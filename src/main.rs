// reposuite — canonical RepoSuite CLI (Rust). Manages the per-user runtime:
// versioned binary dirs, two systemd user services (gateway + relay, where
// gateway embeds the cloud transport), protected pairing over the owner-only
// Unix socket, transactional activation/rollback. The Node npm entry is only
// a launcher that forwards to this binary.
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::ffi::OsStrExt;
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
// Serialize changes to units, selection and version directories.  Keep the
// lock outside the removable runtime root so purge cannot unlink a held lock.
fn runtime_lock(p: &Paths) -> fs::File {
    let parent = p.root.parent().unwrap_or_else(|| die("runtime has no parent"));
    fs::create_dir_all(parent).unwrap_or_else(|e| die(&format!("create runtime parent: {e}")));
    let f = fs::OpenOptions::new().read(true).write(true).create(true).mode(0o600)
        .open(parent.join(".reposuite-runtime.lock"))
        .unwrap_or_else(|e| die(&format!("open runtime lock: {e}")));
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        die("another runtime operation is in progress — retry when it finishes");
    }
    f
}

fn same_file(a: &Path, b: &Path) -> std::io::Result<bool> {
    let mut a = fs::File::open(a)?;
    let mut b = fs::File::open(b)?;
    for f in [&a, &b] {
        let m = f.metadata()?;
        if !m.is_file() || m.permissions().mode() & 0o111 == 0 { return Ok(false); }
    }
    if a.metadata()?.len() != b.metadata()?.len() { return Ok(false); }
    let mut x = [0u8; 65536]; let mut y = [0u8; 65536];
    loop {
        let n = a.read(&mut x)?; let m = b.read(&mut y)?;
        if n != m || x[..n] != y[..m] { return Ok(false); }
        if n == 0 { return Ok(true); }
    }
}
fn same_pair(source: &Path, target: &Path) -> bool {
    OWNED_BINS.iter().all(|f| same_file(&source.join(f), &target.join(f)).unwrap_or(false))
}
fn version_conflict() -> String {
    format!("installed version {VERSION} is incomplete or differs from this package; use a new build/version or supported recovery")
}
// Build the complete version outside versions/ and publish it atomically.
// RENAME_NOREPLACE prevents clobbering even an uncooperative concurrent writer.
fn install_pair(p: &Paths, source: &Path) -> Result<PathBuf, String> {
    let dest = p.versions.join(VERSION);
    let bin = dest.join("bin");
    if fs::symlink_metadata(&dest).is_ok() {
        return if same_pair(source, &bin) { Ok(bin) } else { Err(version_conflict()) };
    }
    fs::create_dir_all(&p.versions).map_err(|e| format!("create versions directory: {e}"))?;
    for dir in [&p.root, &p.versions] {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| format!("protect runtime directory: {e}"))?;
    }
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let stage = p.root.join(format!(".setup-stage-{}-{nonce}", std::process::id()));
    fs::DirBuilder::new().mode(0o700).create(&stage).map_err(|e| format!("create staging directory: {e}"))?;
    let result = (|| -> Result<(), String> {
        let staged_bin = stage.join("bin");
        fs::DirBuilder::new().mode(0o700).create(&staged_bin).map_err(|e| format!("create staging bin: {e}"))?;
        for f in OWNED_BINS {
            fs::copy(source.join(f), staged_bin.join(f)).map_err(|e| format!("stage {f}: {e}"))?;
        }
        if !same_pair(source, &staged_bin) { return Err("staged binary pair is incomplete or differs from the package".into()); }
        let from = std::ffi::CString::new(stage.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let to = std::ffi::CString::new(dest.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        if unsafe { libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, from.as_ptr(), libc::AT_FDCWD, to.as_ptr(), libc::RENAME_NOREPLACE) } != 0 {
            let e = std::io::Error::last_os_error();
            if e.raw_os_error() == Some(libc::EEXIST) && same_pair(source, &bin) { return Ok(()); }
            return Err(if e.raw_os_error() == Some(libc::EEXIST) { version_conflict() } else { format!("install staged version: {e}") });
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&stage);
    result.map(|_| bin)
}
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
    let (st, b) = http_unix(&p.socket, "POST", "/v1/cloud/pair-invite", Some(&body))
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
/// -1 = unknown → deny activation.
fn running_sessions(p: &Paths) -> i64 {
    match relay_probe(p) {
        Some(j) => {
            let count = match j.pointer("/daemon/activeSessions") {
                Some(v) => v.as_i64(),
                None => j.pointer("/daemon/sessionCount").and_then(|v| v.as_i64()),
            };
            count.filter(|n| *n >= 0).unwrap_or(-1)
        },
        None => -1,
    }
}

fn write_units(p: &Paths, bin: &Path) -> std::io::Result<()> {
    fs::create_dir_all(&p.units)?;
    let b = bin.display();
    let gw = format!("[Unit]\nDescription=RepoSuite Gateway (user)\n\n[Service]\nUMask=0077\nEnvironmentFile={}\nEnvironment=REPOSUITE_RSR_HOME={}\nEnvironment=REPOSUITE_GATEWAY_STATE={}\nExecStart={b}/reposuite-gateway serve --data-dir {} --socket {}\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=default.target\n",
        p.env_file.display(), p.relay.display(), p.gateway.display(),
        p.gateway.join("store").display(), p.socket.display());
    let rl = format!("[Unit]\nDescription=RepoSuite Relay (user)\nAfter=reposuite-gateway.service\n\n[Service]\nUMask=0077\nEnvironment=REPOSUITE_HOME={}\nExecStart={b}/reposuite-relay serve\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=default.target\n",
        p.root.display());
    fs::write(p.units.join("reposuite-gateway.service"), gw)?;
    // Exercise a failure after one successful write so rollback must restore
    // the partial unit update as well as the environment and selection.
    if env::var("REPOSUITE_FAULT_INJECT").as_deref() == Ok("unit-write-relay") {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "injected unit write failure"));
    }
    fs::write(p.units.join("reposuite-relay.service"), rl)?;
    Ok(())
}

