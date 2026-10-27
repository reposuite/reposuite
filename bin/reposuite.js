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

const HOME = os.homedir();
const XDG_DATA = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
const XDG_CONF = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const XDG_RUNTIME = process.env.XDG_RUNTIME_DIR || path.join(HOME, '.reposuite', 'run');
const VERSIONS = path.join(XDG_DATA, 'reposuite', 'versions');
const CURRENT = path.join(XDG_DATA, 'reposuite', 'current');  // symlink -> versions/<v>
const RSG_DIR = path.join(XDG_DATA, 'reposuite-gateway');
const RSR_HOME = path.join(HOME, '.reposuite', 'relay');
const CONN_DIR = path.join(XDG_DATA, 'rsc-connector');
const ENV_FILE = path.join(XDG_DATA, 'rsc-connector.env');
const SOCKET = path.join(XDG_RUNTIME, 'reposuite-gateway', 'host.sock');
const UNITS = path.join(XDG_CONF, 'systemd', 'user');
const WSS = process.env.RSC_WS_URL || 'wss://app.reposuite.com/gateway';
const OWNED_BINS = ['reposuite-gateway', 'reposuite-relay', 'rsc-connector'];
const OWNED_UNITS = ['reposuite-rsg.service', 'reposuite-rsr.service', 'reposuite-connector.service'];
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
const paired = () => fs.existsSync(path.join(CONN_DIR, 'gateway.json'));

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

function runningSessions() {
  // real check: relay daemon sessionCount > 0 defers unsafe activation
  try {
    const tok = fs.readFileSync(path.join(RSR_HOME, 'config', 'api.token'), 'utf8').trim();
    const port = JSON.parse(fs.readFileSync(path.join(RSR_HOME, 'config', 'relay.json'), 'utf8')).listenPort;
    const out = execFileSync('wget', ['-qO-', `--header=Authorization: Bearer ${tok}`,
      `http://127.0.0.1:${port}/v1/daemon`], { encoding: 'utf8', timeout: 5000 });
    const d = JSON.parse(out);
    const n = (d.daemon && (d.daemon.activeSessions ?? d.daemon.sessionCount)) || 0;
    return n;
  } catch {
    // unknown: relay never initialized (no token) means no sessions possible;
    // an EXISTING token that failed to answer means state unknown -> deny.
    return fs.existsSync(path.join(RSR_HOME, 'config', 'api.token')) ? -1 : 0;
  }
}

function writeUnits(bin) {
  mkdir(UNITS);
  const sock = path.join(XDG_RUNTIME, 'reposuite-gateway', 'host.sock');
  fs.writeFileSync(path.join(UNITS, 'reposuite-rsg.service'), `[Unit]
Description=RepoSuite Gateway (user)
After=default.target

[Service]
UMask=0077
ExecStart=${bin}/reposuite-gateway serve --data-dir ${RSG_DIR} --socket ${sock}
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`);
  fs.writeFileSync(path.join(UNITS, 'reposuite-rsr.service'), `[Unit]
Description=RepoSuite Relay (user)
After=reposuite-rsg.service

[Service]
UMask=0077
Environment=REPOSUITE_HOME=${HOME}/.reposuite
ExecStart=${bin}/reposuite-relay serve
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`);
  fs.writeFileSync(path.join(UNITS, 'reposuite-connector.service'), `[Unit]
Description=RepoSuite Connector (user)
After=reposuite-rsr.service reposuite-rsg.service
Requires=reposuite-rsr.service reposuite-rsg.service

[Service]
UMask=0077
EnvironmentFile=${ENV_FILE}
ExecStartPre=/bin/sh -c 'for i in $(seq 1 60); do [ -f ${RSR_HOME}/config/api.token ] && exit 0; sleep 1; done; exit 1'
ExecStart=${bin}/rsc-connector -server \${RSC_WS_URL} -state ${CONN_DIR} -rsg-socket ${sock} -rsr-home ${RSR_HOME} -label \${RSC_GATEWAY_LABEL} -agent-version \${RSC_AGENT_VERSION}
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`);
  fs.writeFileSync(ENV_FILE,
    `RSC_WS_URL=${WSS}\nRSC_GATEWAY_LABEL=${os.hostname()}\nRSC_AGENT_VERSION=rsc-connector/${VERSION}\n`,
    { mode: 0o600 });
}

