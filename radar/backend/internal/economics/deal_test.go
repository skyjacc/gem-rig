package economics

import "testing"

// Numbers below are the ones measured on the live market on 6 September 2026.
func liveSettings() Settings {
	s := DefaultSettings()
	s.MarketFeePercent = 5 // read from GetDiscounts for this account
	return s
}

// gemLeg builds a gem sellable into a tm.net buy order.
func gemLeg(name string, order float64, orders int, s Settings) Leg {
	return Leg{
		Name:  name,
		Exits: []Exit{NewExit(VenueMarket, order, s, PayoutCash, SpeedInstant, orders)},
	}
}

func TestEyeOfOmozIsNotTheProfitTheOldRadarClaimed(t *testing.T) {
	// The old radar priced Pits of Omoz from the cheapest listing (269 RUB)
	// and reported +121 RUB. The top standing buy order is 98.76.
	s := liveSettings()
	gem := gemLeg("Kinetic: Pits of Omoz", 98.76, 3, s)
	shell := Leg{Name: "Eye of Omoz", Exits: []Exit{NewExit(VenueMarket, 94.00, s, PayoutCash, SpeedInstant, 1)}}

	d := Plan(146.20, []Leg{gem}, &shell, s)

	if d.Invested != 151.90 {
		t.Fatalf("invested should be 146.20 + 5.70 hammer, got %v", d.Invested)
	}
	// 98.76 and 94.00 less 5% each.
	if d.Proceeds != 183.12 {
		t.Fatalf("proceeds should be 183.12, got %v", d.Proceeds)
	}
	if d.Net <= 0 {
		t.Fatalf("with the store-priced hammer this is thin but positive, got %v", d.Net)
	}
	if d.Net > 40 {
		t.Fatalf("it must not look like the old +121 RUB, got %v", d.Net)
	}
}

func TestMarketHammerCanFlipTheDealNegative(t *testing.T) {
	// Buying the tool on the market instead of the in-game store costs 40 RUB
	// per extraction and turns the same lot into a loss.
	s := liveSettings()
	s.ExtractionCost = 40
	gem := gemLeg("Kinetic: Pits of Omoz", 98.76, 3, s)
	shell := Leg{Name: "Eye of Omoz", Exits: []Exit{NewExit(VenueMarket, 94.00, s, PayoutCash, SpeedInstant, 1)}}

	d := Plan(146.20, []Leg{gem}, &shell, s)
	if d.Net >= 0 {
		t.Fatalf("a 40 RUB tool should sink this deal, got %v", d.Net)
	}
	if d.Verdict() != "loss" {
		t.Fatalf("verdict should be loss, got %q", d.Verdict())
	}
}

func TestLanceOfTheSunwarriorIsRealProfit(t *testing.T) {
	s := liveSettings()
	gem := gemLeg("Kinetic: Serene Honor", 386.83, 10, s)
	shell := Leg{Name: "Lance of the Sunwarrior", Exits: []Exit{NewExit(VenueMarket, 14.88, s, PayoutCash, SpeedInstant, 1)}}

	d := Plan(230, []Leg{gem}, &shell, s)
	if d.Net < 100 {
		t.Fatalf("expected roughly +146 RUB, got %v", d.Net)
	}
	if d.ROI < 50 {
		t.Fatalf("expected ROI above 50%%, got %v", d.ROI)
	}
	if !d.Complete {
		t.Fatalf("both legs are priced, plan should be complete: %v", d.Unknowns)
	}
}

func TestSteamWalletIsIgnoredByDefault(t *testing.T) {
	// Steam pays more on paper but the funds cannot be withdrawn, so by
	// default they must not win the exit choice.
	s := liveSettings()
	gem := Leg{Name: "Kinetic: Serene Honor", Exits: []Exit{
		NewExit(VenueMarket, 386.83, s, PayoutCash, SpeedInstant, 10),
		NewExit(VenueSteam, 600, s, PayoutWallet, SpeedListed, 0),
	}}
	d := Plan(230, []Leg{gem}, nil, s)

	if d.Gems[0].Best == nil || d.Gems[0].Best.Venue != VenueMarket {
		t.Fatalf("cash exit must win while wallet money is valued at zero, got %+v", d.Gems[0].Best)
	}
}

func TestSteamWinsAmongListingsOnceWalletMoneyIsValued(t *testing.T) {
	// Speed is decided first, so this compares like with like: two listings,
	// where Steam pays more but only in funds that stay inside Steam.
	s := liveSettings()
	s.SteamWalletValue = 1   // the operator spends on Steam anyway
	s.AllowListedExit = true // and accepts waiting for a buyer
	gem := Leg{Name: "Kinetic: Serene Honor", Exits: []Exit{
		NewExit(VenueMarket, 520, s, PayoutCash, SpeedListed, 0),
		NewExit(VenueSteam, 600, s, PayoutWallet, SpeedListed, 0),
	}}
	d := Plan(230, []Leg{gem}, nil, s)

	if d.Gems[0].Best.Venue != VenueSteam {
		t.Fatalf("600 less 15%% beats 520 less 5%% when wallet money counts, got %q",
			d.Gems[0].Best.Venue)
	}
	if !d.WalletOnly() {
		t.Fatal("a plan that only profits in Steam funds must be flagged")
	}
}

