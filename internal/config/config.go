package config

import (
	"fmt"
	"net/url"
	"strings"
	"time"
)

type AuthMode string

const (
	AuthDisabled AuthMode = "disabled"
	AuthPassword AuthMode = "password"
)

type Config struct {
	ListenAddr, AuthUsername, AuthPassword, AuthSecret string
	AuthMode                                           AuthMode
	SessionTTL                                         time.Duration
	AgentComposeURL, ScriptServiceURL                  *url.URL
	ScriptServiceToken                                 string
}

func Load(getenv func(string) string) (Config, error) {
	cfg := Config{ListenAddr: "127.0.0.1:8080", AuthMode: AuthDisabled, AuthUsername: "admin", SessionTTL: 24 * time.Hour}
	if value := strings.TrimSpace(getenv("AUTH_MODE")); value != "" {
		cfg.AuthMode = AuthMode(value)
	}
	if value := strings.TrimSpace(getenv("AUTH_USERNAME")); value != "" {
		cfg.AuthUsername = value
	}
	cfg.AuthPassword, cfg.AuthSecret = getenv("AUTH_PASSWORD"), getenv("AUTH_SECRET")
	if cfg.AuthMode != AuthDisabled && cfg.AuthMode != AuthPassword {
		return Config{}, fmt.Errorf("AUTH_MODE must be disabled or password")
	}
	if cfg.AuthMode == AuthPassword && (cfg.AuthPassword == "" || cfg.AuthSecret == "") {
		return Config{}, fmt.Errorf("AUTH_PASSWORD and AUTH_SECRET are required in password mode")
	}
	if raw := strings.TrimSpace(getenv("AUTH_SESSION_TTL")); raw != "" {
		ttl, err := time.ParseDuration(raw)
		if err != nil || ttl <= 0 {
			return Config{}, fmt.Errorf("AUTH_SESSION_TTL must be a positive duration")
		}
		cfg.SessionTTL = ttl
	}
	parse := func(name, fallback string) (*url.URL, error) {
		raw := strings.TrimSpace(getenv(name))
		if raw == "" {
			raw = fallback
		}
		value, err := url.ParseRequestURI(raw)
		if err != nil || (value.Scheme != "http" && value.Scheme != "https") || value.Host == "" {
			return nil, fmt.Errorf("%s must be an absolute HTTP URL", name)
		}
		return value, nil
	}
	var err error
	if cfg.AgentComposeURL, err = parse("AGENT_COMPOSE_URL", "http://agent-compose:7410"); err != nil {
		return Config{}, err
	}
	if cfg.ScriptServiceURL, err = parse("SCRIPT_SERVICE_URL", "http://scripts:7420"); err != nil {
		return Config{}, err
	}
	cfg.ScriptServiceToken = getenv("SCRIPT_SERVICE_TOKEN")
	if cfg.ScriptServiceToken == "" {
		return Config{}, fmt.Errorf("SCRIPT_SERVICE_TOKEN is required")
	}
	return cfg, nil
}
