# Task 3 Report: Go gateway proxies and server

## Outcome

Implemented the UI-owned Go gateway entrypoint, explicit daemon/script-service routing, authentication enforcement, reverse proxies, and graceful loopback HTTP server lifecycle.

## Files

- `internal/proxy/proxy.go`
- `internal/proxy/proxy_test.go`
- `internal/app/server.go`
- `internal/app/server_test.go`
- `cmd/agent-compose-ui-server/main.go`

## Behavior

- Daemon requests preserve method, path, query, body, forwarding host, streaming, and standard `ReverseProxy` upgrade support.
- Script-service requests replace any client-provided `X-Script-Service-Token` with the configured server token.
- A shared standard-library transport bounds dial, TLS handshake, idle connection, and response-header waits without imposing a whole-request timeout.
- Proxy failures return generic JSON `502` responses without upstream details.
- Authentication status/login/logout routes are public, exact-path matched, and method constrained.
- Script and explicitly allowlisted daemon route families are protected through `auth.Manager.Require`; unknown paths return `404`.
- `Run` binds only `127.0.0.1:8080` and performs bounded shutdown after context cancellation.
- The process entrypoint loads validated environment configuration and installs SIGINT/SIGTERM cancellation.

## TDD and verification

RED was observed with missing `NewDaemon`, `NewScripts`, and `New` constructors:

```text
internal/proxy/proxy_test.go: undefined: NewDaemon / NewScripts
internal/app/server_test.go: undefined: New
```

Focused race verification (Go 1.24 Docker):

```text
docker run --rm -v /root/agent/agent-compose-ui:/work -w /work golang:1.24 go test -race ./internal/proxy ./internal/app -v
ok agent-compose-ui/internal/proxy 1.046s
ok agent-compose-ui/internal/app   1.049s
```

Full Go race verification (Go 1.24 Docker):

```text
docker run --rm -v /root/agent/agent-compose-ui:/work -w /work golang:1.24 go test -race ./...
ok agent-compose-ui/internal/app
ok agent-compose-ui/internal/auth
ok agent-compose-ui/internal/config
ok agent-compose-ui/internal/proxy
```

## Concerns

No blocking concerns. The fixed loopback address is intentional per the design and Task 3 brief. Existing unrelated `package-lock.json` and `old/` worktree changes were not touched or staged.
