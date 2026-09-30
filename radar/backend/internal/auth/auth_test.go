package auth

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const tok = "0123456789abcdef0123456789abcdef"

func handler() http.Handler {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	return Middleware(tok, AllowedHosts("rig.tail.ts.net"), ok)
}

func do(t *testing.T, method, target string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var body *strings.Reader
	if method == http.MethodPost {
		body = strings.NewReader(`{"token":"` + hdr["_body"] + `"}`)
	} else {
		body = strings.NewReader("")
	}
	r := httptest.NewRequest(method, target, body)
	r.Host = "localhost:3377"
	for k, v := range hdr {
		switch k {
		case "_body":
		case "Host":
			r.Host = v
		default:
			r.Header.Set(k, v)
		}
	}
	w := httptest.NewRecorder()
	handler().ServeHTTP(w, r)
	return w
}

func TestAPIClosedWithoutToken(t *testing.T) {
	if c := do(t, "GET", "/api/status", nil).Code; c != 401 {
		t.Fatalf("want 401, got %d", c)
	}
	if c := do(t, "GET", "/inspect", nil).Code; c != 401 {
		t.Fatalf("/inspect must be closed too, got %d", c)
	}
}

func TestStaticOpen(t *testing.T) {
	if c := do(t, "GET", "/", nil).Code; c != 200 {
		t.Fatalf("static must stay open, got %d", c)
	}
}

func TestBearerAndCookie(t *testing.T) {
	if c := do(t, "GET", "/api/status", map[string]string{"Authorization": "Bearer " + tok}).Code; c != 200 {
		t.Fatalf("bearer: got %d", c)
	}
	if c := do(t, "GET", "/api/status", map[string]string{"Cookie": Cookie + "=" + tok}).Code; c != 200 {
		t.Fatalf("cookie: got %d", c)
	}
	if c := do(t, "GET", "/api/status", map[string]string{"Cookie": Cookie + "=nope"}).Code; c != 401 {
		t.Fatalf("wrong cookie: got %d", c)
	}
}

func TestForeignHostRejected(t *testing.T) {
	if c := do(t, "GET", "/", map[string]string{"Host": "evil.example"}).Code; c != 403 {
		t.Fatalf("want 403, got %d", c)
	}
	if c := do(t, "GET", "/", map[string]string{"Host": "rig.tail.ts.net"}).Code; c != 200 {
		t.Fatalf("allowed extra host: got %d", c)
	}
}

func TestCrossOriginPostRejectedEvenWithToken(t *testing.T) {
	w := do(t, "POST", "/api/settings", map[string]string{
		"Authorization": "Bearer " + tok, "Origin": "https://evil.example",
	})
	if w.Code != 403 {
		t.Fatalf("want 403, got %d", w.Code)
	}
}

func TestLoginSetsStrictCookie(t *testing.T) {
	w := do(t, "GET", "/api/login?token="+tok, nil)
	if w.Code != http.StatusFound {
		t.Fatalf("want redirect, got %d", w.Code)
	}
	c := w.Header().Get("Set-Cookie")
	if !strings.Contains(c, "HttpOnly") || !strings.Contains(c, "SameSite=Strict") {
		t.Fatalf("cookie flags: %s", c)
	}
	if do(t, "GET", "/api/login?token=bad", nil).Code != 401 {
		t.Fatal("bad token must not log in")
	}
	if do(t, "POST", "/api/login", map[string]string{"_body": tok, "Origin": "http://localhost:5174"}).Code != 200 {
		t.Fatal("POST login from own page must work")
	}
}

func TestLoadTokenCreatesOnce(t *testing.T) {
	dir := t.TempDir()
	noenv := func(string) string { return "" }
	first, created, err := LoadToken(noenv, dir)
	if err != nil || !created || len(first) < 32 {
		t.Fatalf("first: %q %v %v", first, created, err)
	}
	again, created, _ := LoadToken(noenv, dir)
	if created || again != first {
		t.Fatalf("second read must reuse the file")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "panel.token")); strings.TrimSpace(string(b)) != first {
		t.Fatal("file content")
	}
	env := func(k string) string {
		if k == "RADAR_TOKEN" {
			return "from-env"
		}
		return ""
	}
	if got, _, _ := LoadToken(env, dir); got != "from-env" {
		t.Fatalf("env must win, got %q", got)
	}
}

func TestHostname(t *testing.T) {
	for in, want := range map[string]string{"localhost:3377": "localhost", "[::1]:3377": "::1", "Rig.Tail.ts.net": "rig.tail.ts.net"} {
		if got := Hostname(in); got != want {
			t.Fatalf("%s: got %s want %s", in, got, want)
		}
	}
}