// Existing environment files are operator configuration.  Reusing them
// byte-for-byte retains the endpoint and all other supported local settings.
// An explicit target may change only that setting, and never while paired.
fn planned_env(p: &Paths) -> Result<Option<Vec<u8>>, String> {
    let requested = env::var("REPOSUITE_CLOUD_WSS").ok().or_else(|| env::var("RSC_WS_URL").ok());
    if requested.as_ref().is_some_and(|v| v.is_empty() || v.contains(['\n', '\r', '\0'])) {
        return Err("invalid cloud endpoint".into());
    }
    let existing = match fs::read(&p.env_file) {
        Ok(v) => Some(v),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("read existing gateway environment: {e}")),
    };
    match (existing, requested) {
        (Some(_), None) => Ok(None),
        (None, target) => {
            if paired(p) { return Err("paired runtime has no existing gateway environment; use supported recovery before changing its endpoint".into()); }
            let wss = target.unwrap_or_else(|| "wss://app.reposuite.com/gateway".into());
            let host = fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default().trim().to_string();
            Ok(Some(format!("REPOSUITE_CLOUD_WSS={wss}\nREPOSUITE_GATEWAY_LABEL={host}\n").into_bytes()))
        }
        (Some(bytes), Some(target)) => {
            let text = std::str::from_utf8(&bytes).map_err(|_| "cannot safely change a non-UTF-8 gateway environment")?;
            let mut matches = text.lines().filter_map(|l| l.strip_prefix("REPOSUITE_CLOUD_WSS="));
            let old = matches.next().ok_or("cannot safely determine existing gateway endpoint; use supported recovery")?;
            if matches.next().is_some() { return Err("multiple gateway endpoints in environment; use supported recovery".into()); }
            let unquoted = old.strip_prefix('"').and_then(|s| s.strip_suffix('"'))
                .or_else(|| old.strip_prefix('\'').and_then(|s| s.strip_suffix('\''))).unwrap_or(old);
            if unquoted == target { return Ok(None); }
            if paired(p) { return Err("paired runtime endpoint cannot be changed by setup/update/rollback; use supported recovery".into()); }
            let replacement = format!("REPOSUITE_CLOUD_WSS={target}");
            let mut out = String::new();
            for line in text.split_inclusive('\n') {
                if line.starts_with("REPOSUITE_CLOUD_WSS=") {
                    out.push_str(&replacement);
                    if line.ends_with('\n') { out.push('\n'); }
                } else { out.push_str(line); }
            }
            Ok(Some(out.into_bytes()))
        }
    }
}
struct Snapshot { version: Option<String>, units: BTreeMap<String, Option<Vec<u8>>>, environment: Option<(Vec<u8>, u32)> }
fn snapshot(p: &Paths) -> Snapshot {
    let mut units = BTreeMap::new();
    for u in OWNED_UNITS { units.insert(u.to_string(), fs::read(p.units.join(u)).ok()); }
    let environment = match fs::read(&p.env_file) {
        Ok(bytes) => Some((bytes, fs::metadata(&p.env_file).unwrap_or_else(|e| die(&format!("inspect gateway environment: {e}"))).permissions().mode() & 0o777)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => die(&format!("snapshot gateway environment: {e}")),
    };
    Snapshot { version: current_version(p), units, environment }
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
    let env_result = match &s.environment {
        Some((bytes, mode)) => fs::write(&p.env_file, bytes).and_then(|_| fs::set_permissions(&p.env_file, fs::Permissions::from_mode(*mode))),
        None => match fs::remove_file(&p.env_file) { Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e), _ => Ok(()) },
    };
    if env_result.is_err() { all = false; }
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
// This file records only activations that completed both service and health
// checks. Directories are staging material, not proof of prior activation.
#[derive(Debug)]
struct ActivationHistory { current: String, previous: Option<String> }
fn valid_version(v: &str) -> bool {
    !v.is_empty() && v != "." && v != ".." && !v.contains('/') && !v.contains('\0')
}
fn load_history(p: &Paths) -> Result<Option<ActivationHistory>, String> {
    let raw = match fs::read(p.root.join("activation.json")) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read activation history: {e}")),
    };
    let v: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| "invalid activation history; use supported recovery")?;
    let current = v.get("current").and_then(|x| x.as_str()).filter(|x| valid_version(x))
        .ok_or("invalid activation history; use supported recovery")?.to_string();
    let previous = match v.get("previous") {
        Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) if valid_version(s) && s != &current => Some(s.clone()),
        _ => return Err("invalid activation history; use supported recovery".into()),
    };
    let selected = fs::canonicalize(&p.current).ok();
    if current_version(p).as_deref() != Some(&current) || selected.is_none()
        || selected != fs::canonicalize(p.versions.join(&current)).ok() {
        return Err("activation history disagrees with current selection; use supported recovery for the interrupted activation".into());
    }
    Ok(Some(ActivationHistory { current, previous }))
}
fn save_history(p: &Paths, current: &str, previous: Option<&str>) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&serde_json::json!({"current": current, "previous": previous}))?;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let tmp = p.root.join(format!(".activation-{}-{nonce}", std::process::id()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        file.write_all(&bytes)?; file.sync_all()?;
        fs::rename(&tmp, p.root.join("activation.json"))?;
        // A directory sync persists the rename on filesystems that support it.
        fs::File::open(&p.root)?.sync_all()
    })();
    let _ = fs::remove_file(&tmp);
    result
}
// Adopt only a demonstrably live legacy selection. Unit state and local health
// are not sufficient alone: each actual MainPID executable must be this pair.
fn verified_legacy_current(p: &Paths) -> Option<String> {
    let v = current_version(p)?;
    if !valid_version(&v) || fs::canonicalize(&p.current).ok()? != fs::canonicalize(p.versions.join(&v)).ok()? || !health(p) { return None; }
    for unit in OWNED_UNITS {
        let name = unit.trim_end_matches(".service");
        if !is_active(name) { return None; }
        let out = Command::new("systemctl").args(["--user", "show", "--value", "-p", "MainPID", unit]).output().ok()?;
        if !out.status.success() { return None; }
        let pid = String::from_utf8(out.stdout).ok()?.trim().parse::<u32>().ok()?;
        if pid == 0 { return None; }
        let actual = fs::canonicalize(format!("/proc/{pid}/exe")).ok()?;
        let expected = fs::canonicalize(p.versions.join(&v).join("bin").join(name)).ok()?;
        if actual != expected { return None; }
    }
    Some(v)
}
fn apply_runtime(p: &Paths, version: &str, bin: &Path) -> bool {
    if !systemd_ok() { ok("systemd --user unavailable — staged only; no activation recorded"); return false; }
    let history = load_history(p).unwrap_or_else(|e| die(&e));
    let verified = if history.is_none() { verified_legacy_current(p) } else { None };
    let new_env = planned_env(p).unwrap_or_else(|e| die(&e));
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
    if let Some(bytes) = new_env {
        let write = fs::write(&p.env_file, bytes).and_then(|_| fs::set_permissions(&p.env_file, fs::Permissions::from_mode(0o600)));
        if write.is_err() { fail("cannot write gateway environment"); }
    }
    if let Err(e) = write_units(p, bin) { fail(&format!("cannot write user units: {e}")); }
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
    if !svc("enable", &units) { fail("service enable failed"); }
    if !svc("restart", &units) { fail("service start failed"); }
    for u in units { if !is_active(u) { fail("service did not become active"); } }
    if env::var("REPOSUITE_FAULT_INJECT").as_deref() == Ok("start") { fail("injected service failure"); }
    if !health_wait(p) { fail("health verification failed"); }
    let last = history.as_ref().map(|h| h.current.as_str()).or(verified.as_deref());
    let previous = if last == Some(version) { history.as_ref().and_then(|h| h.previous.as_deref()) } else { last };
    if let Err(e) = save_history(p, version, previous) {
        // The history rename may already have succeeded. Do not restore a
        // different selection if the committed history names this version.
        if load_history(p).ok().flatten().as_ref().map(|h| h.current.as_str()) == Some(version) {
            die(&format!("activation history durability uncertain: {e}; use supported recovery"));
        }
        fail(&format!("cannot commit activation history: {e}"));
    }
    true
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
    let version_dir = p.versions.join(VERSION);
    if fs::symlink_metadata(&version_dir).is_ok() && !same_pair(&b, &version_dir.join("bin")) {
        die(&version_conflict());
    }
    if is_active("reposuite-relay") {
        let s = running_sessions(p);
        if s != 0 {
            if s > 0 { die(&format!("{s} agent session(s) running — setup deferred; retry after they finish")); }
            die("Relay state unknown — setup deferred (fail closed)");
        }
    }
    let vdir = install_pair(p, &b).unwrap_or_else(|e| die(&e));
    mkdir700(&p.root);
    migrate_legacy(p);
    mkdir700(&p.gateway); mkdir700(&p.relay);
    mkdir700(&p.gateway.join("store"));   // SQLite store root (strict whitelist)
    mkdir700(&p.gateway.join("cloud"));   // durable cloud identity/creds
    if let Some(parent) = p.socket.parent() { mkdir700(parent); }
    if !apply_runtime(p, VERSION, &vdir) { return; }
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

#[derive(Default, Debug, PartialEq)]
struct PairOptions { label: Option<String>, key: Option<String> }

fn parse_pair_options(args: &[&str]) -> Result<PairOptions, String> {
    let mut opts = PairOptions::default();
    let mut i = 0;
    while i < args.len() {
        let flag = args[i];
        let value = args.get(i + 1).ok_or_else(|| format!("{flag} requires a value"))?.trim();
        match flag {
            "--label" if opts.label.is_none() => {
                if value.is_empty() || value.len() > 32 || value.chars().any(char::is_control) {
                    return Err("label must be printable and at most 32 bytes".into());
                }
                opts.label = Some(value.to_string());
            }
            "--key" if opts.key.is_none() => {
                let key = value.to_ascii_uppercase();
                let bytes = key.as_bytes();
                if !(3..=12).contains(&bytes.len()) || !bytes[0].is_ascii_alphanumeric()
                    || !bytes[bytes.len() - 1].is_ascii_alphanumeric()
                    || !bytes.iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'-') {
                    return Err("key must be 3–12 ASCII letters or digits with interior hyphens".into());
                }
                opts.key = Some(key);
            }
            _ => return Err(format!("unknown or duplicate pair option: {flag}")),
        }
        i += 2;
    }
    if opts.key.is_none() {
        if let Some(label) = &opts.label {
            let key: String = label.to_ascii_uppercase().chars().filter(char::is_ascii_alphanumeric).take(4).collect();
            if key.len() >= 3 { opts.key = Some(key); }
        }
    }
    Ok(opts)
}

