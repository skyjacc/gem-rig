package steam

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// AssetKey identifies one item variant in the Steam economy.
type AssetKey struct {
	ClassID    string `json:"classid"`
	InstanceID string `json:"instanceid"`
}

func (k AssetKey) String() string { return k.ClassID + "_" + k.InstanceID }

// Asset is the decoded economy record for one item variant.
type Asset struct {
	AssetKey
	MarketHashName string   `json:"market_hash_name"`
	Name           string   `json:"name"`
	Type           string   `json:"type"`
	IconURL        string   `json:"icon_url"`
	Sockets        []Socket `json:"sockets"`
}

// KineticGems lists the real kinetic gems physically inside the asset.
func (a Asset) KineticGems() []string { return KineticGems(a.Sockets) }

// Client is a Steam Economy API client with a small memo cache.
// Asset class info is immutable per classid_instanceid, so caching is safe
// and keeps the request budget free for the market API.
type Client struct {
	HTTP    *http.Client
	KeyFunc func() string

	mu    sync.RWMutex
	cache map[string]Asset
}

func NewClient(keyFunc func() string) *Client {
	return &Client{
		HTTP:    &http.Client{Timeout: 25 * time.Second},
		KeyFunc: keyFunc,
		cache:   make(map[string]Asset),
	}
}

// maxAssetsPerCall is Valve's practical ceiling for one GetAssetClassInfo call.
const maxAssetsPerCall = 100

// AssetClassInfo resolves the given asset keys, using the cache where possible.
func (c *Client) AssetClassInfo(ctx context.Context, keys []AssetKey) (map[string]Asset, error) {
	out := make(map[string]Asset, len(keys))
	var missing []AssetKey

	c.mu.RLock()
	for _, k := range keys {
		if a, ok := c.cache[k.String()]; ok {
			out[k.String()] = a
		} else {
			missing = append(missing, k)
		}
	}
	c.mu.RUnlock()

	for start := 0; start < len(missing); start += maxAssetsPerCall {
		end := start + maxAssetsPerCall
		if end > len(missing) {
			end = len(missing)
		}
		batch, err := c.fetchBatch(ctx, missing[start:end])
		if err != nil {
			return out, err
		}
		c.mu.Lock()
		for k, v := range batch {
			c.cache[k] = v
			out[k] = v
		}
		c.mu.Unlock()
	}
	return out, nil
}

// CacheSize reports how many asset variants are memoised.
func (c *Client) CacheSize() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.cache)
}

func (c *Client) fetchBatch(ctx context.Context, keys []AssetKey) (map[string]Asset, error) {
	key := c.KeyFunc()
	if key == "" {
		return nil, errors.New("steam.key is missing")
	}
	q := url.Values{}
	q.Set("key", key)
	q.Set("appid", "570")
	q.Set("class_count", strconv.Itoa(len(keys)))
	for i, k := range keys {
		q.Set("classid"+strconv.Itoa(i), k.ClassID)
		if k.InstanceID != "" {
			q.Set("instanceid"+strconv.Itoa(i), k.InstanceID)
		}
	}
	endpoint := "https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v0001?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("steam GetAssetClassInfo: http %d", resp.StatusCode)
	}
	var raw struct {
		Result map[string]json.RawMessage `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("steam GetAssetClassInfo: %w", err)
	}
	return DecodeAssets(raw.Result), nil
}

// DecodeAssets converts a GetAssetClassInfo result map into assets.
// Exported so tests and the inspector reuse the same decoding path.
func DecodeAssets(result map[string]json.RawMessage) map[string]Asset {
	out := make(map[string]Asset)
	for id, rawVal := range result {
		if id == "success" || !strings.Contains(id, "_") {
			continue
		}
		var rec struct {
			ClassID        string `json:"classid"`
			InstanceID     string `json:"instanceid"`
			MarketHashName string `json:"market_hash_name"`
			Name           string `json:"name"`
			Type           string `json:"type"`
			IconURL        string `json:"icon_url"`
			Descriptions   map[string]struct {
				Value string `json:"value"`
			} `json:"descriptions"`
		}
		if err := json.Unmarshal(rawVal, &rec); err != nil {
			continue
		}
		parts := strings.SplitN(id, "_", 2)
		asset := Asset{
			AssetKey:       AssetKey{ClassID: parts[0], InstanceID: parts[1]},
			MarketHashName: rec.MarketHashName,
			Name:           rec.Name,
			Type:           rec.Type,
			IconURL:        rec.IconURL,
		}
		if rec.ClassID != "" {
			asset.ClassID = rec.ClassID
		}
		if rec.InstanceID != "" {
			asset.InstanceID = rec.InstanceID
		}
		asset.Sockets = socketsFromDescriptions(rec.Descriptions)
		out[id] = asset
	}
	return out
}

// socketsFromDescriptions walks the index-keyed description map in order.
// Sockets can sit in any entry, so every entry is parsed and concatenated.
func socketsFromDescriptions(desc map[string]struct {
	Value string `json:"value"`
}) []Socket {
	var out []Socket
	for i := 0; i < len(desc); i++ {
		d, ok := desc[strconv.Itoa(i)]
		if !ok {
			continue
		}
		out = append(out, ParseSockets(d.Value)...)
	}
	return out
}

// DescriptionHTML returns the raw markup Valve renders, for the inspector view.
func (c *Client) DescriptionHTML(ctx context.Context, k AssetKey) (string, string, error) {
	key := c.KeyFunc()
	if key == "" {
		return "", "", errors.New("steam.key is missing")
	}
	q := url.Values{}
	q.Set("key", key)
	q.Set("appid", "570")
	q.Set("class_count", "1")
	q.Set("classid0", k.ClassID)
	q.Set("instanceid0", k.InstanceID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v0001?"+q.Encode(), nil)
	if err != nil {
		return "", "", err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	var raw struct {
		Result map[string]json.RawMessage `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return "", "", err
	}
	rec, ok := raw.Result[k.String()]
	if !ok {
		return "", "", fmt.Errorf("asset %s not found in Steam economy", k)
	}
	var parsed struct {
		MarketHashName string `json:"market_hash_name"`
		Descriptions   map[string]struct {
			Value string `json:"value"`
		} `json:"descriptions"`
	}
	if err := json.Unmarshal(rec, &parsed); err != nil {
		return "", "", err
	}
	var b strings.Builder
	for i := 0; i < len(parsed.Descriptions); i++ {
		d, ok := parsed.Descriptions[strconv.Itoa(i)]
		if !ok {
			continue
		}
		b.WriteString(d.Value)
		b.WriteString("<br>")
	}
	return parsed.MarketHashName, b.String(), nil
}

// Forget drops assets from the memo cache. The scanner uses it to keep only
// the interesting variants resident after sweeping the whole catalogue.
func (c *Client) Forget(keys ...string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, k := range keys {
		delete(c.cache, k)
	}
}
