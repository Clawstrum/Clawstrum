import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyShellCpuCap } from '../src/config.js';
import { accountEnvironment } from '../src/providers.js';
import { fixture } from './helpers.js';

const skip = process.platform === 'win32' ? 'bash shell prefix' : false;
const capScript = fileURLToPath(new URL('../scripts/cpu-cap.sh', import.meta.url));

function capped(command: string, env: NodeJS.ProcessEnv, seconds = 7) {
  return spawnSync('/bin/bash', [capScript, command], {
    env: { ...env, CLAWSTRUM_CPU_CAP_S: String(seconds) },
    encoding: 'utf8',
  });
}
// A directory with a fake sbatch that reports the CPU limit it runs under.
function fakeSlurm(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-cpucap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'sbatch'), '#!/bin/bash\nulimit -St\n', { mode: 0o755 });
  return { dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } };
}

test(
  'shell CPU cap is off by default and reaches provider environments when set',
  { skip },
  (t) => {
    const f = fixture(t);
    const env: NodeJS.ProcessEnv = { PATH: '/bin' };
    assert.equal(f.config.runtime.shellCpuSeconds, 0);
    applyShellCpuCap(f.config, env);
    assert.deepEqual(env, { PATH: '/bin' });
    f.config.runtime.shellCpuSeconds = 300;
    applyShellCpuCap(f.config, env);
    assert.equal(env.CLAUDE_CODE_SHELL_PREFIX, capScript);
    fs.accessSync(capScript, fs.constants.X_OK);
    const child = accountEnvironment(f.config.accounts[0]!, f.config.accounts, env);
    assert.equal(child.CLAUDE_CODE_SHELL_PREFIX, capScript);
    assert.equal(child.CLAWSTRUM_CPU_CAP_S, '300');
  },
);

test('agent commands run under the soft CPU limit', { skip }, () => {
  const r = capped('ulimit -St', process.env);
  assert.equal(r.stdout.trim(), '7');
});

test('a process over the limit is killed with a pointer to batch jobs', { skip }, () => {
  const r = capped('while :; do :; done', process.env, 1);
  assert.equal(r.status, 152);
  assert.match(r.stderr, /\[clawstrum\] killed: a process used more than 1 CPU-seconds/);
});

test('sbatch runs without the limit, also after a snapshot resets PATH', { skip }, (t) => {
  const slurm = fakeSlurm(t);
  assert.equal(capped('sbatch', slurm.env).stdout.trim(), 'unlimited');
  // The Claude CLI's command shape: source a shell snapshot that re-exports the session-start PATH.
  const snapshot = path.join(slurm.dir, 'snapshot.sh');
  fs.writeFileSync(snapshot, `export PATH='${slurm.env.PATH}'\n`);
  const r = capped(`source ${snapshot} 2>/dev/null || true && env sbatch`, slurm.env);
  assert.equal(r.stdout.trim(), 'unlimited', r.stderr);
});

test('the Clawstrum MCP server keeps the parent limit', { skip }, () => {
  const parent = spawnSync('/bin/bash', ['-c', 'ulimit -St'], { encoding: 'utf8' }).stdout.trim();
  const r = capped(`true /opt/clawstrum/dist/cli.js mcp; ulimit -St`, process.env);
  assert.equal(r.stdout.trim(), parent);
  assert.notEqual(r.stdout.trim(), '7');
});

test('a missing SLURM command fails plainly', { skip }, () => {
  const lift = fileURLToPath(new URL('../scripts/cpu-cap-lift.sh', import.meta.url));
  const r = spawnSync('/bin/bash', [lift, 'clawstrum-no-such-command'], { encoding: 'utf8' });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /clawstrum-no-such-command: not found on PATH/);
});
