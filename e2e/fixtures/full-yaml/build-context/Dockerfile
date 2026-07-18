FROM ghcr.io/chaitin/agent-compose-guest:latest AS runtime
ARG BUILD_MARKER
RUN printf '%s' "$BUILD_MARKER" > /etc/agent-compose-yaml-build-marker
