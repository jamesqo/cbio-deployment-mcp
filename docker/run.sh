#!/usr/bin/env bash
set -eu
# Linux Docker Engine launcher for stdio MCP. Pass local repo/study directories
# as arguments; they are exposed read-only at their original absolute paths.
# Build first: docker build -t cbio-deployment-mcp:local .
# Example: ./docker/run.sh /home/james/work/cbioportal /path/to/studies
# Docker socket access permits managing the host's containers. No DinD daemon.
if [ "$(uname -s)" != Linux ]; then
  echo "This launcher requires Linux host networking." >&2
  exit 1
fi
daemon=${DOCKER_HOST:-unix:///var/run/docker.sock}
case "$daemon" in
  unix:///*) socket=${daemon#unix://} ;;
  *) echo "Only a local Unix Docker socket is supported." >&2; exit 1 ;;
esac
if [ ! -S "$socket" ]; then
  echo "Docker socket not found: $socket" >&2
  exit 1
fi
image=${CBIO_MCP_IMAGE:-cbio-deployment-mcp:local}
docker --host "$daemon" image inspect "$image" >/dev/null
state=$(realpath -m "${CBIO_MCP_HOME:-$HOME/.local/share/cbio-deployment-mcp}")
mkdir -p "$state"
chmod 700 "$state"
# Accumulate mounts without shell eval. Using identical paths lets sibling
# Docker containers mount runtime files created by this MCP container.
mount_args=()
for path in "$@"; do
  path=$(realpath -e "$path")
  mount_args+=(--mount "type=bind,src=$path,dst=$path,readonly")
done
exec docker --host "$daemon" run --rm -i --init --network host --memory 512m \
  --user "$(id -u):$(id -g)" --group-add "$(stat -c %g "$socket")" \
  --mount "type=bind,src=$socket,dst=$socket" \
  --mount "type=bind,src=$state,dst=$state" \
  -e "DOCKER_HOST=$daemon" -e "CBIO_MCP_HOME=$state" \
  "${mount_args[@]}" "$image"
