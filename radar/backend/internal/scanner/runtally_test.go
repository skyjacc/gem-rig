package scanner

import (
	"context"
	"errors"
	"strings"
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

// An empty exit list has two very different causes, and the panel printed the
// harsher one for both: «Ни одна площадка не готова это купить» was shown for
// a name whose order book the sweep simply never got to.
func TestEmptyExitsSayWhichAbsenceItIs(t *testing.T) {
	cases := []struct {
		name       string
		bookRead   bool
		bookHasBid bool
		quoted     bool
		want       string
	}{
		{"стакан не читали, цены нет", false, false, false, "стакан не читали"},
		{"стакан не читали, цена есть", false, false, true, "стакан ордеров не прочитан"},
		{"стакан пуст, цены нет", true, false, false, "стакан пуст"},
		{"стакан пуст, цена есть", true, false, true, "встречных ордеров нет"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := whyNoExit(c.bookRead, c.bookHasBid, c.quoted, 0)
			if got == "" {
				t.Fatal("an empty exit list must always carry a reason")
			}
			if !strings.Contains(got, c.want) {
				t.Fatalf("expected a reason mentioning %q, got %q", c.want, got)
			}
		})
	}

	// A leg that can be sold says nothing: the reason field is for absences.
	if got := whyNoExit(true, true, true, 2); got != "" {
		t.Fatalf("a leg with exits must carry no reason, got %q", got)
	}
}

// DMarket sells loose gems alongside the items that carry them. Buying a gem
// in order to extract a gem is circular: the "spread" is the gem measured
// against its own listing. The market.dota2.net sweep has always excluded
// these; the DMarket sweep did not, and they were the only two lots it ever
// contributed to the table.
func TestLooseGemsAreNotCarriers(t *testing.T) {
	carriers := []string{"Diffusal Lance", "Eye of Omoz", "Sufferwood Sapling"}
	gems := []string{
		"Kinetic: Free to Fear",
		"Kinetic: Obeisance of the Keeper",
		"Кинетический: Serene Honor",
	}
	for _, name := range gems {
		if !isLooseGem(name) {
			t.Fatalf("%q is a gem being sold as a gem and must never be a candidate", name)
		}
	}
	for _, name := range carriers {
		if isLooseGem(name) {
			t.Fatalf("%q carries a gem and must stay a candidate", name)
		}
	}
}
