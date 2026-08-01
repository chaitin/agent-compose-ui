# syntax=docker/dockerfile:1
#
# Single all-in-one image: nginx (SPA + reverse proxy) + Go auth gateway + Bun
# script-service, supervised by s6-overlay v3. Connects to an external
# agent-compose daemon (set AGENT_COMPOSE_URL).
#
# Build context is the repo root. Multi-arch (linux/amd64, linux/arm64) is
# supported via buildx; s6-overlay arch is selected from TARGETARCH.

# ---- Stage 1: build the SPA with Node + npm + Vite ----
# Uses npm (not bun) for the install because bun's bundled BoringSSL CA store
# cannot verify the registry cert in networks with TLS interception, whereas
# npm uses the system/Node OpenSSL trust store and works in those environments.
FROM node:22-alpine AS spa-build
WORKDIR /build

# Reproducible install: requires package-lock.json synced with package.json.
COPY package.json package-lock.json ./
RUN npm ci

# Build the static bundle (outputs /build/dist).
COPY . ./
RUN npm run build

# ---- Stage 2: test and build the loopback authentication gateway ----
FROM golang:1.25-alpine AS gateway-build
ENV GOPROXY=https://goproxy.cn,direct
WORKDIR /src

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY cmd ./cmd
COPY internal ./internal
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    go test ./... && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
    -o /out/agent-compose-ui-server ./cmd/agent-compose-ui-server

# ---- Stage 3: final image with s6-overlay supervising three services ----
FROM nginx:1.27-alpine

ARG TARGETARCH
ARG S6_VERSION=v3.2.0.2

# libstdc++ (+ libgcc via dependency): the Bun binary copied below is
# dynamically linked against libstdc++.so.6 / libgcc_s.so.1, which
# nginx:1.27-alpine does not ship by default.
RUN apk add --no-cache libstdc++

# Install s6-overlay: noarch + arch-specific tarball. Map docker's TARGETARCH
# to s6-overlay's arch naming (amd64 -> x86_64, arm64 -> aarch64).
RUN case "$TARGETARCH" in \
      amd64) s6_arch=x86_64 ;; \
      arm64) s6_arch=aarch64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    wget -O /tmp/s6-noarch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/${S6_VERSION}/s6-overlay-noarch.tar.xz" && \
    wget -O /tmp/s6-arch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/${S6_VERSION}/s6-overlay-${s6_arch}.tar.xz" && \
    tar -C / -Jxf /tmp/s6-noarch.tar.xz && \
    tar -C / -Jxf /tmp/s6-arch.tar.xz && \
    rm /tmp/s6-noarch.tar.xz /tmp/s6-arch.tar.xz

# Bun runtime: copy the static binary from the official image. No install step
# because script-service uses only Node/Bun builtins (no npm deps).
COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun

# SPA static bundle served by nginx.
COPY --from=spa-build /build/dist /usr/share/nginx/html

# Go gateway binary invoked by the gateway service.
COPY --from=gateway-build /out/agent-compose-ui-server /usr/local/bin/agent-compose-ui-server

# Script service sources (.dockerignore filters *.test.mjs at the repo level).
COPY script-service/*.mjs /app/script-service/

# nginx config rendered by the stock image entrypoint via envsubst.
COPY docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template

# s6-overlay service definitions for the three supervised processes.
COPY docker/s6/services /etc/s6-overlay/s6-rc.d

# Defaults: script-service is now in-container, reachable on loopback.
ENV SCRIPT_SERVICE_URL=http://127.0.0.1:7420 \
    SCRIPT_SERVICE_HOST=127.0.0.1 \
    SCRIPT_SERVICE_PORT=7420 \
    SCRIPT_DATA_DIR=/data/scripts \
    S6_VERBOSITY=1

EXPOSE 80 8081

# Gateway exposes /health.v1.HealthService/* on 127.0.0.1:8080. nginx proxies
# /health.v1.* to the gateway, so we healthcheck via nginx.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD wget -q --spider http://127.0.0.1/health.v1.HealthService/Check || exit 1

# s6-overlay's init is PID 1; it brings up the bundle in
# /etc/s6-overlay/s6-rc.d/user/contents.d and forwards signals.
ENTRYPOINT ["/init"]
