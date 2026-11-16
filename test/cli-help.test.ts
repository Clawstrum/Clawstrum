import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandHelp, main } from '../src/cli-main.js';

async function capture(fn: () => Promise<unknown>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return { out: out.join('\n'), err: err.join('\n') };
}

function emptyHome(t: TestContext): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-cli-'));
  const previous = process.env.CLAWSTRUM_HOME;
  process.env.CLAWSTRUM_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAWSTRUM_HOME;
    else process.env.CLAWSTRUM_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = 0;
  });
  return home;
}

test('--help lists --version', async () => {
  const { out } = await capture(() => main(['--help']));
  assert.match(out, /^clawstrum --version /m);
});

test('a command with --help prints its usage and never runs it', async (t) => {
  const home = emptyHome(t);
  const start = await capture(() => main(['start', '--help']));
  assert.equal(start.out, 'clawstrum start');
  assert.equal(start.err, '');
  assert.equal(process.exitCode ?? 0, 0);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal((await capture(() => main(['doctor', '-h']))).out, 'clawstrum doctor [--notify]');
});

test('help for one command keeps its continuation lines and its alternations', () => {
  assert.match(commandHelp('import'), /^clawstrum import nanoclaw .*\n {4}\[--timezone ZONE\]/);
  assert.match(commandHelp('resume'), /^clawstrum stop\|resume\|reset SESSION$/);
  assert.equal(commandHelp('service').split('\n').length, 3);
  assert.match(commandHelp('no-such-command'), /^Clawstrum 0\.1\.0/);
});

test('doctor without config.json reports one failed Config check as JSON', async (t) => {
  const home = emptyHome(t);
  const { out } = await capture(() => main(['doctor']));
  const report = JSON.parse(out) as { checks: { check: string; ok: boolean; detail: string }[] };
  assert.deepEqual(report.checks, [
    { check: 'Config', ok: false, detail: `No config.json in ${home}. Run clawstrum setup first.` },
  ]);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});

test('other commands without config.json say to run setup, without a stack trace', async (t) => {
  emptyHome(t);
  const { out, err } = await capture(() => main(['status']));
  assert.equal(out, '');
  assert.match(err, /^No config\.json in .*\. Run clawstrum setup first\.$/);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});
