'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

function usage() {
  return `Usage: reposuite setup [KEY] [NAME] [--device-code] [--auth-mode code] [--name NAME] [--api-key-file PATH|-] [--json] [--server URL] [--state-dir DIR]
       reposuite setup cancel
       reposuite status [--json]

Starts one RSC device pairing request, prints the verification URL and one-time
code, waits for Owner approval, and writes the resulting one-shot gateway invite
to a private file. No browser or password is used on this machine.`;
}

function parseArgs(argv) {
  const out = { key: '', name: '', authMode: '', json: false,
    server: process.env.REPOSUITE_RSC_URL || 'https://app.reposuite.com',
    stateDir: path.join(os.homedir(), '.reposuite', 'gateway'), connector: '', noStart: false, nameFlag: '', apiKeyFile: '', cancel: false, status: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--auth-mode') out.authMode = argv[++i] || '';
    else if (a === '--device-code') out.authMode = 'code';
    else if (a === '--name') out.nameFlag = argv[++i] || '';
    else if (a === '--api-key-file') out.apiKeyFile = argv[++i] || '';
    else if (a === 'status') out.status = true;
    else if (a === '--server') out.server = argv[++i] || '';
    else if (a === '--state-dir') out.stateDir = argv[++i] || '';
    else if (a === '--connector') out.connector = argv[++i] || '';
    else if (a === '--no-start') out.noStart = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else positional.push(a);
  }
  out.key = positional[0] || '';
  if (out.key === 'cancel') { out.cancel = true; out.key = ''; }
  out.name = out.nameFlag || positional[1] || out.key;
  out.server = out.server.replace(/\/+$/, '');
  return out;
}

