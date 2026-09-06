package scanner

import (
	"context"
	"errors"
	"testing"
	"time"

	"radar/internal/economics"
	"radar/internal/hub"
	"radar/internal/market"
	"radar/internal/pricing"
)

func testScanner(t *testing.T) *Scanner {
	t.Helper()
	book := pricing.NewBook()
	// Three agreeing sources so the finding is not filtered as untrustworthy.
	for _, src := range []string{"tm.net", "steam", "lootfarm"} {
		book.Set("Kinetic: Serene Honor", pricing.Quote{Source: src, Price: 500, Kind: pricing.KindAsk})
	}
	opts := DefaultOptions()
	opts.MinSpread = 50
	// Nil API clients are fine: pricing never touches the network.
	return New(nil, nil, book, hub.New(), opts)
}

func lotAt(price float64) map[string]market.Lot {
	return map[string]market.Lot{
		"200339871_1337149273": {
			ClassID:    "200339871",
			InstanceID: "1337149273",
			Price:      price,
			Offers:     1,
			NameEN:     "Diffusal Lance",
		},
	}
}

func TestFindingAppearsWhenSpreadIsWorthIt(t *testing.T) {
	s := testScanner(t)
	s.gemVariants["200339871_1337149273"] = variantInfo{Gems: []string{"Serene Honor"}}

	s.revalue(lotAt(64))

	findings := s.Findings()
	if len(findings) != 1 {
		t.Fatalf("expected one finding, got %d", len(findings))
	}
	f := findings[0]
	if f.ItemName != "Diffusal Lance" || f.GemValue != 500 {
		t.Fatalf("unexpected finding %+v", f)
	}
	if f.NetSpread != 436 {
		t.Fatalf("spread should be 500-64=436, got %v", f.NetSpread)
	}
}

func TestFindingDropsWhenPriceRisesAndReturnsWhenItFalls(t *testing.T) {
	// This is why gem-bearing variants are remembered rather than discarded:
	// the sockets never change, but the asking price does.
	s := testScanner(t)
	s.gemVariants["200339871_1337149273"] = variantInfo{Gems: []string{"Serene Honor"}}

	s.revalue(lotAt(64))
	if got := len(s.Findings()); got != 1 {
		t.Fatalf("expected a finding at 64 RUB, got %d", got)
	}

	s.revalue(lotAt(480))
	if got := len(s.Findings()); got != 0 {
		t.Fatalf("spread of 20 is below the 50 threshold, got %d findings", got)
	}

	s.revalue(lotAt(70))
	if got := len(s.Findings()); got != 1 {
		t.Fatalf("finding should come back when the seller drops the price, got %d", got)
	}
}

func TestDelistedLotIsDropped(t *testing.T) {
	s := testScanner(t)
	s.gemVariants["200339871_1337149273"] = variantInfo{Gems: []string{"Serene Honor"}}
	s.revalue(lotAt(64))

	s.revalue(map[string]market.Lot{})
	if got := len(s.Findings()); got != 0 {
		t.Fatalf("a lot that left the market must not stay in the table, got %d", got)
	}
}

func TestUnpricedGemIsStillReported(t *testing.T) {
	s := testScanner(t)
	s.gemVariants["200339871_1337149273"] = variantInfo{Gems: []string{"Some Unlisted Gem"}}
	s.revalue(lotAt(64))

	findings := s.Findings()
	if len(findings) != 1 {
		t.Fatalf("a gem without a known price is still worth showing, got %d", len(findings))
	}
	if findings[0].Priced {
		t.Fatal("finding should be flagged as unpriced")
	}
}

func TestSaleFeeReducesNetSpread(t *testing.T) {
	s := testScanner(t)
	s.gemVariants["200339871_1337149273"] = variantInfo{Gems: []string{"Serene Honor"}}
	opts := s.Options()
	opts.SaleFee = 0.1
	s.SetOptions(opts)

	s.revalue(lotAt(64))
	f := s.Findings()[0]
	if f.NetSpread != 500*0.9-64 {
		t.Fatalf("fee should be applied to the gem price, got %v", f.NetSpread)
	}
	if f.Spread != 500-64 {
		t.Fatalf("gross spread should ignore the fee, got %v", f.Spread)
	}
}

func TestRepricingKeepsTheOrderBookPlan(t *testing.T) {
	// The listing-average pass runs at the start of every sweep, while the
	// order-book plan is computed at the end. Re-pricing must not wipe it.
	s := testScanner(t)
	key := "200339871_1337149273"
	s.gemVariants[key] = variantInfo{Gems: []string{"Serene Honor"}}
	s.revalue(lotAt(64))

	s.mu.Lock()
	f := s.findings[key]
	f.Deal = &economics.Deal{Net: 117, Invested: 270, Complete: true}
	s.findings[key] = f
	s.mu.Unlock()

	s.revalue(lotAt(70))

	got := s.Findings()[0]
	if got.Deal == nil {
		t.Fatal("re-pricing dropped the order-book plan")
	}
	if got.Deal.Net != 117 {
		t.Fatalf("plan should survive untouched, got %v", got.Deal.Net)
	}
	if got.Price != 70 {
		t.Fatalf("the listing price should still refresh, got %v", got.Price)
	}
}

