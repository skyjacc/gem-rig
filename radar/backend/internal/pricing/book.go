// Package pricing values a kinetic gem from several independent markets.
//
// A single marketplace ask is a bad valuation: one optimistic seller can hold
// a gem at five times what anyone pays. Twin Deaths' Haunting was listed at
// 150 RUB on one market while two others quoted about 28. Taking the median
// across sources, and flagging how far they disagree, turns that from a
// phantom 400% ROI into a visible outlier.
package pricing

import (
	"sort"
	"strings"
	"sync"
	"time"
)

// Kind describes what a quote actually measures.
type Kind string

const (
	// KindAsk is a seller's asking price: optimistic by nature.
	KindAsk Kind = "ask"
	// KindSale is a completed transaction: the most honest number available.
	KindSale Kind = "sale"
	// KindDemand is what a buyer or a bot offers to pay: the floor.
	KindDemand Kind = "demand"
)

// Quote is one market's opinion about a gem, always in roubles.
type Quote struct {
	Source string    `json:"source"`
	Price  float64   `json:"price"`
	Kind   Kind      `json:"kind"`
	Volume int       `json:"volume,omitempty"`
	At     time.Time `json:"at"`
}

// Confidence grades how much the sources agree.
type Confidence string

const (
	ConfidenceHigh   Confidence = "high"
	ConfidenceMedium Confidence = "medium"
	ConfidenceLow    Confidence = "low"
	ConfidenceNone   Confidence = "none"
)

// GemPrice is the aggregated valuation of one gem.
type GemPrice struct {
	Name       string     `json:"name"`
	Median     float64    `json:"median"`
	Low        float64    `json:"low"`
	High       float64    `json:"high"`
	Sale       float64    `json:"sale,omitempty"`
	Quotes     []Quote    `json:"quotes"`
	Confidence Confidence `json:"confidence"`
}

// Disagreement is the ratio between the highest and lowest quote.
// A gem quoted at 150 by one market and 28 by two others scores about 5.4.
func (g GemPrice) Disagreement() float64 {
	if g.Low <= 0 {
		return 0
	}
	return g.High / g.Low
}

// Book holds every source's quotes and aggregates them on read.
type Book struct {
	mu     sync.RWMutex
	quotes map[string]map[string]Quote // normalized gem -> source -> quote
	// display keeps the market spelling ("Kinetic: Serene Honor") for the
	// normalized key, so lookups that need the real title can find it.
	display map[string]string
}

func NewBook() *Book {
	return &Book{
		quotes:  make(map[string]map[string]Quote),
		display: make(map[string]string),
	}
}

// Normalize makes socket names and market names comparable. Steam renders the
// socket contents as "Serene Honor" while every market sells the same gem as
// "Kinetic: Serene Honor".
func Normalize(name string) string {
	n := strings.TrimSpace(name)
	for _, prefix := range []string{"Kinetic:", "Кинетический:", "Kinetic Gem:"} {
		n = strings.TrimPrefix(n, prefix)
	}
	return strings.ToLower(strings.Join(strings.Fields(n), " "))
}

// Set records one source's quote for a gem. A newer quote replaces the older
// one from the same source.
func (b *Book) Set(gem string, q Quote) {
	key := Normalize(gem)
	if key == "" || q.Price <= 0 {
		return
	}
	if q.At.IsZero() {
		q.At = time.Now()
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.quotes[key] == nil {
		b.quotes[key] = make(map[string]Quote, 4)
	}
	b.quotes[key][q.Source] = q
	// Prefer the full market spelling over a bare socket name.
	if cur := b.display[key]; cur == "" || (!strings.HasPrefix(cur, "Kinetic:") && strings.HasPrefix(gem, "Kinetic:")) {
		b.display[key] = strings.TrimSpace(gem)
	}
}

// DisplayName returns the market spelling of a gem, if any source used it.
func (b *Book) DisplayName(gem string) string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if d := b.display[Normalize(gem)]; d != "" {
		return d
	}
	return gem
}

// SetAll records a whole source's price list at once, dropping that source's
// previous quotes so a delisted gem does not linger.
func (b *Book) SetAll(source string, quotes map[string]Quote) {
	b.mu.Lock()
	for gem, bySource := range b.quotes {
		delete(bySource, source)
		if len(bySource) == 0 {
			delete(b.quotes, gem)
			delete(b.display, gem)
		}
	}
	b.mu.Unlock()

	for gem, q := range quotes {
		q.Source = source
		b.Set(gem, q)
	}
}

// Price aggregates every source's opinion about a gem.
func (b *Book) Price(gem string) (GemPrice, bool) {
	key := Normalize(gem)
	b.mu.RLock()
	bySource, ok := b.quotes[key]
	if !ok || len(bySource) == 0 {
		b.mu.RUnlock()
		return GemPrice{Name: gem, Confidence: ConfidenceNone}, false
	}
	quotes := make([]Quote, 0, len(bySource))
	for _, q := range bySource {
		quotes = append(quotes, q)
	}
	display := b.display[key]
	b.mu.RUnlock()

	if display == "" {
		display = gem
	}
	sort.Slice(quotes, func(i, j int) bool { return quotes[i].Price < quotes[j].Price })

	out := GemPrice{
		Name:   display,
		Quotes: quotes,
		Low:    quotes[0].Price,
		High:   quotes[len(quotes)-1].Price,
		Median: median(quotes),
	}
	saleCount := 0
	for _, q := range quotes {
		if q.Kind == KindSale {
			out.Sale = q.Price
			saleCount = q.Volume
		}
	}
	// A completed sale beats every ask: it is the only number someone paid.
	if out.Sale > 0 {
		out.Median = out.Sale
	}
	out.Confidence = grade(len(quotes), out.Disagreement(), saleCount, out.Sale > 0)
	return out, true
}

func median(sorted []Quote) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return sorted[n/2].Price
	}
	return (sorted[n/2-1].Price + sorted[n/2].Price) / 2
}

// extremeDisagreement is the point where the markets are telling different
// stories about the same name: one quoted Northlight Illuminance at 7 RUB
// while another asked 239. No aggregate of those deserves to look solid.
const extremeDisagreement = 8

// grade turns source count, agreement and trade history into a label.
func grade(sources int, disagreement float64, saleCount int, hasSale bool) Confidence {
	switch {
	case sources == 0:
		return ConfidenceNone
	case disagreement > extremeDisagreement:
		return ConfidenceLow
	case hasSale && saleCount >= 3 && sources >= 2:
		return ConfidenceHigh
	case hasSale && sources >= 2 && disagreement <= 4:
		return ConfidenceHigh
	case hasSale:
		return ConfidenceMedium
	case sources >= 3 && disagreement <= 2:
		return ConfidenceHigh
	case sources >= 2 && disagreement <= 3:
		return ConfidenceMedium
	default:
		return ConfidenceLow
	}
}

// Size reports how many gems have at least one quote.
func (b *Book) Size() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.quotes)
}

// SourceCounts reports how many gems each source priced.
func (b *Book) SourceCounts() map[string]int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	out := make(map[string]int)
	for _, bySource := range b.quotes {
		for source := range bySource {
			out[source]++
		}
	}
	return out
}

// All returns every aggregated gem price, dearest first.
func (b *Book) All() []GemPrice {
	b.mu.RLock()
	names := make([]string, 0, len(b.quotes))
	for k := range b.quotes {
		names = append(names, k)
	}
	b.mu.RUnlock()

	out := make([]GemPrice, 0, len(names))
	for _, n := range names {
		if p, ok := b.Price(n); ok {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Median > out[j].Median })
	return out
}
