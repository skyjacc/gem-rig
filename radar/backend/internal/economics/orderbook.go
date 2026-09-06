package economics

import (
	"context"
	"sync"
	"time"
)

// Book is a standing buy order at one venue.
type Book struct {
	Best   float64   `json:"best"`
	Orders int       `json:"orders"`
	At     time.Time `json:"at"`
}

// Fresh reports whether the book is recent enough to trade on.
func (b Book) Fresh(ttl time.Duration) bool {
	return !b.At.IsZero() && time.Since(b.At) < ttl
}

// BookFetcher reads the order book for one item variant.
type BookFetcher func(ctx context.Context, classID, instanceID string) (Book, error)

// BookCache remembers order books by market item name.
//
// The market matches buy orders by name rather than by variant: every
// Eye of Omoz shares one book whether its socket is full or empty. Caching by
// name therefore costs one request per distinct item instead of one per lot,
// and it is also what makes the emptied shell's resale price knowable.
type BookCache struct {
	fetch BookFetcher
	ttl   time.Duration

	mu    sync.RWMutex
	books map[string]Book
	// probe remembers which variant answered for a given name.
	probe map[string][2]string
	miss  map[string]time.Time
}

func NewBookCache(fetch BookFetcher, ttl time.Duration) *BookCache {
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	return &BookCache{
		fetch: fetch,
		ttl:   ttl,
		books: make(map[string]Book),
		probe: make(map[string][2]string),
		miss:  make(map[string]time.Time),
	}
}

// Register records which variant can be used to query a name's order book.
func (c *BookCache) Register(name, classID, instanceID string) {
	if name == "" || classID == "" || instanceID == "" {
		return
	}
	c.mu.Lock()
	if _, ok := c.probe[name]; !ok {
		c.probe[name] = [2]string{classID, instanceID}
	}
	c.mu.Unlock()
}

// Lookup returns a cached book without fetching.
func (c *BookCache) Lookup(name string) (Book, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	b, ok := c.books[name]
	return b, ok && b.Fresh(c.ttl)
}

// Get returns the book for a name, fetching it when the cached copy is stale.
// A name with no registered variant, or one that recently failed, is skipped
// rather than retried on every sweep.
func (c *BookCache) Get(ctx context.Context, name string) (Book, bool) {
	if b, ok := c.Lookup(name); ok {
		return b, true
	}
	c.mu.RLock()
	ids, known := c.probe[name]
	lastMiss := c.miss[name]
	c.mu.RUnlock()
	if !known || time.Since(lastMiss) < c.ttl {
		return Book{}, false
	}

	book, err := c.fetch(ctx, ids[0], ids[1])
	if err != nil {
		c.mu.Lock()
		c.miss[name] = time.Now()
		c.mu.Unlock()
		return Book{}, false
	}
	book.At = time.Now()
	c.mu.Lock()
	c.books[name] = book
	delete(c.miss, name)
	c.mu.Unlock()
	return book, true
}

// Warm fetches books for the given names, oldest first, up to a call budget.
// It returns how many were refreshed.
func (c *BookCache) Warm(ctx context.Context, names []string, budget int) int {
	done := 0
	for _, name := range names {
		if done >= budget || ctx.Err() != nil {
			break
		}
		if _, cached := c.Lookup(name); cached {
			continue
		}
		if _, ok := c.Get(ctx, name); ok {
			done++
		}
	}
	return done
}

// Size reports how many names have a usable book.
func (c *BookCache) Size() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	n := 0
	for _, b := range c.books {
		if b.Fresh(c.ttl) {
			n++
		}
	}
	return n
}
