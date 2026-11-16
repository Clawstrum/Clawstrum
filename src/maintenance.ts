import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { acquireLock } from './lock.js';
import { canonicalPath } from './config.js';
import { writePrivate } from './files.js';

/** Offline snapshot of harness-owned state. Refuses a live daemon or an existing target. */
export function backupState(store: Store, destination: string): string {
  const target = canonicalPath(path.resolve(destination));
  const source = fs.realpathSync(store.home);
  if (target === source || target.startsWith(source + path.sep))
    throw new Error('Backup destination must be outside the state directory');
  if (fs.existsSync(target)) throw new Error('Backup destination already exists');
  const unlock = acquireLock(store.home);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(store.home)) {
      if (
        /^(clawstrum\.db(?:-wal|-shm|-journal)?|daemon\.lock|daemon-lock\.db(?:-journal)?)$/.test(
          entry,
        )
      )
        continue;
      fs.cpSync(path.join(store.home, entry), path.join(temp, entry), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    const database = path.join(temp, 'clawstrum.db');
    store.exec('VACUUM INTO ?', database);
    fs.chmodSync(database, 0o600);
    writePrivate(
      path.join(temp, 'BACKUP.json'),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          source,
          scope:
            'State directory and SQLite snapshot. Symlink targets and account/workspace directories outside this tree are not copied. Quiesce external writers separately.',
        },
        null,
        2,
      ),
    );
    fs.renameSync(temp, target);
    return target;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    unlock();
  }
}

/** Explicit, offline cleanup. Database history and pending/failed deliveries remain intact. */
export function collectFiles(store: Store, before: number, apply = false): string[] {
  if (!Number.isFinite(before) || before >= Date.now())
    throw new Error('Cleanup cutoff must be in the past');
  const unlock = acquireLock(store.home);
  try {
    const protectedPaths = new Set(
      store
        .all<{
          file_path: string;
        }>("SELECT file_path FROM outbox WHERE file_path IS NOT NULL AND status!='sent'")
        .map((r) => r.file_path),
    );
    for (const row of store.all<{ attachments: string }>(
      "SELECT attachments FROM inbound WHERE status IN ('queued','running','failed')",
    ))
      for (const a of JSON.parse(row.attachments)) if (a.path) protectedPaths.add(a.path);
    const candidates: string[] = [];
    const scan = (dir: string) => {
      if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        // Never traverse workspace or spool symlinks into arbitrary user storage.
        if (entry.isDirectory()) scan(file);
        else if (entry.isFile() && fs.statSync(file).mtimeMs < before && !protectedPaths.has(file))
          candidates.push(file);
      }
    };
    scan(path.join(store.home, 'outgoing'));
    scan(path.join(store.home, 'diagnostics'));
    scan(path.join(store.home, 'transcripts'));
    const owned = path.join(fs.realpathSync(store.home), 'workspaces') + path.sep;
    for (const session of store.all<{ workspace: string }>('SELECT workspace FROM sessions')) {
      if (!canonicalPath(session.workspace).startsWith(owned)) continue;
      const attachments = path.join(session.workspace, 'attachments');
      if (!fs.existsSync(attachments) || fs.lstatSync(attachments).isSymbolicLink()) continue;
      scan(attachments);
    }
    if (apply) for (const file of candidates) fs.unlinkSync(file);
    return candidates;
  } finally {
    unlock();
  }
}
