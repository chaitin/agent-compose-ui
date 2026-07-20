#!/bin/sh
set -eu

entrypoint=$(CDPATH= cd "$(dirname "$0")" && pwd)/web-entrypoint.sh
tmp=$(mktemp -d "${TMPDIR:-/tmp}/web-entrypoint-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

make_child() (
  path=$1
  result=$2
  marker=$3
  cat >"$path" <<EOF
#!/bin/sh
trap 'printf killed >"$marker"; exit 143' TERM
trap 'printf killed >"$marker"; exit 130' INT
${result}
EOF
  chmod +x "$path"
)

run_signal_case() {
  signal=$1
  expected=$2
  make_child "$tmp/gateway" 'exec sleep 30' "$tmp/gateway.killed"
  make_child "$tmp/nginx" 'exec sleep 30' "$tmp/nginx.killed"
  set +e
  GATEWAY_COMMAND="$tmp/gateway" NGINX_ENTRYPOINT="$tmp/nginx" \
    timeout --preserve-status -s "$signal" 0.2 "$entrypoint"
  status=$?
  set -e
  [ "$status" -eq "$expected" ] || { echo "$signal status $status, want $expected" >&2; exit 1; }
}

run_child_case() {
  exiting=$1
  result=$2
  expected=$3
  rm -f "$tmp/gateway.killed" "$tmp/nginx.killed"
  if [ "$exiting" = gateway ]; then
    make_child "$tmp/gateway" "$result" "$tmp/gateway.killed"
    make_child "$tmp/nginx" 'while :; do sleep 1; done' "$tmp/nginx.killed"
    sibling_marker=$tmp/nginx.killed
  else
    make_child "$tmp/gateway" 'while :; do sleep 1; done' "$tmp/gateway.killed"
    make_child "$tmp/nginx" "$result" "$tmp/nginx.killed"
    sibling_marker=$tmp/gateway.killed
  fi
  set +e
  GATEWAY_COMMAND="$tmp/gateway" NGINX_ENTRYPOINT="$tmp/nginx" "$entrypoint"
  status=$?
  set -e
  [ "$status" -eq "$expected" ] || { echo "$exiting status $status, want $expected" >&2; exit 1; }
  [ -f "$sibling_marker" ] || { echo "$exiting exit did not stop sibling" >&2; exit 1; }
}

run_signal_case INT 130
rm -f "$tmp/gateway.killed" "$tmp/nginx.killed"
run_signal_case TERM 143
run_child_case gateway 'exit 0' 0
run_child_case nginx 'exit 7' 7
echo 'web-entrypoint tests passed'
