package scanner

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"radar/internal/dota"
	"radar/internal/economics"
	"radar/internal/history"
	"radar/internal/hub"
	"radar/internal/journal"
	"radar/internal/market"
	"radar/internal/pricing"
	"radar/internal/ratelimit"
	"radar/internal/steam"
)

// Finding is a lot whose physical sockets are worth more than the asking price.
type Finding struct {
	Key        string    `json:"key"`
	ClassID    string    `json:"classid"`
	InstanceID string    `json:"instanceid"`
	ItemName   string    `json:"item_name"`
	ItemType   string    `json:"item_type"`
	IconURL    string    `json:"icon_url"`
	HeroName   string    `json:"hero_name"`
	HeroIcon   string    `json:"hero_icon"`
	Rarity     string    `json:"rarity"`
	NameColor  string    `json:"name_color"`
	Price      float64   `json:"price"`
	Offers     int       `json:"offers"`
	Gems       []string  `json:"gems"`
	GemValue   float64   `json:"gem_value"`
	Spread     float64   `json:"spread"`
	NetSpread  float64   `json:"net_spread"`
	ROI        float64   `json:"roi"`
	Priced     bool      `json:"priced"`
	MarketURL  string    `json:"market_url"`
	InspectURL string    `json:"inspect_url"`
	FoundAt    time.Time `json:"found_at"`

	// Source is the marketplace the lot sits on.
	Source string `json:"source"`
	// LockDays is how long the item cannot be resold after purchase.
	LockDays int `json:"lock_days"`
	// GemPrices carries every market's opinion of each gem, so the dashboard
	// can show why a valuation should or should not be trusted.
	GemPrices  []pricing.GemPrice `json:"gem_prices"`
	Confidence pricing.Confidence `json:"confidence"`

	// Deal is the buy-extract-sell plan priced from standing buy orders.
	// It is the number to act on; GemValue above is only a listing average.
	Deal *economics.Deal `json:"deal,omitempty"`
}

// SourceName identifies lots found on market.dota2.net.
const SourceName = "tm.net"

// OrderBookSourceName is the standing buy orders read from market.dota2.net.
//
// It is listed apart from the asks because the two answer different questions
// and fail independently: listings say what sellers want, orders say what the
// market will actually pay today, and every deal is ranked on the second.
const OrderBookSourceName = "tm.net:orders"

// value prices a set of gems from the shared book, returning the total and
// every market's opinion of each gem.
func (s *Scanner) value(gems []string) (total float64, priced bool, prices []pricing.GemPrice) {
	for _, g := range gems {
		p, ok := s.book.Price(g)
		if !ok {
			p = pricing.GemPrice{Name: g, Confidence: pricing.ConfidenceNone}
		} else {
			total += p.Median
			priced = true
		}
		prices = append(prices, p)
	}
	return total, priced, prices
}

// weakestConfidence returns the least trustworthy grade in a set.
func weakestConfidence(prices []pricing.GemPrice) pricing.Confidence {
	rank := map[pricing.Confidence]int{
		pricing.ConfidenceHigh: 0, pricing.ConfidenceMedium: 1,
		pricing.ConfidenceLow: 2, pricing.ConfidenceNone: 3,
	}
	worst := pricing.ConfidenceHigh
	for _, p := range prices {
		if rank[p.Confidence] > rank[worst] {
			worst = p.Confidence
		}
	}
	if len(prices) == 0 {
		return pricing.ConfidenceNone
	}
	return worst
}

// variantInfo is what the radar remembers about a resolved item variant.
// Sockets and artwork never change for a classid_instanceid, so this is
// cached forever and only the price is re-read each sweep.
type variantInfo struct {
	Gems    []string `json:"gems"`
	IconURL string   `json:"icon_url"`
	Type    string   `json:"type"`
	Name    string   `json:"name"`
}

// Options tune the sweep.
type Options struct {
	// MaxItemPrice caps which lots are worth resolving, in roubles.
	MaxItemPrice float64
	// MinSpread is the smallest profit worth reporting, in roubles.
	MinSpread float64
	// SaleFee is the market's cut when reselling the gem, as a fraction.
	SaleFee float64
	// Interval between full catalogue sweeps.
	Interval time.Duration
	// SteamRPS caps Steam Economy calls per second.
	SteamRPS float64
	// MaxSteamCallsPerSweep bounds the work done in one sweep.
	MaxSteamCallsPerSweep int
	// DataDir persists resolved keys so a restart does not re-sweep.
	DataDir string
}

