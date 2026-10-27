# WORK Pilot Handoff — RepoSuite npm Beta (two-service runtime)

Date: 2026-10-27 · Target: WORK PC (Ubuntu 22.04.5, native Linux)
Status: **candidate** — pending independent review verdict + Owner approval to publish.
Do not install on WORK before the Owner authorizes the published beta.

## What WORK gets

One npm install → ONE CLI (`reposuite`) → TWO local services:

| Component | Form |
|---|---|
| `reposuite` | **Rust CLI** (canonical; ships in the platform package) — setup/doctor/pair/status/start/stop/update/rollback/migrate/uninstall. The npm entry is a frozen dumb launcher (forwards argv/stdio/signals/exit only) |
| `reposuite-gateway` | native binary — local authority + **embedded cloud transport** |
| `reposuite-relay` | native binary — native agent sessions (Codex/Devin/OpenCode) |
| RSC Control | unchanged cloud service (VPS) — no local install |

The former `rsc-connector` binary/service is gone; its WSS/pairing/heartbeat/epoch
logic now runs inside Gateway (`internal/cloud`), optional and supervised, with
bounded exponential backoff. Gateway works fully offline.

## Exact pins (release candidate)

| Repo | Commit |
|---|---|
| `reposuite/reposuite` | `a2bd81f` (Rust CLI + frozen launcher + pipeline) |
| `rceman/reposuite-gateway` | `deec606` (feature/rsg-project-key-projection) |
| `rceman/reposuite-relay` | `9f1c9cc` (main) |

## Candidate artifacts (Lead-built, not yet published)

```
reposuite-0.3.0-beta.1.tgz                  sha256 336e1ccb6bcdc2a57119888fcb4bee8a992f6ce0811de22f5337e42e41dbe494
reposuite-linux-x64-0.3.0-beta.1.tgz        sha256 515e644e00880e12596d237d4d8f9a6bace603a833e023b8fd8b64d64703a00c
```

Reproduce from source (verified build): clone the three repos at the pins,
then `GATEWAY_SHA=… RELAY_SHA=… bash scripts/release/{prepare,build,package,verify}.sh`.
The builder refuses dirty/untracked/mismatched trees.

## Install sequence (after Owner approval + npm publish)

```bash
npm install -g reposuite@beta
reposuite setup          # versioned runtime + 2 systemd user services (no sudo)
reposuite doctor         # pre-pair checks; expect FAIL only on pairing/online
reposuite pair           # invite typed at a hidden prompt (or piped stdin) —
                         # travels only over the local Unix socket
reposuite status         # expect: paired yes, cloud online yes
```

Project-bound agent execution (Owner-approved pilot project only):

```bash
reposuite-gateway project create --code PILOT --name pilot \
  --source-remote <git-url> --source-branch main
reposuite-gateway project bind-workspace --project <key> \
  --path /abs/scratch/checkout --agent-exec true
```

Then create a native Codex session through RSC Cloud/MCP with
`project:<key>` — the connector resolves the admitted workspace; unbound or
unauthorized projects fail closed (`project_workspace_not_bound`,
`agent_exec_denied`).

## What must be proven ON WORK (not provable in CI)

1. Real first pairing with an Owner-issued invite (10-min TTL)
2. Gateway Online in RepoSuite Control (authenticated WSS, independently observed)
3. One real native Codex turn with a real transcript
4. Denial: unbound project and unauthorized workspace both fail closed
5. Service restart + reboot persistence (linger already enabled on WORK)
6. `npm update -g` + `reposuite update apply` and `rollback` across two published versions

## Proven in CI/local (not a substitute for the above)

- Two-binary contract, package installation smoke, lifecycle fault-injection
  (transactional activation/rollback), cloud state race test (`go test -race`),
  manifest/hash verification, connector-absent assertion.

## Boundaries

- No root, no inbound ports, no touching `~/.airelay` or existing agent sessions
- State: `~/.local/share/reposuite/` (unified), credentials 0600
- `reposuite uninstall` preserves state; `purge-state` requires explicit confirm

## Owner-only actions

1. Configure npm Trusted Publishing for BOTH packages (`reposuite`,
   `@reposuite/linux-x64`) and create the protected `release` environment
   with required reviewers.
2. Add repo secrets `RELEASE_KEY_GATEWAY`, `RELEASE_KEY_RELAY` (one deploy key
   per private repo) and var `GITHUB_SSH_KNOWN_HOSTS` (pinned host keys).
3. Approve the first beta publication.
4. Issue the WORK invite shortly before `reposuite pair` on WORK.
5. Authorize `rsg_help` to install and run the pilot.
