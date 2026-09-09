package scanner

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"radar/internal/journal"
	"radar/internal/steam"
)

/*
Two authorities, one lot.

Steam's economy API describes a *variant*: a classid_instanceid, and what is
socketed in it. The marketplace describes a *lot*: the thing actually for sale.
The radar treated the first as proof of the second, and that is not the same
claim.

A seller can hammer the gem out, sell it separately, and leave the emptied item
listed under the gemmed variant's id. Steam still reports the gem — it is
describing the variant, truthfully — while the lot on offer is empty. Buy it
and the trade that arrives carries a different instanceid altogether.

That is not hypothetical. It happened here: 200339871_1337149273 was listed at
59 RUB with Steam reporting Serene Honor; the marketplace's own description of
the same lot said one empty socket; the seller's public inventory held no such
variant at all, six empty Diffusal Lances, and twenty loose gems including that
Serene Honor. The trade that arrived carried 200339871_3361756675 — empty.

So a gem counts as real only when both authorities see it. Where they disagree,
the finding is not an opportunity: it is a warning, and it is shown as one.
*/

// SocketProof records what each authority says about a lot's sockets.
type SocketProof struct {
	// Checked is false when the marketplace has not been asked yet.
	Checked bool `json:"checked"`
	// SteamGems is what Steam reports for this classid_instanceid.
	SteamGems []string `json:"steam_gems"`
	// MarketGems is what the marketplace says about the lot it is selling.
	MarketGems []string `json:"market_gems"`
	// Agree is true when both authorities report the same kinetic gems.
	Agree bool `json:"agree"`
	// Note explains a disagreement in the operator's language.
	Note string `json:"note,omitempty"`
	// At is when the marketplace was last asked.
	At time.Time `json:"at"`
	// Error is set when the marketplace could not be reached. An unchecked lot
	// is not a confirmed lot, and it is not a refuted one either.
	Error string `json:"error,omitempty"`
}

// Trustworthy reports whether this lot may be presented as an opportunity.
func (p SocketProof) Trustworthy() bool { return p.Checked && p.Agree && p.Error == "" }

// proofCache remembers marketplace verdicts so one sweep does not re-ask about
// every finding it already knows.
type proofCache struct {
	mu  sync.RWMutex
	ttl time.Duration
	by  map[string]SocketProof
}

func newProofCache(ttl time.Duration) *proofCache {
	if ttl <= 0 {
		ttl = 20 * time.Minute
	}
	return &proofCache{ttl: ttl, by: make(map[string]SocketProof)}
}

func (c *proofCache) get(key string) (SocketProof, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	p, ok := c.by[key]
	// A failed check is retried sooner than a successful one: the answer was
	// never obtained, so nothing is being preserved by waiting.
	ttl := c.ttl
	if p.Error != "" {
		ttl = c.ttl / 4
	}
	return p, ok && time.Since(p.At) < ttl
}

func (c *proofCache) put(key string, p SocketProof) {
	c.mu.Lock()
	c.by[key] = p
	c.mu.Unlock()
}

// kineticNames lists the kinetic gems in a block of Valve markup, normalised
// for comparison.
func kineticNames(html string) []string {
	out := make([]string, 0, 2)
	for _, s := range steam.ParseSockets(html) {
		if s.Kind != "kinetic" || s.Name == "" || strings.EqualFold(s.Name, "Empty Socket") {
			continue
		}
		out = append(out, strings.TrimSpace(s.Name))
	}
	sort.Strings(out)
	return out
}

func sameGems(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !strings.EqualFold(a[i], b[i]) {
			return false
		}
	}
	return true
}

