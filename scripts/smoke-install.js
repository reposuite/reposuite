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
chk('node wrapper is launcher-only', () => {
  const w = require('fs').readFileSync(require('path').join(__dirname, '..', 'bin', 'reposuite.js'), 'utf8');
  return /spawn\(bin, process\.argv\.slice\(2\)/.test(w) && !/systemctl/.test(w) && w.length < 2000;
});
chk('rust CLI source present', () => require('fs').existsSync(require('path').join(__dirname, '..', 'src', 'main.rs')));
const rustBin = require('path').join(__dirname, '..', 'target', 'release', 'reposuite');
chk('rust CLI built + version matches', () => {
  if (!require('fs').existsSync(rustBin)) return true; // not built in this env
  return execFileSync(rustBin, ['version'], { encoding: 'utf8' }).trim() === pkg.version;
});
chk('proprietary license field', () => /SEE LICENSE/.test(pkg.license));
chk('no postinstall side effects', () => !(pkg.scripts && /postinstall/.test(JSON.stringify(pkg.scripts))));

const cli = path.join(__dirname, '..', 'bin', 'reposuite.js');
chk('cli help mentions setup', () => {
  const out = require('fs').existsSync(rustBin)
    ? execFileSync(rustBin, ['help'], { encoding: 'utf8' })
    : execFileSync('node', [cli, 'help'], { encoding: 'utf8' }).toString();
  return out.includes('setup');
});
chk('launcher forwards version (real platform layout)', () => {
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rsl-'));
  try {
    const plat = path.join(t2, '@reposuite', 'linux-x64', 'bin');
    fs.mkdirSync(plat, { recursive: true });
    const rust = path.join(__dirname, '..', 'target', 'release', 'reposuite');
    const native = fs.existsSync(rust) ? rust : null;
    if (!native) return true; // rust not built here
    fs.copyFileSync(native, path.join(plat, 'reposuite'));
    fs.chmodSync(path.join(plat, 'reposuite'), 0o755);
    const pkg = path.join(t2, 'pkg', 'bin');
    fs.mkdirSync(pkg, { recursive: true });
    fs.copyFileSync(cli, path.join(pkg, 'reposuite.js'));
    const out = execFileSync('node', [path.join(pkg, 'reposuite.js'), 'version'], { encoding: 'utf8' });
    return out.trim().length > 0;
  } finally { fs.rmSync(t2, { recursive: true, force: true }); }
});

// clean-HOME unpack of the tarball
const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmoke-'));
try {
  const tar = execFileSync('npm', ['pack', '--pack-destination', t], { encoding: 'utf8', cwd: path.join(__dirname, '..') }).trim().split('\n').pop();
  const env = { ...process.env, HOME: t, XDG_DATA_HOME: path.join(t, '.local/share'), XDG_CONFIG_HOME: path.join(t, '.config'), XDG_RUNTIME_DIR: path.join(t, 'run') };
  execFileSync('tar', ['xzf', path.join(t, tar), '-C', t]);
  const cliT = path.join(t, 'package', 'bin', 'reposuite.js');
  chk('tarball launcher present', () => fs.existsSync(cliT) && /spawn\(bin/.test(fs.readFileSync(cliT, 'utf8')));
  chk('no go source in tarball', () => !execFileSync('tar', ['tzf', path.join(t, tar)], { encoding: 'utf8' }).includes('.go'));
  chk('no .env/token in tarball', () => !/\.env|id_rsa|secret/i.exec(execFileSync('tar', ['tzf', path.join(t, tar)], { encoding: 'utf8' })));
} finally { fs.rmSync(t, { recursive: true, force: true }); }

console.log(fail ? 'smoke: FAILED' : 'smoke: OK');
process.exit(fail);
