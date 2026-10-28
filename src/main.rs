// reposuite — canonical RepoSuite CLI (Rust). Manages the per-user runtime:
// versioned binary dirs, two systemd user services (gateway + relay, where
// gateway embeds the cloud transport), protected pairing over the owner-only
// Unix socket, transactional activation/rollback. The Node npm entry is only
// a launcher that forwards to this binary.
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const OWNED_BINS: [&str; 2] = ["reposuite-gateway", "reposuite-relay"];
const OWNED_UNITS: [&str; 2] = ["reposuite-gateway.service", "reposuite-relay.service"];

fn home() -> PathBuf { PathBuf::from(env::var("HOME").unwrap_or_else(|_| "/".into())) }
fn xdg(var: &str, def: &str) -> PathBuf {
    env::var(var).map(PathBuf::from).unwrap_or_else(|_| home().join(def))
}
struct Paths {
    root: PathBuf, versions: PathBuf, current: PathBuf, gateway: PathBuf,
    relay: PathBuf, env_file: PathBuf, socket: PathBuf, units: PathBuf,
}
fn paths() -> Paths {
    let data = xdg("XDG_DATA_HOME", ".local/share");
    let conf = xdg("XDG_CONFIG_HOME", ".config");
    let run = env::var("XDG_RUNTIME_DIR").map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".reposuite/run"));
    let root = data.join("reposuite");
    Paths {
        versions: root.join("versions"), current: root.join("current"),
        gateway: root.join("gateway"), relay: root.join("relay"),
        env_file: root.join("gateway.env"), socket: run.join("reposuite/gateway.sock"),
        units: conf.join("systemd/user"), root,
    }
}
fn die(msg: &str) -> ! { eprintln!("reposuite: {msg}"); std::process::exit(1) }
fn ok(msg: &str) { println!("reposuite: {msg}") }
fn mkdir700(p: &Path) { let _ = fs::create_dir_all(p); let _ = fs::set_permissions(p, fs::Permissions::from_mode(0o700)); }
fn have(cmd: &str) -> bool {
    env::var("PATH").map(|p| p.split(':').any(|d| Path::new(d).join(cmd).exists())).unwrap_or(false)
}
fn systemd_ok() -> bool {
    cmd_ok("systemctl", &["--user", "daemon-reload"]) && cmd_ok("systemctl", &["--user", "list-units"])
}
fn cmd_ok(bin: &str, args: &[&str]) -> bool {
    Command::new(bin).args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}
fn svc(verb: &str, units: &[&str]) -> bool {
    let mut a = vec!["--user", verb];
    a.extend_from_slice(units);
    cmd_ok("systemctl", &a)
}
fn is_active(unit: &str) -> bool {
    Command::new("systemctl").args(["--user", "is-active", unit]).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "active").unwrap_or(false)
}
fn current_version(p: &Paths) -> Option<String> {
    fs::read_link(&p.current).ok().and_then(|t| t.file_name().map(|n| n.to_string_lossy().into_owned()))
}
fn activate(p: &Paths, version: &str) -> std::io::Result<()> {
    let target = p.versions.join(version);
    if !target.exists() { return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "version not installed")); }
    let tmp = p.current.with_extension("tmp");
    let _ = fs::remove_file(&tmp);
    std::os::unix::fs::symlink(fs::canonicalize(&target)?, &tmp)?;
    fs::rename(&tmp, &p.current)
}
// pkg_bin_dir: binaries inside THIS installed npm package (new version).
fn pkg_bin_dir() -> Option<PathBuf> {
    if let Ok(o) = env::var("REPOSUITE_BIN") {
        let p = PathBuf::from(o);
        if p.join("reposuite-gateway").exists() { return Some(p); }
    }
    let exe = env::current_exe().ok()?;
    let dir = exe.parent()?.to_path_buf();
    for cand in [dir.clone(), dir.join("../../@reposuite/linux-x64/bin"), dir.join("../node_modules/@reposuite/linux-x64/bin")] {
        if cand.join("reposuite-gateway").exists() { return Some(cand); }
    }
    None
}
fn installed_bin_dir(p: &Paths) -> Option<PathBuf> {
    let d = p.current.join("bin");
    if d.join("reposuite-gateway").exists() { Some(d) } else { None }
}

