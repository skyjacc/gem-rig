package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"radar/internal/pricing"
	"radar/internal/ratelimit"
)

const (
	currencyUSD = 1
	currencyRUB = 5
)

// SteamClient reads the Steam Community Market.
//
// These are the website's own endpoints, not the documented Web API: no key,
// no published limits and no rate-limit headers. Community experience puts the
// ceiling near 20 requests a minute per IP, after which Steam answers 429 for
// several minutes, so the limiter here is deliberately slow.
type SteamClient struct {
	HTTP    *http.Client
	Limiter *ratelimit.Limiter
	FX      *FX
}

func NewSteamClient(fx *FX) *SteamClient {
	return &SteamClient{
		HTTP:    &http.Client{Timeout: 25 * time.Second},
		Limiter: ratelimit.New(0.5), // one request every two seconds
		FX:      fx,
	}
}

func (c *SteamClient) Name() string { return "steam" }

// priceOverview returns the lowest asking price for one item.
func (c *SteamClient) priceOverview(ctx context.Context, name string, currency int) (float64, error) {
	if err := c.Limiter.Wait(ctx); err != nil {
		return 0, err
	}
	q := url.Values{}
	q.Set("appid", "570")
	q.Set("currency", fmt.Sprint(currency))
	q.Set("market_hash_name", name)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://steamcommunity.com/market/priceoverview/?"+q.Encode(), nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests {
		return 0, fmt.Errorf("steam: rate limited (429)")
	}
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("steam priceoverview: http %d", resp.StatusCode)
	}
	var body struct {
		Success     bool   `json:"success"`
		LowestPrice string `json:"lowest_price"`
		MedianPrice string `json:"median_price"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, err
	}
	if !body.Success {
		return 0, fmt.Errorf("steam: no price for %q", name)
	}
	text := body.LowestPrice
	if text == "" {
		text = body.MedianPrice
	}
	return parseMoney(text)
}

// GemQuotes returns every kinetic gem Steam lists, converted to roubles.
//
// The search endpoint pages ten rows at a time, so the whole set of about
// fifty gems costs six requests rather than one per gem.
func (c *SteamClient) GemQuotes(ctx context.Context) (map[string]pricing.Quote, error) {
	out := make(map[string]pricing.Quote)
	rate := c.FX.Rate()
	const pageSize = 10

	for start := 0; start < 200; start += pageSize {
		if err := c.Limiter.Wait(ctx); err != nil {
			return out, err
		}
		q := url.Values{}
		q.Set("query", "Kinetic")
		q.Set("appid", "570")
		q.Set("norender", "1")
		q.Set("count", fmt.Sprint(pageSize))
		q.Set("start", fmt.Sprint(start))

		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			"https://steamcommunity.com/market/search/render/?"+q.Encode(), nil)
		if err != nil {
			return out, err
		}
		req.Header.Set("User-Agent", userAgent)
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return out, err
		}
		var page struct {
			Success    bool `json:"success"`
			TotalCount int  `json:"total_count"`
			Results    []struct {
				Name           string `json:"name"`
				SellPrice      int    `json:"sell_price"` // US cents
				SellListings   int    `json:"sell_listings"`
				SellPriceText  string `json:"sell_price_text"`
				HashName       string `json:"hash_name"`
				AssetDescIsNil bool   `json:"-"`
			} `json:"results"`
		}
		decErr := json.NewDecoder(resp.Body).Decode(&page)
		status := resp.StatusCode
		resp.Body.Close()

		if status == http.StatusTooManyRequests {
			return out, fmt.Errorf("steam: rate limited (429) after %d gems", len(out))
		}
		if status != http.StatusOK {
			return out, fmt.Errorf("steam search: http %d", status)
		}
		if decErr != nil {
			return out, decErr
		}
		if len(page.Results) == 0 {
			break
		}
		for _, r := range page.Results {
			name := r.HashName
			if name == "" {
				name = r.Name
			}
			if !strings.HasPrefix(name, "Kinetic:") || r.SellPrice <= 0 {
				continue
			}
			out[name] = pricing.Quote{
				Source: c.Name(),
				Price:  float64(r.SellPrice) / 100 * rate,
				Kind:   pricing.KindAsk,
				Volume: r.SellListings,
			}
		}
		if start+pageSize >= page.TotalCount {
			break
		}
	}
	return out, nil
}
