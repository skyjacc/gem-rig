package market

import (
	"os"
	"testing"
)

func TestParseItemDB(t *testing.T) {
	data, err := os.ReadFile("testdata/itemdb_sample.csv")
	if err != nil {
		t.Fatal(err)
	}
	lots, err := ParseItemDB(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(lots) == 0 {
		t.Fatal("no lots parsed")
	}

	var odachi *Lot
	for i := range lots {
		if lots[i].ClassID == "57939624" && lots[i].InstanceID == "1419123047" {
			odachi = &lots[i]
			break
		}
	}
	if odachi == nil {
		t.Fatal("Fireborn Odachi row missing")
	}
	// c_price is in kopeks: 10000 -> 100.00 RUB.
	if odachi.Price != 100 {
		t.Fatalf("price should be converted from kopeks, got %v", odachi.Price)
	}
	if odachi.NameEN != "Fireborn Odachi" {
		t.Fatalf("unexpected name %q", odachi.NameEN)
	}
	if odachi.Key() != "57939624_1419123047" {
		t.Fatalf("unexpected key %q", odachi.Key())
	}
}

func TestParseItemDBKeepsBaseRows(t *testing.T) {
	// Rows with instanceid 0 exist in the dump; the scanner filters them out
	// rather than the parser, so they must survive parsing.
	data, err := os.ReadFile("testdata/itemdb_sample.csv")
	if err != nil {
		t.Fatal(err)
	}
	lots, err := ParseItemDB(data)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, l := range lots {
		if l.InstanceID == "0" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected at least one base row with instanceid 0")
	}
}
