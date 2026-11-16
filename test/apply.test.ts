import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, rollback, type ApplyStep } from '../src/apply.js';
import { bootGuard, confirmApply } from '../src/boot-guard.js';

function setup(t: any, checkout = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-apply-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root');
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(root, 'dist', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, 'dist', 'marker.js'), 'old build\n');
  fs.writeFileSync(path.join(root, 'dist', 'nested', 'deep.js'), Buffer.from([0, 1, 2, 255]));
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'dep\n');
  if (checkout) {
    fs.mkdirSync(path.join(root, 'src', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'source\n');
    fs.writeFileSync(path.join(root, 'src', 'dist', 'keep.ts'), 'nested dist\n');
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  }
  const steps: string[] = [];
  const cwds: string[] = [];
  let restarts = 0;
  const run =
    (fail?: string) =>
    (step: ApplyStep, cwd: string): number => {
      assert.notEqual(cwd, root);
      cwds.push(cwd);
      steps.push(step.name);
      // The copy holds sources and a linked node_modules, never the live build or state.
      assert.equal(fs.readFileSync(path.join(cwd, 'src', 'main.ts'), 'utf8'), 'source\n');
      assert.equal(
        fs.readFileSync(path.join(cwd, 'src', 'dist', 'keep.ts'), 'utf8'),
        'nested dist\n',
      );
      assert.equal(
        fs.realpathSync(path.join(cwd, 'node_modules')),
        fs.realpathSync(path.join(root, 'node_modules')),
      );
      assert.equal(fs.existsSync(path.join(cwd, 'runtime')), false);
      assert.equal(fs.existsSync(path.join(cwd, '.git')), false);
      if (step.name === 'typecheck') assert.equal(fs.existsSync(path.join(cwd, 'dist')), false);
      fs.mkdirSync(path.join(cwd, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'dist', 'marker.js'), 'new build\n');
      fs.writeFileSync(path.join(cwd, 'dist', 'added.js'), 'added\n');
      return step.name === fail ? 1 : 0;
    };
  const requestRestart = (h: string) => {
    assert.equal(h, home);
    restarts++;
  };
  const snapshot = (d: string) =>
    Object.fromEntries(
      (fs.readdirSync(d, { recursive: true }) as string[])
        .sort()
        .map((f) => [
          f,
          fs.statSync(path.join(d, f)).isFile()
            ? fs.readFileSync(path.join(d, f)).toString('hex')
            : 'dir',
        ]),
    );
  const pending = () => JSON.parse(fs.readFileSync(path.join(home, 'apply-pending.json'), 'utf8'));
  const last = () => JSON.parse(fs.readFileSync(path.join(home, 'apply-last.json'), 'utf8'));
  const exists = (...p: string[]) => fs.existsSync(path.join(...p));
  return {
    root,
    home,
    steps,
    cwds,
    run,
    requestRestart,
    restarts: () => restarts,
    snapshot,
    pending,
    last,
    exists,
  };
}

const newBuild = {
  'added.js': Buffer.from('added\n').toString('hex'),
  'marker.js': Buffer.from('new build\n').toString('hex'),
};

function applyOk(f: ReturnType<typeof setup>) {
  assert.equal(
    apply({ root: f.root, home: f.home, run: f.run(), requestRestart: f.requestRestart }),
    0,
  );
}

test('apply refuses an install without sources', (t) => {
  const f = setup(t, false);
  const code = apply({
    root: f.root,
    home: f.home,
    run: f.run(),
    requestRestart: f.requestRestart,
  });
  assert.equal(code, 1);
  assert.deepEqual(f.steps, []);
  assert.equal(f.exists(f.root, 'dist.next'), false);
  assert.equal(f.restarts(), 0);
});

test('apply refuses while a previous change is pending', (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.home, 'apply-pending.json'), '{"attempts":0}');
  const code = apply({
    root: f.root,
    home: f.home,
    run: f.run(),
    requestRestart: f.requestRestart,
  });
  assert.equal(code, 1);
  assert.deepEqual(f.steps, []);
  assert.equal(f.exists(f.root, 'dist.next'), false);
  assert.equal(f.restarts(), 0);
});

