// Package guard watches incoming Steam trade offers and compares what is
// actually being sent against what was paid for on the market.
//
// The attack it exists to stop: a seller lists an item that holds a valuable
// kinetic gem, then hammers the gem out after the sale. The item keeps its
// classid but gets a new instanceid, and the market's cached listing still
// advertises the old one. A browser auto-accept extension sees the right item
// name and confirms the trade, and the gem is gone.
//
// The guard never accepts or declines anything. It raises an alarm and leaves
// the decision to a person.
package guard

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"radar/internal/hub"
	"radar/internal/journal"
	"radar/internal/market"
	"radar/internal/secrets"
	"radar/internal/steam"
)

// Severity ranks how bad an incoming offer looks.
type Severity string

const (
	SeverityOK Severity = "ok"
	// SeverityUnknown is the verdict when a check could not run at all.
	//
	// It exists because "ok" and "unknown" were the same value here, and the
	// difference is the whole point of the guard: a green shield reading
	// "Совпадает" over an offer whose purchase list never loaded is worse than
	// no guard, because it invites the operator to accept a swap.
	SeverityUnknown  Severity = "unknown"
	SeverityWarn     Severity = "warn"
	SeverityCritical Severity = "critical"
)

// OfferItem is one item inside an incoming trade offer.
type OfferItem struct {
	AssetID    string   `json:"assetid"`
	ClassID    string   `json:"classid"`
	InstanceID string   `json:"instanceid"`
	Name       string   `json:"name"`
	Gems       []string `json:"gems"`
	// SocketsRead says whether Steam actually described this item. Without it,
	// an empty Gems list means both "no kinetic gem" and "we never got to
	// look" — and the panel printed the first for both.
	//
	// Set per item, never from the batch error: Steam returns partial results,
	// so one failed call can still carry half the descriptions.
	SocketsRead bool   `json:"sockets_read"`
	Expected    bool   `json:"expected"`
	Note        string `json:"note"`
}

// Checked records which comparisons actually ran behind a verdict.
type Checked struct {
	// Purchases is true when the market's list of what this account paid for
	// was read successfully.
	Purchases bool `json:"purchases"`
	// Sockets is true when Steam described every item in the offer.
	Sockets bool `json:"sockets"`
	// Blockers names what stopped a check, in the operator's language.
	Blockers []string `json:"blockers,omitempty"`
}

// Alert is the guard's verdict on one incoming offer.
type Alert struct {
	OfferID   string      `json:"offer_id"`
	Partner   string      `json:"partner"`
	Severity  Severity    `json:"severity"`
	Headline  string      `json:"headline"`
	Details   []string    `json:"details"`
	Items     []OfferItem `json:"items"`
	Checked   Checked     `json:"checked"`
	CheckedAt time.Time   `json:"checked_at"`
}

// Guard polls Steam for incoming offers and evaluates them.
type Guard struct {
	steam   *steam.Client
	market  *market.Client
	hub     *hub.Hub
	http    *http.Client
	keyFunc func() string
	// hide keeps the Steam key out of every error this guard reports. Guard
	// errors are the ones most likely to be read and forwarded: they appear on
	// the Обмены tab whenever a check fails.
	hide *secrets.Redactor
	// audit records what the guard decided and why. Named `audit` because the
	// stdlib `log` package is already in scope here.
	//
	// Without it a critical mismatch existed only as one stdout line and a
	// toast: after the fact nothing could answer "was the guard even running
	// when that offer arrived, and what did it conclude?".
	audit *journal.Journal

	mu     sync.RWMutex
	alerts map[string]Alert
	last   time.Time
	err    string
}

func New(s *steam.Client, m *market.Client, h *hub.Hub, j *journal.Journal, keyFunc func() string) *Guard {
	return &Guard{
		steam:   s,
		market:  m,
		hub:     h,
		http:    &http.Client{Timeout: 25 * time.Second},
		keyFunc: keyFunc,
		hide:    secrets.New(keyFunc),
		audit:   j,
		alerts:  make(map[string]Alert),
	}
}

