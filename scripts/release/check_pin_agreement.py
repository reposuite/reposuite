#!/usr/bin/env python3
"""check_pin_agreement.py --tag <TAG> --expect-distribution-sha <40hex>
  --expect-gateway-sha <40hex> --expect-relay-sha <40hex> [--repo DIR]

Pre-build agreement gate: runs resolve_tag.py --tag (frozen pinset from
the tag's committed release-pins.json) and requires the CI repo-var
pins to equal the resolved values EXACTLY. Fail-closed: any resolver
error, missing tag/pins, or single-field mismatch -> nonzero exit.
Never creates tags, never falls back, never publishes."""
import argparse, json, subprocess, sys, os

def emit(status, **kw):
    print(json.dumps({"schema_version":1,"status":status,**kw}))

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--tag",required=True)
    ap.add_argument("--repo",default=".")
    ap.add_argument("--expect-distribution-sha",required=True)
    ap.add_argument("--expect-gateway-sha",required=True)
    ap.add_argument("--expect-relay-sha",required=True)
    ap.add_argument("--expect-control-sha",default=None,
        help="optional: 'null' asserts resolved control_sha is JSON null; "
             "40-hex asserts equality; omitted = no control assertion")
    a=ap.parse_args()
    if a.expect_control_sha is not None and a.expect_control_sha!="null" \
            and not __import__("re").fullmatch(r"[0-9a-f]{40}",a.expect_control_sha):
        emit("error",stage="args",detail="expect-control-sha must be 'null' or 40-hex"); return 2
    here=os.path.dirname(os.path.abspath(__file__))
    rt=os.path.join(here,"resolve_tag.py")
    p=subprocess.run([sys.executable,rt,"--tag",a.tag,"--repo",a.repo,"--json"],
                     capture_output=True,text=True,timeout=120)
    if p.returncode!=0:
        emit("error",stage="resolve_tag",detail=(p.stdout+p.stderr).strip()[:400]); return 2
    try: res=json.loads(p.stdout)
    except Exception:
        emit("error",stage="resolve_tag_parse"); return 2
    if res.get("status")!="resolved":
        emit("error",stage="resolve_tag",detail=res); return 2
    exp={"distribution_sha":a.expect_distribution_sha,
         "gateway_sha":a.expect_gateway_sha,
         "relay_sha":a.expect_relay_sha}
    ctrl_exp=a.expect_control_sha
    if ctrl_exp=="null":
        ctrl_exp=None  # sentinel: expect resolved control_sha to be null
    if a.expect_control_sha is not None:
        exp["_control"]=(a.expect_control_sha,ctrl_exp)
    diffs={}
    for k,v in exp.items():
        if k=="_control":
            raw,expv=v
            if res.get("control_sha")!=expv:
                diffs["control_sha"]={"resolved":res.get("control_sha"),
                                      "expected":raw}
        elif res.get(k)!=v:
            diffs[k]={"resolved":res.get(k),"expected":v}
    if diffs:
        emit("mismatch",tag=a.tag,tag_object_sha=res.get("tag_object_sha"),
             distribution_sha=res.get("distribution_sha"),diffs=diffs); return 3
    emit("agreed",tag=a.tag,tag_object_sha=res.get("tag_object_sha"),
         distribution_sha=res.get("distribution_sha"),version=res.get("version"),
         gateway_sha=res.get("gateway_sha"),relay_sha=res.get("relay_sha"),
         control_sha=res.get("control_sha")); return 0

if __name__=="__main__":
    sys.exit(main())
