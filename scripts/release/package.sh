#!/usr/bin/env bash
# Produce npm tarballs + a checksummed release manifest. Nothing published.
set -euo pipefail
OUT=release-artifacts; rm -rf "$OUT"; mkdir -p "$OUT"
npm pack --pack-destination "$OUT" >/dev/null
(cd packages/linux-x64 && npm pack --pack-destination "../../$OUT" >/dev/null)
(cd "$OUT" && sha256sum *.tgz > SHA256SUMS && cat > manifest.json <<EOF2
{
  "version": "$(node -p 'require("./package.json").version' 2>/dev/null || node -p 'require("../package.json").version' 2>/dev/null || echo unknown)",
  "pins": { "control": "${CONTROL_SHA:-}", "gateway": "${GATEWAY_SHA:-}", "relay": "${RELAY_SHA:-}" },
  "built": "$(date -u +%FT%TZ)"
}
EOF2
)
ls -la "$OUT"
