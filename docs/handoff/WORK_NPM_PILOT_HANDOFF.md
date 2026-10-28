# WORK Pilot Handoff (v2) — RepoSuite `0.3.0-beta.1` / `0.3.0-beta.2`

- **Date**: 2026-10-27
- **Revision**: v2 (incorporates Planner `NEEDS_REWORK` fixes and verified RSC wire contract)
- **Target Host**: WORK PC (native Ubuntu 22.04.5 LTS `x86_64`)
- **Executor on WORK**: `rsg_help` (local WORK agent)
- **Execution Topology**:
  - **Lead (HOME PC)**: Owns planning, preparation, review, and orchestration; never accesses WORK directly.
  - **Planner (ChatGPT)**: Reviews this handoff before it reaches `rsg_help` and issues the final `rsg_help` execution prompt.
  - **rsg_help (WORK PC)**: Executes only the explicitly authorized phases locally on WORK.
  - **Owner**: Manually transfers prompts/reports between agents and issues any required authorization or one-time pairing invite.

---

## 1. Objective, Release Baseline & Wire-Contract Status

### 1.1 Objective
Execute a staged, non-destructive end-to-end (E2E) pilot of RepoSuite on the native Ubuntu 22.04.5 WORK machine, proving:
1. Read-only host compatibility and conflict preflight (**Phase A**).
2. Clean user-space installation and two-service (`reposuite-gateway` + `reposuite-relay`) lifecycle management (**Phase B**).
3. First-time Gateway pairing (`reposuite pair`) and authenticated Cloud WSS connectivity (**Phase C**, gated on `0.3.0-beta.2`).
4. Fail-closed negative authorization checks and a real native `codex` session turn (`ChatGPT / MCP → RSC → WSS → WORK Gateway → WORK Relay → Native Codex CLI → Durable Transcript`) in an isolated disposable workspace (**Phase D**).
5. Service restart/reconnection, cross-version `update apply` + `rollback` (`0.3.0-beta.1` ↔ `0.3.0-beta.2`), and verified disposable workspace cleanup (**Phase E**).

### 1.2 Published Registry Baseline (`0.3.0-beta.1` — Live on npm `beta`)

| Package | Version | Dist-Tag | Tarball SHA-256 | Tarball SHA-1 (`shasum`) | Rekor Log Index |
|---|---|---|---|---|---|
| `@reposuite/linux-x64` | `0.3.0-beta.1` | `beta` | `d52d25e400eb6f371d0808a2dfdbbcb921042fb3e3b401da8a8dc8b0dce9f7a8` | `0e3aa9b908efe0e24ecd00a9a7f0dc8f608eb5d1` | `3523023282` |
| `reposuite` | `0.3.0-beta.1` | `beta` | `336e1ccb6bcdc2a57119888fcb4bee8a992f6ce0811de22f5337e42e41dbe494` | `718995a4f6569efd80adf4c527189ae1859cbb5f` | `3523025197` |

- `reposuite` `dist-tags.latest` remains `0.1.0` (untouched).
- Embedded pins in `0.3.0-beta.1`:
  - `distribution=93b1f1b29f0e72fbaf15ee39a45677645ba84f53`
  - `gateway=deec606ea7ed6623c666e6116fcc5b8db4257fca`
  - `relay=0aa45414668ca03a7abd8f1a1a0d80ae35ce8137`

### 1.3 Verified Deployed RSC Revision & `0.3.0-beta.2` Wire Fix (Phase C Gate)

1. **Authoritative Deployed RSC Revision**:
   - Deployed from `/home/therceman/git/reposuite-gw` (`feature/gateway-naming` @ `4a828d2d73508fc98fb75f1e052fce17523ea7c0`) via `edge-infra/scripts/domains/reposuite/deploy_rsc.py`.
   - Canonical wire contract in `internal/contract/types.go` (lines 68–84) and `internal/gateway/gateway.go` (lines 101–171): `GatewayHello.GatewayKey` and `GatewayHelloResult.GatewayKey` use JSON key `"gateway"`.
