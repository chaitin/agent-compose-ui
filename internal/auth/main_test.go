package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"agent-compose-ui/internal/audit"

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

func TestDisabledAuthAllowsOnlyReadOnlyRequests(t *testing.T) {
	t.Setenv("AUTH_PASSWORD", "")
	t.Setenv("OAUTH_APIKEY", "")

	tests := []struct {
		name   string
		method string
		path   string
		want   int
	}{
		{"query rpc", http.MethodPost, "/agentcompose.v2.RunService/GetRun", http.StatusNoContent},
		{"stream query rpc", http.MethodPost, "/agentcompose.v2.ProjectService/StreamSchedulerRuns", http.StatusNoContent},
		{"health rpc", http.MethodPost, "/health.v1.HealthService/Status", http.StatusNoContent},
		{"rest query", http.MethodGet, "/api/events/event-1/trace", http.StatusNoContent},
		{"ui query", http.MethodGet, "/api/ui/v1/projects/project-1/yaml", http.StatusNoContent},
		{"run mutation", http.MethodPost, "/agentcompose.v2.RunService/RunAgent", http.StatusForbidden},
		{"settings mutation", http.MethodPost, "/agentcompose.v2.SettingsService/UpdateGlobalEnv", http.StatusForbidden},
		{"workspace upload", http.MethodPost, "/api/agent-compose/workspaces/workspace-1/upload", http.StatusForbidden},
		{"terminal websocket", http.MethodGet, "/api/terminal/attach", http.StatusForbidden},
		{"jupyter proxy", http.MethodGet, "/jupyter/sandbox-1/lab", http.StatusForbidden},
		{"legacy jupyter proxy", http.MethodGet, "/agent-compose/session/sandbox-1/lab", http.StatusForbidden},
		{"future api", http.MethodGet, "/api/future-query", http.StatusForbidden},
		{"future mutation", http.MethodPatch, "/future/write-api", http.StatusForbidden},
		{"webhook ingress", http.MethodPost, "/api/webhooks/webhook.github.push", http.StatusNoContent},
		{"webhook non-ingress method", http.MethodDelete, "/api/webhooks/webhook.github.push", http.StatusForbidden},
		{"runtime llm facade", http.MethodPost, "/api/runtime/sandboxes/sandbox-1/llm/openai/v1/responses", http.StatusNoContent},
		{"legacy runtime llm facade", http.MethodPost, "/api/runtime/sessions/sandbox-1/llm/openai/v1/responses", http.StatusNoContent},
		{"malformed runtime llm facade", http.MethodPost, "/api/runtime/sandboxes/sandbox-1/extra/llm/openai/v1/responses", http.StatusForbidden},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			called := false
			auth := NewManagerFromEnv()
			handler := newTestApp(auth, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(test.method, test.path, nil))

			if recorder.Code != test.want {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, test.want, recorder.Body.String())
			}
			if called != (test.want == http.StatusNoContent) {
				t.Fatalf("backend called = %t", called)
			}
			if test.want == http.StatusForbidden {
				if recorder.Header().Get("Cache-Control") != "no-store" || !strings.Contains(recorder.Body.String(), `"code":"permission_denied"`) {
					t.Fatalf("forbidden response headers=%v body=%s", recorder.Header(), recorder.Body.String())
				}
			}
		})
	}
}

func TestDisabledAuthAuditsDeniedOperation(t *testing.T) {
	t.Setenv("AUTH_PASSWORD", "")
	t.Setenv("OAUTH_APIKEY", "")
	store, err := audit.OpenStore(t.TempDir()+"/ui.db", 180)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	auth := NewManagerFromEnv(store)
	handler := newTestApp(auth, http.NotFoundHandler())
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/agentcompose.v2.RunService/RunAgent", nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusForbidden)
	}

	page, err := store.Query(t.Context(), audit.Filter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("audit items = %d, want 1", len(page.Items))
	}
	event := page.Items[0]
	if event.Actor.ID != "local:default" || event.Action != "access.denied" || event.Outcome != "denied" || event.Status != http.StatusForbidden {
		t.Fatalf("audit event = %#v", event)
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

func TestPasswordLoginReturnsStablePrincipal(t *testing.T) {
	t.Setenv("AUTH_USERNAME", "admin")
	t.Setenv("AUTH_PASSWORD", "secret")
	t.Setenv("AUTH_SECRET", "test-secret")
	auth := NewManagerFromEnv()
	handler := newTestApp(auth, http.NotFoundHandler())
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"secret"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"local:admin"`) || !strings.Contains(rec.Body.String(), `"source":"local"`) {
		t.Fatalf("response=%d %s", rec.Code, rec.Body.String())
	}
	cookie := rec.Result().Cookies()[0]
	req = httptest.NewRequest(http.MethodGet, "/api/auth/status", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"authMethod":"password"`) {
		t.Fatalf("status=%d %s", rec.Code, rec.Body.String())
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
