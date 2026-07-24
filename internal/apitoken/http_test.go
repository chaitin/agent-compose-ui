package apitoken

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeTokenStore struct {
	created   Created
	err       error
	validFor  time.Duration
	listCalls int
}

func (s *fakeTokenStore) Create(_ context.Context, _ string, _ Role, validFor time.Duration) (Created, error) {
	s.validFor = validFor
	return s.created, s.err
}
func (s *fakeTokenStore) List(context.Context) ([]Metadata, error) {
	s.listCalls++
	return nil, s.err
}
func (s *fakeTokenStore) Revoke(context.Context, string) error { return s.err }

func TestCreateInputBoundary(t *testing.T) {
	tests := []struct {
		name, body, contentType, origin, fetchSite string
		want                                       int
	}{
		{"valid default", `{"name":"ci","role":"read-only-admin"}`, "application/json", "http://example.com", "same-origin", http.StatusCreated},
		{"valid one year", `{"name":"ci","role":"admin","expiresInDays":365}`, "application/json", "", "", http.StatusCreated},
		{"invalid validity", `{"name":"ci","role":"admin","expiresInDays":2}`, "application/json", "", "", http.StatusUnprocessableEntity},
		{"unknown field", `{"name":"ci","role":"admin","extra":true}`, "application/json", "", "", http.StatusBadRequest},
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

func TestCreateDefaultsValidityToNinetyDays(t *testing.T) {
	store := &fakeTokenStore{created: Created{Token: "once"}}
	request := httptest.NewRequest(http.MethodPost, "/ui-api/v1/tokens", strings.NewReader(`{"name":"ci","role":"admin"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	NewHTTPHandler(store).ServeHTTP(response, request)
	if response.Code != http.StatusCreated || store.validFor != 90*24*time.Hour {
		t.Fatalf("response = %d, validFor = %v", response.Code, store.validFor)
	}
}

func TestListRejectsCrossSiteRequests(t *testing.T) {
	for _, test := range []struct {
		name, origin, fetchSite string
	}{
		{"cross origin", "https://evil.example", ""},
		{"cross site", "", "cross-site"},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeTokenStore{}
			request := httptest.NewRequest(http.MethodGet, "http://example.com/ui-api/v1/tokens", nil)
			request.Header.Set("Origin", test.origin)
			request.Header.Set("Sec-Fetch-Site", test.fetchSite)
			response := httptest.NewRecorder()
			NewHTTPHandler(store).ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || store.listCalls != 0 {
				t.Fatalf("response = %d, list calls = %d", response.Code, store.listCalls)
			}
		})
	}
}

func TestUnavailableAndStoreFailure(t *testing.T) {
	for _, test := range []struct {
		name    string
		handler http.Handler
	}{{"disabled", UnavailableHandler()}, {"store error", NewHTTPHandler(&fakeTokenStore{err: errors.New("database secret")})}} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			test.handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ui-api/v1/tokens", nil))
			if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), "database secret") {
				t.Fatalf("response = %d %q", response.Code, response.Body.String())
			}
		})
	}
}
