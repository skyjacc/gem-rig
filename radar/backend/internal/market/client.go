// Package market wraps the market.dota2.net trading API.
//
// Every outbound call goes through a shared rate limiter. The market deletes
// the API key of any client that sends more than 5 requests per second, so the
// limiter is the single choke point for the whole process.
package market

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"radar/internal/ratelimit"
)

const baseURL = "https://market.dota2.net"

// AppID is the Dota 2 Steam application id used by this market.
const AppID = "570"

// Client is a rate-limited market.dota2.net API client.
type Client struct {
	HTTP    *http.Client
	Limiter *ratelimit.Limiter
	KeyFunc func() string
}

func NewClient(limiter *ratelimit.Limiter, keyFunc func() string) *Client {
	return &Client{
		HTTP:    &http.Client{Timeout: 30 * time.Second},
		Limiter: limiter,
		KeyFunc: keyFunc,
	}
}

// do performs a rate-limited request, retrying once when the market's gateway
// flaps. Requests with a body are not retried because the reader is consumed.
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body io.Reader, authenticated bool) ([]byte, error) {
	data, err := c.doOnce(ctx, method, path, query, body, authenticated)
	if err == nil || body != nil || !isGatewayFlap(err) {
		return data, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(700 * time.Millisecond):
	}
	return c.doOnce(ctx, method, path, query, nil, authenticated)
}

// isGatewayFlap reports whether an error is the market's transient 5xx.
func isGatewayFlap(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "http 502") ||
		strings.Contains(msg, "http 503") ||
		strings.Contains(msg, "http 504")
}

// doOnce sends the key in the X-API-KEY header rather than the query string,
// so it never lands in logs or referrers.
func (c *Client) doOnce(ctx context.Context, method, path string, query url.Values, body io.Reader, authenticated bool) ([]byte, error) {
	if authenticated && c.KeyFunc() == "" {
		return nil, errors.New("market.key is missing")
	}
	if err := c.Limiter.Wait(ctx); err != nil {
		return nil, err
	}
	u := baseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	if authenticated {
		req.Header.Set("X-API-KEY", c.KeyFunc())
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("market %s: http %d: %s", path, resp.StatusCode, truncate(string(data), 200))
	}
	return data, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// Money is the account balance on the market, in roubles.
type Money struct {
	Money    float64 `json:"money"`
	Currency string  `json:"currency"`
}

// GetMoney returns the current market balance.
// The API reports the balance in kopeks, so it is converted here.
func (c *Client) GetMoney(ctx context.Context) (Money, error) {
	var m Money
	data, err := c.do(ctx, http.MethodGet, "/api/GetMoney/", nil, nil, true)
	if err != nil {
		return m, err
	}
	var raw struct {
		Money    json.Number `json:"money"`
		Currency string      `json:"currency"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return m, fmt.Errorf("GetMoney: %w", err)
	}
	kopeks, err := raw.Money.Float64()
	if err != nil {
		return m, fmt.Errorf("GetMoney: unexpected balance %q", raw.Money.String())
	}
	m.Money = kopeks / 100
	m.Currency = raw.Currency
	if m.Currency == "" {
		m.Currency = "RUB"
	}
	return m, nil
}

// MarketTrade is one Steam trade offer the market has sent to the account.
type MarketTrade struct {
	Dir       string `json:"dir"`
	TradeID   string `json:"trade_id"`
	BotID     string `json:"bot_id"`
	Timestamp string `json:"timestamp"`
}

// MarketTrades lists Steam offers from the market awaiting confirmation.
func (c *Client) MarketTrades(ctx context.Context) ([]MarketTrade, error) {
	data, err := c.do(ctx, http.MethodGet, "/api/MarketTrades/", nil, nil, true)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Success bool          `json:"success"`
		Trades  []MarketTrade `json:"trades"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, fmt.Errorf("MarketTrades: %w", err)
	}
	return resp.Trades, nil
}

// Operation is one row of the account's own buy/sell operations.
type Operation struct {
	ClassID    string `json:"i_classid"`
	InstanceID string `json:"i_instanceid"`
	MarketName string `json:"i_market_name"`
	Price      string `json:"ui_price"`
	Status     string `json:"ui_status"`
	ItemID     string `json:"ui_id"`
	BotID      string `json:"ui_bid"`
}

// Trades lists the account's items currently in the market pipeline.
func (c *Client) Trades(ctx context.Context) ([]Operation, error) {
	data, err := c.do(ctx, http.MethodGet, "/api/Trades/", nil, nil, true)
	if err != nil {
		return nil, err
	}
	var ops []Operation
	if err := json.Unmarshal(data, &ops); err != nil {
		// Errors come back as an object rather than an array.
		var errResp struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &errResp) == nil && errResp.Error != "" {
			return nil, fmt.Errorf("Trades: %s", errResp.Error)
		}
		return nil, fmt.Errorf("Trades: %w", err)
	}
	return ops, nil
}