// DefaultOptions returns conservative settings suitable for a first run.
func DefaultOptions() Options {
	return Options{
		MaxItemPrice: 1500,
		// The listing average is only a gate for reaching the real calculation.
		// Anything the listings do not price below cost gets through; whether it
		// is worth buying is decided by the order-book plan and by the
		// operator's own filters in the table.
		MinSpread:             0,
		SaleFee:               0,
		Interval:              2 * time.Minute,
		SteamRPS:              2,
		MaxSteamCallsPerSweep: 400,
		DataDir:               "radar-data",
	}
}

// Phase is what the sweep is doing right now. "Scanning" on its own says
// nothing; each pass has distinct stages with very different costs.
type Phase string

const (
	PhaseIdle      Phase = "idle"      // ждём следующего обхода
	PhaseCatalogue Phase = "catalogue" // качаем каталог маркета
	PhaseSockets   Phase = "sockets"   // спрашиваем Steam о сокетах
	PhaseOrders    Phase = "orders"    // читаем стаканы ордеров
	PhasePricing   Phase = "pricing"   // считаем сделки
)

// Stats is a snapshot of scanner progress for the dashboard.
type Stats struct {
	Running        bool      `json:"running"`
	Phase          Phase     `json:"phase"`
	PhaseDetail    string    `json:"phase_detail"`
	PhaseDone      int       `json:"phase_done"`
	PhaseTotal     int       `json:"phase_total"`
	StartedAt      time.Time `json:"started_at"`
	LastSweep      time.Time `json:"last_sweep"`
	LastSweepDur   string    `json:"last_sweep_duration"`
	CatalogueSize  int       `json:"catalogue_size"`
	CatalogueBuilt time.Time `json:"catalogue_built"`
	Candidates     int       `json:"candidates"`
	Resolved       int       `json:"resolved"` // historical cache, not current coverage
	// SteamUnknown counts variants Steam refuses to describe. They are not
	// pending work: no amount of waiting resolves them.
	SteamUnknown int `json:"steam_unknown"`
	// RunID names the sweep in flight, or the last one to finish, so every
	// number on the dashboard can be traced back to the pass that produced it.
	RunID              string `json:"run_id"`
	CurrentResolved    int    `json:"current_resolved"`
	CurrentGemVariants int    `json:"current_gem_variants"`
	PendingResolve     int    `json:"pending_resolve"`
	GemVariants        int    `json:"gem_variants"`
	Findings           int    `json:"findings"`
	SteamCalls         int    `json:"steam_calls"`
	SweepsDone         int    `json:"sweeps_done"`
	LastAdded          int    `json:"last_added"`
	LastRemoved        int    `json:"last_removed"`
	LastError          string `json:"last_error"`
	PriceBookEntries   int    `json:"price_book_entries"`
}

// Scanner sweeps the market catalogue and reports gem arbitrage.
type Scanner struct {
	market *market.Client
	steam  *steam.Client
	book   *pricing.Book
	hub    *hub.Hub
	steamL *ratelimit.Limiter
	// books holds standing buy orders per item name; econ holds the operator's
	// own commissions and tool costs.
	books *economics.BookCache
	econ  func() economics.Settings
	// log records why every offer appeared, changed or vanished.
	log *journal.Journal

	// ReportSource publishes this scanner's own price contributions to the
	// dashboard's source table. Optional: nil simply reports nothing.
	ReportSource func(name string, gems int, err error)

	// unknown remembers variants Steam declines to describe, so the sweep
	// stops re-asking about them every two minutes.
	unknown map[string]unknownAsset

	// runs keeps the recent sweep records; tally is the one in flight.
	runs  []Run
	tally *runTally
	// trigger is why the next sweep starts. Read and cleared at sweep start.
	trigger string
	// past holds the time series the dashboard plots.
	past *history.Store

	mu       sync.RWMutex
	opts     Options
	resolved map[string]bool
	// gemVariants remembers which variants physically hold a kinetic gem.
	// Sockets never change for a given classid_instanceid, but the asking
	// price does, so these are re-valued every sweep without asking Steam
	// again. Without this a lot listed above its gem value today would never
	// be looked at again when the seller drops the price tomorrow.
	gemVariants map[string]variantInfo
	findings    map[string]Finding
	// lastCatalogue is the price snapshot from the most recent sweep, so a
	// settings change can be applied without waiting for the next one.
	lastCatalogue map[string]market.Lot
	stats         Stats

	kick chan struct{}
}

