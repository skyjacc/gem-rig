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
	"radar/internal/market"
	"radar/internal/secrets"
	"radar/internal/steam"
)

// Severity ranks how bad an incoming offer looks.
type Severity string

const (
	SeverityOK       Severity = "ok"
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
	Expected   bool     `json:"expected"`
	Note       string   `json:"note"`
}

// Alert is the guard's verdict on one incoming offer.
type Alert struct {
	OfferID   string      `json:"offer_id"`
	Partner   string      `json:"partner"`
	Severity  Severity    `json:"severity"`
	Headline  string      `json:"headline"`
	Details   []string    `json:"details"`
	Items     []OfferItem `json:"items"`
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

	mu     sync.RWMutex
	alerts map[string]Alert
	last   time.Time
	err    string
}

func New(s *steam.Client, m *market.Client, h *hub.Hub, keyFunc func() string) *Guard {
	return &Guard{
		steam:   s,
		market:  m,
		hub:     h,
		http:    &http.Client{Timeout: 25 * time.Second},
		keyFunc: keyFunc,
		hide:    secrets.New(keyFunc),
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
		return
	}
	if len(offers) == 0 {
		g.mu.Lock()
		g.alerts = make(map[string]Alert)
		g.mu.Unlock()
		return
	}

	expected := g.expectedPurchases(ctx)

	fresh := make(map[string]Alert, len(offers))
	for _, offer := range offers {
		alert := g.evaluate(ctx, offer, descs, expected)
		fresh[alert.OfferID] = alert
		g.mu.RLock()
		prev, existed := g.alerts[alert.OfferID]
		g.mu.RUnlock()
		if !existed || prev.Severity != alert.Severity {
			if alert.Severity != SeverityOK {
				log.Printf("[guard] %s offer %s: %s", strings.ToUpper(string(alert.Severity)), alert.OfferID, alert.Headline)
			}
			g.hub.Publish("trade_alert", alert)
		}
	}
	g.mu.Lock()
	g.alerts = fresh
	g.mu.Unlock()
}

// expectedPurchases maps classid to the instanceids the account actually
// paid for on the market.
func (g *Guard) expectedPurchases(ctx context.Context) map[string]map[string]string {
	out := make(map[string]map[string]string)
	ops, err := g.market.Trades(ctx)
	if err != nil {
		log.Printf("[guard] market trades unavailable: %v", err)
		return out
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
	return out
}

func (g *Guard) evaluate(ctx context.Context, offer tradeOffer, descs map[string]tradeDescription, expected map[string]map[string]string) Alert {
	alert := Alert{
		OfferID:   offer.TradeOfferID,
		Partner:   fmt.Sprintf("%d", offer.AccountIDOther),
		Severity:  SeverityOK,
		CheckedAt: time.Now(),
	}

	if len(offer.ItemsToGive) > 0 && len(offer.ItemsToReceive) == 0 {
		alert.Severity = SeverityWarn
		alert.Headline = "Offer only takes items from you"
		alert.Details = append(alert.Details, "This offer gives you nothing in return. Verify it is a sale you made.")
	}

	var keys []steam.AssetKey
	for _, it := range offer.ItemsToReceive {
		keys = append(keys, steam.AssetKey{ClassID: it.ClassID, InstanceID: it.InstanceID})
	}
	assets, err := g.steam.AssetClassInfo(ctx, keys)
	if err != nil {
		alert.Details = append(alert.Details, "Could not read item sockets from Steam: "+err.Error())
	}

	mismatch := false
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
		if a, ok := assets[key]; ok {
			item.Gems = a.KineticGems()
			if item.Name == "" {
				item.Name = a.MarketHashName
			}
		}

		wanted, classBought := expected[it.ClassID]
		switch {
		case classBought && wanted[it.InstanceID] != "":
			item.Expected = true
			item.Note = "matches the exact item you paid for"
		case classBought:
			mismatch = true
			paid := make([]string, 0, len(wanted))
			for inst := range wanted {
				paid = append(paid, inst)
			}
			sort.Strings(paid)
			item.Note = fmt.Sprintf("instanceid %s was sent, but you paid for %s", it.InstanceID, strings.Join(paid, ", "))
			alert.Details = append(alert.Details, fmt.Sprintf(
				"%s: sent instanceid %s, purchased instanceid %s. A different instanceid on the same item means the sockets were changed after the sale.",
				item.Name, it.InstanceID, strings.Join(paid, ", ")))
		default:
			item.Note = "not linked to a market purchase on this account"
		}
		alert.Items = append(alert.Items, item)
	}

	if mismatch {
		alert.Severity = SeverityCritical
		alert.Headline = "Item sent does not match the item you bought"
		alert.Details = append(alert.Details,
			"Do not accept this offer. Decline it in Steam and report the lot to market support.")
	} else if alert.Headline == "" {
		alert.Headline = "Incoming offer matches your purchases"
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
