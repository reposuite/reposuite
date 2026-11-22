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
const { execFileSync, spawnSync, spawn } = require('child_process');

// canonical CLI = the Rust binary (REPOSUITE_CLI override for CI layouts)
const CLI = process.env.REPOSUITE_CLI || path.join(__dirname, '..', 'target', 'release', 'reposuite');
// Source-level tests must never exercise a stale binary: when using the
// repo-local CLI, build first — same convention as the Makefile `test`
// target. Incremental cargo makes this cheap. An external REPOSUITE_CLI is
// the caller's responsibility (CI may pin a prebuilt artifact). A failed
// build stops here, before any scenario runs.
if (!process.env.REPOSUITE_CLI) {
  const b = spawnSync('cargo', ['build', '--release'],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 600000 });
  if (b.error || b.status !== 0) {
    console.error('lifecycle: cargo build --release failed — refusing to run scenarios against a possibly-stale binary');
    if (b.stderr) console.error(b.stderr.trim().split('\n').slice(-8).join('\n'));
    process.exit(2);
  }
}
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
# realistic shim: enable installs only; start/restart/stop change state;
# is-active reads state. FAKE_SYSTEMCTL_FAIL=<verb> injects failure.
STATE="\$HOME/.fake-services"
case "\$1" in --user) shift;; esac
verb="\$1"; shift
if [ "\$FAKE_SYSTEMCTL_FAIL" = "\$verb" ]; then exit 1; fi
case "\$verb" in
  daemon-reload|list-units|enable) exit 0;;
  is-active) [ -f "\$STATE" ] && grep -qx "\$1" "\$STATE" && { echo active; exit 0; }; echo inactive; exit 0;;
  start|restart) for u in "\$@"; do echo "\$u" >> "\$STATE"; done; exit 0;;
  stop) for u in "\$@"; do sed -i "/^\$u\$/d" "\$STATE" 2>/dev/null || true; done; exit 0;;
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
  // STRICT fixture, mirroring Relay's Host validation (ADR-006): Host must be
  // exactly 127.0.0.1:<port> — bare "127.0.0.1" gets HTTP 421, so a portless
  // Host bug in the CLI can never pass this fixture again.
  const src = `const http=require('http');const s=http.createServer((q,r)=>{
    const port=s.address().port;
    if(!['Bearer testtoken','Bearer malformed','Bearer negative','Bearer active'].includes(q.headers.authorization)){r.writeHead(401);return r.end('{}');}
    if(q.headers.host!=='127.0.0.1:'+port){r.writeHead(421);return r.end('{}');}
    r.writeHead(200,{'content-type':'application/json'});
    const token=q.headers.authorization;
    const daemon=token==='Bearer malformed' ? {apiVersion:2}
      : token==='Bearer negative' ? {apiVersion:2,activeSessions:-1,sessionCount:0}
      : token==='Bearer active' ? {apiVersion:2,activeSessions:1,sessionCount:1}
      : {apiVersion:2,activeSessions:0,sessionCount:0};
    r.end(JSON.stringify({daemon}));});
    s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`;
  const child = spawn('node', ['-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise(resolve => {
    child.stdout.once('data', d => resolve({ port: parseInt(String(d).trim(), 10), child }));
  });
}

function seedRelayHealth(paths, port, token = 'testtoken') {
  fs.mkdirSync(path.join(paths.rsr, 'config'), { recursive: true });
  fs.writeFileSync(path.join(paths.rsr, 'config', 'api.token'), token, { mode: 0o600 });
  fs.writeFileSync(path.join(paths.rsr, 'config', 'relay.json'), JSON.stringify({ listenPort: port }));
}

