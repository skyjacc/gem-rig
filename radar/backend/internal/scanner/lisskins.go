package scanner

import (
	"fmt"
	"log"
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

// LisSkinsSourceName identifies lots found on Lis-Skins.
const LisSkinsSourceName = "lis-skins"

// lisRunID groups this scanner's journal entries.
const lisRunID = "lis-skins"

/*
Carriers on Lis-Skins.

Lis-Skins publishes a full market export — every lot, with the contents of
every socket, using the same sprite identifiers Valve renders. The radar has
been downloading all 20 MB of it every half hour to read the loose gems out of
it, and throwing the rest away. Of the roughly seventy-nine thousand lots in
one export, eighty carry a real kinetic gem and seventy-five of those sit under
the scanning price cap: a third marketplace, already paid for in bandwidth,
that produced no offers at all.

The export is authoritative about its own sockets, so unlike market.dota2.net
no Steam call is needed to confirm them. What it does not carry is an
instanceid, so a lot found here cannot be cross-checked against Steam's economy
the way a market.dota2.net variant can. That limit is recorded on the finding
rather than hidden.
*/

// LisScanner turns the Lis-Skins export into findings.
type LisScanner struct {
	book *pricing.Book
	hub  *hub.Hub
	opts func() Options

	// rate converts the export's USD prices into roubles, using the same
	// source the gem quotes were converted with.
	rate func() float64

	// planner prices a finding against the standing order books. Without it a
	// Lis-Skins lot reached the table carrying only a rough listing spread and
	// no Deal at all — and the default "только прибыльные" filter hides anything
	// unpriced, so the whole marketplace was invisible.
	planner func() *Planner

	mu       sync.RWMutex
	findings map[string]Finding
	stats    LisStats
	log      *journal.Journal
}

// SetPlanner supplies the shared deal calculation.
func (l *LisScanner) SetPlanner(p func() *Planner) {
	l.mu.Lock()
	l.planner = p
	l.mu.Unlock()
}

func (l *LisScanner) plan(f Finding) *economics.Deal {
	l.mu.RLock()
	p := l.planner
	l.mu.RUnlock()
	if p == nil {
		return nil
	}
	return p().Plan(f)
}

// LisStats is a snapshot of the last export pass.
type LisStats struct {
	Enabled     bool      `json:"enabled"`
	LastSweep   time.Time `json:"last_sweep"`
	LotsSeen    int       `json:"lots_seen"`
	WithGems    int       `json:"with_gems"`
	Findings    int       `json:"findings"`
	LastSweepMS int64     `json:"last_sweep_ms"`
	LastError   string    `json:"last_error,omitempty"`
}

func NewLisScanner(book *pricing.Book, h *hub.Hub, opts optionsSource, rate func() float64) *LisScanner {
	return &LisScanner{
		book:     book,
		hub:      h,
		opts:     opts.Options,
		rate:     rate,
		findings: make(map[string]Finding),
	}
}

// SetJournal attaches the audit record. Optional: nil records nothing.
func (l *LisScanner) SetJournal(j *journal.Journal) {
	l.mu.Lock()
	l.log = j
	l.mu.Unlock()
}

func (l *LisScanner) note(level journal.Level, kind, subject, reason, message string, fields map[string]any) {
	l.mu.RLock()
	j := l.log
	l.mu.RUnlock()
	if j == nil {
		return
	}
	j.WriteRun(lisRunID, level, kind, subject, reason, message, fields)
}

// Findings returns the current Lis-Skins findings, best spread first.
func (l *LisScanner) Findings() []Finding {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make([]Finding, 0, len(l.findings))
	for _, f := range l.findings {
		out = append(out, f)
	}
	return out
}

// Stats returns the last pass for the dashboard.
func (l *LisScanner) Stats() LisStats {
	l.mu.RLock()
	defer l.mu.RUnlock()
	st := l.stats
	st.Findings = len(l.findings)
	st.Enabled = true
	return st
}

// Ingest rebuilds the finding set from one export.
//
// It is handed the lots the price collector already downloaded rather than
// fetching its own copy: one export, two readings.
func (l *LisScanner) Ingest(lots []sources.LisLot, err error) {
	start := time.Now()
	if err != nil {
		l.mu.Lock()
		l.stats.LastError = err.Error()
		l.stats.LastSweep = time.Now()
		l.mu.Unlock()
		l.note(journal.LevelWarn, journal.KindSweepDone, "", "lis_unavailable",
			"экспорт Lis-Skins не загрузился: "+err.Error(), nil)
		return
	}

	opts := l.opts()
	next := make(map[string]Finding)
	excluded := map[string]int{}
	withGems := 0
	var fresh []Finding

	for _, lot := range lots {
		gems := lot.KineticGems()
		if len(gems) == 0 {
			continue
		}
		// A gem sold as a gem prices itself; buying one to extract one is
		// circular. Same rule as every other pipeline.
		if isLooseGem(lot.Name) {
			excluded[ExcludedLooseGem]++
			continue
		}
		withGems++

		rub := lot.Price * l.rate()
		if rub <= 0 {
			excluded["no_price"]++
			continue
		}
		if rub > opts.MaxItemPrice {
			excluded[ExcludedPriceCap]++
			continue
		}

		var value float64
		priced := false
		prices := make([]pricing.GemPrice, 0, len(gems))
		for _, g := range gems {
			p, ok := l.book.Price(marketGemName(g))
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
		net := value*(1-opts.SaleFee) - rub
		if priced && net < opts.MinSpread {
			excluded[ExcludedBelowSpread]++
			continue
		}

		key := "lis:" + fmt.Sprint(lot.ID)
		heroName, heroIcon := dota.PortraitURL("")
		f := Finding{
			Key:        key,
			ClassID:    lot.ClassID,
			InstanceID: "",
			ItemName:   lot.Name,
			HeroName:   heroName,
			HeroIcon:   heroIcon,
			Price:      rub,
			Offers:     1,
			Gems:       gems,
			GemValue:   value,
			Spread:     value - rub,
			NetSpread:  net,
			Priced:     priced,
			GemPrices:  prices,
			Confidence: weakestConfidence(prices),
			Source:     LisSkinsSourceName,
			MarketURL: "https://lis-skins.com/market/dota2/?query=" +
				strings.ReplaceAll(lot.Name, " ", "+"),
			FoundAt: time.Now(),
		}
		if lot.UnlockAt != nil && *lot.UnlockAt != "" {
			if until, err := time.Parse(time.RFC3339, *lot.UnlockAt); err == nil {
				if d := int(time.Until(until).Hours() / 24); d > 0 {
					f.LockDays = d
				}
			}
		}

		// The gems came out of this lot's own listing, not out of a Steam
		// variant lookup, so there is no variant/lot split to fall through:
		// the marketplace selling it is the one that described it.
		f.Proof = SocketProof{
			Checked:    true,
			Agree:      true,
			MarketGems: append([]string(nil), f.Gems...),
			Note:       "сокеты взяты из экспорта Lis-Skins — площадка сама описала этот лот",
			At:         time.Now(),
		}
		f.Deal = l.plan(f)

		l.mu.RLock()
		prev, existed := l.findings[key]
		l.mu.RUnlock()
		if existed {
			f.FoundAt = prev.FoundAt
		} else {
			fresh = append(fresh, f)
		}
		next[key] = f
	}

	l.mu.Lock()
	before := len(l.findings)
	l.findings = next
	l.stats.LastSweep = time.Now()
	l.stats.LastSweepMS = time.Since(start).Milliseconds()
	l.stats.LotsSeen = len(lots)
	l.stats.WithGems = withGems
	l.stats.LastError = ""
	l.mu.Unlock()

	for _, f := range fresh {
		log.Printf("[find:lis] %s %.2f RUB -> %s (spread %.0f, %s)",
			f.ItemName, f.Price, strings.Join(f.Gems, ", "), f.NetSpread, f.Confidence)
		l.note(journal.LevelInfo, journal.KindFindingAdd, f.ItemName, journal.ReasonNewLot,
			"новый лот с кинетиком на Lis-Skins",
			map[string]any{
				"key": f.Key, "price": f.Price, "gems": f.Gems,
				"gem_value": f.GemValue, "spread": f.NetSpread,
				"confidence": string(f.Confidence), "source": LisSkinsSourceName,
			})
		l.hub.Publish("finding", f)
	}

	fields := map[string]any{
		"lots": len(lots), "with_gems": withGems, "in_table": len(next),
		"added": len(fresh), "removed": maxInt(0, before+len(fresh)-len(next)),
		"duration_ms": time.Since(start).Milliseconds(),
	}
	for reason, n := range excluded {
		fields["excl_"+reason] = n
	}
	l.note(journal.LevelInfo, journal.KindSweepDone, "", "",
		fmt.Sprintf("экспорт Lis-Skins: %d лотов, носителей с кинетиком %d, в таблице %d",
			len(lots), withGems, len(next)),
		fields)
	l.hub.Publish("lis_stats", l.Stats())
}

// Names lists every item and gem name whose order book this scanner needs, so
// the main sweep warms them alongside its own.
func (l *LisScanner) Names() []string {
	l.mu.RLock()
	defer l.mu.RUnlock()
	seen := make(map[string]bool, len(l.findings)*2)
	out := make([]string, 0, len(l.findings)*2)
	for _, f := range l.findings {
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
func (l *LisScanner) Reprice() {
	l.mu.RLock()
	current := make(map[string]Finding, len(l.findings))
	for k, f := range l.findings {
		current[k] = f
	}
	l.mu.RUnlock()

	for key, f := range current {
		deal := l.plan(f)
		if deal == nil {
			continue
		}
		l.mu.Lock()
		if live, still := l.findings[key]; still {
			live.Deal = deal
			l.findings[key] = live
		}
		l.mu.Unlock()
	}
}
