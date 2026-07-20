package config

import (
	"testing"
	"time"
)

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestLoadDefaultsToDisabledInternalMode(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"AGENT_COMPOSE_URL":    "http://agent-compose:7410",
		"SCRIPT_SERVICE_URL":   "http://scripts:7420",
		"SCRIPT_SERVICE_TOKEN": "token",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AuthMode != AuthDisabled || cfg.ListenAddr != "127.0.0.1:8080" || cfg.SessionTTL != 24*time.Hour {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}

func TestLoadPasswordModeRequiresSecrets(t *testing.T) {
	_, err := Load(env(map[string]string{
		"AUTH_MODE":            "password",
		"AUTH_PASSWORD":        "",
		"AUTH_SECRET":          "",
		"AGENT_COMPOSE_URL":    "http://agent-compose:7410",
		"SCRIPT_SERVICE_URL":   "http://scripts:7420",
		"SCRIPT_SERVICE_TOKEN": "token",
	}))
	if err == nil {
		t.Fatal("expected password configuration error")
	}
}

func TestLoadRejectsInvalidModeDurationAndUpstreams(t *testing.T) {
	cases := []map[string]string{
		{"AUTH_MODE": "other"},
		{"AUTH_SESSION_TTL": "zero"},
		{"AGENT_COMPOSE_URL": "://bad"},
		{"SCRIPT_SERVICE_URL": "://bad"},
		{"AGENT_COMPOSE_URL": "ftp://agent-compose:7410"},
		{"SCRIPT_SERVICE_URL": "unix://scripts"},
	}
	for _, values := range cases {
		values["SCRIPT_SERVICE_TOKEN"] = "token"
		if _, err := Load(env(values)); err == nil {
			t.Fatalf("expected error for %#v", values)
		}
	}
}