// ---- minimal HTTP over UnixStream / TCP (local only, no TLS) ----
fn read_http(stream: &mut impl Read) -> Option<(u16, String)> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let mut header_end = None;
    loop {
        if header_end.is_none() {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = Some(pos + 4);
            }
        }
        if let Some(he) = header_end {
            let head = String::from_utf8_lossy(&buf[..he]).to_ascii_lowercase();
            if head.contains("transfer-encoding: chunked") {
                if buf[he..].windows(5).any(|w| w == b"\r\n0\r\n") || buf[he..].ends_with(b"0\r\n\r\n") { break; }
            } else {
                let clen: usize = head.lines()
                    .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().to_string()))
                    .and_then(|v| v.parse().ok()).unwrap_or(0);
                if buf.len() >= he + clen { break; }
            }
        }
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => break,
        }
        if buf.len() > 4 << 20 { break; }
    }
    let he = header_end?;
    let head = String::from_utf8_lossy(&buf[..he]).to_string();
    let status: u16 = head.split_whitespace().nth(1)?.parse().ok()?;
    let raw = &buf[he..];
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        let mut out = Vec::new();
        let mut i = 0usize;
        while i < raw.len() {
            let Some(nl) = raw[i..].windows(2).position(|w| w == b"\r\n") else { break };
            let size_str = String::from_utf8_lossy(&raw[i..i + nl]).trim().to_string();
            let Ok(size) = usize::from_str_radix(size_str.split(';').next().unwrap_or("0"), 16) else { break };
            i += nl + 2;
            if size == 0 { break; }
            if i + size > raw.len() { out.extend_from_slice(&raw[i..]); break; }
            out.extend_from_slice(&raw[i..i + size]);
            i += size + 2;
        }
        String::from_utf8_lossy(&out).to_string()
    } else {
        String::from_utf8_lossy(raw).to_string()
    };
    Some((status, body))
}

fn http_unix(socket: &Path, method: &str, path: &str, body: Option<&str>) -> Option<(u16, String)> {
    let mut s = UnixStream::connect(socket).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(20)));
    let b = body.unwrap_or("");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}",
        b.len());
    s.write_all(req.as_bytes()).ok()?;
    read_http(&mut s)
}
fn http_tcp(port: u16, bearer: &str, path: &str) -> Option<(u16, String)> {
    use std::net::TcpStream;
    let mut s = TcpStream::connect(("127.0.0.1", port)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(4)));
    // Relay validates Host strictly (ADR-006): it must be 127.0.0.1:<port>,
    // not bare 127.0.0.1 — a portless Host gets HTTP 421 and health polling
    // would expire while the daemon is actually fine.
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {bearer}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    read_http(&mut s)
}

fn cloud_status(p: &Paths) -> Option<serde_json::Value> {
    let (st, body) = http_unix(&p.socket, "GET", "/v1/cloud/status", None)?;
    if st != 200 { return None; }
    serde_json::from_str(&body).ok()
}
fn cloud_pair(p: &Paths, invite: &str) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "invite": invite }).to_string();
    let (st, b) = http_unix(&p.socket, "POST", "/v1/cloud/pair", Some(&body))
        .ok_or("gateway socket unavailable")?;
    let v: serde_json::Value = serde_json::from_str(&b).unwrap_or(serde_json::Value::Null);
    if st == 200 { Ok(v) } else {
        Err(v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("pair failed").to_string())
    }
}
fn relay_probe(p: &Paths) -> Option<serde_json::Value> {
    let tok = fs::read_to_string(p.relay.join("config/api.token")).ok()?.trim().to_string();
    let cfg = fs::read_to_string(p.relay.join("config/relay.json")).ok()?;
    let j: serde_json::Value = serde_json::from_str(&cfg).ok()?;
    let port = j.get("listenPort").and_then(|v| v.as_u64())? as u16;
    let (st, body) = http_tcp(port, &tok, "/v1/daemon")?;
    if st != 200 { return None; }
    serde_json::from_str(&body).ok()
}
/// -1 = unknown (token exists, API unreachable) → deny activation.
fn running_sessions(p: &Paths) -> i64 {
    if !p.relay.join("config/api.token").exists() { return 0; }
    match relay_probe(p) {
        Some(j) => j.pointer("/daemon/activeSessions").and_then(|v| v.as_i64())
            .or_else(|| j.pointer("/daemon/sessionCount").and_then(|v| v.as_i64())).unwrap_or(0),
        None => -1,
    }
}

