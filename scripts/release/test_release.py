#!/usr/bin/env python3
"""test_release.py — narrow fixtures for scripts/release mechanics.

Synthetic fixtures only (ELF-shaped stubs, no real binaries, no registry,
no providers, no mutation of real release-artifacts). Run from repo root:

    python3 scripts/release/test_release.py

Covers: verify_artifacts good/missing/extra/forged cases, prepare.sh
untracked-file rejection in an isolated clone, and publish.sh argument
exactness/order/tag rules/registry preflight/PARTIAL_PUBLISH via an npm
PATH shim.
"""

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
SCRIPTS = REPO / "scripts" / "release"
VERSION = "0.3.0-beta.1"
GW = "deec606ea7ed6623c666e6116fcc5b8db4257fca"
RY = "9f1c9ccd758428df65e9b60e85b8b38753a085a9"
LAUNCHER = b"#!/usr/bin/env node\n// fixture launcher\n"

PASS = 0
FAIL = 0


def chk(name, cond, detail=""):
    global PASS, FAIL
    print(f" {' ok ' if cond else 'FAIL'} {name}" + (f"  [{detail}]" if detail and not cond else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


def chk_reject(name, r, needle):
    chk(name, r.returncode != 0 and needle in (r.stderr + r.stdout),
        r.stderr + r.stdout)


def elf_stub():
    b = bytearray(64)
    b[:4] = b"\x7fELF"
    b[4], b[5] = 2, 1                      # ELF64, little-endian
    b[18:20] = (0x3E).to_bytes(2, "little")  # EM_X86_64
    return bytes(b)


def add_member(tf, name, data, mode=0o644, mtype=tarfile.REGTYPE, linkname=""):
    ti = tarfile.TarInfo(name)
    ti.type = mtype
    ti.mode = mode
    ti.linkname = linkname
    ti.mtime = 0
    if mtype == tarfile.REGTYPE:
        ti.size = len(data)
        tf.addfile(ti, io.BytesIO(data))
    else:
        tf.addfile(ti)


def make_tgz(path, members):
    with tarfile.open(path, "w:gz") as tf:
        for name, payload in members.items():
            if payload == "SYMLINK":
                add_member(tf, name, b"", mtype=tarfile.SYMTYPE, linkname="x")
            else:
                data, mode = payload
                add_member(tf, name, data, mode=mode)


def entry_pkg():
    return {
        "name": "reposuite", "version": VERSION,
        "repository": {"type": "git", "url": "https://github.com/reposuite/reposuite.git"},
        "bin": {"reposuite": "bin/reposuite.js"},
        "optionalDependencies": {"@reposuite/linux-x64": VERSION},
    }


def plat_pkg():
    return {
        "name": "@reposuite/linux-x64", "version": VERSION,
        "repository": {"type": "git", "url": "https://github.com/reposuite/reposuite.git"},
        "os": ["linux"], "cpu": ["x64"],
    }


def pins_text(built, go="go1.27.1", rust="rustc 1.93.1 (01f6ddf75 2026-02-11)"):
    return (
        f"control=\ngateway={GW}\nrelay={RY}\n"
        f"distribution={DIST}\ngo={go}\nrust={rust}\nbuilt={built}\n"
    ).encode()


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args],
                          capture_output=True, text=True, check=True).stdout.strip()


DIST = ""


