import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { canonicalPath } from '../config.js';
import type { Store } from '../store.js';

/**
 * Same-file collision protection between running subagents (the code calls them workers).
 *
 * The first running subagent to edit a file through a native edit tool holds that file until it
 * ends; another running subagent's native edit of the same file is refused, naming the holder. The
 * lead is never held. Shell edits cannot be checked before they run, so at the end of each subagent
 * the completion wake lists the files it changed and flags any that another subagent changed while
 * both were running. Holds and the changed-file record are rows in SQLite, so they survive a
 * restart; a hold counts only while its holder's delegation is still running.
 */

/** Native edit tools whose target is a path this hook can resolve. */
export const HOLD_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** The same canonical form writeScopesOverlap compares: symlinks resolved, relative paths made absolute. */
export function holdPath(target: string, cwd: string): string {
  const absolute = path.resolve(cwd, target);
  try {
    return canonicalPath(absolute);
  } catch {
    return absolute;
  }
}

export function nativeEditTarget(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): string | undefined {
  const value = input[HOLD_TOOLS[tool] ?? ''];
  return typeof value === 'string' && value ? holdPath(value, cwd) : undefined;
}

export interface FileHolder {
  path: string;
  holder: string;
  role: string;
  acquiredAt: number;
}

function role(specJson: string | null): string {
  try {
    return String(JSON.parse(specJson ?? '{}').role ?? 'unknown role');
  } catch {
    return 'unknown role';
  }
}

/**
 * Take the hold on `file` for `delegationId`, or return the other running subagent that holds it.
 * A hold whose holder is no longer running is stale and is replaced. A subagent that is itself no
 * longer running takes nothing and is refused nothing.
 */
export function acquireFileHold(
  store: Store,
  delegationId: string,
  file: string,
  now = Date.now(),
): FileHolder | undefined {
  return store.transaction(() => {
    const self = store.get<{ status: string }>(
      'SELECT status FROM delegations WHERE id=?',
      delegationId,
    );
    if (self?.status !== 'running') return undefined;
    const held = store.get<{
      delegation_id: string;
      acquired_at: number;
      status: string | null;
      spec_json: string | null;
    }>(
      'SELECT h.delegation_id,h.acquired_at,d.status,d.spec_json FROM worker_file_holds h LEFT JOIN delegations d ON d.id=h.delegation_id WHERE h.path=?',
      file,
    );
    if (held?.delegation_id === delegationId) return undefined;
    if (held?.status === 'running')
      return {
        path: file,
        holder: held.delegation_id,
        role: role(held.spec_json),
        acquiredAt: held.acquired_at,
      };
    store.exec(
      'INSERT INTO worker_file_holds(path,delegation_id,acquired_at) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET delegation_id=excluded.delegation_id,acquired_at=excluded.acquired_at',
      file,
      delegationId,
      now,
    );
    return undefined;
  });
}

export function releaseFileHolds(store: Store, delegationId: string): void {
  store.exec('DELETE FROM worker_file_holds WHERE delegation_id=?', delegationId);
}

export function recordWorkerFile(
  store: Store,
  delegationId: string,
  file: string,
  source: 'edit' | 'codex' | 'git',
  now = Date.now(),
): void {
  store.exec(
    'INSERT INTO worker_files(delegation_id,path,source,first_at,last_at) VALUES(?,?,?,?,?) ON CONFLICT(delegation_id,path) DO UPDATE SET last_at=excluded.last_at',
    delegationId,
    file,
    source,
    now,
    now,
  );
}

export function holdRefusal(held: FileHolder, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - held.acquiredAt) / 60000));
  return `Refusing this edit: ${held.path} is held by subagent ${held.holder} (${held.role}), which edited it first ${minutes} min ago and is still running. Two subagents editing one file at the same time can overwrite each other's changes. The hold is released when that subagent completes, fails or is cancelled. You may wait and try again later, work on other files, or report the conflict to the lead in your result. The lead is not blocked by holds. Do not work around this refusal with a shell edit of the same file.`;
}

/** Sent to a Codex subagent after the fact, because its file changes cannot be refused in advance. */
export function holdNotice(held: FileHolder): string {
  return `Clawstrum file hold: you just changed ${held.path}, which subagent ${held.holder} (${held.role}) is holding because it edited the file first and is still running. Your change was already applied, so the two of you may have overwritten each other. Do not change this file again while that subagent runs. Name the file in your result so the lead can check it, or wait for the hold to be released.`;
}

