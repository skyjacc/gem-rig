package scanner

import (
	"context"
	"fmt"
	"log"

	"radar/internal/economics"
	"radar/internal/journal"
	"radar/internal/market"
)

// SetEconomics attaches the order book cache and the operator's terms.
// Without them the scanner still reports findings, but priced from listings
// rather than from what a buyer will actually pay.
func (s *Scanner) SetEconomics(books *economics.BookCache, settings func() economics.Settings) {
	s.mu.Lock()
	s.books = books
	s.econ = settings
	s.mu.Unlock()
}

// economicsReady reports whether a real plan can be built.
func (s *Scanner) economicsReady() (*economics.BookCache, economics.Settings, bool) {
	s.mu.RLock()
	books, settings := s.books, s.econ
	s.mu.RUnlock()
	if books == nil || settings == nil {
		return nil, economics.Settings{}, false
	}
	return books, settings(), true
}

// registerBooks teaches the cache which variant to ask about for each name.
// One request then covers every lot sharing that name.
func (s *Scanner) registerBooks(lots []market.Lot) {
	books, _, ok := s.economicsReady()
	if !ok {
		return
	}
	for _, lot := range lots {
		name := lot.NameEN
		if name == "" {
			name = lot.NameRU
		}
		books.Register(name, lot.ClassID, lot.InstanceID)
	}
}

// planDeal turns a finding into a buy-extract-sell plan using standing orders.
//
// It reads only what the cache already holds. Fetching here would bypass the
// sweep's request budget: with two dozen findings and three names apiece it
// would fire off a hundred rate-limited lookups and stall the whole sweep.
// Warming is the only place allowed to hit the network, and it is budgeted.
func (s *Scanner) planDeal(f Finding) *economics.Deal {
	books, settings, ok := s.economicsReady()
	if !ok {
		return nil
	}

	gems := make([]economics.Leg, 0, len(f.Gems))
	for _, gemName := range f.Gems {
		exits, why := s.exitsFor(books, marketGemName(gemName), settings)
		gems = append(gems, economics.Leg{Name: gemName, Exits: exits, Reason: why})
	}

	var shell *economics.Leg
	// The emptied item is sold under the same name, so the host order book
	// applies to it unchanged.
	if exits, why := s.exitsFor(books, f.ItemName, settings); len(exits) > 0 {
		shell = &economics.Leg{Name: f.ItemName, Exits: exits, Reason: why}
	}

	deal := economics.Plan(f.Price, gems, shell, settings)
	return &deal
}

// exitsFor collects every way to sell one item name.
//
// Nothing here costs a request: the order book was warmed by the sweep, and
// the other venues' prices were already gathered by the price collector. They
// are not interchangeable, so each carries its own payout form and speed and
// the plan picks between them by what the operator says the money is worth.
// exitsFor returns every way this name can be turned into money, and — when
// there are none — why. The caller cannot tell an unsold name from an unasked
// one without that second value.
func (s *Scanner) exitsFor(books *economics.BookCache, name string, settings economics.Settings) ([]economics.Exit, string) {
	var exits []economics.Exit

	// The standing buy order on the market: cash, and it fills immediately.
	book, bookRead := books.Lookup(name)
	if bookRead && book.Best > 0 {
		exits = append(exits, economics.NewExit(economics.VenueMarket, book.Best, settings,
			economics.PayoutCash, economics.SpeedInstant, book.Orders))
	}

	priced, quoted := s.book.Price(name)
	if !quoted {
		return exits, whyNoExit(bookRead, book.Best > 0, false, len(exits))
	}
	for _, q := range priced.Quotes {
		switch q.Source {
		case SourceName:
			// Listing the gem yourself rather than filling an order: more
			// money, but only once a buyer turns up.
			exits = append(exits, economics.NewExit(economics.VenueMarket, q.Price, settings,
				economics.PayoutCash, economics.SpeedListed, 0))
		case "steam":
			// Steam pays well but in funds that cannot be withdrawn.
			exits = append(exits, economics.NewExit(economics.VenueSteam, q.Price, settings,
				economics.PayoutWallet, economics.SpeedListed, q.Volume))
		case DMarketSourceName:
			// DMarket publishes completed sales, so this is what the gem has
			// actually been fetching there rather than what someone hopes for.
			exits = append(exits, economics.NewExit(economics.VenueDMExit, q.Price, settings,
				economics.PayoutCash, economics.SpeedListed, q.Volume))
		}
		// waxpeer, lootfarm and lis-skins price the gem but selling there
		// needs a deposit and an account, so they inform the valuation
		// without being offered as an exit.
	}
	return exits, whyNoExit(bookRead, book.Best > 0, true, len(exits))
}

// whyNoExit puts the absence into words. Empty when there is no absence.
func whyNoExit(bookRead, bookHasBid, quoted bool, exits int) string {
	if exits > 0 {
		return ""
	}
	switch {
	case !bookRead && !quoted:
		return "стакан не читали и цены нет ни на одной площадке — выход неизвестен"
	case !bookRead:
		return "стакан ордеров не прочитан: до этого имени не дошла очередь или запрос не удался"
	case !bookHasBid && !quoted:
		return "стакан пуст и ни одна площадка не котирует это имя"
	case !bookHasBid:
		return "встречных ордеров нет, а площадки, которые котируют это имя, продавать на себя не дают"
	default:
		return "выход не найден"
	}
}

