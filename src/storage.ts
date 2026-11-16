import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** SQLite BUSY is temporary cross-connection contention, including extended BUSY codes.
 * Do not classify arbitrary provider text or corruption/programming failures as retryable. */
export function isDatabaseBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && Number.isInteger(code) && (code & 255) === 5;
}

/** Optional deployment policy, checked before opening either SQLite file. */
export function storagePolicy(home: string): { directory: string; journalMode: 'WAL' | 'DELETE' } {
  const file = path.join(home, 'STORAGE.json');
  if (!fs.existsSync(file)) return { directory: home, journalMode: 'WAL' };
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof policy.host !== 'string' || policy.host !== os.hostname())
    throw new Error(
      `This state belongs to host ${policy.host}; connect to that host before opening its database`,
    );
  if (!['WAL', 'DELETE'].includes(policy.journalMode))
    throw new Error('Invalid SQLite journal mode in STORAGE.json');
  if (typeof policy.directory !== 'string' || !path.isAbsolute(policy.directory))
    throw new Error('STORAGE.json requires an absolute database directory');
  return { directory: policy.directory, journalMode: policy.journalMode };
}
