// Package journal records why the radar did what it did.
//
// Offers appearing and vanishing on their own is not a glitch: a lot gets
// bought, a seller re-prices, an order book moves, a filter threshold is
// crossed. Without a record every one of those looks identical from the
// outside. Every state change writes an entry here with a machine-readable
// reason, so any row in the table can be traced back to the event that
// produced or removed it.
package journal

import (
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Level grades how much attention an entry deserves.
type Level string

const (
	LevelDebug Level = "debug"
	LevelInfo  Level = "info"
	LevelWarn  Level = "warn"
	LevelError Level = "error"
)

// Kind is the event type. Kinds are dotted so the UI can group them.
const (
	KindSweepStart   = "sweep.start"
	KindSweepDone    = "sweep.done"
	KindFindingAdd   = "finding.added"
	KindFindingDrop  = "finding.removed"
	KindFindingPrice = "finding.repriced"
	KindDealPriced   = "deal.priced"
	KindDealFailed   = "deal.incomplete"
	KindOrderBook    = "orderbook.fetched"
	KindOrderBookErr = "orderbook.failed"
	KindSource       = "source.refreshed"
	KindSourceErr    = "source.failed"
	KindGuard        = "guard.checked"
	KindSettings     = "settings.changed"
	KindAPIError     = "api.error"
)

// Reasons explain a state change in one stable token.
const (
	ReasonNewLot        = "new_lot"          // впервые увидели лот с гемом
	ReasonDelisted      = "delisted"         // лот пропал из каталога
	ReasonAbovePriceCap = "above_price_cap"  // цена выше потолка сканирования
	ReasonBelowSpread   = "below_min_spread" // спред по объявлениям ниже порога
	ReasonPriceChanged  = "price_changed"    // продавец изменил цену
	ReasonGemUnpriced   = "gem_unpriced"     // ни один рынок не знает цену гема
	ReasonNoOrderBook   = "no_order_book"    // нет стакана для выхода
	ReasonRestored      = "restored"         // поднято из сохранённого состояния
	ReasonSteamUnknown  = "steam_unknown"    // Steam не описывает этот вариант
)

// Event is one recorded fact.
type Event struct {
	ID uint64    `json:"id"`
	At time.Time `json:"at"`
	// Run ties an event to one sweep. Without it the journal is a single
	// undifferentiated stream and the question "what did THAT scan do" has no
	// answer: events from a sweep, from the price collector and from the trade
	// guard interleave by timestamp with nothing separating them.
	Run     string         `json:"run,omitempty"`
	Level   Level          `json:"level"`
	Kind    string         `json:"kind"`
	Subject string         `json:"subject,omitempty"`
	Reason  string         `json:"reason,omitempty"`
	Message string         `json:"message"`
	Fields  map[string]any `json:"fields,omitempty"`
}

// redactFields scrubs string values, including those inside string slices.
// The map is copied rather than edited in place: the caller may still be
// holding it, and quietly mutating an argument is its own kind of bug.
func redactFields(fields map[string]any, redact func(string) string) map[string]any {
	if len(fields) == 0 {
		return fields
	}
	out := make(map[string]any, len(fields))
	for k, v := range fields {
		switch typed := v.(type) {
		case string:
			out[k] = redact(typed)
		case []string:
			cleaned := make([]string, len(typed))
			for i, s := range typed {
				cleaned[i] = redact(s)
			}
			out[k] = cleaned
		case error:
			out[k] = redact(typed.Error())
		default:
			out[k] = v
		}
	}
	return out
}

// Sink receives every event as it is written.
type Sink func(Event)

// Journal is a bounded, in-memory record of recent events.
type Journal struct {
	mu     sync.RWMutex
	events []Event
	limit  int
	nextID atomic.Uint64

	sinkMu sync.RWMutex
	sinks  []Sink

	// Redact is the last line of defence against a credential reaching disk.
	//
	// Clients already strip their own keys, but the journal is written to daily
	// files and packed into a diagnostic bundle meant to be sent to someone
	// else. A secret that slips through one client must not become a permanent
	// artefact, so everything is scrubbed on the way in — not on the way out.
	Redact func(string) string
}

func New(limit int) *Journal {
	if limit <= 0 {
		limit = 5000
	}
	return &Journal{events: make([]Event, 0, limit), limit: limit}
}

// Subscribe registers a sink, returning a function that removes it.
func (j *Journal) Subscribe(s Sink) func() {
	j.sinkMu.Lock()
	j.sinks = append(j.sinks, s)
	idx := len(j.sinks) - 1
	j.sinkMu.Unlock()
	return func() {
		j.sinkMu.Lock()
		if idx < len(j.sinks) {
			j.sinks[idx] = nil
		}
		j.sinkMu.Unlock()
	}
}

// Write records an event and hands it to every sink.
func (j *Journal) Write(level Level, kind, subject, reason, message string, fields map[string]any) Event {
	return j.WriteRun("", level, kind, subject, reason, message, fields)
}

// WriteRun records an event belonging to a named run.
func (j *Journal) WriteRun(run string, level Level, kind, subject, reason, message string, fields map[string]any) Event {
	if j.Redact != nil {
		message = j.Redact(message)
		subject = j.Redact(subject)
		fields = redactFields(fields, j.Redact)
	}
	e := Event{
		ID:      j.nextID.Add(1),
		At:      time.Now(),
		Run:     run,
		Level:   level,
		Kind:    kind,
		Subject: subject,
		Reason:  reason,
		Message: message,
		Fields:  fields,
	}
	j.mu.Lock()
	j.events = append(j.events, e)
	if len(j.events) > j.limit {
		j.events = append(j.events[:0], j.events[len(j.events)-j.limit:]...)
	}
	j.mu.Unlock()

	j.sinkMu.RLock()
	sinks := make([]Sink, 0, len(j.sinks))
	for _, s := range j.sinks {
		if s != nil {
			sinks = append(sinks, s)
		}
	}
	j.sinkMu.RUnlock()
	for _, s := range sinks {
		s(e)
	}
	return e
}

// Convenience wrappers keep call sites short.

func (j *Journal) Info(kind, subject, reason, message string, fields map[string]any) {
	j.Write(LevelInfo, kind, subject, reason, message, fields)
}

func (j *Journal) Debug(kind, subject, reason, message string, fields map[string]any) {
	j.Write(LevelDebug, kind, subject, reason, message, fields)
}

func (j *Journal) Warn(kind, subject, reason, message string, fields map[string]any) {
	j.Write(LevelWarn, kind, subject, reason, message, fields)
}

func (j *Journal) Error(kind, subject, reason, message string, fields map[string]any) {
	j.Write(LevelError, kind, subject, reason, message, fields)
}

// Query filters the record.
type Query struct {
	// Kind matches a full kind or a dotted prefix such as "finding".
	Kind string
	// Subject matches a substring, case-insensitively.
	Subject string
	// Run selects the events of exactly one sweep.
	Run string
	// Level, when set, keeps only entries at or above this severity.
	Level Level
	// SinceID returns only entries newer than this id.
	SinceID uint64
	// Limit caps how many of the newest entries come back.
	Limit int
}

var levelRank = map[Level]int{LevelDebug: 0, LevelInfo: 1, LevelWarn: 2, LevelError: 3}

// Events returns matching entries, newest first.
func (j *Journal) Events(q Query) []Event {
	j.mu.RLock()
	all := make([]Event, len(j.events))
	copy(all, j.events)
	j.mu.RUnlock()

	needle := strings.ToLower(strings.TrimSpace(q.Subject))
	minRank := levelRank[q.Level]

	out := make([]Event, 0, len(all))
	for _, e := range all {
		if e.ID <= q.SinceID {
			continue
		}
		if q.Kind != "" && e.Kind != q.Kind && !strings.HasPrefix(e.Kind, q.Kind+".") {
			continue
		}
		if q.Level != "" && levelRank[e.Level] < minRank {
			continue
		}
		if needle != "" && !strings.Contains(strings.ToLower(e.Subject+" "+e.Message), needle) {
			continue
		}
		if q.Run != "" && e.Run != q.Run {
			continue
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, k int) bool { return out[i].ID > out[k].ID })
	if q.Limit > 0 && len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return out
}

// Counts reports how many entries each kind holds, for the summary strip.
func (j *Journal) Counts() map[string]int {
	j.mu.RLock()
	defer j.mu.RUnlock()
	out := make(map[string]int)
	for _, e := range j.events {
		out[e.Kind]++
	}
	return out
}

// Size reports how many entries are retained.
func (j *Journal) Size() int {
	j.mu.RLock()
	defer j.mu.RUnlock()
	return len(j.events)
}
