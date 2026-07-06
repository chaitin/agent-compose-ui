package config

import (
	"encoding/base64"
	"testing"
)

func TestLoadFromEnvDecodesHTTPBasicAuth(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("daemon-user:daemon-pass"))
	t.Setenv("HTTP_BASIC_AUTH", encoded)

	cfg := LoadFromEnv()
	if cfg.BackendAuthorizationHeader != "Basic "+encoded {
		t.Fatalf("BackendAuthorizationHeader = %q, want daemon basic auth header", cfg.BackendAuthorizationHeader)
	}
}

func TestLoadFromEnvIgnoresInvalidHTTPBasicAuth(t *testing.T) {
	t.Setenv("HTTP_BASIC_AUTH", "not-base64")

	cfg := LoadFromEnv()
	if cfg.BackendAuthorizationHeader != "" {
		t.Fatalf("BackendAuthorizationHeader = %q, want empty for invalid env", cfg.BackendAuthorizationHeader)
	}
}
