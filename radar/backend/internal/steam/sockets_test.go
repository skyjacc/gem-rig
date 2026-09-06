package steam

import (
	"encoding/json"
	"os"
	"testing"
)

func loadFixture(t *testing.T) map[string]Asset {
	t.Helper()
	b, err := os.ReadFile("testdata/assetclassinfo.json")
	if err != nil {
		t.Fatal(err)
	}
	var raw struct {
		Result map[string]json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	return DecodeAssets(raw.Result)
}

func TestRealKineticSocketIsDetected(t *testing.T) {
	assets := loadFixture(t)
	a, ok := assets["200339871_1337149273"]
	if !ok {
		t.Fatal("Diffusal Lance missing from fixture")
	}
	gems := a.KineticGems()
	if len(gems) != 1 || gems[0] != "Serene Honor" {
		t.Fatalf("expected [Serene Honor], got %v (sockets: %+v)", gems, a.Sockets)
	}
}

func TestTextOnlyKineticIsRejected(t *testing.T) {
	// Fireborn Odachi 507059515_3402339528 still carries the plain-text line
	// "Kinetic: Fireborn Assault", but the real gem was hammered out and only
	// a 5-rouble DK spectator gem plus empty sockets remain.
	assets := loadFixture(t)
	a, ok := assets["507059515_3402339528"]
	if !ok {
		t.Fatal("Fireborn Odachi missing from fixture")
	}
	if gems := a.KineticGems(); len(gems) != 0 {
		t.Fatalf("text-only description must not count as a gem, got %v", gems)
	}
	if len(a.Sockets) != 5 {
		t.Fatalf("expected 5 physical sockets, got %d", len(a.Sockets))
	}
	if a.Sockets[0].Kind != KindSpectator || a.Sockets[0].Name != "DK" {
		t.Fatalf("first socket should be the cheap DK spectator gem, got %+v", a.Sockets[0])
	}
	for _, s := range a.Sockets[1:] {
		if !s.Empty() {
			t.Fatalf("sockets 2-5 should be empty, got %+v", s)
		}
	}
}

func TestParseSocketsIgnoresPlainText(t *testing.T) {
	if got := ParseSockets(`''Kinetic: Fireborn Assault''`); got != nil {
		t.Fatalf("plain text must yield no sockets, got %v", got)
	}
}
