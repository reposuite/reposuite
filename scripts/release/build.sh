#!/usr/bin/env bash
# Build the native binaries into packages/linux-x64/bin from pinned trees.
set -euo pipefail
: "${GATEWAY_SHA:?}" "${RELAY_SHA:?}"
[ "$(go env GOVERSION)" = go1.27.1 ] || { echo "build: go1.27.1 required" >&2; exit 1; }
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}"
BUILT=$(date -u -d "@$SOURCE_DATE_EPOCH" +%FT%TZ)
OUT=packages/linux-x64/bin
rm -rf "$OUT"; mkdir -p "$OUT"
# canonical CLI: Rust binary built from THIS repository (pinned by the
# repo commit itself); Node is only the npm launcher.
cargo build --release --locked
cp target/release/reposuite "$OUT/reposuite"
# EXACTLY TWO binaries — the Connector is embedded in Gateway.
(cd ../reposuite-gateway && CGO_ENABLED=1 GOTOOLCHAIN=local go build -buildvcs=false -trimpath \
  -o "$OLDPWD/$OUT/reposuite-gateway" ./cmd/reposuite-gateway)
(cd ../reposuite-relay && CGO_ENABLED=0 GOTOOLCHAIN=local go build -buildvcs=false -trimpath \
  -o "$OLDPWD/$OUT/reposuite-relay" ./cmd/reposuite-relay)
cat > "$OUT/PINS.txt" <<EOF2
control=${CONTROL_SHA:-}
gateway=$GATEWAY_SHA
relay=$RELAY_SHA
distribution=$(git rev-parse HEAD)
go=$(go env GOVERSION)
rust=$(rustc --version)
built=$BUILT
EOF2
chmod +x "$OUT"/{reposuite,reposuite-gateway,reposuite-relay}
[ "$(ls "$OUT" | grep -c '^reposuite')" = 3 ] || { echo "build: expected CLI + exactly 2 services" >&2; exit 1; }
echo "build: rust CLI + exactly 2 service binaries -> $OUT"
