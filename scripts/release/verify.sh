#!/usr/bin/env bash
# Verify artifact hashes + that no private source/secrets leaked.
set -euo pipefail
OUT=release-artifacts
(cd "$OUT" && sha256sum -c SHA256SUMS)
# no Go source or secrets inside tarballs
for t in "$OUT"/*.tgz; do
  if tar tzf "$t" | grep -E '\.go$|\.env|id_rsa|token' >/dev/null; then
    echo "verify: forbidden content in $t" >&2; exit 1
  fi
done
node -e "const p=require('./package.json'); if(!p.optionalDependencies) process.exit(1)"
# exactly two native binaries in the platform package, no connector
B=packages/linux-x64/bin
[ -x "$B/reposuite" ] || { echo "verify: canonical Rust CLI missing" >&2; exit 1; }
[ "$(ls "$B" | grep -c '^reposuite-')" = 2 ] || { echo "verify: platform package must carry exactly 2 service binaries" >&2; exit 1; }
[ ! -e "$B/rsc-connector" ] || { echo "verify: rsc-connector must not ship" >&2; exit 1; }
"$B/reposuite" version >/dev/null || { echo "verify: CLI not runnable" >&2; exit 1; }
echo "verify: artifacts clean + two-binary contract + manifest consistent"
