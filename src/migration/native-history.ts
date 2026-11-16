import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Store } from '../store.js';
import type { Session } from '../types.js';
import { archiveRecord, historyHash } from '../history.js';

/** Preserve available current native logs before changing cwd/session identity. Missing provider
 * archives are recorded as coverage gaps; the old database and memory remain separate evidence. */
export function importNativeHistory(store: Store, config: Config): void {
  for (const session of store.all<Session>('SELECT * FROM sessions WHERE remote_id IS NOT NULL')) {
    const id = session.remote_id!;
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Unsafe native session identifier');
    const files: string[] = [];
    for (const account of config.accounts) {
      // Gemini keeps whole-session JSON files under <home>/.gemini/tmp, not <id>.jsonl logs.
      if (account.provider === 'gemini') continue;
      const root = path.join(account.home, account.provider === 'claude' ? 'projects' : 'sessions');
      if (!fs.existsSync(root)) continue;
      const visit = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) visit(file);
          else if (
            entry.isFile() &&
            (entry.name === id + '.jsonl' || entry.name.endsWith('-' + id + '.jsonl'))
          )
            files.push(file);
        }
      };
      visit(root);
    }
    for (const file of [...new Set(files)]) {
      const raw = fs.readFileSync(file, 'utf8');
      archiveRecord(store, {
        id: `migration-native:${session.id}:${historyHash(file)}:${historyHash(raw)}`,
        sessionId: session.id,
        kind: 'native_transcript',
        source: file,
        content: raw,
      });
      for (const [index, line] of raw.split('\n').entries()) {
        if (!line.trim()) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = {};
        }
        // UUIDs are not universally present; the content hash also distinguishes revisions.
        archiveRecord(store, {
          id: `migration-native-line:${session.id}:${id}:${historyHash(line)}`,
          sessionId: session.id,
          kind: ['assistant', 'user', 'response_item', 'event_msg'].includes(parsed.type)
            ? 'legacy_provider_message'
            : 'native_metadata',
          source: `${file}:${index + 1}`,
          content: line,
          counted: ['assistant', 'user', 'response_item', 'event_msg'].includes(parsed.type),
          at: Number.isFinite(Date.parse(parsed.timestamp))
            ? Date.parse(parsed.timestamp)
            : undefined,
        });
      }
    }
    archiveRecord(store, {
      id: `native-coverage:${session.id}:${id}`,
      sessionId: session.id,
      kind: 'coverage',
      content: {
        nativeSession: id,
        archives: [...new Set(files)],
        scope:
          'Current native session logs available at migration; earlier native sessions remain in original provider storage. SQLite imports may contain shortened historic events.',
        missing: files.length === 0,
      },
    });
  }
}
