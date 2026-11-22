#!/usr/bin/env node
// Focused isolated lifecycle regression. Provide two fixture CLIs built from
// this same source at distinct older Cargo versions, and the packed CLI + its
// actual binary pair. The fake supervisor never executes either service.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execFileSync } = require('child_process');
const B = process.env.REPOSUITE_CLI;
const A = process.env.REPOSUITE_TEST_CLI_A;
const C = process.env.REPOSUITE_TEST_CLI_C;
const bins = process.env.REPOSUITE_TEST_PACKAGE_BIN;
if (![A, B, C, bins].every(Boolean)) throw new Error('set REPOSUITE_CLI, REPOSUITE_TEST_CLI_A, REPOSUITE_TEST_CLI_C and REPOSUITE_TEST_PACKAGE_BIN');
const ver = file => execFileSync(file, ['version'], {encoding:'utf8'}).trim();
const av = ver(A), bv = ver(B), cv = ver(C);
if (new Set([av,bv,cv]).size !== 3) throw new Error('fixture CLI versions must be distinct');
let failures = 0;
function check(label, pass) { console.log(` ${pass ? ' ok ' : 'FAIL'} ${label}`); if (!pass) failures++; }
function server() {
  const src = `require('http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({daemon:{apiVersion:2,activeSessions:0,sessionCount:0}}))}).listen(0,'127.0.0.1',function(){console.log(this.address().port)})`;
  const child = spawn(process.execPath, ['-e', src], {stdio:['ignore','pipe','inherit']});
  return new Promise(resolve => child.stdout.once('data', d => resolve({child, port:Number(String(d).trim())})));
}
function fixture(port) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-history-'));
  const home = path.join(t,'home'), data = path.join(home,'.local/share'), run = path.join(home,'run'), conf = path.join(home,'.config'), shim = path.join(t,'shim');
  const root = path.join(data,'reposuite'), relay = path.join(root,'relay/config');
  for (const dir of [relay, path.join(run,'reposuite'), shim]) fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(relay,'api.token'),'fixture',{mode:0o600});
  fs.writeFileSync(path.join(relay,'relay.json'),JSON.stringify({listenPort:port}));
  fs.writeFileSync(path.join(run,'reposuite/gateway.sock'),'');
  fs.writeFileSync(path.join(shim,'systemctl'),`#!/bin/sh
[ "$NO_USER_MANAGER" = 1 ] && exit 1
[ "$1" = --user ] && shift
v=$1; shift
case "$v" in
 daemon-reload|list-units|disable) exit 0;;
 enable) [ "$FAIL_ENABLE" = 1 ] && exit 1; exit 0;;
 is-active) grep -qx "$1" "$HOME/.services" 2>/dev/null && { echo active; exit 0; }; echo inactive; exit 0;;
 start|restart) for u in "$@"; do echo "$u" >> "$HOME/.services"; done; exit 0;;
 show) case "$*" in *reposuite-gateway.service*) echo "$MAIN_PID_GATEWAY";; *reposuite-relay.service*) echo "$MAIN_PID_RELAY";; *) exit 1;; esac; exit 0;;
 stop) rm -f "$HOME/.services"; exit 0;;
 *) exit 1;;
esac
`,{mode:0o755});
  const env = {...process.env, HOME:home, XDG_DATA_HOME:data, XDG_CONFIG_HOME:conf, XDG_RUNTIME_DIR:run, PATH:shim+':'+process.env.PATH, REPOSUITE_BIN:bins, REPOSUITE_CLOUD_WSS:'wss://127.0.0.1:1/gateway'};
  delete env.RSC_WS_URL; delete env.REPOSUITE_FAULT_INJECT; delete env.NO_USER_MANAGER;
  const invoke = (cli, args, overrides={}) => spawnSync(cli,args,{env:{...env,...overrides},encoding:'utf8',timeout:60000});
  const selected = () => { try { return path.basename(fs.readlinkSync(path.join(root,'current'))); } catch { return null; } };
  const history = () => { try { return JSON.parse(fs.readFileSync(path.join(root,'activation.json'),'utf8')); } catch { return null; } };
  const pair = v => ['reposuite-gateway','reposuite-relay'].map(n => fs.statSync(path.join(root,'versions',v,'bin',n)).ino);
  return {t,root,env,invoke,selected,history,pair, cleanup:()=>fs.rmSync(t,{recursive:true,force:true})};
}
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function positive(r) { return r.status === 0; }
(async () => {
 const health = await server();
 try {
  {
   const f=fixture(health.port);
   try {
    check('fresh A activation succeeds',positive(f.invoke(A,['setup'])) && f.selected()===av);
    check('A to B update succeeds',positive(f.invoke(B,['update','apply'])) && f.selected()===bv);
    const original=f.pair(bv);
    check('rollback selects the previously successful A',positive(f.invoke(B,['rollback'])) && f.selected()===av);
    check('forward B reuses complete original inodes',positive(f.invoke(B,['update','apply'])) && f.selected()===bv && same(original,f.pair(bv)));
   } finally { f.cleanup(); }
  }
  {
   const f=fixture(health.port);
   try {
    check('C to A baseline is activated',positive(f.invoke(C,['setup'])) && positive(f.invoke(A,['update','apply'])) && f.selected()===av);
    const before=f.history();
    const failed=f.invoke(B,['update','apply'],{REPOSUITE_FAULT_INJECT:'start'});
    check('failed B restores A and leaves committed C/A history intact',failed.status!==0 && f.selected()===av && same(before,f.history()));
    check('rollback after failed B selects C, never failed B',positive(f.invoke(B,['rollback'])) && f.selected()===cv);
   } finally { f.cleanup(); }
  }
  {
   const f=fixture(health.port);
   try {
    check('retry baseline A succeeds',positive(f.invoke(A,['setup'])));
    const failed=f.invoke(B,['update','apply'],{REPOSUITE_FAULT_INJECT:'start'}), original=f.pair(bv);
    check('transient B failure restores A',failed.status!==0 && f.selected()===av);
    check('normal retry activates B without replacing either executable',positive(f.invoke(B,['update','apply'])) && f.selected()===bv && same(original,f.pair(bv)));
   } finally { f.cleanup(); }
  }
  for (const mode of ['unit-write-relay','enable']) {
   const f=fixture(health.port);
   try {
    check(`${mode} failure baseline A succeeds`,positive(f.invoke(A,['setup'])));
    const files=['reposuite-gateway.service','reposuite-relay.service'].map(n=>path.join(f.env.XDG_CONFIG_HOME,'systemd/user',n));
    const units=files.map(n=>fs.readFileSync(n,'utf8'));
    const envPath=path.join(f.root,'gateway.env'), config=fs.readFileSync(envPath,'utf8'), before=f.history();
    const fault=mode==='enable' ? {FAIL_ENABLE:'1'} : {REPOSUITE_FAULT_INJECT:'unit-write-relay'};
    const r=f.invoke(B,['update','apply'],fault);
    const expected=mode==='enable' ? /service enable failed/ : /cannot write user units.*injected unit write failure/;
    check(`${mode} failure refuses B success and restores A units, environment and history`, r.status!==0 && expected.test(r.stderr) && f.selected()===av && same(before,f.history()) && same(units,files.map(n=>fs.readFileSync(n,'utf8'))) && fs.readFileSync(envPath,'utf8')===config);
   } finally { f.cleanup(); }
  }
  for (const kind of ['different','incomplete']) {
   const f=fixture(health.port);
   try {
    check(`${kind} baseline A succeeds`,positive(f.invoke(A,['setup'])));
    const dir=path.join(f.root,'versions',bv,'bin'); fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'reposuite-gateway'),'different',{mode:0o755});
    if (kind==='different') fs.writeFileSync(path.join(dir,'reposuite-relay'),'different',{mode:0o755});
    const before=fs.readFileSync(path.join(dir,'reposuite-gateway'),'utf8'), inode=fs.statSync(path.join(dir,'reposuite-gateway')).ino;
    const r=f.invoke(B,['update','apply']);
    check(`${kind} pair refused with no overwrite or selection change`,r.status!==0 && /incomplete or differs/.test(r.stderr) && f.selected()===av && fs.readFileSync(path.join(dir,'reposuite-gateway'),'utf8')===before && fs.statSync(path.join(dir,'reposuite-gateway')).ino===inode);
   } finally { f.cleanup(); }
  }
  {
   const f=fixture(health.port);
   try {
    const r=f.invoke(B,['setup'],{NO_USER_MANAGER:'1'});
    check('missing user manager stages without selecting or recording success',positive(r) && /staged only/.test(r.stdout) && !f.selected() && !f.history());
    check('later healthy setup records staged candidate',positive(f.invoke(B,['setup'])) && f.selected()===bv && f.history().current===bv);
   } finally { f.cleanup(); }
  }
  {
   const f=fixture(health.port);
   try {
    check('staged update baseline A succeeds',positive(f.invoke(A,['setup'])));
    const before=f.history();
    const staged=f.invoke(B,['setup'],{NO_USER_MANAGER:'1'});
    check('staging with no manager preserves prior selection and history',positive(staged) && /staged only/.test(staged.stdout) && f.selected()===av && same(before,f.history()));
    check('staged pair activates after manager returns',positive(f.invoke(B,['update','apply'])) && f.selected()===bv && f.history().previous===av);
   } finally { f.cleanup(); }
  }
  {
   const f=fixture(health.port); let gw, relay;
   try {
    const old=path.join(f.root,'versions',av,'bin'); fs.mkdirSync(old,{recursive:true});
    for (const n of ['reposuite-gateway','reposuite-relay']) fs.copyFileSync('/bin/sleep',path.join(old,n));
    fs.symlinkSync(path.dirname(old),path.join(f.root,'current'));
    fs.writeFileSync(path.join(f.env.HOME,'.services'),'reposuite-gateway\nreposuite-relay\n');
    gw=spawn(path.join(old,'reposuite-gateway'),['600']); relay=spawn(path.join(old,'reposuite-relay'),['600']);
    f.env.MAIN_PID_GATEWAY=String(gw.pid); f.env.MAIN_PID_RELAY=String(relay.pid);
    const r=f.invoke(B,['update','apply']);
    check('legacy selection with active exact executable identities and health is adopted',positive(r) && f.selected()===bv && f.history().previous===av);
    check('adopted verified legacy selection can be rolled back to',positive(f.invoke(B,['rollback'])) && f.selected()===av);
   } finally { if (gw) gw.kill('SIGKILL'); if (relay) relay.kill('SIGKILL'); f.cleanup(); }
  }
  {
   const f=fixture(health.port);
   try {
    check('interruption baseline A succeeds',positive(f.invoke(A,['setup'])) && positive(f.invoke(B,['update','apply'])));
    fs.unlinkSync(path.join(f.root,'current'));
    fs.symlinkSync(path.join(f.root,'versions',av),path.join(f.root,'current'));
    const before=f.history(), r=f.invoke(B,['rollback']);
    check('interrupted selection/history mismatch fails closed',r.status!==0 && /history disagrees/.test(r.stderr) && f.selected()===av && same(before,f.history()));
   } finally { f.cleanup(); }
  }
  {
   const f=fixture(health.port);
   try {
    const old=path.join(f.root,'versions',av,'bin');fs.mkdirSync(old,{recursive:true});
    for (const b of ['reposuite-gateway','reposuite-relay']) fs.copyFileSync(path.join(bins,b),path.join(old,b));
    fs.symlinkSync(path.dirname(old),path.join(f.root,'current'));
    const r=f.invoke(B,['rollback']);
    check('unverified legacy current does not invent a previous version',r.status!==0 && /no verified previous activation/.test(r.stderr) && f.selected()===av && !f.history());
    const update=f.invoke(B,['update','apply']);
    check('legacy current updates without claiming unverified rollback',positive(update) && f.selected()===bv && f.history().previous===null && !/previous .*kept for rollback/.test(update.stdout));
   } finally { f.cleanup(); }
  }
 } finally { health.child.kill(); }
 console.log(failures ? 'activation history: FAILED' : 'activation history: OK');
 process.exitCode=failures?1:0;
})().catch(e=>{console.error(e);process.exit(2)});