func TestAFillableOrderOutranksASteamListingEvenWhenWalletMoneyCounts(t *testing.T) {
	s := liveSettings()
	s.SteamWalletValue = 1
	s.AllowListedExit = true
	gem := Leg{Name: "Kinetic: Serene Honor", Exits: []Exit{
		NewExit(VenueMarket, 386.83, s, PayoutCash, SpeedInstant, 10),
		NewExit(VenueSteam, 600, s, PayoutWallet, SpeedListed, 0),
	}}
	d := Plan(230, []Leg{gem}, nil, s)

	if d.Gems[0].Best.Speed != SpeedInstant {
		t.Fatal("money in hand today outranks a better price someone might pay later")
	}
	if d.Optimistic {
		t.Fatal("an order-backed plan is not optimistic")
	}
}

func TestMissingExitPriceMakesThePlanIncompleteNotProfitable(t *testing.T) {
	s := liveSettings()
	gem := Leg{Name: "Kinetic: Unknown Thing"} // nobody quotes it
	d := Plan(100, []Leg{gem}, nil, s)

	if d.Complete {
		t.Fatal("a gem nobody prices cannot yield a complete plan")
	}
	if d.Net > 0 {
		t.Fatalf("an unpriced gem must not create profit, got %v", d.Net)
	}
	// Nothing at all could be sold, so the honest label is "unpriced" rather
	// than a loss the numbers do not actually support.
	if d.Verdict() != "unpriced" {
		t.Fatalf("unexpected verdict %q", d.Verdict())
	}
}

func TestInstantFillWinsTies(t *testing.T) {
	s := liveSettings()
	// Same money either way; the order fills now.
	gem := Leg{Name: "gem", Exits: []Exit{
		NewExit(VenueMarket, 100, s, PayoutCash, SpeedListed, 0),
		NewExit(VenueMarket, 100, s, PayoutCash, SpeedInstant, 4),
	}}
	d := Plan(10, []Leg{gem}, nil, s)
	if d.Gems[0].Best.Speed != SpeedInstant {
		t.Fatal("an equally paying instant exit should be preferred")
	}
}

func TestMultipleGemsEachCostAnExtraction(t *testing.T) {
	s := liveSettings()
	gems := []Leg{
		gemLeg("gem one", 200, 2, s),
		gemLeg("gem two", 200, 2, s),
		gemLeg("gem three", 200, 2, s),
	}
	d := Plan(100, gems, nil, s)
	if d.ExtractionCost != round2(3*s.ExtractionCost) {
		t.Fatalf("three gems need three extractions, got %v", d.ExtractionCost)
	}
}

func TestNothingSellableIsNotAHundredPercentLoss(t *testing.T) {
	// Before the order books are warm, no leg has an exit. That is missing
	// data, not a lot guaranteed to lose everything.
	s := liveSettings()
	d := Plan(150, []Leg{{Name: "Kinetic: Something"}}, nil, s)

	if d.Priced {
		t.Fatal("no exit anywhere means the plan is unpriced")
	}
	if d.ROI != 0 {
		t.Fatalf("an unpriced plan must not report -100%%, got %v", d.ROI)
	}
	if d.Verdict() != "unpriced" {
		t.Fatalf("verdict should say so plainly, got %q", d.Verdict())
	}
}

func TestOneSellableLegCountsAsPriced(t *testing.T) {
	s := liveSettings()
	d := Plan(150, []Leg{gemLeg("Kinetic: Serene Honor", 386.83, 10, s)}, nil, s)
	if !d.Priced {
		t.Fatal("a gem with an exit makes the plan priced")
	}
	if d.Complete {
		t.Fatal("the shell is still unknown, so the plan stays incomplete")
	}
}

func TestStandingOrderBeatsARicherListing(t *testing.T) {
	// The listing promises far more, but nobody has agreed to pay it. This is
	// the regression that once turned a losing lot into a reported +838 RUB.
	s := liveSettings()
	gem := Leg{Name: "Kinetic: Dominator's Stance", Exits: []Exit{
		NewExit(VenueMarket, 1100, s, PayoutCash, SpeedListed, 0),
		NewExit(VenueMarket, 148, s, PayoutCash, SpeedInstant, 10),
	}}
	d := Plan(550, []Leg{gem}, nil, s)

	if d.Gems[0].Best.Speed != SpeedInstant {
		t.Fatalf("a fillable order must win over a listing, got %+v", d.Gems[0].Best)
	}
	if d.Optimistic {
		t.Fatal("an order-backed plan is not optimistic")
	}
	if d.Net > 0 {
		t.Fatalf("priced honestly this lot loses money, got %v", d.Net)
	}
}

func TestListingOnlyPlanIsMarkedOptimistic(t *testing.T) {
	s := liveSettings()
	s.AllowListedExit = true
	gem := Leg{Name: "gem", Exits: []Exit{NewExit(VenueMarket, 1100, s, PayoutCash, SpeedListed, 0)}}
	d := Plan(550, []Leg{gem}, nil, s)

	if !d.Optimistic {
		t.Fatal("leaning on a listing must be flagged")
	}
	if d.Complete {
		t.Fatal("an optimistic plan is not a complete one")
	}
	if d.Verdict() != "profit-optimistic" {
		t.Fatalf("verdict should say the profit is not guaranteed, got %q", d.Verdict())
	}
}

func TestWithoutOrdersAndWithoutOptInThereIsNoExit(t *testing.T) {
	s := liveSettings() // AllowListedExit stays false
	gem := Leg{Name: "gem", Exits: []Exit{NewExit(VenueMarket, 1100, s, PayoutCash, SpeedListed, 0)}}
	d := Plan(550, []Leg{gem}, nil, s)

	if d.Priced {
		t.Fatal("a listing alone is not an exit unless the operator allows it")
	}
	if d.Net > 0 {
		t.Fatalf("no exit means no profit, got %v", d.Net)
	}
}
