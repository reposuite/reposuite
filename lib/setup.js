'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

function usage() {
  return `Usage: reposuite setup <KEY> <NAME> --auth-mode code [--json] [--server URL] [--state-dir DIR]

Starts one RSC device pairing request, prints the verification URL and one-time
code, waits for Owner approval, and writes the resulting one-shot gateway invite
to a private file. No browser or password is used on this machine.`;
}

function parseArgs(argv) {
  const out = { key: '', name: '', authMode: '', json: false,
    server: process.env.REPOSUITE_RSC_URL || 'https://app.reposuite.com',
    stateDir: path.join(os.homedir(), '.reposuite', 'gateway'), connector: '' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--auth-mode') out.authMode = argv[++i] || '';
    else if (a === '--server') out.server = argv[++i] || '';
    else if (a === '--state-dir') out.stateDir = argv[++i] || '';
    else if (a === '--connector') out.connector = argv[++i] || '';
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else positional.push(a);
  }
  out.key = positional[0] || '';
  out.name = positional[1] || out.key;
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

async function run(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help) { console.log(usage()); return; }
  if (!opts.key || !opts.name) { console.error(usage()); process.exit(2); }
  if (opts.authMode !== 'code') {
    console.error('only --auth-mode code is supported');
    process.exit(2);
  }

  const begin = await postJSON(opts.server, '/v1/pairing/begin', {
    hostname: os.hostname(), os: process.platform, version: 'reposuite-npm',
    suggested_label: opts.name, suggested_key: opts.key,
  });
  if (!begin.pair_id || !begin.device_secret || !begin.user_code || !begin.verification_url_complete) {
    console.error('RSC returned an invalid pairing response');
    process.exit(1);
  }
  if (opts.json) {
    console.log(JSON.stringify({ event: 'pairing', verification_url: begin.verification_url_complete,
      code: begin.user_code, expires_in: begin.expires_in || 600, gateway: opts.key }));
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
    if (poll.status === 'pending' || poll.status === 'claimed') continue;
    if (poll.status !== 'authorized' || !poll.invite_id || !poll.invite_token) {
      console.error(`pairing ${poll.status || 'failed'}`);
      process.exit(1);
    }
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
    if (opts.json) {
      console.log(JSON.stringify({ event: 'authorized', gateway: opts.key,
        label: opts.name, invite_file: inviteFile, status: 'paired', connector_started: !!opts.connector }));
    } else {
      console.log(`Gateway ${opts.key} paired; invite stored at ${inviteFile}`);
    }
    return;
  }
  console.error('pairing expired');
  process.exit(1);
}

module.exports = { run, parseArgs };
