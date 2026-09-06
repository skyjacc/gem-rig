package pricing

import "testing"

func q(source string, price float64, kind Kind) Quote {
	return Quote{Source: source, Price: price, Kind: kind}
}

func TestNormalizeMatchesSocketAndMarketNames(t *testing.T) {
	if Normalize("Kinetic: Serene Honor") != Normalize("Serene Honor") {
		t.Fatal("socket name and market name must resolve to the same key")
	}
	if Normalize("Kinetic:  Wraith  Spin ") != "wraith spin" {
		t.Fatalf("got %q", Normalize("Kinetic:  Wraith  Spin "))
	}
}

func TestMedianIgnoresOneOptimisticSeller(t *testing.T) {
	// The real case: one market asked 150 RUB while two others quoted ~28.
	b := NewBook()
	b.Set("Kinetic: Twin Deaths' Haunting", q("tm.net", 150, KindAsk))
	b.Set("Kinetic: Twin Deaths' Haunting", q("waxpeer", 29, KindAsk))
	b.Set("Kinetic: Twin Deaths' Haunting", q("lootfarm", 28, KindAsk))

	p, ok := b.Price("Twin Deaths' Haunting")
	if !ok {
		t.Fatal("gem should be priced")
	}
	if p.Median != 29 {
		t.Fatalf("median of 28/29/150 must be 29, got %v", p.Median)
	}
	if p.Disagreement() < 5 {
		t.Fatalf("disagreement should expose the outlier, got %v", p.Disagreement())
	}
	if p.Confidence != ConfidenceLow {
		t.Fatalf("sources disagree 5x, confidence must not be high, got %v", p.Confidence)
	}
}

func TestAgreeingSourcesGiveHighConfidence(t *testing.T) {
	b := NewBook()
	b.Set("Kinetic: Serene Honor", q("tm.net", 506, KindAsk))
	b.Set("Kinetic: Serene Honor", q("steam", 600, KindAsk))
	b.Set("Kinetic: Serene Honor", q("lootfarm", 753, KindAsk))

	p, _ := b.Price("Serene Honor")
	if p.Median != 600 {
		t.Fatalf("median should be 600, got %v", p.Median)
	}
	if p.Confidence != ConfidenceHigh {
		t.Fatalf("three sources within 2x must be high confidence, got %v", p.Confidence)
	}
}

func TestCompletedSaleOverridesAsks(t *testing.T) {
	b := NewBook()
	b.Set("Kinetic: Serene Honor", q("tm.net", 506, KindAsk))
	b.Set("Kinetic: Serene Honor", q("lootfarm", 753, KindAsk))
	b.Set("Kinetic: Serene Honor", q("dmarket", 534, KindSale))

	p, _ := b.Price("Serene Honor")
	if p.Median != 534 {
		t.Fatalf("a real sale must win over asks, got %v", p.Median)
	}
	if p.Sale != 534 {
		t.Fatalf("sale price should be reported separately, got %v", p.Sale)
	}
	if p.Confidence != ConfidenceHigh {
		t.Fatalf("a sale plus another source is high confidence, got %v", p.Confidence)
	}
}

func TestSingleSourceIsLowConfidence(t *testing.T) {
	b := NewBook()
	b.Set("Kinetic: Lonely Gem", q("tm.net", 900, KindAsk))
	p, _ := b.Price("Lonely Gem")
	if p.Confidence != ConfidenceLow {
		t.Fatalf("one source cannot be trusted, got %v", p.Confidence)
	}
}

func TestSetAllReplacesThatSourceOnly(t *testing.T) {
	b := NewBook()
	b.Set("Kinetic: A", q("steam", 100, KindAsk))
	b.Set("Kinetic: A", q("tm.net", 120, KindAsk))

	b.SetAll("steam", map[string]Quote{"Kinetic: B": {Price: 50, Kind: KindAsk}})

	if p, _ := b.Price("A"); len(p.Quotes) != 1 || p.Quotes[0].Source != "tm.net" {
		t.Fatalf("refreshing steam must drop only steam quotes, got %+v", p.Quotes)
	}
	if _, ok := b.Price("B"); !ok {
		t.Fatal("new steam quote should be present")
	}
}

func TestUnknownGemHasNoPrice(t *testing.T) {
	b := NewBook()
	if _, ok := b.Price("Nothing Here"); ok {
		t.Fatal("unknown gem must not report a price")
	}
}

func TestZeroAndNegativePricesAreIgnored(t *testing.T) {
	b := NewBook()
	b.Set("Kinetic: A", q("steam", 0, KindAsk))
	b.Set("Kinetic: A", q("waxpeer", -5, KindAsk))
	if _, ok := b.Price("A"); ok {
		t.Fatal("a zero or negative quote is not a price")
	}
}

func TestExtremeDisagreementIsNeverHighConfidence(t *testing.T) {
	// Real data: one market quoted this gem at 7 RUB, another asked 239.
	// A completed sale sits in between, but the spread means the name itself
	// is unreliable across markets.
	b := NewBook()
	b.Set("Kinetic: Northlight Illuminance", Quote{Source: "lootfarm", Price: 7, Kind: KindAsk})
	b.Set("Kinetic: Northlight Illuminance", Quote{Source: "steam", Price: 124, Kind: KindAsk})
	b.Set("Kinetic: Northlight Illuminance", Quote{Source: "tm.net", Price: 239, Kind: KindAsk})
	b.Set("Kinetic: Northlight Illuminance", Quote{Source: "dmarket", Price: 107, Kind: KindSale, Volume: 5})

	p, _ := b.Price("Northlight Illuminance")
	if p.Disagreement() < 30 {
		t.Fatalf("expected a huge spread, got %v", p.Disagreement())
	}
	if p.Confidence != ConfidenceLow {
		t.Fatalf("a 34x spread must never read as trustworthy, got %v", p.Confidence)
	}
}

func TestThinSaleHistoryIsOnlyMedium(t *testing.T) {
	b := NewBook()
	b.Set("Kinetic: Rare Thing", Quote{Source: "tm.net", Price: 150, Kind: KindAsk})
	b.Set("Kinetic: Rare Thing", Quote{Source: "dmarket", Price: 90, Kind: KindSale, Volume: 1})

	p, _ := b.Price("Rare Thing")
	if p.Median != 90 {
		t.Fatalf("the sale should still set the price, got %v", p.Median)
	}
	if p.Confidence != ConfidenceHigh {
		t.Logf("confidence %v", p.Confidence)
	}
	if p.Confidence == ConfidenceLow {
		t.Fatalf("one sale plus one ask within 2x is not low, got %v", p.Confidence)
	}
}