// Alerts returns current verdicts, worst first.
func (g *Guard) Alerts() []Alert {
	g.mu.RLock()
	out := make([]Alert, 0, len(g.alerts))
	for _, a := range g.alerts {
		out = append(out, a)
	}
	g.mu.RUnlock()
	rank := map[Severity]int{SeverityCritical: 0, SeverityWarn: 1, SeverityOK: 2}
	sort.Slice(out, func(i, j int) bool {
		if rank[out[i].Severity] != rank[out[j].Severity] {
			return rank[out[i].Severity] < rank[out[j].Severity]
		}
		return out[i].CheckedAt.After(out[j].CheckedAt)
	})
	return out
}

// Status reports when the guard last ran and any error it hit.
func (g *Guard) Status() (time.Time, string) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.last, g.err
}

// Run polls Steam until ctx is cancelled.
func (g *Guard) Run(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		g.check(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (g *Guard) check(ctx context.Context) {
	offers, descs, err := g.receivedOffers(ctx)
	g.mu.Lock()
	g.last = time.Now()
	g.err = ""
	if err != nil {
		g.err = err.Error()
	}
	g.mu.Unlock()
	if err != nil {
		log.Printf("[guard] %v", err)
		g.note(journal.LevelWarn, "", "steam_unreachable",
			"не удалось прочитать входящие обмены Steam", map[string]any{"error": err.Error()})
		return
	}
	if len(offers) == 0 {
		g.mu.Lock()
		g.alerts = make(map[string]Alert)
		g.mu.Unlock()
		return
	}

	expected, expErr := g.expectedPurchases(ctx)
	if expErr != nil {
		// Without the purchase list there is nothing to compare against. It has
		// to reach the operator: previously this failed silently and every item
		// was then graded as an unremarkable non-purchase.
		g.mu.Lock()
		if g.err == "" {
			g.err = "список покупок недоступен: " + expErr.Error()
		} else {
			g.err += "; список покупок недоступен: " + expErr.Error()
		}
		g.mu.Unlock()
		g.note(journal.LevelWarn, "", "purchases_unreadable",
			"список покупок с маркета не прочитан — сверять входящие обмены не с чем",
			map[string]any{"error": expErr.Error()})
	}

	fresh := make(map[string]Alert, len(offers))
	for _, offer := range offers {
		alert := g.evaluate(ctx, offer, descs, expected, expErr)
		fresh[alert.OfferID] = alert
		g.mu.RLock()
		prev, existed := g.alerts[alert.OfferID]
		g.mu.RUnlock()
		if !existed || prev.Severity != alert.Severity {
			if alert.Severity != SeverityOK {
				log.Printf("[guard] %s offer %s: %s", strings.ToUpper(string(alert.Severity)), alert.OfferID, alert.Headline)
			}
			g.noteVerdict(alert, existed)
			g.hub.Publish("trade_alert", alert)
		}
	}
	g.mu.Lock()
	g.alerts = fresh
	g.mu.Unlock()
}

// expectedPurchases maps classid to the instanceids the account actually
// paid for on the market.
// A failure here used to return an empty map, which every caller then read as
// "this account bought nothing" — indistinguishable from a successful read of
// an empty history, and the reason an unverifiable offer could show green.
func (g *Guard) expectedPurchases(ctx context.Context) (map[string]map[string]string, error) {
	out := make(map[string]map[string]string)
	ops, err := g.market.Trades(ctx)
	if err != nil {
		log.Printf("[guard] market trades unavailable: %v", err)
		return nil, err
	}
	for _, op := range ops {
		if op.ClassID == "" || op.InstanceID == "" {
			continue
		}
		if out[op.ClassID] == nil {
			out[op.ClassID] = make(map[string]string)
		}
		out[op.ClassID][op.InstanceID] = op.MarketName
	}
	return out, nil
}

func (g *Guard) evaluate(ctx context.Context, offer tradeOffer, descs map[string]tradeDescription, expected map[string]map[string]string, expErr error) Alert {
	alert := Alert{
		OfferID:   offer.TradeOfferID,
		Partner:   fmt.Sprintf("%d", offer.AccountIDOther),
		Severity:  SeverityOK,
		CheckedAt: time.Now(),
	}

	alert.Checked = Checked{Purchases: expErr == nil, Sockets: true}
	if expErr != nil {
		alert.Checked.Blockers = append(alert.Checked.Blockers,
			"список покупок с маркета не прочитан: "+expErr.Error())
	}

	if len(offer.ItemsToGive) > 0 && len(offer.ItemsToReceive) == 0 {
		alert.Severity = SeverityWarn
		alert.Headline = "Обмен только забирает у тебя предметы"
		alert.Details = append(alert.Details,
			"Взамен не даётся ничего. Убедись, что это твоя собственная продажа.")
	}

	var keys []steam.AssetKey
	for _, it := range offer.ItemsToReceive {
		keys = append(keys, steam.AssetKey{ClassID: it.ClassID, InstanceID: it.InstanceID})
	}
	assets, err := g.steam.AssetClassInfo(ctx, keys)
	if err != nil {
		alert.Details = append(alert.Details, "Сокеты у Steam прочитать не удалось: "+err.Error())
		alert.Checked.Blockers = append(alert.Checked.Blockers, "Steam не ответил про сокеты: "+err.Error())
	}

	mismatch := false
	unmatched := false
	for _, it := range offer.ItemsToReceive {
		key := it.ClassID + "_" + it.InstanceID
		item := OfferItem{
			AssetID:    it.AssetID,
			ClassID:    it.ClassID,
			InstanceID: it.InstanceID,
		}
		if d, ok := descs[key]; ok {
			item.Name = d.MarketHashName
		}
		// Per item, never from the batch error: Steam returns partial results,
		// so a failed call can still carry some descriptions.
		if a, ok := assets[key]; ok {
			item.SocketsRead = true
			item.Gems = a.KineticGems()
			if item.Name == "" {
				item.Name = a.MarketHashName
			}
		} else {
			alert.Checked.Sockets = false
		}

		if expErr != nil {
			// Nothing to compare against. Saying "не связан с покупкой" here
			// would assert a fact the guard never established.
			item.Note = "сверка не выполнена: список покупок не прочитан"
			alert.Items = append(alert.Items, item)
			continue
		}

		wanted, classBought := expected[it.ClassID]
		switch {
		case classBought && wanted[it.InstanceID] != "":
			item.Expected = true
			item.Note = "совпадает с тем, за что ты заплатил"
		case classBought:
			mismatch = true
			paid := make([]string, 0, len(wanted))
			for inst := range wanted {
				paid = append(paid, inst)
			}
			sort.Strings(paid)
			item.Note = fmt.Sprintf("прислан instanceid %s, оплачен %s", it.InstanceID, strings.Join(paid, ", "))
			alert.Details = append(alert.Details, fmt.Sprintf(
				"%s: прислан instanceid %s, оплачен %s. Другой instanceid на том же предмете значит, что сокеты поменяли после продажи.",
				item.Name, it.InstanceID, strings.Join(paid, ", ")))
		default:
			unmatched = true
			item.Note = "не связан ни с одной покупкой на этом аккаунте"
		}
		alert.Items = append(alert.Items, item)
	}

	// The verdict, strongest ground first. A check that did not run can never
	// produce «Совпадает»: that badge is a statement about evidence, and
	// missing evidence is not agreement.
	switch {
	case mismatch:
		alert.Severity = SeverityCritical
		alert.Headline = "Прислан не тот предмет, за который ты платил"
		alert.Details = append(alert.Details,
			"Не принимай обмен. Отклони его в Steam и пожалуйся на лот в поддержку маркета.")
	case expErr != nil:
		alert.Severity = SeverityUnknown
		alert.Headline = "Сверять не с чем — список покупок не прочитан"
		alert.Details = append(alert.Details,
			"Совпадение instanceid не проверялось. Это не значит, что обмен плохой; это значит, что о нём ничего не известно.")
	case !alert.Checked.Sockets:
		alert.Severity = SeverityUnknown
		alert.Headline = "instanceid сверен, но сокеты не прочитаны"
		alert.Details = append(alert.Details,
			"Steam не описал часть предметов, поэтому какие в них гемы — неизвестно.")
	case unmatched:
		if alert.Severity == SeverityOK {
			alert.Severity = SeverityWarn
		}
		if alert.Headline == "" {
			alert.Headline = "Есть предметы, не связанные с покупками"
		}
	case alert.Headline == "":
		alert.Headline = "Совпадает с твоими покупками"
	}
	return alert
}

type tradeOffer struct {
	TradeOfferID    string      `json:"tradeofferid"`
	AccountIDOther  int64       `json:"accountid_other"`
	TradeOfferState int         `json:"trade_offer_state"`
	ItemsToGive     []tradeItem `json:"items_to_give"`
	ItemsToReceive  []tradeItem `json:"items_to_receive"`
}

type tradeItem struct {
	AppID      json.Number `json:"appid"`
	ClassID    string      `json:"classid"`
	InstanceID string      `json:"instanceid"`
	AssetID    string      `json:"assetid"`
}

type tradeDescription struct {
	ClassID        string `json:"classid"`
	InstanceID     string `json:"instanceid"`
	MarketHashName string `json:"market_hash_name"`
}

// note writes one guard entry, if a journal is attached.
func (g *Guard) note(level journal.Level, subject, reason, message string, fields map[string]any) {
	if g.audit == nil {
		return
	}
	g.audit.Write(level, journal.KindGuard, subject, reason, message, fields)
}

// noteVerdict records a verdict the moment it changes, with the evidence it
// rests on — so the journal can later show not just what the guard said, but
// what it was able to check when it said it.
func (g *Guard) noteVerdict(a Alert, existed bool) {
	level := journal.LevelInfo
	switch a.Severity {
	case SeverityCritical:
		level = journal.LevelError
	case SeverityWarn, SeverityUnknown:
		level = journal.LevelWarn
	}
	fields := map[string]any{
		"offer":             a.OfferID,
		"partner":           a.Partner,
		"severity":          string(a.Severity),
		"items":             len(a.Items),
		"checked_purchases": a.Checked.Purchases,
		"checked_sockets":   a.Checked.Sockets,
		"first_seen":        !existed,
	}
	if len(a.Checked.Blockers) > 0 {
		fields["blockers"] = a.Checked.Blockers
	}
	if len(a.Details) > 0 {
		fields["details"] = a.Details
	}
	g.note(level, a.Partner, string(a.Severity), a.Headline, fields)
}

// safe is the only way an error leaves the guard.
func (g *Guard) safe(err error) error { return g.hide.Error(err) }

// receivedOffers fetches active incoming offers plus their descriptions.
func (g *Guard) receivedOffers(ctx context.Context) ([]tradeOffer, map[string]tradeDescription, error) {
	key := g.keyFunc()
	if key == "" {
		return nil, nil, fmt.Errorf("steam.key is missing")
	}
	q := url.Values{}
	q.Set("key", key)
	q.Set("get_received_offers", "1")
	q.Set("active_only", "1")
	q.Set("get_descriptions", "1")
	q.Set("language", "en")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://api.steampowered.com/IEconService/GetTradeOffers/v1/?"+q.Encode(), nil)
	if err != nil {
		return nil, nil, g.safe(err)
	}
	resp, err := g.http.Do(req)
	if err != nil {
		// The key rides in the query string, so the URL Go prints on a
		// transport failure carries it. This error is surfaced on the dashboard
		// and written to the journal.
		return nil, nil, g.safe(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("steam GetTradeOffers: http %d", resp.StatusCode)
	}
	var payload struct {
		Response struct {
			TradeOffersReceived []tradeOffer       `json:"trade_offers_received"`
			Descriptions        []tradeDescription `json:"descriptions"`
		} `json:"response"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, nil, g.safe(fmt.Errorf("steam GetTradeOffers: %w", err))
	}
	descs := make(map[string]tradeDescription, len(payload.Response.Descriptions))
	for _, d := range payload.Response.Descriptions {
		descs[d.ClassID+"_"+d.InstanceID] = d
	}
	// State 2 is "active"; anything else needs no decision from the user.
	var active []tradeOffer
	for _, o := range payload.Response.TradeOffersReceived {
		if o.TradeOfferState == 2 {
			active = append(active, o)
		}
	}
	return active, descs, nil
}
