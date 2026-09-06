package dota

import (
	_ "embed"
	"encoding/json"
	"sort"
)

//go:embed kinetics.json
var kineticsJSON []byte

// Kinetic is one animation modifier as Valve defines it in items_game.txt.
type Kinetic struct {
	Code  string `json:"code"`
	Title string `json:"title"`
}

var kinetics map[string]Kinetic

func init() {
	if err := json.Unmarshal(kineticsJSON, &kinetics); err != nil {
		kinetics = map[string]Kinetic{}
	}
}

// KineticUniverse is every kinetic gem that exists in the game and has a
// market name. It is the honest denominator for coverage: a gem absent from
// this list cannot be found, and one present but unpriced simply is not on
// sale anywhere right now.
func KineticUniverse() []string {
	out := make([]string, 0, len(kinetics))
	for name := range kinetics {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// KnownKinetic reports whether a gem name is one Valve actually ships.
func KnownKinetic(marketName string) bool {
	_, ok := kinetics[marketName]
	return ok
}

// KineticCount is how many kinetic gems have a market name.
func KineticCount() int { return len(kinetics) }
