#!/usr/bin/env node
/*
 * DIST.PAIR wire fixture: `reposuite pair --invite` must POST the private
 * manual invite to the gateway owner-socket route /v1/cloud/pair-invite
 * (Gateway d838065 contract CloudPairInviteID), never the retired
 * /v1/cloud/pair path, and must never print the invite. Fake UDS HTTP
 * server only — no daemon, no network, no real state.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawnSync, spawn } = require('child_process');

const CLI = process.env.REPOSUITE_CLI || path.join(__dirname, '..', 'target', 'release', 'reposuite');
if (!process.env.REPOSUITE_CLI) {
  const b = spawnSync('cargo', ['build', '--release'],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 600000 });
  if (b.error || b.status !== 0) {
    console.error('pair-invite: cargo build --release failed');
    if (b.stderr) console.error(b.stderr.trim().split('\n').slice(-8).join('\n'));
    process.exit(2);
  }
}
if (!fs.existsSync(CLI)) { console.error('pair-invite: CLI not built'); process.exit(2); }

let fail = 0;
const chk = (n, ok, extra) => { console.log(` ${ok ? ' ok ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); if (!ok) fail = 1; };

const INVITE = 'inv_fixtureid.fixturesecret123';
const seen = [];

function readHttp(sock) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = buf.slice(0, i).toString();
      const m = head.match(/^([A-Z]+) (\S+) HTTP/);
      const len = parseInt((head.match(/Content-Length: (\d+)/i) || [])[1] || '0', 10);
      if (buf.length < i + 4 + len) return;
      sock.removeListener('data', onData);
      resolve({ method: m && m[1], path: m && m[2], body: buf.slice(i + 4, i + 4 + len).toString() });
    };
    sock.on('data', onData);
  });
}

function respond(sock, status, obj) {
  const b = JSON.stringify(obj);
  sock.end(`HTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(b)}\r\nConnection: close\r\n\r\n${b}`);
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reposuite-pair-'));
  const runtime = path.join(home, '.reposuite', 'run', 'reposuite');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const sockPath = path.join(runtime, 'gateway.sock');
  const server = net.createServer((sock) => {
    readHttp(sock).then((req) => {
      seen.push(req);
      if (req.path === '/v1/cloud/pair-invite' && req.method === 'POST') {
        respond(sock, 200, { status: 'authorized' });
      } else if (req.path === '/v1/cloud/status' && req.method === 'GET') {
        respond(sock, 200, { paired: true, online: true, gateway_key: 'gw_fixture' });
      } else {
        respond(sock, 404, { error: { code: 'not_found', message: 'no route' } });
      }
    });
  });
  await new Promise((r, j) => { server.once('error', j); server.listen(sockPath, r); });
  fs.chmodSync(sockPath, 0o600);
  // prove the fixture socket accepts a client before spawning the CLI
  await new Promise((res, rej) => {
    const c = net.connect(sockPath, () => { c.end(); res(); });
    c.on('error', rej); setTimeout(() => rej(new Error('fixture socket connect timeout')), 3000);
  });

  const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, '.local', 'share'),
                XDG_CONFIG_HOME: path.join(home, '.config'), XDG_RUNTIME_DIR: undefined };
  delete env.XDG_RUNTIME_DIR; // force HOME/.reposuite/run socket path
  const r = await new Promise((res) => {
    const p = spawn(CLI, ['pair', '--invite'], { env });
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => err += d);
    p.stdin.write(INVITE + '\n'); p.stdin.end();
    const to = setTimeout(() => { p.kill('SIGKILL'); res({ status: -1, stdout: out, stderr: err + ' TIMEOUT' }); }, 30000);
    p.on('close', (code) => { clearTimeout(to); res({ status: code, stdout: out, stderr: err }); });
  });
  server.close();
  // diagnostic: is the fixture socket still connectable post-run?
  const post = await new Promise((res) => {
    const c = net.connect(sockPath, () => { c.end(); res('connect-ok'); });
    c.on('error', (e) => res('connect-fail:' + e.code));
    setTimeout(() => res('connect-timeout'), 2000);
  });
  console.log(' diag socket=' + sockPath + ' post=' + post + ' requests=' + JSON.stringify(seen.map(q=>q.method+' '+q.path)));

  chk('exit 0 (paired + cloud online via fixture)', r.status === 0, `status=${r.status} stderr=${(r.stderr || '').trim().slice(0, 120)}`);
  const inviteReqs = seen.filter((q) => q.path === '/v1/cloud/pair-invite');
  chk('exactly one POST /v1/cloud/pair-invite', inviteReqs.length === 1, `paths=${seen.map((q) => q.method + ' ' + q.path).join(',')}`);
  chk('no request to retired /v1/cloud/pair', !seen.some((q) => q.path === '/v1/cloud/pair'), '');
  chk('invite body shape {"invite": ...}', inviteReqs[0] && JSON.parse(inviteReqs[0].body || '{}').invite === INVITE, inviteReqs[0] && inviteReqs[0].body);
  chk('invite never printed', !(r.stdout + r.stderr).includes('fixturesecret123'), '');
  chk('paired confirmation printed', /paired \(gateway gw_fixture\)/.test(r.stdout), '');
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(fail);
})().catch((e) => { console.error(e); process.exit(2); });