2. **Live Non-Destructive WSS Probe Against `wss://app.reposuite.com/gateway`**:
   - Sending `{"jsonrpc":"2.0","id":"probe-1","method":"hello","params":{"gateway":"gw_0000000000000000","credential":"probe","epoch":1,"agent_version":"probe"}}` returns `{"jsonrpc":"2.0","id":"probe-1","result":{"ok":false,"epoch":0,"error":"gateway_unknown"}}` (proving `"gateway"` is parsed and reaches `g.resume`).
   - Sending `{"jsonrpc":"2.0","id":"probe-2","method":"hello","params":{"gateway_key":"gw_0000000000000000","credential":"probe","epoch":1,"agent_version":"probe"}}` returns `{"jsonrpc":"2.0","id":"probe-2","result":{"ok":false,"epoch":0,"error":"invalid_hello"}}` (proving `"gateway_key"` is rejected).
3. **Prepared `0.3.0-beta.2` Candidate (Not Yet Published)**:
   - `rceman/reposuite-gateway@ab6808dbe0d97916ffff7c0f535d2a94725d9b16` (branch `release/beta.2-hello-wire-fix`) aligns `GatewayHello.GatewayKey` and `GatewayHelloResult.GatewayKey` in `internal/cloud/rpc.go` to `json:"gateway,omitempty"` and adds `TestCanonicalWireHandshakeClaimPersistResumeReconnect` in `internal/cloud/race_test.go`.
   - `rceman/reposuite-relay@0aa45414668ca03a7abd8f1a1a0d80ae35ce8137` is unchanged.
   - `reposuite/reposuite` keeps `src/` and `bin/` byte-identical to `033fcfd72ebc14a57592903de7e34458e9ec4d83` and bumps package/CLI version to `0.3.0-beta.2`.

---

## 2. Mandatory Safety Boundaries (Hard Rules for `rsg_help`)

1. **Preserve existing WORK state**:
   - Do **NOT** touch, read, stop, or modify `~/.airelay`, `AIRELAY_*`, existing Airelay sockets/PIDs/ports, or any running user/agent sessions.
   - Do **NOT** modify existing user repositories under `~/git` or elsewhere on WORK.
   - Do **NOT** kill or restart unrelated processes or `systemd` units.
2. **No privilege escalation & no persistent npm config mutation**:
   - Do **NOT** run `sudo`, modify `/etc`, alter firewall/network rules, or install system packages.
   - Do **NOT** run `npm config set prefix` or mutate `~/.npmrc`. If the default `npm config get prefix` is not writable by the current user, pass `--prefix "$HOME/.local"` (or `NPM_CONFIG_PREFIX="$HOME/.local"`) per command invocation only.
3. **Unique disposable workspace with sentinel-guarded cleanup**:
   - Never run unconditional `rm -rf` on a fixed path.
   - Create the disposable pilot workspace with `mktemp -d /tmp/reposuite-work-pilot.XXXXXX` (which fails closed if creation cannot produce a fresh unique directory), write a sentinel file `.reposuite-work-pilot-sentinel` inside it, and remove the directory only after verifying the path pattern, non-symlink status, and sentinel contents.
   - Grant `--agent-exec true` **exclusively** to the single disposable pilot Project (`WORKPILOT`).
4. **Zero secret disclosure**:
   - Never place the Owner pairing invite (`inv_<id>.<secret>`), `gateway.json` credential, or Relay `api.token` in command-line arguments, environment variables, shell history, Git commits, stdout/stderr transcripts, or the final report.
   - Feed the invite exclusively through `/dev/tty` hidden prompt (`reposuite pair`) or standard input from an ephemeral `0600` file on `tmpfs` (`${XDG_RUNTIME_DIR}/reposuite-invite.tmp`) that is removed immediately (`rm -f`).
5. **No fabricated evidence**:
   - Never treat CI runs or `fixture` harness turns as proof of WORK E2E connectivity.

---

## 3. Execution Gates Summary

