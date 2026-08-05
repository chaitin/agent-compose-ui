#!/bin/sh
set -eu

/etc/s6-overlay/s6-rc.d/prepare/up

migration_marker=/data/.all-in-one-current-engine
if [ -s /data/data.db ] && [ ! -e "$migration_marker" ]; then
  echo "existing agent-compose database detected; validating in-place migration" >&2
  agent-compose-migrate --source /data --target /data --runtime-root /data --dry-run
  agent-compose-migrate --source /data --target /data --runtime-root /data
fi

pids=""
start() {
  "$@" &
  last_pid=$!
  pids="$pids $last_pid"
}

stop_all() {
  trap - TERM INT EXIT
  [ -z "$pids" ] || kill -TERM $pids 2>/dev/null || true
  wait $pids 2>/dev/null || true
}
trap 'stop_all; exit 0' TERM INT
trap 'stop_all' EXIT

start /etc/s6-overlay/s6-rc.d/daemon/run
daemon_pid=$last_pid
ready=false
for _ in $(seq 1 60); do
  if wget -qO /dev/null http://127.0.0.1:7410/api/version; then
    ready=true
    break
  fi
  if ! kill -0 "$daemon_pid" 2>/dev/null; then
    echo "agent-compose daemon exited during startup" >&2
    exit 1
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo "agent-compose daemon did not become ready within 60 seconds" >&2
  exit 1
fi
touch "$migration_marker"
start /etc/s6-overlay/s6-rc.d/scripts/run
start /etc/s6-overlay/s6-rc.d/gateway/run
start /etc/s6-overlay/s6-rc.d/nginx/run

while :; do
  for pid in $pids; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" || status=$?
      exit "${status:-1}"
    fi
  done
  sleep 1
done
