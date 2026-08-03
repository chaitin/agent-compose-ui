package audit

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStoreLifecycleQueryAndCleanup(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "state.db"), 180)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	input := Input{Actor: Principal{ID: "local:admin", Source: "local", Username: "admin", DisplayName: "Admin", AuthMethod: "password"}, Category: "run", Action: "RunAgent", ResourceType: "project", ResourceID: "project-1", Method: http.MethodPost, Path: "/agentcompose.v2.RunService/RunAgent", Outcome: "success", Status: 200, Duration: 25 * time.Millisecond}
	if err := store.Record(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	page, err := store.Query(context.Background(), Filter{Actor: "local:admin", ResourceID: "project-1", Limit: 10})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("page=%#v err=%v", page, err)
	}
	if page.Items[0].Outcome != "success" || page.Items[0].DurationMs != 25 || page.Items[0].Actor.DisplayName != "Admin" {
		t.Fatalf("event=%#v", page.Items[0])
	}
	store.now = func() time.Time { return now.Add(181 * 24 * time.Hour) }
	if err := store.Cleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
	page, _ = store.Query(context.Background(), Filter{Limit: 10})
	if len(page.Items) != 0 {
		t.Fatalf("expired events=%d", len(page.Items))
	}
}

func TestMiddlewareExtractsConnectResourceWithoutSavingBody(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "state.db"), 180)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	middleware := NewMiddleware(store, nil)
	payload := append([]byte{0x0a, 0x09}, []byte("project-1")...)
	frame := append([]byte{0, 0, 0, 0, byte(len(payload))}, payload...)
	request := httptest.NewRequest(http.MethodPost, "/agentcompose.v2.RunService/RunAgent", strings.NewReader(string(frame)))
	request = request.WithContext(WithPrincipal(request.Context(), Principal{ID: "local:admin", Source: "local", Username: "admin"}))
	response := httptest.NewRecorder()
	middleware.Wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })).ServeHTTP(response, request)
	page, err := store.Query(context.Background(), Filter{Limit: 10})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("page=%#v err=%v", page, err)
	}
	if page.Items[0].ResourceType != "project" || page.Items[0].ResourceID != "project-1" {
		t.Fatalf("event=%#v", page.Items[0])
	}
}

func TestOperationClassificationAuditsWritesOnly(t *testing.T) {
	for _, path := range []string{
		"/agentcompose.v2.ProjectService/ValidateProject",
		"/agentcompose.v2.ProjectService/BatchGetLatestSchedulerRuns",
		"/agentcompose.v2.ProjectService/StreamSchedulerRuns",
	} {
		request := httptest.NewRequest(http.MethodPost, path, nil)
		if operation, ok := inspectOperation(request); ok {
			t.Fatalf("read operation %q classified as write: %#v", path, operation)
		}
	}

	payload := `{"token":"must-not-be-read","input":"must-not-be-read"}`
	request := httptest.NewRequest(http.MethodPost, "/api/webhooks/github", strings.NewReader(payload))
	operation, ok := inspectOperation(request)
	if !ok || operation.Category != "webhook" || operation.ResourceType != "webhook_source" || operation.ResourceID != "github" {
		t.Fatalf("webhook operation = %#v, audited = %v", operation, ok)
	}
	remaining, err := io.ReadAll(request.Body)
	if err != nil || string(remaining) != payload {
		t.Fatalf("webhook body was consumed: %q, err=%v", remaining, err)
	}

	secretLikeSpec := append([]byte{0x0a, 0x0c}, []byte("TOKEN=secret")...)
	resourceType, resourceID := connectResource("/agentcompose.v2.SandboxService/CreateSandbox", secretLikeSpec)
	if resourceType != "" || resourceID != "" {
		t.Fatalf("unapproved request field extracted as resource: %q %q", resourceType, resourceID)
	}
	if safeResourceID("TOKEN=secret") || !safeResourceID("sandbox-123") {
		t.Fatal("safe resource ID validation is too permissive or too restrictive")
	}
	request = httptest.NewRequest(http.MethodPut, "/api/webhook-sources/github", nil)
	operation, ok = inspectOperation(request)
	if !ok || operation.Category != "webhook" || operation.ResourceID != "github" {
		t.Fatalf("webhook source operation = %#v, audited = %v", operation, ok)
	}
}

func TestAuditHTTPListAndExport(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "state.db"), 180)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	_ = store.Record(context.Background(), Input{Actor: Principal{ID: "local:admin"}, Category: "token", Action: "token.create", Method: "POST", Path: "/api/ui/v1/tokens", Outcome: "success", Status: 201})
	handler := NewHTTPHandler(store)
	for _, path := range []string{"/api/ui/v1/audit/events?limit=10", "/api/ui/v1/audit/export?format=csv"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "token.create") {
			t.Fatalf("%s: %d %q", path, response.Code, response.Body.String())
		}
	}
}
