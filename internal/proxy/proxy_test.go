package proxy

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestBackendProxyAddsDaemonBasicAuth(t *testing.T) {
	daemonAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("daemon-user:daemon-pass"))
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != daemonAuth {
			t.Fatalf("Authorization = %q, want %q", got, daemonAuth)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()

	backendURL, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatalf("parse backend URL: %v", err)
	}
	handler := NewBackendProxy(backendURL, BackendProxyOptions{AuthorizationHeader: daemonAuth})

	req := httptest.NewRequest(http.MethodPost, "/agentcompose.v1.SessionService/ListSessions", nil)
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("ui-user:ui-pass")))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
}
