package config

import "testing"

func TestLoadFromEnvDatabaseAndBackendOverrides(t *testing.T) {
	t.Setenv("AGENT_COMPOSE_UI_LISTEN", "")
	t.Setenv("AGENT_COMPOSE_BACKEND", "")
	t.Setenv("UI_DATABASE_PATH", " /data/agent-compose-ui.db ")
	t.Setenv("AUDIT_RETENTION_DAYS", "30")
	t.Setenv("AGENT_COMPOSE_URL", " http://127.0.0.1:17410 ")
	t.Setenv("LISTEN_ADDR", " 127.0.0.1:18080 ")
	cfg := LoadFromEnv()
	if cfg.DatabasePath != "/data/agent-compose-ui.db" || cfg.AuditRetentionDay != 30 {
		t.Fatalf("database config = (%q, %d)", cfg.DatabasePath, cfg.AuditRetentionDay)
	}
	if cfg.BackendURL != "http://127.0.0.1:17410" {
		t.Fatalf("BackendURL = %q", cfg.BackendURL)
	}
	if cfg.ListenAddr != "127.0.0.1:18080" {
		t.Fatalf("ListenAddr = %q", cfg.ListenAddr)
	}
}

func TestLoadFromEnvDatabaseFeaturesDisabledByDefault(t *testing.T) {
	t.Setenv("AGENT_COMPOSE_UI_LISTEN", "")
	t.Setenv("AGENT_COMPOSE_BACKEND", "")
	t.Setenv("UI_DATABASE_PATH", "")
	t.Setenv("AUDIT_RETENTION_DAYS", "")
	t.Setenv("AGENT_COMPOSE_URL", "")
	t.Setenv("LISTEN_ADDR", "")
	t.Setenv("SANDBOX_ROOT", "")
	cfg := LoadFromEnv()
	if cfg.DatabasePath != "" || cfg.AuditRetentionDay != 180 || cfg.BackendURL != DefaultBackendURL || cfg.ListenAddr != DefaultListenAddr {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}

func TestLoadFromEnvDefaults(t *testing.T) {
	t.Setenv("AGENT_COMPOSE_UI_LISTEN", "")
	t.Setenv("AGENT_COMPOSE_BACKEND", "")
	t.Setenv("AGENT_COMPOSE_URL", "")
	t.Setenv("LISTEN_ADDR", "")
	t.Setenv("UI_DATABASE_PATH", "")
	t.Setenv("AUDIT_RETENTION_DAYS", "")

	got := LoadFromEnv()
	if got.ListenAddr != DefaultListenAddr || got.BackendURL != DefaultBackendURL || got.SandboxRoot != DefaultSandboxRoot || got.AuditRetentionDay != 180 {
		t.Fatalf("LoadFromEnv() = %#v, want defaults", got)
	}
}

func TestLoadFromEnvOverrides(t *testing.T) {
	t.Setenv("AGENT_COMPOSE_UI_LISTEN", " 127.0.0.1:8081 ")
	t.Setenv("AGENT_COMPOSE_BACKEND", " http://127.0.0.1:7410 ")
	t.Setenv("AGENT_COMPOSE_URL", "")
	t.Setenv("LISTEN_ADDR", "")
	t.Setenv("UI_DATABASE_PATH", " /data/agent-compose-ui.db ")
	t.Setenv("AUDIT_RETENTION_DAYS", "365")
	t.Setenv("SANDBOX_ROOT", " /mnt/agent-compose/sandboxes ")

	got := LoadFromEnv()
	if got.ListenAddr != "127.0.0.1:8081" || got.BackendURL != "http://127.0.0.1:7410" || got.DatabasePath != "/data/agent-compose-ui.db" || got.SandboxRoot != "/mnt/agent-compose/sandboxes" || got.AuditRetentionDay != 365 {
		t.Fatalf("LoadFromEnv() = %#v, want environment overrides", got)
	}
}
