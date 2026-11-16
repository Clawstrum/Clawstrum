// Runs before cli-main is imported, so it must stay free of dependencies like cli.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ApplyPending {
  appliedAt: number;
  attempts: number;
  commit: string | null;
  root: string;
  swapped: boolean;
}

export function guardHome(): string {
  const value = process.env.CLAWSTRUM_HOME || '~/.clawstrum';
  return path.resolve(
    value === '~'
      ? os.homedir()
      : value.startsWith('~/')
        ? path.join(os.homedir(), value.slice(2))
        : value,
  );
}

export const pendingFile = (home: string) => path.join(home, 'apply-pending.json');
export const lastFile = (home: string) => path.join(home, 'apply-last.json');

export function readPending(home: string): ApplyPending | undefined {
  let text: string;
  try {
    text = fs.readFileSync(pendingFile(home), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object') return value;
  } catch {
    // A torn write still marks an unconfirmed change: count attempts from zero so it can
    // roll back, but never treat it as a staged build to swap in.
  }
  return { appliedAt: 0, attempts: 0, commit: null, root: '', swapped: true };
}

export function writeApplyJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** dist -> dist.failed, dist.prev -> dist. */
export function swapToPrevious(root: string): void {
  const dist = path.join(root, 'dist');
  const failed = path.join(root, 'dist.failed');
  fs.rmSync(failed, { recursive: true, force: true });
  if (fs.existsSync(dist)) fs.renameSync(dist, failed);
  fs.renameSync(path.join(root, 'dist.prev'), dist);
}

export function bootGuard({
  home = guardHome(),
  root = fileURLToPath(new URL('..', import.meta.url)),
  maxAttempts = 3,
  now = Date.now,
}: { home?: string; root?: string; maxAttempts?: number; now?: () => number } = {}):
  | 'none'
  | 'swapped'
  | 'counted'
  | 'rolled-back' {
  const pending = readPending(home);
  if (!pending) return 'none';
  if (!pending.swapped) {
    const dist = path.join(root, 'dist');
    const next = path.join(root, 'dist.next');
    if (!fs.existsSync(next)) {
      fs.rmSync(pendingFile(home), { force: true });
      return 'none';
    }
    const prev = path.join(root, 'dist.prev');
    fs.rmSync(prev, { recursive: true, force: true });
    if (fs.existsSync(dist)) fs.renameSync(dist, prev);
    fs.renameSync(next, dist);
    pending.swapped = true;
    pending.attempts = 1;
    writeApplyJson(pendingFile(home), pending);
    return 'swapped';
  }
  pending.attempts = (Number(pending.attempts) || 0) + 1;
  writeApplyJson(pendingFile(home), pending);
  if (pending.attempts <= maxAttempts || !fs.existsSync(path.join(root, 'dist.prev')))
    return 'counted';
  swapToPrevious(root);
  fs.rmSync(pendingFile(home), { force: true });
  writeApplyJson(lastFile(home), {
    rolledBackAt: now(),
    reason: `did not start after ${maxAttempts} attempts`,
    commit: pending.commit ?? null,
  });
  return 'rolled-back';
}

/** The daemon ran long enough: the applied change is healthy. */
export function confirmApply(home: string, now = Date.now()): boolean {
  const pending = readPending(home);
  // A daemon started before the swap never loaded the change, so it cannot vouch for it.
  if (!pending?.swapped) return false;
  fs.rmSync(pendingFile(home), { force: true });
  writeApplyJson(lastFile(home), { confirmedAt: now, commit: pending.commit ?? null });
  return true;
}