func New(m *market.Client, s *steam.Client, book *pricing.Book, h *hub.Hub, opts Options) *Scanner {
	return &Scanner{
		market:      m,
		steam:       s,
		book:        book,
		hub:         h,
		steamL:      ratelimit.New(opts.SteamRPS),
		opts:        opts,
		resolved:    make(map[string]bool),
		gemVariants: make(map[string]variantInfo),
		unknown:     make(map[string]unknownAsset),
		findings:    make(map[string]Finding),
		kick:        make(chan struct{}, 1),
	}
}

// SetHistory attaches the time series store.
func (s *Scanner) SetHistory(h *history.Store) {
	s.mu.Lock()
	s.past = h
	s.mu.Unlock()
}

// recordSweep appends one point to the sweep series.
func (s *Scanner) recordSweep(st Stats, books int) {
	s.mu.RLock()
	past := s.past
	s.mu.RUnlock()
	if past == nil {
		return
	}
	point := history.Sweep{
		At:         time.Now(),
		Findings:   st.Findings,
		Catalogue:  st.CatalogueSize,
		Candidates: st.Candidates,
		WithGems:   st.GemVariants,
		GemsPriced: st.PriceBookEntries,
		OrderBooks: books,
	}
	for _, f := range s.Findings() {
		if f.Deal == nil || !f.Deal.Priced {
			continue
		}
		point.Priced++
		if f.Deal.Net > 0 {
			point.Profitable++
			point.TotalNet += f.Deal.Net
			if f.Deal.Net > point.BestNet {
				point.BestNet = f.Deal.Net
			}
		}
	}
	if d, err := time.ParseDuration(st.LastSweepDur); err == nil {
		point.DurationMS = d.Milliseconds()
	}
	past.AddSweep(point)
}

// SetJournal attaches the audit log. Without it the scanner still works, it
// just cannot explain itself.
func (s *Scanner) SetJournal(j *journal.Journal) {
	s.mu.Lock()
	s.log = j
	s.mu.Unlock()
}

// journalOf returns the log, or nil.
func (s *Scanner) journalOf() *journal.Journal {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.log
}

// setPhase records what the sweep is doing so the dashboard can say more than
// "running".
func (s *Scanner) setPhase(p Phase, detail string, done, total int) {
	s.mu.Lock()
	s.stats.Phase = p
	s.stats.PhaseDetail = detail
	s.stats.PhaseDone = done
	s.stats.PhaseTotal = total
	s.mu.Unlock()
	s.hub.Publish("stats", s.Stats())
}

// reportSource publishes what this sweep contributed to the price book, so the
// dashboard's source table covers the market being scanned and not only the
// side sources polled by the collector.
func (s *Scanner) reportSource(name string, gems int, err error) {
	if s.ReportSource == nil {
		return
	}
	s.ReportSource(name, gems, err)
}

// exclude tallies one reason a candidate did not become a result, on the sweep
// currently in flight.
func (s *Scanner) exclude(reason string, n int) {
	s.mu.RLock()
	t := s.tally
	s.mu.RUnlock()
	t.exclude(reason, n)
}

// tallyRun applies f to the run in flight, if any.
func (s *Scanner) tallyRun(f func(r *Run)) {
	s.mu.RLock()
	t := s.tally
	s.mu.RUnlock()
	t.set(f)
}

// note writes one journal entry if a journal is attached, stamped with the
// sweep it belongs to so "показать журнал этого скана" can select it.
func (s *Scanner) note(level journal.Level, kind, subject, reason, message string, fields map[string]any) {
	j := s.journalOf()
	if j == nil {
		return
	}
	s.mu.RLock()
	t := s.tally
	s.mu.RUnlock()
	run := ""
	if t != nil {
		run = t.run.ID
	}
	j.WriteRun(run, level, kind, subject, reason, message, fields)
}

// Options returns the current settings.
func (s *Scanner) Options() Options {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.opts
}

// SetOptions updates the tunables that can change without a restart.
func (s *Scanner) SetOptions(o Options) {
	s.mu.Lock()
	s.opts.MaxItemPrice = o.MaxItemPrice
	s.opts.MinSpread = o.MinSpread
	s.opts.SaleFee = o.SaleFee
	if o.Interval > 0 {
		s.opts.Interval = o.Interval
	}
	if o.MaxSteamCallsPerSweep > 0 {
		s.opts.MaxSteamCallsPerSweep = o.MaxSteamCallsPerSweep
	}
	s.mu.Unlock()
	s.recompute()
}