// ItemInfo is the market's view of one item variant, including the buy hash.
type ItemInfo struct {
	Hash           string `json:"hash"`
	ClassID        string `json:"classid"`
	InstanceID     string `json:"instanceid"`
	MarketHashName string `json:"market_hash_name"`
	Rarity         string `json:"rarity"`
	Quality        string `json:"quality"`
	Type           string `json:"type"`
	MinPrice       string `json:"min_price"`
	Offers         []struct {
		Price string `json:"price"`
		Count string `json:"count"`
	} `json:"offers"`
	// BuyOffers are standing buy orders: what other traders will pay right
	// now, which is the realistic exit price for an extracted gem.
	BuyOffers []struct {
		Price string `json:"o_price"`
		Count string `json:"c"`
	} `json:"buy_offers"`
}

// ItemInfo fetches offers and the purchase hash for one item variant.
func (c *Client) ItemInfo(ctx context.Context, classID, instanceID, lang string) (ItemInfo, error) {
	var info ItemInfo
	if lang == "" {
		lang = "en"
	}
	path := fmt.Sprintf("/api/ItemInfo/%s_%s/%s/", classID, instanceID, lang)
	data, err := c.do(ctx, http.MethodGet, path, nil, nil, true)
	if err != nil {
		return info, err
	}
	if err := json.Unmarshal(data, &info); err != nil {
		return info, fmt.Errorf("ItemInfo: %w", err)
	}
	return info, nil
}

// MassInfoResult is one entry of a MassInfo response.
type MassInfoResult struct {
	ClassID    json.Number `json:"classid"`
	InstanceID json.Number `json:"instanceid"`
	SellOffers struct {
		BestOffer json.Number `json:"best_offer"`
	} `json:"sell_offers"`
	Info struct {
		Hash           string `json:"hash"`
		MarketHashName string `json:"market_hash_name"`
	} `json:"info"`
}

// MassInfo asks about up to 100 item variants in a single request.
// sell/buy/history/info follow the market's 0..3 verbosity levels.
func (c *Client) MassInfo(ctx context.Context, keys []string, sell, buy, history, info int) ([]MassInfoResult, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	if len(keys) > 100 {
		return nil, fmt.Errorf("MassInfo accepts at most 100 items, got %d", len(keys))
	}
	path := fmt.Sprintf("/api/MassInfo/%d/%d/%d/%d", sell, buy, history, info)
	form := url.Values{}
	form.Set("list", strings.Join(keys, ","))
	data, err := c.do(ctx, http.MethodPost, path, nil, strings.NewReader(form.Encode()), true)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Success bool             `json:"success"`
		Results []MassInfoResult `json:"results"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, fmt.Errorf("MassInfo: %w", err)
	}
	return resp.Results, nil
}

// WSAuth returns a short-lived token for the market notification socket.
// The token expires 60 seconds after it is issued.
func (c *Client) WSAuth(ctx context.Context) (string, error) {
	data, err := c.do(ctx, http.MethodGet, "/api/GetWSAuth/", nil, nil, true)
	if err != nil {
		return "", err
	}
	var resp struct {
		Success bool   `json:"success"`
		WSAuth  string `json:"wsAuth"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return "", fmt.Errorf("GetWSAuth: %w", err)
	}
	return resp.WSAuth, nil
}

// BuyResult is the market's answer to a purchase attempt.
type BuyResult struct {
	Success bool   `json:"success"`
	ID      string `json:"id"`
	Error   string `json:"error"`
}

// Buy purchases one item variant at priceKopeks (price in minor units).
// The hash pins the purchase to the exact item description the caller saw;
// passing an empty hash disables that protection and is not allowed here.
func (c *Client) Buy(ctx context.Context, classID, instanceID string, priceKopeks int, hash string) (BuyResult, error) {
	var res BuyResult
	if hash == "" {
		return res, errors.New("refusing to buy without a description hash")
	}
	path := fmt.Sprintf("/api/Buy/%s_%s/%d/%s/", classID, instanceID, priceKopeks, hash)
	data, err := c.do(ctx, http.MethodGet, path, nil, nil, true)
	if err != nil {
		return res, err
	}
	if err := json.Unmarshal(data, &res); err != nil {
		return res, fmt.Errorf("Buy: %w", err)
	}
	return res, nil
}

// Discounts carries the account's own trading terms. The sell commission is
// per-account and changes with turnover, so it is read rather than assumed.
type Discounts struct {
	SellFeePercent float64
	BuyDiscount    string
	TotalBuy       float64
}