test('a failing step leaves the live build untouched, stages nothing and removes the copy', (t) => {
  const f = setup(t);
  const before = f.snapshot(f.root);
  const code = apply({
    root: f.root,
    home: f.home,
    run: f.run('build'),
    requestRestart: f.requestRestart,
  });
  assert.equal(code, 1);
  assert.deepEqual(f.steps, ['typecheck', 'build check', 'build']);
  assert.deepEqual(f.snapshot(f.root), before);
  assert.equal(f.exists(f.root, 'dist.next'), false);
  assert.equal(f.exists(f.home, 'apply-pending.json'), false);
  assert.equal(fs.existsSync(f.cwds[0]!), false);
  assert.equal(f.restarts(), 0);
});

test('passing steps stage dist.next, keep the live build and request one restart', (t) => {
  const f = setup(t);
  const before = f.snapshot(path.join(f.root, 'dist'));
  const code = apply({
    root: f.root,
    home: f.home,
    run: f.run(),
    requestRestart: f.requestRestart,
    now: () => 1234,
  });
  assert.equal(code, 0);
  assert.deepEqual(f.steps, ['typecheck', 'build check', 'build', 'test']);
  assert.equal(new Set(f.cwds).size, 1);
  assert.equal(fs.existsSync(f.cwds[0]!), false);
  assert.deepEqual(f.snapshot(path.join(f.root, 'dist')), before);
  assert.deepEqual(f.snapshot(path.join(f.root, 'dist.next')), newBuild);
  assert.equal(f.exists(f.root, 'dist.prev'), false);
  const pending = f.pending();
  assert.equal(pending.appliedAt, 1234);
  assert.equal(pending.attempts, 0);
  assert.equal(pending.swapped, false);
  assert.equal(pending.root, f.root);
  assert.ok('commit' in pending);
  assert.equal(f.restarts(), 1);
});

test('apply without tests skips the test step', (t) => {
  const f = setup(t);
  const code = apply({
    root: f.root,
    home: f.home,
    test: false,
    run: f.run(),
    requestRestart: f.requestRestart,
  });
  assert.equal(code, 0);
  assert.deepEqual(f.steps, ['typecheck', 'build check', 'build']);
});

test('apply still records the change when the daemon cannot take a restart request', (t) => {
  const f = setup(t);
  const code = apply({
    root: f.root,
    home: f.home,
    run: f.run(),
    requestRestart: () => {
      throw new Error('Coordinated restart needs supervision.');
    },
  });
  assert.equal(code, 0);
  assert.equal(f.pending().swapped, false);
  assert.ok(f.exists(f.root, 'dist.next'));
});

test('boot guard swaps in the staged build, counts starts and rolls back after maxAttempts', (t) => {
  const f = setup(t);
  const old = f.snapshot(path.join(f.root, 'dist'));
  applyOk(f);
  const guard = () => bootGuard({ home: f.home, root: f.root, maxAttempts: 3, now: () => 7 });
  assert.equal(guard(), 'swapped');
  assert.deepEqual(f.snapshot(path.join(f.root, 'dist')), newBuild);
  assert.deepEqual(f.snapshot(path.join(f.root, 'dist.prev')), old);
  assert.equal(f.exists(f.root, 'dist.next'), false);
  assert.equal(f.pending().attempts, 1);
  assert.equal(f.pending().swapped, true);
  assert.equal(guard(), 'counted');
  assert.equal(guard(), 'counted');
  assert.equal(f.pending().attempts, 3);
  assert.equal(guard(), 'rolled-back');
  assert.deepEqual(f.snapshot(path.join(f.root, 'dist')), old);
  assert.deepEqual(f.snapshot(path.join(f.root, 'dist.failed')), newBuild);
  assert.equal(f.exists(f.root, 'dist.prev'), false);
  assert.equal(f.exists(f.home, 'apply-pending.json'), false);
  assert.equal(f.last().rolledBackAt, 7);
  assert.equal(f.last().reason, 'did not start after 3 attempts');
  assert.equal(guard(), 'none');
});