// Stats returns a snapshot for the dashboard.
func (s *Scanner) Stats() Stats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := s.stats
	st.Resolved = len(s.resolved)
	st.Findings = len(s.findings)
	st.GemVariants = len(s.gemVariants)
	// Only eligible variants in the latest catalogue form the denominator.
	// Cached records from old catalogues and attempted/failed lookups do not.
	st.Candidates = 0
	st.CurrentResolved = 0
	st.CurrentGemVariants = 0
	for key, lot := range s.lastCatalogue {
		if !eligibleCandidate(lot, s.opts.MaxItemPrice) {
			continue
		}
		st.Candidates++
		if s.resolved[key] {
			st.CurrentResolved++
			if len(s.gemVariants[key].Gems) > 0 {
				st.CurrentGemVariants++
			}
		}
	}
	st.PendingResolve = st.Candidates - st.CurrentResolved
	st.SteamUnknown = 0
	for _, u := range s.unknown {
		if u.Misses >= missesBeforeRetiring {
			st.SteamUnknown++
		}
	}
	st.PriceBookEntries = s.book.Size()
	return st
}

// Findings returns every current finding, best spread first.
func (s *Scanner) Findings() []Finding {
	s.mu.RLock()
	out := make([]Finding, 0, len(s.findings))
	for _, f := range s.findings {
		out = append(out, f)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].NetSpread > out[j].NetSpread })
	return out
}

// Kick asks for a sweep to start as soon as the current one finishes.
func (s *Scanner) Kick() { s.KickBecause("manual") }

// KickBecause is Kick with the reason recorded on the run it starts.
//
// The channel holds one slot, so pressing the button twice queues one sweep,
// not two. The dashboard has to say that rather than imply a queue depth it
// does not have.
func (s *Scanner) KickBecause(reason string) {
	s.mu.Lock()
	s.trigger = reason
	s.mu.Unlock()
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// Queued reports whether a sweep is already waiting to start.
func (s *Scanner) Queued() bool { return len(s.kick) > 0 }

// Run sweeps on a schedule until ctx is cancelled.
func (s *Scanner) Run(ctx context.Context) {
	s.loadState()
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			s.saveState()
			return
		case <-s.kick:
		case <-timer.C:
		}
		s.sweep(ctx)
		s.saveState()
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(s.Options().Interval)
	}
}

