package scanner

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"radar/internal/dota"
	"radar/internal/hub"
	"radar/internal/pricing"
	"radar/internal/sources"
)

// DMarketSourceName identifies lots found on DMarket.
const DMarketSourceName = "dmarket"

// DMarketScanner finds gem arbitrage on DMarket.
//
// It needs no Steam Economy calls at all: DMarket resolves an item's sockets
// itself and returns them with every offer, so a sweep is pure pagination.
type DMarketScanner struct {
	client *sources.DMarket
	book   *pricing.Book
	hub    *hub.Hub
	// opts are shared with the main scanner so one settings change applies
	// to both marketplaces.
	opts func() Options

	mu       sync.RWMutex
	findings map[string]Finding
	stats    DMarketStats
}

// DMarketStats is a snapshot of the DMarket sweep for the dashboard.
type DMarketStats struct {
	Enabled     bool      `json:"enabled"`
	Running     bool      `json:"running"`
	LastSweep   time.Time `json:"last_sweep"`
	OffersSeen  int       `json:"offers_seen"`
	WithGems    int       `json:"with_gems"`
	Findings    int       `json:"findings"`
	LastError   string    `json:"last_error,omitempty"`
	BalanceUSD  string    `json:"balance_usd,omitempty"`
	MaxPages    int       `json:"max_pages"`
	LastSweepMS int64     `json:"last_sweep_ms"`
}

// optionsSource is the part of the main scanner the DMarket sweep reuses.
type optionsSource interface{ Options() Options }

func NewDMarketScanner(client *sources.DMarket, book *pricing.Book, h *hub.Hub, opts optionsSource) *DMarketScanner {
	return &DMarketScanner{
		client:   client,
		book:     book,
		hub:      h,
		opts:     opts.Options,
		findings: make(map[string]Finding),
		stats:    DMarketStats{MaxPages: 20},
	}
}

// Findings returns the current DMarket findings, best spread first.
func (d *DMarketScanner) Findings() []Finding {
	d.mu.RLock()
	out := make([]Finding, 0, len(d.findings))
	for _, f := range d.findings {
		out = append(out, f)
	}
	d.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].NetSpread > out[j].NetSpread })
	return out
}

// Stats returns a snapshot for the dashboard.
func (d *DMarketScanner) Stats() DMarketStats {
	d.mu.RLock()
	defer d.mu.RUnlock()
	st := d.stats
	st.Enabled = d.client != nil && d.client.Configured()
	st.Findings = len(d.findings)
	return st
}

// Run sweeps DMarket on a schedule until ctx is cancelled.
func (d *DMarketScanner) Run(ctx context.Context, every time.Duration) {
	if d.client == nil || !d.client.Configured() {
		log.Printf("[dmarket] no keys, sweep disabled")
		return
	}
	if usd, err := d.client.Balance(ctx); err != nil {
		log.Printf("[dmarket] key check failed: %v", err)
	} else {
		d.mu.Lock()
		d.stats.BalanceUSD = usd
		d.mu.Unlock()
		log.Printf("[dmarket] key accepted, balance $%s", usd)
	}
	if every <= 0 {
		every = 5 * time.Minute
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		d.sweep(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (d *DMarketScanner) sweep(ctx context.Context) {
	start := time.Now()
	d.mu.Lock()
	d.stats.Running = true
	d.stats.LastError = ""
	maxPages := d.stats.MaxPages
	d.mu.Unlock()

	offers, scanned, err := d.client.Offers(ctx, maxPages)

	d.mu.Lock()
	d.stats.Running = false
	d.stats.LastSweep = time.Now()
	d.stats.LastSweepMS = time.Since(start).Milliseconds()
	d.stats.OffersSeen = scanned
	d.stats.WithGems = len(offers)
	if err != nil {
		d.stats.LastError = err.Error()
	}
	d.mu.Unlock()

	if err != nil {
		log.Printf("[dmarket] %v", err)
		if len(offers) == 0 {
			return
		}
	}

	opts := d.opts()
	fresh := d.rebuild(offers, opts)
	for _, f := range fresh {
		log.Printf("[find:dmarket] %s %.2f RUB -> %s (spread %.0f, %s)",
			f.ItemName, f.Price, strings.Join(f.Gems, ", "), f.NetSpread, f.Confidence)
		d.hub.Publish("finding", f)
	}
	d.hub.Publish("dmarket_stats", d.Stats())
}

// rebuild replaces the finding set with the current sweep and returns the ones
// that were not there before.
func (d *DMarketScanner) rebuild(offers []sources.DMOffer, opts Options) []Finding {
	next := make(map[string]Finding, len(offers))
	var fresh []Finding

	for _, o := range offers {
		if o.PriceRUB <= 0 || o.PriceRUB > opts.MaxItemPrice {
			continue
		}
		var value float64
		priced := false
		var prices []pricing.GemPrice
		for _, g := range o.Gems {
			p, ok := d.book.Price(g)
			if !ok {
				p = pricing.GemPrice{Name: g, Confidence: pricing.ConfidenceNone}
			} else {
				value += p.Median
				priced = true
			}
			prices = append(prices, p)
		}
		net := value*(1-opts.SaleFee) - o.PriceRUB
		if priced && net < opts.MinSpread {
			continue
		}

		key := "dm:" + o.OfferID
		heroName, heroIcon := dota.PortraitURL("")
		if o.Hero != "" && o.Hero != "other" {
			heroName = titleCase(o.Hero)
		}
		f := Finding{
			Key:        key,
			ClassID:    o.ClassID,
			InstanceID: o.InstanceID,
			ItemName:   o.Title,
			IconURL:    o.ImageURI,
			HeroName:   heroName,
			HeroIcon:   heroIcon,
			Rarity:     o.Rarity,
			Price:      o.PriceRUB,
			Offers:     1,
			Gems:       o.Gems,
			GemValue:   value,
			Spread:     value - o.PriceRUB,
			NetSpread:  net,
			Priced:     priced,
			MarketURL:  "https://dmarket.com/ingame-items/item-list/dota2-skins?title=" + o.Title,
			InspectURL: fmt.Sprintf("/inspect?class=%s&instance=%s", o.ClassID, o.InstanceID),
			FoundAt:    time.Now(),
			Source:     DMarketSourceName,
			LockDays:   o.LockDays,
			GemPrices:  prices,
			Confidence: weakestConfidence(prices),
		}
		if o.PriceRUB > 0 {
			f.ROI = net / o.PriceRUB * 100
		}

		d.mu.RLock()
		prev, existed := d.findings[key]
		d.mu.RUnlock()
		if existed {
			f.FoundAt = prev.FoundAt
		} else {
			fresh = append(fresh, f)
		}
		next[key] = f
	}

	d.mu.Lock()
	d.findings = next
	d.mu.Unlock()
	return fresh
}

// titleCase upper-cases the first letter of each word in DMarket's lowercase
// hero slugs ("phantom lancer" -> "Phantom Lancer").
func titleCase(s string) string {
	words := strings.Fields(s)
	for i, w := range words {
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}
