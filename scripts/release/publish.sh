#!/usr/bin/env bash
# Publish the EXACT verified tarballs in release-artifacts/ — never re-packs
# directories at publication. Requires --approve after review.
# Trusted Publishing (OIDC via CI) provides auth; no tokens here.
set -euo pipefail
[ "${1:-}" = "--approve" ] || { echo "publish: pass --approve after review" >&2; exit 1; }
TAG="${NPM_TAG:-beta}"
case "$TAG" in beta|latest) ;; *) echo "publish: invalid dist-tag $TAG" >&2; exit 1;; esac
V=$(node -p 'require("./package.json").version')
case "$V" in
  *-*)
    [ "$TAG" = beta ] || { echo "publish: prerelease $V may only use dist-tag beta" >&2; exit 1; } ;;
esac
ART="$PWD/release-artifacts"
ENTRY="$ART/reposuite-$V.tgz"
PLAT="$ART/reposuite-linux-x64-$V.tgz"
for t in "$ENTRY" "$PLAT"; do
  [ -f "$t" ] || { echo "publish: expected tarball missing: $t" >&2; exit 1; }
done

# Artifact gate runs immediately before any publish.
"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify.sh"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# registry_absent <spec>: returns 0 only on an explicit registry E404.
# Any other failure (network, auth, registry error) aborts — absence is
# never inferred from a generic error.
registry_absent() {
  local spec="$1" out="$TMP/view.json" err="$TMP/view.err"
  if npm view "$spec" version --json >"$out" 2>"$err"; then
    echo "publish: $spec already exists on npm — refusing to proceed" >&2
    return 1
  fi
  python3 - "$out" <<'PY'
import json, sys
try:
    doc = json.loads(open(sys.argv[1]).read())
except Exception:
    doc = {}
err = doc.get("error") if isinstance(doc, dict) else None
code = (err or {}).get("code") or doc.get("code")
if code != "E404":
    print("publish: registry check failed without E404 — aborting", file=sys.stderr)
    sys.exit(1)
PY
}

# Absence preflight runs for real and dry runs — only the post-publish
# dist-tag checks are skipped under DRY_RUN.
registry_absent "reposuite@$V"
registry_absent "@reposuite/linux-x64@$V"
if [ -z "${DRY_RUN:-}" ]; then
  # Existing latest must survive this publish untouched.
  npm view reposuite dist-tags.latest --json > "$TMP/latest.before" 2>"$TMP/latest.err" \
    || { echo "publish: could not read dist-tags.latest pre-flight" >&2; exit 1; }
fi

DRY=""; [ -n "${DRY_RUN:-}" ] && DRY="--dry-run"

# Platform package FIRST — the entry optionalDependency must resolve.
npm publish "$PLAT" --tag "$TAG" --access public --provenance --ignore-scripts $DRY
echo "publish: platform @reposuite/linux-x64@$V -> $TAG ${DRY_RUN:+(dry-run)}"
if ! npm publish "$ENTRY" --tag "$TAG" --access public --provenance --ignore-scripts $DRY; then
  echo "publish: PARTIAL_PUBLISH — platform published, entry FAILED; manual review required" >&2
  exit 1
fi
echo "publish: entry reposuite@$V -> $TAG ${DRY_RUN:+(dry-run)}"

if [ -z "${DRY_RUN:-}" ]; then
  npm view reposuite dist-tags.latest --json > "$TMP/latest.after" 2>"$TMP/latest.err" \
    || { echo "publish: could not re-read dist-tags.latest" >&2; exit 1; }
  if ! cmp -s "$TMP/latest.before" "$TMP/latest.after"; then
    echo "publish: dist-tags.latest changed during publish — refusing silent drift" >&2
    diff "$TMP/latest.before" "$TMP/latest.after" >&2 || true
    exit 1
  fi
  echo "publish: dist-tags.latest unchanged: $(tr -d '[:space:]' < "$TMP/latest.after")"
fi
echo "publish: $V -> $TAG ${DRY_RUN:+(dry-run)} complete"
