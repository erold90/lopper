#!/bin/sh
# Records one demo: demo/run.sh <script.json> <session id> <out.cast> [with-lopper|built-in]
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
mode=${4:-with-lopper}
plugin=""
[ "$mode" = "with-lopper" ] && plugin="--plugin-dir $here/plugin"
cd /private/tmp/lopper-demo/express
# A clean environment: nothing inherited from a Claude Code session this may run under.
for v in $(env | sed -n 's/^\(CLAUDE[A-Z_]*\)=.*/\1/p'); do unset "$v"; done
DISABLE_AUTOUPDATER=1 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
COLS=${COLS:-100} ROWS=${ROWS:-28} \
python3 "$here/demo/record.py" "$3" "$here/demo/$1" -- \
  "$HOME/.local/bin/claude" --resume "$2" --fork-session $plugin \
  --permission-mode default --setting-sources project,local \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
