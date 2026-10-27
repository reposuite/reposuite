# Releasing RepoSuite

Lifecycle: Development → RC → Tests → Independent Review → Approval → Publish → Smoke.

## Prepare
```bash
git checkout main && git status           # must be clean
export GATEWAY_SHA=<sha> RELAY_SHA=<sha>   # exact pins (CONTROL_SHA optional: server-side only)
bash scripts/release/prepare.sh <version>  # package.json == version, pins verified
```

## Build + test + package
```bash
bash scripts/release/build.sh      # native binaries -> packages/linux-x64/bin
node scripts/smoke-install.js      # packaging smoke (npm test)
bash scripts/release/package.sh    # tarballs + SHA256SUMS + manifest.json
bash scripts/release/verify.sh     # hashes, no secrets, metadata
```

## Publish (Owner-approved, after independent review)
- **CI path (preferred):** Actions → "release" → choose dist-tag (`beta`/`latest`);
  the protected `release` environment requires Owner approval before any step
  runs. Uses npm Trusted Publishing (OIDC) — no tokens in CI.
- **Local (requires npm auth):** `NPM_TAG=beta bash scripts/release/publish.sh --approve`
- `DRY_RUN=1` performs a non-publishing dry run.
- Publishing refuses to reuse an already-published version.
- GitHub Release: tag `v<version>`, attach `release-artifacts/` tarballs +
  `SHA256SUMS` + `manifest.json` (component SHAs).
- Never publish to `latest` without Owner approval.

## Post-publish smoke
`bash scripts/release/smoke.sh` — clean-HOME install + CLI sanity.
