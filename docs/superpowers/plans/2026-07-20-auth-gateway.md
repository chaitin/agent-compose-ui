# Agent Compose UI Authentication Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional username/password Go authentication gateway that is built and deployed with `agent-compose-ui`, protects daemon and script-service traffic, and requires no changes to the `agent-compose` daemon.

**Architecture:** nginx continues to serve the SPA, but forwards every backend-facing path to a loopback-only Go process in the same UI container. The Go process owns login, signed Cookie validation, route authorization, daemon proxying, and script-service token injection. `AUTH_MODE=disabled` supports the company-internal shared test environment; `AUTH_MODE=password` enables authentication.

**Tech Stack:** Go standard library (`net/http`, `httputil`, `crypto/hmac`), Svelte 5, TypeScript, ConnectRPC Web, Vitest, Bun tests, nginx, Docker Compose.

## Global Constraints

- All new Go code lives in `agent-compose-ui`; do not modify `../agent-compose` or any daemon API.
- The existing `web` image remains the deployment unit; do not add a separately deployed application backend.
- Protect daemon RPC/REST/session/Jupyter paths and `/script-api/*` in password mode.
- `AUTH_MODE=disabled` remains the documented company-internal test mode and the compatibility default.
- `AUTH_MODE=password` requires non-empty `AUTH_PASSWORD` and `AUTH_SECRET`; never generate a transient signing secret.
- The gateway must never log passwords, Cookies, authorization headers, request bodies, script tokens, or environment-variable values.
- `/script-api/*` must replace any browser-supplied script token with the server-side `SCRIPT_SERVICE_TOKEN`.
- Preserve ConnectRPC streaming and request cancellation; do not impose a whole-request timeout on proxied streams.
- Use test-driven development and make only focused commits that exclude the existing user-owned `package-lock.json` change and `old/` directory.

---

### Task 1: Go module and validated gateway configuration

**Files:**
- Create: `go.mod`
- Create: `internal/config/config.go`
- Create: `internal/config/config_test.go`

**Interfaces:**
- Produces: `config.Load(getenv func(string) string) (config.Config, error)`
- Produces: `config.Config` fields `ListenAddr`, `AuthMode`, `AuthUsername`, `AuthPassword`, `AuthSecret`, `SessionTTL`, `AgentComposeURL`, `ScriptServiceURL`, and `ScriptServiceToken`
- Consumes: environment values supplied by the UI container or development command

- [ ] **Step 1: Add the minimal Go module and failing configuration tests**

```go
// internal/config/config_test.go
package config

import (
    "testing"
    "time"
)

func env(values map[string]string) func(string) string {
    return func(key string) string { return values[key] }
}

func TestLoadDefaultsToDisabledInternalMode(t *testing.T) {
    cfg, err := Load(env(map[string]string{
        "AGENT_COMPOSE_URL": "http://agent-compose:7410",
        "SCRIPT_SERVICE_URL": "http://scripts:7420",
        "SCRIPT_SERVICE_TOKEN": "token",
    }))
    if err != nil { t.Fatal(err) }
    if cfg.AuthMode != AuthDisabled || cfg.ListenAddr != "127.0.0.1:8080" || cfg.SessionTTL != 24*time.Hour {
        t.Fatalf("unexpected config: %#v", cfg)
    }
}

func TestLoadPasswordModeRequiresSecrets(t *testing.T) {
    _, err := Load(env(map[string]string{
        "AUTH_MODE": "password",
        "AUTH_PASSWORD": "",
        "AUTH_SECRET": "",
        "AGENT_COMPOSE_URL": "http://agent-compose:7410",
        "SCRIPT_SERVICE_URL": "http://scripts:7420",
        "SCRIPT_SERVICE_TOKEN": "token",
    }))
    if err == nil { t.Fatal("expected password configuration error") }
}

func TestLoadRejectsInvalidModeDurationAndUpstreams(t *testing.T) {
    cases := []map[string]string{
        {"AUTH_MODE": "other"},
        {"AUTH_SESSION_TTL": "zero"},
        {"AGENT_COMPOSE_URL": "://bad"},
        {"SCRIPT_SERVICE_URL": "://bad"},
    }
    for _, values := range cases {
        values["SCRIPT_SERVICE_TOKEN"] = "token"
        if _, err := Load(env(values)); err == nil { t.Fatalf("expected error for %#v", values) }
    }
}
```