| Phase | Scope | Dispatch / Authorization Gate |
|---|---|---|
| **Phase A** | Read-only preflight on WORK | **Independently dispatchable now** (zero filesystem, service, or network mutations). |
| **Phase B** | Local npm install + `reposuite setup` + two-service health | Requires **Phase A = PASS** + explicit Owner authorization for WORK installation. |
| **Phase C** | First-time `reposuite pair` + Cloud Online verification | **Strictly BLOCKED** until `0.3.0-beta.2` (`gateway=ab6808dbe0d97916ffff7c0f535d2a94725d9b16`) is published, installed, and active on WORK **AND** Owner provides a fresh 10-minute invite. Never pair using `0.3.0-beta.1`. |
| **Phase D** | Negative auth checks + real native Codex E2E turn via MCP | Requires **Phase C = PASS** + Owner RSC grant for the WORK Gateway/Project + authorization to bind the disposable workspace with `--agent-exec true`. |
| **Phase E** | Restart/reconnect, `0.3.0-beta.1` ↔ `0.3.0-beta.2` rollback, & cleanup | Requires **Phase D = PASS**. Cross-version rollback requires both `0.3.0-beta.1` and `0.3.0-beta.2` staged under `versions/`. |

---

## 4. Staged Execution Instructions (`rsg_help` on WORK)

### Phase A — Read-Only Preflight (Independently Dispatchable)

**Authorization**: Read-only inspection; modifies zero files, configs, processes, or network state.

```bash
set -euo pipefail

echo "=== A1: OS, glibc, and libsqlite3 ==="
uname -srm
grep -E '^(NAME|VERSION)=' /etc/os-release
ldd --version | head -n 1
ldconfig -p | grep -F 'libsqlite3.so.0'

echo "=== A2: Node, npm, and default global prefix writability (read-only) ==="
node --version
npm --version
DEFAULT_NPM_PREFIX="$(npm config get prefix)"
echo "default_npm_prefix=$DEFAULT_NPM_PREFIX"
if [ -w "$DEFAULT_NPM_PREFIX" ] && { [ ! -e "$DEFAULT_NPM_PREFIX/lib/node_modules" ] || [ -w "$DEFAULT_NPM_PREFIX/lib/node_modules" ]; }; then
  echo "default_npm_prefix_writable=yes"
else
  echo "default_npm_prefix_writable=no (Phase B will use invocation-scoped --prefix \$HOME/.local)"
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
url = "https://app.reposuite.com/.well-known/oauth-protected-resource"
req = urllib.request.Request(url, method="GET")
with urllib.request.urlopen(req, timeout=10) as r:
    print(url, "HTTP", r.status)
PY
```

#### Phase A PASS / FAIL Criteria & Stop Conditions
- **PASS**:
  - Ubuntu 22.04.5 `x86_64`, `glibc >= 2.34`, `libsqlite3.so.0` present.
  - `node` (`>= 18`), `npm`, `systemctl --user`, `XDG_RUNTIME_DIR`, and `codex` available.
  - All four RepoSuite/legacy paths (`~/.local/share/reposuite`, `~/.local/share/reposuite-gateway`, `~/.local/share/rsc-connector`, `~/.reposuite`) report `clean:`, and no `reposuite*` systemd units exist.
  - Public npm registry is reachable (`for 0.3.0-beta.1`: `reposuite` shasum `718995a4f6569efd80adf4c527189ae1859cbb5f`, `@reposuite/linux-x64` shasum `0e3aa9b908efe0e24ecd00a9a7f0dc8f608eb5d1`; once `0.3.0-beta.2` is published, `npm view ...@beta` resolves to `0.3.0-beta.2`).
  - `https://app.reposuite.com/.well-known/oauth-protected-resource` returns `HTTP 200`.
- **STOP CONDITION**:
  - If any `EXISTING_PATH` or `reposuite*` unit is present, or if `systemctl --user` / `codex` is unavailable, **STOP immediately** and report to Owner/Planner.

---

### Phase B — Local Installation & Two-Service Verification

**Authorization Gate**: Requires **Phase A = PASS** and explicit Owner authorization for WORK installation.
- If `0.3.0-beta.2` is already published when Phase B is authorized, set `TARGET_VER="0.3.0-beta.2"` (or first install `0.3.0-beta.1` and run `reposuite setup`, then install `0.3.0-beta.2` and run `reposuite update apply` so both `versions/0.3.0-beta.1` and `versions/0.3.0-beta.2` are populated for Phase E rollback testing).
- Never mutate `~/.npmrc` via `npm config set prefix`; use `NPM_PREFIX_ARGS` per command.

