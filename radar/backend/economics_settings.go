package main

import (
	"context"
	"log"
	"sync"
	"time"

	"radar/internal/economics"
	"radar/internal/market"
)

// economicsStore keeps the operator's trading terms and refreshes the ones the
// market can tell us about. The sell commission is per-account and changes with
// turnover, so it is read rather than hard-coded.
type economicsStore struct {
	market *market.Client

	mu       sync.RWMutex
	settings economics.Settings
	feeAt    time.Time
	feeErr   string
}

func newEconomics(m *market.Client) *economicsStore {
	return &economicsStore{market: m, settings: economics.DefaultSettings()}
}

// Settings returns the current terms.
func (e *economicsStore) Settings() economics.Settings {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.settings
}

// Update applies operator-supplied terms, keeping the values the market owns.
func (e *economicsStore) Update(apply func(*economics.Settings)) economics.Settings {
	e.mu.Lock()
	defer e.mu.Unlock()
	apply(&e.settings)
	return e.settings
}

// Status reports when the commission was last read and any failure.
func (e *economicsStore) Status() (time.Time, string) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.feeAt, e.feeErr
}

// Run keeps the market commission current until ctx is cancelled.
func (e *economicsStore) Run(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = time.Hour
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		d, err := e.market.GetDiscounts(ctx)
		e.mu.Lock()
		if err != nil {
			e.feeErr = err.Error()
		} else {
			e.settings.MarketFeePercent = d.SellFeePercent
			e.feeErr = ""
			e.feeAt = time.Now()
			log.Printf("[economics] комиссия продажи на маркете: %.2f%%", d.SellFeePercent)
		}
		e.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
