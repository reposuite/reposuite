# WORK Pilot Handoff — RepoSuite npm Beta (two-service runtime)

Date: 2026-10-27 · Target: WORK PC (Ubuntu 22.04.5, native Linux)
Status: **candidate verified, NOT PUBLISHED** — pending npm account auth +
Owner approval to publish. WORK is not authorized and was never accessed.
Do not install on WORK before the Owner authorizes the published beta.

## What WORK gets

One npm install → ONE CLI (`reposuite`) → TWO local services:

| Component | Form |
|---|---|
| `reposuite` | **Rust CLI** (canonical; ships in the platform package) — setup/doctor/pair/status/start/stop/update/rollback/migrate/uninstall. The npm entry is a frozen dumb launcher (forwards argv/stdio/signals/exit only) |
| `reposuite-gateway` | native binary — local authority + **embedded cloud transport** |
| `reposuite-relay` | native binary — native agent sessions (Codex/Devin/OpenCode) |

Exactly two Go services and one Rust CLI plus the dumb Node wrapper — no
connector, no second public CLI wrapper.

## Exact pins (release candidate)

| Repo | Commit |
|---|---|
| `reposuite/reposuite` | `93b1f1b29f0e72fbaf15ee39a45677645ba84f53` |
| `rceman/reposuite-gateway` | `deec606ea7ed6623c666e6116fcc5b8db4257fca` |
| `rceman/reposuite-relay` | `0aa45414668ca03a7abd8f1a1a0d80ae35ce8137` |

Relay pin contains only test changes vs approved `9f1c9cc` (zero runtime
diff). Distribution app source (`src`, `bin`, `Cargo.toml`, `Cargo.lock`,
`package.json`) is byte-unchanged vs approved `033fcfd`. Independent
review (Gemini 4 Argon): READY on `93b1f1b`+`51db8c9`, then narrow
re-review READY on `0aa4541`.

## Candidate artifacts (CI-built, NOT yet published)