```bash
set -euo pipefail

# 1. Determine invocation-scoped prefix without mutating ~/.npmrc
DEFAULT_NPM_PREFIX="$(npm config get prefix)"
if [ -w "$DEFAULT_NPM_PREFIX" ] && { [ ! -e "$DEFAULT_NPM_PREFIX/lib/node_modules" ] || [ -w "$DEFAULT_NPM_PREFIX/lib/node_modules" ]; }; then
  NPM_PREFIX="$DEFAULT_NPM_PREFIX"
  NPM_PREFIX_ARGS=()
else
  NPM_PREFIX="$HOME/.local"
  mkdir -p "$NPM_PREFIX"
  NPM_PREFIX_ARGS=(--prefix "$NPM_PREFIX")
fi
export PATH="$NPM_PREFIX/bin:$PATH"

# 2. Install published beta (0.3.0-beta.1 baseline, or 0.3.0-beta.2 once published)
TARGET_VER="${TARGET_VER:-$(npm view reposuite@beta version --registry=https://registry.npmjs.org)}"
npm install -g "${NPM_PREFIX_ARGS[@]}" --registry=https://registry.npmjs.org "reposuite@$TARGET_VER"

# 3. Verify CLI version, help output, and PINS.txt from actual installed @reposuite/linux-x64 location
INSTALLED_VER="$(reposuite version)"
echo "installed_version=$INSTALLED_VER"
test "$INSTALLED_VER" = "$TARGET_VER"
reposuite help | grep -q "setup"

NPM_GLOBAL_ROOT="$(npm root -g "${NPM_PREFIX_ARGS[@]}")"
PINS_FILE="$(NPM_GLOBAL_ROOT="$NPM_GLOBAL_ROOT" node -e '
const fs = require("fs");
const path = require("path");
const root = process.env.NPM_GLOBAL_ROOT;
const candidates = [
  path.join(root, "@reposuite", "linux-x64", "bin", "PINS.txt"),
  path.join(root, "reposuite", "node_modules", "@reposuite", "linux-x64", "bin", "PINS.txt"),
];
const found = candidates.find((p) => fs.existsSync(p));
if (!found) {
  console.error("PINS.txt not found in candidates:", candidates);
  process.exit(1);
}
console.log(found);
')"
echo "pins_file=$PINS_FILE"
cat "$PINS_FILE"

# 4. Initialize versioned runtime and enable/start the two user services
reposuite setup

# 5. Verify systemd user services and CLI status
systemctl --user is-active reposuite-gateway.service reposuite-relay.service
reposuite status

# 6. Pre-pair doctor check: pre-pair, services, and cloud transport enabled must be 'ok';
#    only 'gateway paired (durable identity)' is expected to be FAIL before Phase C.
set +e
DOCTOR_OUT="$(reposuite doctor)"
DOCTOR_RC=$?
set -e
printf '%s\n' "$DOCTOR_OUT"
echo "pre_pair_doctor_rc=$DOCTOR_RC"
test "$DOCTOR_RC" = "1"
printf '%s\n' "$DOCTOR_OUT" | grep -q " ok  linux platform"
printf '%s\n' "$DOCTOR_OUT" | grep -q " ok  native binaries"
printf '%s\n' "$DOCTOR_OUT" | grep -q " ok  provider cli (any)"
printf '%s\n' "$DOCTOR_OUT" | grep -q " ok  systemd --user"
printf '%s\n' "$DOCTOR_OUT" | grep -q " ok  gateway service active"
printf '%s\n' "$DOCTOR_OUT" | grep -q " ok  relay service active"
printf '%s\n' "$DOCTOR_OUT" | grep -q " ok  gateway socket live"
printf '%s\n' "$DOCTOR_OUT" | grep -q " ok  relay api.token 0600"
printf '%s\n' "$DOCTOR_OUT" | grep -q " ok  cloud transport enabled"
printf '%s\n' "$DOCTOR_OUT" | grep -q "FAIL gateway paired (durable identity)"

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
ss -ltn "sport = :$LISTEN_PORT" | grep -F "127.0.0.1:$LISTEN_PORT"
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
  - `reposuite version` equals `$TARGET_VER`; `~/.npmrc` is unmodified.
  - `PINS.txt` resolved dynamically from `@reposuite/linux-x64/bin/PINS.txt` matches the expected commit pins (`go=go1.27.1`, `rustc 1.93.1`).
  - `reposuite-gateway.service` and `reposuite-relay.service` are both `active`.
  - `reposuite doctor` reports `ok` on all 9 pre-pair/service/transport checks and `FAIL` only on `gateway paired (durable identity)`.
  - Relay listens only on `127.0.0.1:<LISTEN_PORT>`, directories are `700`, and `gateway.env`, `api.token`, `daemon.json` are `600`.
- **STOP CONDITION**:
  - **STOP before Phase C** unless `reposuite version` is `0.3.0-beta.2` (`PINS.txt` has `gateway=ab6808dbe0d97916ffff7c0f535d2a94725d9b16`) AND the Owner has issued a fresh pairing invite.

---

### Phase C — First-Time Gateway Pairing & Cloud Connectivity

**Authorization Gate**:
1. Active runtime on WORK **MUST** be `0.3.0-beta.2` (`gateway=ab6808dbe0d97916ffff7c0f535d2a94725d9b16`). Verify with `grep '^gateway=ab6808dbe0d97916ffff7c0f535d2a94725d9b16$' "$PINS_FILE"` and `test "$(reposuite version)" = "0.3.0-beta.2"`.
2. Owner has provided a fresh short-lived (10-minute TTL) invite (`inv_<id>.<secret>`) via the secure local input mechanism below.

#### Secure Owner Invite Handling & Pairing Commands (`rsg_help` on WORK)

```bash
set -euo pipefail
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite"
GW_BIN="$DATA_ROOT/current/bin/reposuite-gateway"
SOCK="${XDG_RUNTIME_DIR}/reposuite/gateway.sock"