- [ ] **Step 2: Run the focused tests and confirm they fail because configuration types do not exist**

Run: `go test ./internal/config -run TestLoad -v`

Expected: compile failure referring to undefined `Load` or `Config`.

- [ ] **Step 3: Implement strict environment parsing with no secret values in errors**

```go
// internal/config/config.go
package config

import (
    "fmt"
    "net/url"
    "strings"
    "time"
)

type AuthMode string
const (
    AuthDisabled AuthMode = "disabled"
    AuthPassword AuthMode = "password"
)

type Config struct {
    ListenAddr, AuthUsername, AuthPassword, AuthSecret string
    AuthMode AuthMode
    SessionTTL time.Duration
    AgentComposeURL, ScriptServiceURL *url.URL
    ScriptServiceToken string
}

func Load(getenv func(string) string) (Config, error) {
    cfg := Config{ListenAddr: "127.0.0.1:8080", AuthMode: AuthDisabled, AuthUsername: "admin", SessionTTL: 24*time.Hour}
    if value := strings.TrimSpace(getenv("AUTH_MODE")); value != "" { cfg.AuthMode = AuthMode(value) }
    if value := strings.TrimSpace(getenv("AUTH_USERNAME")); value != "" { cfg.AuthUsername = value }
    cfg.AuthPassword, cfg.AuthSecret = getenv("AUTH_PASSWORD"), getenv("AUTH_SECRET")
    if cfg.AuthMode != AuthDisabled && cfg.AuthMode != AuthPassword { return Config{}, fmt.Errorf("AUTH_MODE must be disabled or password") }
    if cfg.AuthMode == AuthPassword && (cfg.AuthPassword == "" || cfg.AuthSecret == "") { return Config{}, fmt.Errorf("AUTH_PASSWORD and AUTH_SECRET are required in password mode") }
    if raw := strings.TrimSpace(getenv("AUTH_SESSION_TTL")); raw != "" {
        ttl, err := time.ParseDuration(raw); if err != nil || ttl <= 0 { return Config{}, fmt.Errorf("AUTH_SESSION_TTL must be a positive duration") }; cfg.SessionTTL = ttl
    }
    parse := func(name, fallback string) (*url.URL, error) {
        raw := strings.TrimSpace(getenv(name)); if raw == "" { raw = fallback }
        value, err := url.ParseRequestURI(raw); if err != nil || value.Scheme == "" || value.Host == "" { return nil, fmt.Errorf("%s must be an absolute HTTP URL", name) }; return value, nil
    }
    var err error
    if cfg.AgentComposeURL, err = parse("AGENT_COMPOSE_URL", "http://agent-compose:7410"); err != nil { return Config{}, err }
    if cfg.ScriptServiceURL, err = parse("SCRIPT_SERVICE_URL", "http://scripts:7420"); err != nil { return Config{}, err }
    cfg.ScriptServiceToken = getenv("SCRIPT_SERVICE_TOKEN")
    if cfg.ScriptServiceToken == "" { return Config{}, fmt.Errorf("SCRIPT_SERVICE_TOKEN is required") }
    return cfg, nil
}
```

- [ ] **Step 4: Run formatting and focused tests**

Run: `gofmt -w internal/config/*.go && go test ./internal/config -v`

Expected: all configuration tests pass.

- [ ] **Step 5: Commit the configuration boundary**

```bash
git add go.mod internal/config
git commit -m "feat(auth): add gateway configuration"
```

### Task 2: Signed sessions and login handlers

**Files:**
- Create: `internal/auth/manager.go`
- Create: `internal/auth/session.go`
- Create: `internal/auth/handlers.go`
- Create: `internal/auth/auth_test.go`

**Interfaces:**
- Consumes: `config.Config`
- Produces: `auth.New(config.Config) *auth.Manager`
- Produces: `(*Manager).Status`, `(*Manager).Login`, `(*Manager).Logout`, and `(*Manager).Require(http.Handler) http.Handler`
- Produces: JSON status shape `{ enabled, loggedIn, username?, expiresAt? }`

- [ ] **Step 1: Write handler and session behavior tests with `httptest`**