fn write_units(p: &Paths, bin: &Path) {
    let _ = fs::create_dir_all(&p.units);
    let b = bin.display();
    let gw = format!("[Unit]\nDescription=RepoSuite Gateway (user)\nAfter=default.target\n\n[Service]\nUMask=0077\nEnvironmentFile={}\nEnvironment=REPOSUITE_RSR_HOME={}\nEnvironment=REPOSUITE_GATEWAY_STATE={}\nExecStart={b}/reposuite-gateway serve --data-dir {} --socket {}\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=default.target\n",
        p.env_file.display(), p.relay.display(), p.gateway.display(),
        p.gateway.join("store").display(), p.socket.display());
    let rl = format!("[Unit]\nDescription=RepoSuite Relay (user)\nAfter=reposuite-gateway.service\n\n[Service]\nUMask=0077\nEnvironment=REPOSUITE_HOME={}\nExecStart={b}/reposuite-relay serve\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=default.target\n",
        p.root.display());
    let _ = fs::write(p.units.join("reposuite-gateway.service"), gw);
    let _ = fs::write(p.units.join("reposuite-relay.service"), rl);
    let wss = env::var("REPOSUITE_CLOUD_WSS").or_else(|_| env::var("RSC_WS_URL"))
        .unwrap_or_else(|_| "wss://app.reposuite.com/gateway".into());
    let host = fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default().trim().to_string();
    let _ = fs::write(&p.env_file, format!("REPOSUITE_CLOUD_WSS={wss}\nREPOSUITE_GATEWAY_LABEL={host}\n"));
    let _ = fs::set_permissions(&p.env_file, fs::Permissions::from_mode(0o600));
}

struct Snapshot { version: Option<String>, units: BTreeMap<String, Option<Vec<u8>>> }
fn snapshot(p: &Paths) -> Snapshot {
    let mut units = BTreeMap::new();
    for u in OWNED_UNITS { units.insert(u.to_string(), fs::read(p.units.join(u)).ok()); }
    Snapshot { version: current_version(p), units }
}
// owned_pids returns PIDs of live processes whose executable lives inside
// this installation's versioned tree. Strictly scoped: the /proc exe target
// must resolve under versions/ or current/bin AND match an owned binary
// name — nothing else on the host is ever matched or signalled.
fn owned_pids(p: &Paths) -> Vec<u32> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(c) = fs::canonicalize(&p.versions) { roots.push(c); }
    if let Ok(c) = fs::canonicalize(p.current.join("bin")) { roots.push(c); }
    let mut out = Vec::new();
    if roots.is_empty() { return out; }
    if let Ok(rd) = fs::read_dir("/proc") {
        for e in rd.flatten() {
            let Ok(pid) = e.file_name().to_string_lossy().parse::<u32>() else { continue };
            if pid == std::process::id() { continue; }
            let Ok(exe) = fs::read_link(e.path().join("exe")) else { continue };
            if !roots.iter().any(|r| exe.starts_with(r)) { continue; }
            let base = exe.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if !OWNED_BINS.contains(&base.as_str()) { continue; }
            // Never terminate a systemd-managed service: only processes whose
            // owning unit is NOT active are orphans. `is_active` on a
            // deleted/unloaded unit is false, which is exactly the partial-
            // install case we must reap — a live managed unit stays untouched.
            if systemd_ok() && is_active(&base) { continue; }
            out.push(pid);
        }
    }
    out
}
fn kill_pids(pids: &[u32]) {
    for pid in pids { unsafe { libc::kill(*pid as i32, libc::SIGTERM); } }
    for _ in 0..40 { // ~20s graceful shutdown window
        if pids.iter().all(|pid| unsafe { libc::kill(*pid as i32, 0) } != 0) { return; }
        std::thread::sleep(Duration::from_millis(500));
    }
    for pid in pids { unsafe { libc::kill(*pid as i32, libc::SIGKILL); } }
}

