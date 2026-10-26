#!/usr/bin/env bash
# Builds lopper for opencode into one file and puts it where opencode loads plugins.
#
#   ./opencode/install.sh      → ~/.config/opencode/plugins/lopper.js
#
# Settings, all optional, in ~/.config/opencode/lopper.json:
#   { "threshold": 160000, "target": 90000, "recentTokens": 30000, "auto": true, "language": "it" }
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"

cd "$HERE"
npx esbuild opencode/plugin.ts --bundle --platform=node --format=esm --target=es2022 \
  --log-level=warning --outfile=dist/opencode/lopper.js
mkdir -p "$DEST"
cp dist/opencode/lopper.js "$DEST/lopper.js"
echo "installed -> $DEST/lopper.js"
if opencode --version 2>/dev/null | grep -q "v2\."; then opencode reload >/dev/null 2>&1 && echo "opencode 2: configuration reloaded"; else echo "restart opencode to load it"; fi
