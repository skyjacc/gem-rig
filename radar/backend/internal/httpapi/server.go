// Package httpapi serves the dashboard and the JSON API on localhost.
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io/fs"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"radar/internal/config"
	"radar/internal/dota"
	"radar/internal/economics"
	"radar/internal/guard"
	"radar/internal/history"
	"radar/internal/hub"
	"radar/internal/journal"
	"radar/internal/market"
	"radar/internal/pricing"
	"radar/internal/ratelimit"
	"radar/internal/scanner"
	"radar/internal/sources"
	"radar/internal/steam"
)

// Server wires the components behind one HTTP mux.
type Server struct {
	Cfg       *config.Config
	Market    *market.Client
	Steam     *steam.Client
	Scanner   *scanner.Scanner
	DMarket   *scanner.DMarketScanner
	Guard     *guard.Guard
	Hub       *hub.Hub
	Limiter   *ratelimit.Limiter
	Book      *pricing.Book
	Books     *economics.BookCache
	Journal   *journal.Journal
	History   *history.Store
	Economics EconomicsStore
	Collector *sources.Collector
	FX        *sources.FX
	Assets    fs.FS

	// The balance is polled in the background rather than fetched per request:
	// GetMoney shares the 4 req/sec budget with the catalogue sweep, so a
	// synchronous call would leave the dashboard waiting behind a 9 MB dump.
	balanceMu  sync.RWMutex
	balance    market.Money
	balanceErr string
	balanceAt  time.Time
}

// EconomicsStore is the operator's trading terms, owned by main so the market
// commission can be refreshed independently of the HTTP layer.
type EconomicsStore interface {
	Settings() economics.Settings
	Update(func(*economics.Settings)) economics.Settings
	Status() (time.Time, string)
}

