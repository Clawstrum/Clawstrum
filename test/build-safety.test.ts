import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.js';
import { acquireLock } from '../src/lock.js';
import { Store } from '../src/store.js';

function buildFixture(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-build-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.writeFileSync(path.join(root, 'dist/cli.js'), 'ORIGINAL');
  fs.copyFileSync(
    new URL('../scripts/check-build.mjs', import.meta.url),
    path.join(root, 'check.mjs'),
  );
  fs.writeFileSync(
    path.join(root, 'compiler.mjs'),
    "import fs from 'node:fs';fs.writeFileSync('dist/cli.js','REPLACED');",
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      scripts: {
        prebuild: 'node check.mjs',
        build: 'node compiler.mjs',
        pretest: 'npm run build',
        test: 'node -e "process.exit(0)"',
      },
    }),
  );
  const owner = (extra = {}, home = path.join(root, 'runtime')) => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'daemon.lock'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), ...extra }),
    );
  };
  const check = (home = path.join(root, 'unused')) =>
    spawnSync(process.execPath, ['check.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CLAWSTRUM_HOME: home },
    });
  return { root, owner, check };
}

test('npm build and npm test cannot overwrite a live colocated build, including legacy ownership', (t) => {
  const f = buildFixture(t);
  f.owner();
  for (const command of ['build', 'test']) {
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', command], {
      cwd: f.root,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, CLAWSTRUM_HOME: path.join(f.root, 'unused') },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /running Clawstrum daemon/);
    assert.equal(fs.readFileSync(path.join(f.root, 'dist/cli.js'), 'utf8'), 'ORIGINAL');
  }
});

test('custom state protects its declared build but permits an isolated checkout with inherited environment', (t) => {
  const live = buildFixture(t),
    isolated = buildFixture(t);
  const home = path.join(live.root, 'custom-state');
  live.owner({ entrypoint: path.join(live.root, 'dist/cli.js') }, home);
  assert.notEqual(live.check(home).status, 0);
  assert.equal(isolated.check(home).status, 0);
  if (process.platform !== 'win32') {
    const launcher = path.join(live.root, 'clawstrum');
    fs.symlinkSync(path.join(live.root, 'dist/cli.js'), launcher);
    live.owner({ entrypoint: launcher }, home);
    assert.notEqual(live.check(home).status, 0);
  }
});

test('a remote owner protects shared build files; a confirmed stopped local owner does not', (t) => {
  const f = buildFixture(t);
  f.owner({ host: 'another-owner-host', entrypoint: path.join(f.root, 'dist/cli.js') });
  assert.notEqual(f.check().status, 0);
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
  assert.equal(child.status, 0);
  f.owner({ pid: child.pid });
  assert.equal(f.check().status, 0);
});

test('schema mismatch explains the needed deployment without changing live schema or sessions', (t) => {
  const f = fixture(t);
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'native-preserved', f.session.id);
  f.store.db.exec(
    'ALTER TABLE sessions DROP COLUMN active_model; UPDATE schema_version SET version=5',
  );
  const release = acquireLock(f.home);
  try {
    assert.throws(() => new Store(f.home), /schema 5 needs upgrade to 6.*running daemon/);
    assert.equal(
      f.store.get<{ version: number }>('SELECT version FROM schema_version')?.version,
      5,
    );
    assert.equal(f.store.session(f.session.id).remote_id, 'native-preserved');
  } finally {
    release();
  }
});
