package scanner

import (
	"testing"

	"radar/internal/market"
)

func lance(instanceID string, price float64) market.Lot {
	return market.Lot{ClassID: "200339871", InstanceID: instanceID, Price: price, NameEN: "Diffusal Lance"}
}

// The lot that was bought and swapped, with its real siblings.
//
// Steam and the marketplace both described variant 1337149273 as carrying
// Serene Honor, and both were telling the truth about the variant. The seller
// did not own it: the trade that arrived carried an empty lance. What the
// listing could not hide is the price — 59.52 against empty siblings at 59.17,
// a premium of 35 kopeks on a gem worth 557 roubles.
func TestASellerWhoDoesNotPriceTheGemIsNotSellingOne(t *testing.T) {
	catalogue := map[string]market.Lot{
		"a": lance("1337149273", 59.52),
		"b": lance("942400867", 59.17),
		"c": lance("57949762", 59.18),
		"d": lance("8806173784", 62.19),
	}
	p := premiumFor(lance("1337149273", 59.52), 557, catalogue)

	if !p.Measured {
		t.Fatal("four siblings are enough to measure against")
	}
	if p.Amount > 1 {
		t.Fatalf("the premium was 35 kopeks, got %.2f", p.Amount)
	}
	if p.Priced() {
		t.Fatalf("a 557 RUB gem sold for %.2f extra is not being sold (share %.4f)", p.Amount, p.Share)
	}
}

// The ordinary listings from the same sweep must survive, or the check is just
// a filter that empties the table.
func TestHonestListingsKeepTheirPremium(t *testing.T) {
	cases := []struct {
		name     string
		price    float64
		cheapest float64
		gemValue float64
	}{
		{"Lance of the Sunwarrior", 230, 21.11, 557},
		{"Shattered Destroyer", 105, 0.45, 133},
		{"Ancipitous Strike", 5, 0.50, 19},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			catalogue := map[string]market.Lot{
				"mine":  {ClassID: "X", InstanceID: "1", Price: c.price},
				"other": {ClassID: "X", InstanceID: "2", Price: c.cheapest},
			}
			p := premiumFor(market.Lot{ClassID: "X", InstanceID: "1", Price: c.price}, c.gemValue, catalogue)
			if !p.Priced() {
				t.Fatalf("premium %.2f of a %.0f gem (share %.2f) is a real price for it",
					p.Amount, c.gemValue, p.Share)
			}
		})
	}
}

// The only variant on the market has nothing to be compared against. An
// unmeasurable signal must not read as a failed one.
func TestNoSiblingsIsNotAVerdict(t *testing.T) {
	catalogue := map[string]market.Lot{"only": lance("1337149273", 59.52)}
	p := premiumFor(lance("1337149273", 59.52), 557, catalogue)
	if p.Measured {
		t.Fatal("there is no sibling to measure against")
	}
	if !p.Priced() {
		t.Fatal("an unmeasurable premium must not condemn the lot")
	}
}

// A gem nobody has priced gives the comparison no denominator.
func TestUnpricedGemYieldsNoVerdict(t *testing.T) {
	catalogue := map[string]market.Lot{
		"a": lance("1337149273", 59.52),
		"b": lance("942400867", 59.17),
	}
	if p := premiumFor(lance("1337149273", 59.52), 0, catalogue); p.Measured {
		t.Fatal("without a gem value there is nothing to take a share of")
	}
}

// Sibling variants of a different item must not enter the comparison.
func TestOnlyTheSameItemCounts(t *testing.T) {
	catalogue := map[string]market.Lot{
		"mine":  lance("1337149273", 59.52),
		"other": {ClassID: "999999", InstanceID: "1", Price: 0.45},
	}
	p := premiumFor(lance("1337149273", 59.52), 557, catalogue)
	if p.Measured {
		t.Fatal("a different classid is a different item, not a sibling")
	}
}
