package history

import (
	"testing"
	"time"
)

func TestSweepSeriesIsBoundedAndOldestFirst(t *testing.T) {
	s := New(t.TempDir())
	for i := 0; i < maxSweeps+50; i++ {
		s.AddSweep(Sweep{At: time.Now().Add(time.Duration(i) * time.Minute), Findings: i})
	}
	all := s.Sweeps(0)
	if len(all) != maxSweeps {
		t.Fatalf("series should stop at %d points, got %d", maxSweeps, len(all))
	}
	if all[0].Findings >= all[len(all)-1].Findings {
		t.Fatal("points must stay in chronological order")
	}
	if last := all[len(all)-1].Findings; last != maxSweeps+49 {
		t.Fatalf("the newest point must survive, got %d", last)
	}
}

func TestFlatPricesDoNotFillTheBuffer(t *testing.T) {
	// A gem that does not move for a week must not push out the day it did.
	s := New(t.TempDir())
	s.AddGem("Kinetic: Serene Honor", GemPoint{Median: 500, Order: 380})
	for i := 0; i < 100; i++ {
		s.AddGem("Kinetic: Serene Honor", GemPoint{Median: 500, Order: 380})
	}
	s.AddGem("Kinetic: Serene Honor", GemPoint{Median: 520, Order: 390})

	pts := s.Gem("Kinetic: Serene Honor", 0)
	if len(pts) != 2 {
		t.Fatalf("only real changes are points, got %d", len(pts))
	}
	if pts[1].Median != 520 {
		t.Fatalf("the change must be the newest point, got %v", pts[1].Median)
	}
}

func TestZeroPricesAreNotRecorded(t *testing.T) {
	s := New(t.TempDir())
	s.AddGem("gem", GemPoint{Median: 0})
	s.AddGem("", GemPoint{Median: 100})
	if _, gems, points := s.Size(); gems != 0 || points != 0 {
		t.Fatalf("nothing should be stored, got %d gems and %d points", gems, points)
	}
}

func TestSeriesSurviveARestart(t *testing.T) {
	dir := t.TempDir()
	first := New(dir)
	first.AddSweep(Sweep{Findings: 7, Profitable: 3})
	first.AddGem("Kinetic: Serene Honor", GemPoint{Median: 500, Order: 380})
	if err := first.Save(); err != nil {
		t.Fatal(err)
	}

	second := New(dir)
	sweeps := second.Sweeps(0)
	if len(sweeps) != 1 || sweeps[0].Profitable != 3 {
		t.Fatalf("sweeps should come back, got %+v", sweeps)
	}
	if pts := second.Gem("Kinetic: Serene Honor", 0); len(pts) != 1 || pts[0].Order != 380 {
		t.Fatalf("gem points should come back, got %+v", pts)
	}
}

func TestTrackedGemsAreRankedByHistoryLength(t *testing.T) {
	s := New(t.TempDir())
	for i := 0; i < 5; i++ {
		s.AddGem("busy", GemPoint{Median: float64(100 + i)})
	}
	s.AddGem("quiet", GemPoint{Median: 50})

	names := s.TrackedGems()
	if len(names) != 2 || names[0] != "busy" {
		t.Fatalf("the gem with more history comes first, got %v", names)
	}
}
