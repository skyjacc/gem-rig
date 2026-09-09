package scanner

import (
	"encoding/json"
	"os"
	"testing"
)

// The fixtures are the marketplace's own answers, captured live, for the two
// Diffusal Lance variants at the centre of the incident this check came from:
//
//	gemmed — 200339871_1337149273, the variant that was paid for
//	empty  — 200339871_3361756675, the variant that actually arrived
//
// They are kept verbatim rather than hand-written because the markup is
// Valve's and the exact shape is the thing being parsed. An invented mock
// would only prove the mock matches the parser.
func marketFixture(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile("testdata/market_desc.json")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	var by map[string]string
	if err := json.Unmarshal(data, &by); err != nil {
		t.Fatalf("fixture: %v", err)
	}
	html, ok := by[name]
	if !ok {
		t.Fatalf("fixture %q missing", name)
	}
	return html
}

// The marketplace's description of the paid-for variant names the gem, so the
// two authorities agree and the lot may be offered.
func TestMarketConfirmsTheGemmedVariant(t *testing.T) {
	got := kineticNames(marketFixture(t, "gemmed"))
	if len(got) != 1 || got[0] != "Serene Honor" {
		t.Fatalf("expected exactly the kinetic gem, got %v", got)
	}
	p := SocketProof{Checked: true, SteamGems: []string{"Serene Honor"}, MarketGems: got, Agree: true}
	if !p.Trustworthy() {
		t.Fatal("both authorities agree; this is a real opportunity")
	}
}

// The variant that actually arrived carries no kinetic gem at all. Had it been
// listed under the gemmed variant's price, this is the comparison that refuses
// it.
func TestEmptyVariantYieldsNoGem(t *testing.T) {
	got := kineticNames(marketFixture(t, "empty"))
	if len(got) != 0 {
		t.Fatalf("an empty lance has no kinetic gem, got %v", got)
	}
	if sameGems([]string{"Serene Honor"}, got) {
		t.Fatal("Serene Honor and nothing must not compare equal")
	}
	p := SocketProof{Checked: true, SteamGems: []string{"Serene Honor"}, MarketGems: got}
	if p.Trustworthy() {
		t.Fatal("a lot the marketplace will not confirm must never be trustworthy")
	}
}

// A marketplace that could not be reached proves nothing either way. Treating
// silence as confirmation would reopen the hole at the first network blip.
func TestUnreachableMarketIsNotConfirmation(t *testing.T) {
	p := SocketProof{
		Checked:    true,
		SteamGems:  []string{"Serene Honor"},
		MarketGems: []string{"Serene Honor"},
		Agree:      true,
		Error:      "market /api/ItemInfo/: http 502",
	}
	if p.Trustworthy() {
		t.Fatal("a failed check is not a passed check")
	}
}

// A finding nobody has verified yet must not be offered as verified.
func TestUncheckedIsNotConfirmation(t *testing.T) {
	if (SocketProof{}).Trustworthy() {
		t.Fatal("an unchecked lot must not be trustworthy")
	}
}

// Order and case must not decide the verdict, but an extra gem must.
func TestComparisonIgnoresOrderAndCase(t *testing.T) {
	if !sameGems([]string{"Ambience of Reminiscence", "Serene Honor"},
		[]string{"ambience of reminiscence", "serene honor"}) {
		t.Fatal("the same gems must match regardless of case")
	}
	if sameGems([]string{"Serene Honor"}, []string{"Serene Honor", "Crow's Feet"}) {
		t.Fatal("an extra gem is a different set")
	}
}

// Language matters, and getting it wrong is worse than not checking at all.
//
// The marketplace answers /ru/ with a stale, generic description: for the very
// same gemmed variant it returns one "Пустое гнездо" and nothing else. Reading
// that as the lot's contents flags honest listings as fraudulent — which is
// how this check was nearly shipped. Every call asks for "en".
func TestVerificationAsksForEnglish(t *testing.T) {
	src, err := os.ReadFile("proof.go")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !contains(string(src), `ItemInfo(ctx, f.ClassID, f.InstanceID, "en")`) {
		t.Fatal("the marketplace must be asked in English; /ru/ returns a generic description")
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
