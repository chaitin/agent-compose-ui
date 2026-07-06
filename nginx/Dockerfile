ARG REGISTRY_MIRROR=docker.io
ARG GO_VERSION=1.26.2

FROM ${REGISTRY_MIRROR}/library/node:25-bookworm AS frontend-build
ARG AGENT_COMPOSE_BASE=/
WORKDIR /app
COPY package.json package-lock.json tsconfig.json vite.config.ts index.html ./
RUN npm ci
COPY src ./src
RUN AGENT_COMPOSE_BASE=${AGENT_COMPOSE_BASE} npm run build:ui

FROM ${REGISTRY_MIRROR}/library/golang:${GO_VERSION}-bookworm AS ui-server-build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -o /out/agent-compose-ui-server ./cmd/agent-compose-ui-server

FROM ${REGISTRY_MIRROR}/library/nginx:alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx/nginx.main /etc/nginx/nginx.conf
COPY nginx/10-normalize-jupyter-proxy-base.envsh /docker-entrypoint.d/10-normalize-jupyter-proxy-base.envsh
RUN chmod +x /docker-entrypoint.d/10-normalize-jupyter-proxy-base.envsh
COPY nginx/nginx.conf /etc/nginx/templates/agent-compose.conf.template
COPY --from=frontend-build /app/dist /srv/agent-compose/frontend
COPY --from=ui-server-build /out/agent-compose-ui-server /usr/local/bin/agent-compose-ui-server
COPY nginx/agent-compose-entrypoint.sh /agent-compose-entrypoint.sh
RUN chmod +x /agent-compose-entrypoint.sh
ENTRYPOINT ["/agent-compose-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
