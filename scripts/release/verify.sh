#!/usr/bin/env bash
# Verify artifact hashes + that no private source/secrets leaked.
set -euo pipefail
OUT=release-artifacts
(cd "$OUT" && sha256sum -c SHA256SUMS)
# no Go source or secrets inside tarballs
for t in "$OUT"/*.tgz; do
  tar tzf "$t" | grep -E '\.go$|\.env|id_rsa|token' && { echo "verify: forbidden content in $t" >&2; exit 1; } || true
done
node -e "const p=require('./package.json'); if(!p.optionalDependencies) process.exit(1)"
echo "verify: artifacts clean + manifest consistent"
