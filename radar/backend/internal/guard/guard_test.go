package guard

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"radar/internal/hub"
	"radar/internal/journal"
	"radar/internal/steam"
)

// stubTransport answers every Steam call with a canned body, or fails.
type stubTransport struct {
	body string
	fail error
}

func (t stubTransport) RoundTrip(*http.Request) (*http.Response, error) {
	if t.fail != nil {
		return nil, t.fail
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(bytes.NewBufferString(t.body)),
		Header:     make(http.Header),
	}, nil
}

func guardWith(t *testing.T, tr http.RoundTripper) *Guard {
	t.Helper()
	sc := steam.NewClient(func() string { return "TESTKEY-0123456789ABCDEF" })
	sc.HTTP = &http.Client{Transport: tr}
	return New(sc, nil, hub.New(), journal.New(50), func() string { return "TESTKEY-0123456789ABCDEF" })
}

func offerOf(classID, instanceID string) tradeOffer {
	return tradeOffer{
		TradeOfferID:    "555",
		AccountIDOther:  42,
		TradeOfferState: 2,
		ItemsToReceive: []tradeItem{
			{AssetID: "a1", ClassID: classID, InstanceID: instanceID},
		},
	}
}

// A Steam reply that does describe the item, with a kinetic gem in a socket.
const okSteamBody = `{"result":{"100_200":{"classid":"100","instanceid":"200",
 "market_hash_name":"Diffusal Lance","name":"Diffusal Lance","type":"Immortal",
 "descriptions":{"0":{"value":"<img src=\"https://x/sockets/gem_animation.abc.png\"> Kinetic: Serene Honor"}},
 "success":"1"},"success":"1"}}`

// The failure this guard exists to prevent: a green shield over an offer whose
// purchase list never loaded. Nothing was compared, so nothing may be blessed.
func TestUnreadablePurchaseListIsNeverAMatch(t *testing.T) {
	g := guardWith(t, stubTransport{body: okSteamBody})

	alert := g.evaluate(context.Background(), offerOf("100", "200"), nil, nil,
		errors.New("market: http 500"))

	if alert.Severity == SeverityOK {
		t.Fatal("an offer that was never compared must not be graded ok")
	}
	if alert.Severity != SeverityUnknown {
		t.Fatalf("expected the unknown verdict, got %q", alert.Severity)
	}
	if strings.Contains(alert.Headline, "Совпадает") {
		t.Fatalf("the headline claims a match that was never checked: %q", alert.Headline)
	}
	if alert.Checked.Purchases {
		t.Fatal("Checked.Purchases must record that the list was not read")
	}
	if len(alert.Checked.Blockers) == 0 {
		t.Fatal("the reason the check could not run must be stated")
	}
	for _, it := range alert.Items {
		if strings.Contains(it.Note, "не связан") {
			t.Fatalf("an item note asserts an unchecked fact: %q", it.Note)
		}
	}
}

// An empty gem list means two different things, and the panel printed the
// wrong one: "без кинетика" for an item Steam simply never described.
func TestUnreadSocketsAreNotReportedAsNoGem(t *testing.T) {
	g := guardWith(t, stubTransport{fail: errors.New("dial tcp: 429 slow down")})

	expected := map[string]map[string]string{"100": {"200": "Diffusal Lance"}}
	alert := g.evaluate(context.Background(), offerOf("100", "200"), nil, expected, nil)

	if len(alert.Items) != 1 {
		t.Fatalf("expected one item, got %d", len(alert.Items))
	}
	if alert.Items[0].SocketsRead {
		t.Fatal("SocketsRead must be false when Steam described nothing")
	}
	if alert.Checked.Sockets {
		t.Fatal("Checked.Sockets must record the failure")
	}
	if alert.Severity != SeverityUnknown {
		t.Fatalf("an offer whose sockets were never read cannot be ok, got %q", alert.Severity)
	}
}

// A transport failure must not carry the Steam key into an operator-facing
// detail line — these are read on screen and land in the journal.
func TestSteamFailureDetailCarriesNoKey(t *testing.T) {
	g := guardWith(t, stubTransport{fail: errors.New("boom")})

	alert := g.evaluate(context.Background(), offerOf("100", "200"), nil,
		map[string]map[string]string{"100": {"200": "x"}}, nil)

	joined := strings.Join(append(alert.Details, alert.Checked.Blockers...), " ")
	if strings.Contains(joined, "TESTKEY-0123456789ABCDEF") {
		t.Fatalf("the Steam key reached the alert: %s", joined)
	}
}

// A real swap outranks every softer verdict, even when other checks also failed.
func TestMismatchOutranksAnUnreadableSocket(t *testing.T) {
	g := guardWith(t, stubTransport{fail: errors.New("steam down")})

	// Paid for instanceid 999, sent 200.
	expected := map[string]map[string]string{"100": {"999": "Diffusal Lance"}}
	alert := g.evaluate(context.Background(), offerOf("100", "200"), nil, expected, nil)

	if alert.Severity != SeverityCritical {
		t.Fatalf("a swapped instanceid must stay critical, got %q", alert.Severity)
	}
	if !strings.Contains(alert.Headline, "не тот предмет") {
		t.Fatalf("unexpected headline %q", alert.Headline)
	}
}

