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
```

Set `AGENT_COMPOSE_BASE` to host the app under a sub-path (default `/`).

## Deploy

`nginx/Dockerfile` builds the static UI and serves it via nginx, reverse-proxying
the API and Jupyter routes to the daemon. CI publishes the image to
`ghcr.io/chaitin/agent-compose-frontend`.
