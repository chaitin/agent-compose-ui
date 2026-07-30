#!/bin/sh
set -eu
cd "$(dirname "$0")"
: "${ALL_IN_ONE_TAG:=agent-compose-all-in-one:latest}"
: "${REGISTRY_MIRROR:=docker.io}"
: "${BUN_IMAGE:=oven/bun:1}"
export ALL_IN_ONE_TAG
engine_image=agent-compose-engine:bundle-build
guest_image=agent-compose-guest:bundle-build

docker build --build-arg "REGISTRY_MIRROR=$REGISTRY_MIRROR" -t "$engine_image" -f ../../agent-compose/Dockerfile ../../agent-compose
docker build --build-arg "REGISTRY_MIRROR=$REGISTRY_MIRROR" -t "$guest_image" -f ../../agent-compose/guest-images/Dockerfile.agent-compose-guest ../../agent-compose
docker build \
  --build-arg "ENGINE_IMAGE=$engine_image" \
  --build-arg "GUEST_IMAGE=$guest_image" \
  --build-arg "REGISTRY_MIRROR=$REGISTRY_MIRROR" \
  --build-arg "BUN_IMAGE=$BUN_IMAGE" \
  -t "$ALL_IN_ONE_TAG" \
  -f Dockerfile.all-in-one \
  ../..
AGENT_COMPOSE_ALL_IN_ONE_IMAGE="$ALL_IN_ONE_TAG" \
  docker compose -f docker-compose.all-in-one.yml up -d
