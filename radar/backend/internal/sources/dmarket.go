package sources

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"radar/internal/pricing"
	"radar/internal/ratelimit"
)

// DotaGameID is DMarket's identifier for Dota 2.
const DotaGameID = "9a92"

// DMarket is the only source besides market.dota2.net that exposes an item's
// exact variant *and* resolves its sockets, and the only one that publishes
// completed sales rather than asking prices.
//
// Requests are signed with Ed25519 over "method + path + body + timestamp".
type DMarket struct {
	HTTP    *http.Client
	Limiter *ratelimit.Limiter
	// PublicKey is the hex key sent in X-Api-Key.
	PublicKey func() string
	// SecretKey is the 64-byte Ed25519 private key (seed || public).
	SecretKey func() ed25519.PrivateKey
	FX        *FX
}

func NewDMarket(fx *FX, pub func() string, sec func() ed25519.PrivateKey) *DMarket {
	return &DMarket{
		HTTP:      &http.Client{Timeout: 30 * time.Second},
		Limiter:   ratelimit.New(4),
		PublicKey: pub,
		SecretKey: sec,
		FX:        fx,
	}
}

func (d *DMarket) Name() string { return "dmarket" }

// Configured reports whether both keys are present.
func (d *DMarket) Configured() bool {
	return d.PublicKey() != "" && len(d.SecretKey()) == ed25519.PrivateKeySize
}

// ParsePrivateKey decodes DMarket's hex secret. The value is the standard
// 64-byte Ed25519 private key: a 32-byte seed followed by the public key.
func ParsePrivateKey(hexKey string) (ed25519.PrivateKey, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(hexKey))
	if err != nil {
		return nil, fmt.Errorf("dmarket secret key is not hex: %w", err)
	}
	if len(raw) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("dmarket secret key must be %d bytes, got %d",
			ed25519.PrivateKeySize, len(raw))
	}
	return ed25519.PrivateKey(raw), nil
}

