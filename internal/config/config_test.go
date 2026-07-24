package config

import "testing"

func TestLoadFromEnvTokenAndBackendOverrides(t *testing.T) {
	t.Setenv("TOKEN_DB_PATH", " /data/api/tokens.db ")
	t.Setenv("AGENT_COMPOSE_URL", " http://127.0.0.1:17410 ")
	cfg := LoadFromEnv()
	if cfg.TokenDBPath != "/data/api/tokens.db" {
		t.Fatalf("TokenDBPath = %q", cfg.TokenDBPath)
	}
	if cfg.BackendURL != "http://127.0.0.1:17410" {
		t.Fatalf("BackendURL = %q", cfg.BackendURL)
	}
}

func TestLoadFromEnvTokenFeatureDisabledByDefault(t *testing.T) {
	t.Setenv("TOKEN_DB_PATH", "")
	t.Setenv("AGENT_COMPOSE_URL", "")
	cfg := LoadFromEnv()
	if cfg.TokenDBPath != "" || cfg.BackendURL != DefaultBackendURL {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}
