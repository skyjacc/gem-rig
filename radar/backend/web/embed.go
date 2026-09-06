// Package web carries the built dashboard so the radar ships as one binary.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// Assets returns the built dashboard rooted at dist/.
// It returns nil when the frontend has not been built yet, in which case the
// server runs API-only.
func Assets() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return nil
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil
	}
	return sub
}
