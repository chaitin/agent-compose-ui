package config

import (
	"os"
	"strconv"
	"strings"
)

const (
	DefaultListenAddr = "127.0.0.1:8080"
	DefaultBackendURL = "http://agent-compose:7410"
)

type Config struct {
	ListenAddr        string
	BackendURL        string
	TokenDBPath       string
	StateDBPath       string
	AuditRetentionDay int
}

func LoadFromEnv() Config {
	cfg := Config{
		ListenAddr:  envOrDefault("AGENT_COMPOSE_UI_LISTEN", DefaultListenAddr),
		BackendURL:  envOrDefault("AGENT_COMPOSE_BACKEND", DefaultBackendURL),
		TokenDBPath: strings.TrimSpace(os.Getenv("TOKEN_DB_PATH")),
	}
	cfg.StateDBPath = strings.TrimSpace(os.Getenv("UI_STATE_DB_PATH"))
	if cfg.StateDBPath == "" {
		cfg.StateDBPath = cfg.TokenDBPath
	}
	cfg.AuditRetentionDay = 180
	if raw := strings.TrimSpace(os.Getenv("AUDIT_RETENTION_DAYS")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value >= 1 && value <= 3650 {
			cfg.AuditRetentionDay = value
		}
	}
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
