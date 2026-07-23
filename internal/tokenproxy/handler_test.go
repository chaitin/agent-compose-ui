package tokenproxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"agent-compose-ui/internal/apitoken"
)

type staticAuthenticator struct {
	identity apitoken.Identity
	err      error
}

func (a staticAuthenticator) Authenticate(context.Context, string) (apitoken.Identity, error) {
	return a.identity, a.err
}

func TestAdminAllowsAnyPathAndSanitizesCredentials(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, name := range []string{"Authorization", "Cookie", "Proxy-Authorization", "Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP"} {
			if value := r.Header.Get(name); value != "" {
				t.Errorf("%s reached upstream: %q", name, value)
			}
		}
		w.WriteHeader(http.StatusNoContent)
	})
	handler := New(staticAuthenticator{identity: apitoken.Identity{ID: "id", Role: apitoken.RoleAdmin}}, upstream, nil)
	request := httptest.NewRequest(http.MethodPatch, "/future/api", nil)
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Cookie", "session=secret")
	request.Header.Set("Forwarded", "for=client")
	request.Header.Set("X-Forwarded-For", "client")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestReadOnlyPolicy(t *testing.T) {
	tests := []struct {
		method string
		path   string
		want   int
	}{
		{http.MethodPost, "/agentcompose.v2.RunService/GetRun", http.StatusNoContent},
		{http.MethodPost, "/agentcompose.v2.RunService/ListRuns", http.StatusNoContent},
		{http.MethodPost, "/agentcompose.v2.RunService/FollowRunLogs", http.StatusNoContent},
		{http.MethodPost, "/agentcompose.v2.RunService/ListRunEvents", http.StatusNoContent},
		{http.MethodPost, "/agentcompose.v2.RunService/ListSandboxRunEvents", http.StatusNoContent},
		{http.MethodPost, "/agentcompose.v2.ProjectService/ListProjectSchedulerEvents", http.StatusNoContent},
		{http.MethodPost, "/agentcompose.v2.ProjectService/InvokeScheduler", http.StatusForbidden},
		{http.MethodPost, "/agentcompose.v2.ProjectService/RunScheduler", http.StatusForbidden},
		{http.MethodPost, "/agentcompose.v2.ProjectService/StartSchedulerRun", http.StatusForbidden},
		{http.MethodPost, "/agentcompose.v2.ProjectService/StopSchedulerRun", http.StatusForbidden},
		{http.MethodPost, "/agentcompose.v2.RunService/Run", http.StatusForbidden},
		{http.MethodGet, "/api/events/run-id/runs", http.StatusNoContent},
		{http.MethodDelete, "/api/events/run-id", http.StatusForbidden},
		{http.MethodGet, "/unknown", http.StatusForbidden},
	}
	for _, test := range tests {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			handler := New(staticAuthenticator{identity: apitoken.Identity{Role: apitoken.RoleReadOnlyAdmin}}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }), nil)
			request := httptest.NewRequest(test.method, test.path, nil)
			request.Header.Set("Authorization", "Bearer token")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.want, response.Body.String())
			}
		})
	}
}

func TestAuthenticationAndUnavailableErrors(t *testing.T) {
	tests := []struct {
		name    string
		handler http.Handler
		header  string
		want    int
	}{
		{"missing", New(staticAuthenticator{}, http.NotFoundHandler(), nil), "", http.StatusUnauthorized},
		{"invalid", New(staticAuthenticator{err: apitoken.ErrInvalidToken}, http.NotFoundHandler(), nil), "Bearer bad", http.StatusUnauthorized},
		{"disabled", UnavailableHandler(), "Bearer anything", http.StatusServiceUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/version", nil)
			request.Header.Set("Authorization", test.header)
			response := httptest.NewRecorder()
			test.handler.ServeHTTP(response, request)
			if response.Code != test.want || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("response = %d, cache-control %q", response.Code, response.Header().Get("Cache-Control"))
			}
		})
	}
}