function postJSON(base, pathname, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const lib = url.protocol === 'http:' ? http : https;
    const raw = Buffer.from(JSON.stringify(body));
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': raw.length },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`RSC HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid RSC JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('RSC timeout')));
    req.on('error', reject);
    req.end(raw);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function platformName() {
  return process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
}

function archName() {
  return process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
}

function ensureConnector(opts) {
  if (opts.connector) return opts.connector;
  const envConnector = process.env.REPOSUITE_CONNECTOR;
  if (envConnector) return envConnector;
  const plat = platformName(), arch = archName();
  const root = path.join(__dirname, '..');
  const target = path.join(opts.stateDir, 'bin', 'rsc-connector');
  if (fs.existsSync(target)) return target;
  const assetName = `connector_0.2.0_${plat}_${arch}.tar.gz`;
  const asset = path.join(root, 'assets', assetName);
  const sums = path.join(root, 'assets', 'checksums_connector_sha256.txt');
  if (!fs.existsSync(asset) || !fs.existsSync(sums)) {
    const found = process.env.PATH.split(path.delimiter).map((d) => path.join(d, 'rsc-connector')).find((p) => fs.existsSync(p));
    if (found) return found;
    throw new Error(`connector asset unavailable for ${plat}/${arch}; install rsc-connector or set REPOSUITE_CONNECTOR`);
  }
  const expected = fs.readFileSync(sums, 'utf8').split(/\r?\n/).map((l) => l.trim().split(/\s+/))
    .find((p) => p.length >= 2 && p[1].replace(/^\*/, '') === assetName);
  if (!expected || sha256(asset) !== expected[0]) throw new Error('connector checksum validation failed');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reposuite-connector-'));
  const r = spawnSync('tar', ['-xzf', asset, '-C', tmp], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error('connector extraction failed');
  const src = path.join(tmp, 'rsc-connector');
  if (!fs.existsSync(src)) throw new Error('connector binary missing after extraction');
  fs.copyFileSync(src, target);
  fs.chmodSync(target, 0o700);
  return target;
}

function waitForConnector(stateDir, timeoutMs = 20000) {
  const f = path.join(stateDir, 'connector', 'gateway.json');
  const end = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(f)) return resolve(true);
      if (Date.now() > end) return reject(new Error('connector did not come online'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function prompt(question) {
  const readline = require('readline');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function pendingPath(opts) { return path.join(opts.stateDir, 'pending.json'); }

function readPending(opts) {
  try { return JSON.parse(fs.readFileSync(pendingPath(opts), 'utf8')); } catch { return null; }
}

function clearPending(opts) { try { fs.unlinkSync(pendingPath(opts)); } catch {} }

async function status(argv) {
  const opts = parseArgs(argv);
  const cfgPath = path.join(opts.stateDir, 'gateway.json');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  const state = path.join(opts.stateDir, 'connector', 'gateway.json');
  const online = fs.existsSync(state);
  const out = { gateway: cfg ? cfg.gateway : null, label: cfg ? cfg.label : null,
    server: cfg ? cfg.server : null, online, pending: !!readPending(opts) };
  if (opts.json) console.log(JSON.stringify(out));
  else if (!cfg) { console.error('no gateway configured'); process.exit(1); }
  else console.log(`${out.gateway} (${out.label}) ${online ? 'online' : 'offline'}${out.pending ? ' — pending pairing' : ''}`);
}

async function cancel(argv) {
  const opts = parseArgs(argv);
  const p = readPending(opts);
  if (!p) { console.error('no pending setup request'); process.exit(1); }
  try {
    await postJSON(p.server, '/v1/pairing/cancel', { pair_id: p.pair_id, device_secret: p.device_secret });
  } catch (_) {
    // local cancel still clears the only pending request
  } finally { clearPending(opts); }
  if (opts.json) console.log(JSON.stringify({ status: 'cancelled' }));
  else console.log('pending setup cancelled');
}

async function run(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help) { console.log(usage()); return; }
  if (opts.cancel) return cancel(argv);
  let apiKey = '';
  if (opts.apiKeyFile) {
    apiKey = opts.apiKeyFile === '-' ? fs.readFileSync(0, 'utf8').trim() : fs.readFileSync(opts.apiKeyFile, 'utf8').trim();
    if (!apiKey) { console.error('empty API key file'); process.exit(2); }
  }
  if (!opts.json) {
    if (!opts.key) opts.key = await prompt('Gateway key (3-12 chars): ');
    if (!opts.name) opts.name = await prompt('Gateway name: ');
  }
  if (!opts.key || !opts.name) { console.error(usage()); process.exit(2); }
  if (!opts.authMode) opts.authMode = 'code';
  if (opts.authMode !== 'code') {
    console.error('only --device-code / --auth-mode code is supported');
    process.exit(2);
  }
  if (apiKey) {
    if (!opts.key || !opts.name) { console.error(usage()); process.exit(2); }
    let claim;
    try {
      claim = await postJSON(opts.server, '/v1/enroll/claim', { key: apiKey, gateway: opts.key, name: opts.name });
    } catch (e) {
      console.error('enrollment failed: ' + e.message);
      process.exit(1);
    }
    if (!claim.invite_id || !claim.invite_token) { console.error('invalid enrollment response'); process.exit(1); }
    const invite = `${claim.invite_id}.${claim.invite_token}`;
    const inviteFile = path.join(opts.stateDir, 'invite');
    writePrivate(inviteFile, invite + '\n');
    writePrivate(path.join(opts.stateDir, 'gateway.json'), JSON.stringify({ gateway: opts.key, label: opts.name, server: opts.server, invite_file: inviteFile, paired_at: new Date().toISOString() }, null, 2) + '\n');
    if (opts.noStart) {
      if (opts.json) console.log(JSON.stringify({ event: 'authorized', gateway: opts.key, label: opts.name, invite_file: inviteFile, status: 'paired', online: false }));
      else console.log(`Gateway ${opts.key} paired; invite stored at ${inviteFile}`);
      return;
    }
    const connector = ensureConnector(opts);
    const log = fs.openSync(path.join(opts.stateDir, 'connector.log'), 'a', 0o600);
    const child = spawn(connector, ['-server', opts.server.replace(/^http/, 'ws') + '/gateway', '-invite-file', inviteFile, '-state', path.join(opts.stateDir, 'connector'), '-label', opts.key, '-agent-version', 'reposuite-npm'], { detached: true, stdio: ['ignore', log, log] });
    child.unref();
    await waitForConnector(opts.stateDir);
    if (opts.json) console.log(JSON.stringify({ event: 'online', gateway: opts.key, label: opts.name, invite_file: inviteFile, status: 'online', online: true }));
    else console.log(`Gateway ${opts.key} is online`);
    return;
  }
  const pending = readPending(opts);
  if (pending) { console.error('a setup request is already pending; run: reposuite setup cancel'); process.exit(2); }

  const begin = await postJSON(opts.server, '/v1/pairing/begin', {
    hostname: os.hostname(), os: process.platform, version: 'reposuite-npm',
    suggested_label: opts.name, suggested_key: opts.key,
  });
  if (!begin.pair_id || !begin.device_secret || !begin.user_code || !begin.verification_url_complete) {
    console.error('RSC returned an invalid pairing response');
    process.exit(1);
  }
  writePrivate(pendingPath(opts), JSON.stringify({ pair_id: begin.pair_id, device_secret: begin.device_secret, server: opts.server, key: opts.key, name: opts.name, expires_at: new Date(Date.now() + (begin.expires_in || 600) * 1000).toISOString() }) + '\n');
  if (opts.json) {
    console.log(JSON.stringify({ event: 'pairing', status: 'pending', action_required: true,
      verification_url: begin.verification_url_complete, code: begin.user_code,
      expires_in: begin.expires_in || 600, gateway: opts.key }));
  } else {
    console.log(`Verification URL: ${begin.verification_url_complete}`);
    console.log(`Code: ${begin.user_code}`);
    console.log('Waiting for Owner approval (10 minutes)...');
  }

  const interval = Number(process.env.REPOSUITE_POLL_MS || 3000);
  const deadline = Date.now() + (Number(begin.expires_in || 600) * 1000);
  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await postJSON(opts.server, '/v1/pairing/poll', {
      pair_id: begin.pair_id, device_secret: begin.device_secret,
    });
    if (poll.status === 'pending' || poll.status === 'claimed' || poll.status === 'throttled') continue;
    if (poll.status !== 'authorized' || !poll.invite_id || !poll.invite_token) {
      clearPending(opts);
      console.error(`pairing ${poll.status || 'failed'}`);
      process.exit(1);
    }
    clearPending(opts);
    const invite = `${poll.invite_id}.${poll.invite_token}`;
    const inviteFile = path.join(opts.stateDir, 'invite');
    writePrivate(inviteFile, invite + '\n');
    writePrivate(path.join(opts.stateDir, 'gateway.json'), JSON.stringify({
      gateway: opts.key, label: opts.name, server: opts.server,
      invite_file: inviteFile, paired_at: new Date().toISOString(),
    }, null, 2) + '\n');
    if (opts.connector) {
      const child = spawn(opts.connector, ['-server', opts.server.replace(/^http/, 'ws') + '/gateway',
        '-invite-file', inviteFile, '-state', path.join(opts.stateDir, 'connector'), '-label', opts.key], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    if (opts.noStart) {
      if (opts.json) console.log(JSON.stringify({ event: 'authorized', gateway: opts.key, label: opts.name, invite_file: inviteFile, status: 'paired', online: false }));
      else console.log(`Gateway ${opts.key} paired; invite stored at ${inviteFile}`);
      return;
    }
    const connector = ensureConnector(opts);
    const log = fs.openSync(path.join(opts.stateDir, 'connector.log'), 'a', 0o600);
    const child = spawn(connector, ['-server', opts.server.replace(/^http/, 'ws') + '/gateway',
      '-invite-file', inviteFile, '-state', path.join(opts.stateDir, 'connector'), '-label', opts.key,
      '-agent-version', 'reposuite-npm'], { detached: true, stdio: ['ignore', log, log] });
    child.unref();
    await waitForConnector(opts.stateDir);
    if (opts.json) console.log(JSON.stringify({ event: 'online', gateway: opts.key, label: opts.name, invite_file: inviteFile, status: 'online', online: true }));
    else console.log(`Gateway ${opts.key} is online`);
    return;
  }
  console.error('pairing expired');
  process.exit(1);
}

module.exports = { run, status, cancel, parseArgs };