const run = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}
function existingDir(target: string): string | undefined {
  for (let dir = target; ; dir = path.dirname(dir)) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* Keep walking up to the nearest directory that exists. */
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}
function within(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

/**
 * Files changed in the git repositories under a subagent's declared write paths since `since`:
 * paths named by commits whose committer date is at or after `since`, plus uncommitted paths
 * (tracked or untracked, not ignored) whose modification time is at or after `since`. Only paths
 * inside a declared write path are kept. Changes another process made in the same paths during the
 * window are included too; git cannot say who made them. Deletions in the working tree are not
 * reported. A repository whose git command fails or times out is skipped and named in `skipped`.
 */
export async function gitChangedFiles(
  writePaths: string[],
  since: number,
  limit = 500,
): Promise<{ files: string[]; skipped: string[] }> {
  const files = new Set<string>();
  const skipped: string[] = [];
  const scopes = writePaths.map((p) => holdPath(p, '/'));
  const roots = new Map<string, string[]>();
  for (const scope of scopes) {
    const dir = existingDir(scope);
    if (!dir) continue;
    let root: string;
    try {
      root = holdPath((await git(dir, ['rev-parse', '--show-toplevel'])).trim(), '/');
    } catch {
      continue; // Not a git repository: nothing cheap to compare.
    }
    roots.set(root, [...(roots.get(root) ?? []), scope]);
  }
  for (const [root, rootScopes] of roots) {
    const keep = (rel: string) => {
      const file = path.join(root, rel);
      if (rootScopes.some((scope) => within(scope, file))) files.add(file);
    };
    try {
      const log = await git(root, [
        'log',
        `--since=@${Math.floor(since / 1000)}`,
        '--name-only',
        '--pretty=format:',
        'HEAD',
      ]);
      for (const rel of log.split('\n')) if (rel.trim()) keep(rel.trim());
    } catch {
      /* A repository with no commits yet has no HEAD; the working tree check below still applies. */
    }
    try {
      const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      const entries = status.split('\0');
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        if (entry.length < 4) continue;
        const code = entry.slice(0, 2);
        const rel = entry.slice(3);
        if (code[0] === 'R' || code[0] === 'C') i++; // The next field is the rename source.
        try {
          if (fs.statSync(path.join(root, rel)).mtimeMs >= since) keep(rel);
        } catch {
          /* Deleted in the working tree: no time to compare, so not reported. */
        }
      }
    } catch {
      skipped.push(root);
    }
  }
  return { files: [...files].sort().slice(0, limit), skipped };
}

/**
 * The block added to a subagent's completion wake: the files it changed, and any of them another
 * subagent also changed while both were running.
 */
export function changedFilesReport(
  store: Store,
  delegationId: string,
  options: { now?: number; gitScopes?: number; skipped?: string[]; shown?: number } = {},
): string {
  const now = options.now ?? Date.now();
  const shown = options.shown ?? 30;
  const self = store.get<{
    started_at: number | null;
    created_at: number;
    ended_at: number | null;
  }>('SELECT started_at,created_at,ended_at FROM delegations WHERE id=?', delegationId);
  if (!self) return '';
  const start = self.started_at ?? self.created_at;
  const end = self.ended_at ?? now;
  const files = store.all<{ path: string; source: string }>(
    'SELECT path,source FROM worker_files WHERE delegation_id=? ORDER BY path',
    delegationId,
  );
  const how = `native edit tools${options.gitScopes ? ', plus git changes in its declared write paths' : ''}; other shell edits are not seen`;
  if (!files.length) return `Files this subagent changed (${how}): none recorded.`;
  const lines = files
    .slice(0, shown)
    .map((f) => `- ${f.path}${f.source === 'git' ? ' (git)' : ''}`);
  if (files.length > shown) lines.push(`- and ${files.length - shown} more`);
  const overlaps = store.all<{ path: string; id: string; spec_json: string; status: string }>(
    `SELECT DISTINCT o.path, d.id, d.spec_json, d.status FROM worker_files m
       JOIN worker_files o ON o.path=m.path AND o.delegation_id<>m.delegation_id
       JOIN delegations d ON d.id=o.delegation_id
     WHERE m.delegation_id=? AND COALESCE(d.started_at,d.created_at)<=? AND COALESCE(d.ended_at,?)>=?
     ORDER BY o.path, d.id`,
    delegationId,
    end,
    now,
    start,
  );
  const flagged = overlaps.map(
    (o) =>
      `- ${o.path} was also changed by subagent ${o.id} (${role(o.spec_json)}, ${o.status}) while both were running. Check that neither overwrote the other.`,
  );
  return [
    `Files this subagent changed (${files.length}; ${how}):`,
    ...lines,
    ...(options.skipped?.length
      ? [`Git check skipped (command failed or timed out): ${options.skipped.join(', ')}`]
      : []),
    ...(flagged.length
      ? [`Changed by another subagent during this subagent's run:`, ...flagged]
      : []),
  ].join('\n');
}
