package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"radar/internal/history"
)

// An unknown API path must say so. Serving the dashboard instead makes a
// missing endpoint answer 200 with HTML, which reads as "working" to anything
// that only checks the status code.
func TestUnknownAPIPathIs404NotTheDashboard(t *testing.T) {
	assets := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<!doctype html>")}}
	h := spaFallback(assets, http.FileServer(http.FS(assets)))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/does-not-exist", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "json") {
		t.Fatalf("an API answer must be JSON, got %q", ct)
	}
	if strings.Contains(rec.Body.String(), "doctype") {
		t.Fatal("the dashboard must never be served from an /api/ path")
	}
}

func TestClientRoutesStillFallBackToTheDashboard(t *testing.T) {
	assets := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<!doctype html>")}}
	h := spaFallback(assets, http.FileServer(http.FS(assets)))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/some/client/route", nil))

	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "doctype") {
		t.Fatalf("a page route should still load the app, got %d", rec.Code)
	}
}

// The offers table hands the popup a gem name with no "Kinetic:" prefix, while
// the history store recorded it with one. Asking for the stripped name must
// still find the series, or every chart in the popup looks like missing data.
func TestGemHistoryFoundByTheStrippedName(t *testing.T) {
	past := history.New(t.TempDir())
	past.AddGem("Kinetic: Wraith Spin", history.GemPoint{Median: 131, Low: 114, High: 174, Order: 102})
	past.AddGem("Kinetic: Wraith Spin", history.GemPoint{Median: 140, Low: 120, High: 180, Order: 110})
	s := &Server{History: past}

	rec := httptest.NewRecorder()
	s.handleHistory(rec, httptest.NewRequest(http.MethodGet, "/api/history?gem=Wraith+Spin", nil))

	var got struct {
		Gem    string             `json:"gem"`
		Points []history.GemPoint `json:"points"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Gem != "Kinetic: Wraith Spin" {
		t.Fatalf("expected the stored key back, got %q", got.Gem)
	}
	if len(got.Points) != 2 {
		t.Fatalf("expected both recorded points, got %d", len(got.Points))
	}
}

// A gem nobody has priced must come back empty rather than borrowing another
// gem's series.
func TestGemHistoryUnknownNameStaysEmpty(t *testing.T) {
	past := history.New(t.TempDir())
	past.AddGem("Kinetic: Wraith Spin", history.GemPoint{Median: 131})
	s := &Server{History: past}

	rec := httptest.NewRecorder()
	s.handleHistory(rec, httptest.NewRequest(http.MethodGet, "/api/history?gem=Nothing+Like+It", nil))

	var got struct {
		Points []history.GemPoint `json:"points"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Points) != 0 {
		t.Fatalf("expected no points, got %d", len(got.Points))
	}
}