const cmds = {
  setup() {
    const b = pkgBinDir();
    if (!b) die('native binaries not found — is the platform package installed?');
    // install this package's binaries into a versioned runtime dir, then
    // atomically activate — updates never delete a running path
    const vdir = path.join(VERSIONS, VERSION);
    mkdir(path.join(vdir, 'bin'));
    for (const f of OWNED_BINS) fs.copyFileSync(path.join(b, f), path.join(vdir, 'bin', f));
    activate(VERSION);
    mkdir(RSG_DIR); mkdir(RSR_HOME); mkdir(CONN_DIR); mkdir(path.dirname(SOCKET));
    for (const d of [RSG_DIR, RSR_HOME, CONN_DIR]) try { fs.chmodSync(d, 0o700); } catch {}
    writeUnits(path.join(vdir, 'bin'));
    if (!systemdOK()) { ok('systemd --user unavailable — units staged; start manually'); return; }
    execSync('systemctl --user daemon-reload');
    if (!svc('enable', '--now', ...OWNED_UNITS.map(u => u.replace('.service', ''))))
      die(`unit enable failed — units at ${UNITS}`);
    ok(`setup complete (v${VERSION}) — run 'reposuite doctor', then 'reposuite pair'`);
  },

  pair() {
    if (paired()) return ok(`already paired (${CONN_DIR}/gateway.json)`);
    // protected input: stdin pipe or hidden prompt — NEVER argv/env/history
    let invite;
    if (!process.stdin.isTTY) {
      invite = fs.readFileSync(0, 'utf8').trim();
    } else {
      // hidden interactive entry: raw-mode readline, echo muted
      invite = '';
      const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      rl._writeToOutput = () => {};           // mute echo
      process.stderr.write('invite (inv_<id>.<secret>): ');
      invite = require('child_process').execSync('stty -echo; head -n1; stty echo', { shell: '/bin/sh', encoding: 'utf8' }).trim();
      rl.close();
      process.stderr.write('\n');
    }
    if (!/^inv_[\w-]+\.[\w-]+$/.test(invite)) die('malformed invite');
    mkdir(CONN_DIR); fs.chmodSync(CONN_DIR, 0o700);
    const ifile = path.join(CONN_DIR, `.invite.${process.pid}`);
    fs.writeFileSync(ifile, invite, { mode: 0o600 });
    const b = installedBinDir() || pkgBinDir();
    const was = isActive('reposuite-connector'); if (was) svc('stop', 'reposuite-connector');
    const p = spawnSync(path.join(b, 'rsc-connector'),
      ['-server', WSS, '-invite-file', ifile, '-state', CONN_DIR,
       '-rsg-socket', SOCKET, '-rsr-home', RSR_HOME, '-label', os.hostname()],
      { timeout: 45000, stdio: 'ignore' });
    try { fs.unlinkSync(ifile); } catch {}
    if (was) svc('start', 'reposuite-connector');
    if (!paired()) die('pairing failed: no durable gateway.json (expired/refused invite?)');
    let j; try { j = JSON.parse(fs.readFileSync(path.join(CONN_DIR, 'gateway.json'), 'utf8')); }
    catch { die('gateway.json present but unparseable — identity unverified'); }
    if (!(j.credential || j.token || j.key || j.gateway)) die('gateway.json lacks gateway credential — unverified');
    ok('paired — durable credential + gateway identity stored');
  },

  doctor() {
    let fail = 0;
    const chk = (name, fn) => { const r = (() => { try { return !!fn(); } catch { return false; } })();
      console.log(` ${r ? ' ok ' : 'FAIL'} ${name}`); if (!r) fail = 1; };
    console.log('reposuite doctor  (v' + VERSION + ')');
    console.log(' pre-pair:');
    chk('linux platform', () => process.platform === 'linux');
    chk('native binaries', () => !!pkgBinDir() || !!installedBinDir());
    chk('provider cli (any)', () => ['codex', 'devin', 'opencode'].some(have));
    chk('systemd --user', systemdOK);
    console.log(' post-pair/service:');
    chk('rsg socket live', () => fs.existsSync(SOCKET));
    chk('rsr api.token 0600', () => {
      const t = path.join(RSR_HOME, 'config', 'api.token');
      return fs.existsSync(t) && (fs.statSync(t).mode & 0o777) === 0o600;
    });
    chk('rsr api v2 live', () => {
      const tok = fs.readFileSync(path.join(RSR_HOME, 'config', 'api.token'), 'utf8').trim();
      const port = JSON.parse(fs.readFileSync(path.join(RSR_HOME, 'config', 'relay.json'), 'utf8')).listenPort;
      const out = execFileSync('wget', ['-qO-', `--header=Authorization: Bearer ${tok}`,
        `http://127.0.0.1:${port}/v1/daemon`], { encoding: 'utf8', timeout: 5000 });
      return /apiVersion["\s:]*2/.test(out);
    });
    chk('connector creds stored', paired);
    if (paired()) chk('connector service running', () => !systemdOK() || isActive('reposuite-connector'));
    console.log(' connectivity (observed):',
      systemdOK() && isActive('reposuite-connector')
        ? 'service active — see journalctl --user -u reposuite-connector'
        : 'connector not running — cloud connectivity UNKNOWN');
    process.exit(fail);
  },

  status() {
    for (const u of OWNED_UNITS.map(u => u.replace('.service', '')))
      console.log(`${u.padEnd(22)} ${isActive(u) ? 'active' : 'inactive'}`);
    console.log(`pairing:               ${paired() ? 'paired' : 'NOT paired'}`);
    console.log(`activated version:     ${currentVersion() || 'none'}`);
  },

  start() { svc('start', ...OWNED_UNITS.map(u => u.replace('.service', ''))); cmds.status(); },
  stop() { svc('stop', 'reposuite-connector', 'reposuite-rsr', 'reposuite-rsg'); cmds.status(); },
  restart() { svc('restart', ...OWNED_UNITS.map(u => u.replace('.service', ''))); cmds.status(); },

  'update-check': () => {
    try {
      const out = execFileSync('npm', ['view', 'reposuite', 'dist-tags', '--json'],
        { encoding: 'utf8' }).trim();
      const tags = JSON.parse(out);
      const chan = /beta|alpha|rc/.test(VERSION) ? (tags.beta || tags.latest) : (tags.latest || tags.beta);
      console.log(`installed ${VERSION}  channel ${chan}${chan === VERSION ? '  (up to date)' : '  — run: npm update -g reposuite'}`);
    } catch { die('npm registry unreachable'); }
  },

  'update-apply': () => {
    const cur = currentVersion();
    const sessions = runningSessions();
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
    activate(v);
    writeUnits(path.join(vdir, 'bin'));
    if (systemdOK()) { execSync('systemctl --user daemon-reload'); cmds.restart(); }
    ok(`activated ${v}${cur && cur !== v ? ` (previous ${cur} kept for rollback)` : ''}`);
  },

  rollback: () => {
    const cur = currentVersion();
    const versions = fs.readdirSync(VERSIONS).filter(v => v !== cur).sort(cmpVer).reverse();
    if (!versions.length) die('no previous version to roll back to');
    const target = versions[0];
    if (runningSessions() > 0) die('active sessions — stop first');
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
    ok('units + activation removed; state preserved under ' + path.join(XDG_DATA, 'reposuite'));
    console.log('  full state removal: reposuite purge-state');
  },

  'purge-state': () => {
    if (args.includes('--yes') !== true) {
      console.log('purge-state permanently removes:');
      for (const d of [RSG_DIR, path.join(HOME, '.reposuite'), CONN_DIR, path.join(XDG_DATA, 'reposuite')])
        console.log('  ' + d);
      if (!process.stdin.isTTY) die('non-interactive: pass --yes to confirm');
      const a = fs.readFileSync(0, 'utf8').trim();
      if (a !== 'purge') die('aborted');
    }
    cmds.uninstall();
    for (const d of [RSG_DIR, path.join(HOME, '.reposuite'), CONN_DIR,
                     path.join(XDG_DATA, 'reposuite'), ENV_FILE])
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
fn(...args.slice(1));
