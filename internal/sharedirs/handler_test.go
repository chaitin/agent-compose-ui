package sharedirs

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerReturnsCatalogAndSecurityHeaders(t *testing.T) {
	h, err := NewHandler([]Entry{{ID: "reference", Name: "Reference", Path: "/shares/reference"}})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/shared-directories", nil))
	if w.Code != http.StatusOK || w.Body.String() != `{"entries":[{"id":"reference","name":"Reference","path":"/shares/reference","writable":false}]}`+"\n" {
		t.Fatalf("response = %d %q", w.Code, w.Body.String())
	}
	if w.Header().Get("Content-Type") != "application/json" || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("headers = %#v", w.Header())
	}
}

func TestHandlerEmptyCatalog(t *testing.T) {
	h, err := NewHandler(nil)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/shared-directories", nil))
	if w.Body.String() != `{"entries":[]}`+"\n" {
		t.Fatalf("body = %q", w.Body.String())
	}
}

func TestHandlerRejectsMethodsAndQueries(t *testing.T) {
	h, err := NewHandler(nil)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/shared-directories", nil))
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("method = %d, Allow %q", w.Code, w.Header().Get("Allow"))
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/shared-directories?x=1", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("query = %d", w.Code)
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/shared-directories?", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bare query marker = %d", w.Code)
	}
}

func TestHandlerDefensivelyCopiesEntries(t *testing.T) {
	entries := []Entry{{ID: "a", Name: "A", Path: "/shares/a"}}
	h, err := NewHandler(entries)
	if err != nil {
		t.Fatal(err)
	}
	entries[0].Name = "mutated"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/shared-directories", nil))
	if w.Body.String() != `{"entries":[{"id":"a","name":"A","path":"/shares/a","writable":false}]}`+"\n" {
		t.Fatalf("body = %q", w.Body.String())
	}
}

func TestNewHandlerRejectsInvalidProgrammaticCatalog(t *testing.T) {
	tests := map[string][]Entry{
		"restricted path":  {{ID: "a", Name: "A", Path: "/data/private"}},
		"duplicate id":     {{ID: "a", Name: "A", Path: "/shares/a"}, {ID: "a", Name: "B", Path: "/shares/b"}},
		"duplicate path":   {{ID: "a", Name: "A", Path: "/shares/private"}, {ID: "b", Name: "B", Path: "/shares/private"}},
		"format character": {{ID: "a", Name: "A\u2066", Path: "/shares/a"}},
	}
	for name, entries := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := NewHandler(entries); err == nil {
				t.Fatal("NewHandler succeeded")
			}
		})
	}
}

func TestNewHandlerValidationErrorDoesNotExposeConfiguredValues(t *testing.T) {
	secretName, secretPath := "Customer\u202eSecret", "/shares/customer\u200b-secret"
	_, err := NewHandler([]Entry{{ID: "secret", Name: secretName, Path: secretPath}})
	if err == nil {
		t.Fatal("NewHandler succeeded")
	}
	if strings.Contains(err.Error(), secretName) || strings.Contains(err.Error(), secretPath) {
		t.Fatalf("error exposes configured value: %q", err)
	}
}
