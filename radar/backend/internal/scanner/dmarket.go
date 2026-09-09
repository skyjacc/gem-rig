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
	"radar/internal/economics"
	"radar/internal/hub"
	"radar/internal/journal"
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

	// log records what this sweep did. Without it DMarket offers appeared in
	// the table and vanished from it with no trace anywhere: the journal
	// covered only the market.dota2.net pipeline, so half the offers on screen
	// had no history at all.
	log *journal.Journal

	// planner prices a finding against the standing order books, the same way
	// the market.dota2.net sweep does. Where a lot was bought changes only its
	// price; the gems come out the same and sell in the same places.
	planner func() *Planner

	mu       sync.RWMutex
	findings map[string]Finding
	stats    DMarketStats
}

// SetPlanner supplies the shared deal calculation.
func (d *DMarketScanner) SetPlanner(p func() *Planner) {
	d.mu.Lock()
	d.planner = p
	d.mu.Unlock()
}

func (d *DMarketScanner) plan(f Finding) *economics.Deal {
	d.mu.RLock()
	p := d.planner
	d.mu.RUnlock()
	if p == nil {
		return nil
	}
	return p().Plan(f)
}

// SetJournal attaches the audit record. Optional: nil records nothing.
func (d *DMarketScanner) SetJournal(j *journal.Journal) {
	d.mu.Lock()
	d.log = j
	d.mu.Unlock()
}

func (d *DMarketScanner) note(level journal.Level, kind, subject, reason, message string, fields map[string]any) {
	d.mu.RLock()
	j := d.log
	d.mu.RUnlock()
	if j == nil {
		return
	}
	j.WriteRun(dmarketRunID, level, kind, subject, reason, message, fields)
}

// dmarketRunID groups DMarket events under one run tag so the journal filter
// can separate them from a market.dota2.net sweep.
const dmarketRunID = "dmarket"

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
		// Total page budget across every price band. DMarket caps one result
		// set at 10 000 offers, and the slice under the buying ceiling is
		// larger than that, so coverage comes from splitting the price range
		// rather than from paging deeper into a single query. At the client's
		// 4 requests a second this is about two minutes per sweep.
		stats: DMarketStats{MaxPages: 500},
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

	offers, scanned, truncated, err := d.client.Offers(ctx, maxPages, d.opts().MaxItemPrice)

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
		d.note(journal.LevelWarn, journal.KindSweepDone, "", "dmarket_unavailable",
			"обход DMarket не удался: "+err.Error(),
			map[string]any{"scanned": scanned, "with_gems": len(offers)})
		if len(offers) == 0 {
			return
		}
	}

	opts := d.opts()
	before := len(d.Findings())
	fresh, excluded := d.rebuild(offers, opts)
	for _, f := range fresh {
		log.Printf("[find:dmarket] %s %.2f RUB -> %s (spread %.0f, %s)",
			f.ItemName, f.Price, strings.Join(f.Gems, ", "), f.NetSpread, f.Confidence)
		d.note(journal.LevelInfo, journal.KindFindingAdd, f.ItemName, journal.ReasonNewLot,
			"новый лот с кинетиком на DMarket",
			map[string]any{
				"key": f.Key, "price": f.Price, "gems": f.Gems,
				"gem_value": f.GemValue, "spread": f.NetSpread,
				"confidence": string(f.Confidence), "source": DMarketSourceName,
			})
		d.hub.Publish("finding", f)
	}

	after := len(d.Findings())
	// One closing line per sweep, so "просмотрено 2000, с кинетиком 32,
	// в таблице 0" is answerable after the fact rather than only live.
	d.note(journal.LevelInfo, journal.KindSweepDone, "", "",
		fmt.Sprintf("обход DMarket: просмотрено %d офферов%s, с кинетиком %d, в таблице %d",
			scanned, map[bool]string{true: " (упёрлись в бюджет страниц, дальше не смотрели)", false: " — это весь список под потолком цены"}[truncated],
			len(offers), after),
		func() map[string]any {
			f := map[string]any{
				"scanned": scanned, "with_gems": len(offers),
				"in_table": after, "added": len(fresh), "removed": maxInt(0, before+len(fresh)-after),
				"max_pages": maxPages, "truncated": truncated,
				"duration_ms": time.Since(start).Milliseconds(),
			}
			for reason, n := range excluded {
				f["excl_"+reason] = n
			}
			return f
		}())
	d.hub.Publish("dmarket_stats", d.Stats())
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// rebuild replaces the finding set with the current sweep and returns the ones
// that were not there before.
// rebuild also reports why offers were dropped. "2000 просмотрено, 30
// с кинетиком, 0 в таблице" is not an answer, and it was the only thing the
// panel could say about the second marketplace.
func (d *DMarketScanner) rebuild(offers []sources.DMOffer, opts Options) ([]Finding, map[string]int) {
	next := make(map[string]Finding, len(offers))
	var fresh []Finding
	excluded := map[string]int{}

	for _, o := range offers {
		// A loose gem prices itself. Buying one in order to extract a gem is
		// circular, and the resulting "spread" is the gem measured against its
		// own listing. The market.dota2.net sweep has always excluded these;
		// this one did not, so the only two lots DMarket ever contributed were
		// gems sold as gems.
		if isLooseGem(o.Title) {
			excluded[ExcludedLooseGem]++
			continue
		}
		if o.PriceRUB <= 0 {
			excluded["no_price"]++
			continue
		}
		if o.PriceRUB > opts.MaxItemPrice {
			excluded[ExcludedPriceCap]++
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
		if !priced {
			excluded[ExcludedGemUnpriced]++
		}
		net := value*(1-opts.SaleFee) - o.PriceRUB
		if priced && net < opts.MinSpread {
			excluded[ExcludedBelowSpread]++
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

		// The gems came out of this lot's own listing, not out of a Steam
		// variant lookup, so there is no variant/lot split to fall through:
		// the marketplace selling it is the one that described it.
		f.Proof = SocketProof{
			Checked:    true,
			Agree:      true,
			MarketGems: append([]string(nil), f.Gems...),
			Note:       "сокеты взяты из ответа DMarket по этому офферу — площадка сама описала лот",
			At:         time.Now(),
		}
		f.Deal = d.plan(f)

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
	return fresh, excluded
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

// Names lists every item and gem name whose order book this scanner needs, so
// the main sweep warms them alongside its own.
func (d *DMarketScanner) Names() []string {
	d.mu.RLock()
	defer d.mu.RUnlock()
	seen := make(map[string]bool, len(d.findings)*2)
	out := make([]string, 0, len(d.findings)*2)
	for _, f := range d.findings {
		for _, g := range f.Gems {
			if n := marketGemName(g); n != "" && !seen[n] {
				seen[n] = true
				out = append(out, n)
			}
		}
		if f.ItemName != "" && !seen[f.ItemName] {
			seen[f.ItemName] = true
			out = append(out, f.ItemName)
		}
	}
	return out
}

// Reprice recomputes every finding against the books the main sweep just
// warmed. Without it a lot found while the books were cold kept its empty plan
// until this marketplace's own, much slower refresh came round again.
func (d *DMarketScanner) Reprice() {
	d.mu.RLock()
	current := make(map[string]Finding, len(d.findings))
	for k, f := range d.findings {
		current[k] = f
	}
	d.mu.RUnlock()

	for key, f := range current {
		deal := d.plan(f)
		if deal == nil {
			continue
		}
		d.mu.Lock()
		if live, still := d.findings[key]; still {
			live.Deal = deal
			d.findings[key] = live
		}
		d.mu.Unlock()
	}
}
