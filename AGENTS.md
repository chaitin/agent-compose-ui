# Repository Guidelines

## Project Structure & Module Organization

This repository contains a Svelte 5 + Vite UI and a small Go UI server/proxy. Frontend code lives in `src/`: pages in `src/pages/`, shared UI in `src/components/`, API wrappers in `src/api/`, and domain helpers in `src/model/`. Go code lives under `cmd/agent-compose-ui-server/` and `internal/`. Runtime image and nginx configuration live in `nginx/`.

## Build, Test, and Development Commands

- `npm run dev:ui`: start Vite on `http://127.0.0.1:5174`, proxying daemon calls to `http://127.0.0.1:7410`.
- `npm run build:ui`: build the Svelte app into `dist/`.
- `npm run check:ui`: run the same Vite production build as the frontend check.
- `npm run check:server` or `go test ./...`: run all Go tests.
- `npm run build:image`: build the local nginx-based Docker image.

Run `npm ci` before frontend work. Set `AGENT_COMPOSE_BASE` when hosting below `/`.

## Coding Style & Naming Conventions

Use TypeScript strict mode. Follow existing frontend style: two-space indentation, single quotes, semicolons, PascalCase Svelte components, and camelCase functions/variables. Keep Svelte markup declarative; move non-trivial data shaping, formatting, and state transitions into named functions.

For Go, use `gofmt`, package-local tests, and idiomatic `TestName` functions. Prefer small handlers and helpers with explicit inputs over package-level mutable state.

## Module Boundaries

Keep route-level orchestration in `src/pages/`; split large page sections into `src/components/` before adding unrelated behavior. Components should receive data and callbacks through props.

Use `src/api/` only for HTTP/RPC calls, request options, and raw response adaptation. Put shared domain types, derived values, formatters, and normalization logic in `src/model/` or focused utility modules. Do not import Svelte components from `src/api/` or `src/model/`.

Keep Go HTTP setup in `internal/app`, auth/session/OAuth logic in `internal/auth`, reverse proxy behavior in `internal/proxy`, and environment/default handling in `internal/config`.

## Testing Guidelines

Use Go `testing` plus `httptest` where needed. Add or update `*_test.go` files next to changed Go packages. There is no frontend unit-test runner configured; use `npm run check:ui` and manually exercise affected UI flows.

## Commit & Pull Request Guidelines

Recent history uses short imperative commits with prefixes such as `fix:` and `feat:`. Pull requests should include a concise description, linked issue when available, test results, and screenshots or recordings for visible UI changes. Note new environment variables or nginx routing updates.

## Security & Configuration Tips

Do not commit secrets. Auth depends on `AUTH_USERNAME`, `AUTH_PASSWORD`, and `AUTH_SECRET`; tests should set these with `t.Setenv`. The frontend consumes `@chaitin-ai/agent-compose-client`; do not add generated proto files.
