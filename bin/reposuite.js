#!/usr/bin/env node
/*
 * reposuite — npm launcher ONLY.
 * The canonical CLI is the native `reposuite` Rust binary in the platform
 * package. This wrapper resolves that binary and forwards argv, stdio,
 * signals and the exit status. It implements no product logic.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function resolveBinary() {
  const plat = `linux-${process.arch}`;
  const candidates = [
    path.join(__dirname, '..', '..', '@reposuite', plat, 'bin', 'reposuite'), // hoisted sibling
    path.join(__dirname, '..', 'node_modules', '@reposuite', plat, 'bin', 'reposuite'),
    path.join(__dirname, '..', 'vendor', plat, 'reposuite'),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  console.error('reposuite: native CLI not found — is @reposuite/' + plat + ' installed?');
  process.exit(1);
}

const bin = resolveBinary();
const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit' });

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(sig, () => { try { child.kill(sig); } catch {} });
}
child.on('error', err => { console.error('reposuite: failed to launch native CLI:', err.message); process.exit(1); });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code === null ? 1 : code);
});
