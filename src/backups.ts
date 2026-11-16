import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { storagePolicy } from './storage.js';
import { canonicalPath } from './config.js';
import { writePrivate } from './files.js';

export interface SnapshotManifest {
  version: 1;
  createdAt: string;
  source: string;
  database: 'clawstrum.db';
  sha256: string;
  scope: string;
}
function integrity(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || Object.values(rows[0]!)[0] !== 'ok')
    throw new Error('Snapshot failed SQLite integrity check');
}
/** Read-only SQLite online backup. Does not open Store or migrate the source. */
export async function copyDatabase(home: string, destination: string): Promise<void> {
  const source = path.join(storagePolicy(home).directory, 'clawstrum.db');
  if (!fs.existsSync(source)) throw new Error('Source database is missing');
  if (fs.existsSync(destination)) throw new Error('Snapshot destination already exists');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    db.exec('PRAGMA busy_timeout=60000');
    const mode = db.prepare('PRAGMA journal_mode').get()?.journal_mode;
    if (mode === 'wal') {
      // Committed pages can still live in the WAL. A shared read transaction
      // does not prevent WAL writers, so copying only the main file loses data.
      const sqlite = await import('node:sqlite');
      if (typeof sqlite.backup !== 'function')
        throw new Error('Live WAL snapshots require Node.js >=22.16.0');
      fs.closeSync(fs.openSync(destination, 'wx', 0o600));
      await sqlite.backup(db, destination, { rate: 256 });
    } else {
      // Hold a read transaction, which keeps a SHARED lock so writers cannot change
      // the main database file, then copy the file whole. sqlite.backup() restarts
      // from page one on every writer commit, so under the daemon's continuous
      // write load it can run for half an hour and copy nothing. This path blocks
      // writers for one file copy instead, a few seconds for a GB-sized database.
      db.exec('BEGIN DEFERRED');
      db.prepare('SELECT count(*) FROM sqlite_schema').get();
      try {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, 0o600);
      } finally {
        db.exec('ROLLBACK');
      }
    }
    const check = new DatabaseSync(destination, { readOnly: true });
    try {
      integrity(check);
    } finally {
      check.close();
    }
    const output = fs.openSync(destination, 'r');
    try {
      fs.fsyncSync(output);
    } finally {
      fs.closeSync(output);
    }
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    db?.close();
  }
}
function digest(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let length;
    while ((length = fs.readSync(fd, buffer))) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
export function verifySnapshot(directory: string): SnapshotManifest {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, 'SNAPSHOT.json'), 'utf8'),
  ) as SnapshotManifest;
  if (
    manifest.version !== 1 ||
    manifest.database !== 'clawstrum.db' ||
    !Number.isFinite(Date.parse(manifest.createdAt))
  )
    throw new Error('Unsupported snapshot manifest');
  const file = path.join(directory, manifest.database);
  if (digest(file) !== manifest.sha256) throw new Error('Snapshot checksum mismatch');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    integrity(db);
  } finally {
    db.close();
  }
  return manifest;
}
const snapshotName = /^snapshot-\d{8}T\d{9}Z-[0-9a-f-]{36}$/;
export async function liveBackup(
  home: string,
  directory: string,
  options: { keepLast?: number; keepDays?: number; now?: number } = {},
): Promise<{ directory: string; manifest: SnapshotManifest }> {
  const keepLast = options.keepLast ?? 12,
    keepDays = options.keepDays ?? 7;
  for (const n of [keepLast, keepDays])
    if (!Number.isSafeInteger(n) || n < 1 || n > 10000)
      throw new Error('Retention must be between 1 and 10000');
  const folder = canonicalPath(path.resolve(directory));
  const source = canonicalPath(path.join(storagePolicy(home).directory, 'clawstrum.db'));
  if (folder === source) throw new Error('Backup directory cannot be the source database');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const mutexPath = path.join(folder, '.backup-lock.db');
  const mutex = new DatabaseSync(mutexPath);
  fs.chmodSync(mutexPath, 0o600);
  let locked = false;
  const temporary = path.join(folder, '.snapshot-' + randomUUID() + '.tmp');
  try {
    try {
      mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      locked = true;
    } catch {
      throw new Error('Another backup is using this destination');
    }
    fs.mkdirSync(temporary, { mode: 0o700 });
    const file = path.join(temporary, 'clawstrum.db');
    await copyDatabase(home, file);
    const createdAt = new Date(options.now ?? Date.now()).toISOString();
    const manifest: SnapshotManifest = {
      version: 1,
      createdAt,
      source,
      database: 'clawstrum.db',
      sha256: digest(file),
      scope:
        'Live SQLite snapshot only. Configuration, credentials, workspaces, attachments and external files need separate backups. Restore only with all writers stopped and a compatible binary.',
    };
    writePrivate(path.join(temporary, 'SNAPSHOT.json'), JSON.stringify(manifest, null, 2) + '\n');
    if (process.platform !== 'win32') {
      const fd = fs.openSync(temporary, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    const name = 'snapshot-' + createdAt.replace(/[-:.]/g, '') + '-' + randomUUID();
    const target = path.join(folder, name);
    fs.renameSync(temporary, target);
    writePrivate(
      path.join(folder, 'latest.json'),
      JSON.stringify({ directory: name, createdAt }) + '\n',
    );
    if (process.platform !== 'win32') {
      const fd = fs.openSync(folder, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    // Retention only owns directories with a matching source manifest. Never prune arbitrary DBs.
    const candidates = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && snapshotName.test(entry.name))
      .map((entry) => {
        try {
          const saved = JSON.parse(
            fs.readFileSync(path.join(folder, entry.name, 'SNAPSHOT.json'), 'utf8'),
          );
          return saved.version === 1 && saved.source === source && saved.database === 'clawstrum.db'
            ? {
                name: entry.name,
                at: Date.parse(saved.createdAt),
                day: String(saved.createdAt).slice(0, 10),
              }
            : null;
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is { name: string; at: number; day: string } =>
          entry !== null && Number.isFinite(entry.at),
      )
      .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
    const keep = new Set([name, ...candidates.slice(0, keepLast).map((entry) => entry.name)]);
    const days = new Set<string>();
    for (const entry of candidates) {
      if (!days.has(entry.day) && days.size < keepDays) {
        days.add(entry.day);
        keep.add(entry.name);
      }
    }
    for (const entry of candidates)
      if (!keep.has(entry.name)) fs.rmSync(path.join(folder, entry.name), { recursive: true });
    return { directory: target, manifest };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (locked) mutex.exec('ROLLBACK');
    mutex.close();
  }
}
