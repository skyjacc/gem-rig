// Package hub fans server events out to connected dashboards over SSE.
package hub

import (
	"encoding/json"
	"sync"
	"time"
)

// Event is one message pushed to the dashboard.
type Event struct {
	Type string      `json:"type"`
	At   time.Time   `json:"at"`
	Data interface{} `json:"data"`
}

// Hub broadcasts events to every subscriber and keeps a short replay buffer
// so a dashboard opened mid-scan still sees recent findings.
type Hub struct {
	mu       sync.RWMutex
	subs     map[chan Event]struct{}
	history  []Event
	maxHist  int
	maxQueue int
}

func New() *Hub {
	return &Hub{
		subs:     make(map[chan Event]struct{}),
		maxHist:  200,
		maxQueue: 64,
	}
}

// Subscribe returns a channel of events and a function to release it.
//
// The replay backlog is written into the buffer before the channel is handed
// out, not from a goroutine. A goroutine racing with the release function used
// to send on a closed channel and take the whole process down whenever a
// dashboard disconnected mid-replay.
func (h *Hub) Subscribe() (<-chan Event, func()) {
	h.mu.Lock()
	backlog := h.history
	capacity := h.maxQueue
	if len(backlog) > capacity {
		capacity = len(backlog)
	}
	ch := make(chan Event, capacity)
	for _, e := range backlog {
		ch <- e
	}
	h.subs[ch] = struct{}{}
	h.mu.Unlock()

	return ch, func() {
		h.mu.Lock()
		if _, ok := h.subs[ch]; ok {
			delete(h.subs, ch)
			close(ch)
		}
		h.mu.Unlock()
	}
}

// Publish sends an event to every subscriber. Slow subscribers drop messages
// rather than stalling the scanner.
func (h *Hub) Publish(eventType string, data interface{}) {
	e := Event{Type: eventType, At: time.Now(), Data: data}
	h.mu.Lock()
	if eventType == "finding" || eventType == "trade_alert" {
		h.history = append(h.history, e)
		if len(h.history) > h.maxHist {
			h.history = h.history[len(h.history)-h.maxHist:]
		}
	}
	for ch := range h.subs {
		select {
		case ch <- e:
		default:
		}
	}
	h.mu.Unlock()
}

// Encode renders an event as an SSE frame body.
func (e Event) Encode() ([]byte, error) { return json.Marshal(e) }

// Subscribers reports the current dashboard connection count.
func (h *Hub) Subscribers() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs)
}
