#!/usr/bin/env bash
# Build the native binaries into packages/linux-x64/bin from pinned trees.
set -euo pipefail
: "${GATEWAY_SHA:?}" "${RELAY_SHA:?}"
OUT=packages/linux-x64/bin
rm -rf "$OUT"; mkdir -p "$OUT"
# EXACTLY TWO binaries — the Connector is embedded in Gateway.
(cd ../reposuite-gateway && CGO_ENABLED=1 GOTOOLCHAIN=auto go build -buildvcs=false -trimpath \
  -o "$OLDPWD/$OUT/reposuite-gateway" ./cmd/reposuite-gateway)
(cd ../reposuite-relay && CGO_ENABLED=0 GOTOOLCHAIN=auto go build -buildvcs=false -trimpath \
  -o "$OLDPWD/$OUT/reposuite-relay" ./cmd/reposuite-relay)
cat > "$OUT/PINS.txt" <<EOF2
control=${CONTROL_SHA:-}
gateway=$GATEWAY_SHA
relay=$RELAY_SHA
built=$(date -u +%FT%TZ)
EOF2
chmod +x "$OUT"/{reposuite-gateway,reposuite-relay}
[ "$(ls "$OUT" | grep -c '^reposuite-')" = 2 ] || { echo "build: expected exactly 2 binaries" >&2; exit 1; }
echo "build: exactly 2 binaries -> $OUT"
