package scanner

import (
	"fmt"
	"sync"
	"time"

	"radar/internal/journal"
)

// Run is the record of one sweep: what triggered it, what it looked at, what
// came out, and what was thrown away on the way.
//
// Before this existed the dashboard could say "обход завершён" and nothing
// else. There was no way to ask which scan produced a given row, whether a
// scan had finished cleanly, or why a scan that examined forty thousand
// variants surfaced nothing. Every counter here answers one of those.
type Run struct {
	ID         string    `json:"id"`
	Pipeline   string    `json:"pipeline"`
	Trigger    string    `json:"trigger"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	DurationMS int64     `json:"duration_ms"`
	// Outcome is "ok", "error" or "cancelled". A sweep cut short by shutdown
	// or by the Steam call budget is not a clean pass and must not read as one.
	Outcome string `json:"outcome"`
	Error   string `json:"error,omitempty"`

	// What the sweep saw.
	CatalogueRows int `json:"catalogue_rows"`
	Candidates    int `json:"candidates"`
	FromCache     int `json:"from_cache"`
	Requested     int `json:"requested"`
	SteamCalls    int `json:"steam_calls"`
	// SteamUnknown is how many candidates were skipped because Steam has
	// repeatedly refused to describe them.
	SteamUnknown int `json:"steam_unknown"`
	// SocketMismatch counts lots the marketplace would not confirm: Steam
	// describes a gem in the variant, the marketplace describes an empty lot.
	SocketMismatch int `json:"socket_mismatch"`
	// NoGemPremium counts lots priced as if they held no gem at all.
	NoGemPremium int `json:"no_gem_premium"`
	SocketsOK    int `json:"sockets_ok"`
	OrderBooks   int `json:"order_books"`

	// What came out.
	Findings   int `json:"findings"`
	Priced     int `json:"priced"`
	Profitable int `json:"profitable"`
	Added      int `json:"added"`
	Removed    int `json:"removed"`

	// Why things did not come out. Keyed by the same reason codes the journal
	// uses, so a count here always has matching events to open.
	Excluded map[string]int `json:"excluded"`
	// Deferred counts candidates this sweep did not get to, so a partial pass
	// cannot masquerade as full coverage.
	Deferred int `json:"deferred"`
}

// Exclusion reasons tallied per run. These deliberately mirror the journal's
// reason codes: a number in the run summary must be openable as events.
const (
	ExcludedPriceCap       = "above_price_cap"
	ExcludedLooseGem       = "loose_gem"
	ExcludedNoInstance     = "no_instance_id"
	ExcludedNoSocket       = "no_kinetic_socket"
	ExcludedGemUnpriced    = "gem_unpriced"
	ExcludedBelowSpread    = "below_min_spread"
	ExcludedDelisted       = "delisted"
	ExcludedNoOrderBook    = "no_order_book"
	ExcludedSteamUnknown   = "steam_unknown"
	ExcludedSocketMismatch = "socket_mismatch"
	ExcludedNoGemPremium   = "no_gem_premium"
)

// runTally accumulates a sweep's counters while it is still in flight.
type runTally struct {
	mu       sync.Mutex
	run      Run
	excluded map[string]int
}

func newRunTally(id, pipeline, trigger string, started time.Time) *runTally {
	return &runTally{
		run: Run{
			ID:        id,
			Pipeline:  pipeline,
			Trigger:   trigger,
			StartedAt: started,
			Outcome:   "ok",
		},
		excluded: map[string]int{},
	}
}

func (t *runTally) exclude(reason string, n int) {
	if t == nil || n <= 0 {
		return
	}
	t.mu.Lock()
	t.excluded[reason] += n
	t.mu.Unlock()
}

func (t *runTally) set(f func(r *Run)) {
	if t == nil {
		return
	}
	t.mu.Lock()
	f(&t.run)
	t.mu.Unlock()
}

func (t *runTally) snapshot() Run {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := t.run
	out.Excluded = make(map[string]int, len(t.excluded))
	for k, v := range t.excluded {
		out.Excluded[k] = v
	}
	return out
}

// runID is stable, sortable and readable in a log line. Two sweeps cannot
// start in the same second, so the timestamp alone identifies one.
func runID(pipeline string, at time.Time) string {
	return fmt.Sprintf("%s-%s", pipeline, at.Format("20060102-150405"))
}

// Runs returns the recent sweep records, newest first.
func (s *Scanner) Runs(limit int) []Run {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit <= 0 || limit > len(s.runs) {
		limit = len(s.runs)
	}
	out := make([]Run, 0, limit)
	for i := len(s.runs) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, s.runs[i])
	}
	return out
}

// CurrentRun returns the sweep in flight, if there is one.
func (s *Scanner) CurrentRun() (Run, bool) {
	s.mu.RLock()
	t := s.tally
	s.mu.RUnlock()
	if t == nil {
		return Run{}, false
	}
	return t.snapshot(), true
}

const maxRetainedRuns = 50

func (s *Scanner) finishRun(r Run) {
	s.mu.Lock()
	s.runs = append(s.runs, r)
	if len(s.runs) > maxRetainedRuns {
		s.runs = append(s.runs[:0], s.runs[len(s.runs)-maxRetainedRuns:]...)
	}
	s.tally = nil
	s.mu.Unlock()
}

// noteRun writes the closing summary of a sweep into the journal.
//
// It is written after the run is sealed, so the run id is passed explicitly
// rather than read from the in-flight tally, which is gone by then.
func (s *Scanner) noteRun(r Run) {
	j := s.journalOf()
	if j == nil {
		return
	}
	fields := map[string]any{
		"trigger":     r.Trigger,
		"outcome":     r.Outcome,
		"duration_ms": r.DurationMS,
		"catalogue":   r.CatalogueRows,
		"candidates":  r.Candidates,
		"steam_calls": r.SteamCalls,
		"order_books": r.OrderBooks,
		"findings":    r.Findings,
		"priced":      r.Priced,
		"profitable":  r.Profitable,
		"added":       r.Added,
		"removed":     r.Removed,
		"deferred":    r.Deferred,
	}
	for reason, n := range r.Excluded {
		fields["excl_"+reason] = n
	}
	level := journal.LevelInfo
	if r.Outcome != "ok" {
		level = journal.LevelWarn
	}
	j.WriteRun(r.ID, level, journal.KindSweepDone, "", r.Outcome,
		fmt.Sprintf("итог обхода %s: найдено %d, оценено %d, прибыльных %d", r.ID, r.Findings, r.Priced, r.Profitable),
		fields)
}
