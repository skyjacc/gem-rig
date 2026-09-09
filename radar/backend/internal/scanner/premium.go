package scanner

import (
	"radar/internal/market"
)

/*
Does the seller price the gem?

Metadata cannot catch every swap. Steam describes a variant and the marketplace
describes its lot, and both can be telling the truth about a variant the seller
does not own: the emptied item goes up under the gemmed variant's id, and the
trade that arrives carries a different instanceid entirely.

There is a signal the listing itself cannot hide. A seller holding a gem worth
several hundred roubles prices it in. A seller holding an empty shell prices it
like the other empty shells, because that is what it is.

Measured on live data, the difference is not subtle:

	Diffusal Lance           gem ~557 RUB   premium over its empty siblings  +0.35
	Lance of the Sunwarrior  gem ~557 RUB   premium                        +208.89
	Shattered Destroyer      gem ~133 RUB   premium                        +104.55
	Ancipitous Strike        gem  ~19 RUB   premium                          +4.50

The first is the lot that was bought and swapped. The rest are ordinary.

A low premium is not proof of fraud — a genuine mispricing looks the same for
the seconds it survives. So this does not delete the offer. It refuses to
present it as a confident profit, says plainly what is odd about it, and leaves
the judgement to the operator.
*/

// PricePremium is what the seller charges for the gem, over the same item
// without one.
type PricePremium struct {
	// Measured is false when there is no sibling variant to compare against.
	Measured bool `json:"measured"`
	// Cheapest is the lowest price among other variants of the same item.
	Cheapest float64 `json:"cheapest_sibling"`
	// Siblings is how many other variants were on offer.
	Siblings int `json:"siblings"`
	// Amount is this lot's price minus the cheapest sibling.
	Amount float64 `json:"amount"`
	// Share is Amount as a fraction of the gem's value. A gem worth 557 that
	// costs 0.35 extra is not being sold.
	Share float64 `json:"share"`
}

// minPremiumShare is how much of the gem's value a seller must be charging
// before the listing is taken at face value.
//
// Ten per cent is deliberately generous: the honest listings measured here sat
// at 24, 37 and 79 per cent, and the swapped one at 0.06. Anything under this
// means the gem is not part of the price.
const minPremiumShare = 0.10

// Priced reports whether the seller is charging for the gem at all.
func (p PricePremium) Priced() bool { return !p.Measured || p.Share >= minPremiumShare }

// premiumFor compares a lot against the other variants of the same item.
func premiumFor(lot market.Lot, gemValue float64, catalogue map[string]market.Lot) PricePremium {
	if gemValue <= 0 || lot.Price <= 0 {
		return PricePremium{}
	}
	cheapest := 0.0
	siblings := 0
	for _, other := range catalogue {
		if other.ClassID != lot.ClassID || other.InstanceID == lot.InstanceID || other.Price <= 0 {
			continue
		}
		siblings++
		if cheapest == 0 || other.Price < cheapest {
			cheapest = other.Price
		}
	}
	if siblings == 0 {
		// Nothing to compare against. Silence is not evidence either way.
		return PricePremium{}
	}
	amount := lot.Price - cheapest
	return PricePremium{
		Measured: true,
		Cheapest: cheapest,
		Siblings: siblings,
		Amount:   amount,
		Share:    amount / gemValue,
	}
}
