# WORK beta.4 candidate handoff

Status: local candidate, **not published or deployed**. Do not execute the
upgrade until the artifact transfer and Control deployment gates below pass.
This is for `rsg_help` on WORK; HOME is not an execution host or proxy.

## Candidate and evidence

| Item | Immutable pin |
| --- | --- |
| Distribution | `330fe08e38a18c809cfb09c7e22ecd719189ae57` |
| Gateway | `134d4c8f0cd1418846356c740c9c6a815c88b784` |
| Relay | `0aa45414668ca03a7abd8f1a1a0d80ae35ce8137` |
| Local Control source, **not a deployed revision** | `456e15f34fb889c0ff8886ea34f8ca809e29bc94` |
| Gateway / Relay Go | `go1.27.3` / `go1.27.1` |
| Rust | `rustc 1.93.1`, static musl CLI |

Candidate files are currently on HOME under
`release-artifacts/0.3.0-beta.4-330fe08/`; transfer has not occurred. Older
beta.4 candidates in other directories are superseded and must not be used.
Obtain both
tarballs through an Owner-approved authenticated channel, and compare them
to these independently communicated hashes before using them:

```text
7ca9d917a9d360e5b59b461f153958126d7e0095b50d193b4c76ca6c1bbc6fa4  reposuite-0.3.0-beta.4.tgz
0c0d38444de564cb8af6fbfd6898524fb937449ed3be11ebb16cf9b9d0a54be3  reposuite-linux-x64-0.3.0-beta.4.tgz
```

Two independent clean local builds produced byte-identical tarballs. Artifact
verification, an offline clean-prefix npm install, Rust unit tests, 32 release
script tests, CLI lifecycle fault-injection, full Gateway tests including
`-race`, and Relay tests including `-race` passed. A minimal Debian container
without `libsqlite3.so.0` could not start Gateway: SQLite is an explicit
runtime prerequisite, not bundled. The Gateway build rejects glibc
requirements newer than 2.35; this is not a test on WORK or proof of an Ubuntu
22.04 deployment. Gateway's `version` says `dev` and Relay's says `0.1.0-dev`;
the artifact `PINS.txt`, not those strings, identifies their source revisions.

## Gates before touching WORK

1. The Owner or release operator confirms a trusted artifact delivery method;
   do not fetch the older beta.3 artifact or substitute an npm dist-tag.
2. Record the actual deployed Control/API and customer UI revisions. Confirm
   the matching backend and pairing UI are deployed and operational, and HOME
   remains Online. Local source or this document is not deployment evidence.
3. WORK's Owner confirms the intended maintenance window. `rsg_help` must
   preserve existing Relay sessions, Gateway credentials, projects, state,
   services and unrelated workloads. Do not stop sessions to force an upgrade.
4. The current active runtime must actually be beta.2. If it is not, a service
   is unhealthy, the Relay state is unknown, or beta.4 is already staged,
   **stop and report**; do not delete anything or improvise recovery.

## WORK preflight (read-only)

On WORK as the existing unprivileged user:

```bash
set -eu
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite"
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
printf 'architecture: '; uname -sm
printf 'glibc: '; getconf GNU_LIBC_VERSION
getconf GNU_LIBC_VERSION | awk '{ split($2,v,"."); if (v[1] < 2 || (v[1] == 2 && v[2] < 35)) exit 1 }'
printf 'node: '; node --version
node -e 'if (Number(process.versions.node.split(".")[0]) < 18) process.exit(1)'
printf 'npm: '; npm --version
systemctl --user is-active reposuite-gateway.service reposuite-relay.service
reposuite status
RELAY_STATUS="$(REPOSUITE_HOME="$DATA_ROOT" "$DATA_ROOT/current/bin/reposuite-relay" status --json)"
printf '%s\n' "$RELAY_STATUS"
printf '%s\n' "$RELAY_STATUS" | node -e '
let s = ""; process.stdin.on("data", x => s += x);
process.stdin.on("end", () => {
  const j = JSON.parse(s);
  if (j.status !== "running" || j.running !== true || j.apiAuthConfigured !== true ||
      !Number.isInteger(j.active) || j.active !== 0) {
    console.error("Relay is active, unreachable or not safely authenticated; stop.");
    process.exit(1);
  }
});'
printf 'active runtime: '; readlink "$DATA_ROOT/current"
test "$(basename "$(readlink "$DATA_ROOT/current")")" = "0.3.0-beta.2"
test -x "$DATA_ROOT/versions/0.3.0-beta.2/bin/reposuite-gateway"
test -x "$DATA_ROOT/versions/0.3.0-beta.2/bin/reposuite-relay"
test ! -e "$DATA_ROOT/versions/0.3.0-beta.4"
```

Require Linux x86_64, glibc >= 2.35, Node >= 18, working user systemd, both
services active, and known Relay status with **zero active sessions**. An
idle but preserved session is not a reason to delete it. Confirm WORK has
`libsqlite3.so.0` using the new binary's `ldd` check below. If any check fails,
stop; do not install OS packages, use sudo, remove state, or restart services.

