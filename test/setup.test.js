'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function server(mode) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/pairing/begin') {
        res.end(JSON.stringify({ pair_id: 'p1', device_secret: 'secret-value',
          user_code: 'ABCD-EFGH', verification_url_complete: 'https://app.example/pair?r=p1', expires_in: 5 }));
      } else if (req.url === '/v1/pairing/poll') {
        if (mode === 'expired') return res.end(JSON.stringify({ status: 'expired' }));
        res.end(JSON.stringify({ status: 'authorized', invite_id: 'inv_test', invite_token: 'invite-secret' }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
}

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'reposuite.js'), ...args], {
      env: { ...process.env, REPOSUITE_POLL_MS: '10', ...env },
    });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('exit', (code) => resolve({ code, out, err }));
  });
}

test('code pairing stores invite privately and never prints device secret', async () => {
  const s = server('ok'); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reposuite-setup-'));
  const { port } = s.address();
  const r = await run(['setup', 'WRK', 'work-pc', '--auth-mode', 'code', '--json', '--no-start', '--server', `http://127.0.0.1:${port}`, '--state-dir', dir]);
  s.close();
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].verification_url, 'https://app.example/pair?r=p1');
  assert.equal(lines[0].code, 'ABCD-EFGH');
  assert.equal(lines[0].status, 'pending');
  assert.equal(lines[0].action_required, true);
  assert.doesNotMatch(r.out, /secret-value/);
  const invite = fs.readFileSync(path.join(dir, 'invite'), 'utf8').trim();
  assert.equal(invite, 'inv_test.invite-secret');
  assert.equal(fs.statSync(path.join(dir, 'invite')).mode & 0o777, 0o600);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'gateway.json'), 'utf8'));
  assert.equal(cfg.gateway, 'WRK');
  assert.equal(cfg.invite_file, path.join(dir, 'invite'));
  assert.doesNotMatch(JSON.stringify(cfg), /invite-secret/);
});

test('expired pairing fails and writes no invite', async () => {
  const s = server('expired'); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reposuite-setup-'));
  const { port } = s.address();
  const r = await run(['setup', 'WRK', 'work-pc', '--auth-mode', 'code', '--no-start', '--server', `http://127.0.0.1:${port}`, '--state-dir', dir]);
  s.close();
  assert.notEqual(r.code, 0);
  assert.equal(fs.existsSync(path.join(dir, 'invite')), false);
});

test('rejects a non-code auth mode', async () => {
  const r = await run(['setup', 'WRK', 'work-pc', '--auth-mode', 'password']);
  assert.equal(r.code, 2);
  assert.match(r.err, /auth-mode code/);
});

test('status and cancel use local authorized state only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reposuite-status-'));
  fs.writeFileSync(path.join(dir, 'gateway.json'), JSON.stringify({ gateway: 'WRK', label: 'work-pc', server: 'https://app.reposuite.com' }));
  fs.mkdirSync(path.join(dir, 'connector'));
  fs.writeFileSync(path.join(dir, 'connector', 'gateway.json'), '{}');
  const r = await run(['status', '--json', '--state-dir', dir]);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).online, true);
  fs.writeFileSync(path.join(dir, 'pending.json'), JSON.stringify({ pair_id: 'p', device_secret: 's', server: 'http://127.0.0.1:1' }));
  const c = await run(['setup', 'cancel', '--json', '--state-dir', dir]);
  assert.equal(c.code, 0, c.err);
  assert.equal(fs.existsSync(path.join(dir, 'pending.json')), false);
});
