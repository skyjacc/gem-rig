package steam

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// A failing Steam call must not hand its API key to the caller.
//
// Steam takes the key in the query string, so Go's transport error prints the
// whole request URL. That text was surfaced on the dashboard, written to the
// journal and packed into the diagnostic bundle — a file meant to be shared.
func TestTransportFailureDoesNotLeakTheKey(t *testing.T) {
	const key = "A1B2C3D4E5F60718293A4B5C6D7E8F90"
	c := NewClient(func() string { return key })
	c.HTTP = &http.Client{
		Timeout: time.Second,
		Transport: &http.Transport{
			DialContext: func(context.Context, string, string) (net.Conn, error) {
				return nil, errors.New("dial tcp: network unreachable in test")
			},
		},
	}

	if _, err := c.fetchBatch(context.Background(), []AssetKey{{ClassID: "1", InstanceID: "2"}}); err == nil {
		t.Fatal("expected the batch call to fail")
	} else if strings.Contains(err.Error(), key) {
		t.Fatalf("the API key leaked into the error: %s", err)
	} else if !strings.Contains(err.Error(), "network unreachable") {
		t.Fatalf("the diagnosis must survive redaction: %s", err)
	}

	if _, _, err := c.DescriptionHTML(context.Background(), AssetKey{ClassID: "1", InstanceID: "2"}); err == nil {
		t.Fatal("expected the inspector call to fail")
	} else if strings.Contains(err.Error(), key) {
		t.Fatalf("the API key leaked into the inspector error: %s", err)
	}
}
