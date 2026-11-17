#!/usr/bin/env python3
"""resolve_tag.py --tag <GIT_TAG> [--repo <checkout>] [--json] [--dry-run]

Resolve an exact git tag to a frozen release pinset. Read-only: never
creates tags, never falls back to env vars/HEAD/branches, never claims
provenance signatures or runtime compatibility.
Output schema_version=1: release_tag, tag_object_sha, distribution_sha
(peeled commit), version (package.json at tag), gateway_sha, relay_sha,
control_sha (nullable), status=resolved. Errors -> JSON, nonzero exit.

Correctness: the tag ref is resolved ONCE to a captured object SHA and
that object — never the mutable tag name — is peeled to its commit, so a
retarget between calls cannot produce an inconsistent pinset.
"""
import argparse, json, os, re, subprocess, sys

HEX40 = re.compile(r"^[0-9a-f]{40}$")
SEMVER = re.compile(
    r"^\d+\.\d+\.\d+"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")
TAGNAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
try:
    GIT_TIMEOUT = float(os.environ.get("RESOLVE_TAG_GIT_TIMEOUT", "30"))
except ValueError:
    GIT_TIMEOUT = 30.0


def git(repo, *args):
    try:
        return subprocess.run(["git", "-C", repo, *args],
                              capture_output=True, text=True,
                              timeout=GIT_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as e:
        fail(f"git {' '.join(args)} failed: {e}")


def fail(msg):
    print(json.dumps({"schema_version": 1, "status": "error", "error": msg}))
    sys.exit(2)


def valid_tag(name):
    return (TAGNAME.match(name) and not name.endswith("/") and not name.endswith(".")
            and not name.endswith(".lock") and ".." not in name
            and not any(c in name for c in ("@{", "\\", " ", "~", "^", ":", "?", "*", "[", "]")))


def load_json_object(raw, what):
    try:
        doc = json.loads(raw)
    except Exception:
        fail(f"{what} at tag is not valid JSON")
    if not isinstance(doc, dict):
        fail(f"{what} at tag is not a JSON object")
    return doc


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
    if not HEX40.match(tag_obj):
        fail(f"git returned malformed tag object sha: {tag_obj!r}")
    # Peel the CAPTURED object sha — never re-resolve the mutable tag
    # name, which could have been retargeted between the two calls.
    c = git(a.repo, "rev-parse", f"{tag_obj}^{{commit}}")
    if c.returncode != 0:
        fail(f"tag object {tag_obj} does not peel to a commit")
    dist_sha = c.stdout.strip()
    if not HEX40.match(dist_sha):
        fail(f"git returned malformed commit sha: {dist_sha!r}")
    # clean tree required (untracked included) — resolved from committed state only
    st = git(a.repo, "status", "--porcelain")
    if st.returncode != 0 or st.stdout.strip():
        fail("repo worktree not clean (tracked or untracked changes present)")
    # version from tag's package.json
    pj = git(a.repo, "show", f"{dist_sha}:package.json")
    if pj.returncode != 0:
        fail("package.json absent at tag commit")
    pkg = load_json_object(pj.stdout, "package.json")
    version = pkg.get("version")
    if not (isinstance(version, str) and SEMVER.match(version)):
        fail("package.json at tag lacks an exact semver version string")
    # pins manifest FROM TAG COMMIT, not worktree/env
    pm = git(a.repo, "show", f"{dist_sha}:release-pins.json")
    if pm.returncode != 0:
        fail("release-pins.json absent at tag commit — tag predates pin manifest")
    pins = load_json_object(pm.stdout, "release-pins.json")
    sv = pins.get("schema_version")
    if not (isinstance(sv, int) and not isinstance(sv, bool) and sv == 1):
        fail("release-pins.json schema_version must be integer 1")
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
