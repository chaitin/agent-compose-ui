package app

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"agent-compose-ui/internal/config"
)

func TestServeDrainsInFlightRequestBeforeReturning(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusNoContent)
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- serve(ctx, &http.Server{Handler: handler}, listener)
	}()

	requestDone := make(chan error, 1)
	go func() {
		response, err := http.Get("http://" + listener.Addr().String())
		if err == nil {
			_ = response.Body.Close()
		}
		requestDone <- err
	}()
	<-started
	cancel()
	select {
	case err := <-done:
		t.Fatalf("serve returned before request drained: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	if err := <-requestDone; err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("serve returned %v", err)
	}
}

func TestServeReturnsShutdownTimeoutAfterForcingConnectionsClosed(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- serveWithShutdownTimeout(ctx, &http.Server{Handler: handler}, listener, 20*time.Millisecond)
	}()
	requestDone := make(chan error, 1)
	go func() {
		response, err := http.Get("http://" + listener.Addr().String())
		if err == nil {
			_ = response.Body.Close()
		}
		requestDone <- err
	}()
	<-started
	cancel()
	if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("serve returned %v, want shutdown deadline error", err)
	}
	close(release)
	<-requestDone
}

func TestProxyAbortPanicIsNotRecovered(t *testing.T) {
	panickingProxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusPartialContent)
		_, _ = io.WriteString(w, "partial")
		panic(http.ErrAbortHandler)
	})
	handler := routeHandler(http.NotFoundHandler(), panickingProxy, panickingProxy)
	response := httptest.NewRecorder()

	deferred := func() (recovered any) {
		defer func() { recovered = recover() }()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/test", nil))
		return nil
	}()
	if deferred != http.ErrAbortHandler {
		t.Fatalf("recovered = %v, want http.ErrAbortHandler", deferred)
	}
	if got := response.Body.String(); got != "partial" {
		t.Fatalf("body = %q, want partial response without JSON", got)
	}
}

func TestRunReturnsWhenContextIsAlreadyCanceled(t *testing.T) {
	listener, err := net.Listen("tcp", listenAddress)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cfg := testConfig(mustURL(t, "http://127.0.0.1:1"))
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, cfg)
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Run did not return for canceled context")
	}
}

func TestRoutesOnlyExplicitUpstreamFamilies(t *testing.T) {
	received := make(chan string, 8)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	handler := New(testConfig(target))

	for _, path := range []string{
		"/agentcompose.v1.Service/Call",
		"/agentcompose.v2.Service/Call",
		"/health.v1.Health/Status",
		"/api/test",
		"/oauth/callback",
		"/agent-compose/session/abc",
		"/jupyter",
		"/jupyter/lab/tree/notebook.ipynb",
		"/script-api/v1/health",
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNoContent {
			t.Errorf("%s status = %d", path, response.Code)
		}
		if got := <-received; got != path {
			t.Errorf("path = %q, want %q", got, path)
		}
	}

	for _, path := range []string{"/not-an-upstream", "/agentcompose.v3.Service/Call", "/api", "/script-api", "/api/auth", "/api/auth/status/extra", "/jupyterevil"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound {
			t.Errorf("%s status = %d", path, response.Code)
		}
	}
}

func TestJupyterRouteRequiresPasswordSessionAndProxiesAfterLogin(t *testing.T) {
	received := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	cfg := testConfig(target)
	cfg.AuthMode = config.AuthPassword
	cfg.AuthPassword = "password"
	cfg.AuthSecret = "secret"
	handler := New(cfg)

	unauthenticated := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/jupyter/lab", nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d", unauthenticated.Code, http.StatusUnauthorized)
	}

	login := httptest.NewRecorder()
	handler.ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"password"}`)))
	if login.Code != http.StatusOK || len(login.Result().Cookies()) != 1 {
		t.Fatalf("login response = %d, cookies = %#v", login.Code, login.Result().Cookies())
	}
	request := httptest.NewRequest(http.MethodGet, "/jupyter/lab", nil)
	request.AddCookie(login.Result().Cookies()[0])
	authenticated := httptest.NewRecorder()
	handler.ServeHTTP(authenticated, request)
	if authenticated.Code != http.StatusNoContent {
		t.Fatalf("authenticated status = %d, want %d", authenticated.Code, http.StatusNoContent)
	}
	if got := <-received; got != "/jupyter/lab" {
		t.Fatalf("proxied path = %q", got)
	}
}

func TestAuthenticationRoutesArePublicAndDaemonIsProtected(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	cfg := testConfig(target)
	cfg.AuthMode = config.AuthPassword
	cfg.AuthPassword = "password"
	cfg.AuthSecret = "secret"
	handler := New(cfg)

	status := httptest.NewRecorder()
	handler.ServeHTTP(status, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	if status.Code != http.StatusOK {
		t.Fatalf("status endpoint = %d", status.Code)
	}

	protected := httptest.NewRecorder()
	handler.ServeHTTP(protected, httptest.NewRequest(http.MethodGet, "/agentcompose.v2.Service/Call", nil))
	if protected.Code != http.StatusUnauthorized || !strings.Contains(protected.Body.String(), "unauthorized") {
		t.Fatalf("protected response = %d %q", protected.Code, protected.Body.String())
	}
}

func TestAuthenticationRoutesRejectUnsupportedMethods(t *testing.T) {
	handler := New(testConfig(mustURL(t, "http://127.0.0.1:1")))
	tests := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/auth/status"},
		{http.MethodGet, "/api/auth/login"},
		{http.MethodGet, "/api/auth/logout"},
	}
	for _, test := range tests {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s %s status = %d", test.method, test.path, response.Code)
		}
	}
}

func TestScriptRouteReplacesClientToken(t *testing.T) {
	received := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		received <- r.Header.Get("X-Script-Service-Token")
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	handler := New(testConfig(target))
	request := httptest.NewRequest(http.MethodPost, "/script-api/v1/files", strings.NewReader("body"))
	request.Header.Set("X-Script-Service-Token", "client-token")
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if got := <-received; got != "server-token" {
		t.Fatalf("token = %q", got)
	}
}

func testConfig(target *url.URL) config.Config {
	return config.Config{
		ListenAddr:         "127.0.0.1:8080",
		AuthMode:           config.AuthDisabled,
		AuthUsername:       "admin",
		SessionTTL:         time.Hour,
		AgentComposeURL:    target,
		ScriptServiceURL:   target,
		ScriptServiceToken: "server-token",
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	value, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}
