package app

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"agent-compose-ui/internal/config"
)

func TestRunReturnsWhenContextIsAlreadyCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cfg := testConfig(mustURL(t, "http://127.0.0.1:1"))
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, cfg)
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Run did not return for canceled context")
	}
}

func TestRoutesOnlyExplicitUpstreamFamilies(t *testing.T) {
	received := make(chan string, 8)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	handler := New(testConfig(target))

	for _, path := range []string{
		"/agentcompose.v1.Service/Call",
		"/agentcompose.v2.Service/Call",
		"/health.v1.Health/Status",
		"/api/test",
		"/oauth/callback",
		"/agent-compose/session/abc",
		"/script-api/v1/health",
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNoContent {
			t.Errorf("%s status = %d", path, response.Code)
		}
		if got := <-received; got != path {
			t.Errorf("path = %q, want %q", got, path)
		}
	}

	for _, path := range []string{"/not-an-upstream", "/agentcompose.v3.Service/Call", "/api", "/script-api", "/api/auth/status/extra"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound {
			t.Errorf("%s status = %d", path, response.Code)
		}
	}
}

func TestAuthenticationRoutesArePublicAndDaemonIsProtected(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	cfg := testConfig(target)
	cfg.AuthMode = config.AuthPassword
	cfg.AuthPassword = "password"
	cfg.AuthSecret = "secret"
	handler := New(cfg)

	status := httptest.NewRecorder()
	handler.ServeHTTP(status, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	if status.Code != http.StatusOK {
		t.Fatalf("status endpoint = %d", status.Code)
	}

	protected := httptest.NewRecorder()
	handler.ServeHTTP(protected, httptest.NewRequest(http.MethodGet, "/agentcompose.v2.Service/Call", nil))
	if protected.Code != http.StatusUnauthorized || !strings.Contains(protected.Body.String(), "unauthorized") {
		t.Fatalf("protected response = %d %q", protected.Code, protected.Body.String())
	}
}

func TestAuthenticationRoutesRejectUnsupportedMethods(t *testing.T) {
	handler := New(testConfig(mustURL(t, "http://127.0.0.1:1")))
	tests := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/auth/status"},
		{http.MethodGet, "/api/auth/login"},
		{http.MethodGet, "/api/auth/logout"},
	}
	for _, test := range tests {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s %s status = %d", test.method, test.path, response.Code)
		}
	}
}

func TestScriptRouteReplacesClientToken(t *testing.T) {
	received := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		received <- r.Header.Get("X-Script-Service-Token")
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	handler := New(testConfig(target))
	request := httptest.NewRequest(http.MethodPost, "/script-api/v1/files", strings.NewReader("body"))
	request.Header.Set("X-Script-Service-Token", "client-token")
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if got := <-received; got != "server-token" {
		t.Fatalf("token = %q", got)
	}
}

func testConfig(target *url.URL) config.Config {
	return config.Config{
		ListenAddr:         "127.0.0.1:8080",
		AuthMode:           config.AuthDisabled,
		AuthUsername:       "admin",
		SessionTTL:         time.Hour,
		AgentComposeURL:    target,
		ScriptServiceURL:   target,
		ScriptServiceToken: "server-token",
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	value, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}
