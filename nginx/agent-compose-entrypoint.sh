#!/bin/sh
set -eu

/usr/local/bin/agent-compose-ui-server &
ui_server_pid=$!

/docker-entrypoint.sh "$@" &
nginx_pid=$!

cleanup() {
    kill "$ui_server_pid" "$nginx_pid" 2>/dev/null || true
    wait "$ui_server_pid" "$nginx_pid" 2>/dev/null || true
}

trap cleanup INT TERM

while :; do
    if ! kill -0 "$ui_server_pid" 2>/dev/null; then
        set +e
        wait "$ui_server_pid"
        status=$?
        set -e
        kill "$nginx_pid" 2>/dev/null || true
        wait "$nginx_pid" 2>/dev/null || true
        exit "$status"
    fi
    if ! kill -0 "$nginx_pid" 2>/dev/null; then
        set +e
        wait "$nginx_pid"
        status=$?
        set -e
        kill "$ui_server_pid" 2>/dev/null || true
        wait "$ui_server_pid" 2>/dev/null || true
        exit "$status"
    fi
    sleep 1
done
