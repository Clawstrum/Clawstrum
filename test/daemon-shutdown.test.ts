import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('daemon CLI exits after cleanup despite leftover SDK handles, preserving exit codes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-exit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(new URL('../src/cli.ts', import.meta.url), path.join(dir, 'cli.mjs'));
  fs.writeFileSync(
    path.join(dir, 'boot-guard.js'),
    "export function bootGuard() { return 'none'; }",
  );
  for (const code of [0, 1, 75]) {
    fs.writeFileSync(
      path.join(dir, 'cli-main.js'),
      `
      import fs from 'node:fs';
      export async function main() {
        setInterval(() => {}, 1000);
        try {
          if (${code} === 1) throw new Error('synthetic gateway failure');
          process.exitCode = ${code};
        } finally { fs.writeFileSync('cleanup', 'done'); }
      }
    `,
    );
    const child = spawnSync(process.execPath, ['cli.mjs', 'start'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, code, child.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'cleanup'), 'utf8'), 'done');
    fs.unlinkSync(path.join(dir, 'cleanup'));
  }
});

test('shutdown deadline terminates stuck cleanup but clears after completion or rejection', () => {
  const url = new URL('../src/daemon-shutdown.ts', import.meta.url).href;
  for (const outcome of ['stuck', 'done', 'rejected']) {
    const script = `
      import {withShutdownDeadline} from ${JSON.stringify(url)};
      try {
        await withShutdownDeadline(async () => {
          if (${JSON.stringify(outcome)} === 'stuck') await new Promise(() => {});
          if (${JSON.stringify(outcome)} === 'rejected') throw new Error('cleanup error');
        }, 30);
      } catch {}
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, outcome === 'stuck' ? 1 : 0, child.stderr);
    assert.equal(child.stderr.includes('daemon_shutdown_timeout'), outcome === 'stuck');
  }
});
