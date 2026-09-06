// Package history keeps the small time series the dashboard plots.
//
// A single snapshot answers "what is true now". A chart answers questions a
// snapshot cannot: is this gem drifting down all week, is the number of
// profitable offers shrinking, did coverage actually improve after a change.
// The series are deliberately coarse and bounded — one point per sweep, one
// per price refresh — because this is a decision aid, not a tick database.
package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Sweep is one snapshot of the radar's own state, taken after each pass.
type Sweep struct {
	At         time.Time `json:"at"`
	Findings   int       `json:"findings"`
	Profitable int       `json:"profitable"`
	Priced     int       `json:"priced"`
	BestNet    float64   `json:"best_net"`
	TotalNet   float64   `json:"total_net"`
	Catalogue  int       `json:"catalogue"`
	Candidates int       `json:"candidates"`
	WithGems   int       `json:"with_gems"`
	GemsPriced int       `json:"gems_priced"`
	OrderBooks int       `json:"order_books"`
	DurationMS int64     `json:"duration_ms"`
}

// GemPoint is one gem's valuation at a moment in time.
type GemPoint struct {
	At     time.Time `json:"at"`
	Median float64   `json:"median"`
	Low    float64   `json:"low"`
	High   float64   `json:"high"`
	// Order is the best standing buy order, when one is known. This is the
	// line that matters: it is the price the gem can actually be sold at.
	Order float64 `json:"order,omitempty"`
}

const (
	maxSweeps        = 720 // about a day at one sweep every two minutes
	maxPointsPerGem  = 300
	maxTrackedGems   = 200
	saveEveryNSweeps = 5
)

// Store holds both series and persists them beside the scanner state.
type Store struct {
	dir string

	mu     sync.RWMutex
	sweeps []Sweep
	gems   map[string][]GemPoint
	dirty  int
}

func New(dir string) *Store {
	s := &Store{dir: dir, gems: make(map[string][]GemPoint)}
	s.load()
	return s
}

// AddSweep records one pass. Points are appended, never rewritten.
func (s *Store) AddSweep(p Sweep) {
	if p.At.IsZero() {
		p.At = time.Now()
	}
	s.mu.Lock()
	s.sweeps = append(s.sweeps, p)
	if len(s.sweeps) > maxSweeps {
		s.sweeps = append(s.sweeps[:0], s.sweeps[len(s.sweeps)-maxSweeps:]...)
	}
	s.dirty++
	shouldSave := s.dirty >= saveEveryNSweeps
	s.mu.Unlock()
	if shouldSave {
		s.Save()
	}
}

// AddGem records one gem's valuation. Repeated identical values are skipped so
// a flat week does not fill the buffer and hide the day it moved.
func (s *Store) AddGem(name string, p GemPoint) {
	if name == "" || p.Median <= 0 {
		return
	}
	if p.At.IsZero() {
		p.At = time.Now()
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	series := s.gems[name]
	if n := len(series); n > 0 {
		last := series[n-1]
		if last.Median == p.Median && last.Order == p.Order {
			return
		}
	}
	if len(series) == 0 && len(s.gems) >= maxTrackedGems {
		return
	}
	series = append(series, p)
	if len(series) > maxPointsPerGem {
		series = append(series[:0], series[len(series)-maxPointsPerGem:]...)
	}
	s.gems[name] = series
}

// Sweeps returns the sweep series, oldest first.
func (s *Store) Sweeps(limit int) []Sweep {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := s.sweeps
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	cp := make([]Sweep, len(out))
	copy(cp, out)
	return cp
}

// Gem returns one gem's series, oldest first.
func (s *Store) Gem(name string, limit int) []GemPoint {
	s.mu.RLock()
	defer s.mu.RUnlock()
	series := s.gems[name]
	if limit > 0 && len(series) > limit {
		series = series[len(series)-limit:]
	}
	cp := make([]GemPoint, len(series))
	copy(cp, series)
	return cp
}

// TrackedGems lists the gems with a series, most points first.
func (s *Store) TrackedGems() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, 0, len(s.gems))
	for n := range s.gems {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool {
		if len(s.gems[names[i]]) != len(s.gems[names[j]]) {
			return len(s.gems[names[i]]) > len(s.gems[names[j]])
		}
		return names[i] < names[j]
	})
	return names
}

// Size reports how much is retained.
func (s *Store) Size() (sweeps, gems, points int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, series := range s.gems {
		points += len(series)
	}
	return len(s.sweeps), len(s.gems), points
}

type persisted struct {
	Sweeps []Sweep               `json:"sweeps"`
	Gems   map[string][]GemPoint `json:"gems"`
}

func (s *Store) path() string { return filepath.Join(s.dir, "history.json") }

func (s *Store) load() {
	data, err := os.ReadFile(s.path())
	if err != nil {
		return
	}
	var p persisted
	if err := json.Unmarshal(data, &p); err != nil {
		return
	}
	s.mu.Lock()
	s.sweeps = p.Sweeps
	if p.Gems != nil {
		s.gems = p.Gems
	}
	s.mu.Unlock()
}

// Save writes the series to disk, replacing the file atomically.
func (s *Store) Save() error {
	s.mu.Lock()
	p := persisted{Sweeps: s.sweeps, Gems: s.gems}
	s.dirty = 0
	dir := s.dir
	s.mu.Unlock()

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	tmp := s.path() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path())
}