# 1. Enforce 0.3.0-beta.2 wire-compatibility gate before touching any invite
test "$(reposuite version)" = "0.3.0-beta.2"
test "$(basename "$(readlink "$DATA_ROOT/current")")" = "0.3.0-beta.2"

# 2. Consume invite from mode-0600 tmpfs file via stdin (never argv/env/history/stdout) and remove immediately
INV_FILE="${XDG_RUNTIME_DIR}/reposuite-invite.tmp"
test -f "$INV_FILE"
test "$(stat -c '%a' "$INV_FILE")" = "600"
reposuite pair < "$INV_FILE"
rm -f "$INV_FILE"

# 3. Verify post-pair doctor (must exit 0) and status
reposuite doctor
reposuite status
"$GW_BIN" cloud status --socket "$SOCK"

# 4. Verify gateway.json mode (0600) and canonical keys without printing credential secret
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
  - `reposuite pair` outputs `paired (gateway gw_...)` and `cloud ONLINE (authenticated WSS)`.
  - `reposuite doctor` exits `0` with all checks (`gateway paired (durable identity)` and `cloud ONLINE (authenticated WSS)`) reporting `ok`.
  - `reposuite status` reports `paired: yes`, `cloud online: yes (gw_...)`, `activated version: 0.3.0-beta.2`.
  - `${XDG_RUNTIME_DIR}/reposuite-invite.tmp` no longer exists (`! -e`).
  - Owner/Planner confirms the WORK Gateway appears **Online** in RepoSuite Control (`reposuite.gateway_status`).
- **STOP CONDITION**:
  - If `reposuite pair` or `reposuite doctor` fails, **STOP** immediately and report `reposuite status` and `"$GW_BIN" cloud status --socket "$SOCK"` without requesting or consuming another invite.

---

### Phase D — Disposable Pilot Project, Negative Auth & Real Native Codex E2E

**Authorization Gate**: Requires **Phase C = PASS** and Owner authorization to create Project `WORKPILOT`, bind a unique disposable workspace with `--agent-exec true`, and grant the WORK Gateway + `WORKPILOT` Project in RepoSuite Control.

#### D1. Create Unique Disposable Pilot Workspace & Register Project on WORK

