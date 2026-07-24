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

The Vite-only setup does not provide API Token management. To develop that
feature locally, start the Go UI server and point Vite at it (the directory
containing the database file must already exist).

In one terminal:

```bash
TOKEN_DB_PATH=/absolute/path/to/tokens.db \
AGENT_COMPOSE_URL=http://127.0.0.1:7410 \
go run ./cmd/agent-compose-ui-server
```

In another terminal:

```bash
AGENT_COMPOSE_DEV_BACKEND=http://127.0.0.1:8080 \
AGENT_COMPOSE_DEV_UI_SERVER=http://127.0.0.1:8080 \
npm run dev:ui
```

## Build

```bash
npm run build:ui   # outputs to dist/
go test ./...
docker build -f nginx/Dockerfile -t agent-compose-ui:local .
```

Set `AGENT_COMPOSE_BASE` to host the app under a sub-path (default `/`).

## Token-protected API

The official image enables API Token management by default with
`TOKEN_DB_PATH=/data/api/tokens.db`. Mount a persistent volume at `/data/api`
and override `TOKEN_DB_PATH` when a different location is required. When the
UI server binary is run outside the image, set `TOKEN_DB_PATH` explicitly to
enable Token management in the System Settings page. The server then exposes
a separate h2c-capable machine API listener on container port `8081`. The
deployment may publish that port with a mapping such as
`${TOKEN_RBAC_API_PORT:-8081}:8081`, but the mapped port is not necessarily the
caller-facing API address. Deployers should place it behind an encrypted,
protected entry point and provide callers with the resulting API Base URL.

Tokens use the `admin` or `read-only-admin` role and are only shown once when
created. Callers obtain the accessible API Base URL from their administrator
and send `Authorization: Bearer <token>` with each request; they should not
construct the Base URL from the container or host port alone. `admin` can call
all APIs forwarded by the proxy, while `read-only-admin` is limited to the
allowlisted query APIs and receives HTTP 403 for other paths. Tokens are
sensitive credentials: use them only with the administrator-provided API Base
URL, and never disclose or send them to another address.

The database stores a non-recoverable digest. When `TOKEN_DB_PATH` is unset
(for example when running the server binary directly), the browser UI remains
available while Token management and port `8081` return HTTP 503.

The UI server accepts `LISTEN_ADDR` to override its default browser API address
`127.0.0.1:8080` and `AGENT_COMPOSE_URL` to override the default daemon URL
`http://agent-compose:7410`. The Token API listener remains fixed at `8081`.
The daemon must not use
`AGENT_COMPOSE_AUTH_TOKEN` with this proxy: managed API Tokens are removed
before requests are forwarded upstream.

## Deploy

`nginx/Dockerfile` builds the Svelte UI and the Go UI server, then packages both
into the nginx-based runtime image. nginx serves static assets and forwards
API/RPC/OAuth/Jupyter routes to the local Go UI server, which handles browser
auth/OAuth and proxies the daemon. CI publishes the image to
`ghcr.io/chaitin/agent-compose-ui`.
