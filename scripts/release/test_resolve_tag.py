#!/usr/bin/env python3
import json, os, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "scripts" / "release" / "resolve_tag.py"
TMP = Path(os.environ.get("TMPDIR", "/nonexistent"))
HEX = "a" * 40

def git(repo, *a):
    return subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True, check=True).stdout.strip()

def run(repo, tag):
    return subprocess.run([sys.executable, str(TOOL), "--tag", tag, "--repo", str(repo), "--json"],
                          capture_output=True, text=True)

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

if __name__ == "__main__":
    unittest.main()
