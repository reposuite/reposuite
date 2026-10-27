#!/usr/bin/env bash
# Build the native binaries into packages/linux-x64/bin from pinned trees.
set -euo pipefail
: "${CONTROL_SHA:?}" "${GATEWAY_SHA:?}" "${RELAY_SHA:?}"
OUT=packages/linux-x64/bin
rm -rf "$OUT"; mkdir -p "$OUT"
(cd ../reposuite-gw && CGO_ENABLED=0 GOTOOLCHAIN=auto go build -buildvcs=false -trimpath \
  -o "$OLDPWD/$OUT/rsc-connector" ./cmd/rsc-connector)
(cd ../reposuite-gateway && CGO_ENABLED=1 GOTOOLCHAIN=auto go build -buildvcs=false -trimpath \
  -o "$OLDPWD/$OUT/reposuite-gateway" ./cmd/reposuite-gateway)
(cd ../reposuite-relay && CGO_ENABLED=0 GOTOOLCHAIN=auto go build -buildvcs=false -trimpath \
  -o "$OLDPWD/$OUT/reposuite-relay" ./cmd/reposuite-relay)
cat > "$OUT/PINS.txt" <<EOF2
control=$CONTROL_SHA
gateway=$GATEWAY_SHA
relay=$RELAY_SHA
built=$(date -u +%FT%TZ)
EOF2
chmod +x "$OUT"/{reposuite-gateway,reposuite-relay,rsc-connector}
echo "build: 3 binaries -> $OUT"
