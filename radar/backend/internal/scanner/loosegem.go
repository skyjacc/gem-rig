package scanner

import "strings"

// gemPrefixes are the ways the markets spell a loose gem listing. The English
// column of the catalogue sometimes carries the Russian name, so both are
// checked against both columns.
var gemPrefixes = []string{"Kinetic:", "Кинетический:", "Кинетик:"}

// isLooseGem reports whether a market listing is the gem itself rather than an
// item that holds one. Buying a gem to extract a gem is pointless, so these
// never become findings — but their prices are exactly what values the gems.
func isLooseGem(names ...string) bool {
	for _, name := range names {
		trimmed := strings.TrimSpace(name)
		for _, p := range gemPrefixes {
			if strings.HasPrefix(trimmed, p) {
				return true
			}
		}
	}
	return false
}