async function main() {
  const { port, child } = await startHealthServer();

  // ---------- case 1: update apply with injected service failure ----------
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.1');
    pkgBin(t);
    seedRelayHealth(paths, port);
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
    seedRelayHealth(paths, port);
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
    seedRelayHealth(paths, port);
    fs.mkdirSync(path.join(paths.run, 'reposuite'), { recursive: true });
    fs.writeFileSync(path.join(paths.run, 'reposuite', 'gateway.sock'), '');
    const r = run(t, env, ['update-apply']);
    chk('successful update-apply exits zero', r.status === 0);
    chk('new version activated', path.basename(fs.readlinkSync(paths.current)) !== '0.0.1');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // ---------- case 3b: restore-time restart failure is NOT reported as recovery ----------
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.1');
    pkgBin(t);
    seedRelayHealth(paths, port);
    // shim: every non-is-active verb fails → the apply fails AND the
    // restore restart fails; CLI must report RECOVERY FAILED, not success.
    fs.writeFileSync(path.join(env.PATH.split(':')[0], 'systemctl'), `#!/bin/sh
case "$1" in --user) shift;; esac
verb="$1"; shift
case "$verb" in
  daemon-reload|list-units|enable) exit 0;;
  is-active) echo inactive; exit 0;;
  *) exit 1;;
esac
`, { mode: 0o755 });
    const r = run(t, env, ['update-apply']);
    chk('restore restart failure exits nonzero', r.status !== 0);
    chk('restore restart failure reported (no false success)', /RECOVERY FAILED|restoring previous runtime/.test(r.stderr + r.stdout)
      && !/previous runtime restored/.test(r.stderr + r.stdout));
    fs.rmSync(t, { recursive: true, force: true });
  }

  // ---------- case 4: rollback failure restores the still-current version ----------
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.2');
    seedRelayHealth(paths, port);
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

  // ---------- case 5: FIRST-INSTALL health failure removes cleanly (no restart-of-nothing) ----------
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.1');
    // simulate first install: no previous version, no units, no current
    fs.rmSync(path.join(paths.data, 'reposuite'), { recursive: true, force: true });
    for (const u of ['reposuite-gateway.service', 'reposuite-relay.service'])
      fs.rmSync(path.join(paths.units, u), { force: true });
    fs.mkdirSync(path.join(paths.run, 'reposuite'), { recursive: true });
    pkgBin(t);
    const r = run(t, { ...env, REPOSUITE_FAULT_INJECT: 'health' }, ['setup']);
    chk('first-install health failure exits nonzero', r.status !== 0);
    chk('first-install failure does NOT report RECOVERY FAILED', !/RECOVERY FAILED/.test(r.stderr + r.stdout));
    chk('first-install failure reports removal', /removed failed install|previous/.test(r.stderr + r.stdout));
    chk('no activation left behind', !fs.existsSync(paths.current));
    chk('unit files removed', !fs.existsSync(path.join(paths.units, 'reposuite-gateway.service')));
    fs.rmSync(t, { recursive: true, force: true });
  }

  // ---------- case 6: delayed readiness still succeeds within the bounded poll ----------
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.1');
    pkgBin(t);
    seedRelayHealth(paths, port);
    fs.mkdirSync(path.join(paths.run, 'reposuite'), { recursive: true });
    fs.writeFileSync(path.join(paths.run, 'reposuite', 'gateway.sock'), '');
    const r = run(t, env, ['setup']);
    chk('delayed-readiness setup exits zero', r.status === 0);
    chk('activation recorded', fs.existsSync(paths.current));
    const gatewayUnit = fs.readFileSync(path.join(paths.units, 'reposuite-gateway.service'), 'utf8');
    const relayUnit = fs.readFileSync(path.join(paths.units, 'reposuite-relay.service'), 'utf8');
    chk('gateway unit does not order after its own enabling target', !/^After=.*\bdefault\.target\b/m.test(gatewayUnit));
    chk('relay is ordered after gateway', /^After=reposuite-gateway\.service$/m.test(relayUnit));
    chk('both services are enabled by default.target', [gatewayUnit, relayUnit].every(u => /^WantedBy=default\.target$/m.test(u)));
    fs.rmSync(t, { recursive: true, force: true });
  }

  // ---------- case 7: orphan daemons from a partial install are reaped before restart ----------
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.1');
    pkgBin(t);
    // partial-install state: units+current gone, orphan daemon process running
    for (const u of ['reposuite-gateway.service', 'reposuite-relay.service'])
      fs.rmSync(path.join(paths.units, u), { force: true });
    fs.rmSync(paths.current, { force: true });
    const sleeper = path.join(paths.data, 'reposuite', 'versions', '0.0.1', 'bin', 'reposuite-gateway');
    fs.copyFileSync('/bin/sleep', sleeper); fs.chmodSync(sleeper, 0o755);
    const orphan = spawn(sleeper, ['600'], { detached: true }).pid;
    seedRelayHealth(paths, port);
    fs.mkdirSync(path.join(paths.run, 'reposuite'), { recursive: true });
    fs.writeFileSync(path.join(paths.run, 'reposuite', 'gateway.sock'), '');
    const r = run(t, env, ['setup']);
    // dead child stays a zombie of this test process, so kill(pid,0) lies —
    // /proc/<pid>/exe is the reliable liveness check.
    chk('partial-install setup exits zero', r.status === 0);
    chk('orphan daemon reaped', !fs.existsSync(`/proc/${orphan}/exe`));
    chk('activation recorded after orphan reap', fs.existsSync(paths.current));
    try { process.kill(orphan, 'SIGKILL'); } catch {}
    fs.rmSync(t, { recursive: true, force: true });
  }

  // Unknown or malformed Relay state must never be interpreted as idle.
  for (const mode of ['missing', 'malformed', 'negative', 'active']) {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.1');
    pkgBin(t);
    if (mode !== 'missing') seedRelayHealth(paths, port, mode);
    const r = run(t, env, ['update-apply']);
    const expected = mode === 'active' ? /session\(s\) running/ : /Relay state unknown/;
    chk(`${mode} Relay state defers update`, r.status !== 0 && expected.test(r.stderr + r.stdout));
    chk(`${mode} state preserves current runtime`, path.basename(fs.readlinkSync(paths.current)) === '0.0.1');
    const ver = execFileSync(CLI, ['version'], { encoding: 'utf8' }).trim();
    chk(`${mode} state does not stage binaries`, !fs.existsSync(path.join(paths.data, 'reposuite', 'versions', ver)));
    fs.rmSync(t, { recursive: true, force: true });
  }

  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.1');
    pkgBin(t);
    seedRelayHealth(paths, port);
    const ver = execFileSync(CLI, ['version'], { encoding: 'utf8' }).trim();
    const staged = path.join(paths.data, 'reposuite', 'versions', ver, 'bin');
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, 'reposuite-gateway'), 'do not replace');
    const r = run(t, env, ['update-apply']);
    chk('existing version refuses overwrite', r.status !== 0 && /without overwriting/.test(r.stderr + r.stdout));
    chk('existing version remains intact', fs.readFileSync(path.join(staged, 'reposuite-gateway'), 'utf8') === 'do not replace');
    chk('existing version leaves current unchanged', path.basename(fs.readlinkSync(paths.current)) === '0.0.1');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // Same-version setup must reuse the complete pair, even while an executable
  // is running. Conflicting or incomplete pairs must not change any runtime.
  for (const mode of ['identical', 'different', 'incomplete']) {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const ver = execFileSync(CLI, ['version'], { encoding: 'utf8' }).trim();
    const { env, paths } = setupEnv(t, ver);
    pkgBin(t);
    const installed = path.join(paths.data, 'reposuite', 'versions', ver, 'bin');
    const pkg = path.join(t, 'pkgbin');
    fs.copyFileSync('/bin/sleep', path.join(installed, 'reposuite-gateway'));
    fs.copyFileSync(mode === 'different' ? '/bin/true' : '/bin/sleep', path.join(pkg, 'reposuite-gateway'));
    fs.writeFileSync(path.join(pkg, 'reposuite-relay'), 'old', { mode: 0o755 });
    if (mode === 'incomplete') fs.unlinkSync(path.join(installed, 'reposuite-relay'));
    const sleeper = spawn(path.join(installed, 'reposuite-gateway'), ['600']);
    fs.writeFileSync(path.join(env.HOME, '.fake-services'), 'reposuite-gateway\nreposuite-relay\n');
    seedRelayHealth(paths, port);
    fs.mkdirSync(path.join(paths.run, 'reposuite'), { recursive: true });
    fs.writeFileSync(path.join(paths.run, 'reposuite', 'gateway.sock'), '');
    const snapshot = () => ({
      current: fs.readlinkSync(paths.current),
      unit: fs.readFileSync(path.join(paths.units, 'reposuite-gateway.service'), 'utf8'),
      gateway: fs.readFileSync(path.join(installed, 'reposuite-gateway')).toString('base64'),
      inode: fs.statSync(path.join(installed, 'reposuite-gateway')).ino,
      relay: fs.existsSync(path.join(installed, 'reposuite-relay')) ? fs.readFileSync(path.join(installed, 'reposuite-relay'), 'utf8') : null,
    });
    const before = snapshot();
    const r = run(t, env, ['setup']);
    const after = snapshot();
    chk(`${mode} running executable gives expected result`, mode === 'identical' ? r.status === 0 : r.status !== 0 && /incomplete or differs.*new build\/version or supported recovery/.test(r.stderr));
    chk(`${mode} preserves running binary bytes and inode`, before.gateway === after.gateway && before.inode === after.inode && fs.existsSync(`/proc/${sleeper.pid}/exe`));
    chk(`${mode} preserves installed relay`, before.relay === after.relay);
    if (mode !== 'identical') chk(`${mode} preserves selection and units`, before.current === after.current && before.unit === after.unit);
    sleeper.kill('SIGKILL');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // A partial source must not leave an installed version behind.
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.1'); pkgBin(t);
    fs.unlinkSync(path.join(t, 'pkgbin', 'reposuite-relay'));
    const ver = execFileSync(CLI, ['version'], { encoding: 'utf8' }).trim();
    const r = run(t, env, ['setup']);
    chk('missing package member refuses incomplete staging', r.status !== 0 && /stage reposuite-relay/.test(r.stderr));
    chk('failed staging leaves no installed version or temporary stage', !fs.existsSync(path.join(paths.data, 'reposuite', 'versions', ver)) && !fs.readdirSync(path.join(paths.data, 'reposuite')).some(n => n.startsWith('.setup-stage-')));
    chk('failed staging leaves selection unchanged', path.basename(fs.readlinkSync(paths.current)) === '0.0.1');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // Hold the same real flock as another installer, then retry after release.
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rslife-'));
    const { env, paths } = setupEnv(t, '0.0.1'); pkgBin(t);
    const lock = path.join(paths.data, '.reposuite-runtime.lock');
    const ready = path.join(t, 'locked');
    const holder = spawn('flock', ['-x', lock, 'sh', '-c', 'touch "$1"; sleep 30', 'sh', ready], { detached: true });
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise(r => setTimeout(r, 20));
    const r = run(t, env, ['setup']);
    chk('concurrent installer fails with retry diagnostic', fs.existsSync(ready) && r.status !== 0 && /another runtime operation.*retry/.test(r.stderr));
    chk('concurrent refusal leaves current selection unchanged', path.basename(fs.readlinkSync(paths.current)) === '0.0.1');
    process.kill(-holder.pid, 'SIGTERM');
    await new Promise(resolve => holder.once('exit', resolve));
    seedRelayHealth(paths, port);
    fs.mkdirSync(path.join(paths.run, 'reposuite'), { recursive: true });
    fs.writeFileSync(path.join(paths.run, 'reposuite', 'gateway.sock'), '');
    const retry = run(t, env, ['setup']);
    chk('retry after concurrent installer exits succeeds', retry.status === 0);
    fs.rmSync(t, { recursive: true, force: true });
  }

  child.kill();
  console.log(fail ? 'lifecycle: FAILED' : 'lifecycle: OK');
  process.exit(fail);
}

main().catch(e => { console.error(e); process.exit(1); });