func (s *Scanner) sweep(ctx context.Context) {
	start := time.Now()
	s.mu.Lock()
	trigger := s.trigger
	if trigger == "" {
		trigger = "schedule"
	}
	s.trigger = ""
	tally := newRunTally(runID(SourceName, start), SourceName, trigger, start)
	s.tally = tally
	s.stats.Running = true
	s.stats.StartedAt = start
	s.stats.RunID = tally.run.ID
	s.stats.LastError = ""
	s.stats.LastAdded = 0
	s.stats.LastRemoved = 0
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.stats.Running = false
		s.stats.LastSweep = time.Now()
		s.stats.LastSweepDur = time.Since(start).Round(time.Second).String()
		s.stats.SweepsDone++
		s.stats.Phase = PhaseIdle
		s.stats.PhaseDetail = "ждём следующего обхода"
		s.stats.PhaseDone = 0
		s.stats.PhaseTotal = 0
		s.mu.Unlock()
		st := s.Stats()
		// The closing entry is written once, by noteRun, because only it knows
		// how the sweep actually ended. This used to be a second, unconditional
		// "обход завершён" that stamped success over a cancelled pass and
		// produced the duplicate pairs in the journal.
		books := 0
		if s.books != nil {
			books = s.books.Size()
		}
		s.recordSweep(st, books)

		priced, profitable := 0, 0
		for _, f := range s.Findings() {
			if f.Deal != nil && f.Deal.Priced {
				priced++
				if f.Deal.Net > 0 {
					profitable++
				}
			}
		}
		finished := time.Now()
		tally.set(func(r *Run) {
			r.FinishedAt = finished
			r.DurationMS = finished.Sub(start).Milliseconds()
			// Only if the catalogue actually loaded: the error path above has
			// already zeroed these deliberately.
			if r.Error == "" {
				r.CatalogueRows = st.CatalogueSize
				r.Candidates = st.Candidates
			}
			r.OrderBooks = books
			r.Findings = st.Findings
			r.Priced = priced
			r.Profitable = profitable
			r.Added = st.LastAdded
			r.Removed = st.LastRemoved
			r.Deferred = st.PendingResolve
			if ctx.Err() != nil {
				r.Outcome = "cancelled"
			} else if st.LastError != "" {
				r.Outcome = "error"
				r.Error = st.LastError
			}
		})
		run := tally.snapshot()
		s.finishRun(run)
		// The closing entry carries the whole summary, so one journal line is
		// enough to see what a sweep did without opening the run list.
		s.noteRun(run)
		s.hub.Publish("stats", st)
		s.hub.Publish("run", run)
	}()

	s.setPhase(PhaseCatalogue, "качаем каталог маркета", 0, 0)
	s.note(journal.LevelDebug, journal.KindSweepStart, "", "", "начали обход каталога", nil)

	lots, stamp, err := s.market.ItemDB(ctx)
	if err != nil {
		s.setError(fmt.Errorf("itemdb: %w", err))
		// Nothing was examined, so the run must not inherit the previous
		// sweep's catalogue size and candidate count from Stats.
		s.tallyRun(func(r *Run) {
			r.Outcome = "error"
			r.Error = "каталог не загрузился: " + err.Error()
			r.CatalogueRows = 0
			r.Candidates = 0
		})
		s.note(journal.LevelError, journal.KindSweepStart, "", "catalogue_unavailable",
			"каталог не загрузился, обход не состоялся: "+err.Error(), nil)
		return
	}
	opts := s.Options()

	s.note(journal.LevelDebug, journal.KindSweepStart, "", "", "каталог загружен",
		map[string]any{"lots": len(lots), "built_at": stamp})

	byKey := make(map[string]market.Lot, len(lots))
	catalogue := make(map[string]market.Lot, len(lots))
	livePrices := make(map[string]float64)
	var todo []steam.AssetKey
	// Every row the catalogue offers is accounted for: it becomes a candidate
	// or it lands in exactly one of these buckets. A variant that silently
	// vanishes between 42k rows and 25 offers is the thing this counts.
	looseGems, overCap, noInstance := 0, 0, 0
	for _, lot := range lots {
		if lot.InstanceID == "" || lot.InstanceID == "0" || lot.Price <= 0 {
			noInstance++
			continue
		}
		// A loose gem on sale prices itself. Its cheapest listing is a far
		// better valuation than a hand-maintained file, and buying a gem to
		// extract a gem is pointless, so it is never a candidate.
		if isLooseGem(lot.NameEN, lot.NameRU) {
			if cur, ok := livePrices[lot.NameEN]; !ok || lot.Price < cur {
				livePrices[lot.NameEN] = lot.Price
			}
			looseGems++
			continue
		}
		catalogue[lot.Key()] = lot
		if eligibleCandidate(lot, opts.MaxItemPrice) {
			byKey[lot.Key()] = lot
			continue
		}
		// Record which rule dropped it. "42k variants, 25 offers" is only
		// believable when the gap is itemised.
		switch {
		case lot.InstanceID == "" || lot.InstanceID == "0":
			noInstance++
		case lot.Price > opts.MaxItemPrice:
			overCap++
		default:
			noInstance++
		}
	}
	s.exclude(ExcludedLooseGem, looseGems)
	s.exclude(ExcludedPriceCap, overCap)
	s.exclude(ExcludedNoInstance, noInstance)
	sweepNo := s.Stats().SweepsDone
	retired := 0
	for key, lot := range byKey {
		s.mu.RLock()
		seen := s.resolved[key]
		s.mu.RUnlock()
		if seen {
			continue
		}
		if s.skipUnknown(key, sweepNo) {
			retired++
			continue
		}
		todo = append(todo, steam.AssetKey{ClassID: lot.ClassID, InstanceID: lot.InstanceID})
	}
	s.exclude(ExcludedSteamUnknown, retired)
	s.tallyRun(func(r *Run) {
		r.Candidates = len(byKey)
		r.Requested = len(todo)
		r.FromCache = len(byKey) - len(todo) - retired
		r.SteamUnknown = retired
	})

	quotes := make(map[string]pricing.Quote, len(livePrices))
	for name, price := range livePrices {
		quotes[name] = pricing.Quote{Price: price, Kind: pricing.KindAsk}
	}
	// An empty successful catalogue must also clear yesterday's source quotes.
	s.book.SetAll(SourceName, quotes)
	log.Printf("[prices] %s: %d gems from live listings", SourceName, len(livePrices))
	s.reportSource(SourceName, len(livePrices), nil)

	s.registerBooks(lots)

	s.mu.Lock()
	s.lastCatalogue = catalogue
	s.stats.CatalogueSize = len(lots)
	s.stats.CatalogueBuilt = stamp
	s.mu.Unlock()

	// Re-value every variant already known to hold a gem against today's
	// prices before spending any Steam calls on new ones.
	s.revalue(byKey)

	if len(todo) > 0 {
		s.setPhase(PhaseSockets, "спрашиваем Steam о сокетах новых вариантов", 0, len(todo))
	}

	const batchSize = 100
	calls := 0
	for start := 0; start < len(todo); start += batchSize {
		if ctx.Err() != nil {
			return
		}
		if calls >= opts.MaxSteamCallsPerSweep {
			log.Printf("[scan] steam call budget reached (%d calls), %d variants left for next sweep",
				calls, len(todo)-start)
			break
		}
		end := start + batchSize
		if end > len(todo) {
			end = len(todo)
		}
		batch := todo[start:end]
		if err := s.steamL.Wait(ctx); err != nil {
			return
		}
		assets, err := s.steam.AssetClassInfo(ctx, batch)
		calls++
		s.recordSocketBatch(batch, assets, byKey, err, end, len(todo))

		// A full first sweep takes minutes; checkpoint so a restart in the
		// middle does not throw the work away.
		if calls%50 == 0 {
			s.saveState()
		}
	}

	// Price what was found against standing buy orders. Bounded so the order
	// book lookups cannot crowd out the catalogue sweep.
	// Reading an order book is one market request. Two dozen findings carry
	// close to a hundred distinct names between gems and shells, so a budget
	// of 60 left most plans permanently incomplete.
	s.applyDeals(ctx, 200)
	s.setPhase(PhaseIdle, "ждём следующего обхода", 0, 0)
}