// GetDiscounts returns the account's own commission.
func (c *Client) GetDiscounts(ctx context.Context) (Discounts, error) {
	var out Discounts
	data, err := c.do(ctx, http.MethodGet, "/api/GetDiscounts/", nil, nil, true)
	if err != nil {
		return out, err
	}
	var body struct {
		Success   bool `json:"success"`
		Discounts struct {
			TotalBuy    float64 `json:"total_buy"`
			BuyDiscount string  `json:"buy_discount"`
			SellFee     string  `json:"sell_fee"`
		} `json:"discounts"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return out, fmt.Errorf("GetDiscounts: %w", err)
	}
	pct, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(body.Discounts.SellFee), "%"), 64)
	if err != nil {
		return out, fmt.Errorf("GetDiscounts: cannot read sell_fee %q", body.Discounts.SellFee)
	}
	out.SellFeePercent = pct
	out.BuyDiscount = body.Discounts.BuyDiscount
	out.TotalBuy = body.Discounts.TotalBuy
	return out, nil
}

// OrderBook is what buyers are standing ready to pay for an item.
//
// The market matches buy orders by item name, not by the exact variant: a
// gemmed item and an emptied one share one book. That makes the emptied shell
// reliably resellable, and it makes listing a gemmed item below the top order
// a way to give the gem away for free.
type OrderBook struct {
	Best   float64 `json:"best"` // roubles
	Orders int     `json:"orders"`
}

// BuyOrders reads the standing buy orders for an item variant.
//
// The dedicated BestBuyOffer endpoint is not trusted: for one gem it returned
// the lowest of three orders, and it answers 502 often enough to matter. The
// maximum is taken from the full list instead.
func (c *Client) BuyOrders(ctx context.Context, classID, instanceID string) (OrderBook, error) {
	var out OrderBook
	info, err := c.ItemInfo(ctx, classID, instanceID, "en")
	if err != nil {
		return out, err
	}
	for _, o := range info.BuyOffers {
		kopeks, convErr := strconv.Atoi(o.Price)
		if convErr != nil || kopeks <= 0 {
			continue
		}
		out.Orders++
		if v := float64(kopeks) / 100; v > out.Best {
			out.Best = v
		}
	}
	return out, nil
}

// Lot is one row of the market-wide item database dump.
type Lot struct {
	ClassID    string  `json:"classid"`
	InstanceID string  `json:"instanceid"`
	Price      float64 `json:"price"` // roubles
	Offers     int     `json:"offers"`
	NameEN     string  `json:"name_en"`
	NameRU     string  `json:"name_ru"`
	HeroID     string  `json:"hero_id"`
	Rarity     string  `json:"rarity"`
	Quality    string  `json:"quality"`
	NameColor  string  `json:"name_color"`
}

// Key returns the classid_instanceid identifier used by Steam and MassInfo.
func (l Lot) Key() string { return l.ClassID + "_" + l.InstanceID }

// ItemDB downloads the market-wide dump of everything currently on sale.
//
// The market rebuilds this file once a minute and explicitly asks clients to
// use it instead of polling search endpoints, so the whole catalogue costs
// two requests instead of hundreds.
func (c *Client) ItemDB(ctx context.Context) ([]Lot, time.Time, error) {
	data, err := c.do(ctx, http.MethodGet, "/itemdb/current_"+AppID+".json", nil, nil, false)
	if err != nil {
		return nil, time.Time{}, err
	}
	var cur struct {
		Time json.Number `json:"time"`
		DB   string      `json:"db"`
	}
	if err := json.Unmarshal(data, &cur); err != nil {
		return nil, time.Time{}, fmt.Errorf("itemdb current: %w", err)
	}
	if cur.DB == "" {
		return nil, time.Time{}, errors.New("itemdb current: empty db name")
	}
	csvData, err := c.do(ctx, http.MethodGet, "/itemdb/"+cur.DB, nil, nil, false)
	if err != nil {
		return nil, time.Time{}, err
	}
	lots, err := ParseItemDB(csvData)
	if err != nil {
		return nil, time.Time{}, err
	}
	var stamp time.Time
	if sec, err := cur.Time.Int64(); err == nil {
		stamp = time.Unix(sec, 0)
	}
	return lots, stamp, nil
}

// ParseItemDB decodes the semicolon-separated market dump.
func ParseItemDB(data []byte) ([]Lot, error) {
	r := csv.NewReader(strings.NewReader(string(data)))
	r.Comma = ';'
	r.FieldsPerRecord = -1
	r.LazyQuotes = true

	header, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("itemdb csv header: %w", err)
	}
	idx := make(map[string]int, len(header))
	for i, h := range header {
		idx[strings.TrimSpace(strings.TrimPrefix(h, "\ufeff"))] = i
	}
	col := func(rec []string, name string) string {
		i, ok := idx[name]
		if !ok || i >= len(rec) {
			return ""
		}
		return rec[i]
	}

	var lots []Lot
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			// A single malformed row must not discard the whole dump.
			continue
		}
		classID := col(rec, "c_classid")
		if classID == "" {
			continue
		}
		priceKopeks, _ := strconv.Atoi(col(rec, "c_price"))
		offers, _ := strconv.Atoi(col(rec, "c_offers"))
		lots = append(lots, Lot{
			ClassID:    classID,
			InstanceID: col(rec, "c_instanceid"),
			Price:      float64(priceKopeks) / 100,
			Offers:     offers,
			NameEN:     col(rec, "c_market_name_en"),
			NameRU:     col(rec, "c_market_name"),
			HeroID:     col(rec, "c_heroid"),
			Rarity:     col(rec, "c_rarity"),
			Quality:    col(rec, "c_quality"),
			NameColor:  col(rec, "c_name_color"),
		})
	}
	return lots, nil
}