```go
func TestPasswordLoginSetsSignedCookieAndUnlocksProtectedRoute(t *testing.T) {
    manager := newTestManager(t)
    login := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"correct"}`))
    recorder := httptest.NewRecorder()
    manager.Login(recorder, login)
    if recorder.Code != http.StatusOK || len(recorder.Result().Cookies()) != 1 { t.Fatalf("login response: %d", recorder.Code) }

    protected := manager.Require(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
    request := httptest.NewRequest(http.MethodGet, "/agentcompose.v2.ProjectService/ListProjects", nil)
    request.AddCookie(recorder.Result().Cookies()[0])
    response := httptest.NewRecorder()
    protected.ServeHTTP(response, request)
    if response.Code != http.StatusNoContent { t.Fatalf("protected response: %d", response.Code) }
}

func TestInvalidLoginIsUnauthorized(t *testing.T) {
    manager := newTestManager(t)
    request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"wrong"}`))
    response := httptest.NewRecorder()
    manager.Login(response, request)
    if response.Code != http.StatusUnauthorized || len(response.Result().Cookies()) != 0 { t.Fatalf("invalid login response: %d", response.Code) }
}

func TestTamperedCookieIsUnauthorized(t *testing.T) {
    manager := newTestManager(t)
    protected := manager.Require(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
    request := httptest.NewRequest(http.MethodGet, "/agentcompose.v2.ProjectService/ListProjects", nil)
    request.AddCookie(&http.Cookie{Name: cookieName, Value: manager.signedValue("admin", time.Now().Add(time.Hour)) + "changed"})
    response := httptest.NewRecorder()
    protected.ServeHTTP(response, request)
    if response.Code != http.StatusUnauthorized { t.Fatalf("tampered cookie response: %d", response.Code) }
}

func TestDisabledModeAllowsRequestsAndReportsDisabled(t *testing.T) {
    manager := New(config.Config{AuthMode: config.AuthDisabled})
    protected := manager.Require(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
    response := httptest.NewRecorder()
    protected.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/test", nil))
    if response.Code != http.StatusNoContent { t.Fatalf("disabled response: %d", response.Code) }
}

func TestLogoutExpiresCookie(t *testing.T) {
    manager := newTestManager(t)
    response := httptest.NewRecorder()
    manager.Logout(response, httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil))
    cookies := response.Result().Cookies()
    if len(cookies) != 1 || cookies[0].MaxAge >= 0 { t.Fatalf("logout cookies: %#v", cookies) }
}
```

- [ ] **Step 2: Run tests and verify the missing auth package failure**

Run: `go test ./internal/auth -v`

Expected: compile failure because `Manager` and its handlers do not exist.

- [ ] **Step 3: Implement stateless HMAC-SHA256 sessions and constant-time credential checks**

Implement these exact invariants:

```go
type Manager struct { mode config.AuthMode; username, password string; secret []byte; ttl time.Duration }
type statusResponse struct { Enabled bool `json:"enabled"`; LoggedIn bool `json:"loggedIn"`; Username string `json:"username,omitempty"`; ExpiresAt string `json:"expiresAt,omitempty"` }

func (m *Manager) signedValue(username string, expires time.Time) string
func (m *Manager) validate(r *http.Request) (username string, expires time.Time, ok bool)
func (m *Manager) Require(next http.Handler) http.Handler
```

Use `subtle.ConstantTimeCompare` for credentials and signatures. Build the Cookie with `HttpOnly`, `SameSite=Lax`, `Path=/`, expiration, and `Secure` when `r.TLS != nil` or the trusted nginx header equals `https`. Decode login JSON with a bounded body and return generic JSON errors. Do not accept Basic Auth as an alternate bypass.

- [ ] **Step 4: Run auth tests and the race detector**

Run: `gofmt -w internal/auth/*.go && go test -race ./internal/auth -v`

Expected: all auth tests pass with no race reports.

- [ ] **Step 5: Commit the authentication behavior**

```bash
git add internal/auth
git commit -m "feat(auth): add signed login sessions"
```

### Task 3: Explicit daemon and script-service reverse proxies

**Files:**
- Create: `internal/proxy/proxy.go`
- Create: `internal/proxy/proxy_test.go`
- Create: `internal/app/server.go`
- Create: `internal/app/server_test.go`
- Create: `cmd/agent-compose-ui-server/main.go`

