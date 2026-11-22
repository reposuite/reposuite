#!/usr/bin/env python3
"""Check packaged Go build metadata against PINS.txt and the release builder.

Run after verify.sh has validated the tarball member set and checksums. `go
version` reads ELF build information; it does not execute packaged binaries.
"""
import json
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent


def main():
    version = json.loads((ROOT / "package.json").read_text())["version"]
    archive = Path(sys.argv[1]) if len(sys.argv) == 2 else ROOT / "release-artifacts" / f"reposuite-linux-x64-{version}.tgz"
    if len(sys.argv) > 2:
        raise ValueError("expected at most one archive path")
    builder = (ROOT / "scripts/release/build.sh").read_text()
    expected = {}
    for key in ("GW_GO", "RELAY_GO"):
        matches = re.findall(rf"^{key}=(go[0-9.]+)$", builder, re.MULTILINE)
        if len(matches) != 1:
            raise ValueError(f"invalid {key} in build.sh")
        expected[key] = matches[0]
    with tarfile.open(archive, "r:gz") as tf, tempfile.TemporaryDirectory(prefix="rs-go-proof-") as tmp:
        members = tf.getmembers()
        names = [m.name for m in members]
        required = ("package/bin/PINS.txt", "package/bin/reposuite-gateway", "package/bin/reposuite-relay")
        if any(names.count(name) != 1 for name in required):
            raise ValueError("missing or duplicate binary or PINS.txt")
        if any(not tf.getmember(name).isreg() for name in required):
            raise ValueError("binary and PINS.txt members must be regular files")
        pins = {}
        for line in tf.extractfile(required[0]).read().decode().splitlines():
            key, sep, value = line.partition("=")
            if not sep or key in pins:
                raise ValueError("invalid or duplicate PINS.txt key")
            pins[key] = value
        for product, key, pin in (("gateway", "GW_GO", "go_gateway"), ("relay", "RELAY_GO", "go_relay")):
            if pins.get(pin) != expected[key]:
                raise ValueError(f"{pin} differs from {key} in build.sh")
            path = Path(tmp) / f"reposuite-{product}"
            path.write_bytes(tf.extractfile(f"package/bin/reposuite-{product}").read())
            result = subprocess.run(["go", "version", str(path)], capture_output=True, text=True, check=True)
            if result.stdout.strip().split()[-1] != expected[key]:
                raise ValueError(f"{product} binary toolchain differs from PINS.txt and build.sh")
            print(f"{product}: {expected[key]} matches package metadata and builder")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, tarfile.TarError, subprocess.CalledProcessError) as exc:
        print(f"packaged Go verification failed: {exc}", file=sys.stderr)
        sys.exit(1)
