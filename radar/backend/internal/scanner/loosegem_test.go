package scanner

import "testing"

func TestIsLooseGemAcrossLanguages(t *testing.T) {
	if !isLooseGem("Kinetic: Serene Honor") {
		t.Fatal("English gem listing must be recognised")
	}
	// The catalogue's English column sometimes carries the Russian name.
	if !isLooseGem("Кинетический: Serene Honor") {
		t.Fatal("Russian gem listing must be recognised")
	}
	if !isLooseGem("", "Кинетический: Serene Honor") {
		t.Fatal("any of the supplied names may carry the prefix")
	}
	for _, host := range []string{"Diffusal Lance", "Inscribed Fireborn Odachi", ""} {
		if isLooseGem(host) {
			t.Fatalf("%q is a host item, not a gem listing", host)
		}
	}
}
