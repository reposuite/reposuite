#!/usr/bin/env bash
# Produce npm tarballs + a checksummed release manifest. Nothing published.
set -euo pipefail
: "${GATEWAY_SHA:?}" "${RELAY_SHA:?}"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}"
DIST_SHA=$(git rev-parse HEAD)
V=$(node -p 'require("./package.json").version')
BUILT=$(date -u -d "@$SOURCE_DATE_EPOCH" +%FT%TZ)
OUT=release-artifacts; rm -rf "$OUT"; mkdir -p "$OUT"
npm pack --pack-destination "$OUT" >/dev/null
(cd packages/linux-x64 && npm pack --pack-destination "../../$OUT" >/dev/null)
(cd "$OUT" && sha256sum *.tgz > SHA256SUMS && cat > manifest.json <<EOF2
{
  "version": "$V",
  "pins": { "distribution": "$DIST_SHA", "control": "${CONTROL_SHA:-}", "gateway": "$GATEWAY_SHA", "relay": "$RELAY_SHA" },
  "built": "$BUILT"
}
EOF2
)
ls -la "$OUT"