fn restore(p: &Paths, s: &Snapshot) -> bool {
    let mut all = true;
    match &s.version {
        Some(v) => {
            for (u, content) in &s.units {
                let path = p.units.join(u);
                let r = match content { Some(c) => fs::write(&path, c), None => { let _ = fs::remove_file(&path); Ok(()) } };
                if r.is_err() { all = false; }
            }
            if activate(p, v).is_err() { all = false; }
            if systemd_ok() {
                let _ = Command::new("systemctl").args(["--user", "daemon-reload"]).status();
                if !svc("restart", &OWNED_UNITS.map(|u| u.trim_end_matches(".service"))) { all = false; }
                // recovery is only proven when both restored units are actually up
                for u in OWNED_UNITS { if !is_active(u.trim_end_matches(".service")) { all = false; } }
            }
        }
        None => {
            // First-install rollback: there is NO previous runtime, so the
            // correct end state is "not installed" — not restarting removed
            // units. Stop/disable the just-installed units while their unit
            // files still exist (a post-removal daemon-reload would orphan
            // them), then remove files + activation and reap any orphans.
            if systemd_ok() {
                let names = OWNED_UNITS.map(|u| u.trim_end_matches(".service"));
                let _ = svc("stop", &names);
                let _ = svc("disable", &names);
            }
            for (u, content) in &s.units {
                let path = p.units.join(u);
                let r = match content { Some(c) => fs::write(&path, c), None => { let _ = fs::remove_file(&path); Ok(()) } };
                if r.is_err() { all = false; }
            }
            let _ = fs::remove_file(&p.current);
            if systemd_ok() { let _ = Command::new("systemctl").args(["--user", "daemon-reload"]).status(); }
            let pids = owned_pids(p);
            if !pids.is_empty() { kill_pids(&pids); }
            if !owned_pids(p).is_empty() { all = false; }
        }
    }
    all
}
fn health(p: &Paths) -> bool {
    if env::var("REPOSUITE_FAULT_INJECT").as_deref() == Ok("health") { return false; }
    p.socket.exists() && relay_probe(p).is_some()
}
/// Readiness poll: freshly started daemons need time to bind the socket and
/// mint relay credentials on first run — never fail a rollout on the first
/// probe. Bounded (~30s) and reports the leg that timed out for diagnosis.
fn health_wait(p: &Paths) -> bool {
    let mut last = "unknown";
    for _ in 0..60 {
        if health(p) { return true; }
        last = if !p.socket.exists() { "gateway socket" }
            else if !p.relay.join("config/api.token").exists() { "relay api.token" }
            else if !p.relay.join("config/relay.json").exists() { "relay listenPort" }
            else { "relay /v1/daemon probe" };
        std::thread::sleep(Duration::from_millis(500));
    }
    eprintln!("reposuite: health check timed out waiting for {last}");
    false
}
fn apply_runtime(p: &Paths, version: &str, bin: &Path) {
    let snap = snapshot(p);
    let fail = |msg: &str| -> ! {
        eprintln!("reposuite: {msg} — restoring previous runtime");
        if !restore(p, &snap) {
            die(&format!("RECOVERY FAILED — manual intervention required (previous: {})", snap.version.clone().unwrap_or_else(|| "none".into())));
        }
        ok(&format!("previous runtime restored{}", snap.version.as_ref().map(|v| format!(" ({v})")).unwrap_or_default()));
        std::process::exit(1)
    };
    if activate(p, version).is_err() { fail("activation error"); }
    write_units(p, bin);
    if !systemd_ok() { ok("systemd --user unavailable — staged only"); return; }
    if !cmd_ok("systemctl", &["--user", "daemon-reload"]) { fail("daemon-reload failed"); }
    // Orphans from a previous partial install hold the socket/port and would
    // defeat the new units' bind — reap them before restart. Scoped strictly
    // to executables inside this installation's versioned tree.
    let orphans = owned_pids(p);
    if !orphans.is_empty() {
        kill_pids(&orphans);
        // Bounded failure path: any survivor would still hold the socket/port.
        if !owned_pids(p).is_empty() { fail("could not terminate orphan processes"); }
    }
    // enable only installs symlinks — it does NOT start units. Restart them
    // (start if not running) so the NEW binaries actually execute, then
    // verify both are active before health polling.
    let units = OWNED_UNITS.map(|u| u.trim_end_matches(".service"));
    let _ = svc("enable", &units);
    if !svc("restart", &units) { fail("service start failed"); }
    for u in units { if !is_active(u) { fail("service did not become active"); } }
    if env::var("REPOSUITE_FAULT_INJECT").as_deref() == Ok("start") { fail("injected service failure"); }
    if !health_wait(p) { fail("health verification failed"); }
}

