package config

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Config holds runtime settings and secrets for the radar.
type Config struct {
	Port int
	// KeysDir is the directory holding market.key / steam.key files.
	KeysDir string
	// SteamID64 of the account whose incoming trades the guard watches.
	SteamID64 string
	// AllowAutoDecline lets Trade Guard decline bad offers by itself.
	// Off by default: money-moving actions stay in the user's hands.
	AllowAutoDecline bool
	// AllowBuy enables the /api/buy endpoint. Off by default.
	AllowBuy bool

	mu         sync.RWMutex
	market     string
	steam      string
	dmarketPub string
	dmarketSec string
}

func Load() *Config {
	c := &Config{
		Port:      envInt("RADAR_PORT", 3377),
		KeysDir:   env("RADAR_KEYS_DIR", defaultKeysDir()),
		SteamID64: env("RADAR_STEAMID64", ""),
	}
	c.AllowAutoDecline = os.Getenv("RADAR_AUTO_DECLINE") == "1"
	c.AllowBuy = os.Getenv("RADAR_ALLOW_BUY") == "1"
	c.Reload()
	return c
}

// Reload re-reads the key files from disk.
func (c *Config) Reload() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.market = readKey(filepath.Join(c.KeysDir, "market.key"))
	c.steam = readKey(filepath.Join(c.KeysDir, "steam.key"))
	c.dmarketPub = readKey(filepath.Join(c.KeysDir, "dmarket.pub"))
	c.dmarketSec = readKey(filepath.Join(c.KeysDir, "dmarket.key"))
}

func (c *Config) MarketKey() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.market
}

func (c *Config) SteamKey() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.steam
}

// DMarketPublicKey is the hex key sent in the X-Api-Key header.
func (c *Config) DMarketPublicKey() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.dmarketPub
}

// DMarketSecretKey is the hex Ed25519 private key used to sign requests.
func (c *Config) DMarketSecretKey() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.dmarketSec
}

func readKey(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// defaultKeysDir points at the repo's tools/ directory when running from source.
func defaultKeysDir() string {
	candidates := []string{"tools", filepath.Join("..", "..", "tools"), "."}
	for _, dir := range candidates {
		if _, err := os.Stat(filepath.Join(dir, "market.key")); err == nil {
			if abs, err := filepath.Abs(dir); err == nil {
				return abs
			}
			return dir
		}
	}
	return "."
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n := 0
	for _, r := range v {
		if r < '0' || r > '9' {
			return def
		}
		n = n*10 + int(r-'0')
	}
	if n == 0 {
		return def
	}
	return n
}
