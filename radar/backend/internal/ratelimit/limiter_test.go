package ratelimit

import (
	"context"
	"testing"
	"time"
)

func TestNeverExceedsRate(t *testing.T) {
	l := New(4)
	ctx := context.Background()
	start := time.Now()
	for i := 0; i < 9; i++ {
		if err := l.Wait(ctx); err != nil {
			t.Fatal(err)
		}
	}
	// 9 requests at 4/s must take at least 2 seconds of spacing.
	if elapsed := time.Since(start); elapsed < 2*time.Second {
		t.Fatalf("9 requests finished in %v, faster than 4 req/sec", elapsed)
	}
}

func TestWaitRespectsContext(t *testing.T) {
	l := New(1)
	ctx := context.Background()
	if err := l.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	cctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if err := l.Wait(cctx); err == nil {
		t.Fatal("expected context deadline error")
	}
}