test('boot guard drops a pending change whose staged build is missing', (t) => {
  const f = setup(t);
  applyOk(f);
  fs.rmSync(path.join(f.root, 'dist.next'), { recursive: true });
  const before = f.snapshot(path.join(f.root, 'dist'));
  assert.equal(bootGuard({ home: f.home, root: f.root }), 'none');
  assert.equal(f.exists(f.home, 'apply-pending.json'), false);
  assert.deepEqual(f.snapshot(path.join(f.root, 'dist')), before);
});

test('boot guard without a pending change does nothing', (t) => {
  const f = setup(t);
  const before = f.snapshot(f.root);
  assert.equal(bootGuard({ home: f.home, root: f.root }), 'none');
  assert.deepEqual(f.snapshot(f.root), before);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('a torn pending record counts toward rollback and never swaps', (t) => {
  const f = setup(t);
  applyOk(f);
  bootGuard({ home: f.home, root: f.root });
  fs.mkdirSync(path.join(f.root, 'dist.next'));
  fs.writeFileSync(path.join(f.home, 'apply-pending.json'), '{"swa');
  assert.equal(bootGuard({ home: f.home, root: f.root }), 'counted');
  assert.deepEqual(f.snapshot(path.join(f.root, 'dist')), newBuild);
  assert.ok(f.exists(f.root, 'dist.next'));
});

test('confirmApply ignores an unswapped change and confirms a swapped one', (t) => {
  const f = setup(t);
  applyOk(f);
  assert.equal(confirmApply(f.home, 5), false);
  assert.equal(f.pending().swapped, false);
  assert.equal(f.exists(f.home, 'apply-last.json'), false);
  assert.equal(bootGuard({ home: f.home, root: f.root }), 'swapped');
  assert.equal(confirmApply(f.home, 5), true);
  assert.equal(f.exists(f.home, 'apply-pending.json'), false);
  assert.equal(f.last().confirmedAt, 5);
  assert.equal(confirmApply(f.home), false);
});

test('rollback before the swap discards the staged build without a restart', (t) => {
  const f = setup(t);
  const old = f.snapshot(path.join(f.root, 'dist'));
  applyOk(f);
  const code = rollback({
    root: f.root,
    home: f.home,
    requestRestart: f.requestRestart,
    now: () => 42,
  });
  assert.equal(code, 0);
  assert.equal(f.exists(f.root, 'dist.next'), false);
  assert.deepEqual(f.snapshot(path.join(f.root, 'dist')), old);
  assert.equal(f.exists(f.home, 'apply-pending.json'), false);
  assert.equal(f.last().rolledBackAt, 42);
  assert.equal(f.last().reason, 'manual');
  assert.equal(f.restarts(), 1);
});

test('rollback after the swap restores the previous build and requests a restart', (t) => {
  const f = setup(t);
  const old = f.snapshot(path.join(f.root, 'dist'));
  applyOk(f);
  assert.equal(bootGuard({ home: f.home, root: f.root }), 'swapped');
  const code = rollback({
    root: f.root,
    home: f.home,
    requestRestart: f.requestRestart,
    now: () => 99,
  });
  assert.equal(code, 0);
  assert.deepEqual(f.snapshot(path.join(f.root, 'dist')), old);
  assert.deepEqual(f.snapshot(path.join(f.root, 'dist.failed')), newBuild);
  assert.equal(f.exists(f.root, 'dist.prev'), false);
  assert.equal(f.exists(f.home, 'apply-pending.json'), false);
  assert.equal(f.last().rolledBackAt, 99);
  assert.equal(f.last().reason, 'manual');
  assert.equal(f.restarts(), 2);
});

test('rollback with nothing to roll back refuses', (t) => {
  const f = setup(t);
  assert.equal(rollback({ root: f.root, home: f.home, requestRestart: f.requestRestart }), 1);
  assert.equal(f.restarts(), 0);
});
