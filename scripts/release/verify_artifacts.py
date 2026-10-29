#!/usr/bin/env python3
"""verify_artifacts.py — release artifact gate (stdlib only).

Validates release-artifacts/ — tarballs, SHA256SUMS, manifest.json — NOT
the build tree. Runs from the distribution checkout root; works identically
in the publish job where only the downloaded artifacts exist.

Contract (fail-closed on any violation):
  * root package.json version == manifest.version
  * manifest.pins: distribution == git HEAD, gateway/relay == env
    GATEWAY_SHA/RELAY_SHA — all required lowercase 40-hex, none optional
  * exactly two tarballs: reposuite-<v>.tgz + reposuite-linux-x64-<v>.tgz
  * SHA256SUMS lists exactly those two names with the actual digests
  * entry archive member set EXACTLY {bin/reposuite.js, package.json,
    README.md, LICENSE.md, CHANGELOG.md} under package/
  * platform archive member set EXACTLY {bin/reposuite,
    bin/reposuite-gateway, bin/reposuite-relay, bin/PINS.txt,
    package.json} under package/
  * no links/specials/traversal/extra members; every member regular
  * platform binaries executable, no setuid/setgid, ELF64 LE x86_64
  * package.json names/versions exact; entry optionalDependencies pins
    @reposuite/linux-x64 at the same version; both repository.url
    canonical; no install-time script hooks
  * PINS.txt strict key=value, no duplicates: distribution/gateway/relay
    match manifest, go == go1.27.3, rust starts "rustc 1.93.1",
    built == manifest.built
  * entry launcher bytes == bin/reposuite.js in this checkout (frozen
    wrapper integrity)
"""

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

CHECKS = 0


def ok(msg):
    global CHECKS
    CHECKS += 1
    print(f"  ok {msg}")


def fail(msg):
    print(f"verify: FAIL {msg}", file=sys.stderr)
    sys.exit(1)


def sha256_file(p):
    h = hashlib.sha256()
    h.update(p.read_bytes())
    return h.hexdigest()


def hex40(name, value):
    if (
        not isinstance(value, str)
        or len(value) != 40
        or any(c not in "0123456789abcdef" for c in value)
    ):
        fail(f"{name} is not a lowercase 40-hex pin: {value!r}")
    return value


