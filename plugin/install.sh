#!/usr/bin/env bash
#
# Manual install for the Sandy plugin (DECISIONS Q3: git repo + manual install,
# no registry dependency). Copies the plugin into the host's plugin directory.
#
# Usage:
#   ./install.sh [--host claude] [--dir <plugin-dir>]
#
# Defaults: --host claude, --dir ~/.claude/plugins
# Set --dir to the plugin directory your host loads from (e.g. a Codex config
# dir) if you are not using Claude Code.

set -euo pipefail

HOST="claude"
PLUGIN_DIR="${HOME}/.claude/plugins"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --dir)  PLUGIN_DIR="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The plugin needs a built dist/ (the MCP server runs from it).
if [[ ! -f "${REPO_ROOT}/dist/plugin/mcp-server.js" ]]; then
  echo "dist/ not built — running 'npm ci && npm run build' first."
  (cd "$REPO_ROOT" && npm ci && npm run build)
fi

DEST="${PLUGIN_DIR}/sandy"
echo "Installing Sandy ${HOST} plugin -> ${DEST}"
mkdir -p "$DEST"
rm -rf "$DEST/plugin" "$DEST/dist"
cp -R "${REPO_ROOT}/plugin/.claude-plugin" "$DEST/.claude-plugin"
cp -R "${REPO_ROOT}/dist" "$DEST/dist"

# Keep the manifest's relative path (../dist) valid regardless of layout.
echo ""
echo "Installed. Next:"
echo "  1. Put your config in the project working directory as 'sandy.json'"
echo "     (or point SANDY_CONFIG at your config; the repo's 'config/' has a template)."
echo "  2. Ensure the MCP servers it declares are reachable from the sandbox."
echo "  3. In your host, add the plugin from '${DEST}' and run it INSIDE your"
echo "     sandbox (Sandy refuses to start without a boundary)."
echo ""
echo "Verify: node ${DEST}/dist/plugin/mcp-server.js <sandy.json>  (lists tools over stdio)"
