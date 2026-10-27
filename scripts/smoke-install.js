// Local packaging smoke: verifies package metadata, the CLI contract and a
// simulated clean-HOME install of the tarball (no real npm publish needed).
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let fail = 0;
const chk = (n, f) => { let r = false; try { r = !!f(); } catch {} console.log(` ${r ? ' ok ' : 'FAIL'} ${n}`); if (!r) fail = 1; };

const pkg = require('../package.json');
chk('name=reposuite', () => pkg.name === 'reposuite');
chk('bin wired', () => pkg.bin && pkg.bin.reposuite === 'bin/reposuite.js');
chk('engines node>=18', () => (pkg.engines && pkg.engines.node) === '>=18');
chk('platform package declared', () => pkg.optionalDependencies && pkg.optionalDependencies['@reposuite/linux-x64']);
chk('proprietary license field', () => /SEE LICENSE/.test(pkg.license));
chk('no postinstall side effects', () => !(pkg.scripts && /postinstall/.test(JSON.stringify(pkg.scripts))));

const cli = path.join(__dirname, '..', 'bin', 'reposuite.js');
chk('cli parses --help', () => execFileSync('node', [cli, 'help'], { encoding: 'utf8' }).includes('setup'));
chk('cli version', () => execFileSync('node', [cli, 'version'], { encoding: 'utf8' }).trim().length > 0);

// clean-HOME unpack of the tarball
const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmoke-'));
try {
  const tar = execFileSync('npm', ['pack', '--pack-destination', t], { encoding: 'utf8', cwd: path.join(__dirname, '..') }).trim().split('\n').pop();
  const env = { ...process.env, HOME: t, XDG_DATA_HOME: path.join(t, '.local/share'), XDG_CONFIG_HOME: path.join(t, '.config'), XDG_RUNTIME_DIR: path.join(t, 'run') };
  execFileSync('tar', ['xzf', path.join(t, tar), '-C', t]);
  const cliT = path.join(t, 'package', 'bin', 'reposuite.js');
  chk('tarball cli runnable', () => execFileSync('node', [cliT, 'version'], { env, encoding: 'utf8' }).trim().length > 0);
  chk('no go source in tarball', () => !execFileSync('tar', ['tzf', path.join(t, tar)], { encoding: 'utf8' }).includes('.go'));
  chk('no .env/token in tarball', () => !/\.env|id_rsa|secret/i.exec(execFileSync('tar', ['tzf', path.join(t, tar)], { encoding: 'utf8' })));
} finally { fs.rmSync(t, { recursive: true, force: true }); }

console.log(fail ? 'smoke: FAILED' : 'smoke: OK');
process.exit(fail);
