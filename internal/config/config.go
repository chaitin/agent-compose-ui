package config

import (
	"os"
	"strings"
)

const (
	DefaultListenAddr = "127.0.0.1:8080"
	DefaultBackendURL = "http://agent-compose:7410"
)

type Config struct {
	ListenAddr  string
	BackendURL  string
	TokenDBPath string
}

func LoadFromEnv() Config {
	cfg := Config{
		ListenAddr:  DefaultListenAddr,
		BackendURL:  DefaultBackendURL,
		TokenDBPath: strings.TrimSpace(os.Getenv("TOKEN_DB_PATH")),
	}
	if backendURL := strings.TrimSpace(os.Getenv("AGENT_COMPOSE_URL")); backendURL != "" {
		cfg.BackendURL = backendURL
	}
	return cfg
}
