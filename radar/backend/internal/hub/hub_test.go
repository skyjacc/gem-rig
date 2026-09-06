package hub

import (
	"sync"
	"testing"
)

// Subscribe fills a replay backlog from a goroutine while cancel closes the
// same channel. A dashboard that disconnects mid-replay should not crash the
// radar.
func TestSubscribeCancelDuringReplayDoesNotPanic(t *testing.T) {
	h := New()
	for i := 0; i < 200; i++ {
		h.Publish("finding", i)
	}
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, cancel := h.Subscribe()
			cancel()
		}()
	}
	wg.Wait()
}