```bash
set -euo pipefail
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite"
GW_BIN="$DATA_ROOT/current/bin/reposuite-gateway"
SOCK="${XDG_RUNTIME_DIR}/reposuite/gateway.sock"

# Create a fresh unique directory under /tmp; mktemp -d fails closed if it cannot create a new directory
PILOT_WS="$(mktemp -d /tmp/reposuite-work-pilot.XXXXXX)"
chmod 700 "$PILOT_WS"
echo "PILOT_WS=$PILOT_WS"

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

# Write ownership sentinel recording both workspace path and project key for safe Phase E cleanup
cat > "$PILOT_WS/.reposuite-work-pilot-sentinel" <<EOF
owner=reposuite-work-pilot
project=$PROJECT_KEY
workspace=$PILOT_WS
EOF
chmod 600 "$PILOT_WS/.reposuite-work-pilot-sentinel"

"$GW_BIN" project list --socket "$SOCK"
```

#### D2. Negative Authorization Checks (Fail-Closed Admission Before Granting `agent_exec`)

1. **Negative Case 1 — Unbound workspace (`project_workspace_not_bound`)**:
   - With `PROJECT_KEY` created in Gateway and added to the Owner's RSC client grant, but **not** bound in `agent_workspaces.json`:
   - Invoke MCP tool `reposuite.relay_session_create` with `{"gateway": "<GW_KEY>", "project": "<PROJECT_KEY>", "harness": "codex", "key": "work-neg-unbound"}`.
   - **Expected**: Fails closed with `-32004: project_workspace_not_bound`.
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
   - Invoke MCP tool `reposuite.relay_session_create` with `{"gateway": "<GW_KEY>", "project": "<PROJECT_KEY>", "harness": "codex", "key": "work-neg-noexec"}`.
   - **Expected**: Fails closed with `-32003: agent_exec_denied`.
3. **Negative Case 3 — Unlisted project in RSC Client Grant**:
   - Invoke MCP tool `reposuite.project_read` with `{"gateway": "<GW_KEY>", "project": "prj_0000000000000000"}`.
   - **Expected**: Fails closed at RSC with `client grant denies project prj_0000000000000000`.

#### D3. Positive Real Native Codex Turn (`WORK → Gateway → RSC → Relay → Native Codex → Transcript`)

1. **Enable `--agent-exec true` for `$PROJECT_KEY` on `$PILOT_WS`**:
   ```bash
   "$GW_BIN" project bind-workspace \
     --socket "$SOCK" \
     --project "$PROJECT_KEY" \
     --path "$PILOT_WS" \
     --agent-exec true
   "$GW_BIN" project workspaces --socket "$SOCK"
   ```
2. **Execute through Cloud / MCP (`https://app.reposuite.com/mcp`)**:
   - `reposuite.gateway_status` (`{"gateway": "<GW_KEY>"}`) → `"online": true`, `"ready": true`.
   - `reposuite.projects_list` (`{"gateway": "<GW_KEY>"}`) → includes `<PROJECT_KEY>`.
   - `reposuite.project_read` (`{"gateway": "<GW_KEY>", "project": "<PROJECT_KEY>"}`) → `"status": "active"`, `"summary": "code=WORKPILOT ..."`.
   - `reposuite.relay_session_create` (`{"gateway": "<GW_KEY>", "project": "<PROJECT_KEY>", "harness": "codex", "key": "work-pilot-codex-1"}`) → returns `{"key": "work-pilot-codex-1", "session_id": "<id>", "state": "cold"}`.
   - `reposuite.relay_prompt` (`{"session": "work-pilot-codex-1", "text": "Read PILOT_MARKER.txt in the current working directory and reply with its exact marker token only. Do not modify any files."}`) → returns `{"key": "work-pilot-codex-1", "accepted": true, "state": "submitted"}`.
   - Poll `reposuite.relay_transcript` (`{"session": "work-pilot-codex-1", "after": 0, "limit": 50}`) until turn completion → verify `records` contain `message.user` and native Codex completion citing `WORK_PILOT_OK_20261027`, with `cursor > 0`.
3. **Verify on WORK local Relay**:
   ```bash
   REPOSUITE_HOME="$DATA_ROOT" "$RL_BIN" status --json
   REPOSUITE_HOME="$DATA_ROOT" "$RL_BIN" session status work-pilot-codex-1
   git -C "$PILOT_WS" status --short
   ```

