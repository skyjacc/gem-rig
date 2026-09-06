// Package ratelimit provides a hard cap on outbound request rate.
//
// market.dota2.net deletes the API key of any client that exceeds
// 5 requests per second, so the limiter is deliberately conservative:
// requests are serialised and spaced by a fixed interval, with no burst.
package ratelimit

import (
	"context"
	"sync"
	"time"
)

type Limiter struct {
	mu       sync.Mutex
	interval time.Duration
	next     time.Time

	statMu sync.Mutex
	stamps []time.Time
}

// New returns a limiter that allows at most rps requests per second.
func New(rps float64) *Limiter {
	if rps <= 0 {
		rps = 1
	}
	return &Limiter{interval: time.Duration(float64(time.Second) / rps)}
}

// Wait blocks until the caller is allowed to send one request.
func (l *Limiter) Wait(ctx context.Context) error {
	l.mu.Lock()
	now := time.Now()
	slot := l.next
	if slot.Before(now) {
		slot = now
	}
	l.next = slot.Add(l.interval)
	l.mu.Unlock()

	delay := time.Until(slot)
	if delay > 0 {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
	l.record()
	return nil
}

func (l *Limiter) record() {
	now := time.Now()
	l.statMu.Lock()
	defer l.statMu.Unlock()
	l.stamps = append(l.stamps, now)
	cutoff := now.Add(-time.Second)
	i := 0
	for i < len(l.stamps) && l.stamps[i].Before(cutoff) {
		i++
	}
	l.stamps = l.stamps[i:]
}

// RecentRate reports how many requests were sent in the last second.
func (l *Limiter) RecentRate() int {
	now := time.Now()
	l.statMu.Lock()
	defer l.statMu.Unlock()
	cutoff := now.Add(-time.Second)
	n := 0
	for _, t := range l.stamps {
		if t.After(cutoff) {
			n++
		}
	}
	return n
}
