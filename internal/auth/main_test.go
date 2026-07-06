package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

func TestAuthStatusDisabled(t *testing.T) {
	auth := NewManagerFromEnv()
	handler := newTestApp(auth, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/auth/status", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d", rec.Code, http.StatusOK)
	}
	if body := rec.Body.String(); !strings.Contains(body, `"enabled":false`) || !strings.Contains(body, `"loggedIn":true`) {
		t.Fatalf("unexpected auth status body: %s", body)
	}
}

func TestAuthProtectsRPCAndAcceptsBasicAuth(t *testing.T) {
	t.Setenv("AUTH_USERNAME", "admin")
	t.Setenv("AUTH_PASSWORD", "secret")
	t.Setenv("AUTH_SECRET", "test-secret")

	auth := NewManagerFromEnv()
	handler := newTestApp(auth, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/agentcompose.v1.AgentService/ListAgents", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}

	req = httptest.NewRequest(http.MethodPost, "/agentcompose.v1.AgentService/ListAgents", nil)
	req.SetBasicAuth("admin", "secret")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("authenticated status = %d, want %d", rec.Code, http.StatusNoContent)
	}
}

func TestAuthAllowsWebhookIngress(t *testing.T) {
	t.Setenv("AUTH_PASSWORD", "secret")
	t.Setenv("AUTH_SECRET", "test-secret")

	auth := NewManagerFromEnv()
	handler := newTestApp(auth, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/webhooks/github", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("webhook status = %d, want %d", rec.Code, http.StatusAccepted)
	}
}

func newTestApp(auth *Manager, backend http.Handler) http.Handler {
	app := echo.New()
	app.GET("/api/auth/status", auth.HandleStatus)
	app.HEAD("/api/auth/status", auth.HandleStatus)
	app.POST("/api/auth/login", auth.HandleLogin)
	app.POST("/api/auth/logout", auth.HandleLogout)
	app.GET("/oauth/authorize", auth.HandleOAuthAuthorize)
	app.HEAD("/oauth/authorize", auth.HandleOAuthAuthorize)
	app.GET("/oauth/callback", auth.HandleOAuthCallback)
	app.HEAD("/oauth/callback", auth.HandleOAuthCallback)
	app.Any("/*", auth.Protect(echo.WrapHandler(backend)))
	return app
}
