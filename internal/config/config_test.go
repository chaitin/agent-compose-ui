package config

import "testing"

func TestLoadFromEnvTokenAndBackendOverrides(t *testing.T) {
	t.Setenv("TOKEN_DB_PATH", " /data/api/tokens.db ")
	t.Setenv("AGENT_COMPOSE_URL", " http://127.0.0.1:17410 ")
	t.Setenv("LISTEN_ADDR", " 127.0.0.1:18080 ")
	cfg := LoadFromEnv()
	if cfg.TokenDBPath != "/data/api/tokens.db" {
		t.Fatalf("TokenDBPath = %q", cfg.TokenDBPath)
	}
	if cfg.BackendURL != "http://127.0.0.1:17410" {
		t.Fatalf("BackendURL = %q", cfg.BackendURL)
	}
	if cfg.ListenAddr != "127.0.0.1:18080" {
		t.Fatalf("ListenAddr = %q", cfg.ListenAddr)
	}
}

func TestLoadFromEnvTokenFeatureDisabledByDefault(t *testing.T) {
	t.Setenv("TOKEN_DB_PATH", "")
	t.Setenv("AGENT_COMPOSE_URL", "")
	t.Setenv("LISTEN_ADDR", "")
	cfg := LoadFromEnv()
	if cfg.TokenDBPath != "" || cfg.BackendURL != DefaultBackendURL || cfg.ListenAddr != DefaultListenAddr {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}
