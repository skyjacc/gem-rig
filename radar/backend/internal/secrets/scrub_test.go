package secrets

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"testing"
)

const fakeKey = "A1B2C3D4E5F60718293A4B5C6D7E8F90"

// The exact shape that leaked: Go prints the whole request URL when the
// transport fails, and Steam's key lives in the query string.
func TestTransportErrorLosesTheKey(t *testing.T) {
	raw := &url.Error{
		Op:  "Get",
		URL: "https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v0001?appid=570&key=" + fakeKey,
		Err: errors.New("dial tcp: lookup api.steampowered.com: no such host"),
	}
	r := Static(fakeKey)

	got := r.Error(raw)
	if got == nil {
		t.Fatal("a non-nil error must stay non-nil")
	}
	if contains(got.Error(), fakeKey) {
		t.Fatalf("the key survived redaction: %s", got.Error())
	}
	if !contains(got.Error(), Marker) {
		t.Fatalf("a removal must be visible, got %q", got.Error())
	}
	if !contains(got.Error(), "no such host") {
		t.Fatalf("the diagnosis must survive, got %q", got.Error())
	}
}

// The sweep decides whether to keep going by asking errors.Is about
// cancellation, so redaction must not sever the chain.
func TestRedactionKeepsErrorsIs(t *testing.T) {
	wrapped := fmt.Errorf("calling steam with key=%s: %w", fakeKey, context.Canceled)
	got := Static(fakeKey).Error(wrapped)

	if contains(got.Error(), fakeKey) {
		t.Fatalf("the key survived: %s", got.Error())
	}
	if !errors.Is(got, context.Canceled) {
		t.Fatal("cancellation must still be recognisable after redaction")
	}
}

// A missing key is the normal state before the operator configures one. Its
// empty value must not turn every message into markers.
func TestEmptyAndShortSecretsAreIgnored(t *testing.T) {
	r := Static("", "x", "ab")
	const msg = "steam: http 429 rate limited"
	if got := r.String(msg); got != msg {
		t.Fatalf("short secrets must not be scrubbed, got %q", got)
	}
}

func TestNilErrorStaysNil(t *testing.T) {
	if got := Static(fakeKey).Error(nil); got != nil {
		t.Fatalf("expected nil, got %v", got)
	}
}

// Several keys are in play at once — market, steam, dmarket — and one call can
// mention more than one of them.
func TestEveryKnownSecretIsRemoved(t *testing.T) {
	const other = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"
	r := Static(fakeKey, other)
	got := r.String("key=" + fakeKey + " and token=" + other)
	if contains(got, fakeKey) || contains(got, other) {
		t.Fatalf("a secret survived: %s", got)
	}
}

// A redactor reads its secrets through functions so a key re-read from disk
// mid-run is still redacted afterwards.
func TestSecretsAreReadLive(t *testing.T) {
	current := ""
	r := New(func() string { return current })
	current = fakeKey
	if got := r.String("key=" + fakeKey); contains(got, fakeKey) {
		t.Fatalf("a key set after construction must still be scrubbed: %s", got)
	}
}

func contains(haystack, needle string) bool {
	return needle != "" && len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