**Interfaces:**
- Consumes: `config.Config` and `auth.Manager`
- Produces: `proxy.NewDaemon(*url.URL) http.Handler`
- Produces: `proxy.NewScripts(*url.URL, string) http.Handler`
- Produces: `app.New(config.Config) http.Handler` and `app.Run(context.Context, config.Config) error`

- [ ] **Step 1: Write proxy tests proving routing, authorization, body preservation, and token replacement**

```go
func TestDaemonProxyPreservesRequest(t *testing.T) {
    received := make(chan string, 1)
    upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        body, _ := io.ReadAll(r.Body)
        received <- r.Method + " " + r.URL.RequestURI() + " " + string(body)
        w.WriteHeader(http.StatusNoContent)
    }))
    defer upstream.Close()
    target, _ := url.Parse(upstream.URL)
    response := httptest.NewRecorder()
    NewDaemon(target).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/agentcompose.v2.Test/Call?q=1", strings.NewReader("payload")))
    if got := <-received; got != "POST /agentcompose.v2.Test/Call?q=1 payload" { t.Fatalf("received %q", got) }
}

func TestScriptProxyReplacesClientToken(t *testing.T) {
    received := make(chan string, 1)
    upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { received <- r.Header.Get("X-Script-Service-Token") }))
    defer upstream.Close()
    target, _ := url.Parse(upstream.URL)
    request := httptest.NewRequest(http.MethodGet, "/script-api/v1/health", nil)
    request.Header.Set("X-Script-Service-Token", "attacker")
    NewScripts(target, "server-token").ServeHTTP(httptest.NewRecorder(), request)
    if got := <-received; got != "server-token" { t.Fatalf("token = %q", got) }
}

func TestUnknownPathIsNotProxied(t *testing.T) {
    handler := New(testConfig(t))
    response := httptest.NewRecorder()
    handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/not-an-upstream", nil))
    if response.Code != http.StatusNotFound { t.Fatalf("status = %d", response.Code) }
}

func TestProxyFailureIsGeneric(t *testing.T) {
    target, _ := url.Parse("http://127.0.0.1:1")
    response := httptest.NewRecorder()
    NewDaemon(target).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/test", nil))
    if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "127.0.0.1") { t.Fatalf("response = %d %q", response.Code, response.Body.String()) }
}
```

Use `httptest.NewServer` as each upstream and log only received safe fields in test failures.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `go test ./internal/proxy ./internal/app -v`

Expected: compile failure for missing constructors.

- [ ] **Step 3: Implement proxies using `httputil.NewSingleHostReverseProxy`**

The daemon director preserves paths and sets `X-Forwarded-Host`. The script director additionally executes:

```go
req.Header.Del("X-Script-Service-Token")
req.Header.Set("X-Script-Service-Token", scriptToken)
```

Use a shared `http.Transport` with bounded dial, TLS-handshake, idle, and response-header timeouts. Set a generic JSON `ErrorHandler`; never log the request body or headers.

- [ ] **Step 4: Implement an explicit route switch and graceful server lifecycle**

Route only the known families:

```go
switch {
case strings.HasPrefix(path, "/api/auth/"):
    authHandler.ServeHTTP(w, r)
case strings.HasPrefix(path, "/script-api/"):
    manager.Require(scriptProxy).ServeHTTP(w, r)
case isDaemonPath(path):
    manager.Require(daemonProxy).ServeHTTP(w, r)
default:
    http.NotFound(w, r)
}
```

`main.go` calls `config.Load(os.Getenv)`, installs signal cancellation, and calls `app.Run`. `app.Run` listens only on `127.0.0.1:8080`, shuts down with a bounded context, and reports startup failures without dumping configuration.

- [ ] **Step 5: Verify proxy and app tests**

Run: `gofmt -w cmd internal/app internal/proxy && go test -race ./internal/proxy ./internal/app -v`

Expected: all tests pass.

- [ ] **Step 6: Commit the UI-owned Go gateway**

```bash
git add cmd internal/app internal/proxy
git commit -m "feat(auth): proxy UI backend traffic"
```

### Task 4: Frontend authentication state and login screen

