#!/usr/bin/env bash
# Post-install smoke on a clean environment (isolated HOME).
set -euo pipefail
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T" XDG_DATA_HOME="$T/.local/share" XDG_CONFIG_HOME="$T/.config" XDG_RUNTIME_DIR="$T/run"
npm install -g "$1" >/dev/null 2>&1 || npm install -g ./reposuite-*.tgz >/dev/null
reposuite version >/dev/null
reposuite doctor >/dev/null 2>&1 || true   # doctor fails closed without daemons — presence check only
echo "smoke: CLI installed and runnable in clean HOME"