## Install and upgrade (only after gates)

Set `ART` to the absolute directory containing the two transferred files.
The prefix below is user-owned; if it contains a non-RepoSuite `reposuite`
command, stop rather than replacing it.

```bash
set -eu
ART="/absolute/path/to/verified/artifacts"
PREFIX="$HOME/.local"
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite"
test "$(basename "$(readlink "$DATA_ROOT/current")")" = "0.3.0-beta.2"
test ! -e "$DATA_ROOT/versions/0.3.0-beta.4"
cd "$ART"
printf '%s  %s\n' \
  7ca9d917a9d360e5b59b461f153958126d7e0095b50d193b4c76ca6c1bbc6fa4 reposuite-0.3.0-beta.4.tgz \
  0c0d38444de564cb8af6fbfd6898524fb937449ed3be11ebb16cf9b9d0a54be3 reposuite-linux-x64-0.3.0-beta.4.tgz |
  sha256sum -c -
npm install -g --offline --ignore-scripts --no-audit --no-fund --prefix "$PREFIX" \
  "$ART/reposuite-linux-x64-0.3.0-beta.4.tgz" "$ART/reposuite-0.3.0-beta.4.tgz"
test "$("$PREFIX/bin/reposuite" version)" = "0.3.0-beta.4"
BIN="$PREFIX/lib/node_modules/@reposuite/linux-x64/bin"
grep -Fx 'distribution=330fe08e38a18c809cfb09c7e22ecd719189ae57' "$BIN/PINS.txt"
grep -Fx 'gateway=134d4c8f0cd1418846356c740c9c6a815c88b784' "$BIN/PINS.txt"
grep -Fx 'relay=0aa45414668ca03a7abd8f1a1a0d80ae35ce8137' "$BIN/PINS.txt"
LIBS="$(ldd -r "$BIN/reposuite-gateway")"
printf '%s\n' "$LIBS"
case "$LIBS" in *"not found"*|*"undefined symbol"*) exit 1 ;; esac
```

Stop if `ldd` reports any `not found`, if a pin/version differs, or if Relay
has active/unknown sessions. Confirm the beta.4 version directory is still
absent immediately before the next command. `update apply` may restart only
the two RepoSuite user services, and fails closed on active or unknown Relay
sessions. It preserves the old version for rollback.

```bash
test ! -e "$DATA_ROOT/versions/0.3.0-beta.4"
"$PREFIX/bin/reposuite" update apply
"$PREFIX/bin/reposuite" status
"$PREFIX/bin/reposuite" doctor
```

Expected: beta.4 active, both services healthy, previous beta.2 directory
preserved. Pairing may be the only expected `doctor` failure on an unpaired
WORK host. If activation or health checks fail, stop and report the sanitized
error and current status; do not remove directories or repeatedly retry. The
CLI attempts transactional rollback, but its result must be verified.

## Pairing and ACP verification

Only after the Control deployment gate and successful upgrade, run
`"$PREFIX/bin/reposuite" pair --label "Work Linux" --key WRK` on WORK. The
Owner personally reviews and approves the request in the browser; device
suggestions are untrusted and editable. Never share credentials, cookies,
OTP codes, device secrets or unredacted logs. Confirm WORK's own Gateway
reports authenticated WSS Online; HOME's status is not evidence for WORK.
If WORK is already paired, inspect its existing identity first; do not revoke
or recreate it to make the suggested key fit.

For the real Devin ACP test, after verifying that the Relay service is still
running and the real `devin` CLI is authenticated, use a new isolated session:

```bash
set -eu
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite"
export REPOSUITE_HOME="$DATA_ROOT"
R="$DATA_ROOT/current/bin/reposuite-relay"
systemctl --user is-active reposuite-relay.service
"$R" status --json
command -v devin
KEY="wrk-swe2-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
TEST_CWD="$(mktemp -d "${XDG_RUNTIME_DIR:?}/reposuite-acp-check.XXXXXX")"
cd "$TEST_CWD"
"$R" serve devin --key "$KEY" --model swe-2-high
"$R" session status "$KEY"
"$R" prompt "$KEY" --text "Reply with exactly WORK-ACP-OK. Do not use tools."
```

The generated key is new; if creation reports a collision, stop rather than
changing or deleting an existing session. The prompt command only reports
acceptance, not completion. In the local Relay Web Admin, inspect that session
and confirm a completed agent response containing `WORK-ACP-OK`; record the
observed vendor/model and runtime evidence separately from desired config.
If the actual model cannot be verified, report it as unverified. Do not use
the Codex-only per-turn `--model` option, share native IDs/cookies/secrets, or
delete or stop existing sessions. Do not claim success from a fake adapter.
Plan the SGS Lead transition only after this WORK evidence.
