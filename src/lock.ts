import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writePrivate } from './files.js';
import { storagePolicy } from './storage.js';

export function lockStatus(home: string): { live: boolean; detail: string; pid?: number } {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, 'daemon.lock'), 'utf8'));
    if (!Number.isSafeInteger(info.pid) || info.pid <= 0 || typeof info.host !== 'string')
      return { live: false, detail: 'Malformed daemon metadata' };
    if (info.host !== os.hostname())
      return { live: true, detail: `Lock belongs to host ${info.host}`, pid: info.pid };
    try {
      process.kill(info.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH')
        return { live: false, detail: `Stale daemon metadata (pid ${info.pid})` };
      return {
        live: true,
        detail: `Cannot inspect daemon pid ${info.pid}: ${String(error)}`,
        pid: info.pid,
      };
    }
    return { live: true, detail: `Daemon pid ${info.pid} on ${info.host}`, pid: info.pid };
  } catch (error) {
    return {
      live: false,
      detail:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'Daemon is not running'
          : 'Malformed daemon metadata',
    };
  }
}

/** SQLite's OS-backed exclusive lock is released even on SIGKILL. Never unlink its inode. */
export function acquireLock(home: string): () => void {
  const storage = storagePolicy(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'daemon.lock');
  fs.mkdirSync(storage.directory, { recursive: true, mode: 0o700 });
  const dbfile = path.join(storage.directory, 'daemon-lock.db');
  const mutex = new DatabaseSync(dbfile);
  fs.chmodSync(dbfile, 0o600);
  try {
    mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch {
    mutex.close();
    throw new Error('Clawstrum is already running (exclusive daemon lock is held)');
  }
  try {
    // Retain compatibility with a still-running 0.1 daemon using the old metadata lock.
    const previous = lockStatus(home);
    let modern = false;
    try {
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
      modern = metadata.lock === 'sqlite' && metadata.host === os.hostname();
    } catch {
      /* Missing or malformed metadata is replaced under the held mutex. */
    }
    // For modern same-host owners the acquired OS lock is authoritative, including PID reuse.
    if (!modern && previous.live)
      throw new Error(`Clawstrum is already running: ${previous.detail}`);
    writePrivate(
      file,
      JSON.stringify({
        lock: 'sqlite',
        pid: process.pid,
        host: os.hostname(),
        startedAt: Date.now(),
        entrypoint: process.argv[1] ? path.resolve(process.argv[1]) : undefined,
      }),
    );
  } catch (error) {
    mutex.exec('ROLLBACK');
    mutex.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      fs.rmSync(file, { force: true });
    } finally {
      mutex.exec('ROLLBACK');
      mutex.close();
    }
  };
}
