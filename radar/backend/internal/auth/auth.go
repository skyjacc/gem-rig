// Package auth closes the radar panel to everyone but its owner.
//
// Binding to 127.0.0.1 keeps the network out, but not a page open in the
// same browser: through DNS rebinding a foreign site gets a name that points
// at 127.0.0.1 and talks to the panel as if it were local. POST handlers here
// decode JSON regardless of content type, so any page could rewrite the price
// ceiling or the scan interval. Three layers, same as the rig panel:
//
//	Host    only our names: localhost, 127.0.0.1, ::1 and RADAR_ALLOWED_HOSTS
//	Origin  state-changing requests only from our own pages
//	token   every /api/* and /inspect carries the login cookie or a Bearer token
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const Cookie = "radar_auth"

// LoadToken returns RADAR_TOKEN, else the token stored in dir/panel.token,
// creating a random one on first run. created reports whether it was just made,
// so the caller prints the login link once instead of on every start.
func LoadToken(env func(string) string, dir string) (token string, created bool, err error) {
	if t := strings.TrimSpace(env("RADAR_TOKEN")); t != "" {
		return t, false, nil
	}
	file := filepath.Join(dir, "panel.token")
	if b, err := os.ReadFile(file); err == nil {
		if t := strings.TrimSpace(string(b)); len(t) >= 16 {
			return t, false, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", false, err
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", false, err
	}
	t := hex.EncodeToString(buf)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", false, err
	}
	if err := os.WriteFile(file, []byte(t+"\n"), 0o600); err != nil {
		return "", false, err
	}
	return t, true, nil
}

// AllowedHosts is the loopback set plus a comma-separated extra list.
func AllowedHosts(extra string) map[string]bool {
	out := map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}
	for _, h := range strings.Split(extra, ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			out[h] = true
		}
	}
	return out
}

// Hostname strips the port: "localhost:3377" → "localhost", "[::1]:3377" → "::1".
func Hostname(hostport string) string {
	h := strings.ToLower(strings.TrimSpace(hostport))
	if host, _, err := net.SplitHostPort(h); err == nil {
		return strings.Trim(host, "[]")
	}
	return strings.Trim(h, "[]")
}

func originOK(origin string, allowed map[string]bool) bool {
	if origin == "" {
		return true // not a browser; without the token it gets nowhere anyway
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	return allowed[strings.ToLower(u.Hostname())]
}

// Same reports whether two tokens match, in constant time.
func Same(a, b string) bool {
	if a == "" || len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func presented(r *http.Request) string {
	if c, err := r.Cookie(Cookie); err == nil && c.Value != "" {
		return c.Value
	}
	if h := r.Header.Get("Authorization"); len(h) > 7 && strings.EqualFold(h[:7], "Bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

func protected(path string) bool {
	return strings.HasPrefix(path, "/api/") || path == "/inspect" || strings.HasPrefix(path, "/inspect/")
}

func isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	p := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	return strings.EqualFold(p, "https")
}

func setCookie(w http.ResponseWriter, r *http.Request, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     Cookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   isHTTPS(r),
		MaxAge:   maxAge,
	})
}

func deny(w http.ResponseWriter, code int, why string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": why, "auth": code == http.StatusUnauthorized})
}

// Middleware wraps the whole panel. It also serves /api/auth (am I logged in),
// /api/login (GET ?token= from the startup link, POST {"token"} from the
// login screen) and /api/logout.
func Middleware(token string, allowed map[string]bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowed[Hostname(r.Host)] {
			deny(w, http.StatusForbidden, "чужое имя хоста")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !originOK(r.Header.Get("Origin"), allowed) {
			deny(w, http.StatusForbidden, "запрос с чужой страницы")
			return
		}

		switch r.URL.Path {
		case "/api/auth":
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(map[string]bool{"authed": Same(presented(r), token)})
			return
		case "/api/login":
			got := r.URL.Query().Get("token")
			if r.Method == http.MethodPost {
				var body struct {
					Token string `json:"token"`
				}
				_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)
				got = body.Token
			}
			if !Same(strings.TrimSpace(got), token) {
				deny(w, http.StatusUnauthorized, "токен не подходит")
				return
			}
			setCookie(w, r, token, 60*60*24*30)
			if r.Method == http.MethodPost {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				_, _ = w.Write([]byte(`{"ok":true}`))
				return
			}
			http.Redirect(w, r, "/", http.StatusFound)
			return
		case "/api/logout":
			if r.Method != http.MethodPost {
				deny(w, http.StatusMethodNotAllowed, "только POST")
				return
			}
			setCookie(w, r, "", -1)
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}

		if protected(r.URL.Path) && !Same(presented(r), token) {
			deny(w, http.StatusUnauthorized, "нужен вход")
			return
		}
		next.ServeHTTP(w, r)
	})
}