def sandbox(root, *, manifest_over=None, sums_over=None, entry_over=None,
            plat_over=None, pins_kw=None):
    """Create a runnable fixture checkout: git repo + scripts + release-artifacts."""
    root = Path(root)
    (root / "bin").mkdir(parents=True)
    (root / "bin" / "reposuite.js").write_bytes(LAUNCHER)
    (root / "package.json").write_text(json.dumps({"name": "reposuite", "version": VERSION}))
    sdir = root / "scripts" / "release"
    sdir.mkdir(parents=True)
    for f in ("verify.sh", "verify_artifacts.py", "publish.sh", "prepare.sh"):
        shutil.copy2(SCRIPTS / f, sdir / f)
    git(root, "init", "-q")
    git(root, "add", "-A")
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture")
    global DIST
    DIST = git(root, "rev-parse", "HEAD")

    built = "2026-10-27T00:00:00Z"
    manifest = {"version": VERSION,
                "pins": {"distribution": DIST, "control": "", "gateway": GW, "relay": RY},
                "built": built}
    if manifest_over:
        manifest.update(manifest_over)

    entry_members = {
        "package/bin/reposuite.js": (LAUNCHER, 0o644),
        "package/package.json": (json.dumps(entry_pkg()).encode(), 0o644),
        "package/README.md": (b"readme\n", 0o644),
        "package/LICENSE.md": (b"license\n", 0o644),
        "package/CHANGELOG.md": (b"changes\n", 0o644),
    }
    plat_members = {
        "package/bin/reposuite": (elf_stub(), 0o755),
        "package/bin/reposuite-gateway": (elf_stub(), 0o755),
        "package/bin/reposuite-relay": (elf_stub(), 0o755),
        "package/bin/PINS.txt": (pins_text(built, **(pins_kw or {})), 0o644),
        "package/package.json": (json.dumps(plat_pkg()).encode(), 0o644),
    }
    if entry_over:
        entry_members.update(entry_over)
    if plat_over:
        plat_members.update(plat_over)

    art = root / "release-artifacts"
    art.mkdir()
    et = art / f"reposuite-{VERSION}.tgz"
    pt = art / f"reposuite-linux-x64-{VERSION}.tgz"
    make_tgz(et, entry_members)
    make_tgz(pt, plat_members)
    sums = {t.name: hashlib.sha256(t.read_bytes()).hexdigest() for t in (et, pt)}
    if sums_over is not None:
        sums = sums_over
    (art / "SHA256SUMS").write_text("".join(f"{d}  {n}\n" for n, d in sums.items()))
    (art / "manifest.json").write_text(json.dumps(manifest))
    return root


def run_verify(root, env_extra=None):
    env = dict(os.environ, GATEWAY_SHA=GW, RELAY_SHA=RY)
    env.update(env_extra or {})
    r = subprocess.run(["bash", "scripts/release/verify.sh"],
                       cwd=root, env=env, capture_output=True, text=True)
    return r


def npm_shim(root):
    """npm shim: logs argv, answers `view`/`publish` from env knobs."""
    bindir = Path(root) / "shim-bin"
    bindir.mkdir(exist_ok=True)
    shim = bindir / "npm"
    shim.write_text("""#!/usr/bin/env bash
echo "npm $*" >> "$NPM_SHIM_LOG"
if [ "$1" = view ]; then
  case " $* " in
    *" dist-tags.latest "*) echo '"0.1.0"'; exit 0;;
  esac
  case "${NPM_SHIM_VIEW:-e404}" in
    e404) echo '{"error":{"code":"E404","summary":"Not Found"}}'; exit 1;;
    e500) echo '{"error":{"code":"E500","summary":"Internal Error"}}'; exit 1;;
    exists) echo '["0.3.0-beta.1"]'; exit 0;;
  esac
fi
if [ "$1" = publish ]; then
  case "${NPM_SHIM_FAIL_PUBLISH:-none}" in
    platform) [[ "$2" == *linux-x64* ]] && exit 1;;
    entry) [[ "$2" != *linux-x64* ]] && exit 1;;
  esac
  exit 0
fi
exit 0
""")
    shim.chmod(0o755)
    return bindir


def run_publish(root, env_extra):
    log = Path(root) / "npm-shim.log"
    env = dict(os.environ,
               PATH=f"{npm_shim(root)}:{os.environ['PATH']}",
               NPM_SHIM_LOG=str(log),
               GATEWAY_SHA=GW, RELAY_SHA=RY)
    env.update(env_extra)
    r = subprocess.run(["bash", "scripts/release/publish.sh", "--approve"],
                       cwd=root, env=env, capture_output=True, text=True)
    return r, log.read_text() if log.exists() else ""


