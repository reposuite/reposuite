#!/usr/bin/env python3
"""resolve_tag.py --tag <GIT_TAG> [--repo <checkout>] [--json] [--dry-run]

Resolve an exact git tag to a frozen release pinset. Read-only: never
creates tags, never falls back to env vars/HEAD/branches, never claims
provenance signatures or runtime compatibility.
Output schema_version=1: release_tag, tag_object_sha, distribution_sha
(peeled commit), version (package.json at tag), gateway_sha, relay_sha,
control_sha (nullable), status=resolved. Errors -> JSON, nonzero exit.
"""
import argparse, json, re, subprocess, sys

HEX40 = re.compile(r"^[0-9a-f]{40}$")
TAGNAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
FORBIDDEN = ("..", "//", "@{", "\\", " ", "~", "^", ":", "?", "*", "[", "]")


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args],
                          capture_output=True, text=True, timeout=30)


def fail(msg):
    print(json.dumps({"schema_version": 1, "status": "error", "error": msg}))
    sys.exit(2)


def valid_tag(name):
    return (TAGNAME.match(name) and not name.endswith("/") and not name.endswith(".")
            and not name.endswith(".lock") and ".." not in name
            and not any(c in name for c in ("@{", "\\", " ", "~", "^", ":", "?", "*", "[", "]")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--repo", default=".")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if not valid_tag(a.tag):
        fail(f"malformed or unsafe tag ref: {a.tag!r}")
    # exact tag object only — never a branch/HEAD/SHA/path
    t = git(a.repo, "rev-parse", "--verify", f"refs/tags/{a.tag}")
    if t.returncode != 0:
        fail(f"tag not found or not a tag object: refs/tags/{a.tag}")
    tag_obj = t.stdout.strip()
    # peeled commit
    c = git(a.repo, "rev-parse", f"refs/tags/{a.tag}^{{commit}}")
    if c.returncode != 0:
        fail(f"tag does not peel to a commit: {a.tag}")
    dist_sha = c.stdout.strip()
    # clean tree required (untracked included) — resolved from committed state only
    st = git(a.repo, "status", "--porcelain")
    if st.returncode != 0 or st.stdout.strip():
        fail("repo worktree not clean (tracked or untracked changes present)")
    # version from tag's package.json
    pj = git(a.repo, "show", f"{dist_sha}:package.json")
    if pj.returncode != 0:
        fail("package.json absent at tag commit")
    try:
        version = json.loads(pj.stdout).get("version")
    except Exception:
        fail("package.json at tag is not valid JSON")
    if not version:
        fail("package.json at tag lacks version")
    # pins manifest FROM TAG COMMIT, not worktree/env
    pm = git(a.repo, "show", f"{dist_sha}:release-pins.json")
    if pm.returncode != 0:
        fail("release-pins.json absent at tag commit — tag predates pin manifest")
    try:
        pins = json.loads(pm.stdout)
    except Exception:
        fail("release-pins.json at tag is not valid JSON")
    if pins.get("schema_version") != 1:
        fail("release-pins.json schema_version != 1")
    out = {"schema_version": 1, "release_tag": a.tag, "tag_object_sha": tag_obj,
           "distribution_sha": dist_sha, "version": version,
           "gateway_sha": pins.get("gateway_sha"), "relay_sha": pins.get("relay_sha"),
           "control_sha": pins.get("control_sha"), "status": "resolved"}
    for k in ("gateway_sha", "relay_sha"):
        if not (isinstance(out[k], str) and HEX40.match(out[k])):
            fail(f"release-pins.json {k} missing or not 40-hex")
    cs = out["control_sha"]
    if cs is not None and not (isinstance(cs, str) and HEX40.match(cs)):
        fail("release-pins.json control_sha present but not 40-hex")
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