// recordSocketBatch separates attempts from verified responses. Steam can omit
// keys or return cached successes alongside an error; only returned requested
// assets become resolved, and every other candidate remains pending.
func (s *Scanner) recordSocketBatch(batch []steam.AssetKey, assets map[string]steam.Asset, byKey map[string]market.Lot, err error, done, total int) {
	s.mu.Lock()
	s.stats.SteamCalls++
	s.mu.Unlock()
	// The run keeps its own count. Stats.SteamCalls is a process-lifetime
	// counter, so copying it into the run made a sweep that spent nothing look
	// like it had spent every call made since the radar started. Incremented
	// outside the lock above: tallyRun takes the same non-reentrant mutex.
	s.tallyRun(func(r *Run) { r.SteamCalls++ })
	verified := make(map[string]steam.Asset, len(assets))
	sweepNo := s.Stats().SweepsDone
	for _, key := range batch {
		id := key.String()
		if asset, ok := assets[id]; ok {
			verified[id] = asset
			s.clearSteamMiss(id)
			continue
		}
		// A key that came back absent is not a transport failure: Steam
		// answered and simply has no record. Only count that as a miss when
		// the call itself succeeded, or a rate-limited batch would retire
		// every variant in it.
		if err == nil {
			name := ""
			if lot, ok := byKey[id]; ok {
				name = lot.NameEN
				if name == "" {
					name = lot.NameRU
				}
			}
			s.noteSteamMiss(id, name, sweepNo)
		}
	}
	if len(verified) > 0 {
		s.evaluate(verified, byKey)
	}
	if err != nil {
		s.setError(fmt.Errorf("steam: %w", err))
	}
	s.setPhase(PhaseSockets, fmt.Sprintf("запрошено %d из %d вариантов; подтверждения — в покрытии", done, total), done, total)
}

func eligibleCandidate(lot market.Lot, maxPrice float64) bool {
	return lot.InstanceID != "" && lot.InstanceID != "0" && lot.Price > 0 &&
		lot.Price <= maxPrice && !isLooseGem(lot.NameEN, lot.NameRU)
}

// evaluate records freshly resolved variants and prices the ones that hold a
// kinetic gem.
func (s *Scanner) evaluate(assets map[string]steam.Asset, byKey map[string]market.Lot) {
	var boring []string

	for key, asset := range assets {
		gems := asset.KineticGems()
		s.mu.Lock()
		s.resolved[key] = true
		if len(gems) > 0 {
			s.gemVariants[key] = variantInfo{
				Gems:    gems,
				IconURL: asset.IconURL,
				Type:    asset.Type,
				Name:    asset.MarketHashName,
			}
		}
		s.mu.Unlock()
		if len(gems) == 0 {
			// A variant without a kinetic gem never needs to stay in memory:
			// its sockets cannot change, and `resolved` already remembers it.
			boring = append(boring, key)
		}
	}
	if len(boring) > 0 {
		s.steam.Forget(boring...)
	}
	s.exclude(ExcludedNoSocket, len(boring))
	s.tallyRun(func(r *Run) { r.SocketsOK += len(assets) })
	s.price(byKey)
}

