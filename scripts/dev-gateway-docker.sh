#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN=$(grep '^SCRIPT_SERVICE_TOKEN=' .env.dev | cut -d= -f2-)
DAEMON_DATA_DIR="$(cd ../agent-compose && pwd)/data"

docker rm -f agent-compose-ui-gateway 2>/dev/null || true
docker run -d --name agent-compose-ui-gateway \
  --network host \
  -e AGENT_COMPOSE_URL=http://127.0.0.1:7410 \
  -e SCRIPT_SERVICE_URL=http://127.0.0.1:7420 \
  -e SCRIPT_SERVICE_TOKEN="$TOKEN" \
  -e AUTH_MODE=disabled \
  -e AGENT_COMPOSE_DB_PATH=/data/agent-compose/data.db \
  -e UI_STATE_DB_PATH=/data/ui/project-env.db \
  -e PROJECT_STORAGE_ROOT=/data/work/projects \
  -e LOCAL_VOLUME_ROOT=/data/volumes/local \
  -v "$DAEMON_DATA_DIR:/data/agent-compose:ro" \
  -v "$DAEMON_DATA_DIR/work:/data/work" \
  -v "$DAEMON_DATA_DIR/volumes/local:/data/volumes/local" \
  -v agent-compose-ui-state:/data/ui \
  agent-compose-ui-gateway:dev

echo "==> Go gateway running on http://127.0.0.1:8080 (host network)"
echo "==> Logs (Ctrl+C to detach, container keeps running):"
docker logs -f agent-compose-ui-gateway
