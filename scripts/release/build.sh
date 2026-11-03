#!/usr/bin/env bash
# Build the native binaries into packages/linux-x64/bin from pinned trees.
set -euo pipefail
: "${GATEWAY_SHA:?}" "${RELAY_SHA:?}"
GW_GO=go1.27.3
RELAY_GO=go1.27.1
for toolchain in "$GW_GO" "$RELAY_GO"; do
  [ "$(GOTOOLCHAIN="$toolchain" go env GOVERSION)" = "$toolchain" ] || {
    echo "build: $toolchain required" >&2; exit 1;
  }
done
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}"
BUILT=$(date -u -d "@$SOURCE_DATE_EPOCH" +%FT%TZ)
OUT=packages/linux-x64/bin
[ ! -e "$OUT" ] || { echo "build: $OUT exists; use a clean disposable checkout" >&2; exit 1; }
mkdir -p "$OUT"
# canonical CLI: Rust binary built from THIS repository (pinned by the
# repo commit itself); Node is only the npm launcher.
cargo build --release --locked --target x86_64-unknown-linux-musl
cp target/x86_64-unknown-linux-musl/release/reposuite "$OUT/reposuite"
# EXACTLY TWO binaries — the Connector is embedded in Gateway.
(cd ../reposuite-gateway && CGO_ENABLED=1 GOTOOLCHAIN="$GW_GO" go build -buildvcs=false -trimpath \
  -o "$OLDPWD/$OUT/reposuite-gateway" ./cmd/reposuite-gateway)
(cd ../reposuite-relay && CGO_ENABLED=0 GOTOOLCHAIN="$RELAY_GO" go build -buildvcs=false -trimpath \
  -o "$OLDPWD/$OUT/reposuite-relay" ./cmd/reposuite-relay)
cat > "$OUT/PINS.txt" <<EOF2
control=${CONTROL_SHA:-}
gateway=$GATEWAY_SHA
relay=$RELAY_SHA
distribution=$(git rev-parse HEAD)
go_gateway=$GW_GO
go_relay=$RELAY_GO
rust=$(rustc --version)
built=$BUILT
EOF2
chmod +x "$OUT"/{reposuite,reposuite-gateway,reposuite-relay}
[ "$("$OUT/reposuite" version)" = "$(node -p 'require("./package.json").version')" ] || {
  echo "build: CLI version does not match package" >&2; exit 1;
}
if readelf -l "$OUT/reposuite" | grep -q INTERP; then
  echo "build: CLI must be statically linked" >&2; exit 1
fi
# The supported pilot baseline is Ubuntu 22.04 (glibc 2.35).
readelf --version-info "$OUT/reposuite-gateway" | python3 -c '
import re, sys
versions = [tuple(map(int, v.split("."))) for v in re.findall(r"GLIBC_(\d+\.\d+)", sys.stdin.read())]
if not versions or max(versions) > (2, 35):
    sys.exit("build: gateway requires unsupported glibc: " + str(max(versions, default=None)))
'
[ "$(go version "$OUT/reposuite-gateway" | awk '{print $NF}')" = "$GW_GO" ] || { echo "build: gateway toolchain mismatch" >&2; exit 1; }
[ "$(go version "$OUT/reposuite-relay" | awk '{print $NF}')" = "$RELAY_GO" ] || { echo "build: relay toolchain mismatch" >&2; exit 1; }
[ "$(ls "$OUT" | grep -c '^reposuite')" = 3 ] || { echo "build: expected CLI + exactly 2 services" >&2; exit 1; }
echo "build: rust CLI + exactly 2 service binaries -> $OUT"
