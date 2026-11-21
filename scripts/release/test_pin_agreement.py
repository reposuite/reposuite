#!/usr/bin/env python3
"""Offline fixture tests for check_pin_agreement.py — fabricated tag/
version/pin data ONLY. No production pins, no network, no real repo."""
import json, os, subprocess, sys, tempfile, unittest
HERE=os.path.dirname(os.path.abspath(__file__))
CHK=os.path.join(HERE,"check_pin_agreement.py")
GW="a"*40; RL="b"*40; GW_BAD="c"*40

def git(repo,*a):
    return subprocess.run(["git","-C",repo,*a],capture_output=True,text=True,check=True).stdout.strip()

def make_repo(root,pins=None,version="9.9.9-test.0",tag="v9.9.9-test"):
    os.makedirs(root,exist_ok=True)
    git(root,"init","-q")
    git(root,"config","user.email","t@t"); git(root,"config","user.name","t")
    open(os.path.join(root,"package.json"),"w").write(json.dumps({"version":version}))
    if pins is not None:
        open(os.path.join(root,"release-pins.json"),"w").write(json.dumps(pins))
    git(root,"add","-A"); git(root,"commit","-qm","fixture")
    sha=git(root,"rev-parse","HEAD")
    git(root,"tag",tag)
    return sha

PINS={"schema_version":1,"gateway_sha":GW,"relay_sha":RL,"control_sha":None}

class TestAgreement(unittest.TestCase):
    def run_chk(self,repo,tag,dist,gw,rl):
        return subprocess.run([sys.executable,CHK,"--tag",tag,"--repo",repo,
            "--expect-distribution-sha",dist,"--expect-gateway-sha",gw,
            "--expect-relay-sha",rl],capture_output=True,text=True)
    def test_accept_frozen_pinset(self):
        with tempfile.TemporaryDirectory() as d:
            sha=make_repo(d,PINS)
            p=self.run_chk(d,"v9.9.9-test",sha,GW,RL)
            self.assertEqual(p.returncode,0,p.stderr+p.stdout)
            self.assertEqual(json.loads(p.stdout)["status"],"agreed")
    def test_refuse_gateway_mismatch(self):
        with tempfile.TemporaryDirectory() as d:
            sha=make_repo(d,PINS)
            p=self.run_chk(d,"v9.9.9-test",sha,GW_BAD,RL)
            self.assertEqual(p.returncode,3,p.stdout)
            self.assertEqual(json.loads(p.stdout)["status"],"mismatch")
    def test_refuse_distribution_mismatch(self):
        with tempfile.TemporaryDirectory() as d:
            sha=make_repo(d,PINS)
            p=self.run_chk(d,"v9.9.9-test","d"*40,GW,RL)
            self.assertEqual(p.returncode,3)
    def test_refuse_missing_tag(self):
        with tempfile.TemporaryDirectory() as d:
            sha=make_repo(d,PINS)
            p=self.run_chk(d,"v-nope",sha,GW,RL)
            self.assertEqual(p.returncode,2)
            self.assertEqual(json.loads(p.stdout)["status"],"error")
    def test_refuse_missing_pins_file(self):
        with tempfile.TemporaryDirectory() as d:
            sha=make_repo(d,None)
            p=self.run_chk(d,"v9.9.9-test",sha,GW,RL)
            self.assertEqual(p.returncode,2)
    def test_refuse_malformed_pins(self):
        with tempfile.TemporaryDirectory() as d:
            sha=make_repo(d,{"schema_version":1,"gateway_sha":"zz","relay_sha":RL})
            p=self.run_chk(d,"v9.9.9-test",sha,GW,RL)
            self.assertEqual(p.returncode,2)

class TestControlPin(unittest.TestCase):
    def run_chk(self,repo,tag,dist,gw,rl,ctrl=None):
        cmd=[sys.executable,CHK,"--tag",tag,"--repo",repo,
            "--expect-distribution-sha",dist,"--expect-gateway-sha",gw,
            "--expect-relay-sha",rl]
        if ctrl is not None: cmd+=["--expect-control-sha",ctrl]
        return subprocess.run(cmd,capture_output=True,text=True)
    def test_control_pin_accepted_when_matching(self):
        with tempfile.TemporaryDirectory() as d:
            pins=dict(PINS); pins["control_sha"]="e"*40
            sha=make_repo(d,pins)
            p=self.run_chk(d,"v9.9.9-test",sha,GW,RL,"e"*40)
            self.assertEqual(p.returncode,0,p.stdout)
            self.assertEqual(json.loads(p.stdout)["control_sha"],"e"*40)
    def test_control_pin_refused_on_mismatch(self):
        with tempfile.TemporaryDirectory() as d:
            pins=dict(PINS); pins["control_sha"]="e"*40
            sha=make_repo(d,pins)
            p=self.run_chk(d,"v9.9.9-test",sha,GW,RL,"f"*40)
            self.assertEqual(p.returncode,3,p.stdout)
    def test_control_pin_refused_when_resolved_null(self):
        with tempfile.TemporaryDirectory() as d:
            sha=make_repo(d,PINS)  # control_sha null
            p=self.run_chk(d,"v9.9.9-test",sha,GW,RL,"e"*40)
            self.assertEqual(p.returncode,3,p.stdout)

class TestNullPolicy(unittest.TestCase):
    """Actual-invocation tests: --expect-control-sha null vs omitted vs hex."""
    def run_chk(self,repo,tag,dist,gw,rl,ctrl_marker):
        cmd=[sys.executable,CHK,"--tag",tag,"--repo",repo,
            "--expect-distribution-sha",dist,"--expect-gateway-sha",gw,
            "--expect-relay-sha",rl]
        # ctrl_marker: 'OMIT' | 'null' | hex
        if ctrl_marker!="OMIT": cmd+=["--expect-control-sha",ctrl_marker]
        return subprocess.run(cmd,capture_output=True,text=True)
    def test_null_policy_accepts_null_control(self):
        with tempfile.TemporaryDirectory() as d:
            sha=make_repo(d,PINS)  # control_sha null
            p=self.run_chk(d,"v9.9.9-test",sha,GW,RL,"null")
            self.assertEqual(p.returncode,0,p.stdout)
            self.assertEqual(json.loads(p.stdout)["status"],"agreed")
    def test_null_policy_refuses_set_control(self):
        with tempfile.TemporaryDirectory() as d:
            pins=dict(PINS); pins["control_sha"]="e"*40
            sha=make_repo(d,pins)
            p=self.run_chk(d,"v9.9.9-test",sha,GW,RL,"null")
            self.assertEqual(p.returncode,3,p.stdout)
            self.assertIn("control_sha",json.loads(p.stdout)["diffs"])
    def test_omitted_control_still_agrees_with_null(self):
        with tempfile.TemporaryDirectory() as d:
            sha=make_repo(d,PINS)
            p=self.run_chk(d,"v9.9.9-test",sha,GW,RL,"OMIT")
            self.assertEqual(p.returncode,0,p.stdout)
    def test_invalid_control_value_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            sha=make_repo(d,PINS)
            p=self.run_chk(d,"v9.9.9-test",sha,GW,RL,"nothex!!")
            self.assertEqual(p.returncode,2,p.stdout)

if __name__=="__main__":
    unittest.main()
