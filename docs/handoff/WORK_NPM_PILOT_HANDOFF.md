# WORK Pilot Handoff — RepoSuite `0.3.0-beta.1` (`beta`)

- **Date**: 2026-10-27
- **Target Host**: WORK PC (native Ubuntu 22.04.5 LTS `x86_64`)
- **Executor on WORK**: `rsg_help` (local WORK agent)
- **Execution Topology**:
  - **Lead (HOME PC)**: Owns planning, preparation, review, and orchestration; never accesses WORK directly.
  - **Planner (ChatGPT)**: Reviews this handoff before it reaches `rsg_help` and issues the final `rsg_help` execution prompt.
  - **rsg_help (WORK PC)**: Executes the bounded phases locally on WORK after Owner/Planner dispatch.
  - **Owner**: Manually transfers prompts/reports between agents and issues any required authorization or one-time pairing invite.

---

## 1. Objective & Scope

Execute a bounded, non-destructive end-to-end (E2E) pilot of the published npm release `reposuite@0.3.0-beta.1` on the native Ubuntu 22.04.5 WORK machine, proving the two-service local runtime (`reposuite-gateway` + `reposuite-relay` managed by the canonical Rust `reposuite` CLI via the frozen Node launcher) and the full cloud-to-native-agent path:

`ChatGPT / MCP Client → RepoSuite Control (https://app.reposuite.com/mcp) → WSS (wss://app.reposuite.com/gateway) → WORK Gateway → WORK Relay → Native Codex CLI → Durable Transcript`

### Release Baseline (Published on Public npm Registry)

| Package | Version | Dist-Tag | Tarball SHA-256 | Sigstore Rekor Log Index |
|---|---|---|---|---|
| `@reposuite/linux-x64` | `0.3.0-beta.1` | `beta` | `d52d25e400eb6f371d0808a2dfdbbcb921042fb3e3b401da8a8dc8b0dce9f7a8` | `3523023282` |
| `reposuite` | `0.3.0-beta.1` | `beta` | `336e1ccb6bcdc2a57119888fcb4bee8a992f6ce0811de22f5337e42e41dbe494` | `3523025197` |

