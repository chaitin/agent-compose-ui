package app

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agent-compose-ui/internal/config"
	"agent-compose-ui/internal/sharedirs"
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
	handler := recoverHTTPPanics(routeHandler(http.NotFoundHandler(), http.NotFoundHandler(), panickingProxy, panickingProxy))
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

func TestHTTPBoundaryRecoversOrdinaryProxyPanicAsGenericJSON(t *testing.T) {
	panickingProxy := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("sensitive internal detail")
	})
	handler := recoverHTTPPanics(routeHandler(http.NotFoundHandler(), http.NotFoundHandler(), panickingProxy, panickingProxy))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/test", nil))

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusInternalServerError)
	}
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	if got := strings.TrimSpace(response.Body.String()); got != `{"error":"internal server error"}` {
		t.Fatalf("body = %q, want generic JSON error", got)
	}
}

func TestNewServerUsesConfiguredListenAddress(t *testing.T) {
	cfg := testConfig(mustURL(t, "http://127.0.0.1:1"))
	cfg.ListenAddr = "127.0.0.1:0"

	server := newServer(cfg, http.NotFoundHandler())

	if server.Addr != cfg.ListenAddr {
		t.Fatalf("server Addr = %q, want %q", server.Addr, cfg.ListenAddr)
	}
}

func TestRunReturnsWhenContextIsAlreadyCanceled(t *testing.T) {
	cfg := testConfig(mustURL(t, "http://127.0.0.1:1"))
	cfg.ListenAddr = "127.0.0.1:0"
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, cfg, nil)
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

func TestProjectStorageRoutesRequirePasswordSession(t *testing.T) {
	target, _ := url.Parse("http://127.0.0.1:1")
	cfg := testConfig(target)
	cfg.AuthMode = config.AuthPassword
	cfg.AuthPassword = "password"
	cfg.AuthSecret = "secret"
	cfg.ProjectStorageRoot = t.TempDir()
	handler := New(cfg)

	for _, path := range []string{"/api/project-storage/bind", "/api/local-workspace/ensure-dir"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`)))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d, want %d", path, response.Code, http.StatusUnauthorized)
		}
	}
}

func TestProjectFilesRoutePrecedesDaemonAndRequiresPasswordSession(t *testing.T) {
	proxied := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxied <- r.URL.Path
		w.WriteHeader(http.StatusTeapot)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	cfg := testConfig(target)
	cfg.AuthMode = config.AuthPassword
	cfg.AuthPassword = "password"
	cfg.AuthSecret = "secret"
	cfg.ProjectStorageRoot = t.TempDir()
	projectKey := "ws_0123456789abcdef0123456789abcdef"
	if err := os.Mkdir(filepath.Join(cfg.ProjectStorageRoot, projectKey), 0o750); err != nil {
		t.Fatal(err)
	}
	handler := New(cfg)
	endpoint := "/api/project-files/skills?projectKey=" + projectKey

	unauthenticated := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, endpoint, nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated = %d %s", unauthenticated.Code, unauthenticated.Body.String())
	}
	if unauthenticated.Header().Get("Cache-Control") != "no-store" || unauthenticated.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("unauthenticated security headers = %#v", unauthenticated.Header())
	}

	login := httptest.NewRecorder()
	handler.ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"password"}`)))
	cookie := login.Result().Cookies()[0]
	createReq := httptest.NewRequest(http.MethodPost, "/api/project-files/skills/create", strings.NewReader(`{"projectKey":"`+projectKey+`","name":"wired"}`))
	createReq.Header.Set("Content-Type", "application/json")
	createReq.AddCookie(cookie)
	created := httptest.NewRecorder()
	handler.ServeHTTP(created, createReq)
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	req := httptest.NewRequest(http.MethodGet, endpoint, nil)
	req.AddCookie(cookie)
	authenticated := httptest.NewRecorder()
	handler.ServeHTTP(authenticated, req)
	if authenticated.Code != http.StatusOK || !strings.Contains(authenticated.Body.String(), "wired") {
		t.Fatalf("authenticated = %d %s", authenticated.Code, authenticated.Body.String())
	}
	select {
	case got := <-proxied:
		t.Fatalf("project-files request was proxied to daemon: %s", got)
	default:
	}
}

