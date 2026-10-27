#!/usr/bin/env bash
# Verify the release-artifacts/ directory: tarball members, digests,
# manifest and pins. Artifact-only — never inspects packages/linux-x64/bin,
# so it runs identically in the publish job where only the downloaded
# tarballs exist. Requires GATEWAY_SHA and RELAY_SHA env pins.
set -euo pipefail
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_artifacts.py" "$@"
