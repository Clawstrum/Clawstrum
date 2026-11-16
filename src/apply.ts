import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  lastFile,
  pendingFile,
  readPending,
  swapToPrevious,
  writeApplyJson,
  type ApplyPending,
} from './boot-guard.js';
import { Store } from './store.js';
import { storagePolicy } from './storage.js';
import { requestRestart as requestStoreRestart } from './restart.js';

export interface ApplyStep {
  name: string;
  args: string[];
}
/** Returns the exit status of `process.execPath ...args` run in root (the temp build copy). */
export type StepRunner = (step: ApplyStep, root: string) => number;
/** Throws when the daemon cannot take a coordinated restart (unsupervised, not running). */
export type RestartRequester = (home: string) => void;

export function packageRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}
export function isSourceCheckout(root: string): boolean {
  return fs.existsSync(path.join(root, 'src')) && fs.existsSync(path.join(root, 'tsconfig.json'));
}

// Mirrors package.json typecheck, prebuild, build and test. npm's pretest would build again.
export function applySteps(test: boolean): ApplyStep[] {
  return [
    { name: 'typecheck', args: ['node_modules/typescript/bin/tsc', '--noEmit'] },
    { name: 'build check', args: ['scripts/check-build.mjs'] },
    { name: 'build', args: ['node_modules/typescript/bin/tsc'] },
    ...(test ? [{ name: 'test', args: ['scripts/test.mjs'] }] : []),
  ];
}

export const runStep: StepRunner = (step, root) => {
  const child = spawnSync(process.execPath, step.args, { cwd: root, stdio: 'inherit' });
  if (child.error) console.error(child.error.message);
  return child.status ?? 1;
};

export const daemonRestart: RestartRequester = (home) => {
  if (!fs.existsSync(path.join(storagePolicy(home).directory, 'clawstrum.db')))
    throw new Error('Clawstrum state database is missing');
  const store = new Store(home);
  try {
    requestStoreRestart(store);
  } finally {
    store.close();
  }
};

const SKIP_TOP_LEVEL = new Set([
  'node_modules',
  'dist',
  'dist.prev',
  'dist.next',
  'dist.failed',
  'runtime',
  '.git',
]);

function gitCommit(root: string): string | null {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return git.status === 0 ? git.stdout.trim() || null : null;
}

function restartOrAdvise(home: string, requestRestart: RestartRequester): void {
  try {
    requestRestart(home);
    console.log('Restart requested; Clawstrum restarts on the new code once current work is done.');
  } catch (error) {
    console.log(`restart Clawstrum to load the change (${(error as Error).message})`);
  }
}

export function apply({
  root = packageRoot(),
  home,
  test = true,
  run = runStep,
  requestRestart = daemonRestart,
  now = Date.now,
}: {
  root?: string;
  home: string;
  test?: boolean;
  run?: StepRunner;
  requestRestart?: RestartRequester;
  now?: () => number;
}): number {
  if (!isSourceCheckout(root)) {
    console.error(
      "this install has only compiled code; install from a git checkout to change Clawstrum's code",
    );
    return 1;
  }
  if (fs.existsSync(pendingFile(home))) {
    console.error(
      'the previous change is not live and confirmed yet; restart Clawstrum, or run clawstrum rollback',
    );
    return 1;
  }
  // Build in a copy: the running daemon forks workers from root/dist, and check-build
  // refuses to rebuild a dist a live daemon uses.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-apply-'));
  const top = path.resolve(root);
  try {
    fs.cpSync(top, tmp, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => path.dirname(src) !== top || !SKIP_TOP_LEVEL.has(path.basename(src)),
    });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'));
    for (const step of applySteps(test)) {
      if (run(step, tmp) === 0) continue;
      console.error(`${step.name} failed; nothing was applied and the running build is unchanged.`);
      return 1;
    }
    const next = path.join(root, 'dist.next');
    fs.rmSync(next, { recursive: true, force: true });
    // Copy, not rename: the temp dir may be on another filesystem.
    fs.cpSync(path.join(tmp, 'dist'), next, { recursive: true, verbatimSymlinks: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const pending: ApplyPending = {
    appliedAt: now(),
    attempts: 0,
    commit: gitCommit(root),
    root,
    swapped: false,
  };
  writeApplyJson(pendingFile(home), pending);
  restartOrAdvise(home, requestRestart);
  return 0;
}

export function rollback({
  root = packageRoot(),
  home,
  requestRestart = daemonRestart,
  now = Date.now,
}: {
  root?: string;
  home: string;
  requestRestart?: RestartRequester;
  now?: () => number;
}): number {
  const pending = readPending(home);
  if (pending && !pending.swapped) {
    fs.rmSync(path.join(root, 'dist.next'), { recursive: true, force: true });
    fs.rmSync(pendingFile(home), { force: true });
    writeApplyJson(lastFile(home), {
      rolledBackAt: now(),
      reason: 'manual',
      commit: pending.commit ?? null,
    });
    console.log('Discarded the change that was waiting for a restart.');
    return 0;
  }
  if (!fs.existsSync(path.join(root, 'dist.prev'))) {
    console.error(`nothing to roll back: ${path.join(root, 'dist.prev')} does not exist`);
    return 1;
  }
  let commit = pending?.commit ?? null;
  if (!pending)
    try {
      commit = JSON.parse(fs.readFileSync(lastFile(home), 'utf8')).commit ?? null;
    } catch {
      // No record of the change being rolled back.
    }
  swapToPrevious(root);
  fs.rmSync(pendingFile(home), { force: true });
  writeApplyJson(lastFile(home), { rolledBackAt: now(), reason: 'manual', commit });
  console.log('Restored the build from before the last apply.');
  restartOrAdvise(home, requestRestart);
  return 0;
}
