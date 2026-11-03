#!/usr/bin/env bash
# Validate version, exact pins, and clean source trees before a release.
set -euo pipefail
V="${1:-}"
[ -n "$V" ] || { echo "usage: prepare.sh <version>" >&2; exit 1; }
node -e "const v=require('./package.json').version; if(v!=='$V') {console.error('package.json version '+v+' != $V');process.exit(1)}"
[ -z "$(git status --porcelain --untracked-files=all)" ] || { echo "prepare: dirty or untracked distribution files" >&2; exit 1; }
: "${GATEWAY_SHA:?}" "${RELAY_SHA:?}"

for pair in "gateway:../reposuite-gateway:$GATEWAY_SHA" "relay:../reposuite-relay:$RELAY_SHA"; do
  name="${pair%%:*}"; rest="${pair#*:}"; dir="${rest%%:*}"; want="${rest##*:}"
  a=$(git -C "$dir" rev-parse HEAD 2>/dev/null) || { echo "prepare: $dir missing" >&2; exit 1; }
  [ "$a" = "$want" ] || { echo "prepare: $name SHA mismatch ($a != $want)" >&2; exit 1; }
  if [ -n "$(git -C "$dir" status --porcelain --untracked-files=all)" ]; then
    echo "prepare: $name tree dirty" >&2; exit 1
  fi
done

# CONTROL_SHA is an optional server-side pin only (no local binary built from it)
if [ -n "${CONTROL_SHA:-}" ]; then
  a=$(git -C ../reposuite-gw rev-parse HEAD 2>/dev/null) || { echo "prepare: control checkout missing" >&2; exit 1; }
  [ "$a" = "$CONTROL_SHA" ] || { echo "prepare: control SHA mismatch" >&2; exit 1; }
fi

cargo metadata --locked --no-deps --format-version 1 | node -e '
  let data = "";
  process.stdin.on("data", chunk => data += chunk);
  process.stdin.on("end", () => {
    const m = JSON.parse(data);
    const p = m.packages.find(p => p.name === "reposuite");
    if (!p || p.version !== process.argv[1]) {
      console.error("prepare: Rust CLI version does not match package version");
      process.exit(1);
    }
  });
' "$V"
node -e '
  if (require("./packages/linux-x64/package.json").version !== process.argv[1] ||
      require("./package.json").optionalDependencies["@reposuite/linux-x64"] !== process.argv[1]) {
    console.error("prepare: platform package version mismatch");
    process.exit(1);
  }
' "$V"

echo "prepare: v$V OK (gateway=${GATEWAY_SHA:0:7} relay=${RELAY_SHA:0:7})"
