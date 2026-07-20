#!/bin/sh
set -eu

gateway_pid=
nginx_pid=

stop_children() {
  trap - INT TERM
  [ -z "$gateway_pid" ] || kill "$gateway_pid" 2>/dev/null || true
  [ -z "$nginx_pid" ] || kill "$nginx_pid" 2>/dev/null || true
  [ -z "$gateway_pid" ] || wait "$gateway_pid" 2>/dev/null || true
  [ -z "$nginx_pid" ] || wait "$nginx_pid" 2>/dev/null || true
}

on_signal() {
  stop_children
  exit 143
}

trap on_signal INT TERM

/usr/local/bin/agent-compose-ui-server &
gateway_pid=$!

# Invoke the nginx image's stock entrypoint by its absolute path. It performs
# template rendering and then execs nginx inside this supervised child.
/docker-entrypoint.sh nginx -g 'daemon off;' &
nginx_pid=$!

# POSIX sh has no portable wait-for-any-child operation. Polling keeps this
# script portable across Alpine/BusyBox versions and bounds detection to 1s.
while kill -0 "$gateway_pid" 2>/dev/null && kill -0 "$nginx_pid" 2>/dev/null; do
  sleep 1
done

stop_children
exit 1
