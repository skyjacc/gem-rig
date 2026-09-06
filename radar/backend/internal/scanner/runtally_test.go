package scanner

import (
	"context"
	"errors"
	"testing"
	"time"

	"radar/internal/economics"
	"radar/internal/hub"
	"radar/internal/pricing"
)

// applyDeals re-prices every finding after each warmed chunk of order books, so
// a lot passes through several intermediate states inside one sweep. Counting
// exclusions at each pass made a sweep report offers it was, at that very
// moment, listing as priced: "22 в таблице, 20 с расчётом" beside
// "22 · цену гема не знает ни один рынок".
//
// The invariant is arithmetic: a run can never claim more unpriced findings
// than it has findings without a price.
func TestExclusionsCountFinalStateNotEveryPass(t *testing.T) {
	book := pricing.NewBook()
	book.Set("Kinetic: Serene Honor", pricing.Quote{Source: SourceName, Price: 500, Kind: pricing.KindAsk})

	opts := DefaultOptions()
	opts.MinSpread = 0
	s := New(nil, nil, book, hub.New(), opts)
	// The gem gets a standing order, the shell does not. That is the ordinary
	// case, and it makes the deal move from unpriced to priced-but-incomplete
	// as the sweep warms its books — the transition that used to be counted
	// twice, once in each state.
	books := economics.NewBookCache(func(_ context.Context, class, _ string) (economics.Book, error) {
		if class == "gem" {
			return economics.Book{Best: 420, Orders: 3}, nil
		}
		return economics.Book{}, errors.New("no order book for the shell")
	}, time.Minute)
	books.Register("Kinetic: Serene Honor", "gem", "0")
	books.Register("Diffusal Lance", "shell", "0")
	s.SetEconomics(books, func() economics.Settings { return economics.DefaultSettings() })

	// Open a run so the tally has somewhere to land.
	s.mu.Lock()
	s.tally = newRunTally("test-run", SourceName, "test", time.Now())
	s.mu.Unlock()

	s.gemVariants["200339871_1337149273"] = variantInfo{Gems: []string{"Serene Honor"}}
	s.price(lotAt(100))
	if got := len(s.Findings()); got != 1 {
		t.Fatalf("expected one finding to price, got %d", got)
	}

	// One sweep calls applyDeals once — but inside it, priceFindings runs
	// before warming and again after every chunk of order books. That is where
	// the double counting came from.
	s.applyDeals(context.Background(), 10)

	run := s.tally.snapshot()
	findings := len(s.Findings())
	unpriced := run.Excluded[ExcludedGemUnpriced]
	incomplete := run.Excluded[ExcludedNoOrderBook]

	if unpriced+incomplete > findings {
		t.Fatalf("counted %d exclusions (%d unpriced, %d incomplete) against %d findings — "+
			"the tally ran once per re-pricing pass instead of once per sweep",
			unpriced+incomplete, unpriced, incomplete, findings)
	}

	// And the count must match what the offers table is showing right now.
	wantUnpriced := 0
	for _, f := range s.Findings() {
		if f.Deal != nil && !f.Deal.Priced {
			wantUnpriced++
		}
	}
	if unpriced != wantUnpriced {
		t.Fatalf("run reports %d unpriced, the table shows %d", unpriced, wantUnpriced)
	}
}

// Stats.SteamCalls counts every call since the process started. Copying it into
// a run made a sweep that spent nothing report the whole session's spend as its
// own cost.
func TestRunCountsOnlyItsOwnSteamCalls(t *testing.T) {
	s := testScanner(t)
	s.mu.Lock()
	s.stats.SteamCalls = 504 // as if the process had been up for hours
	s.tally = newRunTally("test-run", SourceName, "test", time.Now())
	s.mu.Unlock()

	if got := s.tally.snapshot().SteamCalls; got != 0 {
		t.Fatalf("a fresh run must start at zero calls, got %d", got)
	}

	s.tallyRun(func(r *Run) { r.SteamCalls++ })
	s.tallyRun(func(r *Run) { r.SteamCalls++ })

	if got := s.tally.snapshot().SteamCalls; got != 2 {
		t.Fatalf("expected the run's own two calls, got %d", got)
	}
	if got := s.Stats().SteamCalls; got != 504 {
		t.Fatalf("the session total must be left alone, got %d", got)
	}
}