---

### Phase E — Restart/Reconnection, Cross-Version Rollback & Sentinel-Guarded Cleanup

#### E1. Service Restart & Cloud Reconnection Verification

```bash
set -euo pipefail
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite"
RL_BIN="$DATA_ROOT/current/bin/reposuite-relay"

PORT_BEFORE="$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.local/share/reposuite/relay/config/relay.json")))["listenPort"])')"
EPOCH_BEFORE="$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.local/share/reposuite/gateway/cloud/gateway.json")))["epoch"])')"

reposuite restart
reposuite doctor
reposuite status

PORT_AFTER="$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.local/share/reposuite/relay/config/relay.json")))["listenPort"])')"
EPOCH_AFTER="$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.local/share/reposuite/gateway/cloud/gateway.json")))["epoch"])')"
echo "port_before=$PORT_BEFORE port_after=$PORT_AFTER epoch_before=$EPOCH_BEFORE epoch_after=$EPOCH_AFTER"
test "$PORT_BEFORE" = "$PORT_AFTER"
test "$EPOCH_AFTER" -gt "$EPOCH_BEFORE"
REPOSUITE_HOME="$DATA_ROOT" "$RL_BIN" status --json
```
- Confirm via MCP `reposuite.relay_transcript` (`{"session": "work-pilot-codex-1", "after": 0, "limit": 50}`) that the durable transcript and watermark cursor survive the restart intact.

#### E2. Update Check & Rollback Verification

```bash
set -euo pipefail
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite"
RL_BIN="$DATA_ROOT/current/bin/reposuite-relay"

reposuite update check

# Ensure zero active Relay sessions before testing rollback/update-apply
REPOSUITE_HOME="$DATA_ROOT" "$RL_BIN" stop work-pilot-codex-1 || true

# If both 0.3.0-beta.1 and 0.3.0-beta.2 are staged under versions/, test live rollback -> update-apply back to 0.3.0-beta.2:
if [ -d "$DATA_ROOT/versions/0.3.0-beta.1/bin" ] && [ -d "$DATA_ROOT/versions/0.3.0-beta.2/bin" ]; then
  reposuite rollback
  test "$(basename "$(readlink "$DATA_ROOT/current")")" = "0.3.0-beta.1"
  reposuite update apply
  test "$(basename "$(readlink "$DATA_ROOT/current")")" = "0.3.0-beta.2"
  reposuite doctor
else
  # Single-version guard check: must fail closed with exit code 1 without stopping services
  set +e
  reposuite rollback
  ROLLBACK_RC=$?
  set -e
  test "$ROLLBACK_RC" = "1"
  reposuite doctor
fi
```

#### E3. Sentinel-Guarded Disposable Workspace Cleanup

```bash
set -euo pipefail
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/reposuite"
GW_BIN="$DATA_ROOT/current/bin/reposuite-gateway"
SOCK="${XDG_RUNTIME_DIR}/reposuite/gateway.sock"

# 1. Unbind workspace in Gateway authority
"$GW_BIN" project unbind-workspace --socket "$SOCK" --project "$PROJECT_KEY"
"$GW_BIN" project workspaces --socket "$SOCK"

# 2. Verify pilot ownership sentinel and path invariants before removing disposable directory
case "$PILOT_WS" in
  /tmp/reposuite-work-pilot.??????) ;;
  *) echo "refusing cleanup: unexpected PILOT_WS path $PILOT_WS" >&2; exit 1 ;;
esac
test -d "$PILOT_WS" && test ! -L "$PILOT_WS"
test -f "$PILOT_WS/.reposuite-work-pilot-sentinel"
grep -qx "owner=reposuite-work-pilot" "$PILOT_WS/.reposuite-work-pilot-sentinel"
grep -qx "project=$PROJECT_KEY" "$PILOT_WS/.reposuite-work-pilot-sentinel"
grep -qx "workspace=$PILOT_WS" "$PILOT_WS/.reposuite-work-pilot-sentinel"

rm -rf -- "$PILOT_WS"
test ! -e "$PILOT_WS"
reposuite doctor
reposuite status
```

---

## 5. Required Evidence & Report Format from `rsg_help`