func TestRestoredFindingsDoNotCarryAStalePlan(t *testing.T) {
	// Order books move. A plan restored from disk would look current while
	// being priced against prices that no longer exist.
	dir := t.TempDir()
	saver := testScanner(t)
	saver.opts.DataDir = dir
	saver.gemVariants["200339871_1337149273"] = variantInfo{Gems: []string{"Serene Honor"}}
	saver.revalue(lotAt(64))
	saver.mu.Lock()
	f := saver.findings["200339871_1337149273"]
	f.Deal = &economics.Deal{Net: 999, Complete: true}
	saver.findings["200339871_1337149273"] = f
	saver.mu.Unlock()
	saver.saveState()

	loader := testScanner(t)
	loader.opts.DataDir = dir
	loader.loadState()

	for _, got := range loader.Findings() {
		if got.Deal != nil {
			t.Fatalf("restored finding must wait for a fresh plan, got %+v", got.Deal)
		}
	}
}

// exitScanner builds a scanner whose price book already holds quotes from
// several venues, as the collector would leave it.
func exitScanner(t *testing.T) *Scanner {
	t.Helper()
	book := pricing.NewBook()
	book.Set("Kinetic: Serene Honor", pricing.Quote{Source: SourceName, Price: 520, Kind: pricing.KindAsk})
	book.Set("Kinetic: Serene Honor", pricing.Quote{Source: "steam", Price: 600, Kind: pricing.KindAsk})
	book.Set("Kinetic: Serene Honor", pricing.Quote{Source: DMarketSourceName, Price: 533, Kind: pricing.KindSale, Volume: 8})
	book.Set("Kinetic: Serene Honor", pricing.Quote{Source: "waxpeer", Price: 700, Kind: pricing.KindAsk})

	s := New(nil, nil, book, hub.New(), DefaultOptions())
	books := economics.NewBookCache(func(context.Context, string, string) (economics.Book, error) {
		return economics.Book{}, errors.New("tests must not fetch")
	}, time.Minute)
	settings := economics.DefaultSettings()
	settings.MarketFeePercent = 5
	s.SetEconomics(books, func() economics.Settings { return settings })
	return s
}

func TestExitsCoverEveryVenueWeCanActuallySellOn(t *testing.T) {
	s := exitScanner(t)
	books, settings, _ := s.economicsReady()

	exits, _ := s.exitsFor(books, "Kinetic: Serene Honor", settings)
	byVenue := map[economics.Venue]economics.Exit{}
	for _, e := range exits {
		byVenue[e.Venue] = e
	}

	if _, ok := byVenue[economics.VenueMarket]; !ok {
		t.Fatal("the market listing is an exit")
	}
	if steam, ok := byVenue[economics.VenueSteam]; !ok {
		t.Fatal("steam is an exit")
	} else if steam.Payout != economics.PayoutWallet {
		t.Fatalf("steam pays into a wallet, got %q", steam.Payout)
	}
	if dm, ok := byVenue[economics.VenueDMExit]; !ok {
		t.Fatal("dmarket is an exit")
	} else if dm.Payout != economics.PayoutCash {
		t.Fatalf("dmarket pays cash, got %q", dm.Payout)
	}
	// Waxpeer prices the gem but selling there needs a deposit, so it must not
	// be offered as somewhere to sell.
	for _, e := range exits {
		if string(e.Venue) == "waxpeer" {
			t.Fatal("waxpeer is a price source, not an exit")
		}
	}
}

func TestListedExitsAreNotChosenWithoutOptIn(t *testing.T) {
	// Every venue here offers a listing, none a standing order. By default a
	// listing is not an exit, so the plan reports no price rather than a
	// profit nobody has agreed to pay.
	s := exitScanner(t)
	books, settings, _ := s.economicsReady()
	legExits, _ := s.exitsFor(books, "Kinetic: Serene Honor", settings)
	leg := economics.Leg{Name: "gem", Exits: legExits}

	deal := economics.Plan(100, []economics.Leg{leg}, nil, settings)
	if deal.Priced {
		t.Fatal("listings alone must not price a plan by default")
	}
}

func TestAllowingListingsPicksTheDearestCashOne(t *testing.T) {
	s := exitScanner(t)
	books, _, _ := s.economicsReady()
	settings := economics.DefaultSettings()
	settings.MarketFeePercent = 5
	settings.AllowListedExit = true

	legExits, _ := s.exitsFor(books, "Kinetic: Serene Honor", settings)
	leg := economics.Leg{Name: "gem", Exits: legExits}
	deal := economics.Plan(100, []economics.Leg{leg}, nil, settings)
	best := deal.Gems[0].Best
	if best == nil {
		t.Fatal("expected a chosen exit once listings are allowed")
	}
	if best.Venue == economics.VenueSteam {
		t.Fatal("steam funds are valued at zero by default and must not be chosen")
	}
	// DMarket's completed sale of 533 beats the market listing of 520.
	if best.Venue != economics.VenueDMExit {
		t.Fatalf("expected the dearest cash exit, got %q at %v", best.Venue, best.Net)
	}
	if !deal.Optimistic {
		t.Fatal("a listing-backed plan must be flagged optimistic")
	}
}

func TestRaisingSteamWalletValueChangesTheChosenExit(t *testing.T) {
	s := exitScanner(t)
	books, _, _ := s.economicsReady()
	settings := economics.DefaultSettings()
	settings.MarketFeePercent = 5
	settings.SteamWalletValue = 1
	settings.AllowListedExit = true

	legExits, _ := s.exitsFor(books, "Kinetic: Serene Honor", settings)
	leg := economics.Leg{Name: "gem", Exits: legExits}
	deal := economics.Plan(100, []economics.Leg{leg}, nil, settings)
	if deal.Gems[0].Best.Venue != economics.VenueSteam {
		t.Fatalf("600 less 15%% should win once wallet money counts, got %q",
			deal.Gems[0].Best.Venue)
	}
}
