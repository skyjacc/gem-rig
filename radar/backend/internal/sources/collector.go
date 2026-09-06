package sources

import (
	"context"
	"log"
	"sort"
	"sync"
	"time"

	"radar/internal/history"
	"radar/internal/journal"
	"radar/internal/pricing"
)

// SourceStatus reports how one source's last refresh went.
type SourceStatus struct {
	Name    string    `json:"name"`
	Gems    int       `json:"gems"`
	Error   string    `json:"error,omitempty"`
	At      time.Time `json:"at"`
	Enabled bool      `json:"enabled"`
}

// Collector refreshes every price source and feeds the shared book.
//
// Sources are independent: a rate-limited Steam or a flapping market must not
// stop the others, so each failure is recorded and the rest still run.
type Collector struct {
	Book     *pricing.Book
	FX       *FX
	Steam    *SteamClient
	Waxpeer  *Waxpeer
	LootFarm *LootFarm
	LisSkins *LisSkins
	DMarket  *DMarket

	// Log records every source refresh so a silent failure is visible.
	Log *journal.Journal
	// Past records how each gem's valuation moves over time.
	Past *history.Store
	// OrderBook reports the best standing buy order for a gem, when known.
	// Plotted alongside the median, it shows the gap between what sellers ask
	// and what buyers actually pay.
	OrderBook func(gem string) (float64, bool)

	mu     sync.RWMutex
	status map[string]SourceStatus
}

func NewCollector(book *pricing.Book, fx *FX, dm *DMarket) *Collector {
	return &Collector{
		Book:     book,
		FX:       fx,
		Steam:    NewSteamClient(fx),
		Waxpeer:  NewWaxpeer(fx),
		LootFarm: NewLootFarm(fx),
		LisSkins: NewLisSkins(fx),
		DMarket:  dm,
		status:   make(map[string]SourceStatus),
	}
}

// Status returns the last result for every source, in a stable order.
func (c *Collector) Status() []SourceStatus {
	c.mu.RLock()
	out := make([]SourceStatus, 0, len(c.status))
	for _, s := range c.status {
		out = append(out, s)
	}
	c.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Report publishes a price source that the collector does not own.
//
// The scanner reads market.dota2.net's listings and order books itself — the
// largest source of prices in the whole tool, and the only one supplying the
// buy orders every deal is ranked on. It refreshes on the sweep schedule, not
// the collector's, so it is pushed in from outside instead of being polled
// here. Without this it fed the price book while showing no row at all, and
// the sources table quietly understated what the numbers rest on.
func (c *Collector) Report(name string, gems int, err error) {
	c.record(name, gems, true, err)
}

func (c *Collector) record(name string, gems int, enabled bool, err error) {
	s := SourceStatus{Name: name, Gems: gems, At: time.Now(), Enabled: enabled}
	if err != nil {
		s.Error = err.Error()
		log.Printf("[prices] %s: %v", name, err)
		if c.Log != nil {
			c.Log.Warn(journal.KindSourceErr, name, "", "источник не ответил: "+err.Error(),
				map[string]any{"gems": gems})
		}
	} else if enabled {
		log.Printf("[prices] %s: %d gems", name, gems)
		if c.Log != nil {
			c.Log.Info(journal.KindSource, name, "", "источник обновил цены",
				map[string]any{"gems": gems})
		}
	}
	c.mu.Lock()
	c.status[name] = s
	c.mu.Unlock()
}

// quoteFetcher is the shape every free source shares.
type quoteFetcher interface {
	Name() string
	GemQuotes(ctx context.Context) (map[string]pricing.Quote, error)
}

// Refresh re-reads every source. Free sources run in parallel; DMarket runs
// afterwards because it prices per gem name and needs the list the others built.
func (c *Collector) Refresh(ctx context.Context) {
	if _, source, updated := c.FX.Status(); source == "fallback" || time.Since(updated) > time.Hour {
		if err := c.FX.Refresh(ctx, c.Steam); err != nil {
			log.Printf("[fx] keeping previous rate: %v", err)
		} else {
			rate, src, _ := c.FX.Status()
			log.Printf("[fx] 1 USD = %.2f RUB (%s)", rate, src)
		}
	}

	// Sampled whatever happens below. recordHistory used to sit after the
	// DMarket branch, so an unconfigured DMarket meant the gem price series was
	// never written at all — and the popup's history chart was permanently
	// empty while 51 gems had prices.
	defer c.recordHistory()

	free := []quoteFetcher{c.Waxpeer, c.LootFarm, c.LisSkins, c.Steam}
	var wg sync.WaitGroup
	for _, s := range free {
		wg.Add(1)
		go func(src quoteFetcher) {
			defer wg.Done()
			quotes, err := src.GemQuotes(ctx)
			if len(quotes) > 0 {
				c.Book.SetAll(src.Name(), quotes)
			}
			c.record(src.Name(), len(quotes), true, err)
		}(s)
	}
	wg.Wait()

	if c.DMarket == nil || !c.DMarket.Configured() {
		c.record("dmarket", 0, false, nil)
		return
	}
	// Only ask DMarket about gems some other market already knows, so the
	// per-name sale lookups stay bounded.
	names := c.knownGemNames()
	quotes, err := c.DMarket.GemQuotes(ctx, names)
	if len(quotes) > 0 {
		c.Book.SetAll(c.DMarket.Name(), quotes)
	}
	c.record("dmarket", len(quotes), true, err)
}

// recordHistory samples every priced gem after a refresh.
func (c *Collector) recordHistory() {
	if c.Past == nil {
		return
	}
	for _, g := range c.Book.All() {
		point := history.GemPoint{Median: g.Median, Low: g.Low, High: g.High}
		if c.OrderBook != nil {
			if best, ok := c.OrderBook(g.Name); ok {
				point.Order = best
			}
		}
		c.Past.AddGem(g.Name, point)
	}
	_ = c.Past.Save()
}

// knownGemNames lists the market names of every gem seen so far.
func (c *Collector) knownGemNames() []string {
	all := c.Book.All()
	seen := make(map[string]bool, len(all))
	out := make([]string, 0, len(all))
	for _, g := range all {
		name := g.Name
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}

// Run refreshes on a schedule until ctx is cancelled.
func (c *Collector) Run(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = 30 * time.Minute
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		c.Refresh(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