// marketGemName turns a socket name into the market's listing name.
// Steam renders the socket contents as "Serene Honor"; every marketplace
// sells the same gem as "Kinetic: Serene Honor".
func marketGemName(socketName string) string {
	if socketName == "" {
		return ""
	}
	if len(socketName) > 8 && socketName[:8] == "Kinetic:" {
		return socketName
	}
	return "Kinetic: " + socketName
}

// applyDeals prices every finding against the order books, warming the cache
// for the names involved first so one sweep costs a bounded number of calls.
func (s *Scanner) applyDeals(ctx context.Context, budget int) {
	books, _, ok := s.economicsReady()
	if !ok {
		return
	}

	s.mu.RLock()
	seen := make(map[string]bool, len(s.findings)*2)
	names := make([]string, 0, len(s.findings)*2)
	keys := make([]string, 0, len(s.findings))
	for key, f := range s.findings {
		keys = append(keys, key)
		// Gems first: without an exit price there is no plan at all, while a
		// missing shell price only makes the plan conservative.
		for _, g := range f.Gems {
			if n := marketGemName(g); !seen[n] {
				seen[n] = true
				names = append(names, n)
			}
		}
		if !seen[f.ItemName] {
			seen[f.ItemName] = true
			names = append(names, f.ItemName)
		}
	}
	s.mu.RUnlock()

	// Price from whatever is already cached first, so the table fills as soon
	// as the sweep starts rather than only after every lookup has finished.
	s.setPhase(PhaseOrders, "читаем стаканы ордеров", 0, len(names))
	s.priceFindings(keys)

	const chunk = 10
	warmed := 0
	for start := 0; start < len(names) && warmed < budget; start += chunk {
		end := start + chunk
		if end > len(names) {
			end = len(names)
		}
		warmed += books.Warm(ctx, names[start:end], budget-warmed)
		s.priceFindings(keys)
		s.setPhase(PhaseOrders,
			fmt.Sprintf("прочитано стаканов %d из %d", end, len(names)), end, len(names))
		if ctx.Err() != nil {
			break
		}
	}
	if warmed > 0 {
		log.Printf("[orders] обновлено стаканов: %d", warmed)
		s.note(journal.LevelDebug, journal.KindOrderBook, "", "", "обновлены стаканы ордеров",
			map[string]any{"fetched": warmed, "budget": budget, "names": len(names)})
	}

	// Tally the exclusions once, from the state the sweep actually ended in.
	//
	// priceFindings runs again after every warmed chunk, so counting inside it
	// counted each finding on its way through: a lot that starts unpriced,
	// becomes priced-but-incomplete, then completes was added to two different
	// exclusion buckets and subtracted from neither. A sweep could report
	// "22 offers, 20 priced" alongside "22 gem_unpriced". This runs after the
	// loop whether it finished or broke early on cancellation, so a cut-short
	// sweep still reports where it really stopped.
	unpriced, incomplete := 0, 0
	s.mu.RLock()
	for _, key := range keys {
		f, still := s.findings[key]
		if !still || f.Deal == nil {
			continue
		}
		if !f.Deal.Priced {
			unpriced++
		} else if !f.Deal.Complete {
			incomplete++
		}
	}
	s.mu.RUnlock()
	// Emitted after the lock: exclude takes the same mutex for reading.
	s.exclude(ExcludedGemUnpriced, unpriced)
	s.exclude(ExcludedNoOrderBook, incomplete)
	// Report the whole cache, not just this sweep's fetches: the table asks how
	// many names the radar can price right now, and a book stays usable between
	// sweeps.
	s.reportSource(OrderBookSourceName, books.Size(), nil)
}

// priceFindings recomputes the plan for each key from the cached order books.
func (s *Scanner) priceFindings(keys []string) {
	for _, key := range keys {
		s.mu.RLock()
		f, still := s.findings[key]
		s.mu.RUnlock()
		if !still {
			continue
		}
		deal := s.planDeal(f)
		if deal == nil {
			continue
		}
		changed := f.Deal == nil || f.Deal.Net != deal.Net
		f.Deal = deal
		if changed {
			level := journal.LevelInfo
			kind := journal.KindDealPriced
			reason := ""
			message := "рассчитан полный цикл: покупка, извлечение, продажа в ордер"
			if !deal.Complete {
				level, kind = journal.LevelWarn, journal.KindDealFailed
				reason = journal.ReasonNoOrderBook
				message = "расчёт неполный, часть выходов не оценена"
			}
			s.note(level, kind, f.ItemName, reason, message, map[string]any{
				"key": key, "invested": deal.Invested, "proceeds": deal.Proceeds,
				"net": deal.Net, "roi": deal.ROI, "unknowns": deal.Unknowns,
			})
		}
		s.mu.Lock()
		if _, current := s.findings[key]; current {
			s.findings[key] = f
		}
		s.mu.Unlock()
	}
}
