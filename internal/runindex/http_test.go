package runindex

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestListsOnlyRunsWithoutSandboxAndContinuesCursor(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"runs":[{"runId":"run-1","sandboxId":"sandbox-1"},{"runId":"run-2","sandboxId":""},{"runId":"run-3"}],"total":3}`))
	}))
	defer backend.Close()
	parsed, _ := url.Parse(backend.URL)
	response := httptest.NewRecorder()
	New(parsed).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/ui/v1/runs/unlinked?limit=2", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"run-2"`) || !strings.Contains(response.Body.String(), `"run-3"`) || strings.Contains(response.Body.String(), `"run-1"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestRejectsInvalidPagination(t *testing.T) {
	backend, _ := url.Parse("http://127.0.0.1:1")
	response := httptest.NewRecorder()
	New(backend).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/ui/v1/runs/unlinked?limit=101", nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", response.Code)
	}
}