func TestSharedDirectoriesRoutePrecedesDaemonAndRequiresPasswordSession(t *testing.T) {
	proxied := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxied <- r.URL.Path
		w.WriteHeader(http.StatusTeapot)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	cfg := testConfig(target)
	cfg.AuthMode, cfg.AuthPassword, cfg.AuthSecret = config.AuthPassword, "password", "secret"
	cfg.SharedDirectoryCatalog = []sharedirs.Entry{{ID: "reference", Name: "Reference", Path: "/shares/reference"}}
	handler := New(cfg)

	unauthenticated := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/shared-directories", nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated = %d %s", unauthenticated.Code, unauthenticated.Body.String())
	}
	if unauthenticated.Header().Get("Cache-Control") != "no-store" || unauthenticated.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("headers = %#v", unauthenticated.Header())
	}

	login := httptest.NewRecorder()
	handler.ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"password"}`)))
	req := httptest.NewRequest(http.MethodGet, "/api/shared-directories", nil)
	req.AddCookie(login.Result().Cookies()[0])
	authenticated := httptest.NewRecorder()
	handler.ServeHTTP(authenticated, req)
	if authenticated.Code != http.StatusOK || !strings.Contains(authenticated.Body.String(), `"id":"reference"`) {
		t.Fatalf("authenticated = %d %s", authenticated.Code, authenticated.Body.String())
	}
	select {
	case got := <-proxied:
		t.Fatalf("request was proxied: %s", got)
	default:
	}
}

func TestProgrammaticInvalidSharedDirectoryCatalogFailsHandlerConstruction(t *testing.T) {
	cfg := testConfig(mustURL(t, "http://127.0.0.1:1"))
	cfg.SharedDirectoryCatalog = []sharedirs.Entry{{ID: "unsafe", Name: "Unsafe", Path: "/data/private"}}
	if _, _, err := newHandlers(cfg, nil); err == nil {
		t.Fatal("newHandlers succeeded")
	}

	response := httptest.NewRecorder()
	New(cfg).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/shared-directories", nil))
	if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), "/data/private") {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
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

func TestVolumeFilesRoutePrecedesDaemonProxyAndFailsClosedWhenDisabled(t *testing.T) {
	called := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusTeapot)
	}))
	defer upstream.Close()
	h := New(testConfig(mustURL(t, upstream.URL)))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/volume-files?projectKey=ws_0123456789abcdef0123456789abcdef&volume=cache", nil))
	if rec.Code != http.StatusServiceUnavailable || called {
		t.Fatalf("response = %d, daemon called=%v, body=%q", rec.Code, called, rec.Body.String())
	}
}

func TestVolumeFilesServerUsesDaemonInspectorWithoutLeakingPath(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "cache")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "hello.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	const project = "ws_0123456789abcdef0123456789abcdef"
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agentcompose.v2.VolumeService/InspectVolume" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"volume":{"name":"cache","driver":"local","path":"`+root+`","labels":{"agent-compose-ui.managed":"true","agent-compose-ui.project-key":"`+project+`"}}}`)
	}))
	defer daemon.Close()
	cfg := testConfig(mustURL(t, daemon.URL))
	cfg.LocalVolumeRoot = parent
	h := New(cfg)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/volume-files?projectKey="+project+"&volume=cache", nil))
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), root) || !strings.Contains(rec.Body.String(), "hello.txt") {
		t.Fatalf("response = %d %q", rec.Code, rec.Body.String())
	}
}

func TestNewWithCleanupReleasesConfiguredStores(t *testing.T) {
	cfg := testConfig(mustURL(t, "http://127.0.0.1:1"))
	cfg.TokenDBPath = filepath.Join(t.TempDir(), "tokens.db")
	h, cleanup, err := NewWithCleanup(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if h == nil {
		t.Fatal("nil handler")
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	_, cleanup2, err := NewWithCleanup(cfg)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if err := cleanup2(); err != nil {
		t.Fatal(err)
	}
}

func TestNewReturnsExplicitlyCloseableHandler(t *testing.T) {
	h := New(testConfig(mustURL(t, "http://127.0.0.1:1")))
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
}

