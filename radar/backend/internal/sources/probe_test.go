package sources

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"os"
	"testing"
	"time"

	"radar/internal/config"
)

// TestProbeDMarketDepth measures how deep the price-banded walk has to go
// before DMarket runs out of offers under the buying ceiling. It exists so the
// page budget is a measurement rather than a guess.
//
//	PROBE_DMARKET=1 RADAR_KEYS_DIR=... go test ./internal/sources \
//	  -run TestProbeDMarketDepth -v -count=1 -timeout 40m
func TestProbeDMarketDepth(t *testing.T) {
	if os.Getenv("PROBE_DMARKET") != "1" {
		t.Skip("diagnostic only")
	}
	cfg := config.Load()
	fx := NewFX()
	dm := NewDMarket(fx, cfg.DMarketPublicKey, func() ed25519.PrivateKey {
		key, err := ParsePrivateKey(cfg.DMarketSecretKey())
		if err != nil {
			return nil
		}
		return key
	})
	if !dm.Configured() {
		t.Skip("no dmarket keys")
	}
	if err := fx.Refresh(context.Background(), NewSteamClient(fx)); err != nil {
		t.Logf("курс остался запасным: %v", err)
	}

	const cap = 1500.0
	for _, budget := range []int{500, 1500, 3000} {
		start := time.Now()
		offers, scanned, truncated, err := dm.Offers(context.Background(), budget, cap)
		carriers := 0
		for _, o := range offers {
			if len(o.Gems) > 0 {
				carriers++
			}
		}
		fmt.Printf("бюджет %5d стр: просмотрено %7d, с гемом %4d, обрезано=%v, %s, err=%v\n",
			budget, scanned, carriers, truncated, time.Since(start).Round(time.Second), err)
		if !truncated {
			fmt.Printf("  ПОЛНОЕ ПОКРЫТИЕ достигнуто при бюджете %d страниц\n", budget)
			return
		}
	}
}
