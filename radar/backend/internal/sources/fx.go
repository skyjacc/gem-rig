// Package sources fetches kinetic gem prices from every market that answers
// without an account, plus DMarket, which needs a signed key.
//
// Every source returns roubles so the pricing book can compare them directly.
package sources

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// fallbackUSDRUB is used only until the live rate is known. It is not a
// constant of the world, just a sane starting point.
const fallbackUSDRUB = 86.5

// FX converts US dollars to roubles.
//
// The rate is derived from Steam itself rather than a currency API: the same
// gem is quoted in both currencies and the ratio is taken. That keeps the
// comparison internally consistent with the market being measured, and adds
// no third-party dependency.
type FX struct {
	mu      sync.RWMutex
	rate    float64
	updated time.Time
	source  string
}

func NewFX() *FX {
	return &FX{rate: fallbackUSDRUB, source: "fallback"}
}

// Rate returns the current dollars-to-roubles multiplier.
func (f *FX) Rate() float64 {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.rate
}

// Status reports where the rate came from and when.
func (f *FX) Status() (float64, string, time.Time) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.rate, f.source, f.updated
}

// probeItem is a liquid gem that is always listed in both currencies.
const probeItem = "Kinetic: Serene Honor"

// Refresh re-derives the rate. Two Steam requests.
func (f *FX) Refresh(ctx context.Context, s *SteamClient) error {
	usd, err := s.priceOverview(ctx, probeItem, currencyUSD)
	if err != nil {
		return err
	}
	rub, err := s.priceOverview(ctx, probeItem, currencyRUB)
	if err != nil {
		return err
	}
	if usd <= 0 || rub <= 0 {
		return fmt.Errorf("fx: steam quoted %v USD and %v RUB", usd, rub)
	}
	rate := rub / usd
	// A rate outside this band means the probe item was misparsed, not that
	// the rouble moved. Refuse it rather than mispricing every gem.
	if rate < 20 || rate > 300 {
		return fmt.Errorf("fx: implausible rate %.2f RUB/USD", rate)
	}
	f.mu.Lock()
	f.rate = rate
	f.source = "steam " + probeItem
	f.updated = time.Now()
	f.mu.Unlock()
	return nil
}

// priceText parses Steam's localised money strings: "$6.94", "600,25 руб.".
var moneyRe = regexp.MustCompile(`[0-9][0-9\s.,]*`)

func parseMoney(s string) (float64, error) {
	m := moneyRe.FindString(s)
	if m == "" {
		return 0, fmt.Errorf("no number in %q", s)
	}
	m = strings.ReplaceAll(m, " ", "")
	m = strings.ReplaceAll(m, " ", "")
	// Steam uses a comma as the decimal separator in most European locales
	// and a dot in USD. Whichever separator comes last is the decimal one.
	lastComma := strings.LastIndex(m, ",")
	lastDot := strings.LastIndex(m, ".")
	switch {
	case lastComma > lastDot:
		m = strings.ReplaceAll(m, ".", "")
		m = strings.Replace(m, ",", ".", 1)
	default:
		m = strings.ReplaceAll(m, ",", "")
	}
	return strconv.ParseFloat(strings.TrimSpace(m), 64)
}
