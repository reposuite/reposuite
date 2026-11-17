// Process-level regression tests for `reposuite debug` (config-gated,
// read-only). Spawns the built binary with isolated child envs only —
// never mutates parent HOME/env, no services/install/cloud, no /tmp.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixture(tag: &str) -> Fixture {
    let base = env!("CARGO_TARGET_TMPDIR").to_string();
    let d = Path::new(&base).join(format!("dbg-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(d.join(".reposuite")).unwrap();
    // Isolate ALL xdg/runtime dirs inside the fixture so nothing escapes.
    for sub in ["data", "config", "run"] {
        fs::create_dir_all(d.join(sub)).unwrap();
    }
    Fixture(d)
}

fn write_cfg(home: &Path, body: &str) {
    fs::write(home.join(".reposuite/config.json"), body).unwrap();
}

fn snapshot(d: &Path) -> Vec<(String, Vec<u8>)> {
    // Recursive: relative path -> bytes (empty marker for directories).
    let mut v = Vec::new();
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        for e in fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().into_owned();
            if p.is_dir() {
                out.push((rel + "/", Vec::new()));
                walk(base, &p, out);
            } else {
                out.push((rel, fs::read(&p).unwrap()));
            }
        }
    }
    walk(d, d, &mut v);
    v.sort();
    v
}

struct Fixture(PathBuf);
impl Fixture { fn path(&self) -> &Path { &self.0 } }
impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn run(home: Option<&Path>, args: &[&str]) -> Output {
    let mut c = Command::new(env!("CARGO_BIN_EXE_reposuite"));
    c.args(args).env_clear();
    if let Some(h) = home {
        c.env("HOME", h)
            .env("XDG_DATA_HOME", h.join("data"))
            .env("XDG_CONFIG_HOME", h.join("config"))
            .env("XDG_RUNTIME_DIR", h.join("run"));
    }
    // PATH kept minimal but present for libc/loader sanity.
    if let Ok(p) = env::var("PATH") {
        c.env("PATH", p);
    }
    c.output().unwrap()
}

fn stdout(o: &Output) -> String { String::from_utf8_lossy(&o.stdout).into_owned() }
fn stderr(o: &Output) -> String { String::from_utf8_lossy(&o.stderr).into_owned() }

#[test]
fn home_unset_and_empty_refuse_no_root_fallback() {
    for home in [None, Some(Path::new(""))] {
        let o = run(home, &["debug", "paths"]);
        assert!(!o.status.success(), "home={home:?} must refuse");
        assert!(stderr(&o).contains("debug disabled"), "{}", stderr(&o));
        assert!(!stdout(&o).contains("/reposuite/current"), "root fallback leaked");
    }
}

#[test]
fn gate_matrix_process_level() {
    let h = fixture("gate");
    for (body, want_ok) in [
        ("{\"debug_mode\": true}", true),
        ("{\"debug_mode\": false}", false),
        ("{\"debug_mode\": \"true\"}", false),
        ("{\"debug_mode\": 1}", false),
        ("{\"other\": 1}", false),
        ("not json {", false),
        ("[1,2]", false),
        ("\"x\"", false),
    ] {
        write_cfg(h.path(), body);
        let o = run(Some(h.path()), &["debug", "paths"]);
        assert_eq!(o.status.success(), want_ok, "body={body}");
        if !want_ok {
            assert!(stderr(&o).contains("debug disabled"), "{body}: {}", stderr(&o));
        }
    }
    // missing file
    fs::remove_file(h.path().join(".reposuite/config.json")).unwrap();
    let o = run(Some(h.path()), &["debug", "paths"]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("config missing"));
}

#[test]
fn json_output_single_object_and_exit_status() {
    let h = fixture("json");
    write_cfg(h.path(), "{\"debug_mode\": true}");
    for args in [&["debug", "paths", "--json"][..],
                 &["debug", "--json", "paths"][..],
                 &["debug", "config", "--json"][..]] {
        let o = run(Some(h.path()), args);
        assert!(o.status.success(), "{args:?}: {}", stderr(&o));
        let v: serde_json::Value =
            serde_json::from_str(stdout(&o).trim()).expect("one JSON object");
        assert!(v.is_object());
        assert!(v.get("action").is_some());
    }
    // error path: exactly one JSON object, nonzero exit
    let o = run(Some(h.path()), &["debug", "bogus", "--json"]);
    assert_eq!(o.status.code(), Some(1));
    let v: serde_json::Value =
        serde_json::from_str(stdout(&o).trim()).expect("one error object");
    assert_eq!(v["ok"], false);
    assert!(v["error"].as_str().unwrap().contains("usage"));
    assert!(stderr(&o).is_empty(), "json mode must not use stderr");
}

#[test]
fn text_errors_on_stderr_and_secret_never_printed() {
    let h = fixture("text");
    write_cfg(h.path(), "{\"debug_mode\": true, \"secret_marker\": \"S3CR3T-XYZZY\"}");
    let o = run(Some(h.path()), &["debug", "paths"]);
    assert_eq!(o.status.code(), Some(0));
    assert!(stdout(&o).contains("root="), "text paths output");
    assert!(stderr(&o).is_empty());
    for mode in [&["paths"][..], &["config"][..], &["paths", "--json"][..],
                 &["config", "--json"][..]] {
        let args: Vec<&str> = std::iter::once("debug")
            .chain(mode.iter().copied()).collect();
        let o = run(Some(h.path()), &args);
        let all = format!("{}{}", stdout(&o), stderr(&o));
        assert!(!all.contains("S3CR3T-XYZZY"), "secret leaked: {mode:?}");
        assert!(!all.contains("secret_marker"), "key name leaked");
    }
    // disabled error is stderr text, stdout empty
    fs::write(h.path().join(".reposuite/config.json"), "{\"debug_mode\": false}").unwrap();
    let o = run(Some(h.path()), &["debug", "paths"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(stdout(&o).is_empty());
    assert!(stderr(&o).contains("debug disabled"));
}

#[test]
fn no_file_mutations() {
    let h = fixture("nomut");
    write_cfg(h.path(), "{\"debug_mode\": true}");
    // nested sentinel proves recursive snapshot reaches deep files
    fs::write(h.path().join("data/sentinel.bin"), b"sentinel").unwrap();
    let before = snapshot(h.path());
    assert!(before.iter().any(|(p, _)| p == ".reposuite/config.json"),
            "snapshot must include nested config.json: {before:?}");
    assert!(before.iter().any(|(p, _)| p == "data/sentinel.bin"),
            "snapshot must include nested sentinel: {before:?}");
    for args in [&["debug", "paths"][..], &["debug", "config"][..],
                 &["debug", "paths", "--json"][..], &["debug", "config", "--json"][..]] {
        let o = run(Some(h.path()), args);
        assert_eq!(o.status.code(), Some(0), "{args:?}");
    }
    assert_eq!(snapshot(h.path()), before, "debug must not write files");
    // prove the snapshot is sensitive: intentional mutation then restore
    fs::write(h.path().join("data/sentinel.bin"), b"MUTATED").unwrap();
    assert_ne!(snapshot(h.path()), before, "snapshot must detect mutation");
    fs::write(h.path().join("data/sentinel.bin"), b"sentinel").unwrap();
    assert_eq!(snapshot(h.path()), before);
}