// An item that matches nothing the account bought is not a clean pass either:
// the guard could compare, and the comparison found no purchase behind it.
func TestUnlinkedItemIsNotAGreenMatch(t *testing.T) {
	g := guardWith(t, stubTransport{body: okSteamBody})

	alert := g.evaluate(context.Background(), offerOf("100", "200"), nil,
		map[string]map[string]string{"777": {"888": "Something Else"}}, nil)

	if alert.Severity == SeverityOK {
		t.Fatal("an unlinked item must not read as a confirmed purchase")
	}
}

// The clean path still passes, or the guard is just an alarm that never stops.
func TestFullyVerifiedOfferMatches(t *testing.T) {
	g := guardWith(t, stubTransport{body: okSteamBody})

	expected := map[string]map[string]string{"100": {"200": "Diffusal Lance"}}
	alert := g.evaluate(context.Background(), offerOf("100", "200"), nil, expected, nil)

	if alert.Severity != SeverityOK {
		t.Fatalf("a fully checked matching offer should be ok, got %q (%s)", alert.Severity, alert.Headline)
	}
	if !alert.Checked.Purchases || !alert.Checked.Sockets {
		t.Fatalf("both checks ran, Checked must say so: %+v", alert.Checked)
	}
	if !alert.Items[0].SocketsRead {
		t.Fatal("SocketsRead must be true when Steam described the item")
	}
	if !alert.Items[0].Expected {
		t.Fatal("the item matched a purchase and must be marked expected")
	}
}

// A verdict has to survive in the journal, not only as a toast that scrolls by.
func TestVerdictReachesTheJournal(t *testing.T) {
	g := guardWith(t, stubTransport{body: okSteamBody})

	alert := g.evaluate(context.Background(), offerOf("100", "200"), nil, nil,
		errors.New("market: http 500"))
	g.noteVerdict(alert, false)

	events := g.audit.Events(journal.Query{Kind: journal.KindGuard})
	if len(events) != 1 {
		t.Fatalf("expected one guard entry, got %d", len(events))
	}
	e := events[0]
	if e.Level != journal.LevelWarn {
		t.Fatalf("an unverifiable offer should be recorded as a warning, got %q", e.Level)
	}
	if e.Fields["checked_purchases"] != false {
		t.Fatalf("the entry must record that purchases were unread: %v", e.Fields)
	}
}

// The swap that actually happened, replayed.
//
// Paid on market.dota2.net for 200339871_1337149273 — a Diffusal Lance whose
// variant carries Serene Honor, worth some 387 RUB in standing orders. The
// trade that arrived carried 200339871_3361756675: the same lance, one empty
// socket. The seller's public inventory held six empty lances, no copy of the
// paid-for variant, and twenty loose gems including that Serene Honor.
//
// Both listings are honest about their own variant. The lie is in the delivery,
// which is the only thing this guard can see — so it has to see it.
func TestTheRealSwapIsGradedCritical(t *testing.T) {
	g := guardWith(t, stubTransport{fail: errors.New("sockets not needed for this verdict")})

	paid := map[string]map[string]string{
		"200339871": {"1337149273": "Diffusal Lance"},
	}
	offer := tradeOffer{
		TradeOfferID:    "9355850214",
		AccountIDOther:  408316077,
		TradeOfferState: 2,
		ItemsToReceive: []tradeItem{
			{AssetID: "a1", ClassID: "200339871", InstanceID: "3361756675"},
		},
	}

	alert := g.evaluate(context.Background(), offer, nil, paid, nil)

	if alert.Severity != SeverityCritical {
		t.Fatalf("a swapped instanceid on a paid-for item must be critical, got %q (%s)",
			alert.Severity, alert.Headline)
	}
	if len(alert.Items) != 1 || alert.Items[0].Expected {
		t.Fatal("the delivered item must not be marked as expected")
	}
	joined := strings.Join(alert.Details, " ")
	if !strings.Contains(joined, "3361756675") || !strings.Contains(joined, "1337149273") {
		t.Fatalf("the alert must name both instanceids so the swap is checkable: %s", joined)
	}
	if !strings.Contains(alert.Headline, "не тот предмет") {
		t.Fatalf("unexpected headline %q", alert.Headline)
	}
}

// The honest delivery of the same purchase still passes.
func TestTheMatchingDeliveryIsAccepted(t *testing.T) {
	g := guardWith(t, stubTransport{body: okSteamBody})

	paid := map[string]map[string]string{"100": {"200": "Diffusal Lance"}}
	alert := g.evaluate(context.Background(), offerOf("100", "200"), nil, paid, nil)

	if alert.Severity != SeverityOK {
		t.Fatalf("the item that was paid for must pass, got %q (%s)", alert.Severity, alert.Headline)
	}
}
