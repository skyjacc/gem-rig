package economics

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestBookCacheFetchesOncePerName(t *testing.T) {
	var calls int32
	c := NewBookCache(func(_ context.Context, _, _ string) (Book, error) {
		atomic.AddInt32(&calls, 1)
		return Book{Best: 94, Orders: 3}, nil
	}, time.Minute)

	// Three variants of one item share a single order book.
	c.Register("Eye of Omoz", "147888896", "565284672")
	c.Register("Eye of Omoz", "147888896", "720638933")
	c.Register("Eye of Omoz", "147888896", "3361762589")

	for i := 0; i < 5; i++ {
		b, ok := c.Get(context.Background(), "Eye of Omoz")
		if !ok || b.Best != 94 {
			t.Fatalf("expected the cached book, got %+v ok=%v", b, ok)
		}
	}
	if calls != 1 {
		t.Fatalf("one name must cost one request, got %d", calls)
	}
}

func TestUnregisteredNameIsNotFetched(t *testing.T) {
	c := NewBookCache(func(_ context.Context, _, _ string) (Book, error) {
		t.Fatal("must not fetch a name with no known variant")
		return Book{}, nil
	}, time.Minute)
	if _, ok := c.Get(context.Background(), "Nothing"); ok {
		t.Fatal("unknown name should report no book")
	}
}

func TestFailureIsNotRetriedEverySweep(t *testing.T) {
	var calls int32
	c := NewBookCache(func(_ context.Context, _, _ string) (Book, error) {
		atomic.AddInt32(&calls, 1)
		return Book{}, errors.New("http 502")
	}, time.Minute)
	c.Register("Flaky", "1", "2")

	for i := 0; i < 4; i++ {
		if _, ok := c.Get(context.Background(), "Flaky"); ok {
			t.Fatal("a failed fetch must not report a book")
		}
	}
	if calls != 1 {
		t.Fatalf("a failing name should back off, got %d calls", calls)
	}
}

func TestWarmRespectsBudget(t *testing.T) {
	var calls int32
	c := NewBookCache(func(_ context.Context, _, _ string) (Book, error) {
		atomic.AddInt32(&calls, 1)
		return Book{Best: 10, Orders: 1}, nil
	}, time.Minute)
	names := []string{"a", "b", "c", "d", "e"}
	for _, n := range names {
		c.Register(n, "1", "2")
	}
	if got := c.Warm(context.Background(), names, 2); got != 2 {
		t.Fatalf("warm should stop at the budget, got %d", got)
	}
	if calls != 2 {
		t.Fatalf("budget of 2 must mean 2 requests, got %d", calls)
	}
}

func TestStaleBookIsRefetched(t *testing.T) {
	var calls int32
	c := NewBookCache(func(_ context.Context, _, _ string) (Book, error) {
		atomic.AddInt32(&calls, 1)
		return Book{Best: 50, Orders: 1}, nil
	}, time.Millisecond)
	c.Register("x", "1", "2")

	c.Get(context.Background(), "x")
	time.Sleep(3 * time.Millisecond)
	c.Get(context.Background(), "x")
	if calls != 2 {
		t.Fatalf("an expired book must be refetched, got %d calls", calls)
	}
}

func TestLookupNeverFetches(t *testing.T) {
	// Planning a deal must read only what warming already paid for; otherwise
	// a sweep with two dozen findings fires off a hundred extra lookups.
	c := NewBookCache(func(_ context.Context, _, _ string) (Book, error) {
		t.Fatal("Lookup must not reach the network")
		return Book{}, nil
	}, time.Minute)
	c.Register("Eye of Omoz", "1", "2")
	if _, ok := c.Lookup("Eye of Omoz"); ok {
		t.Fatal("an unwarmed name has no cached book")
	}
}
