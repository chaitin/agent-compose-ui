# agent-compose-ui

Web UI for [agent-compose](https://github.com/chaitin/agent-compose) — a Svelte + Vite single-page app that talks to the agent-compose daemon over ConnectRPC.

The API client is consumed from the published package
[`@chaitin-ai/agent-compose-client`](https://www.npmjs.com/package/@chaitin-ai/agent-compose-client),
which is generated from the backend's `proto/`. This repo contains no proto or
generated code.

## Develop

Requires a running agent-compose daemon on `http://127.0.0.1:7410` — the Vite
dev server proxies RPC/API/Jupyter calls to it.

```bash
npm ci
npm run dev:ui   # http://127.0.0.1:5174
```

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

When the shared deployment environment includes daemon `HTTP_BASIC_AUTH`, the UI
server reuses it for proxied daemon API and Jupyter requests.