**Files:**
- Create: `src/lib/auth.ts`
- Create: `src/components/LoginView.svelte`
- Create: `test/components/LoginView.test.ts`
- Create: `test/AppAuth.test.ts`
- Modify: `src/App.svelte`

**Interfaces:**
- Produces: `getAuthStatus(): Promise<AuthStatus>`, `login(username, password): Promise<AuthStatus>`, `logout(): Promise<void>`
- Produces: `authState` with `phase: 'loading' | 'authenticated' | 'anonymous' | 'disabled' | 'error'`
- Produces: `requireLogin()` and `subscribeUnauthorized(listener)` for shared request clients in Task 5

- [ ] **Step 1: Write component tests for startup gating, login, and hash-route restoration**

```ts
test('does not mount protected application components before auth status resolves', async () => {
  // Hold getAuthStatus promise; render App; assert Sidebar and RPC-backed pages are absent.
});

test('shows login and restores pathname search and hash after success', async () => {
  history.replaceState(null, '', '/?sandboxTab=files#/project/demo');
  // Mock anonymous status, submit credentials, resolve success, assert the full target remains active.
});

test('disabled mode mounts the normal application without a login form', async () => {
  vi.mocked(getAuthStatus).mockResolvedValue({ enabled: false, loggedIn: true });
  render(App);
  expect(await screen.findByRole('navigation')).toBeInTheDocument();
  expect(screen.queryByRole('form', { name: '登录' })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests and confirm missing modules/components fail**

Run: `npx vitest run test/components/LoginView.test.ts test/AppAuth.test.ts`

Expected: module resolution or assertion failures because authentication UI is absent.

- [ ] **Step 3: Implement the auth client and in-memory state**

All requests use same-origin credentials and JSON:

```ts
export interface AuthStatus { enabled: boolean; loggedIn: boolean; username?: string; expiresAt?: string }
export async function getAuthStatus(): Promise<AuthStatus>
export async function login(username: string, password: string): Promise<AuthStatus>
export async function logout(): Promise<void>
```

Save only a same-origin local target (`pathname + search + hash`) in `sessionStorage`; never store credentials. A failed status request enters a retryable error state rather than mounting protected children.

- [ ] **Step 4: Implement `LoginView` and gate all existing `App.svelte` content**

Render exactly one of loading, retryable error, login, or the existing application shell. Keep the existing project/runtime routing inside the authenticated branch so child `onMount` hooks cannot make early protected calls.

- [ ] **Step 5: Run component tests and Svelte checking**

Run: `npx vitest run test/components/LoginView.test.ts test/AppAuth.test.ts && bun run check`

Expected: tests and Svelte check pass.

- [ ] **Step 6: Commit frontend login gating**

```bash
git add src/App.svelte src/lib/auth.ts src/components/LoginView.svelte test/AppAuth.test.ts test/components/LoginView.test.ts
git commit -m "feat(auth): gate UI behind login"
```

### Task 5: Consistent session-expiry handling for ConnectRPC and scripts

**Files:**
- Create: `src/lib/auth-fetch.ts`
- Create: `src/lib/auth-fetch.test.ts`
- Modify: `src/lib/rpc.ts`
- Modify: `src/lib/scripts/api.ts`
- Modify: `src/lib/scripts/api.test.js`

**Interfaces:**
- Consumes: `requireLogin()` from `src/lib/auth.ts`
- Produces: `authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>`
- Guarantees: one `401` notification per anonymous transition and normal response passthrough otherwise

- [ ] **Step 1: Write failing tests for 401 notification without consuming response bodies**

```ts
test('marks the session anonymous on a 401 and returns the original response', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"error":"authentication required"}', { status: 401 }));
  const response = await authFetch('/agentcompose.v2.ProjectService/ListProjects');
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'authentication required' });
  expect(requireLogin).toHaveBeenCalledOnce();
});
```

Extend the script API test to assert a gateway `401` triggers auth state instead of being mislabeled as script-service `UNAUTHORIZED`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx vitest run src/lib/auth-fetch.test.ts && bun test src/lib/scripts/api.test.js`

Expected: failure because `authFetch` is missing and script API uses raw `fetch`.

- [ ] **Step 3: Implement and install `authFetch` in both request stacks**

