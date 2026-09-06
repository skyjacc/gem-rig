// Package economics turns a lot into a full buy-extract-sell calculation.
//
// The radar used to call the cheapest listing of a gem its "value". That is
// not a price anyone pays. Kinetic: Pits of Omoz was listed at 280 RUB while
// the best standing buy order was 98 RUB, so a lot the radar reported at
// +121 RUB was actually a small loss once the tool and the commission were
// counted. Everything here works from what a buyer will actually pay.
package economics

import (
	"math"
	"sort"
	"strings"
)

// Venue is a place the item or gem can be sold.
type Venue string

const (
	VenueMarket Venue = "tm.net"
	VenueSteam  Venue = "steam"
	VenueDMExit Venue = "dmarket"
)

// Payout describes what kind of money an exit produces. Steam wallet funds
// cannot be withdrawn, so they must never be silently compared with cash.
type Payout string

const (
	// PayoutCash is money that can leave the platform.
	PayoutCash Payout = "cash"
	// PayoutWallet is spendable only inside the platform, like Steam funds.
	PayoutWallet Payout = "wallet"
)

// Speed distinguishes an exit that fills now from one that waits for a buyer.
type Speed string

const (
	// SpeedInstant fills against a standing buy order.
	SpeedInstant Speed = "instant"
	// SpeedListed waits for someone to take the listing.
	SpeedListed Speed = "listed"
)

// Exit is one way to turn an item into money.
type Exit struct {
	Venue Venue `json:"venue"`
	// Gross is the headline price at this venue, in roubles.
	Gross float64 `json:"gross"`
	// FeePercent is what the venue keeps.
	FeePercent float64 `json:"fee_percent"`
	// Net is what actually arrives, in roubles.
	Net float64 `json:"net"`
	// Weighted is Net adjusted by how much this payout form is worth to the
	// operator. Cash is always worth its face value.
	Weighted float64 `json:"weighted"`
	Payout   Payout  `json:"payout"`
	Speed    Speed   `json:"speed"`
	// Orders is how many buyers are queued at this venue, when known.
	Orders int `json:"orders,omitempty"`
	// Note explains a caveat, such as an unconfirmed commission.
	Note string `json:"note,omitempty"`
}

// Settings are the operator's own terms. Nothing here is guessed at runtime.
type Settings struct {
	// MarketFeePercent is the account's own commission, read from the market.
	MarketFeePercent float64
	// SteamFeePercent is what Steam keeps. Dota 2 charges 10% to the game plus
	// 5% to Steam; it is a setting because the exact figure is only visible on
	// the account's own listing screen.
	SteamFeePercent float64
	// DMarketFeePercent is DMarket's cut. Not published in their API.
	DMarketFeePercent float64
	// SteamWalletValue is how much a rouble of Steam funds is worth to the
	// operator, from 0 (useless, cannot withdraw) to 1 (as good as cash).
	SteamWalletValue float64
	// ExtractionCost is what one gem extraction costs, in roubles.
	ExtractionCost float64
	// AllowListedExit lets a plan settle on a listing price instead of a
	// standing buy order. A listing is a hope, not an exit: to actually sell
	// you must undercut it and then wait. Off by default, because letting the
	// ask win is exactly how the radar once reported +838 RUB on a lot whose
	// order-book value made it a loss.
	AllowListedExit bool
	// SteamFeeConfirmed marks whether the Steam commission was verified.
	SteamFeeConfirmed bool
	// DMarketFeeConfirmed marks whether the DMarket commission was verified.
	DMarketFeeConfirmed bool
}

// DefaultSettings are deliberately conservative.
//
// Steam funds count for nothing until the operator says otherwise: a plan that
// looks profitable only in wallet money is not a plan to make money.
func DefaultSettings() Settings {
	return Settings{
		MarketFeePercent:  5,
		SteamFeePercent:   15,
		DMarketFeePercent: 7,
		SteamWalletValue:  0,
		// One Artificer's Hammer from the in-game store: $0.99 for a stack of
		// 15 uses, per items_game.txt, at roughly 86 RUB to the dollar.
		ExtractionCost: 5.7,
	}
}

