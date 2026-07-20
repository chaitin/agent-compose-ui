package auth

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"agent-compose-ui/internal/config"
)

func newTestManager(t *testing.T) *Manager {
	t.Helper()
	return New(config.Config{
		AuthMode:     config.AuthPassword,
		AuthUsername: "admin",
		AuthPassword: "correct",
		AuthSecret:   "test-secret",
		SessionTTL:   time.Hour,
	})
}

func TestPasswordLoginSetsSignedCookieAndUnlocksProtectedRoute(t *testing.T) {
	manager := newTestManager(t)
	login := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"correct"}`))
	recorder := httptest.NewRecorder()
	manager.Login(recorder, login)
	if recorder.Code != http.StatusOK || len(recorder.Result().Cookies()) != 1 {
		t.Fatalf("login response: %d, cookies: %#v", recorder.Code, recorder.Result().Cookies())
	}
	cookie := recorder.Result().Cookies()[0]
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" || cookie.Expires.IsZero() {
		t.Fatalf("cookie attributes: %#v", cookie)
	}

	protected := manager.Require(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	request := httptest.NewRequest(http.MethodGet, "/agentcompose.v2.ProjectService/ListProjects", nil)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	protected.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("protected response: %d", response.Code)
	}
}

func TestInvalidLoginIsUnauthorized(t *testing.T) {
	manager := newTestManager(t)
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"wrong"}`))
	response := httptest.NewRecorder()
	manager.Login(response, request)
	if response.Code != http.StatusUnauthorized || len(response.Result().Cookies()) != 0 {
		t.Fatalf("invalid login response: %d", response.Code)
	}
}

func TestLoginRequiresStrictJSONBody(t *testing.T) {
	manager := newTestManager(t)
	tests := map[string]string{
		"unknown field":  `{"username":"admin","password":"correct","extra":true}`,
		"trailing value": `{"username":"admin","password":"correct"}{}`,
		"malformed":      `{"username":`,
		"empty":          ``,
	}
	for name, body := range tests {
		t.Run(name, func(t *testing.T) {
			response := httptest.NewRecorder()
			manager.Login(response, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(body)))
			if response.Code != http.StatusBadRequest || len(response.Result().Cookies()) != 0 {
				t.Fatalf("response: %d, cookies: %#v", response.Code, response.Result().Cookies())
			}
			var payload map[string]string
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil || payload["error"] == "" {
				t.Fatalf("generic JSON error: body=%q err=%v", response.Body.String(), err)
			}
		})
	}
}

func TestTamperedAndExpiredCookiesAreUnauthorized(t *testing.T) {
	manager := newTestManager(t)
	protected := manager.Require(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	values := []string{
		manager.signedValue("admin", time.Now().Add(time.Hour)) + "changed",
		manager.signedValue("admin", time.Now().Add(-time.Hour)),
	}
	for _, value := range values {
		request := httptest.NewRequest(http.MethodGet, "/agentcompose.v2.ProjectService/ListProjects", nil)
		request.AddCookie(&http.Cookie{Name: cookieName, Value: value})
		response := httptest.NewRecorder()
		protected.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("unauthorized cookie response: %d", response.Code)
		}
	}
}

func TestDisabledModeAllowsRequestsAndReportsDisabled(t *testing.T) {
	manager := New(config.Config{AuthMode: config.AuthDisabled})
	protected := manager.Require(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	response := httptest.NewRecorder()
	protected.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/test", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("disabled response: %d", response.Code)
	}

	status := httptest.NewRecorder()
	manager.Status(status, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	if status.Code != http.StatusOK || strings.TrimSpace(status.Body.String()) != `{"enabled":false,"loggedIn":false}` {
		t.Fatalf("disabled status: %d %s", status.Code, status.Body.String())
	}
}

func TestStatusReportsSignedInSession(t *testing.T) {
	manager := newTestManager(t)
	expires := time.Now().Add(time.Hour).Truncate(time.Second)
	request := httptest.NewRequest(http.MethodGet, "/api/auth/status", nil)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: manager.signedValue("admin", expires)})
	response := httptest.NewRecorder()
	manager.Status(response, request)
	var status statusResponse
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.Enabled || !status.LoggedIn || status.Username != "admin" || status.ExpiresAt != expires.UTC().Format(time.RFC3339) {
		t.Fatalf("status: %#v", status)
	}
}

func TestCookieSecureForTLSOrHTTPSForward(t *testing.T) {
	manager := newTestManager(t)
	for _, setup := range []func(*http.Request){
		func(request *http.Request) { request.TLS = &tls.ConnectionState{} },
		func(request *http.Request) { request.Header.Set("X-Forwarded-Proto", "https") },
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"correct"}`))
		setup(request)
		response := httptest.NewRecorder()
		manager.Login(response, request)
		if cookies := response.Result().Cookies(); len(cookies) != 1 || !cookies[0].Secure {
			t.Fatalf("secure cookie: %#v", cookies)
		}
	}
}

func TestLogoutExpiresCookie(t *testing.T) {
	manager := newTestManager(t)
	response := httptest.NewRecorder()
	manager.Logout(response, httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil))
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || cookies[0].MaxAge >= 0 {
		t.Fatalf("logout cookies: %#v", cookies)
	}
}
