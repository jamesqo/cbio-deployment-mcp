#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=${1:?Usage: install.sh /absolute/path/to/persistent/playwright-directory}
case "$target" in /*) ;; *) echo 'Target must be absolute' >&2; exit 1;; esac
mkdir -p "$target"
if [ "$(cd "$target" && pwd)" != "$source_dir" ]; then
  cp -f "$source_dir/package.json" "$source_dir/package-lock.json" "$source_dir/run.sh" "$target/"
fi
npm ci --prefix "$target" --ignore-scripts --no-audit --no-fund
PLAYWRIGHT_BROWSERS_PATH="$target/browsers" \
  node "$target/node_modules/playwright/cli.js" install chromium
chmod 755 "$target/run.sh"