fn cloud_pair_begin(p: &Paths, opts: &PairOptions) -> Result<serde_json::Value, String> {
    let mut body = serde_json::Map::new();
    if let Some(label) = &opts.label { body.insert("suggested_label".into(), label.clone().into()); }
    if let Some(key) = &opts.key { body.insert("suggested_key".into(), key.clone().into()); }
    let payload = serde_json::Value::Object(body).to_string();
    let (st, b) = http_unix(&p.socket, "POST", "/v1/cloud/pair-begin", Some(&payload))
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

fn cmd_pair(p: &Paths, opts: &PairOptions) {
    if paired(p) { ok("already paired — revocation is a Control-side action"); return; }
    // Browser device-authorization flow (ADR-PAIR-001): the gateway daemon
    // owns the device_secret — it is never in argv/env/history here.
    let begin = match cloud_pair_begin(p, opts) {
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
    std::process::exit(wait_paired_online(p));
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

fn cmd_update_apply(p: &Paths) {
    let s = running_sessions(p);
    if s != 0 {
        if s > 0 { die(&format!("{s} agent session(s) running — deferring activation")); }
        die("Relay state unknown — deferring activation (fail closed)");
    }
    let b = pkg_bin_dir().unwrap_or_else(|| die("new package carries no platform binaries"));
    let vdir = install_pair(p, &b).unwrap_or_else(|e| die(&e));
    if !apply_runtime(p, VERSION, &vdir) { return; }
    let previous = load_history(p).unwrap_or_else(|e| die(&e)).and_then(|h| h.previous);
    ok(&format!("activated {VERSION}{}", previous.map(|c| format!(" (previous {c} kept for rollback)")).unwrap_or_default()));
}

fn cmd_rollback(p: &Paths) {
    let cur = current_version(p);
    let target = load_history(p).unwrap_or_else(|e| die(&e))
        .and_then(|h| h.previous).unwrap_or_else(|| die("no verified previous activation; run setup to establish current history or use supported recovery"));
    let target_bin = p.versions.join(&target).join("bin");
    if !OWNED_BINS.iter().all(|f| fs::metadata(target_bin.join(f)).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)) {
        die("verified previous version is incomplete; use supported recovery");
    }
    let s = running_sessions(p);
    if s != 0 {
        if s > 0 { die(&format!("{s} agent session(s) running — stop them first")); }
        die("Relay state unknown — refusing rollback (fail closed)");
    }
    if !apply_runtime(p, &target, &target_bin) { return; }
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
    let _ = fs::remove_file(p.root.join("activation.json"));
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
    let _lock = match sub.as_slice() {
        ["setup"] | ["update", "apply"] | ["update-apply"] | ["rollback"] | ["uninstall"] | ["purge-state", ..] | ["migrate"] => Some(runtime_lock(&p)),
        _ => None,
    };
    match sub.as_slice() {
        ["setup"] => cmd_setup(&p),
        ["pair", "--invite"] => cmd_pair_manual(&p),
        ["pair", rest @ ..] => {
            let opts = parse_pair_options(rest).unwrap_or_else(|e| die(&e));
            cmd_pair(&p, &opts);
        }
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
        _ => println!("reposuite <command>\n\n  setup            install+enable user services (versioned runtime)\n  doctor           readiness checks (pre-pair / services / cloud)\n  pair [--label LABEL] [--key KEY]  browser pairing; --invite = manual invite\n  start|stop|restart|status   service control + state\n  update check     compare installed vs npm channel\n  update apply     activate safely (defers on live/unknown sessions)\n  rollback         re-activate the previous runtime version\n  migrate          idempotent legacy-state migration\n  uninstall        remove units+activation, preserve state\n  purge-state      remove all owned state roots (explicit)"),
    }
}

#[cfg(test)]
mod pair_option_tests {
    use super::*;

    #[test]
    fn suggestions_and_legacy_pair() {
        assert_eq!(parse_pair_options(&[]).unwrap(), PairOptions::default());
        assert_eq!(parse_pair_options(&["--label", "Work Linux"]).unwrap(),
            PairOptions { label: Some("Work Linux".into()), key: Some("WORK".into()) });
        assert_eq!(parse_pair_options(&["--key", "wrk", "--label", "Work Linux"]).unwrap(),
            PairOptions { label: Some("Work Linux".into()), key: Some("WRK".into()) });
    }

    #[test]
    fn rejects_bad_options() {
        for args in [&["--key", "ab"][..], &["--key", "-ABC"][..], &["--label"][..],
                     &["--key", "ABC", "--key", "DEF"][..]] {
            assert!(parse_pair_options(args).is_err(), "{args:?}");
        }
    }
}
