#!/bin/sh
set -eu

/usr/local/bin/agent-compose-ui-server &

exec /docker-entrypoint.sh "$@"