def git_head():
    r = subprocess.run(
        ["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=os.getcwd()
    )
    if r.returncode != 0:
        fail(f"git rev-parse HEAD failed: {r.stderr.strip()}")
    return hex40("git HEAD", r.stdout.strip())


def archive_members(tgz, expected):
    """Return {name: TarInfo-with-bytes} requiring exactly `expected` regular files."""
    found = {}
    with tarfile.open(tgz, "r:gz") as tf:
        for m in tf:
            name = m.name
            if name in (".", "./") or name.endswith("/"):
                fail(f"{tgz.name}: directory entry {name!r} not allowed")
            if ".." in name.split("/") or name.startswith("/"):
                fail(f"{tgz.name}: traversal member {name!r}")
            if not m.isreg():
                fail(f"{tgz.name}: non-regular member {name!r} (type {m.type!r})")
            if name in found:
                fail(f"{tgz.name}: duplicate member {name!r}")
            if name not in expected:
                fail(f"{tgz.name}: unexpected member {name!r}")
            f = tf.extractfile(m)
            found[name] = (m, f.read() if f else b"")
    missing = expected - found.keys()
    if missing:
        fail(f"{tgz.name}: missing members {sorted(missing)}")
    return found


def pkg_json(members, name):
    try:
        return json.loads(members[name][1])
    except Exception as e:
        fail(f"{name}: unparseable package.json: {e}")


def elf_x86_64(name, data):
    # ELF64, little-endian, machine x86-64 (EM_X86_64 = 0x3e)
    if len(data) < 20 or data[:4] != b"\x7fELF":
        fail(f"{name}: not an ELF payload")
    if data[4] != 2 or data[5] != 1:
        fail(f"{name}: not ELF64 little-endian")
    if int.from_bytes(data[18:20], "little") != 0x3E:
        fail(f"{name}: not an x86_64 ELF")


def main():
    root = Path.cwd()
    art = root / "release-artifacts"
    if not art.is_dir():
        fail(f"release-artifacts/ not found under {root}")

    # ---- root version + manifest pins -------------------------------------
    try:
        root_version = json.loads((root / "package.json").read_text())["version"]
    except Exception as e:
        fail(f"root package.json unreadable: {e}")
    try:
        manifest = json.loads((art / "manifest.json").read_text())
    except Exception as e:
        fail(f"manifest.json unreadable: {e}")
    version = manifest.get("version")
    if version != root_version:
        fail(f"manifest.version {version!r} != package.json {root_version!r}")
    ok(f"version {version}")

    head = git_head()
    gw = hex40("env GATEWAY_SHA", os.environ.get("GATEWAY_SHA"))
    ry = hex40("env RELAY_SHA", os.environ.get("RELAY_SHA"))
    pins = manifest.get("pins") or {}
    if hex40("manifest pins.distribution", pins.get("distribution")) != head:
        fail(f"manifest distribution pin {pins.get('distribution')!r} != HEAD {head}")
    if hex40("manifest pins.gateway", pins.get("gateway")) != gw:
        fail("manifest gateway pin != env GATEWAY_SHA")
    if hex40("manifest pins.relay", pins.get("relay")) != ry:
        fail("manifest relay pin != env RELAY_SHA")
    ok(f"pins distribution={head[:12]}… gateway={gw[:12]}… relay={ry[:12]}… match manifest")

    built = manifest.get("built")
    if not isinstance(built, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", built
    ):
        fail(f"manifest.built is not a strict UTC timestamp: {built!r}")
    ok(f"manifest.built {built}")

    # ---- tarball set + SHA256SUMS ------------------------------------------
    entry_tgz = art / f"reposuite-{version}.tgz"
    plat_tgz = art / f"reposuite-linux-x64-{version}.tgz"
    on_disk = {p.name for p in art.glob("*.tgz")}
    if on_disk != {entry_tgz.name, plat_tgz.name}:
        fail(f"release-artifacts/*.tgz {sorted(on_disk)} != expected two tarballs")
    for t in (entry_tgz, plat_tgz):
        if not t.is_file():
            fail(f"expected tarball missing: {t.name}")
    sums = {}
    for line in (art / "SHA256SUMS").read_text().splitlines():
        if not line.strip():
            continue
        digest, _, name = line.partition("  ")
        if not digest or not name:
            fail(f"SHA256SUMS malformed line: {line!r}")
        if name in sums:
            fail(f"SHA256SUMS duplicate name {name!r}")
        sums[name] = digest
    if set(sums) != {entry_tgz.name, plat_tgz.name}:
        fail(f"SHA256SUMS names {sorted(sums)} != expected tarballs")
    for t in (entry_tgz, plat_tgz):
        actual = sha256_file(t)
        if sums[t.name] != actual:
            fail(f"{t.name}: sha256 mismatch (manifest {sums[t.name][:12]}… != actual {actual[:12]}…)")
        ok(f"{t.name} sha256 {actual}")

    # ---- entry archive ------------------------------------------------------
    entry = archive_members(
        entry_tgz,
        {
            "package/bin/reposuite.js",
            "package/package.json",
            "package/README.md",
            "package/LICENSE.md",
            "package/CHANGELOG.md",
        },
    )
    ok(f"{entry_tgz.name}: member set exact ({len(entry)} files)")
    epkg = pkg_json(entry, "package/package.json")
    if epkg.get("name") != "reposuite" or epkg.get("version") != version:
        fail(f"entry package.json name/version wrong: {epkg.get('name')!r}@{epkg.get('version')!r}")
    if (epkg.get("optionalDependencies") or {}).get("@reposuite/linux-x64") != version:
        fail("entry optionalDependencies must pin @reposuite/linux-x64 at same version")

    # ---- platform archive ---------------------------------------------------
    plat = archive_members(
        plat_tgz,
        {
            "package/bin/reposuite",
            "package/bin/reposuite-gateway",
            "package/bin/reposuite-relay",
            "package/bin/PINS.txt",
            "package/package.json",
        },
    )
    ok(f"{plat_tgz.name}: member set exact ({len(plat)} files)")
    ppkg = pkg_json(plat, "package/package.json")
    if ppkg.get("name") != "@reposuite/linux-x64" or ppkg.get("version") != version:
        fail(f"platform package.json name/version wrong: {ppkg.get('name')!r}@{ppkg.get('version')!r}")

    for pname, pj in (("entry", epkg), ("platform", ppkg)):
        if (pj.get("repository") or {}).get("url") != "https://github.com/reposuite/reposuite.git":
            fail(f"{pname} repository.url not canonical")
        hooks = set((pj.get("scripts") or {})) & {"install", "preinstall", "postinstall", "prepare"}
        if hooks:
            fail(f"{pname} package.json carries install hooks: {sorted(hooks)}")

    for name in ("reposuite", "reposuite-gateway", "reposuite-relay"):
        m, data = plat[f"package/bin/{name}"]
        mode = stat.S_IMODE(m.mode)
        if not mode & 0o111:
            fail(f"{name}: not executable (mode {oct(mode)})")
        if mode & 0o6000:
            fail(f"{name}: setuid/setgid bits set (mode {oct(mode)})")
        elf_x86_64(name, data)
    ok("platform binaries: executable ELF64 x86_64, no setuid/setgid")

    # ---- PINS.txt -----------------------------------------------------------
    pins_kv = {}
    for line in plat["package/bin/PINS.txt"][1].decode().splitlines():
        if "=" not in line:
            fail(f"PINS.txt non key=value line: {line!r}")
        k, _, v = line.partition("=")
        if k in pins_kv:
            fail(f"PINS.txt duplicate key {k!r}")
        pins_kv[k] = v
    for k in ("distribution", "gateway", "relay"):
        if pins_kv.get(k) != pins.get(k):
            fail(f"PINS.txt {k} {pins_kv.get(k)!r} != manifest {pins.get(k)!r}")
    if pins_kv.get("go") != "go1.27.3":
        fail(f"PINS.txt go {pins_kv.get('go')!r} != go1.27.3")
    if not (pins_kv.get("rust") or "").startswith("rustc 1.93.1 "):
        fail(f"PINS.txt rust {pins_kv.get('rust')!r} does not start 'rustc 1.93.1 '")
    if pins_kv.get("built") != built:
        fail("PINS.txt built != manifest.built")
    ok("PINS.txt: pins/go1.27.3/rustc-1.93.1/built all match")

    # ---- frozen launcher integrity ------------------------------------------
    frozen = (root / "bin" / "reposuite.js").read_bytes()
    if entry["package/bin/reposuite.js"][1] != frozen:
        fail("entry launcher bytes != bin/reposuite.js at checkout")
    ok("launcher byte-identical to bin/reposuite.js")

    print(f"verify: artifacts clean — {CHECKS} checks passed")


if __name__ == "__main__":
    main()