// ---- protected invite input: /dev/tty with echo disabled, always restored ----
struct EchoGuard { fd: i32, saved: libc::termios }
impl Drop for EchoGuard {
    fn drop(&mut self) { unsafe { libc::tcsetattr(self.fd, libc::TCSANOW, &self.saved); } }
}
fn read_hidden(prompt: &str) -> Result<String, String> {
    use std::io::BufRead;
    let f = fs::OpenOptions::new().read(true).open("/dev/tty")
        .map_err(|e| format!("cannot open /dev/tty ({e})"))?;
    let fd = std::os::unix::io::AsRawFd::as_raw_fd(&f);
    let mut saved: libc::termios = unsafe { std::mem::zeroed() };
    // FAIL CLOSED: if the terminal's echo state cannot be read or disabled,
    // refuse to read the invite rather than typing a secret in cleartext.
    if unsafe { libc::tcgetattr(fd, &mut saved) } != 0 {
        return Err("cannot read terminal attributes — refusing to read the invite".into());
    }
    let mut raw = saved;
    raw.c_lflag &= !(libc::ECHO);
    if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
        return Err("cannot disable terminal echo — refusing to read the invite".into());
    }
    let guard = EchoGuard { fd, saved };
    eprint!("{prompt}");
    let mut line = String::new();
    let r = std::io::BufReader::new(&f).read_line(&mut line);
    drop(guard);
    eprintln!();
    match r {
        Ok(_) => Ok(line.trim().to_string()),
        Err(e) => Err(format!("terminal read failed ({e})")),
    }
}
fn read_invite() -> String {
    let stdin_tty = unsafe { libc::isatty(0) } == 1;
    let invite = if stdin_tty {
        match read_hidden("invite (inv_<id>.<secret>): ") {
            Ok(v) => v,
            Err(e) => die(&e),
        }
    } else {
        let mut s = String::new();
        let _ = std::io::stdin().read_to_string(&mut s);
        s.trim().to_string()
    };
    let valid = invite.starts_with("inv_") && invite.contains('.')
        && invite.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if !valid { die("malformed invite"); }
    invite
}

fn cmd_setup(p: &Paths) {
    let b = pkg_bin_dir().unwrap_or_else(|| die("native binaries not found — is the platform package installed?"));
    mkdir700(&p.root);
    migrate_legacy(p);
    let switching = current_version(p).map(|v| v != VERSION).unwrap_or(false);
    if switching && is_active("reposuite-relay") {
        let s = running_sessions(p);
        if s != 0 {
            if s > 0 { die(&format!("{s} agent session(s) running — setup staged; run 'reposuite update apply' later")); }
            die("Relay state unknown — staging only (fail closed)");
        }
    }
    let vdir = p.versions.join(VERSION).join("bin");
    mkdir700(&vdir);
    for f in OWNED_BINS { fs::copy(b.join(f), vdir.join(f)).unwrap_or_else(|e| die(&format!("copy {f}: {e}"))); }
    mkdir700(&p.gateway); mkdir700(&p.relay);
    mkdir700(&p.gateway.join("store"));   // SQLite store root (strict whitelist)
    mkdir700(&p.gateway.join("cloud"));   // durable cloud identity/creds
    if let Some(parent) = p.socket.parent() { mkdir700(parent); }
    apply_runtime(p, VERSION, &vdir);
    ok(&format!("setup complete (v{VERSION}) — run 'reposuite doctor', then 'reposuite pair'"));
}

fn paired(p: &Paths) -> bool {
    // durable identity = non-empty gateway key AND credential; an
    // unclaimed file (pre-claim epoch state) must never block pairing.
    fs::read_to_string(p.gateway.join("cloud/gateway.json")).ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .map(|j| {
            let nonempty = |k: &str| j.get(k).and_then(|v| v.as_str()).map(|v| !v.is_empty()).unwrap_or(false);
            nonempty("gateway") && nonempty("credential")
        }).unwrap_or(false)
}

fn cloud_pair_begin(p: &Paths) -> Result<serde_json::Value, String> {
    let (st, b) = http_unix(&p.socket, "POST", "/v1/cloud/pair-begin", Some("{}"))
        .ok_or("gateway socket unavailable")?;
    let v: serde_json::Value = serde_json::from_str(&b).unwrap_or(serde_json::Value::Null);
    if st == 200 { Ok(v) } else {
        Err(v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("pair begin failed").to_string())
    }
}
fn cloud_pair_status(p: &Paths) -> Option<serde_json::Value> {
    let (st, b) = http_unix(&p.socket, "POST", "/v1/cloud/pair-status", Some("{}"))?;
    if st != 200 { return None; }
    serde_json::from_str(&b).ok()
}
fn cloud_pair_cancel(p: &Paths) {
    let _ = http_unix(&p.socket, "POST", "/v1/cloud/pair-cancel", Some("{}"));
}

fn open_browser(url: &str) {
    // best-effort launcher; failure is non-fatal (headless boxes approve
    // from any other device using the printed code). Only http(s) URLs —
    // never hand a server-provided string to a shell-open primitive blindly.
    if !(url.starts_with("https://") || url.starts_with("http://")) { return; }
    for (cmd, args) in [("xdg-open", vec![url]), ("wslview", vec![url]), ("open", vec![url])] {
        if have(cmd) {
            let _ = Command::new(cmd).args(&args).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
            return;
        }
    }
}

