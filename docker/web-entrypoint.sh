#!/bin/sh
set -eu

gateway_pid=
nginx_pid=
gateway_command=${GATEWAY_COMMAND:-/usr/local/bin/agent-compose-ui-server}
nginx_entrypoint=${NGINX_ENTRYPOINT:-/docker-entrypoint.sh}
umask 077
status_dir=$(mktemp -d "${TMPDIR:-/tmp}/web-entrypoint.XXXXXX")

start_child() {
  name=$1
  shift
  (
    child_pid=
    forward_int() {
      [ -z "$child_pid" ] || kill -INT "$child_pid" 2>/dev/null || true
    }
    forward_term() {
      [ -z "$child_pid" ] || kill -TERM "$child_pid" 2>/dev/null || true
    }
    trap forward_int INT
    trap forward_term TERM
    "$@" &
    child_pid=$!
    printf '%s\n' "$child_pid" >"$status_dir/$name.pid"
    if wait "$child_pid"; then
      child_status=0
    else
      child_status=$?
    fi
    if mkdir "$status_dir/winner.lock" 2>/dev/null; then
      printf '%s %s\n' "$name" "$child_status" >"$status_dir/winner.$name"
      mv "$status_dir/winner.$name" "$status_dir/winner"
    fi
    exit "$child_status"
  ) &
  started_pid=$!
}

cleanup_status_dir() {
  rm -f "$status_dir/winner" "$status_dir/winner.gateway" "$status_dir/winner.nginx" \
    "$status_dir/gateway.pid" "$status_dir/nginx.pid"
  rmdir "$status_dir/winner.lock" 2>/dev/null || true
  rmdir "$status_dir" 2>/dev/null || true
}

signal_children() {
  signal=$1
  trap - INT TERM
  if [ -f "$status_dir/gateway.pid" ]; then
    IFS= read -r gateway_child_pid <"$status_dir/gateway.pid"
    kill -"$signal" "$gateway_child_pid" 2>/dev/null || true
  fi
  if [ -f "$status_dir/nginx.pid" ]; then
    IFS= read -r nginx_child_pid <"$status_dir/nginx.pid"
    kill -"$signal" "$nginx_child_pid" 2>/dev/null || true
  fi
  [ -z "$gateway_pid" ] || kill -"$signal" "$gateway_pid" 2>/dev/null || true
  [ -z "$nginx_pid" ] || kill -"$signal" "$nginx_pid" 2>/dev/null || true
  if [ "$signal" = INT ]; then
    [ -z "${gateway_child_pid:-}" ] || kill -TERM "$gateway_child_pid" 2>/dev/null || true
    [ -z "${nginx_child_pid:-}" ] || kill -TERM "$nginx_child_pid" 2>/dev/null || true
  fi
  [ -z "$gateway_pid" ] || wait "$gateway_pid" 2>/dev/null || true
  [ -z "$nginx_pid" ] || wait "$nginx_pid" 2>/dev/null || true
  cleanup_status_dir
}

on_int() {
  signal_children INT
  exit 130
}

on_term() {
  signal_children TERM
  exit 143
}

trap on_int INT
trap on_term TERM

start_child gateway "$gateway_command"
gateway_pid=$started_pid

# Invoke the nginx image's stock entrypoint by its absolute path. It performs
# template rendering and then execs nginx inside this supervised child.
start_child nginx "$nginx_entrypoint" nginx -g 'daemon off;'
nginx_pid=$started_pid

# POSIX sh has no portable wait-for-any-child operation. Polling keeps this
# script portable across Alpine/BusyBox versions and bounds detection to 1s.
while [ ! -f "$status_dir/winner" ]; do
  sleep 1
done

IFS=' ' read -r winner winner_status <"$status_dir/winner"
if [ "$winner" = gateway ]; then
  wait "$gateway_pid" 2>/dev/null || true
  gateway_pid=
else
  wait "$nginx_pid" 2>/dev/null || true
  nginx_pid=
fi

signal_children TERM
exit "$winner_status"