// PollBalance keeps the cached market balance fresh until ctx is cancelled.
func (s *Server) PollBalance(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = 30 * time.Second
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		if s.Cfg.MarketKey() != "" {
			money, err := s.Market.GetMoney(ctx)
			s.balanceMu.Lock()
			if err != nil {
				s.balanceErr = err.Error()
			} else {
				s.balance = money
				s.balanceErr = ""
				s.balanceAt = time.Now()
			}
			s.balanceMu.Unlock()
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Handler builds the routing table.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/findings", s.handleFindings)
	mux.HandleFunc("/api/settings", s.handleSettings)
	mux.HandleFunc("/api/scan", s.handleScan)
	mux.HandleFunc("/api/trades", s.handleTrades)
	mux.HandleFunc("/api/asset", s.handleAsset)
	mux.HandleFunc("/api/item", s.handleItem)
	mux.HandleFunc("/api/gems", s.handleGems)
	mux.HandleFunc("/api/economics", s.handleEconomics)
	mux.HandleFunc("/api/journal", s.handleJournal)
	mux.HandleFunc("/api/journal/export", s.handleJournalExport)
	mux.HandleFunc("/api/coverage", s.handleCoverage)
	mux.HandleFunc("/api/history", s.handleHistory)
	mux.HandleFunc("/api/runs", s.handleRuns)
	mux.HandleFunc("/api/events", s.handleEvents)
	mux.HandleFunc("/inspect", s.handleInspect)

	if s.Assets != nil {
		fileServer := http.FileServer(http.FS(s.Assets))
		mux.Handle("/", spaFallback(s.Assets, fileServer))
	}
	return mux
}

// spaFallback serves the built dashboard, falling back to index.html so
// client-side routes survive a page reload.
//
// An unmatched /api/ path is a 404, never the dashboard. Returning HTML there
// makes a missing endpoint look alive: a caller sees 200, and only the content
// type gives it away. That cost real debugging time once already.
func spaFallback(assets fs.FS, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeJSON(w, http.StatusNotFound, map[string]string{
				"error": "unknown endpoint: " + r.URL.Path,
			})
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(assets, path); err != nil {
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	type status struct {
		MarketKeyOK   bool          `json:"market_key_ok"`
		SteamKeyOK    bool          `json:"steam_key_ok"`
		Balance       float64       `json:"balance"`
		Currency      string        `json:"currency"`
		BalanceAt     time.Time     `json:"balance_at"`
		BalanceError  string        `json:"balance_error,omitempty"`
		RequestsLastS int           `json:"requests_last_second"`
		Scanner       scanner.Stats `json:"scanner"`
		GuardLastRun  time.Time     `json:"guard_last_run"`
		GuardError    string        `json:"guard_error,omitempty"`
		BuyEnabled    bool          `json:"buy_enabled"`

		DMarket  scanner.DMarketStats   `json:"dmarket"`
		Sources  []sources.SourceStatus `json:"sources"`
		Gems     int                    `json:"gems_priced"`
		FXRate   float64                `json:"fx_rate"`
		FXSource string                 `json:"fx_source"`
		// FXUpdated lets the panel distinguish a rate measured minutes ago from
		// the built-in constant the process started with. Both are numbers; only
		// one of them was measured.
		FXUpdated time.Time `json:"fx_updated"`
	}
	st := status{
		MarketKeyOK:   s.Cfg.MarketKey() != "",
		SteamKeyOK:    s.Cfg.SteamKey() != "",
		RequestsLastS: s.Limiter.RecentRate(),
		Scanner:       s.Scanner.Stats(),
		BuyEnabled:    s.Cfg.AllowBuy,
	}
	st.GuardLastRun, st.GuardError = s.Guard.Status()
	if s.DMarket != nil {
		st.DMarket = s.DMarket.Stats()
	}
	if s.Collector != nil {
		st.Sources = s.Collector.Status()
	}
	if s.Book != nil {
		st.Gems = s.Book.Size()
	}
	if s.FX != nil {
		st.FXRate, st.FXSource, st.FXUpdated = s.FX.Status()
	}

	s.balanceMu.RLock()
	st.Balance = s.balance.Money
	st.Currency = s.balance.Currency
	st.BalanceAt = s.balanceAt
	st.BalanceError = s.balanceErr
	s.balanceMu.RUnlock()

	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleFindings(w http.ResponseWriter, r *http.Request) {
	findings := s.Scanner.Findings()
	if s.DMarket != nil {
		findings = append(findings, s.DMarket.Findings()...)
	}
	sort.Slice(findings, func(i, j int) bool { return findings[i].NetSpread > findings[j].NetSpread })
	if src := r.URL.Query().Get("source"); src != "" {
		filtered := findings[:0:0]
		for _, f := range findings {
			if f.Source == src {
				filtered = append(filtered, f)
			}
		}
		findings = filtered
	}
	if limit := r.URL.Query().Get("limit"); limit != "" {
		if n, err := strconv.Atoi(limit); err == nil && n > 0 && n < len(findings) {
			findings = findings[:n]
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"count":   len(findings),
		"results": findings,
	})
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, s.Scanner.Options())
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	opts := s.Scanner.Options()
	var body struct {
		MaxItemPrice *float64 `json:"max_item_price"`
		MinSpread    *float64 `json:"min_spread"`
		SaleFee      *float64 `json:"sale_fee"`
		IntervalSecs *int     `json:"interval_seconds"`
		MaxCalls     *int     `json:"max_steam_calls_per_sweep"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if body.MaxItemPrice != nil && *body.MaxItemPrice > 0 {
		opts.MaxItemPrice = *body.MaxItemPrice
	}
	if body.MinSpread != nil {
		opts.MinSpread = *body.MinSpread
	}
	if body.SaleFee != nil && *body.SaleFee >= 0 && *body.SaleFee < 1 {
		opts.SaleFee = *body.SaleFee
	}
	if body.IntervalSecs != nil && *body.IntervalSecs >= 60 {
		opts.Interval = time.Duration(*body.IntervalSecs) * time.Second
	}
	if body.MaxCalls != nil && *body.MaxCalls > 0 {
		opts.MaxSteamCallsPerSweep = *body.MaxCalls
	}
	s.Scanner.SetOptions(opts)
	writeJSON(w, http.StatusOK, s.Scanner.Options())
}

func (s *Server) handleScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// The kick channel holds one slot. Saying "queued" for the second press
	// implies a depth the scanner does not have, so the answer distinguishes
	// a fresh request from one that merged into a sweep already waiting.
	running := s.Scanner.Stats().Running
	already := s.Scanner.Queued()
	s.Scanner.KickBecause("manual")
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "queued",
		"merged":  already,
		"running": running,
		"note": map[bool]string{
			true:  "обход уже в очереди — запросы объединяются в один",
			false: "обход market.dota2.net поставлен в очередь",
		}[already],
	})
}

func (s *Server) handleTrades(w http.ResponseWriter, r *http.Request) {
	last, errMsg := s.Guard.Status()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"alerts":   s.Guard.Alerts(),
		"last_run": last,
		"error":    errMsg,
	})
}

func (s *Server) handleAsset(w http.ResponseWriter, r *http.Request) {
	classID := r.URL.Query().Get("class")
	instanceID := r.URL.Query().Get("instance")
	if classID == "" || instanceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "class and instance are required"})
		return
	}
	key := steam.AssetKey{ClassID: classID, InstanceID: instanceID}
	assets, err := s.Steam.AssetClassInfo(r.Context(), []steam.AssetKey{key})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	asset, ok := assets[key.String()]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "asset not found in the Steam economy"})
		return
	}
	writeJSON(w, http.StatusOK, asset)
}

// handleGems exposes the aggregated gem price book, so a valuation can be
// audited source by source rather than taken on faith.
func (s *Server) handleGems(w http.ResponseWriter, _ *http.Request) {
	if s.Book == nil {
		writeJSON(w, http.StatusOK, map[string]any{"count": 0, "results": []any{}})
		return
	}
	all := s.Book.All()
	writeJSON(w, http.StatusOK, map[string]any{
		"count":   len(all),
		"results": all,
		"sources": s.Collector.Status(),
	})
}

// handleJournal serves the audit record: what happened, to what, and why.
func (s *Server) handleJournal(w http.ResponseWriter, r *http.Request) {
	if s.Journal == nil {
		writeJSON(w, http.StatusOK, map[string]any{"count": 0, "events": []any{}})
		return
	}
	q := journal.Query{
		Kind:    r.URL.Query().Get("kind"),
		Subject: r.URL.Query().Get("subject"),
		Run:     r.URL.Query().Get("run"),
		Level:   journal.Level(r.URL.Query().Get("level")),
		Limit:   200,
	}
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 2000 {
			q.Limit = n
		}
	}
	if v := r.URL.Query().Get("since"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 64); err == nil {
			q.SinceID = n
		}
	}
	events := s.Journal.Events(q)
	writeJSON(w, http.StatusOK, map[string]any{
		"count":  len(events),
		"events": events,
		"counts": s.Journal.Counts(),
		"total":  s.Journal.Size(),
	})
}

// handleJournalExport hands the whole record over as newline-delimited JSON,
// one event per line, so it can be grepped, piped through jq or attached to a
// bug report without the dashboard in the way.
func (s *Server) handleJournalExport(w http.ResponseWriter, r *http.Request) {
	if s.Journal == nil {
		http.Error(w, "journal not configured", http.StatusNotFound)
		return
	}
	events := s.Journal.Events(journal.Query{
		Kind:    r.URL.Query().Get("kind"),
		Subject: r.URL.Query().Get("subject"),
		Level:   journal.Level(r.URL.Query().Get("level")),
		Limit:   0,
	})
	name := "radar-journal-" + time.Now().Format("2006-01-02-1504") + ".ndjson"
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	enc := json.NewEncoder(w)
	// Oldest first: a log reads forwards in time.
	for i := len(events) - 1; i >= 0; i-- {
		if err := enc.Encode(events[i]); err != nil {
			return
		}
	}
}

// GemCoverage answers whether the radar is actually seeing everything.
type GemCoverage struct {
	// InGame is how many kinetic gems Valve ships with a market name.
	InGame int `json:"in_game"`
	// Priced counts only known universe names with a quote in the book.
	Priced int `json:"priced"`
	// Unlisted is the legacy wire name for known gems without a collected
	// quote. It is not evidence that no marketplace lists them.
	Unlisted []string `json:"unlisted"`
	// Unknown are gems the markets quote that the game data does not list,
	// which usually means a renamed or newly added modifier.
	Unknown []string `json:"unknown"`
}

func gemCoverage(universe, names []string) GemCoverage {
	cov := GemCoverage{Unlisted: []string{}, Unknown: []string{}}
	known := map[string]string{}
	for _, name := range universe {
		known[pricing.Normalize(name)] = name
	}
	cov.InGame = len(known)
	quoted := map[string]bool{}
	for _, name := range names {
		key := pricing.Normalize(name)
		if quoted[key] {
			continue
		}
		quoted[key] = true
		if _, ok := known[key]; ok {
			cov.Priced++
		} else {
			cov.Unknown = append(cov.Unknown, name)
		}
	}
	for key, name := range known {
		if !quoted[key] {
			cov.Unlisted = append(cov.Unlisted, name)
		}
	}
	sort.Strings(cov.Unlisted)
	sort.Strings(cov.Unknown)
	return cov
}

// handleCoverage reports how much of the market and of the gem catalogue the
// radar has actually looked at. Source rows saying "5 · 15 минут назад" mean
// nothing without a denominator.
func (s *Server) handleCoverage(w http.ResponseWriter, _ *http.Request) {
	stats := s.Scanner.Stats()

	var names []string
	if s.Book != nil {
		for _, g := range s.Book.All() {
			names = append(names, g.Name)
		}
	}
	cov := gemCoverage(dota.KineticUniverse(), names)

	sourceStatus := []sources.SourceStatus{}
	if s.Collector != nil {
		sourceStatus = s.Collector.Status()
	}
	books := 0
	if s.Books != nil {
		books = s.Books.Size()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"catalogue": map[string]any{
			"variants":         stats.CatalogueSize,
			"built_at":         stats.CatalogueBuilt,
			"candidates":       stats.Candidates,
			"resolved":         stats.Resolved,
			"pending":          stats.PendingResolve,
			"with_gems":        stats.CurrentGemVariants,
			"current_resolved": stats.CurrentResolved,
		},
		"gems":        cov,
		"order_books": books,
		"sources":     sourceStatus,
		"scanner":     stats,
	})
}

// handleHistory serves the plotted series: the radar's own state over time,
// and one gem's valuation over time when a name is given.
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	if s.History == nil {
		writeJSON(w, http.StatusOK, map[string]any{"sweeps": []any{}, "gems": []any{}})
		return
	}
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	if gem := r.URL.Query().Get("gem"); gem != "" {
		key := s.resolveGemSeries(gem)
		writeJSON(w, http.StatusOK, map[string]any{
			"gem":    key,
			"points": s.History.Gem(key, limit),
		})
		return
	}
	sweeps, gems, points := s.History.Size()
	writeJSON(w, http.StatusOK, map[string]any{
		"sweeps":       s.History.Sweeps(limit),
		"tracked_gems": s.History.TrackedGems(),
		"retained":     map[string]int{"sweeps": sweeps, "gems": gems, "points": points},
	})
}

// resolveGemSeries maps whatever name the caller holds onto the key the history
// store recorded under.
//
// The same gem travels under two spellings: the price book keeps the full
// market name ("Kinetic: Wraith Spin"), while a finding carries it stripped
// ("Wraith Spin"). A popup opened from the offers table therefore asks for a
// name the store has never seen, and the chart comes back empty even though
// the series exists.
func (s *Server) resolveGemSeries(name string) string {
	if len(s.History.Gem(name, 1)) > 0 {
		return name
	}
	want := pricing.Normalize(name)
	if want == "" {
		return name
	}
	for _, tracked := range s.History.TrackedGems() {
		if pricing.Normalize(tracked) == want {
			return tracked
		}
	}
	return name
}

// handleRuns lists recent sweeps: what triggered each, how it ended, and what
// it produced or discarded.
//
// "Обход завершён" on its own answers nothing. A run row is the unit the owner
// actually asks about — which scan was that, did it finish, what came of it —
// and every count here can be opened as journal events via ?run=<id>.
func (s *Server) handleRuns(w http.ResponseWriter, r *http.Request) {
	if s.Scanner == nil {
		writeJSON(w, http.StatusOK, map[string]any{"runs": []any{}})
		return
	}
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 50 {
			limit = n
		}
	}
	body := map[string]any{
		"runs":   s.Scanner.Runs(limit),
		"queued": s.Scanner.Queued(),
	}
	if cur, ok := s.Scanner.CurrentRun(); ok {
		body["current"] = cur
	}
	writeJSON(w, http.StatusOK, body)
}

// handleEconomics reads and updates the operator's trading terms.
//
// The market commission is read from the account and cannot be set here; the
// rest are the operator's own facts about how they trade.
func (s *Server) handleEconomics(w http.ResponseWriter, r *http.Request) {
	if s.Economics == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "economics not configured"})
		return
	}
	if r.Method == http.MethodPost {
		var body struct {
			SteamFeePercent     *float64 `json:"steam_fee_percent"`
			DMarketFeePercent   *float64 `json:"dmarket_fee_percent"`
			SteamWalletValue    *float64 `json:"steam_wallet_value"`
			ExtractionCost      *float64 `json:"extraction_cost"`
			AllowListedExit     *bool    `json:"allow_listed_exit"`
			SteamFeeConfirmed   *bool    `json:"steam_fee_confirmed"`
			DMarketFeeConfirmed *bool    `json:"dmarket_fee_confirmed"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		s.Economics.Update(func(e *economics.Settings) {
			if body.SteamFeePercent != nil && *body.SteamFeePercent >= 0 && *body.SteamFeePercent < 100 {
				e.SteamFeePercent = *body.SteamFeePercent
			}
			if body.DMarketFeePercent != nil && *body.DMarketFeePercent >= 0 && *body.DMarketFeePercent < 100 {
				e.DMarketFeePercent = *body.DMarketFeePercent
			}
			if body.SteamWalletValue != nil && *body.SteamWalletValue >= 0 && *body.SteamWalletValue <= 1 {
				e.SteamWalletValue = *body.SteamWalletValue
			}
			if body.ExtractionCost != nil && *body.ExtractionCost >= 0 {
				e.ExtractionCost = *body.ExtractionCost
			}
			if body.AllowListedExit != nil {
				e.AllowListedExit = *body.AllowListedExit
			}
			if body.SteamFeeConfirmed != nil {
				e.SteamFeeConfirmed = *body.SteamFeeConfirmed
			}
			if body.DMarketFeeConfirmed != nil {
				e.DMarketFeeConfirmed = *body.DMarketFeeConfirmed
			}
		})
	}

	feeAt, feeErr := s.Economics.Status()
	books := 0
	if s.Books != nil {
		books = s.Books.Size()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"settings":         s.Economics.Settings(),
		"market_fee_at":    feeAt,
		"market_fee_error": feeErr,
		"order_books":      books,
	})
}

// ItemOffer is one seller's asking price for an item variant.
type ItemOffer struct {
	Price float64 `json:"price"`
	Count int     `json:"count"`
}

// ItemDetail is everything the dashboard shows in the item popup.
type ItemDetail struct {
	ClassID    string         `json:"classid"`
	InstanceID string         `json:"instanceid"`
	Name       string         `json:"name"`
	Type       string         `json:"type"`
	IconURL    string         `json:"icon_url"`
	Sockets    []steam.Socket `json:"sockets"`
	ValveHTML  string         `json:"valve_html"`
	Offers     []ItemOffer    `json:"offers"`
	BuyOrders  []ItemOffer    `json:"buy_orders"`
	OffersErr  string         `json:"offers_error,omitempty"`
	MarketURL  string         `json:"market_url"`
	SteamURL   string         `json:"steam_url"`
	InspectURL string         `json:"inspect_url"`
}

// parseOffers converts the market's kopek strings into rouble amounts.
func parseOffers(rows []struct {
	Price string
	Count string
}) []ItemOffer {
	var out []ItemOffer
	for _, r := range rows {
		kopeks, err := strconv.Atoi(r.Price)
		if err != nil {
			continue
		}
		count, _ := strconv.Atoi(r.Count)
		out = append(out, ItemOffer{Price: float64(kopeks) / 100, Count: count})
	}
	return out
}

// handleItem backs the item popup: sockets straight from Valve, plus the
// current asking prices on the market for the same variant.
func (s *Server) handleItem(w http.ResponseWriter, r *http.Request) {
	classID := r.URL.Query().Get("class")
	instanceID := r.URL.Query().Get("instance")
	if classID == "" || instanceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "class and instance are required"})
		return
	}
	key := steam.AssetKey{ClassID: classID, InstanceID: instanceID}

	assets, err := s.Steam.AssetClassInfo(r.Context(), []steam.AssetKey{key})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	asset, ok := assets[key.String()]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "asset not found in the Steam economy"})
		return
	}
	name, valveHTML, err := s.Steam.DescriptionHTML(r.Context(), key)
	if err != nil {
		valveHTML = ""
	}
	if name == "" {
		name = asset.MarketHashName
	}

	detail := ItemDetail{
		ClassID:    classID,
		InstanceID: instanceID,
		Name:       name,
		Type:       asset.Type,
		IconURL:    steam.EconImageURL(asset.IconURL),
		Sockets:    asset.Sockets,
		ValveHTML:  valveHTML,
		MarketURL:  fmt.Sprintf("https://market.dota2.net/item/%s-%s", classID, instanceID),
		SteamURL:   "https://steamcommunity.com/market/listings/570/" + url.PathEscape(name),
		InspectURL: fmt.Sprintf("/inspect?class=%s&instance=%s", classID, instanceID),
	}

	// One rate-limited market call, only when a popup is actually opened.
	if info, err := s.Market.ItemInfo(r.Context(), classID, instanceID, "en"); err != nil {
		detail.OffersErr = err.Error()
	} else {
		sell := make([]struct{ Price, Count string }, 0, len(info.Offers))
		for _, o := range info.Offers {
			sell = append(sell, struct{ Price, Count string }{o.Price, o.Count})
		}
		buy := make([]struct{ Price, Count string }, 0, len(info.BuyOffers))
		for _, o := range info.BuyOffers {
			buy = append(buy, struct{ Price, Count string }{o.Price, o.Count})
		}
		detail.Offers = parseOffers(sell)
		detail.BuyOrders = parseOffers(buy)
		sort.Slice(detail.Offers, func(i, j int) bool { return detail.Offers[i].Price < detail.Offers[j].Price })
		sort.Slice(detail.BuyOrders, func(i, j int) bool { return detail.BuyOrders[i].Price > detail.BuyOrders[j].Price })
		if detail.Type == "" {
			detail.Type = info.Type
		}
	}

	writeJSON(w, http.StatusOK, detail)
}

