package apitoken

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeTokenStore struct {
	created Created
	items   []Metadata
	err     error
}

func (s *fakeTokenStore) Create(context.Context, string, Role) (Created, error) {
	return s.created, s.err
}
func (s *fakeTokenStore) List(context.Context) ([]Metadata, error) { return s.items, s.err }
func (s *fakeTokenStore) Revoke(context.Context, string) error     { return s.err }

func TestCreateInputBoundary(t *testing.T) {
	tests := []struct {
		name        string
		body        string
		contentType string
		origin      string
		fetchSite   string
		want        int
	}{
		{"valid", `{"name":"ci","role":"read-only-admin"}`, "application/json", "http://example.com", "same-origin", http.StatusCreated},
		{"unknown field", `{"name":"ci","role":"admin","extra":true}`, "application/json", "", "", http.StatusBadRequest},
		{"trailing json", `{"name":"ci","role":"admin"}{}`, "application/json", "", "", http.StatusBadRequest},
		{"invalid role", `{"name":"ci","role":"owner"}`, "application/json", "", "", http.StatusUnprocessableEntity},
		{"wrong content type", `{}`, "text/plain", "", "", http.StatusUnsupportedMediaType},
		{"cross origin", `{"name":"ci","role":"admin"}`, "application/json", "https://evil.example", "", http.StatusForbidden},
		{"cross site", `{"name":"ci","role":"admin"}`, "application/json", "", "cross-site", http.StatusForbidden},
	}
	handler := NewHTTPHandler(&fakeTokenStore{created: Created{Token: "once"}})
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "http://example.com/ui-api/v1/tokens", strings.NewReader(test.body))
			request.Header.Set("Content-Type", test.contentType)
			request.Header.Set("Origin", test.origin)
			request.Header.Set("Sec-Fetch-Site", test.fetchSite)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.want, response.Body.String())
			}
		})
	}
}

func TestUnavailableAndStoreFailure(t *testing.T) {
	for _, test := range []struct {
		name    string
		handler http.Handler
		want    int
	}{
		{"disabled", UnavailableHandler(), http.StatusServiceUnavailable},
		{"store error", NewHTTPHandler(&fakeTokenStore{err: errors.New("database secret")}), http.StatusServiceUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			test.handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ui-api/v1/tokens", nil))
			if response.Code != test.want || strings.Contains(response.Body.String(), "database secret") {
				t.Fatalf("response = %d %q", response.Code, response.Body.String())
			}
		})
	}
}

func TestRevokeValidatesIDAndIsIdempotentForMissingRecord(t *testing.T) {
	handler := NewHTTPHandler(&fakeTokenStore{})
	for _, test := range []struct {
		id   string
		want int
	}{{"invalid", http.StatusBadRequest}, {strings.Repeat("a", publicIDHexLength), http.StatusNoContent}} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodDelete, "/ui-api/v1/tokens/"+test.id, nil))
		if response.Code != test.want {
			t.Errorf("id %q status = %d, want %d", test.id, response.Code, test.want)
		}
	}
}