// verifyLot asks the marketplace what it is actually selling and compares.
func (s *Scanner) verifyLot(ctx context.Context, f Finding) SocketProof {
	key := f.ClassID + "_" + f.InstanceID
	if p, fresh := s.proofs.get(key); fresh {
		return p
	}

	steamGems := append([]string(nil), f.Gems...)
	sort.Strings(steamGems)
	proof := SocketProof{Checked: true, SteamGems: steamGems, At: time.Now()}

	info, err := s.market.ItemInfo(ctx, f.ClassID, f.InstanceID, "en")
	if err != nil {
		proof.Error = err.Error()
		proof.Note = "площадка не ответила — проверить лот не удалось"
		s.proofs.put(key, proof)
		return proof
	}

	proof.MarketGems = kineticNames(info.DescriptionHTML())
	proof.Agree = sameGems(steamGems, proof.MarketGems)
	if !proof.Agree {
		switch {
		case len(proof.MarketGems) == 0:
			proof.Note = "площадка не показывает кинетик в этом лоте, хотя Steam описывает его у этого варианта — так выглядит выбитый гем под старым объявлением"
		default:
			proof.Note = "площадка и Steam называют разные гемы: " +
				strings.Join(proof.MarketGems, ", ") + " против " + strings.Join(steamGems, ", ")
		}
	}
	s.proofs.put(key, proof)
	return proof
}

// verifyFindings checks every finding against the marketplace before it is
// offered as something to buy.
//
// One request per finding, through the same rate limiter as everything else.
// There are tens of findings, not tens of thousands, so this is affordable —
// and it is the only check that looks at the lot rather than at the variant.
func (s *Scanner) verifyFindings(ctx context.Context) {
	if s.market == nil {
		return
	}
	s.mu.RLock()
	pending := make([]Finding, 0, len(s.findings))
	for _, f := range s.findings {
		pending = append(pending, f)
	}
	s.mu.RUnlock()

	mismatched := 0
	for _, f := range pending {
		if ctx.Err() != nil {
			return
		}
		proof := s.verifyLot(ctx, f)

		s.mu.Lock()
		live, still := s.findings[f.Key]
		if still {
			was := live.Proof.Trustworthy()
			live.Proof = proof
			// A lot the marketplace will not confirm must carry no profit
			// claim. Leaving the plan attached would keep the row sorted among
			// the opportunities and counted in "прибыльных".
			if !proof.Trustworthy() {
				live.Deal = nil
			}
			s.findings[f.Key] = live
			if !proof.Trustworthy() && was {
				mismatched++
			}
		}
		s.mu.Unlock()

		// A seller who is not charging for the gem is not selling one. This is
		// separate from the metadata check and catches what it cannot: a listing
		// whose description is perfectly honest about a variant the seller does
		// not hold.
		if !f.Premium.Priced() {
			// The plan was already withheld in priceFindings; this records why,
			// once per sweep, where it can be read afterwards.
			s.exclude(ExcludedNoGemPremium, 1)
			s.tallyRun(func(r *Run) { r.NoGemPremium++ })
			s.note(journal.LevelWarn, journal.KindFindingDrop, f.ItemName,
				journal.ReasonNoGemPremium,
				"продавец не заложил гем в цену — расчёт снят",
				map[string]any{
					"key": f.Key, "price": f.Price,
					"gem_value":        f.GemValue,
					"cheapest_sibling": f.Premium.Cheapest,
					"premium":          f.Premium.Amount,
					"premium_share":    f.Premium.Share,
				})
		}

		if !proof.Agree && proof.Error == "" {
			mismatched++
			s.exclude(ExcludedSocketMismatch, 1)
			s.note(journal.LevelWarn, journal.KindFindingDrop, f.ItemName,
				journal.ReasonSocketMismatch,
				"лот не подтверждён площадкой — предложение снято с расчёта",
				map[string]any{
					"key":         f.Key,
					"steam_gems":  proof.SteamGems,
					"market_gems": proof.MarketGems,
					"price":       f.Price,
					"note":        proof.Note,
				})
		}
	}
	if mismatched > 0 {
		s.tallyRun(func(r *Run) { r.SocketMismatch += mismatched })
	}
}
