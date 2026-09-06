// Package steam talks to Valve's Economy API and interprets item sockets.
package steam

import (
	"regexp"
	"strings"
)

// SocketKind identifies the sprite Valve renders for a socket.
type SocketKind string

const (
	KindKinetic   SocketKind = "kinetic"   // gem_animation
	KindSpectator SocketKind = "spectator" // gem_spectator (Games Watched)
	KindEmpty     SocketKind = "empty"     // gem_stat_empty
	KindPrismatic SocketKind = "prismatic"
	KindEthereal  SocketKind = "ethereal"
	KindOther     SocketKind = "other"
)

// Socket is one physical socket reported by Valve, never a text description.
type Socket struct {
	Kind     SocketKind `json:"kind"`
	Sprite   string     `json:"sprite"`
	IconURL  string     `json:"icon_url"`
	Name     string     `json:"name"`
	Subtitle string     `json:"subtitle"`
}

// Empty reports whether the socket has nothing in it.
func (s Socket) Empty() bool {
	return s.Kind == KindEmpty || strings.EqualFold(s.Name, "Empty Socket")
}

var (
	// Each socket row is its own div with this exact inline style.
	socketRowSplit = regexp.MustCompile(`<div style="white-space: nowrap; padding: 3px;">`)
	// .../icons/econ/sockets/<sprite>.<sha1>.png
	spriteRe = regexp.MustCompile(`(https?://[^\s")]*/sockets/([a-z0-9_]+)\.[0-9a-f]+\.png)`)
	// The 18px span carries the gem name, the 12px span the subtitle.
	nameRe     = regexp.MustCompile(`(?s)<span style="font-size: 18px[^>]*>(.*?)</span>`)
	subtitleRe = regexp.MustCompile(`(?s)<span style="font-size: 12px[^>]*>(.*?)</span>`)
	tagRe      = regexp.MustCompile(`<[^>]+>`)
)

// ParseSockets extracts the physical sockets from one Steam description value.
//
// Only markup containing a real socket sprite counts. Plain-text lines such as
// a quoted "Kinetic: Fireborn Assault" line are cosmetic leftovers on old items
// and are deliberately ignored: sellers extract the real gem and the text stays.
func ParseSockets(descriptionHTML string) []Socket {
	if !strings.Contains(descriptionHTML, "/sockets/") {
		return nil
	}
	var out []Socket
	for _, chunk := range socketRowSplit.Split(descriptionHTML, -1) {
		m := spriteRe.FindStringSubmatch(chunk)
		if m == nil {
			continue
		}
		sprite := m[2]
		out = append(out, Socket{
			Kind:     kindFromSprite(sprite),
			Sprite:   sprite,
			IconURL:  m[1],
			Name:     firstGroupText(nameRe, chunk),
			Subtitle: firstGroupText(subtitleRe, chunk),
		})
	}
	return out
}

func kindFromSprite(sprite string) SocketKind {
	switch {
	case strings.Contains(sprite, "empty"):
		return KindEmpty
	case strings.Contains(sprite, "animation"):
		return KindKinetic
	case strings.Contains(sprite, "spectator"):
		return KindSpectator
	case strings.Contains(sprite, "prismatic"):
		return KindPrismatic
	case strings.Contains(sprite, "ethereal"):
		return KindEthereal
	default:
		return KindOther
	}
}

func firstGroupText(re *regexp.Regexp, s string) string {
	m := re.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	return strings.TrimSpace(tagRe.ReplaceAllString(m[1], ""))
}

// KineticGems returns the names of real, non-empty kinetic gems in an asset.
func KineticGems(sockets []Socket) []string {
	var names []string
	for _, s := range sockets {
		if s.Kind == KindKinetic && !s.Empty() && s.Name != "" {
			names = append(names, s.Name)
		}
	}
	return names
}

// EconImageURL turns a Steam icon_url hash into a CDN link.
// Valve serves the image at a size suffix; 96fx96f is the inventory tile size.
func EconImageURL(iconHash string) string {
	if iconHash == "" {
		return ""
	}
	return "https://community.cloudflare.steamstatic.com/economy/image/" + iconHash + "/96fx96f"
}
