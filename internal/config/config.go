package config

import (
	"encoding/base64"
	"log/slog"
	"os"
	"strings"
)

const (
	DefaultListenAddr = "127.0.0.1:8080"
	DefaultBackendURL = "http://agent-compose:7410"
)

type Config struct {
	ListenAddr                 string
	BackendURL                 string
	BackendAuthorizationHeader string
}

func LoadFromEnv() Config {
	return Config{
		ListenAddr:                 DefaultListenAddr,
		BackendURL:                 DefaultBackendURL,
		BackendAuthorizationHeader: loadHTTPBasicAuthHeader(),
	}
}

func loadHTTPBasicAuthHeader() string {
	raw := strings.TrimSpace(os.Getenv("HTTP_BASIC_AUTH"))
	if raw == "" {
		return ""
	}
	if _, err := base64.StdEncoding.DecodeString(raw); err != nil {
		slog.Warn("failed to decode HTTP_BASIC_AUTH", "error", err)
		return ""
	}
	return "Basic " + raw
}