Built by GitHub run
[40555513458](https://github.com/reposuite/reposuite/actions/runs/40555513458)
— all verification gates PASS, publish job SKIPPED (`publish=false`).
Workflow on main `a9cb934`; checkout pinned to distribution `93b1f1b`.

```
reposuite-0.3.0-beta.1.tgz                  sha256 336e1ccb6bcdc2a57119888fcb4bee8a992f6ce0811de22f5337e42e41dbe494
reposuite-linux-x64-0.3.0-beta.1.tgz        sha256 d52d25e400eb6f371d0808a2dfdbbcb921042fb3e3b401da8a8dc8b0dce9f7a8
```

Artifact `npm-beta-candidate` (ID 12757696002) is retained until
2026-11-03T18:01:07Z. A durable **draft (not published)**
[GitHub release](https://github.com/reposuite/reposuite/releases/tag/untagged-c84f5c5536ed1ef37d06)
for `v0.3.0-beta.1` carries exactly these bytes — pending
Owner approval, not publicly downloadable and NOT on npm.

The older platform tarball sha256
`515e644e00880e12596d237d4d8f9a6bace603a833e023b8fd8b64d64703a00c` is
superseded — **HELD, DO NOT PUBLISH** (Go 1.24.3 toolchain, pre-pin
layout); kept only as historical evidence.

Toolchains (from `BUILD_ENVIRONMENT.txt`): Go 1.27.1 for BOTH services;
rustc/cargo 1.93.1; gcc 11.4.0; built on Ubuntu 22.04 (glibc 2.35);
node v24.22.1; npm 11.21.1. Both dynamic binaries require at most
GLIBC_2.34 (Relay is static); Gateway needs `libsqlite3.so.0` present.
Two fresh `npm pack` repacks of the same payloads are byte-identical —
that proves archive determinism only, NOT full source→binary
reproducibility (hosted runner image/gcc/libsqlite can vary);
`SOURCE_DATE_EPOCH` removes PINS/manifest wall-clock variance.

## Proven in CI + local artifact verification

- Pinned private-source fetch (read-only deploy keys, pinned official
  github.com host fingerprint), source-freeze contract diffs.
- Rust release build; 29 release-script regression guards; CLI
  transactional lifecycle (12 assertions); install smoke (14 checks).
- Gateway `go test ./...` + `-race ./internal/cloud`; Relay full
  `go test ./...` + `-race ./...` (canonical token-budget gate PASS).
- Archive whitelist/hash/manifest/ELF verification — no Go/Rust source
  or secret material in archives; frozen Node launcher byte-identical.
- Clean-HOME tarball `npm install -g` on Ubuntu 22.04 in CI, repeated
  locally using downloaded artifacts; version/help work; `doctor` exits 1 with no daemons —
  this is expected, NOT a service-health claim.
- NOT RUN: real providers, signed-in Cloud, any WORK-side test.
  The standalone Relay ubuntu-latest PR CI still fails on separate
  fake-harness/timing tests — do not claim all repository CI green.

## GitHub/npm infra status

- `release` environment: main-only, required reviewer rceman (Owner),
  admin bypass disabled — the agent must NEVER approve.
- `release-build` environment: main-only, read-only deploy keys.
- Repo vars: `RELEASE_DISTRIBUTION_SHA`=93b1f1b…, `RELEASE_GATEWAY_SHA`=deec606…,
  `RELEASE_RELAY_SHA`=0aa4541…, `RELEASE_SSH_KNOWN_HOSTS` (the `GITHUB_`
  prefix is rejected by GitHub). Host fingerprint pinned:
  `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`. No Control checkout key.
- **npm Trusted Publishing is NOT configured**: `npm whoami` = ENEEDAUTH;
  public `reposuite` latest stays `0.1.0`; `@reposuite/linux-x64` is a
  public 404.
- Pending (agent owns setup; Owner does ONLY the interactive browser
  auth, the GitHub environment approval, and the explicit WORK
  authorization/invite):
  1. `npm login --auth-type=web --no-browser` — Owner completes the
     printed URL in a browser (Owner 2FA may require browser action).
  2. Ownership check + `0.0.0-bootstrap.0` bootstrap publish under a
     separate `bootstrap` tag — no approved version consumed, `latest`
     unmodified — only after explicit publication approval.
  3. `npm trust github` for both packages: `--file release.yml`,
     `--repo reposuite/reposuite`, `--env release`, `--allow-publish`
     only; no manual dist-tags or tokens.
  Bootstrap is described, not executed.

## Install sequence (FUTURE — after publish + Owner WORK authorization)

```bash
npm install -g reposuite@beta
reposuite version        # must print 0.3.0-beta.1
reposuite setup          # versioned runtime + 2 systemd user services (no sudo)
systemctl --user is-active reposuite-gateway.service reposuite-relay.service
reposuite doctor         # expect FAIL only on pairing/online before pair
reposuite pair           # invite entered interactively at the hidden prompt —
                         # never via argv/env/shell history/logs
reposuite status
```

## Project admin (FUTURE — Owner-approved project only)

Gateway's Go binary is not on PATH — always use explicit binary + socket:

```bash
GW="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite/current/bin/reposuite-gateway"
SOCK="${XDG_RUNTIME_DIR:?}/reposuite/gateway.sock"
"$GW" project create --socket "$SOCK" --code PILOT --name pilot \
  --source-remote <approved-git-url> --source-branch main
"$GW" project list --socket "$SOCK"
"$GW" project bind-workspace --socket "$SOCK" --project <key> \
  --path /abs/approved/checkout --agent-exec true
```

Every project call needs `--socket "$SOCK"` — the Go default socket path
differs from the Rust CLI-installed one. `--agent-exec true` may be granted
only by the local Owner (remote cannot grant). Cloud MCP endpoint:
`https://app.reposuite.com/mcp`; Gateway WSS: `wss://app.reposuite.com/gateway`.
Never run these commands before Owner authorization.

## What must be proven ON WORK (not provable in CI)

1. Real first pairing with an Owner-issued invite (10-min TTL)
2. Gateway Online in Control (authenticated WSS, independently observed)
3. One real native Codex turn: prompt → transcript → denial checks →
   reconnect/restart checklist
4. Denial: unbound project and unauthorized workspace fail closed
5. Service restart + reboot persistence
6. Update + rollback across two published versions — `reposuite rollback`
   is only valid once a second compatible version is installed and Relay
   has no active sessions; unknown state fails closed. Rollback is NOT
   available for the first installed version; pin `0.3.0-beta.1` for
   recovery once published. Never purge/uninstall active processes.

## Boundaries

- No root, no inbound ports, no touching `~/.airelay` or existing agent
  sessions; prior provider processes/Airelay remain untouched.
- State: `~/.local/share/reposuite/` (unified), credentials 0600.
- `reposuite uninstall` preserves state; `purge-state` requires explicit
  confirmation.