- `reposuite` `dist-tags.latest` remains `0.1.0` (untouched).
- Published by GitHub Actions run [`40561580585`](https://github.com/reposuite/reposuite/actions/runs/40561580585) via OIDC Trusted Publishing after Owner approval of the protected `release` environment.

### Approved Source Pins Embedded in `0.3.0-beta.1` (`bin/PINS.txt`)

| Component | Repository | Commit SHA |
|---|---|---|
| Distribution (`reposuite` Rust CLI + Node launcher) | `reposuite/reposuite` | `93b1f1b29f0e72fbaf15ee39a45677645ba84f53` |
| Gateway (`reposuite-gateway`, embedded Cloud transport) | `rceman/reposuite-gateway` | `deec606ea7ed6623c666e6116fcc5b8db4257fca` |
| Relay (`reposuite-relay`, native agent session daemon) | `rceman/reposuite-relay` | `0aa45414668ca03a7abd8f1a1a0d80ae35ce8137` |

- Toolchains in `PINS.txt`: `go=go1.27.1`, `rust=rustc 1.93.1 (01f6ddf75 2026-02-11)`, `built=2026-10-27T17:46:58Z`.

---

## 2. Mandatory Safety Boundaries (Hard Rules for `rsg_help`)

1. **Preserve existing WORK state**:
   - Do **NOT** touch, read, stop, or modify `~/.airelay`, `AIRELAY_*`, existing Airelay sockets/PIDs/ports, or any running user/agent sessions.
   - Do **NOT** modify existing user repositories under `~/git` or elsewhere on WORK.
   - Do **NOT** kill or restart unrelated processes or `systemd` units.
2. **No privilege escalation or host reconfiguration**:
   - Do **NOT** run `sudo`, modify `/etc`, alter firewall/network rules, or install system packages.
   - Use a user-writable npm global prefix if the default `npm prefix -g` is root-owned (e.g., `/usr/local`).
3. **Disposable workspace isolation**:
   - Create and use only a dedicated disposable pilot Git repository under `/tmp/reposuite-work-pilot-repo` (or `${XDG_DATA_HOME:-$HOME/.local/share}/reposuite/pilot-workspace`).
   - Grant `--agent-exec true` **exclusively** to the single disposable pilot Project (`WORKPILOT`).
4. **Zero secret disclosure**:
   - Never place the Owner pairing invite (`inv_<id>.<secret>`), `gateway.json` credential, or Relay `api.token` in command-line arguments, environment variables, shell history, Git commits, stdout/stderr transcripts, or the final report.
   - Always run interactive shells with `HISTFILE=/dev/null` or `set +o history` around sensitive operations, and feed the invite exclusively through `/dev/tty` hidden prompt (`reposuite pair`) or standard input from an ephemeral `0600` file on `tmpfs` (`${XDG_RUNTIME_DIR}/reposuite-invite.tmp`) that is deleted immediately (`shred -u` / `rm -f`).
5. **No fabricated evidence**:
   - Never substitute CI results or `fixture` harness turns for a real native `codex` turn on WORK.
   - Stop immediately and escalate if any phase gate fails or if preflight detects conflicting state.

---

## 3. Known Pre-Execution Blocker Identified by Lead (Must Review Before Phase C)

Before issuing an Owner invite or running Phase C (`reposuite pair`), Planner and Owner must note the following code-verified wire mismatch between the published `reposuite-gateway@deec606` (`0.3.0-beta.1`) and `reposuite-control` (`feature/gateway-naming` deployed on `wss://app.reposuite.com/gateway`):

- **Root cause**:
  - In `rceman/reposuite-gateway@deec606` (`internal/cloud/rpc.go` lines 90–106), `GatewayHello` and `GatewayHelloResult` serialize the gateway identifier field as `json:"gateway_key,omitempty"`.
  - In `reposuite-control` (`feature/gateway-naming`, `internal/contract/types.go` lines 68–84 and `internal/gateway/gateway.go` lines 101–171), `GatewayHello` and `GatewayHelloResult` expect and emit `json:"gateway,omitempty"`.
- **Impact on Phase C (`reposuite pair`)**:
  1. When `reposuite pair` submits `inv_<id>.<secret>`, `wss://app.reposuite.com/gateway` accepts `InviteID` + `InviteToken`, **consumes the one-time invite**, and returns `{"ok":true,"gateway":"gw_<hex>","credential":"<secret>","epoch":1}`.
  2. `reposuite-gateway@deec606` unmarshals `GatewayHelloResult` looking for `"gateway_key"`, leaving `GatewayKey == ""` in `${XDG_DATA_HOME:-$HOME/.local/share}/reposuite/gateway/cloud/gateway.json`.
  3. Because `claimed()` requires both `gateway != ""` and `credential != ""`, `GET /v1/cloud/status` reports `"paired": false`, and `reposuite pair` fails after 15s with:
     `reposuite: pairing did not produce durable gateway identity (expired/refused invite?)`
  4. On subsequent reconnect (`resume`), `reposuite-gateway@deec606` sends `"gateway_key"` instead of `"gateway"`, which RSC rejects with `"invalid_hello"`.
- **Gate instruction**:
  - **Phase A (Read-only preflight)** and **Phase B (Installation & local two-service verification)** do **not** touch RSC or consume an invite and are safe to execute immediately once authorized.
  - **Phase C (Pairing)** and **Phase D (Cloud/MCP E2E)** MUST NOT be executed with a live Owner invite until either:
    1. `reposuite-control` on `app.reposuite.com` accepts/emits `gateway_key` alongside `gateway` in `GatewayHello`/`GatewayHelloResult`, **or**
    2. `0.3.0-beta.2` is published with `internal/cloud/rpc.go` aligned to `json:"gateway,omitempty"` (which simultaneously provides the second published version required for Phase E cross-version `update`/`rollback` testing).

---

## 4. Environment Assumptions & Prerequisites

- **OS / Arch**: Ubuntu 22.04.5 LTS `x86_64` (`linux/amd64`), `glibc >= 2.34` (Ubuntu 22.04 ships `glibc 2.35`).
- **Shared libraries**: `libsqlite3.so.0` installed (required by `reposuite-gateway`).
- **Node / npm**: Node.js `>= 18` (`v24.x` recommended) and `npm` available on `PATH`.
- **Service manager**: `systemd --user` active with an available `XDG_RUNTIME_DIR` (`/run/user/$(id -u)`).
- **Native agent**: `codex` CLI installed, on `PATH`, and already authenticated on WORK.
- **Network**: Outbound HTTPS (`443`) to `https://registry.npmjs.org` and `https://app.reposuite.com`, and outbound WSS (`443`) to `wss://app.reposuite.com/gateway`. No inbound ports are opened.

### Canonical XDG Runtime Layout on WORK

| Purpose | Path |
|---|---|
| Data root | `${XDG_DATA_HOME:-$HOME/.local/share}/reposuite` (`0700`) |
| Installed versions | `${XDG_DATA_HOME:-$HOME/.local/share}/reposuite/versions/<ver>/bin/{reposuite-gateway,reposuite-relay}` |
| Active version symlink | `${XDG_DATA_HOME:-$HOME/.local/share}/reposuite/current` |
| Gateway SQLite store | `${XDG_DATA_HOME:-$HOME/.local/share}/reposuite/gateway/store` (`0700`, strict store-file whitelist) |
| Gateway state & workspaces | `${XDG_DATA_HOME:-$HOME/.local/share}/reposuite/gateway/agent_workspaces.json` (`0600`) |
| Gateway cloud identity | `${XDG_DATA_HOME:-$HOME/.local/share}/reposuite/gateway/cloud/gateway.json` (`0600`) |
| Gateway env file | `${XDG_DATA_HOME:-$HOME/.local/share}/reposuite/gateway.env` (`0600`) |
| Relay home (`REPOSUITE_RSR_HOME`) | `${XDG_DATA_HOME:-$HOME/.local/share}/reposuite/relay` (`0700`) |
| Relay config & machine token | `${XDG_DATA_HOME:-$HOME/.local/share}/reposuite/relay/config/{relay.json,api.token}` (`0600`) |
| Relay runtime descriptor | `${XDG_DATA_HOME:-$HOME/.local/share}/reposuite/relay/run/daemon.json` (`0600`) |
| Gateway Owner Unix socket | `${XDG_RUNTIME_DIR}/reposuite/gateway.sock` |
| User systemd units | `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/reposuite-{gateway,relay}.service` |

---

## 5. Staged Execution Plan

Each phase is strictly gated. Record all command outputs (excluding secrets) for the final report. If any check fails, **STOP** immediately and do not proceed to the next phase.

---

### Phase A — Read-Only Preflight

**Authorization**: Safe read-only inspection; modifies zero files, processes, or network state.

#### Commands (`rsg_help` on WORK)

```bash
set -euo pipefail

echo "=== A1: OS, glibc, and libsqlite3 ==="
uname -srm
cat /etc/os-release | grep -E '^(NAME|VERSION)='
ldd --version | head -n 1
ldconfig -p | grep -F 'libsqlite3.so.0'

echo "=== A2: Node, npm, and global prefix writability ==="
node --version
npm --version
NPM_PREFIX="$(npm config get prefix)"
echo "npm_prefix=$NPM_PREFIX"
if [ -w "$NPM_PREFIX" ] || [ -w "$NPM_PREFIX/lib" ]; then
  echo "npm_prefix_writable=yes"
else
  echo "npm_prefix_writable=no (will use user prefix ~/.local)"
fi

echo "=== A3: systemd --user and linger status ==="
echo "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-UNSET}"
test -n "${XDG_RUNTIME_DIR:-}" && test -d "${XDG_RUNTIME_DIR}"
systemctl --user is-system-running || true
loginctl show-user "$(id -un)" -p Linger

echo "=== A4: Native provider CLIs ==="
for bin in codex devin opencode; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "provider $bin: $(command -v "$bin")"
  else
    echo "provider $bin: absent"
  fi
done
command -v codex >/dev/null 2>&1

echo "=== A5: Existing RepoSuite / legacy state and running services ==="
command -v reposuite || echo "reposuite_on_path=absent"
systemctl --user list-unit-files 'reposuite*' --no-pager || true
for p in \
  "${XDG_DATA_HOME:-$HOME/.local/share}/reposuite" \
  "${XDG_DATA_HOME:-$HOME/.local/share}/reposuite-gateway" \
  "${XDG_DATA_HOME:-$HOME/.local/share}/rsc-connector" \
  "$HOME/.reposuite"; do
  if [ -e "$p" ]; then
    echo "EXISTING_PATH: $p"
  else
    echo "clean: $p"
  fi
done

echo "=== A6: Verify ~/.airelay preservation baseline (read-only stat) ==="
if [ -e "$HOME/.airelay" ]; then
  stat -c 'airelay_present mode=%a mtime=%Y' "$HOME/.airelay"
else
  echo "airelay_present=no"
fi

echo "=== A7: Public registry & Cloud endpoint reachability ==="
npm view reposuite@beta version dist.shasum --json --registry=https://registry.npmjs.org
npm view @reposuite/linux-x64@beta version dist.shasum --json --registry=https://registry.npmjs.org
python3 - <<'PY'
import urllib.request
for url in ("https://app.reposuite.com/.well-known/oauth-protected-resource",):
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=10) as r:
        print(url, "HTTP", r.status)
PY
```

#### Phase A PASS / FAIL Criteria & Stop Conditions
- **PASS**:
  - Ubuntu 22.04.5 `x86_64`, `glibc >= 2.34`, `libsqlite3.so.0` present.
  - `node` (`>= 18`), `npm`, `systemctl --user`, `XDG_RUNTIME_DIR`, and `codex` available.
  - All four RepoSuite/legacy paths (`~/.local/share/reposuite`, `~/.local/share/reposuite-gateway`, `~/.local/share/rsc-connector`, `~/.reposuite`) are absent (`clean:`), and no `reposuite*` systemd units exist.
  - `npm view reposuite@beta` and `@reposuite/linux-x64@beta` resolve to `0.3.0-beta.1` with shasums `718995a4f6569efd80adf4c527189ae1859cbb5f` and `0e3aa9b908efe0e24ecd00a9a7f0dc8f608eb5f1` (`0e3aa9b908efe0e24ecd00a9a7f0dc8f608eb5d1`).
  - `https://app.reposuite.com/.well-known/oauth-protected-resource` returns `HTTP 200`.
- **STOP CONDITION**:
  - If any `EXISTING_PATH` or active `reposuite*` unit is found, **STOP immediately** and report to Owner/Lead before running `setup` or `migrate`.
  - If `systemctl --user` is unavailable or `codex` is missing, **STOP**.

---

### Phase B — Installation & Local Two-Service Verification

**Authorization Gate**: Proceed only after Phase A is `PASS` and Owner/Planner has authorized installation on WORK.

#### Commands (`rsg_help` on WORK)

```bash
set -euo pipefail

# 1. Use a user-writable global prefix without sudo if default prefix is not writable
NPM_PREFIX="$(npm config get prefix)"
if [ ! -w "$NPM_PREFIX" ]; then
  mkdir -p "$HOME/.local"
  npm config set prefix "$HOME/.local"
  export PATH="$HOME/.local/bin:$PATH"
fi

# 2. Install published beta from public npm registry
npm install -g --registry=https://registry.npmjs.org reposuite@0.3.0-beta.1

# 3. Verify CLI version and embedded PINS.txt before setup
test "$(reposuite version)" = "0.3.0-beta.1"
NPM_ROOT="$(npm root -g)"
cat "$NPM_ROOT/reposuite/node_modules/@reposuite/linux-x64/bin/PINS.txt"

# 4. Initialize versioned runtime and enable/start the two user services
reposuite setup

# 5. Verify systemd user services and local endpoints
systemctl --user is-active reposuite-gateway.service reposuite-relay.service
reposuite status

# 6. Pre-pair doctor check: pre-pair and services must be 'ok'; only 'gateway paired' is expected to be FAIL before Phase C
set +e
reposuite doctor
DOCTOR_RC=$?
set -e
echo "pre_pair_doctor_rc=$DOCTOR_RC"

# 7. Verify Gateway local status over Owner Unix socket and Relay local status
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite"
GW_BIN="$DATA_ROOT/current/bin/reposuite-gateway"
RL_BIN="$DATA_ROOT/current/bin/reposuite-relay"
SOCK="${XDG_RUNTIME_DIR}/reposuite/gateway.sock"

"$GW_BIN" status --socket "$SOCK"
"$GW_BIN" cloud status --socket "$SOCK"
REPOSUITE_HOME="$DATA_ROOT" "$RL_BIN" status --json

# 8. Confirm Relay binds only loopback (127.0.0.1) and directory/credential modes are strict (0700/0600)
LISTEN_PORT="$(python3 -c 'import json,os; p=os.path.expanduser("~/.local/share/reposuite/relay/config/relay.json"); print(json.load(open(p))["listenPort"])')"
ss -ltn "sport = :$LISTEN_PORT"
stat -c '%a %n' \
  "$DATA_ROOT" \
  "$DATA_ROOT/gateway" \
  "$DATA_ROOT/gateway/store" \
  "$DATA_ROOT/gateway/cloud" \
  "$DATA_ROOT/gateway.env" \
  "$DATA_ROOT/relay/config/api.token" \
  "$DATA_ROOT/relay/run/daemon.json"
```

#### Phase B PASS / FAIL Criteria & Stop Conditions
- **PASS**:
  - `reposuite version` outputs `0.3.0-beta.1`.
  - `PINS.txt` matches `distribution=93b1f1b29f0e72fbaf15ee39a45677645ba84f53`, `gateway=deec606ea7ed6623c666e6116fcc5b8db4257fca`, `relay=0aa45414668ca03a7abd8f1a1a0d80ae35ce8137`, `go=go1.27.1`, `rustc 1.93.1`.
  - `reposuite setup` prints `reposuite: setup complete (v0.3.0-beta.1) — run 'reposuite doctor', then 'reposuite pair'`.
  - `systemctl --user is-active reposuite-gateway.service reposuite-relay.service` outputs `active` for both; no `rsc-connector` binary or unit exists.
  - `reposuite doctor` shows `ok` for all 4 `pre-pair` checks, all 4 `services` checks, and `cloud transport enabled`, with `FAIL` **only** on `gateway paired (durable identity)`.
  - `"$GW_BIN" status --socket "$SOCK"` returns `{"ready":true,...}`.
  - `ss -ltn` shows Relay listening exclusively on `127.0.0.1:<LISTEN_PORT>`.
  - Directories are `700` and secret/config files (`gateway.env`, `api.token`, `daemon.json`) are `600`.
- **STOP CONDITION**:
  - Do **NOT** proceed to Phase C until the Section 3 wire-contract blocker is resolved AND the Owner provides a short-lived pairing invite (`inv_<id>.<secret>`).

---

### Phase C — First-Time Gateway Pairing & Cloud Connectivity

**Authorization Gate**: Requires (1) resolution of the Section 3 `gateway` vs `gateway_key` handshake field mismatch and (2) an Owner-issued short-lived (10-minute TTL) invite for WORK.

#### Secure Owner Invite Handling Procedure
1. **Never** pass `inv_<id>.<secret>` in `argv`, environment variables, shell history, or chat logs.
2. Preferred method (interactive TTY):
   - Run `reposuite pair` directly in an interactive terminal on WORK and paste the invite at the echo-disabled `/dev/tty` prompt (`invite (inv_<id>.<secret>): `). Note: `read_hidden` is fail-closed and aborts if terminal echo cannot be disabled.
3. Alternative method for non-interactive agent execution (`rsg_help`):
   - Owner writes the invite directly to a mode-`0600` file on `tmpfs` (`${XDG_RUNTIME_DIR}/reposuite-invite.tmp`) on WORK, or `rsg_help` pipes it over stdin without echoing and immediately deletes the file:
   ```bash
   set -euo pipefail
   INV_FILE="${XDG_RUNTIME_DIR}/reposuite-invite.tmp"
   # Verify file permissions are 0600 before reading, then pipe via stdin and delete immediately
   test "$(stat -c '%a' "$INV_FILE")" = "600"
   reposuite pair < "$INV_FILE"
   rm -f "$INV_FILE"
   ```

#### Post-Pair Verification Commands (`rsg_help` on WORK)

```bash
set -euo pipefail
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite"
GW_BIN="$DATA_ROOT/current/bin/reposuite-gateway"
SOCK="${XDG_RUNTIME_DIR}/reposuite/gateway.sock"

reposuite doctor
reposuite status

# Inspect cloud status (safe: does NOT print credential secret)
"$GW_BIN" cloud status --socket "$SOCK"

# Verify gateway.json permissions and non-empty gateway + credential fields without printing secret values
stat -c '%a %n' "$DATA_ROOT/gateway/cloud/gateway.json"
python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.local/share/reposuite/gateway/cloud/gateway.json")
d = json.load(open(p))
assert isinstance(d.get("gateway"), str) and d["gateway"].startswith("gw_"), "missing gateway key"
assert isinstance(d.get("credential"), str) and len(d["credential"]) >= 32, "missing credential"
assert isinstance(d.get("epoch"), int) and d["epoch"] >= 1, "invalid epoch"
print(f"gateway_json_valid=true gateway={d['gateway']} epoch={d['epoch']} credential_redacted=true")
PY
```

#### Phase C PASS / FAIL Criteria & Stop Conditions
- **PASS**:
  - `reposuite pair` reports `paired (gateway gw_...)` and `cloud ONLINE (authenticated WSS)`.
  - `reposuite doctor` exits `0` with every check (`pre-pair`, `services`, `cloud transport enabled`, `gateway paired (durable identity)`, `cloud ONLINE (authenticated WSS)`) reporting `ok`.
  - `reposuite status` shows both services `active`, `paired: yes`, `cloud online: yes (gw_...)`, `activated version: 0.3.0-beta.1`.
  - `gateway.json` has mode `600`, non-empty `gateway` (`gw_...`), redacted non-empty `credential`, and `epoch >= 1`.
  - Owner/Planner confirms the WORK Gateway appears **Online** in RepoSuite Control (`https://app.reposuite.com`) and via MCP `reposuite.gateway_status`.
- **STOP CONDITION**:
  - If `reposuite pair` or `reposuite doctor` fails, **STOP** immediately, capture `reposuite status` and `"$GW_BIN" cloud status --socket "$SOCK"`, and do not issue another invite until root cause is reviewed.

---

### Phase D — Disposable Pilot Project, Negative Auth & Real Native Codex E2E

**Authorization Gate**: Proceed only after Phase C is `PASS` and Owner authorizes binding the disposable pilot workspace `/tmp/reposuite-work-pilot-repo` with `--agent-exec true`.

#### D1. Create Disposable Pilot Git Workspace & Register Project on WORK

```bash
set -euo pipefail
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite"
GW_BIN="$DATA_ROOT/current/bin/reposuite-gateway"
SOCK="${XDG_RUNTIME_DIR}/reposuite/gateway.sock"
PILOT_WS="/tmp/reposuite-work-pilot-repo"

rm -rf "$PILOT_WS"
mkdir -p "$PILOT_WS"
git -C "$PILOT_WS" init -b main
git -C "$PILOT_WS" config user.name "WORK Pilot"
git -C "$PILOT_WS" config user.email "pilot@reposuite.local"
cat > "$PILOT_WS/PILOT_MARKER.txt" <<'EOF'
RepoSuite WORK E2E Pilot Marker: WORK_PILOT_OK_20261027
EOF
git -C "$PILOT_WS" add PILOT_MARKER.txt
git -C "$PILOT_WS" commit -m "chore: seed disposable WORK pilot marker"

# Create pilot project in WORK Gateway local authority
CREATE_JSON="$("$GW_BIN" project create \
  --socket "$SOCK" \
  --code WORKPILOT \
  --name "WORK Pilot Disposable" \
  --source-remote "https://github.com/reposuite/reposuite.git" \
  --source-branch main)"
echo "$CREATE_JSON"
PROJECT_KEY="$(printf '%s' "$CREATE_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["key"])')"
echo "PROJECT_KEY=$PROJECT_KEY"

"$GW_BIN" project list --socket "$SOCK"
```

#### D2. Negative Authorization Checks (Fail-Closed Admission Before Granting `agent_exec`)

Before binding `--agent-exec true`, prove that remote session creation fails closed in two negative states:

1. **Negative Case 1 — Unbound workspace (`project_workspace_not_bound`)**:
   - With `PROJECT_KEY` created in Gateway but not bound in `agent_workspaces.json` (and allowed in the Owner's RSC client grant), invoke MCP tool `reposuite.relay_session_create`:
     - Arguments: `{"gateway": "<GW_KEY>", "project": "<PROJECT_KEY>", "harness": "codex", "key": "work-neg-unbound"}`
     - Expected result: Fails closed with RPC error `-32004: project_workspace_not_bound`. Zero sessions created in Relay.
2. **Negative Case 2 — Workspace bound with `--agent-exec false` (`agent_exec_denied`)**:
   - On WORK, bind the workspace with `--agent-exec false`:
     ```bash
     "$GW_BIN" project bind-workspace \
       --socket "$SOCK" \
       --project "$PROJECT_KEY" \
       --path "$PILOT_WS" \
       --agent-exec false
     "$GW_BIN" project workspaces --socket "$SOCK"
     ```
   - Invoke MCP tool `reposuite.relay_session_create`:
     - Arguments: `{"gateway": "<GW_KEY>", "project": "<PROJECT_KEY>", "harness": "codex", "key": "work-neg-noexec"}`
     - Expected result: Fails closed with RPC error `-32003: agent_exec_denied`. Zero sessions created in Relay.
3. **Negative Case 3 — Unlisted project/gateway in RSC Grant**:
   - Invoke MCP tool `reposuite.project_read` or `reposuite.relay_session_create` with a project key not in the RSC client grant (`prj_0000000000000000`):
     - Expected result: Fails closed at RSC with `client grant denies project prj_0000000000000000`.

#### D3. Positive Real Native Codex Turn (`WORK → Gateway → RSC → Relay → Native Codex → Transcript`)

1. **Enable `--agent-exec true` for the disposable pilot Project only**:
   ```bash
   "$GW_BIN" project bind-workspace \
     --socket "$SOCK" \
     --project "$PROJECT_KEY" \
     --path "$PILOT_WS" \
     --agent-exec true
   "$GW_BIN" project workspaces --socket "$SOCK"
   ```
2. **Through Cloud / MCP (`https://app.reposuite.com/mcp`)**, execute:
   - `reposuite.gateway_status` (`{"gateway": "<GW_KEY>"}`) → verify `"online": true`, `"rsg_ok": true`, `"rsr_ok": true`.
   - `reposuite.projects_list` (`{"gateway": "<GW_KEY>"}`) → verify `<PROJECT_KEY>` is listed.
   - `reposuite.project_read` (`{"gateway": "<GW_KEY>", "project": "<PROJECT_KEY>"}`) → verify `"status": "active"`, `"summary": "code=WORKPILOT ..."`.
   - `reposuite.relay_session_create`:
     - Arguments: `{"gateway": "<GW_KEY>", "project": "<PROJECT_KEY>", "harness": "codex", "key": "work-pilot-codex-1"}`
     - Expected result: Returns `{"key": "work-pilot-codex-1", "session_id": "<id>", "state": "cold"}` (or active state).
   - `reposuite.relay_prompt`:
     - Arguments: `{"session": "work-pilot-codex-1", "text": "Read PILOT_MARKER.txt in the current working directory and reply with its exact marker token only. Do not modify any files."}`
     - Expected result: Returns `{"key": "work-pilot-codex-1", "accepted": true, "state": "submitted"}`.
   - Poll `reposuite.relay_transcript`:
     - Arguments: `{"session": "work-pilot-codex-1", "after": 0, "limit": 50}`
     - Expected result: Non-empty `records` containing `message.user` and native Codex turn completion (`message.agent.completed` / `turn.completed`) citing `WORK_PILOT_OK_20261027` from `/tmp/reposuite-work-pilot-repo/PILOT_MARKER.txt`, with `cursor > 0`.
3. **Verify on WORK local Relay & filesystem**:
   ```bash
   REPOSUITE_HOME="$DATA_ROOT" "$RL_BIN" status --json
   ls -la "$DATA_ROOT/relay/sessions/"
   git -C "$PILOT_WS" status --short
   ```
   - Confirm durable session directory exists under `$DATA_ROOT/relay/sessions/`, native `codex` executed in `cwd=/tmp/reposuite-work-pilot-repo`, and no native `codex app-server` socket/port is exposed outside `relayd`.

#### Phase D PASS / FAIL Criteria
- **PASS**:
  - All three negative authorization tests fail closed with the exact expected errors (`project_workspace_not_bound`, `agent_exec_denied`, `client grant denies project`).
  - Real `codex` session `work-pilot-codex-1` executes in `/tmp/reposuite-work-pilot-repo`, reads `PILOT_MARKER.txt`, and returns `WORK_PILOT_OK_20261027` in `reposuite.relay_transcript`.

---

### Phase E — Service Restart, Reconnection, Update/Rollback Gate & Pilot Cleanup

#### E1. Service Restart & Cloud Reconnection Verification

```bash
set -euo pipefail
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite"
GW_BIN="$DATA_ROOT/current/bin/reposuite-gateway"
RL_BIN="$DATA_ROOT/current/bin/reposuite-relay"
SOCK="${XDG_RUNTIME_DIR}/reposuite/gateway.sock"

# 1. Record pre-restart Relay port and Gateway epoch
PORT_BEFORE="$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.local/share/reposuite/relay/config/relay.json")))["listenPort"])')"
EPOCH_BEFORE="$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.local/share/reposuite/gateway/cloud/gateway.json")))["epoch"])')"

# 2. Restart both services via canonical CLI
reposuite restart
reposuite doctor
reposuite status

# 3. Verify stable Relay port, incremented WSS epoch, and COLD session recovery
PORT_AFTER="$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.local/share/reposuite/relay/config/relay.json")))["listenPort"])')"
EPOCH_AFTER="$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.local/share/reposuite/gateway/cloud/gateway.json")))["epoch"])')"
echo "port_before=$PORT_BEFORE port_after=$PORT_AFTER epoch_before=$EPOCH_BEFORE epoch_after=$EPOCH_AFTER"
test "$PORT_BEFORE" = "$PORT_AFTER"
test "$EPOCH_AFTER" -gt "$EPOCH_BEFORE"
REPOSUITE_HOME="$DATA_ROOT" "$RL_BIN" status --json
```

- After `reposuite restart`, verify via MCP `reposuite.relay_transcript` (`{"session": "work-pilot-codex-1", "after": 0, "limit": 50}`) that the durable transcript and watermark cursor survive the daemon restart intact.

#### E2. Update Check & Rollback Gate Verification

- **Prerequisites & Limitation**:
  - `reposuite rollback` requires at least two installed versions under `${XDG_DATA_HOME:-$HOME/.local/share}/reposuite/versions/` and zero active Relay sessions (`running_sessions == 0`).
  - When only `0.3.0-beta.1` is installed, `reposuite rollback` MUST fail closed with `reposuite: no previous version to roll back to` (exit code `1`) without disturbing active services.
  - Cross-version `update apply` + `rollback` on WORK is executed only when a second approved beta version (e.g., `0.3.0-beta.2`) is published.

```bash
set -euo pipefail
reposuite update check

# With only 0.3.0-beta.1 installed, verify rollback fails closed without stopping services
set +e
reposuite rollback
ROLLBACK_RC=$?
set -e
echo "single_version_rollback_rc=$ROLLBACK_RC"
test "$ROLLBACK_RC" = "1"
reposuite status
```

#### E3. Post-Pilot Disposable Workspace Cleanup (Preserving Paired Runtime)

Unbind the disposable pilot workspace, stop the test session, and remove `/tmp/reposuite-work-pilot-repo` so WORK does not retain `--agent-exec true` on a temporary directory:

```bash
set -euo pipefail
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite"
GW_BIN="$DATA_ROOT/current/bin/reposuite-gateway"
RL_BIN="$DATA_ROOT/current/bin/reposuite-relay"
SOCK="${XDG_RUNTIME_DIR}/reposuite/gateway.sock"

"$GW_BIN" project unbind-workspace --socket "$SOCK" --project "$PROJECT_KEY"
"$GW_BIN" project workspaces --socket "$SOCK"
REPOSUITE_HOME="$DATA_ROOT" "$RL_BIN" stop work-pilot-codex-1 || true
rm -rf /tmp/reposuite-work-pilot-repo
reposuite doctor
reposuite status
```

#### Failure Recovery & Emergency Uninstall Instructions (Only If Needed)
- **Stop services while keeping state and pairing**:
  `reposuite stop`
- **Remove systemd units and `current` activation symlink while preserving state/credentials**:
  `reposuite uninstall`
- **Full state removal of RepoSuite-owned directories only** (NEVER run unless explicitly instructed by Owner; never touches `~/.airelay`):
  `reposuite purge-state --yes`

---

## 6. Explicit Acceptance Criteria

The WORK pilot is accepted (`WORK_E2E_PASSED`) if and only if all of the following hold with verbatim command evidence from WORK:
1. **Preflight (Phase A)**: Ubuntu 22.04.5, `glibc 2.35`, `libsqlite3.so.0`, `systemd --user`, `codex`, and clean RepoSuite state verified; `~/.airelay` mtime/state unchanged before and after the pilot.
2. **Install & Services (Phase B)**: `npm install -g reposuite@0.3.0-beta.1` and `reposuite setup` activate `0.3.0-beta.1`; `reposuite-gateway.service` and `reposuite-relay.service` are `active`; `PINS.txt` matches the 3 approved SHAs; Relay listens only on `127.0.0.1:<port>`; state/credential modes are `0700`/`0600`.
3. **Pairing & Cloud Online (Phase C)**: `reposuite pair` succeeds without exposing the invite secret; `reposuite doctor` exits `0` (`ok` on all checks); WORK Gateway is Online in RSC (`reposuite.gateway_status`).
4. **Negative Auth & Real Native Codex Turn (Phase D)**:
   - Unbound project session create denied with `project_workspace_not_bound`.
   - `--agent-exec false` session create denied with `agent_exec_denied`.
   - Unlisted project denied by RSC grant allowlist.
   - Real native `codex` session (`work-pilot-codex-1`) created on `--agent-exec true` disposable workspace `/tmp/reposuite-work-pilot-repo`, prompt executed, and `reposuite.relay_transcript` returns the real native Codex response containing `WORK_PILOT_OK_20261027`.
5. **Restart, Reconnect & Cleanup (Phase E)**:
   - `reposuite restart` preserves Relay `listenPort`, increments Gateway WSS `epoch`, reconnects `cloud online: yes`, and preserves durable transcript history.
   - `reposuite update check` reports `installed 0.3.0-beta.1  channel 0.3.0-beta.1  (up to date)`.
   - Disposable workspace `/tmp/reposuite-work-pilot-repo` is unbound and removed after the test; `~/.airelay` remains untouched.

---

## 7. Required Evidence & Report Format from `rsg_help`

`rsg_help` must produce a structured markdown report containing:

```markdown
# WORK Pilot Execution Report — RepoSuite 0.3.0-beta.1

- Host: <uname -srm / Ubuntu version>
- Date (UTC): <ISO-8601>
- Installed Version: <reposuite version>
- PINS.txt: <verbatim PINS.txt>
- Gateway Key: <gw_...> (NO credentials or invite tokens)
- Pilot Project Key: <prj_...>

## Phase Results
- Phase A (Read-only preflight): PASS | FAIL — <evidence summary + verbatim output>
- Phase B (Installation & local services): PASS | FAIL — <evidence summary + verbatim output>
- Phase C (Pairing & Cloud Online): PASS | FAIL | BLOCKED — <evidence summary + doctor/status output>
- Phase D (Negative auth & real native Codex E2E): PASS | FAIL | BLOCKED — <negative error codes + session ID + transcript cursor/excerpt>
- Phase E (Restart/reconnect, update/rollback check & cleanup): PASS | FAIL | BLOCKED — <port/epoch before & after + cleanup confirmation>

## Safety Boundary Attestation
- ~/.airelay stat before vs after: <verbatim stat>
- Unrelated user repos/processes untouched: YES | NO
- Secrets redacted from all logs/history/outputs: YES | NO
- Final Verdict: WORK_E2E_PASSED | BLOCKED (<reason>)
```

---

## 8. Proposed Bootstrap Prompt for `rsg_help` (For Planner Review Only — Do Not Dispatch Directly)

```text
You are rsg_help executing on the native Ubuntu 22.04.5 WORK PC.

1. Before taking any action, fetch and read the committed WORK pilot handoff in `reposuite/reposuite`:
   - Branch: `pilot/work-handoff-0.3.0-beta.1`
   - File: `docs/handoff/WORK_NPM_PILOT_HANDOFF.md`
2. Obey all phase gates, stop conditions, and safety boundaries in `docs/handoff/WORK_NPM_PILOT_HANDOFF.md`:
   - Work exclusively on WORK PC.
   - Never touch `~/.airelay`, `AIRELAY_*`, existing user repositories, or unrelated running processes/sessions.
   - Never use `sudo`.
   - Never expose pairing invites (`inv_<id>.<secret>`), credentials, or bearer tokens in command arguments, environment variables, shell history, Git commits, or output logs.
   - Never fabricate E2E evidence from CI or `fixture` harness runs.
3. Execute only the explicitly authorized phases in order:
   - Start with Phase A (Read-only preflight) and verify every check.
   - If Phase A passes and Installation is authorized in your dispatch prompt, execute Phase B (`npm install -g reposuite@0.3.0-beta.1`, `reposuite setup`, local service and `doctor` verification).
   - Check the Section 3 pre-pairing gate before Phase C: do not consume an Owner invite unless the Section 3 wire-contract gate is cleared and the Owner has provided the invite via the secure local input mechanism.
   - If any check or gate fails, STOP immediately without expanding scope, preserve diagnostic evidence, and return the structured report from Section 7.
```
