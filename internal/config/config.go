package config

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
)

const (
	DefaultListenAddr  = "127.0.0.1:8080"
	DefaultBackendURL  = "http://agent-compose:7410"
	DefaultSandboxRoot = "/data/sandboxes"
)

type Config struct {
	ListenAddr        string
	BackendURL        string
	DatabasePath      string
	SandboxRoot       string
	AuditRetentionDay int
	SandboxTaskFields []SandboxTaskField
}

// SandboxTaskField names where a trigger payload carries the task a sandbox
// works on: dot-separated paths into the payload JSON for the task title and
// its link.
type SandboxTaskField struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

func LoadFromEnv() Config {
	cfg := Config{
		ListenAddr:   envOrDefault("AGENT_COMPOSE_UI_LISTEN", DefaultListenAddr),
		BackendURL:   envOrDefault("AGENT_COMPOSE_BACKEND", DefaultBackendURL),
		DatabasePath: strings.TrimSpace(os.Getenv("UI_DATABASE_PATH")),
		SandboxRoot:  envOrDefault("SANDBOX_ROOT", DefaultSandboxRoot),
	}
	cfg.AuditRetentionDay = 180
	if raw := strings.TrimSpace(os.Getenv("AUDIT_RETENTION_DAYS")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value >= 1 && value <= 3650 {
			cfg.AuditRetentionDay = value
		}
	}
	cfg.SandboxTaskFields = parseSandboxTaskFields(os.Getenv("SANDBOX_TASK_FIELDS"))
	if backendURL := strings.TrimSpace(os.Getenv("AGENT_COMPOSE_URL")); backendURL != "" {
		cfg.BackendURL = backendURL
	}
	if listenAddr := strings.TrimSpace(os.Getenv("LISTEN_ADDR")); listenAddr != "" {
		cfg.ListenAddr = listenAddr
	}
	return cfg
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

// parseSandboxTaskFields reads a JSON array such as
// [{"title":"payload.body.title","url":"payload.body.metadata.url"}].
// Entries without a title path are dropped; malformed input yields none.
func parseSandboxTaskFields(raw string) []SandboxTaskField {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var parsed []SandboxTaskField
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil
	}
	var fields []SandboxTaskField
	for _, field := range parsed {
		field.Title = strings.TrimSpace(field.Title)
		field.URL = strings.TrimSpace(field.URL)
		if field.Title != "" {
			fields = append(fields, field)
		}
	}
	return fields
}
