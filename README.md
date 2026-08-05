# agent-compose-ui

Web UI for [agent-compose](https://github.com/chaitin/agent-compose) — a Svelte + Vite single-page app that talks to the agent-compose daemon over ConnectRPC.

The backend repository's protobuf definitions are the API source of truth. This
repository directly tracks the generated `agentcompose/v2` and `health/v1`
TypeScript clients under `src/gen/`.

## Develop

Development uses the same authenticated request path as production. Start a
daemon, the Go UI server, and Vite in separate terminals:

```bash
npm ci
AGENT_COMPOSE_BACKEND=http://127.0.0.1:7410 \
AUTH_USERNAME=admin \
AUTH_PASSWORD=change-me \
AUTH_SECRET=replace-with-a-stable-random-secret \
UI_DATABASE_PATH=/absolute/path/to/agent-compose-ui.db \
SANDBOX_ROOT=/absolute/path/to/agent-compose/data/sandboxes \
go run ./cmd/agent-compose-ui-server

AGENT_COMPOSE_DEV_UI_SERVER=http://127.0.0.1:8080 npm run dev:ui
```

Open `http://<host>:5174/`. Vite forwards browser requests to the UI server;
the UI server authenticates them and proxies daemon traffic. The interactive
terminal uses an authenticated WebSocket-to-Connect bridge in the UI server.

Runtime variables:

- `AGENT_COMPOSE_UI_LISTEN`: UI server listen address (default `127.0.0.1:8080`).
- `AGENT_COMPOSE_BACKEND`: daemon base URL (default `http://agent-compose:7410`).
- `AGENT_COMPOSE_DEV_UI_SERVER`: Vite's UI server target (default `http://127.0.0.1:8080`).
- `AUTH_USERNAME`, `AUTH_PASSWORD`, and `AUTH_SECRET`: local login and signed-session settings.
- `UI_DATABASE_PATH`: persistent UI-server database for audit events, OAuth
  principals, and API tokens. Versioned migrations run automatically at startup.
- `SANDBOX_ROOT`: read-only daemon Sandbox directory used to display Codex and
  Claude JSONL records (default `/data/sandboxes`).
- `AUDIT_RETENTION_DAYS`: audit retention in days (default `180`, range
  `1`–`3650`).
- `AGENT_COMPOSE_BASE`: frontend base path when hosted below `/`.

When the UI server runs in a container, mount the daemon Sandbox directory at
the configured path as read-only, for example
`${AGENT_COMPOSE_DATA_DIR}/sandboxes:/data/sandboxes:ro`. The UI server only
reads JSONL files below `.codex/sessions` and `.claude/projects`.

The UI server owns login identity and audit attribution; the daemon does not
manage browser users. Local password login is a single emergency account from
`AUTH_USERNAME`/`AUTH_PASSWORD`, while OAuth identities are discovered during
login. There is intentionally no user-management API or user CRUD. When neither
password login nor OAuth is configured, browser access is read-only: query APIs
remain available, while mutations, command execution, interactive terminals,
and Jupyter proxy access return HTTP 403. Configure either authentication method
to enable those operations. Webhook ingress and the runtime LLM facade retain
their existing public-access behavior.

Database migrations live under `internal/dbmigrate/migrations/` and use one
ordered sequence for the UI database. Applied migrations are tracked with
their checksum. Never edit an applied migration; add the next numbered SQL
file instead.

The browser management API is versioned under `/api/ui/v1/*`. Its audit log
records login/security events and mutating operations, including the actor,
safe resource identifiers, result, and duration. It never stores request
bodies, passwords, API Tokens, webhook payloads, or terminal input. The Audit
page supports filtered JSON and CSV export. The former
`/ui-api/v1/tokens` endpoint remains available only for Token-client
compatibility.

The Vite-only setup does not provide API Token management. To develop that
feature locally, start the Go UI server and point Vite at it (the directory
containing the database file must already exist).

In one terminal:

```bash
UI_DATABASE_PATH=/absolute/path/to/agent-compose-ui.db \
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

The official image enables persistent UI state and API Token management with
`UI_DATABASE_PATH=/data/agent-compose-ui.db`. Mount a persistent volume at
`/data` and override `UI_DATABASE_PATH` when a different location is required.
When the UI server binary is run outside the image, set `UI_DATABASE_PATH`
explicitly to enable persistence and Token management. The server then exposes
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

The database stores a non-recoverable digest. When `UI_DATABASE_PATH` is unset
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
