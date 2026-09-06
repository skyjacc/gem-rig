package market

import (
	"context"
	"encoding/json"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// wsEndpoint is the market's notification socket.
const wsEndpoint = "wss://wsn.dota2.net/wsn/"

// NewItem is a lot that just appeared on (or changed price on) the market.
type NewItem struct {
	ClassID    string    `json:"classid"`
	InstanceID string    `json:"instanceid"`
	Price      float64   `json:"price"`
	Name       string    `json:"name"`
	Seen       time.Time `json:"seen"`
}

// Key returns the classid_instanceid identifier.
func (n NewItem) Key() string { return n.ClassID + "_" + n.InstanceID }

// WatchNewItems subscribes to the market's newitems channel and emits every
// lot it announces. It reconnects with backoff until ctx is cancelled.
//
// This is a listen-only subscription: it costs no API requests, which is why
// it is the fast path for spotting a fresh lot before other snipers.
func WatchNewItems(ctx context.Context, out chan<- NewItem) {
	backoff := time.Second
	for ctx.Err() == nil {
		if err := runSocket(ctx, out); err != nil && ctx.Err() == nil {
			log.Printf("[ws] disconnected: %v (retry in %s)", err, backoff)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func runSocket(ctx context.Context, out chan<- NewItem) error {
	dialer := websocket.Dialer{HandshakeTimeout: 20 * time.Second}
	conn, _, err := dialer.DialContext(ctx, wsEndpoint, nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	// Subscribing to a public channel needs no key, so the socket never
	// carries account credentials.
	if err := conn.WriteMessage(websocket.TextMessage, []byte("newitems_cs")); err != nil {
		return err
	}
	log.Printf("[ws] subscribed to newitems_cs")

	pingTicker := time.NewTicker(45 * time.Second)
	defer pingTicker.Stop()
	done := make(chan error, 1)

	go func() {
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				done <- err
				return
			}
			for _, item := range parseNewItems(raw) {
				select {
				case out <- item:
				case <-ctx.Done():
					done <- ctx.Err()
					return
				default:
					// Drop rather than block the socket reader: this channel
					// is very chatty and the itemdb sweep is the safety net.
				}
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-done:
			return err
		case <-pingTicker.C:
			if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
				return err
			}
		}
	}
}

// parseNewItems decodes the socket envelope. The market wraps payloads as
// {"type": "...", "data": "<json string>"} and the inner payload uses the
// same i_/ui_ field naming as the REST API.
func parseNewItems(raw []byte) []NewItem {
	text := strings.TrimSpace(string(raw))
	if text == "" || text == "pong" || text == "ping" || text == "auth" {
		return nil
	}
	var env struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil
	}
	if env.Data == nil {
		return nil
	}
	payload := env.Data
	// data is usually a JSON-encoded string, occasionally a nested object.
	var inner string
	if json.Unmarshal(payload, &inner) == nil {
		payload = json.RawMessage(inner)
	}

	var records []map[string]json.RawMessage
	if err := json.Unmarshal(payload, &records); err != nil {
		var single map[string]json.RawMessage
		if err := json.Unmarshal(payload, &single); err != nil {
			return nil
		}
		records = []map[string]json.RawMessage{single}
	}

	now := time.Now()
	var out []NewItem
	for _, rec := range records {
		item := NewItem{
			ClassID:    fieldString(rec, "i_classid", "classid"),
			InstanceID: fieldString(rec, "i_instanceid", "instanceid"),
			Name:       fieldString(rec, "i_market_name", "market_hash_name", "i_market_hash_name"),
			Seen:       now,
		}
		if item.ClassID == "" {
			continue
		}
		if p := fieldString(rec, "ui_price", "price"); p != "" {
			if v, err := strconv.ParseFloat(p, 64); err == nil {
				item.Price = v
			}
		}
		out = append(out, item)
	}
	return out
}

// fieldString reads the first present key, tolerating string or number JSON.
func fieldString(rec map[string]json.RawMessage, keys ...string) string {
	for _, k := range keys {
		raw, ok := rec[k]
		if !ok {
			continue
		}
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return s
		}
		var n json.Number
		if json.Unmarshal(raw, &n) == nil {
			return n.String()
		}
	}
	return ""
}
