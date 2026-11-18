#!/bin/sh
set -eu
runtime_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
artifacts=${HERMES_PLAYWRIGHT_ARTIFACTS:-$runtime_dir/artifacts}
mkdir -p "$artifacts"
cd "$artifacts"
export PLAYWRIGHT_BROWSERS_PATH="$runtime_dir/browsers"
exec node "$runtime_dir/node_modules/@playwright/mcp/cli.js" \
  --headless --browser chromium --no-sandbox --isolated \
  --output-dir "$artifacts" "$@"