// netAfterFee applies a percentage commission.
func netAfterFee(gross, feePercent float64) float64 {
	if gross <= 0 {
		return 0
	}
	return round2(gross * (1 - feePercent/100))
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

// NewExit builds an exit and works out what it is really worth.
func NewExit(venue Venue, gross float64, s Settings, payout Payout, speed Speed, orders int) Exit {
	e := Exit{Venue: venue, Gross: round2(gross), Payout: payout, Speed: speed, Orders: orders}
	switch venue {
	case VenueSteam:
		e.FeePercent = s.SteamFeePercent
		if !s.SteamFeeConfirmed {
			e.Note = "комиссия Steam не подтверждена на аккаунте"
		}
	case VenueDMExit:
		e.FeePercent = s.DMarketFeePercent
		if !s.DMarketFeeConfirmed {
			e.Note = "комиссия DMarket не подтверждена"
		}
	default:
		e.FeePercent = s.MarketFeePercent
	}
	e.Net = netAfterFee(e.Gross, e.FeePercent)
	e.Weighted = e.Net
	if e.Payout == PayoutWallet {
		e.Weighted = round2(e.Net * s.SteamWalletValue)
	}
	return e
}

// Leg is one thing being sold: the extracted gem, or the emptied item.
type Leg struct {
	Name string `json:"name"`
	// Exits are every way this leg can be sold, best weighted first.
	Exits []Exit `json:"exits"`
	// Best is the exit the plan assumes. Nil when nothing can be sold.
	Best *Exit `json:"best,omitempty"`
	// Reason explains an empty Exits list.
	//
	// "Nobody bids" and "we never asked" both produced no exits, and the panel
	// printed the first for both — asserting an absence of demand it had not
	// established. Set only when Exits is empty.
	Reason string `json:"reason,omitempty"`
}

// pickBest chooses the exit the plan will assume.
//
// An exit that fills against a standing order always outranks a listing, no
// matter how much more the listing promises. The listing price is what other
// sellers are asking, not what anyone has agreed to pay, and to use it you
// would have to undercut it and wait an unknown time.
func (l *Leg) pickBest(s Settings) {
	sort.SliceStable(l.Exits, func(i, j int) bool {
		a, b := l.Exits[i], l.Exits[j]
		if (a.Speed == SpeedInstant) != (b.Speed == SpeedInstant) {
			return a.Speed == SpeedInstant
		}
		return a.Weighted > b.Weighted
	})
	for i := range l.Exits {
		e := l.Exits[i]
		if e.Weighted <= 0 {
			continue
		}
		if e.Speed != SpeedInstant && !s.AllowListedExit {
			continue
		}
		l.Best = &l.Exits[i]
		return
	}
	l.Best = nil
}

// Deal is the whole plan for one lot: what it costs to get in, what comes back
// out, and what is still unknown.
type Deal struct {
	// BuyPrice is what the lot costs, in roubles.
	BuyPrice float64 `json:"buy_price"`
	// ExtractionCost is the tool, counted once per gem.
	ExtractionCost float64 `json:"extraction_cost"`
	Invested       float64 `json:"invested"`

	// Gem is the extracted gem being sold.
	Gems []Leg `json:"gems"`
	// Shell is the item left behind after extraction.
	Shell *Leg `json:"shell,omitempty"`

	Proceeds float64 `json:"proceeds"`
	Net      float64 `json:"net"`
	ROI      float64 `json:"roi"`
	// Complete is false when a required number was missing, in which case the
	// result is a lower bound rather than a forecast.
	Complete bool `json:"complete"`
	// Priced is false when nothing at all could be sold. Such a plan is not a
	// loss, it is an absence of data, and must never be shown as -100%.
	Priced bool `json:"priced"`
	// Optimistic is true when the plan leans on a listing rather than on a
	// standing order, so the money is not guaranteed and not immediate.
	Optimistic bool `json:"optimistic"`
	// Unknowns lists what could not be priced.
	Unknowns []string `json:"unknowns,omitempty"`
}

// Plan assembles the deal. Legs with no sellable exit contribute nothing and
// are recorded as unknowns, so a missing price can never inflate the result.
func Plan(buyPrice float64, gems []Leg, shell *Leg, s Settings) Deal {
	d := Deal{
		BuyPrice:       round2(buyPrice),
		ExtractionCost: round2(s.ExtractionCost * float64(len(gems))),
		Gems:           gems,
		Shell:          shell,
		Complete:       true,
	}
	d.Invested = round2(d.BuyPrice + d.ExtractionCost)

	for i := range d.Gems {
		d.Gems[i].pickBest(s)
		if d.Gems[i].Best == nil {
			d.Complete = false
			d.Unknowns = append(d.Unknowns, "нет цены выхода: "+d.Gems[i].Name)
			continue
		}
		d.Proceeds += d.Gems[i].Best.Weighted
	}
	if d.Shell != nil {
		d.Shell.pickBest(s)
		if d.Shell.Best == nil {
			d.Complete = false
			d.Unknowns = append(d.Unknowns, "остаток носителя не оценён")
		} else {
			d.Proceeds += d.Shell.Best.Weighted
		}
	} else {
		d.Complete = false
		d.Unknowns = append(d.Unknowns, "остаток носителя не оценён")
	}
	if !s.SteamFeeConfirmed && usesVenue(d, VenueSteam) {
		d.Unknowns = append(d.Unknowns, "комиссия Steam взята по умолчанию")
	}

	for _, g := range d.Gems {
		if g.Best != nil {
			d.Priced = true
			if g.Best.Speed != SpeedInstant {
				d.Optimistic = true
			}
		}
	}
	if d.Shell != nil && d.Shell.Best != nil {
		d.Priced = true
		if d.Shell.Best.Speed != SpeedInstant {
			d.Optimistic = true
		}
	}
	if d.Optimistic {
		d.Unknowns = append(d.Unknowns,
			"часть выхода взята из объявления, а не из стоящего ордера: продажа не мгновенна и цену придётся опустить")
	}

	d.Proceeds = round2(d.Proceeds)
	d.Net = round2(d.Proceeds - d.Invested)
	if d.Invested > 0 && d.Priced {
		d.ROI = round2(d.Net / d.Invested * 100)
	}
	return d
}

// usesVenue reports whether the chosen plan sells anything at a venue.
func usesVenue(d Deal, v Venue) bool {
	for _, g := range d.Gems {
		if g.Best != nil && g.Best.Venue == v {
			return true
		}
	}
	return d.Shell != nil && d.Shell.Best != nil && d.Shell.Best.Venue == v
}

// Verdict is a short, honest label for the result.
func (d Deal) Verdict() string {
	switch {
	case !d.Priced:
		return "unpriced"
	case d.Net > 0 && d.Optimistic:
		return "profit-optimistic"
	case d.Net > 0 && d.Complete:
		return "profit"
	case d.Net > 0:
		return "profit-partial"
	case !d.Complete:
		return "unknown"
	default:
		return "loss"
	}
}

// WalletOnly reports whether the plan only works because Steam funds were
// counted. Worth surfacing: that money cannot be withdrawn.
func (d Deal) WalletOnly() bool {
	if d.Net <= 0 {
		return false
	}
	cash := 0.0
	for _, g := range d.Gems {
		if g.Best != nil && g.Best.Payout == PayoutCash {
			cash += g.Best.Weighted
		}
	}
	if d.Shell != nil && d.Shell.Best != nil && d.Shell.Best.Payout == PayoutCash {
		cash += d.Shell.Best.Weighted
	}
	return cash-d.Invested <= 0
}

// Describe renders the plan as a compact line for logs.
func (d Deal) Describe() string {
	var parts []string
	for _, g := range d.Gems {
		if g.Best != nil {
			parts = append(parts, g.Name+" -> "+string(g.Best.Venue))
		}
	}
	return strings.Join(parts, ", ")
}
