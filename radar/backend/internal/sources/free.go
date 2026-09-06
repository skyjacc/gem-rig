package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"radar/internal/pricing"
)

const userAgent = "kinetic-radar/1.0 (personal arbitrage tool)"

// fetchJSON performs one GET and decodes the body into v.
func fetchJSON(ctx context.Context, client *http.Client, url string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

// ---------------------------------------------------------------- Waxpeer

// Waxpeer publishes its whole Dota price list without a key.
// Prices arrive in thousandths of a dollar.
type Waxpeer struct {
	HTTP *http.Client
	FX   *FX
}

func NewWaxpeer(fx *FX) *Waxpeer {
	return &Waxpeer{HTTP: &http.Client{Timeout: 40 * time.Second}, FX: fx}
}

func (w *Waxpeer) Name() string { return "waxpeer" }

func (w *Waxpeer) GemQuotes(ctx context.Context) (map[string]pricing.Quote, error) {
	var body struct {
		Success bool `json:"success"`
		Items   []struct {
			Name  string `json:"name"`
			Count int    `json:"count"`
			Min   int64  `json:"min"`
		} `json:"items"`
	}
	if err := fetchJSON(ctx, w.HTTP, "https://api.waxpeer.com/v1/prices?game=dota2", &body); err != nil {
		return nil, fmt.Errorf("waxpeer: %w", err)
	}
	rate := w.FX.Rate()
	out := make(map[string]pricing.Quote)
	for _, it := range body.Items {
		if !strings.HasPrefix(it.Name, "Kinetic:") || it.Min <= 0 {
			continue
		}
		out[it.Name] = pricing.Quote{
			Source: w.Name(),
			Price:  float64(it.Min) / 1000 * rate,
			Kind:   pricing.KindAsk,
			Volume: it.Count,
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- LOOT.Farm

// LootFarm is a swap site. Beyond the price it publishes `have` (its stock)
// and `max` (how many it is still willing to take), which is a rare direct
// read on demand rather than on what sellers hope to get.
type LootFarm struct {
	HTTP *http.Client
	FX   *FX
}

func NewLootFarm(fx *FX) *LootFarm {
	return &LootFarm{HTTP: &http.Client{Timeout: 40 * time.Second}, FX: fx}
}

func (l *LootFarm) Name() string { return "lootfarm" }

func (l *LootFarm) GemQuotes(ctx context.Context) (map[string]pricing.Quote, error) {
	var items []struct {
		Name  string `json:"name"`
		Price int64  `json:"price"` // US cents
		Have  int    `json:"have"`
		Max   int    `json:"max"`
	}
	if err := fetchJSON(ctx, l.HTTP, "https://loot.farm/fullpriceDOTA.json", &items); err != nil {
		return nil, fmt.Errorf("lootfarm: %w", err)
	}
	rate := l.FX.Rate()
	out := make(map[string]pricing.Quote)
	for _, it := range items {
		if !strings.HasPrefix(it.Name, "Kinetic:") || it.Price <= 0 {
			continue
		}
		kind := pricing.KindAsk
		// A positive `max` means the site actively wants the item.
		if it.Max > 0 {
			kind = pricing.KindDemand
		}
		out[it.Name] = pricing.Quote{
			Source: l.Name(),
			Price:  float64(it.Price) / 100 * rate,
			Kind:   kind,
			Volume: it.Have,
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- Lis-Skins

// LisSkins publishes every individual lot rather than an aggregate, with the
// item's class id and Valve's own socket sprite identifiers.
type LisSkins struct {
	HTTP *http.Client
	FX   *FX
}

func NewLisSkins(fx *FX) *LisSkins {
	return &LisSkins{HTTP: &http.Client{Timeout: 90 * time.Second}, FX: fx}
}

func (l *LisSkins) Name() string { return "lis-skins" }

// LisLot is one listing, kept for the variant-level scan.
type LisLot struct {
	ID       int64    `json:"id"`
	Name     string   `json:"name"`
	Price    float64  `json:"price"` // USD
	ClassID  string   `json:"item_class_id"`
	AssetID  string   `json:"item_asset_id"`
	UnlockAt *string  `json:"unlock_at"`
	Gems     []LisGem `json:"gems"`
}

// LisGem carries the same sprite file name Valve renders, so the kinetic test
// is identical to the one applied to Steam's own markup.
type LisGem struct {
	Identifiers []string `json:"identifiers"`
	Name        string   `json:"name"`
}

// Kinetic reports whether the gem sits in a real kinetic socket.
func (g LisGem) Kinetic() bool {
	for _, id := range g.Identifiers {
		if strings.HasPrefix(id, "gem_animation") {
			return true
		}
	}
	return false
}

// Lots downloads the full Dota listing export (about 20 MB, 75 000 lots).
func (l *LisSkins) Lots(ctx context.Context) ([]LisLot, error) {
	var body struct {
		Status     string   `json:"status"`
		LastUpdate int64    `json:"last_update"`
		Items      []LisLot `json:"items"`
	}
	err := fetchJSON(ctx, l.HTTP,
		"https://lis-skins.ru/market_export_json/api_dota2_full.json", &body)
	if err != nil {
		return nil, fmt.Errorf("lis-skins: %w", err)
	}
	return body.Items, nil
}

// Scan downloads the export once and returns both halves of it: the lots, and
// the loose-gem quotes derived from them.
//
// The export is 20 MB and carries every lot's sockets, but only the gems sold
// as gems were ever read out of it — the eighty items actually carrying a
// kinetic gem were downloaded and discarded on every refresh. Fetching twice
// to recover them would be absurd, so both readings come from one download.
func (l *LisSkins) Scan(ctx context.Context) ([]LisLot, map[string]pricing.Quote, error) {
	lots, err := l.Lots(ctx)
	if err != nil {
		return nil, nil, err
	}
	return lots, l.quotesFrom(lots), nil
}

func (l *LisSkins) GemQuotes(ctx context.Context) (map[string]pricing.Quote, error) {
	lots, err := l.Lots(ctx)
	if err != nil {
		return nil, err
	}
	return l.quotesFrom(lots), nil
}

func (l *LisSkins) quotesFrom(lots []LisLot) map[string]pricing.Quote {
	rate := l.FX.Rate()
	cheapest := make(map[string]float64)
	count := make(map[string]int)
	for _, lot := range lots {
		if !strings.HasPrefix(lot.Name, "Kinetic:") || lot.Price <= 0 {
			continue
		}
		count[lot.Name]++
		if cur, ok := cheapest[lot.Name]; !ok || lot.Price < cur {
			cheapest[lot.Name] = lot.Price
		}
	}
	out := make(map[string]pricing.Quote, len(cheapest))
	for name, usd := range cheapest {
		out[name] = pricing.Quote{
			Source: l.Name(),
			Price:  usd * rate,
			Kind:   pricing.KindAsk,
			Volume: count[name],
		}
	}
	return out
}

// KineticGems lists the real kinetic gems physically in this lot, using the
// same sprite test applied to Valve's own markup.
func (lot LisLot) KineticGems() []string {
	var out []string
	for _, g := range lot.Gems {
		if g.Kinetic() && g.Name != "" && !strings.EqualFold(g.Name, "Empty Socket") {
			out = append(out, g.Name)
		}
	}
	return out
}
