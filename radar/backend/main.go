// Command radar watches Dota 2 marketplaces for items whose sockets are worth
// more than the item, and warns when an incoming Steam trade does not match
// what was paid for.
package main

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"radar/internal/config"
	"radar/internal/economics"
	"radar/internal/guard"
	"radar/internal/history"
	"radar/internal/httpapi"
	"radar/internal/hub"
	"radar/internal/journal"
	"radar/internal/market"
	"radar/internal/pricing"
	"radar/internal/ratelimit"
	"radar/internal/scanner"
	"radar/internal/sources"
	"radar/internal/steam"
	"radar/web"
)

// marketRPS stays a full request per second below the market's limit of 5,
// which is enforced by key deletion.
const marketRPS = 4

func main() {
	log.SetFlags(log.Ltime)
	cfg := config.Load()

	limiter := ratelimit.New(marketRPS)
	marketClient := market.NewClient(limiter, cfg.MarketKey)
	steamClient := steam.NewClient(cfg.SteamKey)
	events := hub.New()
	audit := journal.New(5000)
	// The journal also lands on disk, one file per day, one JSON object per
	// line. The dashboard's ring buffer disappears on restart; a lot that
	// vanished last night has to still be explainable this morning.
	journalDir := filepath.Join(dataDir(), "journal")
	if sink, err := journal.NewFileSink(journalDir); err != nil {
		log.Printf("[journal] файл не пишется: %v", err)
	} else {
		audit.Subscribe(sink.Write)
		defer sink.Close()
		log.Printf("[journal] пишу в %s", sink.Dir())
	}
	// Every journal entry also reaches the dashboard live, so the table can
	// explain a row disappearing while the operator is looking at it.
	audit.Subscribe(func(e journal.Event) { events.Publish("journal", e) })

	book := pricing.NewBook()
	fx := sources.NewFX()
	dmarket := sources.NewDMarket(fx, cfg.DMarketPublicKey, dmarketSecret(cfg))
	past := history.New(dataDir())
	collector := sources.NewCollector(book, fx, dmarket)
	collector.Log = audit
	collector.Past = past

	opts := scanner.DefaultOptions()
	opts.DataDir = dataDir()
	scan := scanner.New(marketClient, steamClient, book, events, opts)

	// Exit prices come from standing buy orders, not from listings. The market
	// keys its order book by item name, so one lookup covers every variant.
	books := economics.NewBookCache(func(ctx context.Context, classID, instanceID string) (economics.Book, error) {
		ob, err := marketClient.BuyOrders(ctx, classID, instanceID)
		return economics.Book{Best: ob.Best, Orders: ob.Orders}, err
	}, 15*time.Minute)
	econ := newEconomics(marketClient)
	scan.SetEconomics(books, econ.Settings)
	scan.SetJournal(audit)
	scan.SetHistory(past)
	collector.OrderBook = func(gem string) (float64, bool) {
		b, ok := books.Lookup(gem)
		return b.Best, ok && b.Best > 0
	}
	scan.ReportSource = collector.Report
	dmScan := scanner.NewDMarketScanner(dmarket, book, events, scan)
	tradeGuard := guard.New(steamClient, marketClient, events, cfg.SteamKey)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go econ.Run(ctx, time.Hour)
	go collector.Run(ctx, 30*time.Minute)
	go scan.Run(ctx)
	go dmScan.Run(ctx, 5*time.Minute)
	go tradeGuard.Run(ctx, 30*time.Second)
	go watchNewLots(ctx, scan)

	srv := &httpapi.Server{
		Cfg:       cfg,
		Market:    marketClient,
		Steam:     steamClient,
		Scanner:   scan,
		DMarket:   dmScan,
		Guard:     tradeGuard,
		Hub:       events,
		Limiter:   limiter,
		Book:      book,
		Books:     books,
		Journal:   audit,
		History:   past,
		Economics: econ,
		Collector: collector,
		FX:        fx,
		Assets:    web.Assets(),
	}

	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go srv.PollBalance(ctx, 30*time.Second)

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	logStartup(cfg, dmarket)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("http server: %v", err)
	}
	log.Println("radar stopped")
}

// dataDir is where persistent state and journals live. It sits beside the
// backend rather than inside it so a rebuild never wipes the sweep cache.
func dataDir() string {
	if dir := os.Getenv("RADAR_DATA_DIR"); dir != "" {
		return dir
	}
	return filepath.Join("..", "radar-data")
}

// dmarketSecret parses the Ed25519 key once per read so a rotated key file is
// picked up by config.Reload without restarting.
func dmarketSecret(cfg *config.Config) func() ed25519.PrivateKey {
	var cachedHex string
	var cached ed25519.PrivateKey
	return func() ed25519.PrivateKey {
		hexKey := cfg.DMarketSecretKey()
		if hexKey == "" {
			return nil
		}
		if hexKey == cachedHex {
			return cached
		}
		key, err := sources.ParsePrivateKey(hexKey)
		if err != nil {
			log.Printf("[dmarket] %v", err)
			return nil
		}
		cachedHex, cached = hexKey, key
		return key
	}
}

// watchNewLots turns the market's public notification socket into extra
// sweeps, so a fresh lot is checked within seconds instead of at the next
// scheduled catalogue pass.
func watchNewLots(ctx context.Context, scan *scanner.Scanner) {
	items := make(chan market.NewItem, 256)
	go market.WatchNewItems(ctx, items)

	// The channel is very chatty; collapse bursts into one sweep request.
	var pending bool
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-items:
			pending = true
		case <-ticker.C:
			if pending {
				pending = false
				scan.KickBecause("new_lot")
			}
		}
	}
}

func logStartup(cfg *config.Config, dm *sources.DMarket) {
	log.Printf("radar listening on http://127.0.0.1:%d", cfg.Port)
	log.Printf("keys dir: %s (market: %v, steam: %v, dmarket: %v)",
		cfg.KeysDir, cfg.MarketKey() != "", cfg.SteamKey() != "", dm.Configured())
	log.Printf("rate limit: %d req/sec to market.dota2.net (its hard limit is 5)", marketRPS)
	log.Printf("gem prices: tm.net + steam + waxpeer + lootfarm + lis-skins" +
		", plus dmarket completed sales when keyed")
	log.Printf("trade guard: alert only, it never accepts or declines an offer")
}
