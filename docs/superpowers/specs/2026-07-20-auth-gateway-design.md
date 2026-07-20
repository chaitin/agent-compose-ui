# Agent Compose UI Authentication Gateway Design

## Objective

Add an optional username/password authentication gateway to the current Agent Compose UI deployment. The same image must support an open company-internal test environment and a password-protected environment without changing application code.

This work covers:

- a small Go HTTP service;
- username/password login;
- signed login cookies;
- access control for the UI's backend-facing requests;
- reverse proxying to Agent Compose daemon and script-service;
- frontend login state and return-to-original-route behavior.

OAuth, user roles, project-level authorization, read-only sharing, and public-internet hardening beyond the controls described here are out of scope.

## Deployment Modes

Authentication is selected explicitly with `AUTH_MODE`.

### Open internal test environment

```env
AUTH_MODE=disabled
```

All users can use the application without logging in. Requests still pass through the Go gateway so both deployment modes exercise the same routing path.

### Password-protected environment

```env
AUTH_MODE=password
AUTH_USERNAME=admin
AUTH_PASSWORD=<strong password>
AUTH_SECRET=<independent random signing secret>
AUTH_SESSION_TTL=24h
```

`AUTH_USERNAME` defaults to `admin`. `AUTH_SESSION_TTL` defaults to `24h`. In password mode, an empty `AUTH_PASSWORD` or `AUTH_SECRET` is a startup error. A signing secret must not be generated transiently because doing so would invalidate every session on restart and could hide a deployment mistake.

Unknown `AUTH_MODE` values are startup errors. The default mode is `disabled` for compatibility with the current unauthenticated deployment, and deployment documentation must call out this default explicitly.

## Architecture

The existing `web` image remains the deployment unit. It contains nginx, the built SPA, and a small Go gateway bound only to the container loopback interface.

```text
Browser
  |
  v
nginx :80
  |-- static SPA files
  `-- protected/API paths --> Go gateway 127.0.0.1:8080
                                |-- authentication endpoints
                                |-- Agent Compose reverse proxy
                                `-- script-service reverse proxy
```

The image entrypoint starts the Go gateway and nginx, forwards termination signals, and exits if either process exits. The gateway owns authentication decisions. nginx does not duplicate authentication policy.

The Go code is organized by responsibility:

- `cmd/agent-compose-ui-server`: process entrypoint;
- `internal/config`: environment parsing and validation;
- `internal/auth`: credentials, signed sessions, handlers, and access checks;
- `internal/proxy`: daemon and script-service reverse proxies;
- `internal/app`: dependency assembly, routes, and HTTP server lifecycle.

## Routing and Access Policy

nginx serves immutable frontend assets and the SPA shell. It forwards these paths to the Go gateway:

- `/api/auth/*`;
- `/agentcompose.v1.*`;
- `/agentcompose.v2.*`;
- `/health.v1.*`;
- `/api/*`;
- `/script-api/*`;
- Agent Compose session, event, Jupyter, and upgrade paths used by the current UI.

Authentication endpoints are matched before the broader `/api/*` rule.

In `AUTH_MODE=password`, only these endpoints are public:

- `GET` and `HEAD /api/auth/status`;
- `POST /api/auth/login`;
- `POST /api/auth/logout`.

All daemon and script-service proxy routes require a valid session. API requests without a valid session receive `401` JSON. The SPA is allowed to load so it can render the login page; it cannot read or mutate backend data until authenticated.

In `AUTH_MODE=disabled`, status reports authentication as disabled and all proxy routes are allowed.

The gateway must not treat arbitrary paths as proxy targets. Each upstream has an explicit route family, preventing a caller from using the gateway as an open proxy.

## Login and Session Flow

The frontend checks `/api/auth/status` during application initialization.

- If authentication is disabled, normal application startup continues.
- If the browser has a valid session, normal application startup continues.
- If authentication is enabled and the session is missing or invalid, the frontend displays the login page without loading protected application data.

Before showing login, the frontend saves the complete local target, including `pathname`, `search`, and `hash`, in session storage. This is necessary because URL fragments are never sent to the Go server. After successful login, the frontend restores the target and clears it. Unsafe cross-origin targets are never accepted.

Login accepts a JSON username/password payload. Credential comparisons use constant-time comparison. A successful login returns authentication status and sets the signed session cookie. Failed login returns a generic `401` without revealing whether the username or password was wrong.

