#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

export SCRIPT_SERVICE_TOKEN=$(grep '^SCRIPT_SERVICE_TOKEN=' .env.dev | cut -d= -f2-)
export SKIP_LOCAL_GATEWAY=1

echo "==> Hybrid dev mode: Vite + script-service on host, Go gateway in Docker"
echo "==> Make sure gateway is running: ./scripts/dev-gateway-docker.sh"
echo "==> Token: ${SCRIPT_SERVICE_TOKEN:0:8}... (full token in .env.dev)"
echo ""
exec bun run dev
