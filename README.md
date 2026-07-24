# agent-compose-ui

Web UI for [agent-compose](https://github.com/chaitin/agent-compose) — a Svelte + Vite single-page app that talks to the agent-compose daemon over ConnectRPC.

The backend repository's protobuf definitions are the API source of truth. This
repository directly tracks the generated `agentcompose/v2` and `health/v1`
TypeScript clients under `src/gen/`.

## Develop

Requires a running agent-compose daemon on `http://127.0.0.1:7410` — the Vite
dev server proxies RPC/API/Jupyter calls to it.

```bash
npm ci
npm run dev:ui   # listens on 0.0.0.0:5174
```

Open `http://<host>:5174/` from another machine. The development server proxies
v2 ConnectRPC, health, REST API, and Jupyter requests to the local daemon.
Set `AGENT_COMPOSE_DEV_BACKEND` to use a daemon URL other than
`http://127.0.0.1:7410`.

## Build

```bash
npm run build:ui   # outputs to dist/
go test ./...
docker build -f nginx/Dockerfile -t agent-compose-ui:local .
```

Set `AGENT_COMPOSE_BASE` to host the app under a sub-path (default `/`).

## Token-protected API

Set `TOKEN_DB_PATH` to an absolute path in a persistent volume to enable API
Token management in the System Settings page. The UI server then exposes a
separate h2c-capable machine API listener on container port `8081`. Map that
port explicitly (for example `${TOKEN_RBAC_API_PORT:-8081}:8081`) and protect
cross-host traffic with TLS, a VPN, or a tunnel.

Tokens use the `admin` or `read-only-admin` role and are only shown once when
created. The database stores a non-recoverable digest. When `TOKEN_DB_PATH` is
unset, the browser UI remains available while Token management and port `8081`
return HTTP 503.

The UI server accepts `AGENT_COMPOSE_URL` to override the default daemon URL
`http://agent-compose:7410`. The daemon must not use
`AGENT_COMPOSE_AUTH_TOKEN` with this proxy: managed API Tokens are removed
before requests are forwarded upstream.

## Deploy

`nginx/Dockerfile` builds the Svelte UI and the Go UI server, then packages both
into the nginx-based runtime image. nginx serves static assets and forwards
API/RPC/OAuth/Jupyter routes to the local Go UI server, which handles browser
auth/OAuth and proxies the daemon. CI publishes the image to
`ghcr.io/chaitin/agent-compose-ui`.
