#!/usr/bin/env python3
import json, os, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "scripts" / "release" / "resolve_tag.py"
TMP = Path(os.environ.get("TMPDIR") or tempfile.gettempdir())
HEX = "a" * 40

def git(repo, *a):
    return subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True, check=True).stdout.strip()

def run(repo, tag, env=None):
    e = dict(os.environ); e.update(env or {})
    return subprocess.run([sys.executable, str(TOOL), "--tag", tag, "--repo", str(repo), "--json"],
                          capture_output=True, text=True, env=e, timeout=60)

FAKE_GIT = '''#!/usr/bin/env python3
import sys, time
args = sys.argv[1:]
if args[:1] == ["-C"]: args = args[2:]
key = " ".join(args)
TAGOBJ = "a" * 40   # captured tag object A
COMMIT_A = "c" * 40 # what A peels to
COMMIT_B = "b" * 40 # what a retargeted name would peel to
SLEEP = float(__import__("os").environ.get("FAKE_GIT_SLEEP", "0"))
if SLEEP: time.sleep(SLEEP)
if key == "rev-parse --verify refs/tags/v9":
    print(TAGOBJ)
elif key == "rev-parse refs/tags/v9^{commit}":
    print(COMMIT_B)          # retargeted name -> B (old buggy path)
elif key == "rev-parse " + TAGOBJ + "^{commit}":
    print(COMMIT_A)          # captured object -> A's commit (fixed path)
elif key == "rev-parse " + TAGOBJ:
    print(TAGOBJ)
elif key == "status --porcelain":
    print("")
elif key == "show " + COMMIT_A + ":package.json":
    print('{"version":"1.2.3"}')
elif key == "show " + COMMIT_A + ":release-pins.json":
    print('{"schema_version":1,"gateway_sha":"' + "d"*40 + '","relay_sha":"' + "e"*40 + '","control_sha":null}')
elif key == "rev-parse --verify refs/tags/vbad":
    print("not-a-sha")
else:
    sys.stderr.write("unexpected git call: " + key + "\\n"); sys.exit(1)
'''