// revalue re-prices known gem variants against the current catalogue.
func (s *Scanner) revalue(byKey map[string]market.Lot) { s.price(byKey) }

// price turns known gem variants into findings using today's asking prices.
func (s *Scanner) price(byKey map[string]market.Lot) {
	opts := s.Options()

	s.mu.RLock()
	variants := make(map[string]variantInfo, len(s.gemVariants))
	for k, v := range s.gemVariants {
		variants[k] = v
	}
	s.mu.RUnlock()

	var fresh []Finding
	for key, info := range variants {
		lot, listed := byKey[key]
		if !listed || !eligibleCandidate(lot, opts.MaxItemPrice) {
			// The lot left the market, or is now above the price ceiling.
			s.mu.Lock()
			prev, had := s.findings[key]
			delete(s.findings, key)
			s.mu.Unlock()
			if had {
				s.mu.Lock()
				s.stats.LastRemoved++
				s.mu.Unlock()
				s.exclude(ExcludedDelisted, 1)
				s.note(journal.LevelInfo, journal.KindFindingDrop, prev.ItemName,
					journal.ReasonDelisted,
					"лот пропал из каталога: продан, снят или цена вышла за потолок сканирования",
					map[string]any{"key": key, "last_price": prev.Price, "cap": opts.MaxItemPrice})
			}
			continue
		}

		value, priced, gemPrices := s.value(info.Gems)
		net := value*(1-opts.SaleFee) - lot.Price
		if priced && net < opts.MinSpread {
			s.mu.Lock()
			prev, had := s.findings[key]
			delete(s.findings, key)
			s.mu.Unlock()
			if had {
				s.mu.Lock()
				s.stats.LastRemoved++
				s.mu.Unlock()
				s.exclude(ExcludedBelowSpread, 1)
				s.note(journal.LevelInfo, journal.KindFindingDrop, prev.ItemName,
					journal.ReasonBelowSpread,
					"по объявлениям гем перестал перекрывать цену лота",
					map[string]any{
						"key": key, "price": lot.Price, "gem_value": value,
						"spread": net, "min_spread": opts.MinSpread,
					})
			}
			continue
		}

		f := buildFinding(key, lot, info, value, net, priced, gemPrices)
		s.mu.Lock()
		prev, existed := s.findings[key]
		if existed {
			f.FoundAt = prev.FoundAt
			// Re-pricing the listing average must not discard the order-book
			// plan; it is refreshed separately at the end of a sweep.
			f.Deal = prev.Deal
		}
		s.findings[key] = f
		s.mu.Unlock()
		if !existed {
			fresh = append(fresh, f)
		} else if prev.Price != f.Price {
			s.note(journal.LevelDebug, journal.KindFindingPrice, f.ItemName,
				journal.ReasonPriceChanged, "продавец изменил цену лота",
				map[string]any{"key": key, "was": prev.Price, "now": f.Price})
		}
	}

	if len(fresh) > 0 {
		s.mu.Lock()
		s.stats.LastAdded += len(fresh)
		s.mu.Unlock()
	}
	for _, f := range fresh {
		log.Printf("[find] %s %.2f RUB -> %s (spread %.0f)", f.ItemName, f.Price, strings.Join(f.Gems, ", "), f.NetSpread)
		s.note(journal.LevelInfo, journal.KindFindingAdd, f.ItemName, journal.ReasonNewLot,
			"новый лот с подтверждённым кинетическим сокетом",
			map[string]any{
				"key": f.Key, "price": f.Price, "gems": f.Gems,
				"gem_value": f.GemValue, "confidence": string(f.Confidence),
				"source": f.Source,
			})
		s.hub.Publish("finding", f)
	}
}

