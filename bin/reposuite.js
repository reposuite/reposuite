#!/usr/bin/env node
/*
 * reposuite — canonical RepoSuite CLI (single implementation).
 * Manages the per-user RepoSuite runtime: Gateway + Relay + Connector as
 * systemd --user services, a VERSIONED runtime dir, safe update activation,
 * pairing via protected invite file, rollback. Never touches argv secrets,
 * never requires sudo, never leaves services pointing at deleted paths.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync, spawnSync } = require('child_process');
const http = require('http');

const HOME = os.homedir();
const XDG_DATA = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
const XDG_CONF = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const XDG_RUNTIME = process.env.XDG_RUNTIME_DIR || path.join(HOME, '.reposuite', 'run');
const ROOT = path.join(XDG_DATA, 'reposuite');            // unified XDG namespace
const VERSIONS = path.join(ROOT, 'versions');
const CURRENT = path.join(ROOT, 'current');               // symlink -> versions/<v>
const RSG_DIR = path.join(ROOT, 'gateway');               // gateway/{store,cloud}
const RSR_HOME = path.join(ROOT, 'relay');                // relay/{config,sessions}
const ENV_FILE = path.join(ROOT, 'gateway.env');
const SOCKET = path.join(XDG_RUNTIME, 'reposuite', 'gateway.sock');
const UNITS = path.join(XDG_CONF, 'systemd', 'user');
const WSS = process.env.REPOSUITE_CLOUD_WSS || process.env.RSC_WS_URL || 'wss://app.reposuite.com/gateway';
const OWNED_BINS = ['reposuite-gateway', 'reposuite-relay'];
const OWNED_UNITS = ['reposuite-gateway.service', 'reposuite-relay.service'];
// legacy (pre-unified) state roots — migrated once, idempotently
const LEGACY = [
  [path.join(XDG_DATA, 'reposuite-gateway'), path.join(RSG_DIR, 'store')],
  [path.join(HOME, '.reposuite', 'relay'), RSR_HOME],
  [path.join(XDG_DATA, 'rsc-connector'), path.join(RSG_DIR, 'cloud')],
];
const VERSION = require('../package.json').version;

const die = (m, c = 1) => { console.error(`reposuite: ${m}`); process.exit(c); };
const ok = m => console.log(`reposuite: ${m}`);
const have = c => { try { execFileSync('which', [c], { stdio: 'pipe' }); return true; } catch { return false; } };
const systemdOK = () => {
  try { execSync('systemctl --user daemon-reload >/dev/null 2>&1 && systemctl --user list-units >/dev/null 2>&1'); return true; }
  catch { return false; }
};
const svc = (verb, ...units) => {
  const r = spawnSync('systemctl', ['--user', verb, ...units], { encoding: 'utf8' });
  return r.status === 0;
};
const isActive = u => {
  try { return execSync(`systemctl --user is-active ${u}`, { encoding: 'utf8' }).trim() === 'active'; }
  catch { return false; }
};
const mkdir = d => fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const CREDS = path.join(RSG_DIR, 'cloud', 'gateway.json');
const paired = () => fs.existsSync(CREDS);
function cloudStatus() {
  // authenticated local read over the owner-only Unix socket
  return new Promise((resolve) => {
    const req = http.request({ socketPath: SOCKET, path: '/v1/cloud/status', method: 'GET' }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.setTimeout(4000, () => { req.destroy(); resolve(null); }); req.end();
  });
}
// readHidden: muted-echo terminal input; readline restores terminal state
// on close and on SIGINT (no stty shell-outs, no half-raw terminals).
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = () => {};                 // never echo the secret
    process.stderr.write(prompt);
    const done = (err, val) => {
      process.removeListener('SIGINT', onInt);
      try { rl.close(); } catch {}
      process.stderr.write('\n');
      err ? reject(err) : resolve(val.trim());
    };
    const onInt = () => done(new Error('interrupted'));
    process.once('SIGINT', onInt);
    rl.question('', ans => done(null, ans));
  });
}

// relayProbe: authenticated in-process HTTP to the loopback Relay — the
// bearer never enters a child process argv.
function relayProbe() {
  return new Promise(resolve => {
    try {
      const tok = fs.readFileSync(path.join(RSR_HOME, 'config', 'api.token'), 'utf8').trim();
      const port = JSON.parse(fs.readFileSync(path.join(RSR_HOME, 'config', 'relay.json'), 'utf8')).listenPort;
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/daemon', method: 'GET',
        headers: { authorization: 'Bearer ' + tok }, timeout: 4000 }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { const j = JSON.parse(d); resolve(j.daemon || null); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch { resolve(null); }
  });
}

function cloudPair(invite) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ invite });
    const req = http.request({ socketPath: SOCKET, path: '/v1/cloud/pair', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { let j = {}; try { j = JSON.parse(d); } catch {} 
        if (res.statusCode === 200) resolve(j); else reject(new Error(j.error && j.error.message || 'pair failed http ' + res.statusCode)); });
    });
    req.on('error', reject); req.setTimeout(20000, () => { req.destroy(); reject(new Error('gateway socket timeout')); });
    req.end(body);
  });
}

// Two distinct binary sources — never conflate:
//  pkgBinDir(): binaries inside THIS installed npm package (the new version).
//  installedBinDir(): the currently activated runtime (old version).
// update/setup must always install from pkgBinDir, never from the old runtime.
function pkgBinDir() {
  for (const cand of [
    // npm hoists optionalDependencies to the top-level node_modules as a
    // SIBLING of the entry package (<prefix>/lib/node_modules/@reposuite/...)
    path.join(__dirname, '..', '..', '@reposuite', `linux-${process.arch}`, 'bin'),
    path.join(__dirname, '..', 'node_modules', '@reposuite', `linux-${process.arch}`, 'bin'),
    path.join(__dirname, '..', 'vendor', process.platform + '-' + process.arch),
    path.join(__dirname, '..', 'bin-native'),
  ]) if (fs.existsSync(path.join(cand, 'reposuite-gateway'))) return cand;
  return null;
}
function installedBinDir() {
  const c = path.join(CURRENT, 'bin');
  return fs.existsSync(path.join(c, 'reposuite-gateway')) ? c : null;
}

function activate(version) {
  const target = path.join(VERSIONS, version);
  if (!fs.existsSync(target)) die(`version ${version} not installed under ${VERSIONS}`);
  mkdir(path.dirname(CURRENT));
  const tmp = CURRENT + '.tmp';
  try { fs.unlinkSync(tmp); } catch {}
  fs.symlinkSync(path.resolve(target), tmp);
  fs.renameSync(tmp, CURRENT);
}

function currentVersion() {
  try { return path.basename(fs.realpathSync(CURRENT)); } catch { return null; }
}
function cmpVer(a, b) {
  const pa = a.split(/[.+-]/).map(x => /^\d+$/.test(x) ? +x : x);
  const pb = b.split(/[.+-]/).map(x => /^\d+$/.test(x) ? +x : x);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
  }
  return 0;
}

// runningSessions must be awaited; -1 = unknown (deny activation).
async function runningSessions() {
  if (!fs.existsSync(path.join(RSR_HOME, 'config', 'api.token'))) return 0;
  const d = await relayProbe();
  if (!d) return -1;
  return d.activeSessions ?? d.sessionCount ?? 0;
}

// migrateLegacy: one-time, idempotent, never overwrites existing data.
function migrateLegacy() {
  for (const [from, to] of LEGACY) {
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to) && fs.readdirSync(to).length) { console.log(`  legacy ${from} left in place (target populated)`); continue; }
    try {
      mkdir(path.dirname(to));
      fs.renameSync(from, to);
      console.log(`  migrated ${from} -> ${to}`);
    } catch (e) { console.log(`  legacy ${from} not migrated (${e.code || e.message})`); }
  }
}

function writeUnits(bin) {
  mkdir(UNITS);
  fs.writeFileSync(path.join(UNITS, 'reposuite-gateway.service'), `[Unit]
Description=RepoSuite Gateway (user)
After=default.target

[Service]
UMask=0077
EnvironmentFile=${ENV_FILE}
Environment=REPOSUITE_RSR_HOME=${RSR_HOME}
ExecStart=${bin}/reposuite-gateway serve --data-dir ${RSG_DIR} --socket ${SOCKET}
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`);
  fs.writeFileSync(path.join(UNITS, 'reposuite-relay.service'), `[Unit]
Description=RepoSuite Relay (user)
After=reposuite-gateway.service

[Service]
UMask=0077
Environment=REPOSUITE_HOME=${ROOT}
ExecStart=${bin}/reposuite-relay serve
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`);
  fs.writeFileSync(ENV_FILE,
    `REPOSUITE_CLOUD_WSS=${WSS}\nREPOSUITE_GATEWAY_LABEL=${os.hostname()}\n`,
    { mode: 0o600 });
}

// serviceOp runs a systemctl verb on the two owned units and VALIDATES the
// resulting state — a failed start/stop never reports success.
async function serviceOp(verb) {
  if (!systemdOK()) die('systemd --user unavailable');
  const units = OWNED_UNITS.map(u => u.replace('.service', ''));
  if (!svc(verb, ...units)) die(`${verb} failed (systemctl returned nonzero)`);
  const want = verb === 'stop' ? false : true;
  const bad = units.filter(u => isActive(u) !== want);
  if (bad.length) die(`${verb} incomplete: ${bad.join(', ')} not ${want ? 'active' : 'stopped'}`);
  ok(`${verb}: ${units.join(', ')} ${want ? 'active' : 'stopped'}`);
  return cmds.status();
}

const cmds = {
  async setup() {
    const b = pkgBinDir();
    if (!b) die('native binaries not found — is the platform package installed?');
    mkdir(ROOT); migrateLegacy();
    const switching = currentVersion() && currentVersion() !== VERSION;
    if (switching && isActive('reposuite-relay')) {
      const s = await runningSessions();
      if (s !== 0) die(s > 0 ? `${s} agent session(s) running — setup staged; run 'reposuite update apply' later`
                             : 'Relay state unknown — staging only (fail closed)');
    }
    const vdir = path.join(VERSIONS, VERSION);
    mkdir(path.join(vdir, 'bin'));
    for (const f of OWNED_BINS) fs.copyFileSync(path.join(b, f), path.join(vdir, 'bin', f));
    const prev = currentVersion();
    try { activate(VERSION); } catch (e) { if (prev) try { activate(prev); } catch {} die('activation failed: ' + e.message); }
    mkdir(RSG_DIR); mkdir(RSR_HOME); mkdir(path.join(RSG_DIR, 'cloud')); mkdir(path.dirname(SOCKET));
    for (const d of [ROOT, RSG_DIR, RSR_HOME, path.join(RSG_DIR, 'cloud')]) try { fs.chmodSync(d, 0o700); } catch {}
    writeUnits(path.join(vdir, 'bin'));
    if (!systemdOK()) { ok('systemd --user unavailable — units staged; start manually'); return; }
    execSync('systemctl --user daemon-reload');
    if (!svc('enable', '--now', ...OWNED_UNITS.map(u => u.replace('.service', '')))) {
      if (prev) try { activate(prev); } catch {}
      die(`unit enable failed — units at ${UNITS}${prev ? ' (previous version restored)' : ''}`);
    }
    ok(`setup complete (v${VERSION}) — run 'reposuite doctor', then 'reposuite pair'`);
  },

  async pair() {
    if (paired()) return ok('already paired — revocation is a Control-side action');
    let invite;
    if (!process.stdin.isTTY) invite = fs.readFileSync(0, 'utf8').trim();
    else invite = await readHidden('invite (inv_<id>.<secret>): ');
    if (!/^inv_[\w-]+\.[\w-]+$/.test(invite)) die('malformed invite');
    // the invite travels ONLY over the owner-only Unix socket (local IPC)
    let st;
    try { st = await cloudPair(invite); } catch (e) { die('pairing failed: ' + e.message); }
    // invite is QUEUED asynchronously: accepted != paired != online
    ok('invite accepted — waiting for the cloud handshake');
    let pairedSeen = false, s = null;
    for (let i = 0; i < 30; i++) {           // up to ~15s for durable identity
      s = await cloudStatus();
      if (s && s.paired) { pairedSeen = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!pairedSeen) die('pairing did not produce durable gateway identity (expired/refused invite?)');
    ok(`paired (gateway ${s.gateway_key || '?'}) — waiting for authenticated cloud`);
    for (let i = 0; i < 20; i++) {           // up to ~10s for online
      s = await cloudStatus();
      if (s && s.online) return ok('cloud ONLINE (authenticated WSS)');
      await new Promise(r => setTimeout(r, 500));
    }
    ok('paired; online not yet observed' + (s && s.last_error ? ' — cloud: ' + s.last_error : ''));
    console.log('  check: reposuite status');
  },

  async doctor() {
    let fail = 0;
    const chk = (name, v) => { console.log(` ${v ? ' ok ' : 'FAIL'} ${name}`); if (!v) fail = 1; };
    console.log('reposuite doctor  (v' + VERSION + ')');
    console.log(' pre-pair:');
    chk('linux platform', process.platform === 'linux');
    chk('native binaries', !!pkgBinDir() || !!installedBinDir());
    chk('provider cli (any)', ['codex', 'devin', 'opencode'].some(have));
    chk('systemd --user', systemdOK());
    console.log(' services:');
    chk('gateway service active', !systemdOK() || isActive('reposuite-gateway'));
    chk('relay service active', !systemdOK() || isActive('reposuite-relay'));
    chk('gateway socket live', fs.existsSync(SOCKET));
    chk('relay api.token 0600', (() => {
      const t = path.join(RSR_HOME, 'config', 'api.token');
      return fs.existsSync(t) && (fs.statSync(t).mode & 0o777) === 0o600;
    })());
    console.log(' cloud:');
    const cs = await cloudStatus();
    if (!cs) { chk('gateway cloud status reachable', false); }
    else {
      chk('cloud transport enabled', !!cs.enabled);
      chk('gateway paired (durable identity)', !!cs.paired);
      if (cs.paired) chk('cloud ONLINE (authenticated WSS)', !!cs.online);
      if (cs.last_error) console.log('  info last cloud error: ' + cs.last_error);
    }
    process.exit(fail);
  },

  async status() {
    for (const u of OWNED_UNITS.map(u => u.replace('.service', '')))
      console.log(`${u.padEnd(24)} ${isActive(u) ? 'active' : 'inactive'}`);
    const cs = await cloudStatus();
    console.log(`paired:                 ${cs && cs.paired ? 'yes' : 'no'}`);
    console.log(`cloud online:           ${cs && cs.online ? 'yes' : 'no'}${cs && cs.gateway_key ? '  (' + cs.gateway_key + ')' : ''}`);
    console.log(`activated version:      ${currentVersion() || 'none'}`);
  },

  start() { return serviceOp('start'); },
  stop() { return serviceOp('stop'); },
  restart() { return serviceOp('restart'); },

  'update-check': () => {
    try {
      const out = execFileSync('npm', ['view', 'reposuite', 'dist-tags', '--json'],
        { encoding: 'utf8' }).trim();
      const tags = JSON.parse(out);
      const chan = /beta|alpha|rc/.test(VERSION) ? (tags.beta || tags.latest) : (tags.latest || tags.beta);
      console.log(`installed ${VERSION}  channel ${chan}${chan === VERSION ? '  (up to date)' : '  — run: npm update -g reposuite'}`);
    } catch { die('npm registry unreachable'); }
  },

  'update-apply': async () => {
    const cur = currentVersion();
    const sessions = await runningSessions();
    if (sessions !== 0) die(sessions > 0
      ? `${sessions} agent session(s) running — deferring activation`
      : 'Relay state unknown — deferring activation (fail closed)');
    // install the NEW package's own binaries into a fresh version dir —
    // never re-copy the old activated runtime into a new version.
    const b = pkgBinDir();
    if (!b) die('new package carries no platform binaries');
    const v = VERSION;
    const vdir = path.join(VERSIONS, v);
    mkdir(path.join(vdir, 'bin'));
    for (const f of OWNED_BINS) fs.copyFileSync(path.join(b, f), path.join(vdir, 'bin', f));
    try { activate(v); } catch (e) { if (cur) try { activate(cur); } catch {} die('activation failed: ' + e.message); }
    writeUnits(path.join(vdir, 'bin'));
    if (systemdOK()) { execSync('systemctl --user daemon-reload'); cmds.restart(); }
    ok(`activated ${v}${cur && cur !== v ? ` (previous ${cur} kept for rollback)` : ''}`);
  },

  rollback: async () => {
    const cur = currentVersion();
    const versions = fs.readdirSync(VERSIONS).filter(v => v !== cur).sort(cmpVer).reverse();
    if (!versions.length) die('no previous version to roll back to');
    const target = versions[0];
    const s = await runningSessions();
    if (s !== 0) die(s > 0 ? `${s} agent session(s) running — stop them first`
                            : 'Relay state unknown — refusing rollback (fail closed)');
    activate(target);
    writeUnits(path.join(VERSIONS, target, 'bin'));
    if (systemdOK()) { execSync('systemctl --user daemon-reload'); cmds.restart(); }
    ok(`rolled back ${cur} -> ${target}`);
  },

  uninstall() {
    if (systemdOK()) { svc('disable', '--now', ...OWNED_UNITS.map(u => u.replace('.service', ''))); }
    for (const u of OWNED_UNITS) try { fs.unlinkSync(path.join(UNITS, u)); } catch {}
    if (systemdOK()) execSync('systemctl --user daemon-reload');
    // state preserved: versions dir, projects, creds all kept — use
    // 'purge-state' (explicit) to remove them.
    try { fs.unlinkSync(CURRENT); } catch {}
    ok('units + activation removed; state preserved under ' + ROOT);
    console.log('  full state removal: reposuite purge-state');
  },

  'purge-state': () => {
    if (args.includes('--yes') !== true) {
      console.log('purge-state permanently removes:');
      for (const d of [ROOT, path.join(XDG_DATA, 'reposuite-gateway'), path.join(HOME, '.reposuite'), path.join(XDG_DATA, 'rsc-connector')])
        console.log('  ' + d);
      if (!process.stdin.isTTY) die('non-interactive: pass --yes to confirm');
      const a = fs.readFileSync(0, 'utf8').trim();
      if (a !== 'purge') die('aborted');
    }
    cmds.uninstall();
    for (const d of [ROOT, path.join(XDG_DATA, 'reposuite-gateway'),
                     path.join(HOME, '.reposuite'), path.join(XDG_DATA, 'rsc-connector'), ENV_FILE])
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    ok('RepoSuite state purged (owned roots only; unrelated state untouched)');
  },

  version: () => console.log(VERSION),
  help() {
    console.log(`reposuite <command>

  setup            install+enable user services (versioned runtime)
  doctor           readiness checks (pre-pair / post-pair / connectivity)
  pair             protected invite pairing (stdin or hidden prompt)
  start|stop|restart|status   service control + pairing/activation state
  update check     compare installed vs npm latest
  update apply     activate the installed version safely (defers on live sessions)
  rollback         re-activate the previous runtime version
  uninstall        remove units+activation, preserve state
  purge-state      remove all owned state roots (explicit)`);
  },
};

const args = process.argv.slice(2);
const cmd = args.join('-') === 'update-check' || args[0] === 'update' && args[1] === 'check' ? 'update-check'
  : args.join('-') === 'update-apply' || args[0] === 'update' && args[1] === 'apply' ? 'update-apply'
  : args[0];
const fn = cmds[cmd] || cmds.help;
Promise.resolve(fn(...args.slice(1))).catch(e => die(e.message));