class T(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp(dir=TMP)); self.r = self.t / "repo"; self.r.mkdir()
        git(self.r, "init", "-q"); git(self.r, "config", "user.email", "t@t"); git(self.r, "config", "user.name", "t")
        (self.r / "package.json").write_text(json.dumps({"version": "9.9.9"}))
        (self.r / "release-pins.json").write_text(json.dumps({"schema_version": 1, "gateway_sha": HEX, "relay_sha": "b"*40, "control_sha": None}))
        git(self.r, "add", "."); git(self.r, "commit", "-qm", "c1")

    def tag(self, name, ann=True):
        if ann: git(self.r, "tag", "-a", name, "-m", "rel")
        else: git(self.r, "tag", name)

    def test_lightweight_tag_resolves(self):
        self.tag("v1", ann=False); r = run(self.r, "v1")
        self.assertEqual(r.returncode, 0); d = json.loads(r.stdout)
        self.assertEqual(d["status"], "resolved"); self.assertEqual(d["version"], "9.9.9")
        self.assertEqual(d["gateway_sha"], HEX); self.assertEqual(d["distribution_sha"], git(self.r, "rev-parse", "HEAD"))

    def test_annotated_tag_object_differs_from_commit(self):
        self.tag("v2"); d = json.loads(run(self.r, "v2").stdout)
        self.assertNotEqual(d["tag_object_sha"], d["distribution_sha"])

    def test_retarget_visible_between_resolutions(self):
        self.tag("v3"); first = json.loads(run(self.r, "v3").stdout)["distribution_sha"]
        (self.r / "x").write_text("x"); git(self.r, "add", "."); git(self.r, "commit", "-qm", "c2")
        git(self.r, "tag", "-f", "v3"); second = json.loads(run(self.r, "v3").stdout)["distribution_sha"]
        self.assertNotEqual(first, second)

    def test_branch_name_rejected(self):
        git(self.r, "branch", "main"); r = run(self.r, "main")
        self.assertNotEqual(r.returncode, 0)

    def test_dirty_and_untracked_rejected(self):
        self.tag("v4")
        (self.r / "package.json").write_text("{}")
        self.assertNotEqual(run(self.r, "v4").returncode, 0)
        git(self.r, "checkout", "--", "package.json")
        (self.r / "junk.txt").write_text("x")
        self.assertNotEqual(run(self.r, "v4").returncode, 0)

    def test_manifest_from_tag_not_worktree(self):
        self.tag("v5")
        (self.r / "release-pins.json").write_text(json.dumps({"schema_version": 1, "gateway_sha": "c"*40, "relay_sha": "d"*40}))
        git(self.r, "add", "."); git(self.r, "commit", "-qm", "c3")
        d = json.loads(run(self.r, "v5").stdout)
        self.assertEqual(d["gateway_sha"], HEX)  # tag's pins, not worktree 'c'*40

    def test_missing_pins_refused(self):
        (self.r / "release-pins.json").unlink(); git(self.r, "add", "-A"); git(self.r, "commit", "-qm", "c4")
        self.tag("v6"); r = run(self.r, "v6")
        self.assertNotEqual(r.returncode, 0); self.assertIn("error", json.loads(r.stdout))

    def test_bad_pin_refused(self):
        (self.r / "release-pins.json").write_text(json.dumps({"schema_version": 1, "gateway_sha": "zz", "relay_sha": "b"*40}))
        git(self.r, "add", "."); git(self.r, "commit", "-qm", "c5"); self.tag("v7")
        self.assertNotEqual(run(self.r, "v7").returncode, 0)

    def test_injection_rejected(self):
        for bad in ("v1;rm", "../x", "HEAD", "v1@{u}", "a b", "-x"):
            self.assertNotEqual(run(self.r, bad).returncode, 0, bad)

    # -- correctness rework: captured-object peel, type validation, git failures

    def _commit(self, fname, content):
        (self.r / fname).write_text(content)
        git(self.r, "add", fname); git(self.r, "commit", "-qm", "c-" + fname)

    def _fakegit_env(self, extra=None):
        bindir = self.t / "fakebin"; bindir.mkdir(exist_ok=True)
        fg = bindir / "git"; fg.write_text(FAKE_GIT); fg.chmod(0o755)
        env = {"PATH": f"{bindir}:{os.environ['PATH']}"}
        env.update(extra or {})
        return env

    def test_retarget_between_calls_uses_captured_object(self):
        """Deterministic retarget: name resolves to tagobj A, name^{commit}
        would now yield B, but the captured A object must peel to A."""
        env = self._fakegit_env()
        r = run(self.r, "v9", env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        d = json.loads(r.stdout)
        self.assertEqual(d["tag_object_sha"], "a" * 40)
        self.assertEqual(d["distribution_sha"], "c" * 40)  # A's commit, not B
        self.assertNotEqual(d["distribution_sha"], "b" * 40)

    def test_malformed_plumbing_sha_rejected(self):
        env = self._fakegit_env()
        r = run(self.r, "vbad", env=env)
        self.assertNotEqual(r.returncode, 0)
        d = json.loads(r.stdout)
        self.assertEqual(d["status"], "error")
        self.assertIn("malformed", d["error"])
        self.assertNotIn("Traceback", r.stderr)

    def test_git_timeout_is_json_error(self):
        env = self._fakegit_env({"FAKE_GIT_SLEEP": "5",
                                 "RESOLVE_TAG_GIT_TIMEOUT": "0.5"})
        r = run(self.r, "v9", env=env)
        self.assertNotEqual(r.returncode, 0)
        d = json.loads(r.stdout)
        self.assertEqual(d["status"], "error")
        self.assertIn("failed", d["error"])
        self.assertNotIn("Traceback", r.stderr)

    def test_missing_git_is_json_error(self):
        env = {"PATH": str(self.t / "empty-path")}
        (self.t / "empty-path").mkdir(exist_ok=True)
        r = run(self.r, "v1", env=env)
        self.assertNotEqual(r.returncode, 0)
        d = json.loads(r.stdout)
        self.assertEqual(d["status"], "error")
        self.assertNotIn("Traceback", r.stderr + r.stdout)

    def test_package_json_nonobject_rejected(self):
        for i, content in enumerate(("[1,2]", '"str"', "null", "42")):
            self._commit("package.json", content)
            self.tag(f"vnj{i}")
            r = run(self.r, f"vnj{i}")
            self.assertNotEqual(r.returncode, 0, content)
            self.assertEqual(json.loads(r.stdout)["status"], "error")

    def test_version_must_be_exact_semver_string(self):
        cases = [("{\"version\":\"latest\"}", "dist-tag"),
                 ("{\"version\":\"1.2\"}", "partial"),
                 ("{\"version\":123}", "nonstring"),
                 ("{\"version\":null}", "null"),
                 ("{}", "missing"),
                 ("{\"version\":\"1.2.3-beta..1\"}", "bad-prerelease")]
        for i, (content, why) in enumerate(cases):
            self._commit("package.json", content)
            self.tag(f"vsv{i}")
            r = run(self.r, f"vsv{i}")
            self.assertNotEqual(r.returncode, 0, why)
            self.assertEqual(json.loads(r.stdout)["status"], "error", why)

    def test_semver_prerelease_and_build_accepted(self):
        for i, v in enumerate(("1.2.3-rc.1", "2.0.0+build.5", "0.0.1")):
            self._commit("package.json", json.dumps({"version": v}))
            self.tag(f"vok{i}")
            r = run(self.r, f"vok{i}")
            self.assertEqual(r.returncode, 0, v)
            self.assertEqual(json.loads(r.stdout)["version"], v)

    def test_pins_nonobject_rejected(self):
        for i, content in enumerate(("[1]", '"x"', "null", "7")):
            self._commit("release-pins.json", content)
            self.tag(f"vpn{i}")
            r = run(self.r, f"vpn{i}")
            self.assertNotEqual(r.returncode, 0, content)
            self.assertEqual(json.loads(r.stdout)["status"], "error")

    def test_schema_version_must_be_int_one_not_bool(self):
        base = {"gateway_sha": "a"*40, "relay_sha": "b"*40, "control_sha": None}
        for i, sv in enumerate((True, "1", 2, 1.0, None)):
            pins = dict(base); pins["schema_version"] = sv
            self._commit("release-pins.json", json.dumps(pins))
            self.tag(f"vsc{i}")
            r = run(self.r, f"vsc{i}")
            self.assertNotEqual(r.returncode, 0, repr(sv))
            self.assertEqual(json.loads(r.stdout)["status"], "error")

if __name__ == "__main__":
    unittest.main()