// handleEvents streams scanner and guard events to the dashboard over SSE.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	events, cancel := s.Hub.Subscribe()
	defer cancel()

	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-keepalive.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case e, ok := <-events:
			if !ok {
				return
			}
			payload, err := e.Encode()
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.Type, payload)
			flusher.Flush()
		}
	}
}

// handleInspect renders Valve's own socket markup so a find can be verified
// against the source of truth rather than the market's cached description.
func (s *Server) handleInspect(w http.ResponseWriter, r *http.Request) {
	classID := r.URL.Query().Get("class")
	instanceID := r.URL.Query().Get("instance")
	if classID == "" || instanceID == "" {
		http.Error(w, "class and instance are required", http.StatusBadRequest)
		return
	}
	key := steam.AssetKey{ClassID: classID, InstanceID: instanceID}
	name, markup, err := s.Steam.DescriptionHTML(r.Context(), key)
	if err != nil {
		http.Error(w, "Steam API: "+err.Error(), http.StatusBadGateway)
		return
	}
	assets, _ := s.Steam.AssetClassInfo(r.Context(), []steam.AssetKey{key})
	var socketRows strings.Builder
	if asset, ok := assets[key.String()]; ok {
		for i, sock := range asset.Sockets {
			socketRows.WriteString(fmt.Sprintf(
				"<tr><td>%d</td><td>%s</td><td>%s</td><td>%s</td></tr>",
				i+1, html.EscapeString(string(sock.Kind)),
				html.EscapeString(sock.Name), html.EscapeString(sock.Subtitle)))
		}
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, inspectTemplate,
		html.EscapeString(name),
		html.EscapeString(name),
		html.EscapeString(classID), html.EscapeString(instanceID),
		socketRows.String(),
		markup,
	)
}

