package scanner

import (
	"radar/internal/journal"
)

/*
Variants Steam will not describe.

market.dota2.net lists classid_instanceid pairs that Steam's economy API does
not know: old loading screens, pennant upgrades, a handful of bundles. Asking
about one returns a result with that key simply absent — no error, no empty
record, nothing to distinguish it from a call that was rate-limited.

Left alone, the sweep re-asked about all 650 of them every two minutes: seven
wasted Steam calls a pass, forever, while the dashboard reported 650 candidates
"в очереди" as though the work were merely unfinished. It was not unfinished —
it was impossible, and saying so is the honest answer.

A variant is retired after three consecutive misses and retried much later, in
case Valve adds the entry. Sockets are immutable per classid_instanceid, so a
variant that resolves once never returns here.
*/

const (
	// missesBeforeRetiring is deliberately above one: a single miss can also be
	// a truncated batch or a rate-limited call, and retiring on that would hide
	// variants the radar could actually price.
	missesBeforeRetiring = 3
	// retryRetiredEvery re-asks about retired variants occasionally, because
	// Valve does add economy entries after the fact.
	retryRetiredEvery = 30
)

// unknownAsset remembers why a variant is not being asked about.
type unknownAsset struct {
	Misses     int    `json:"misses"`
	RetiredAt  int    `json:"retired_at"`
	LastName   string `json:"last_name,omitempty"`
	LastReason string `json:"last_reason,omitempty"`
}

// skipUnknown reports whether this variant should be left out of this sweep's
// Steam batch. Caller holds no lock.
func (s *Scanner) skipUnknown(key string, sweep int) bool {
	s.mu.RLock()
	u, ok := s.unknown[key]
	s.mu.RUnlock()
	if !ok || u.Misses < missesBeforeRetiring {
		return false
	}
	return sweep-u.RetiredAt < retryRetiredEvery
}

// noteSteamMiss records that Steam did not describe a variant it was asked about.
func (s *Scanner) noteSteamMiss(key, name string, sweep int) {
	s.mu.Lock()
	u := s.unknown[key]
	u.Misses++
	if name != "" {
		u.LastName = name
	}
	retiring := u.Misses == missesBeforeRetiring
	if u.Misses >= missesBeforeRetiring {
		u.RetiredAt = sweep
	}
	s.unknown[key] = u
	s.mu.Unlock()

	if retiring {
		s.note(journal.LevelInfo, journal.KindFindingDrop, name, journal.ReasonSteamUnknown,
			"Steam не описывает этот вариант — перестаём спрашивать до повторной попытки",
			map[string]any{"key": key, "misses": u.Misses, "retry_after_sweeps": retryRetiredEvery})
	}
}

// clearSteamMiss forgets the miss history once a variant finally resolves.
func (s *Scanner) clearSteamMiss(key string) {
	s.mu.Lock()
	if _, ok := s.unknown[key]; ok {
		delete(s.unknown, key)
	}
	s.mu.Unlock()
}

// SteamUnknown counts variants retired because Steam does not describe them.
func (s *Scanner) SteamUnknown() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, u := range s.unknown {
		if u.Misses >= missesBeforeRetiring {
			n++
		}
	}
	return n
}

// UnknownSample lists a few retired variants by name, so the dashboard can show
// what kind of thing Steam refuses rather than only a count.
func (s *Scanner) UnknownSample(limit int) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, limit)
	for _, u := range s.unknown {
		if len(out) >= limit {
			break
		}
		if u.Misses >= missesBeforeRetiring && u.LastName != "" {
			out = append(out, u.LastName)
		}
	}
	return out
}
