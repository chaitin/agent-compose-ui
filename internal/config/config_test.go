package config

import "testing"

func TestLoadFromEnvTokenAndBackendOverrides(t *testing.T) {
	t.Setenv("AGENT_COMPOSE_UI_LISTEN", "")
	t.Setenv("AGENT_COMPOSE_BACKEND", "")
	t.Setenv("TOKEN_DB_PATH", " /data/api/tokens.db ")
	t.Setenv("UI_STATE_DB_PATH", "")
	t.Setenv("AUDIT_RETENTION_DAYS", "30")
	t.Setenv("AGENT_COMPOSE_URL", " http://127.0.0.1:17410 ")
	t.Setenv("LISTEN_ADDR", " 127.0.0.1:18080 ")
	cfg := LoadFromEnv()
	if cfg.TokenDBPath != "/data/api/tokens.db" {
		t.Fatalf("TokenDBPath = %q", cfg.TokenDBPath)
	}
	if cfg.StateDBPath != cfg.TokenDBPath || cfg.AuditRetentionDay != 30 {
		t.Fatalf("audit config = (%q, %d)", cfg.StateDBPath, cfg.AuditRetentionDay)
	}
	if cfg.BackendURL != "http://127.0.0.1:17410" {
		t.Fatalf("BackendURL = %q", cfg.BackendURL)
	}
	if cfg.ListenAddr != "127.0.0.1:18080" {
		t.Fatalf("ListenAddr = %q", cfg.ListenAddr)
	}
}

func TestLoadFromEnvTokenFeatureDisabledByDefault(t *testing.T) {
	t.Setenv("AGENT_COMPOSE_UI_LISTEN", "")
	t.Setenv("AGENT_COMPOSE_BACKEND", "")
	t.Setenv("TOKEN_DB_PATH", "")
	t.Setenv("UI_STATE_DB_PATH", "")
	t.Setenv("AUDIT_RETENTION_DAYS", "")
	t.Setenv("AGENT_COMPOSE_URL", "")
	t.Setenv("LISTEN_ADDR", "")
	cfg := LoadFromEnv()
	if cfg.TokenDBPath != "" || cfg.StateDBPath != "" || cfg.AuditRetentionDay != 180 || cfg.BackendURL != DefaultBackendURL || cfg.ListenAddr != DefaultListenAddr {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}

func TestLoadFromEnvDefaults(t *testing.T) {
	t.Setenv("AGENT_COMPOSE_UI_LISTEN", "")
	t.Setenv("AGENT_COMPOSE_BACKEND", "")
	t.Setenv("AGENT_COMPOSE_URL", "")
	t.Setenv("LISTEN_ADDR", "")
	t.Setenv("TOKEN_DB_PATH", "")
	t.Setenv("UI_STATE_DB_PATH", "")
	t.Setenv("AUDIT_RETENTION_DAYS", "")

	got := LoadFromEnv()
	if got.ListenAddr != DefaultListenAddr || got.BackendURL != DefaultBackendURL || got.AuditRetentionDay != 180 {
		t.Fatalf("LoadFromEnv() = %#v, want defaults", got)
	}
}

func TestLoadFromEnvOverrides(t *testing.T) {
	t.Setenv("AGENT_COMPOSE_UI_LISTEN", " 127.0.0.1:8081 ")
	t.Setenv("AGENT_COMPOSE_BACKEND", " http://127.0.0.1:7410 ")
	t.Setenv("AGENT_COMPOSE_URL", "")
	t.Setenv("LISTEN_ADDR", "")
	t.Setenv("TOKEN_DB_PATH", "")
	t.Setenv("UI_STATE_DB_PATH", " /data/ui/state.db ")
	t.Setenv("AUDIT_RETENTION_DAYS", "365")

	got := LoadFromEnv()
	if got.ListenAddr != "127.0.0.1:8081" || got.BackendURL != "http://127.0.0.1:7410" || got.StateDBPath != "/data/ui/state.db" || got.AuditRetentionDay != 365 {
		t.Fatalf("LoadFromEnv() = %#v, want environment overrides", got)
	}
}
