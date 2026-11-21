#!/usr/bin/env python3
"""Static contract tests for the tagged-pin gate in release.yml —
omission must be impossible, publish must depend on agreement."""
import os, unittest, yaml
WF=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                "..","..",".github","workflows","release.yml")
class TestWorkflowGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc=yaml.safe_load(open(WF))
        cls.on=cls.doc["on"] if "on" in cls.doc else cls.doc[True]
        cls.verify=[j for j in cls.doc["jobs"].values()
                    if j.get("name","").startswith("verify") or
                    "outputs" in j and "agreement_status" in
                    (j.get("outputs") or {})]
        cls.verify_job=[j for j in cls.doc["jobs"].values()
                        if "agreement_status" in (j.get("outputs") or {})][0]
        cls.publish=[j for j in cls.doc["jobs"].values()
                     if j.get("environment")=="release"][0]
    def test_release_tag_input_required(self):
        inp=self.on["workflow_dispatch"]["inputs"]["release_tag"]
        self.assertTrue(inp.get("required"),"release_tag must be required")
        self.assertNotIn("default",inp)
    def test_agreement_step_unconditional(self):
        steps=self.verify_job["steps"]
        ag=[s for s in steps if s.get("id")=="pin_agreement"]
        self.assertEqual(len(ag),1)
        self.assertNotIn("if",ag[0],"agreement step must not be skippable")
    def test_publish_depends_on_agreement(self):
        cond=self.publish.get("if","")
        self.assertIn("agreement_status",cond)
        self.assertIn("agreed",cond)
    def test_verify_outputs_agreement(self):
        self.assertIn("agreement_status",self.verify_job["outputs"])
    def test_no_omission_path(self):
        # no step may gate agreement behind a possibly-empty input
        for s in self.verify_job["steps"]:
            if s.get("id")=="pin_agreement":
                self.assertNotIn("inputs.release_tag != ''",str(s.get("if","")))
if __name__=="__main__":
    unittest.main()