// Returns the process exit code: 0 = paired AND cloud-online confirmed;
// 2 = durable identity claimed but connectivity not yet observed (pairing
// itself succeeded — not a failure, but NOT full success either).
fn wait_paired_online(p: &Paths) -> i32 {
    let mut paired_seen = false;
    let mut last: Option<serde_json::Value> = None;
    for _ in 0..30 {
        if let Some(s) = cloud_status(p) {
            last = Some(s.clone());
            if s.get("paired").and_then(|v| v.as_bool()) == Some(true) { paired_seen = true; break; }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    if !paired_seen { die("pairing did not produce durable gateway identity (expired/refused?)"); }
    let key = last.as_ref().and_then(|s| s.get("gateway_key")).and_then(|v| v.as_str()).unwrap_or("?").to_string();
    ok(&format!("paired (gateway {key}) — waiting for authenticated cloud"));
    for _ in 0..20 {
        if let Some(s) = cloud_status(p) {
            if s.get("online").and_then(|v| v.as_bool()) == Some(true) {
                ok("cloud ONLINE (authenticated WSS)");
                return 0;
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    eprintln!("reposuite: paired but cloud connectivity not yet confirmed —");
    eprintln!("reposuite: durable gateway identity is saved; check: reposuite status / reposuite doctor");
    2
}

fn cmd_pair(p: &Paths) {
    if paired(p) { ok("already paired — revocation is a Control-side action"); return; }
    // Browser device-authorization flow (ADR-PAIR-001): the gateway daemon
    // owns the device_secret — it is never in argv/env/history here.
    let begin = match cloud_pair_begin(p) {
        Ok(v) => v,
        Err(e) => die(&format!("cannot start browser pairing: {e} (use 'reposuite pair --invite' for manual pairing)")),
    };
    let code = begin.get("user_code").and_then(|v| v.as_str()).unwrap_or("").to_string();
    // verification_url_complete carries the opaque browser-facing handle —
    // the normal desktop flow needs NO manual code entry.
    let url = begin.get("verification_url_complete").and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "https://app.reposuite.com/pair".into());
    println!("reposuite: open {url}");
    if !code.is_empty() { println!("reposuite: verification code {code} (optional visual check)"); }
    open_browser(&url);
    println!("reposuite: approve in the browser to finish pairing (Ctrl-C to abort)...");
    // bounded poll — the request expires server-side after 10 minutes;
    // sleep BEFORE polling so RSC's per-request throttle never races us
    for _ in 0..200 {
        std::thread::sleep(Duration::from_secs(3));
        if let Some(s) = cloud_pair_status(p) {
            match s.get("status").and_then(|v| v.as_str()).unwrap_or("unknown") {
                "authorized" => { std::process::exit(wait_paired_online(p)); }
                "denied" => die("pairing denied"),
                "expired" => die("pairing request expired — run 'reposuite pair' again"),
                _ => {} // pending | throttled | unknown | claimed (daemon
                        // still delivering the claimed invite locally — keep
                        // polling; it reports authorized once delivered)
            }
        }
    }
    cloud_pair_cancel(p);
    die("pairing timed out — request cancelled");
}

fn cmd_pair_manual(p: &Paths) {
    if paired(p) { ok("already paired — revocation is a Control-side action"); return; }
    let invite = read_invite();
    match cloud_pair(p, &invite) {
        Ok(_) => ok("invite accepted — waiting for the cloud handshake"),
        Err(e) => die(&format!("pairing failed: {e}")),
    }
    wait_paired_online(p);
}

fn cmd_doctor(p: &Paths) -> i32 {
    let mut fail = 0;
    let mut chk = |name: &str, v: bool| { println!(" {} {name}", if v { " ok " } else { "FAIL" }); if !v { fail = 1; } };
    println!("reposuite doctor  (v{VERSION})");
    println!(" pre-pair:");
    chk("linux platform", cfg!(target_os = "linux"));
    chk("native binaries", pkg_bin_dir().is_some() || installed_bin_dir(p).is_some());
    chk("provider cli (any)", have("codex") || have("devin") || have("opencode"));
    chk("systemd --user", systemd_ok());
    println!(" services:");
    chk("gateway service active", !systemd_ok() || is_active("reposuite-gateway"));
    chk("relay service active", !systemd_ok() || is_active("reposuite-relay"));
    chk("gateway socket live", p.socket.exists());
    let tok = p.relay.join("config/api.token");
    chk("relay api.token 0600", tok.exists() && fs::metadata(&tok).map(|m| m.permissions().mode() & 0o777 == 0o600).unwrap_or(false));
    println!(" cloud:");
    match cloud_status(p) {
        None => chk("gateway cloud status reachable", false),
        Some(cs) => {
            let b = |k: &str| cs.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
            chk("cloud transport enabled", b("enabled"));
            chk("gateway paired (durable identity)", b("paired"));
            if b("paired") { chk("cloud ONLINE (authenticated WSS)", b("online")); }
            if let Some(e) = cs.get("last_error").and_then(|v| v.as_str()) { println!("  info last cloud error: {e}"); }
        }
    }
    fail
}

fn cmd_status(p: &Paths) {
    for u in OWNED_UNITS {
        let n = u.trim_end_matches(".service");
        println!("{:<24} {}", n, if is_active(n) { "active" } else { "inactive" });
    }
    let cs = cloud_status(p);
    let paired = cs.as_ref().and_then(|c| c.get("paired")).and_then(|v| v.as_bool()).unwrap_or(false);
    let online = cs.as_ref().and_then(|c| c.get("online")).and_then(|v| v.as_bool()).unwrap_or(false);
    let key = cs.as_ref().and_then(|c| c.get("gateway_key")).and_then(|v| v.as_str());
    println!("paired:                 {}", if paired { "yes" } else { "no" });
    println!("cloud online:           {}{}", if online { "yes" } else { "no" }, key.map(|k| format!("  ({k})")).unwrap_or_default());
    println!("activated version:      {}", current_version(p).unwrap_or_else(|| "none".into()));
}

fn service_op(verb: &str) {
    if !systemd_ok() { die("systemd --user unavailable"); }
    let units: Vec<&str> = OWNED_UNITS.iter().map(|u| u.trim_end_matches(".service")).collect();
    if !svc(verb, &units) { die(&format!("{verb} failed (systemctl returned nonzero)")); }
    let want = verb != "stop";
    let mut bad: Vec<&str> = units.clone();
    for _ in 0..40 { // bounded ~20s: Type=simple units pass through 'activating'
        bad = units.iter().copied().filter(|u| is_active(u) != want).collect();
        if bad.is_empty() { break; }
        std::thread::sleep(Duration::from_millis(500));
    }
    if !bad.is_empty() { die(&format!("{verb} incomplete: {} not {}", bad.join(", "), if want { "active" } else { "stopped" })); }
    ok(&format!("{verb}: {} {}", units.join(", "), if want { "active" } else { "stopped" }));
    cmd_status(&paths());
}

fn cmp_ver(a: &str, b: &str) -> std::cmp::Ordering {
    let num = |s: &str| -> Vec<i64> { s.split(|c: char| c == '.' || c == '-' || c == '+')
        .map(|p| p.parse::<i64>().unwrap_or(0)).collect() };
    num(a).cmp(&num(b))
}

fn cmd_update_apply(p: &Paths) {
    let cur = current_version(p);
    let s = running_sessions(p);
    if s != 0 {
        if s > 0 { die(&format!("{s} agent session(s) running — deferring activation")); }
        die("Relay state unknown — deferring activation (fail closed)");
    }
    let b = pkg_bin_dir().unwrap_or_else(|| die("new package carries no platform binaries"));
    let vdir = p.versions.join(VERSION).join("bin");
    mkdir700(&vdir);
    for f in OWNED_BINS { fs::copy(b.join(f), vdir.join(f)).unwrap_or_else(|e| die(&format!("copy {f}: {e}"))); }
    apply_runtime(p, VERSION, &vdir);
    ok(&format!("activated {VERSION}{}", cur.filter(|c| c != VERSION).map(|c| format!(" (previous {c} kept for rollback)")).unwrap_or_default()));
}

fn cmd_rollback(p: &Paths) {
    let cur = current_version(p);
    let mut versions: Vec<String> = fs::read_dir(&p.versions).ok().map(|it| it.flatten()
        .filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    versions.retain(|v| Some(v) != cur.as_ref());
    versions.sort_by(|a, b| cmp_ver(a, b));
    let target = versions.pop().unwrap_or_else(|| die("no previous version to roll back to"));
    let s = running_sessions(p);
    if s != 0 {
        if s > 0 { die(&format!("{s} agent session(s) running — stop them first")); }
        die("Relay state unknown — refusing rollback (fail closed)");
    }
    apply_runtime(p, &target, &p.versions.join(&target).join("bin"));
    ok(&format!("rolled back {} -> {target}", cur.unwrap_or_else(|| "none".into())));
}

fn cmd_update_check() {
    let out = Command::new("npm").args(["view", "reposuite", "dist-tags", "--json"]).output()
        .unwrap_or_else(|_| die("npm registry unreachable"));
    if !out.status.success() { die("npm registry unreachable"); }
    let j: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or(serde_json::Value::Null);
    let beta = j.get("beta").and_then(|v| v.as_str());
    let latest = j.get("latest").and_then(|v| v.as_str());
    let chan = if VERSION.contains("beta") || VERSION.contains("rc") { beta.or(latest) } else { latest.or(beta) };
    match chan {
        Some(c) if c == VERSION => println!("installed {VERSION}  channel {c}  (up to date)"),
        Some(c) => println!("installed {VERSION}  channel {c}  — run: npm update -g reposuite"),
        None => println!("installed {VERSION}  (channel unknown)"),
    }
}

fn cmd_uninstall(p: &Paths) {
    if systemd_ok() {
        let units = OWNED_UNITS.map(|u| u.trim_end_matches(".service"));
        let _ = svc("stop", &units);          // never leave daemons running on deleted state
        let _ = svc("disable", &units);
    }
    for u in OWNED_UNITS { let _ = fs::remove_file(p.units.join(u)); }
    if systemd_ok() { let _ = Command::new("systemctl").args(["--user", "daemon-reload"]).status(); }
    let _ = fs::remove_file(&p.current);
    ok(&format!("units + activation removed; state preserved under {}", p.root.display()));
    println!("  full state removal: reposuite purge-state");
}

fn cmd_purge(p: &Paths, yes: bool) {
    let data = xdg("XDG_DATA_HOME", ".local/share");
    let roots = [p.root.clone(), data.join("reposuite-gateway"), home().join(".reposuite"), data.join("rsc-connector")];
    if !yes {
        println!("purge-state permanently removes:");
        for r in &roots { println!("  {}", r.display()); }
        let tty = unsafe { libc::isatty(0) } == 1;
        if !tty { die("non-interactive: pass --yes to confirm"); }
        let mut line = String::new();
        eprint!("type 'purge' to confirm: ");
        let _ = std::io::stdin().read_line(&mut line);
        if line.trim() != "purge" { die("aborted"); }
    }
    cmd_uninstall(p);
    for r in &roots { let _ = fs::remove_dir_all(r); }
    let _ = fs::remove_file(&p.env_file);
    ok("RepoSuite state purged (owned roots only; unrelated state untouched)");
}

fn migrate_legacy(p: &Paths) {
    let data = xdg("XDG_DATA_HOME", ".local/share");
    let pairs = [
        (data.join("reposuite-gateway"), p.gateway.join("store")),
        (home().join(".reposuite/relay"), p.relay.clone()),
        (data.join("rsc-connector"), p.gateway.join("cloud")),
    ];
    for (from, to) in pairs {
        if !from.exists() { continue; }
        let populated = to.exists() && fs::read_dir(&to).map(|mut d| d.next().is_some()).unwrap_or(false);
        if populated { println!("  legacy {} left in place (target populated)", from.display()); continue; }
        if let Some(parent) = to.parent() { mkdir700(parent); }
        match fs::rename(&from, &to) {
            Ok(_) => println!("  migrated {} -> {}", from.display(), to.display()),
            Err(e) => println!("  legacy {} not migrated ({e})", from.display()),
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let p = paths();
    let sub: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    match sub.as_slice() {
        ["setup"] => cmd_setup(&p),
        ["pair"] => cmd_pair(&p),
        ["pair", "--invite"] => cmd_pair_manual(&p),
        ["doctor"] => std::process::exit(cmd_doctor(&p)),
        ["status"] => cmd_status(&p),
        ["start"] => service_op("start"),
        ["stop"] => service_op("stop"),
        ["restart"] => service_op("restart"),
        ["update", "check"] | ["update-check"] => cmd_update_check(),
        ["update", "apply"] | ["update-apply"] => cmd_update_apply(&p),
        ["rollback"] => cmd_rollback(&p),
        ["uninstall"] => cmd_uninstall(&p),
        ["purge-state", rest @ ..] => cmd_purge(&p, rest.iter().any(|a| *a == "--yes")),
        ["migrate"] => { mkdir700(&p.root); migrate_legacy(&p); }
        ["version"] => println!("{VERSION}"),
        _ => println!("reposuite <command>\n\n  setup            install+enable user services (versioned runtime)\n  doctor           readiness checks (pre-pair / services / cloud)\n  pair             browser pairing (approve in web admin); --invite = manual invite\n  start|stop|restart|status   service control + state\n  update check     compare installed vs npm channel\n  update apply     activate safely (defers on live/unknown sessions)\n  rollback         re-activate the previous runtime version\n  migrate          idempotent legacy-state migration\n  uninstall        remove units+activation, preserve state\n  purge-state      remove all owned state roots (explicit)"),
    }
}