def main():
    tmp = Path(tempfile.mkdtemp(prefix="reltst-"))
    os.chdir(tmp)

    # ---------- verify_artifacts ----------
    good = sandbox(tmp / "good")
    r = run_verify(good)
    chk("verify: good fixture passes", r.returncode == 0, r.stderr)

    # missing member: rebuild entry tgz without CHANGELOG.md
    sub = sandbox(tmp / "missing")
    et = sub / "release-artifacts" / f"reposuite-{VERSION}.tgz"
    members = {
        "package/bin/reposuite.js": (LAUNCHER, 0o644),
        "package/package.json": (json.dumps(entry_pkg()).encode(), 0o644),
        "package/README.md": (b"readme\n", 0o644),
        "package/LICENSE.md": (b"license\n", 0o644),
    }
    make_tgz(et, members)
    # sums now stale — fix only sums to isolate "missing member" as the failure
    sums = {t.name: hashlib.sha256(t.read_bytes()).hexdigest()
            for t in (et, sub / "release-artifacts" / f"reposuite-linux-x64-{VERSION}.tgz")}
    (sub / "release-artifacts" / "SHA256SUMS").write_text(
        "".join(f"{d}  {n}\n" for n, d in sums.items()))
    r = run_verify(sub)
    chk_reject("verify: missing CHANGELOG rejected", r, "missing members")

    r = run_verify(sandbox(tmp / "extra", entry_over={"package/evil.sh": (b"x", 0o644)}))
    chk_reject("verify: extra member rejected", r, "unexpected member")

    r = run_verify(sandbox(tmp / "link", entry_over={"package/link": "SYMLINK"}))
    chk_reject("verify: symlink member rejected", r, "non-regular member")

    r = run_verify(sandbox(tmp / "forgever", manifest_over={"version": "9.9.9"}))
    chk_reject("verify: forged manifest version rejected", r, "!=")

    # third tarball on disk — SUMS still exact but extra .tgz must fail
    t3 = sandbox(tmp / "thirdtgz")
    shutil.copy2(t3 / "release-artifacts" / f"reposuite-{VERSION}.tgz",
                 t3 / "release-artifacts" / "stowaway.tgz")
    r = run_verify(t3)
    chk_reject("verify: third tarball on disk rejected", r, "expected two tarballs")

    # missing manifest.built — must not compare absent==absent
    mb = sandbox(tmp / "nobuilt")
    mp = mb / "release-artifacts" / "manifest.json"
    m = json.loads(mp.read_text()); del m["built"]
    mp.write_text(json.dumps(m))
    r = run_verify(mb)
    chk_reject("verify: missing manifest.built rejected", r, "built")

    r = run_verify(sandbox(tmp / "rust1310", pins_kw={"rust": "rustc 1.93.10 (x)"}))
    chk_reject("verify: rustc 1.93.10 prefix rejected", r, "rustc 1.93.1")

    # forged gateway pin: mutate manifest post-sandbox so ONLY the gateway
    # pin is wrong (distribution stays == HEAD of this sandbox).
    fp = sandbox(tmp / "forgepin")
    mp = fp / "release-artifacts" / "manifest.json"
    m = json.loads(mp.read_text()); m["pins"]["gateway"] = "0" * 40
    mp.write_text(json.dumps(m))
    r = run_verify(fp)
    chk_reject("verify: forged gateway pin rejected", r, "gateway pin")

    badsums = sandbox(tmp / "badsums",
                      sums_over={f"reposuite-{VERSION}.tgz": "0" * 64,
                                 f"reposuite-linux-x64-{VERSION}.tgz": "0" * 64})
    r = run_verify(badsums)
    chk_reject("verify: forged SHA256SUMS rejected", r, "sha256 mismatch")

    r = run_verify(sandbox(tmp / "mutlaunch",
                           entry_over={"package/bin/reposuite.js": (b"// tampered\n", 0o644)}))
    chk_reject("verify: mutated launcher rejected", r, "launcher")

    r = run_verify(sandbox(tmp / "badgo", pins_kw={"go": "go1.24.3"}))
    chk_reject("verify: wrong go pin rejected", r, "go1.27.1")

    r = run_verify(good, env_extra={"RELAY_SHA": "not-hex"})
    chk_reject("verify: non-40hex env pin rejected", r, "40-hex")

    r = run_verify(good, env_extra={"RELAY_SHA": ""})
    chk_reject("verify: empty env pin rejected", r, "40-hex")

    # ---------- prepare.sh (minimal isolated fixture — no repo copytree) ---
    pre = tmp / "prep" / "repo"
    (pre / "scripts" / "release").mkdir(parents=True)
    (pre / "package.json").write_text(json.dumps({"name": "reposuite", "version": VERSION}))
    shutil.copy2(SCRIPTS / "prepare.sh", pre / "scripts" / "release" / "prepare.sh")
    git(pre, "init", "-q")
    git(pre, "add", "-A")
    git(pre, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture")
    env = dict(os.environ, GATEWAY_SHA=GW, RELAY_SHA=RY)
    # clean tree: passes version+dirty checks, fails only at missing siblings
    r = subprocess.run(["bash", "scripts/release/prepare.sh", VERSION],
                       cwd=pre, env=env, capture_output=True, text=True)
    chk("prepare: clean tree reaches sibling check",
        "gateway" in r.stderr + r.stdout or "missing" in r.stderr + r.stdout,
        r.stderr)
    (pre / "untracked.txt").write_text("dirt")
    r = subprocess.run(["bash", "scripts/release/prepare.sh", VERSION],
                       cwd=pre, env=env, capture_output=True, text=True)
    chk("prepare: untracked file rejected", r.returncode != 0 and "untracked" in r.stderr + r.stdout,
        r.stderr)

    # ---------- publish.sh ----------
    pub = sandbox(tmp / "pub")
    r, log = run_publish(pub, {"DRY_RUN": "1"})
    chk("publish dry-run rc=0", r.returncode == 0, r.stderr)
    lines = [l for l in log.splitlines() if l.startswith("npm publish")]
    chk("publish: exactly 2 npm publish calls", len(lines) == 2, log)
    if len(lines) == 2:
        chk("publish: platform before entry", "linux-x64" in lines[0] and "linux-x64" not in lines[1])
        chk("publish: exact absolute tgz args",
            f'"{pub}/release-artifacts/reposuite-linux-x64-{VERSION}.tgz"' in lines[0] or
            f"{pub}/release-artifacts/reposuite-linux-x64-{VERSION}.tgz" in lines[0])
        chk("publish: --provenance --ignore-scripts --dry-run present",
            all(x in lines[0] for x in ("--provenance", "--ignore-scripts", "--dry-run", "--tag beta")))
    chk("publish: no re-pack (no npm pack)", "npm pack" not in log)

    r, log = run_publish(sandbox(tmp / "pub-latest"), {"NPM_TAG": "latest"})
    chk("publish: prerelease+latest denied before npm", r.returncode != 0 and "npm publish" not in log)

    r, log = run_publish(sandbox(tmp / "pub-e404"), {})
    chk("publish: E404 absence accepted, full publish", r.returncode == 0 and log.count("npm publish") == 2,
        r.stderr + log)
    chk("publish: dist-tag guard ran (3 view calls)", log.count("npm view") >= 3, log)

    r, log = run_publish(sandbox(tmp / "pub-e500"), {"NPM_SHIM_VIEW": "e500"})
    chk("publish: E500 aborts before npm publish", r.returncode != 0 and "npm publish" not in log,
        r.stderr + log)

    r, log = run_publish(sandbox(tmp / "pub-exists"), {"NPM_SHIM_VIEW": "exists"})
    chk("publish: existing version aborts before publish", r.returncode != 0 and "npm publish" not in log,
        r.stderr + log)

    r, log = run_publish(sandbox(tmp / "pub-partial"), {"NPM_SHIM_FAIL_PUBLISH": "entry"})
    chk("publish: entry failure => PARTIAL_PUBLISH", r.returncode != 0 and "PARTIAL_PUBLISH" in r.stderr + r.stdout,
        r.stderr + r.stdout)
    chk("publish: platform still attempted first", log.count("npm publish") == 2, log)

    print(f"\n{'FAIL' if FAIL else 'test-release: OK'}  pass={PASS} fail={FAIL}")
    shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
