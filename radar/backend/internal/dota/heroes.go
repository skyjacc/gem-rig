// Package dota holds static Dota 2 reference data used for presentation.
package dota

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed heroes.json
var heroesJSON []byte

// Hero is one playable hero, keyed by the id the market reports per item.
type Hero struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
}

var heroes map[string]Hero

func init() {
	if err := json.Unmarshal(heroesJSON, &heroes); err != nil {
		heroes = map[string]Hero{}
	}
}

// PortraitURL returns Valve's own hero portrait for a hero id.
// Item ids above the hero range (couriers, wards, bundles) have no portrait.
func PortraitURL(heroID string) (string, string) {
	h, ok := heroes[heroID]
	if !ok {
		return "", ""
	}
	return h.Name, fmt.Sprintf(
		"https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/%s.png", h.Slug)
}
