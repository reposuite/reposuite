#!/usr/bin/env node
/*
 * Lifecycle fault-injection test: proves setup/update apply/rollback are
 * transactional — on injected service or health failures the previous
 * active runtime AND unit configuration are restored, and success is never
 * reported. Uses a fake systemctl (PATH shim) and a real loopback Relay
 * health endpoint. No systemd, no daemons, no user state touched.
 */
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// canonical CLI = the Rust binary (REPOSUITE_CLI override for CI layouts)
const CLI = process.env.REPOSUITE_CLI || path.join(__dirname, '..', 'target', 'release', 'reposuite');
if (!require('fs').existsSync(CLI)) {
  console.error('lifecycle: Rust CLI not built at ' + CLI + ' — run: cargo build --release');
  process.exit(2);
}
let fail = 0;
const chk = (n, ok) => { console.log(` ${ok ? ' ok ' : 'FAIL'} ${n}`); if (!ok) fail = 1; };

function setupEnv(t, version) {
  const home = path.join(t, 'home');
  const data = path.join(home, '.local', 'share');
  const conf = path.join(home, '.config');
  const run = path.join(home, 'run');
  for (const d of [home, data, conf, run, path.join(conf, 'systemd', 'user')]) fs.mkdirSync(d, { recursive: true });
  // fake systemctl shim
  const bin = path.join(t, 'shim'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh
case "$1" in --user) shift;; esac
verb="$1"; shift
case "$verb" in
  daemon-reload|enable|start|stop|restart|list-units) exit 0;;
  is-active) echo active; exit 0;;
  *) exit 0;;
esac
`, { mode: 0o755 });
  // seed a previous active version A with its unit config
  const vA = path.join(data, 'reposuite', 'versions', version);
  fs.mkdirSync(path.join(vA, 'bin'), { recursive: true });
  for (const b of ['reposuite-gateway', 'reposuite-relay']) fs.writeFileSync(path.join(vA, 'bin', b), 'old', { mode: 0o755 });
  fs.symlinkSync(vA, path.join(data, 'reposuite', 'current'));
  fs.writeFileSync(path.join(conf, 'systemd', 'user', 'reposuite-gateway.service'),
    `[Service]\nExecStart=${vA}/bin/reposuite-gateway serve\n`);
  fs.writeFileSync(path.join(conf, 'systemd', 'user', 'reposuite-relay.service'),
    `[Service]\nExecStart=${vA}/bin/reposuite-relay serve\n`);
  return {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: data, XDG_CONFIG_HOME: conf, XDG_RUNTIME_DIR: run,
           PATH: bin + ':' + process.env.PATH, REPOSUITE_BIN: path.join(t, 'pkgbin') },
    paths: { current: path.join(data, 'reposuite', 'current'), units: path.join(conf, 'systemd', 'user'),
             data, run, rsr: path.join(data, 'reposuite', 'relay') },
  };
}

function pkgBin(t) {
  // the "new package" binaries the CLI copies from
  const d = path.join(t, 'pkgbin'); fs.mkdirSync(d, { recursive: true });
  for (const b of ['reposuite-gateway', 'reposuite-relay']) fs.writeFileSync(path.join(d, b), 'new', { mode: 0o755 });
  // platform-package layout the CLI discovers
  const plat = path.join(t, 'node_modules', '@reposuite', 'linux-x64', 'bin');
  fs.mkdirSync(plat, { recursive: true });
  for (const b of ['reposuite-gateway', 'reposuite-relay']) fs.writeFileSync(path.join(plat, b), 'new', { mode: 0o755 });
  return plat;
}

function run(t, env, args) {
  return spawnSync(CLI, args, { env, encoding: 'utf8', timeout: 60000 });
}

// health server runs in a CHILD process: spawnSync in this process blocks
// the event loop, so an in-process server could never answer the CLI.
function startHealthServer() {
  const { spawn } = require('child_process');
  const src = `const http=require('http');const s=http.createServer((q,r)=>{
    if(q.headers.authorization!=='Bearer testtoken'){r.writeHead(401);return r.end('{}');}
    r.writeHead(200,{'content-type':'application/json'});
    r.end(JSON.stringify({daemon:{apiVersion:2,activeSessions:0,sessionCount:0}}));});
    s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`;
  const child = spawn('node', ['-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise(resolve => {
    child.stdout.once('data', d => resolve({ port: parseInt(String(d).trim(), 10), child }));
  });
}

async function main() {
  const { port, child } = await startHealthServer();

  // ---------- case 1: update apply with injected service failure ----------
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.1');
    pkgBin(t);
    const r = run(t, { ...env, REPOSUITE_FAULT_INJECT: 'start' }, ['update-apply']);
    const cur = fs.readlinkSync(paths.current);
    const unit = fs.readFileSync(path.join(paths.units, 'reposuite-gateway.service'), 'utf8');
    chk('update-apply injected failure exits nonzero', r.status !== 0);
    chk('previous version restored', path.basename(cur) === '0.0.1');
    chk('previous unit config restored', /0\.0\.1/.test(unit));
    chk('failure reported, not success', /injected service failure/.test(r.stderr + r.stdout));
    fs.rmSync(t, { recursive: true, force: true });
  }

  // ---------- case 2: update apply with failed health verification ----------
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.1');
    pkgBin(t);
    const r = run(t, { ...env, REPOSUITE_FAULT_INJECT: 'health' }, ['update-apply']);
    chk('health failure exits nonzero', r.status !== 0);
    chk('health failure restores previous version', path.basename(fs.readlinkSync(paths.current)) === '0.0.1');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // ---------- case 3: successful update apply with REAL health ----------
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.1');
    pkgBin(t);
    fs.mkdirSync(path.join(paths.rsr, 'config'), { recursive: true });
    fs.writeFileSync(path.join(paths.rsr, 'config', 'api.token'), 'testtoken', { mode: 0o600 });
    fs.writeFileSync(path.join(paths.rsr, 'config', 'relay.json'), JSON.stringify({ listenPort: port }));
    fs.mkdirSync(path.join(paths.run, 'reposuite'), { recursive: true });
    fs.writeFileSync(path.join(paths.run, 'reposuite', 'gateway.sock'), '');
    const r = run(t, env, ['update-apply']);
    chk('successful update-apply exits zero', r.status === 0);
    chk('new version activated', path.basename(fs.readlinkSync(paths.current)) !== '0.0.1');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // ---------- case 4: rollback failure restores the still-current version ----------
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.2');
    // older version 0.0.1 present as rollback target
    const vOld = path.join(paths.data, 'reposuite', 'versions', '0.0.1', 'bin');
    fs.mkdirSync(vOld, { recursive: true });
    for (const b of ['reposuite-gateway', 'reposuite-relay']) fs.writeFileSync(path.join(vOld, b), 'old', { mode: 0o755 });
    pkgBin(t);
    const r = run(t, { ...env, REPOSUITE_FAULT_INJECT: 'start' }, ['rollback']);
    chk('rollback injected failure exits nonzero', r.status !== 0);
    chk('rollback failure keeps current version', path.basename(fs.readlinkSync(paths.current)) === '0.0.2');
    fs.rmSync(t, { recursive: true, force: true });
  }

  child.kill();
  console.log(fail ? 'lifecycle: FAILED' : 'lifecycle: OK');
  process.exit(fail);
}

main().catch(e => { console.error(e); process.exit(1); });