func (d *DMarket) get(ctx context.Context, path string, v any) error {
	if !d.Configured() {
		return errors.New("dmarket keys are missing")
	}
	if err := d.Limiter.Wait(ctx); err != nil {
		return err
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := ed25519.Sign(d.SecretKey(), []byte(http.MethodGet+path+ts))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.dmarket.com"+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Api-Key", d.PublicKey())
	req.Header.Set("X-Sign-Date", ts)
	req.Header.Set("X-Request-Sign", "dmar ed25519 "+hex.EncodeToString(sig))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)

	resp, err := d.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("dmarket %s: http %d: %s", path, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

// Balance is a cheap call that proves the key and signature work.
func (d *DMarket) Balance(ctx context.Context) (string, error) {
	var body struct {
		USD string `json:"usd"`
	}
	if err := d.get(ctx, "/account/v1/balance", &body); err != nil {
		return "", err
	}
	return body.USD, nil
}

// DMOffer is one listing with its sockets already resolved by DMarket.
type DMOffer struct {
	OfferID    string
	Title      string
	ClassID    string
	InstanceID string
	AssetID    string
	PriceRUB   float64
	Gems       []string
	Hero       string
	Rarity     string
	ImageURI   string
	LockDays   int
}

type dmOffersPage struct {
	Items []struct {
		OfferID    string `json:"offerId"`
		PriceCents string `json:"priceCents"`
		Attributes struct {
			Title         string `json:"title"`
			ClassID       string `json:"classId"`
			InGameAssetID string `json:"inGameAssetId"`
			ImageURI      string `json:"imageUri"`
			TradeLockDays int    `json:"tradeLockDays"`
			Dota2         struct {
				Hero   string `json:"hero"`
				Rarity string `json:"rarity"`
				Gems   []struct {
					Name  string `json:"name"`
					Type  string `json:"type"`
					Image string `json:"image"`
				} `json:"gems"`
			} `json:"dota2"`
		} `json:"attributes"`
	} `json:"items"`
	Cursor string `json:"cursor"`
}

// Offers walks the Dota catalogue within a price ceiling and returns every lot
// that physically holds a kinetic gem.
//
// Two structural problems shaped this function.
//
// First, it used to page ordered by price descending with no bound: the first
// two thousand offers were the most expensive on the platform, every gemmed lot
// among them cost far more than the scanning cap, and the sweep reported
// "просмотрено 2000, с кинетиком 30, в таблице 0" every five minutes —
// incapable of finding anything buyable no matter how long it ran.
//
// Second, DMarket caps any single result set at ten thousand offers. Bounding
// the query by price fixed the first problem and exposed the second: the
// bounded slice is itself larger than one query can return, so paging to the
// ceiling still left offers unseen. The answer is to cut the price range into
// bands and page each one separately — a band that comes back full is split in
// half and retried, until every band ends before the ceiling or the request
// budget runs out.
//
// maxRUB is the operator's price cap; zero means unbounded, which is only
// useful for diagnostics. maxPages is the total page budget across all bands.
//
// The third return value reports incomplete coverage: true when some band was
// still full when the budget ran out, so "просмотрено N" means "первые N" and
// an empty table proves nothing.
func (d *DMarket) Offers(ctx context.Context, maxPages int, maxRUB float64) ([]DMOffer, int, bool, error) {
	rate := d.FX.Rate()
	priceTo := 0
	if maxRUB > 0 && rate > 0 {
		priceTo = int(maxRUB / rate * 100)
		if priceTo < 1 {
			priceTo = 1
		}
	}
	if priceTo == 0 {
		// Unbounded: one band, best effort.
		return d.offersInBand(ctx, 0, 0, maxPages, rate)
	}

	seen := make(map[string]bool)
	var out []DMOffer
	scanned := 0
	budget := maxPages
	incomplete := false

	// Bands are processed high-first so the dearest lots — the ones most likely
	// to carry a gem worth extracting — are in hand even if the budget runs out.
	type band struct{ from, to int }
	queue := []band{{1, priceTo}}

	for len(queue) > 0 && budget > 0 {
		b := queue[0]
		queue = queue[1:]

		part, got, full, err := d.offersInBand(ctx, b.from, b.to, budget, rate)
		scanned += got
		budget -= (got + 99) / 100
		for _, o := range part {
			if !seen[o.OfferID] {
				seen[o.OfferID] = true
				out = append(out, o)
			}
		}
		if err != nil {
			return out, scanned, true, err
		}
		if !full {
			continue
		}
		// The band filled its result set, so it hides more than it returned.
		// Split it, unless it is already too narrow to divide meaningfully.
		mid := b.from + (b.to-b.from)/2
		if mid <= b.from || mid >= b.to {
			incomplete = true
			continue
		}
		queue = append(queue, band{mid + 1, b.to}, band{b.from, mid})
	}

	return out, scanned, incomplete || len(queue) > 0, nil
}

// offersInBand pages one price band. `full` is true when paging stopped because
// the budget or DMarket's own ceiling was reached rather than because the band
// was exhausted.
func (d *DMarket) offersInBand(ctx context.Context, fromCents, toCents, maxPages int, rate float64) ([]DMOffer, int, bool, error) {
	cursor := ""
	scanned := 0
	var out []DMOffer

	for page := 0; page < maxPages; page++ {
		path := "/marketplace-api/v2/offers?gameId=" + DotaGameID +
			"&limit=100&currency=USD&orderBy=price&orderDir=desc"
		if toCents > 0 {
			path += "&priceTo=" + strconv.Itoa(toCents)
		}
		if fromCents > 0 {
			path += "&priceFrom=" + strconv.Itoa(fromCents)
		}
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		var body dmOffersPage
		if err := d.get(ctx, path, &body); err != nil {
			return out, scanned, true, err
		}
		if len(body.Items) == 0 {
			return out, scanned, false, nil
		}
		scanned += len(body.Items)

		for _, it := range body.Items {
			var gems []string
			for _, g := range it.Attributes.Dota2.Gems {
				// The same test applied to Steam's markup: a real kinetic
				// socket, not an empty one and not a leftover text label.
				if strings.Contains(g.Type, "Kinetic") &&
					!strings.EqualFold(g.Name, "Empty Socket") && g.Name != "" {
					gems = append(gems, g.Name)
				}
			}
			if len(gems) == 0 {
				continue
			}
			cents, _ := strconv.Atoi(it.PriceCents)
			if cents <= 0 {
				continue
			}
			// inGameAssetId is "instanceid:classid:assetid:appid".
			parts := strings.Split(it.Attributes.InGameAssetID, ":")
			offer := DMOffer{
				OfferID:  it.OfferID,
				Title:    it.Attributes.Title,
				ClassID:  it.Attributes.ClassID,
				PriceRUB: float64(cents) / 100 * rate,
				Gems:     gems,
				Hero:     it.Attributes.Dota2.Hero,
				Rarity:   it.Attributes.Dota2.Rarity,
				ImageURI: it.Attributes.ImageURI,
				LockDays: it.Attributes.TradeLockDays,
			}
			if len(parts) >= 3 {
				offer.InstanceID = parts[0]
				offer.AssetID = parts[2]
			}
			out = append(out, offer)
		}
		if body.Cursor == "" {
			return out, scanned, false, nil
		}
		cursor = body.Cursor
	}
	return out, scanned, true, nil
}

// LastSale returns the most recent completed sale price for a gem, in roubles.
// This is the only number in the whole system that someone actually paid.
func (d *DMarket) LastSale(ctx context.Context, gemMarketName string) (float64, int, error) {
	path := "/trade-aggregator/v1/last-sales?gameId=" + DotaGameID +
		"&title=" + urlQueryEscape(gemMarketName) + "&limit=20"
	var body struct {
		Sales []struct {
			Price string `json:"price"`
			Date  string `json:"date"`
		} `json:"sales"`
	}
	if err := d.get(ctx, path, &body); err != nil {
		return 0, 0, err
	}
	if len(body.Sales) == 0 {
		return 0, 0, nil
	}
	// The median of recent sales, not the latest one: a single trade can be a
	// favour between friends.
	var prices []float64
	for _, s := range body.Sales {
		if v, err := strconv.ParseFloat(s.Price, 64); err == nil && v > 0 {
			prices = append(prices, v)
		}
	}
	if len(prices) == 0 {
		return 0, 0, nil
	}
	for i := 1; i < len(prices); i++ {
		for j := i; j > 0 && prices[j] < prices[j-1]; j-- {
			prices[j], prices[j-1] = prices[j-1], prices[j]
		}
	}
	mid := prices[len(prices)/2]
	if len(prices)%2 == 0 {
		mid = (prices[len(prices)/2-1] + prices[len(prices)/2]) / 2
	}
	return mid * d.FX.Rate(), len(prices), nil
}

// GemQuotes prices gems from DMarket's completed sales.
func (d *DMarket) GemQuotes(ctx context.Context, gemNames []string) (map[string]pricing.Quote, error) {
	out := make(map[string]pricing.Quote)
	var firstErr error
	for _, name := range gemNames {
		price, n, err := d.LastSale(ctx, name)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if price <= 0 {
			continue
		}
		out[name] = pricing.Quote{
			Source: d.Name(),
			Price:  price,
			Kind:   pricing.KindSale,
			Volume: n,
		}
	}
	return out, firstErr
}

// urlQueryEscape percent-encodes a value for a query string. The signature is
// computed over the same encoded path, so both must match exactly.
func urlQueryEscape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