func buildFinding(key string, lot market.Lot, info variantInfo, value, net float64, priced bool, gemPrices []pricing.GemPrice) Finding {
	parts := strings.SplitN(key, "_", 2)
	name := lot.NameEN
	if name == "" {
		name = info.Name
	}
	heroName, heroIcon := dota.PortraitURL(lot.HeroID)

	f := Finding{
		Key:        key,
		ClassID:    parts[0],
		InstanceID: parts[1],
		ItemName:   name,
		ItemType:   info.Type,
		IconURL:    steam.EconImageURL(info.IconURL),
		HeroName:   heroName,
		HeroIcon:   heroIcon,
		Rarity:     lot.Rarity,
		NameColor:  lot.NameColor,
		Price:      lot.Price,
		Offers:     lot.Offers,
		Gems:       info.Gems,
		GemValue:   value,
		Spread:     value - lot.Price,
		NetSpread:  net,
		Priced:     priced,
		MarketURL:  fmt.Sprintf("https://market.dota2.net/item/%s-%s", parts[0], parts[1]),
		InspectURL: fmt.Sprintf("/inspect?class=%s&instance=%s", parts[0], parts[1]),
		FoundAt:    time.Now(),
		Source:     SourceName,
		GemPrices:  gemPrices,
		Confidence: weakestConfidence(gemPrices),
	}
	if lot.Price > 0 {
		f.ROI = net / lot.Price * 100
	}
	return f
}

func (s *Scanner) setError(err error) {
	log.Printf("[scan] %v", err)
	s.mu.Lock()
	s.stats.LastError = err.Error()
	s.mu.Unlock()
}

// recompute re-applies the thresholds after the options change, using the
// price snapshot from the last sweep so the table reacts immediately.
func (s *Scanner) recompute() {
	s.mu.RLock()
	catalogue := s.lastCatalogue
	s.mu.RUnlock()
	if catalogue == nil {
		return
	}
	s.price(catalogue)
}

type persistedState struct {
	Resolved []string `json:"resolved"`
	// Legacy field: gems only, written before item artwork was cached.
	LegacyGemVariants map[string][]string     `json:"gem_variants,omitempty"`
	GemVariants       map[string]variantInfo  `json:"gem_variants_v2"`
	Findings          []Finding               `json:"findings"`
	Unknown           map[string]unknownAsset `json:"steam_unknown,omitempty"`
}

func (s *Scanner) statePath() string {
	return filepath.Join(s.opts.DataDir, "scanner-state.json")
}

func (s *Scanner) loadState() {
	data, err := os.ReadFile(s.statePath())
	if err != nil {
		return
	}
	var st persistedState
	if err := json.Unmarshal(data, &st); err != nil {
		log.Printf("[scan] ignoring unreadable state file: %v", err)
		return
	}
	s.mu.Lock()
	for _, k := range st.Resolved {
		s.resolved[k] = true
	}
	for k, v := range st.GemVariants {
		s.gemVariants[k] = v
	}
	for k, v := range st.Unknown {
		s.unknown[k] = v
	}
	// State written before artwork was cached carries gems but no icon.
	// Forget those variants so the next sweep resolves them once more and
	// fills in the picture; there are only a handful of them.
	migrated := 0
	for k, gems := range st.LegacyGemVariants {
		if _, ok := s.gemVariants[k]; ok {
			continue
		}
		s.gemVariants[k] = variantInfo{Gems: gems}
		delete(s.resolved, k)
		migrated++
	}
	for _, f := range st.Findings {
		// A plan priced against yesterday's order book is not a plan. Restored
		// findings show as awaiting calculation until the next sweep prices
		// them again.
		f.Deal = nil
		s.findings[f.Key] = f
	}
	s.mu.Unlock()
	log.Printf("[scan] restored %d resolved variants, %d with gems, %d findings",
		len(st.Resolved), len(st.GemVariants)+migrated, len(st.Findings))
}

func (s *Scanner) saveState() {
	s.mu.RLock()
	st := persistedState{
		Resolved:    make([]string, 0, len(s.resolved)),
		GemVariants: make(map[string]variantInfo, len(s.gemVariants)),
		Findings:    make([]Finding, 0, len(s.findings)),
	}
	for k := range s.resolved {
		st.Resolved = append(st.Resolved, k)
	}
	for k, v := range s.gemVariants {
		st.GemVariants[k] = v
	}
	st.Unknown = make(map[string]unknownAsset, len(s.unknown))
	for k, v := range s.unknown {
		st.Unknown[k] = v
	}
	for _, f := range s.findings {
		st.Findings = append(st.Findings, f)
	}
	dir := s.opts.DataDir
	s.mu.RUnlock()

	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("[scan] cannot create %s: %v", dir, err)
		return
	}
	data, err := json.Marshal(st)
	if err != nil {
		return
	}
	tmp := s.statePath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Printf("[scan] cannot write state: %v", err)
		return
	}
	if err := os.Rename(tmp, s.statePath()); err != nil {
		log.Printf("[scan] cannot replace state: %v", err)
	}
}
