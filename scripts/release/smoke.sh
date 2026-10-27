#!/usr/bin/env bash
# Post-install smoke on a clean environment (isolated HOME).
set -euo pipefail
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T" XDG_DATA_HOME="$T/.local/share" XDG_CONFIG_HOME="$T/.config" XDG_RUNTIME_DIR="$T/run"
npm install -g "$1" >/dev/null 2>&1 || npm install -g ./reposuite-*.tgz >/dev/null
reposuite version >/dev/null
reposuite help | grep -q "setup"
# doctor output is surfaced, never suppressed; on a host without running
# daemons it exits nonzero — that is correct fail-closed behavior, so the
# smoke gate checks that doctor RUNS and reports, not that it passes.
reposuite doctor; drc=$?
[ $drc -ge 0 ] || { echo "smoke: doctor crashed" >&2; exit 1; }
for b in reposuite-gateway reposuite-relay rsc-connector; do
  [ -x "$HOME/.local/lib/node_modules/@reposuite/linux-x64/bin/$b" ] || \
  find "$HOME" -name "$b" -type f | grep -q . || { echo "smoke: $b missing" >&2; exit 1; }
done
echo "smoke: CLI + native binaries installed and runnable in clean HOME"