```markdown
# WORK Pilot Execution Report — RepoSuite

- Host: <uname -srm / Ubuntu version>
- Date (UTC): <ISO-8601>
- Installed Version: <reposuite version>
- PINS.txt Path & Content: <resolved path + verbatim PINS.txt>
- Gateway Key: <gw_...> (NO credentials or invite tokens)
- Pilot Project Key & Disposable Path: <prj_...> / </tmp/reposuite-work-pilot.XXXXXX>

## Phase Results
- Phase A (Read-only preflight): PASS | FAIL — <evidence summary + verbatim output>
- Phase B (Installation & local services): PASS | FAIL | NOT_AUTHORIZED — <evidence summary + verbatim output>
- Phase C (Pairing & Cloud Online): PASS | FAIL | BLOCKED — <evidence summary + doctor/status output>
- Phase D (Negative auth & real native Codex E2E): PASS | FAIL | BLOCKED — <negative error codes + session ID + transcript cursor/excerpt>
- Phase E (Restart/reconnect, rollback & sentinel cleanup): PASS | FAIL | BLOCKED — <port/epoch before & after + rollback result + cleanup confirmation>

## Safety Boundary Attestation
- ~/.airelay stat before vs after: <verbatim stat>
- ~/.npmrc unmodified: YES | NO
- Unrelated user repos/processes untouched: YES | NO
- Secrets redacted from all logs/history/outputs: YES | NO
- Final Verdict: WORK_PREFLIGHT_PASSED | WORK_LOCAL_INSTALL_PASSED | WORK_E2E_PASSED | BLOCKED (<reason>)
```

### 5.1 Durable Evidence Publishing (GitHub)

Publish each phase report to the dedicated private repo `rceman/reposuite-work-evidence`,
branch `main`, at `docs/pilots/work/phase-<X>.md` (append-only conventions, deploy-key
access, redaction gate and template in `docs/pilots/work/README.md` + `TEMPLATE.md`,
root commit `673f5384f5ab8ae72f7189b0022e0fbfe9f19794`). Use a dedicated SSH deploy key
(`~/.ssh/rsevidence`) and env-scoped `GIT_SSH_COMMAND`; never modify
`~/.gitconfig`, `~/.ssh/config`, or other WORK repo checkouts. If the deploy
key is not yet provisioned, write reports locally and push later — evidence
publishing never blocks an authorized phase.

---

## 6. Proposed Short Bootstrap Prompt for `rsg_help` (For Planner Review Only)

```text
You are rsg_help on the native Ubuntu 22.04.5 WORK PC.

1. Fetch `https://github.com/reposuite/reposuite.git` branch `pilot/work-handoff-0.3.0-beta.1` at commit `<COMMIT_SHA>` and read `docs/handoff/WORK_NPM_PILOT_HANDOFF.md` in full before acting.
2. Enforce all safety rules in Section 2:
   - Work only on WORK PC; never touch `~/.airelay`, `AIRELAY_*`, existing user repos, or unrelated services.
   - Never run `sudo` or `npm config set prefix` (use invocation-scoped `--prefix "$HOME/.local"` if needed).
   - Never expose invites (`inv_<id>.<secret>`), credentials, or tokens in argv, env, history, commits, or logs.
   - Use only `mktemp -d /tmp/reposuite-work-pilot.XXXXXX` with `.reposuite-work-pilot-sentinel` verification before cleanup.
3. Obey strict phase gates (Section 3):
   - Execute only the phase(s) explicitly authorized in this dispatch prompt.
   - Never run `reposuite pair` (Phase C) on `0.3.0-beta.1`; Phase C requires `0.3.0-beta.2` (`gateway=ab6808dbe0d97916ffff7c0f535d2a94725d9b16`) and a fresh Owner invite in `${XDG_RUNTIME_DIR}/reposuite-invite.tmp` (`0600`).
4. After each phase, publish its report to rceman/reposuite-work-evidence branch
   main at docs/pilots/work/phase-<X>.md per that branch's
   docs/pilots/work/README.md (dedicated deploy key + env-scoped
   GIT_SSH_COMMAND; redaction gate must pass; local-first if key pending).
5. Stop immediately on any failed check or stop condition without expanding scope, and return the Section 5 report.
```
