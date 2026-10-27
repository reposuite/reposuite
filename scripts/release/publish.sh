#!/usr/bin/env bash
# Publish an APPROVED release. Requires --approve and a clean verify run.
# Prefers npm Trusted Publishing (OIDC via CI); local publish needs npm auth.
set -euo pipefail
[ "${1:-}" = "--approve" ] || { echo "publish: pass --approve after review" >&2; exit 1; }
TAG="${NPM_TAG:-beta}"
V=$(node -p 'require("./package.json").version')
npm view "reposuite@$V" version >/dev/null 2>&1 && { echo "publish: reposuite@$V already on npm" >&2; exit 1; }
npm view "@reposuite/linux-x64@$V" version >/dev/null 2>&1 && { echo "publish: linux-x64@$V already on npm" >&2; exit 1; }
# platform package FIRST — the entry pkg's optionalDependency must resolve
(cd packages/linux-x64 && npm publish --tag "$TAG" --access public ${DRY_RUN:+--dry-run})
npm publish --tag "$TAG" --access public ${DRY_RUN:+--dry-run}
echo "publish: $V -> $TAG ${DRY_RUN:+(dry-run)}"
