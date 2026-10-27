#!/usr/bin/env bash
# Validate version, pins, and clean source trees before a release.
set -euo pipefail
V="${1:-}"
[ -n "$V" ] || { echo "usage: prepare.sh <version>" >&2; exit 1; }
node -e "const v=require('./package.json').version; if(v!=='$V') {console.error('package.json version '+v+' != $V');process.exit(1)}"
[ -n "$(git status --porcelain)" ] && { echo "prepare: dirty tree" >&2; exit 1; }
: "${CONTROL_SHA:?}" "${GATEWAY_SHA:?}" "${RELAY_SHA:?}"
for s in control:$CONTROL_SHA gateway:$GATEWAY_SHA relay:$RELAY_SHA; do
  d="../reposuite-${s%%:*}"; [ "$d" = "../reposuite-control" ] || d="../reposuite-${s%%:*}"
  [ "${s%%:*}" = "control" ] && d="../reposuite-gw"
  [ "${s%%:*}" = "gateway" ] && d="../reposuite-gateway"
  [ "${s%%:*}" = "relay" ] && d="../reposuite-relay"
  a=$(git -C "$d" rev-parse HEAD 2>/dev/null) || { echo "prepare: $d missing" >&2; exit 1; }
  [ "$a" = "${s##*:}" ] || { echo "prepare: ${s%%:*} SHA mismatch ($a != ${s##*:})" >&2; exit 1; }
done
echo "prepare: v$V OK (control=${CONTROL_SHA:0:7} gateway=${GATEWAY_SHA:0:7} relay=${RELAY_SHA:0:7})"