Logout expires the cookie and returns an unauthenticated status response.

## Cookie Design

The gateway uses a stateless HMAC-SHA256 signed cookie containing the authenticated username and expiration time. It contains no password or backend credential.

Cookie properties:

- `HttpOnly=true`;
- `SameSite=Lax`;
- `Path=/`;
- bounded `Expires` and `Max-Age` derived from `AUTH_SESSION_TTL`;
- `Secure=true` when the original request is HTTPS, determined from the direct TLS state or a trusted `X-Forwarded-Proto=https` supplied by the deployment proxy.

Signature and credential comparisons are constant-time. Expired, malformed, or incorrectly signed cookies are rejected. Changing `AUTH_SECRET` invalidates existing sessions.

The gateway does not log passwords, cookies, authorization headers, request bodies, script-service tokens, or environment-variable values.

## Reverse Proxy Behavior

### Agent Compose daemon

Authenticated daemon requests retain their method, path, query, body, and streaming behavior. The proxy supports ConnectRPC, long-running streams, and connection upgrades. It sets forwarding headers and uses bounded dial, TLS handshake, idle connection, and response-header timeouts without imposing a short whole-request timeout on streams.

The daemon upstream is configured through `AGENT_COMPOSE_URL` and validated at startup.

### Script service

Authenticated `/script-api/*` requests are forwarded to `SCRIPT_SERVICE_URL`. The gateway injects `X-Script-Service-Token` from `SCRIPT_SERVICE_TOKEN`, replacing any client-supplied value. The token is never exposed to the browser.

All three settings are required to be valid when their respective proxy is enabled. Proxy failures return a generic `502` JSON response and log only safe operational context such as upstream name and request path.

## Frontend Behavior

The frontend adds a small authentication API module and login view. Authentication state wraps application initialization so protected RPC calls are not fired before status is known.

The login view contains username and password inputs, a submit action, an invalid-credentials message, and a retryable service-error state. It does not persist the password. After a `401` from an otherwise authenticated session, the shared request layers signal session expiry and return the user to login while preserving the current route.

Both ConnectRPC and plain HTTP/script API clients must handle authentication failure consistently. No secret request body is copied into client logs or error telemetry.

## Docker and Development Integration

The web Dockerfile gains a Go build stage and copies the gateway binary into the nginx runtime image. The runtime entrypoint supervises nginx and the gateway.

Compose files pass:

- `AUTH_MODE`;
- `AUTH_USERNAME`;
- `AUTH_PASSWORD`;
- `AUTH_SECRET`;
- `AUTH_SESSION_TTL`;
- existing daemon and script-service upstream settings.

The example environment file documents both internal open mode and password mode without shipping usable credentials.

Local frontend development continues to use Vite. Vite proxies authentication and protected backend paths to a locally running Go gateway, while a dedicated development command starts the gateway with the configured mode. Direct-to-daemon proxying remains available only as an explicitly documented authentication-disabled development shortcut, not as the verification path for the feature.

## Error Handling

- Invalid gateway configuration fails startup with the setting name but never its secret value.
- Invalid credentials return `401` with a generic message.
- Missing or invalid sessions return `401` for protected APIs.
- Unsupported methods return `405`.
- Upstream failures return `502` with a generic response.
- Panics are recovered at the HTTP boundary and return `500` without exposing internal details.

## Verification Strategy

Go tests cover:

- disabled and password configuration modes;
- required configuration validation;
- successful and failed login;
- cookie signature, expiry, and tampering;
- logout;
- protected and public route decisions;
- daemon proxy forwarding;
- script-service token replacement;
- streaming and upgrade-compatible proxy configuration;
- safe proxy error responses.

Frontend tests cover:

- disabled mode startup;
- authenticated startup;
- login display and submission;
- invalid credentials;
- preservation and restoration of hash routes;
- session expiry handling;
- suppression of protected startup calls before authentication completes.

Docker/configuration verification covers image construction, both Compose variants, open-mode startup, password-mode startup, and rejection of incomplete password-mode configuration.

## Security Boundary

This feature is authentication, not fine-grained authorization. Every authenticated user has the same access to all daemon and script-service operations exposed by the UI. `AUTH_MODE=disabled` is suitable only behind the stated company network/VPN boundary. An internet-facing deployment must use password mode behind HTTPS and should add organization-specific rate limiting or SSO at the ingress layer.