const inspectTemplate = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Steam inspector — %s</title>
<style>
 :root { color-scheme: dark; }
 body { background:#07090e; color:#e6edf5; font:15px/1.6 system-ui,Segoe UI,sans-serif; margin:0; padding:40px 20px; }
 .card { max-width:820px; margin:0 auto; background:#0f141d; border:1px solid #1e2836; border-radius:16px; padding:28px; }
 h1 { margin:0 0 4px; font-size:1.5rem; color:#34d399; }
 .meta { color:#8896ab; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.85rem; margin-bottom:20px; }
 table { width:100%%; border-collapse:collapse; margin-bottom:24px; font-size:.9rem; }
 th,td { text-align:left; padding:6px 10px; border-bottom:1px solid #1e2836; }
 th { color:#8896ab; font-weight:600; }
 .render { background:#151b27; border:1px solid #23405c; border-radius:12px; padding:18px; overflow-x:auto; }
 a { color:#38bdf8; }
</style></head>
<body><div class="card">
<h1>%s</h1>
<div class="meta">classid %s &middot; instanceid %s &middot; source: Steam Economy API</div>
<table><thead><tr><th>#</th><th>Kind</th><th>Contents</th><th>Detail</th></tr></thead>
<tbody>%s</tbody></table>
<div class="render">%s</div>
<p><a href="/">&larr; back to the radar</a></p>
</div></body></html>`
