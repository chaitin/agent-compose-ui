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

## Deploy

`nginx/Dockerfile` builds the Svelte UI and the Go UI server, then packages both
into the nginx-based runtime image. nginx serves static assets and forwards
API/RPC/OAuth/Jupyter routes to the local Go UI server, which handles browser
auth/OAuth and proxies the daemon. CI publishes the image to
`ghcr.io/chaitin/agent-compose-ui`.