Replace the final raw `fetch` in the Connect transport and script API with `authFetch`. Preserve the existing RPC abort/timeout signal and do not clone or parse successful/streaming responses.

- [ ] **Step 4: Run focused and component tests**

Run: `npx vitest run src/lib/auth-fetch.test.ts test/AppAuth.test.ts && bun test src/lib/scripts/api.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit unified expiry handling**

```bash
git add src/lib/auth-fetch.ts src/lib/auth-fetch.test.ts src/lib/rpc.ts src/lib/scripts/api.ts src/lib/scripts/api.test.js
git commit -m "feat(auth): handle expired UI sessions"
```

### Task 6: Build and route the Go gateway in the existing web image

**Files:**
- Create: `docker/web-entrypoint.sh`
- Create: `docker/nginx/default.conf.test.mjs`
- Modify: `docker/Dockerfile.web`
- Modify: `docker/nginx/default.conf.template`
- Modify: `docker/docker-compose.yml`
- Modify: `docker/docker-compose.full.yml`
- Modify: `docker/.env.example`

**Interfaces:**
- Consumes: gateway binary from Tasks 1-3
- Produces: one `web` image containing SPA, nginx, and `/usr/local/bin/agent-compose-ui-server`
- Produces: nginx-to-gateway routing with `X-Forwarded-Proto`

- [ ] **Step 1: Add a failing static nginx routing test**

Test assertions must require:

```js
expect(config).toMatch(/location.*agentcompose/);
expect(config).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:8080/);
expect(config).toMatch(/location \/script-api\//);
expect(config).not.toContain('X-Script-Service-Token ${SCRIPT_SERVICE_TOKEN}');
expect(config).toContain('X-Forwarded-Proto $scheme');
```

- [ ] **Step 2: Run the nginx test and confirm current direct-upstream assertions fail**

Run: `bun test docker/nginx/default.conf.test.mjs`

Expected: failure because nginx currently proxies daemon and scripts directly.

- [ ] **Step 3: Add a Go build stage and supervised runtime entrypoint**

Use an Alpine Go builder compatible with `go.mod`, run `go test ./...`, build `./cmd/agent-compose-ui-server`, and copy only the binary into the nginx runtime. The POSIX entrypoint starts the gateway, starts the stock nginx entrypoint, traps `INT`/`TERM`, and terminates the sibling if either exits.

- [ ] **Step 4: Route all backend paths to loopback Go gateway**

Keep static SPA serving in nginx. Replace daemon and script upstream proxy blocks with `proxy_pass http://127.0.0.1:8080`, forward host/client/proto headers, preserve streaming timeouts, and never inject the script token in nginx.

- [ ] **Step 5: Pass authentication settings through both Compose variants**

Add these exact mappings to the `web.environment` blocks:

```yaml
AUTH_MODE: ${AUTH_MODE:-disabled}
AUTH_USERNAME: ${AUTH_USERNAME:-admin}
AUTH_PASSWORD: ${AUTH_PASSWORD:-}
AUTH_SECRET: ${AUTH_SECRET:-}
AUTH_SESSION_TTL: ${AUTH_SESSION_TTL:-24h}
```

Keep existing `AGENT_COMPOSE_URL`, `SCRIPT_SERVICE_URL`, and `SCRIPT_SERVICE_TOKEN` values for consumption by the Go gateway.

- [ ] **Step 6: Document safe example configurations**

Add disabled company-internal mode and password-mode examples to `docker/.env.example`. Leave password and signing secret empty, and document `openssl rand -hex 32` for `AUTH_SECRET`.

- [ ] **Step 7: Verify config tests and build the image**

Run: `bun test docker/nginx/default.conf.test.mjs`

Run: `docker build -f docker/Dockerfile.web -t agent-compose-ui:auth-test .`

Expected: test passes and the image builds with Go tests executed in its builder stage.

- [ ] **Step 8: Commit production integration**

```bash
git add docker/Dockerfile.web docker/web-entrypoint.sh docker/nginx/default.conf.template docker/nginx/default.conf.test.mjs docker/docker-compose.yml docker/docker-compose.full.yml docker/.env.example
git commit -m "feat(auth): deploy gateway with web image"
```

### Task 7: Development orchestration and operator documentation

**Files:**
- Modify: `package.json`
- Modify: `scripts/dev.mjs`
- Modify: `scripts/dev.test.mjs`
- Modify: `vite.config.ts`
- Modify: `README.md`
- Modify: `docker/README.md`

**Interfaces:**
- Produces: `bun run dev:gateway`
- Changes: `bun run dev` starts gateway, Vite, and script service with one shared script token
- Produces: Vite proxy routes protected paths to `127.0.0.1:8080`

- [ ] **Step 1: Extend supervisor tests to require the gateway child and shared environment**

Expected child order and responsibilities:

```js
expect(specs.map(({ name }) => name)).toEqual(['gateway', 'web', 'scripts']);
expect(specs[0].args).toEqual(['run', './cmd/agent-compose-ui-server']);
expect(specs.every(({ env }) => env.SCRIPT_SERVICE_TOKEN === 'abc')).toBe(true);
```

- [ ] **Step 2: Run the current test and verify it fails on the missing gateway**

Run: `bun test scripts/dev.test.mjs`

Expected: child list mismatch.

- [ ] **Step 3: Add gateway development command and route Vite through it**

Add `"dev:gateway": "go run ./cmd/agent-compose-ui-server"`. Update the supervisor to pass `AUTH_MODE` from the developer environment, defaulting to `disabled`, and to provide the generated script token to all children. Change daemon, health, API, and script Vite targets to `http://127.0.0.1:8080`; remove Vite's script-token injection.

- [ ] **Step 4: Document operation and security boundary**

Document:

- company-internal test deployment with `AUTH_MODE=disabled`;
- password deployment with all required variables;
- login/logout and session TTL behavior;
- all authenticated users have full UI capability;
- the feature is implemented entirely in `agent-compose-ui` and does not modify daemon behavior;
- HTTPS remains required outside the company network.

- [ ] **Step 5: Run supervisor and configuration checks**

Run: `bun test scripts/dev.test.mjs docker/nginx/default.conf.test.mjs && bun run check`

Expected: all pass.

- [ ] **Step 6: Commit development and documentation integration**

```bash
git add package.json scripts/dev.mjs scripts/dev.test.mjs vite.config.ts README.md docker/README.md
git commit -m "docs(auth): add gateway development workflow"
```

### Task 8: Full verification and security regression audit

**Files:**
- Modify only if a verification failure exposes a scoped defect in files from Tasks 1-7.

**Interfaces:**
- Consumes: all prior task outputs
- Produces: evidence that authentication-disabled and password modes work without daemon changes

- [ ] **Step 1: Run all Go tests with race detection**

Run: `go test -race ./...`

Expected: all packages pass with no race report.

- [ ] **Step 2: Run all frontend and script tests**

Run: `bun run test:all`

Expected: all checks and tests pass.

- [ ] **Step 3: Build the production image**

Run: `docker build -f docker/Dockerfile.web -t agent-compose-ui:auth-final .`

Expected: successful multi-stage build.

- [ ] **Step 4: Smoke-test disabled mode**

Start the full Compose stack with `AUTH_MODE=disabled`, request `/api/auth/status`, and verify `enabled=false`, `loggedIn=true`. Verify daemon and `/script-api/v1/health` requests pass without a Cookie.

- [ ] **Step 5: Smoke-test password mode**

Start with `AUTH_MODE=password` and generated password/signing secret. Verify protected daemon and script requests return `401` before login, login sets an `HttpOnly` Cookie, and the same requests succeed with that Cookie. Verify a modified Cookie returns `401`.

- [ ] **Step 6: Audit the final diff for secret handling and scope**

Run:

```bash
rg -n "password|AUTH_SECRET|SCRIPT_SERVICE_TOKEN|Authorization|Cookie" cmd internal src docker scripts README.md
git diff --check HEAD~7..HEAD
git status --short
```

Expected: no secret values or request-body logging; no changes under `../agent-compose`; only intentional user-owned pre-existing changes remain unstaged.

- [ ] **Step 7: Commit only scoped verification fixes if needed**

First inspect `git diff --name-only`. If verification required a fix, stage only the affected paths from `cmd/agent-compose-ui-server`, `internal`, `src`, `docker`, `scripts`, `README.md`, or `package.json`, then run:

```bash
git commit -m "fix(auth): address gateway verification findings"
```

Skip this commit when verification required no fixes.
