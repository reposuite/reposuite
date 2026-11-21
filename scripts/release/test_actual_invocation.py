#!/usr/bin/env python3
"""Invoke the ACTUAL extracted workflow agreement step under
absent/empty/null/valid/mismatch control policies — measured rc,
not static string assertions. Fabricated fixture repo+tag only."""
import json, os, subprocess, sys, tempfile, unittest, yaml
HERE=os.path.dirname(os.path.abspath(__file__))
WF=os.path.join(HERE,"..","..",".github","workflows","release.yml")
REPO_ROOT=os.path.join(HERE,"..","..")
GW="a"*40; RL="b"*40

def git(repo,*a):
    return subprocess.run(["git","-C",repo,*a],capture_output=True,text=True,check=True).stdout.strip()

def make_fixture(root,control_sha):
    os.makedirs(root,exist_ok=True)
    git(root,"init","-q"); git(root,"config","user.email","t@t"); git(root,"config","user.name","t")
    open(os.path.join(root,"package.json"),"w").write(json.dumps({"version":"9.9.9-test.0"}))
    pins={"schema_version":1,"gateway_sha":GW,"relay_sha":RL,"control_sha":control_sha}
    open(os.path.join(root,"release-pins.json"),"w").write(json.dumps(pins))
    git(root,"add","-A"); git(root,"commit","-qm","fx")
    sha=git(root,"rev-parse","HEAD"); git(root,"tag","v9.9.9-test")
    git(root,"remote","add","origin",root)
    return sha

def extract_step():
    doc=yaml.safe_load(open(WF))
    jobs=doc["jobs"]
    vj=[j for j in jobs.values() if "agreement_status" in (j.get("outputs") or {})][0]
    st=[s for s in vj["steps"] if s.get("id")=="pin_agreement"][0]
    return st["run"]

class TestActualInvocation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script=extract_step()
    def invoke(self,pins_control,env_control,mode):
        # pins_control: value written into fixture release-pins.json (None->null)
        # env_control: value for RELEASE_CONTROL_SHA env ('ABSENT'|'EMPTY'|str)
        with tempfile.TemporaryDirectory() as d:
            repo=os.path.join(d,"repo"); os.makedirs(repo)
            subprocess.run(["cp","-r",os.path.join(REPO_ROOT,"scripts"),repo],check=True)
            sha=make_fixture(repo,pins_control)
            script=os.path.join(d,"step.sh"); open(script,"w").write(self.script)
            env=dict(os.environ)
            env.update({"GITHUB_WORKSPACE":repo,"GITHUB_OUTPUT":os.path.join(d,"out"),
                "RELEASE_TAG":"v9.9.9-test","DISTRIBUTION_SHA":sha,
                "GATEWAY_SHA":GW,"RELAY_SHA":RL})
            if mode=="ABSENT": env.pop("RELEASE_CONTROL_SHA",None)
            else: env["RELEASE_CONTROL_SHA"]=env_control
            p=subprocess.run(["bash",script],cwd=repo,env=env,
                             capture_output=True,text=True,timeout=60)
            outp=open(env["GITHUB_OUTPUT"]).read() if os.path.exists(env["GITHUB_OUTPUT"]) else ""
            return p.returncode,p.stdout+p.stderr,outp
    def test_absent_refuses_before_build(self):
        rc,o,_=self.invoke("e"*40,"e"*40,"ABSENT")
        self.assertEqual(rc,2); self.assertIn("missing/empty",o)
    def test_empty_refuses_before_build(self):
        rc,o,_=self.invoke("e"*40,"","EMPTY")
        self.assertEqual(rc,2); self.assertIn("missing/empty",o)
    def test_null_policy_positive(self):
        rc,o,out=self.invoke(None,"null","SET")
        self.assertEqual(rc,0,o); self.assertIn("agreed",o); self.assertIn("status=agreed",out)
    def test_valid_hex_positive(self):
        rc,o,out=self.invoke("e"*40,"e"*40,"SET")
        self.assertEqual(rc,0,o); self.assertIn("status=agreed",out)
    def test_mismatch_hex_refused(self):
        rc,o,_=self.invoke("e"*40,"f"*40,"SET")
        self.assertEqual(rc,3); self.assertIn("mismatch",o)
    def test_null_policy_refuses_set_control(self):
        rc,o,_=self.invoke("e"*40,"null","SET")
        self.assertEqual(rc,3); self.assertIn("control_sha",o)
    def test_invalid_value_refused(self):
        rc,o,_=self.invoke(None,"bogus!","SET")
        self.assertEqual(rc,2); self.assertIn("invalid RELEASE_CONTROL_SHA",o)

if __name__=="__main__":
    unittest.main()
