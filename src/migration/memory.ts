import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../store.js';
import type { Session } from '../types.js';
import {
  archiveRecord,
  historyHash,
  historyRoot,
  importStoredHistory,
  repairHistory,
} from '../history.js';
import {
  memoryFile,
  memoryTemplate,
  observeMemory,
  parseMemory,
  hasMemory,
  updateMemory,
} from '../memory.js';
import { writePrivate, syncDirectory } from '../files.js';
import { DEFAULT_AGENTS } from '../context.js';
import { consolidationCoverage } from '../consolidation.js';

export function migrationPending(store: Store, sessionId: string | null): boolean {
  return !!store.get(
    'SELECT key FROM metadata WHERE key=?',
    `memory-migration:${sessionId ?? 'shared'}`,
  );
}
export function finishMemoryMigration(store: Store, sessionId: string | null): void {
  const key = `memory-migration:${sessionId ?? 'shared'}`;
  const pending = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key);
  if (!pending) return;
  const cutoff = consolidationCoverage(store, sessionId);
  if (
    store.get(
      'SELECT seq FROM history_records WHERE session_id IS ? AND kind=? AND seq>? LIMIT 1',
      sessionId,
      'legacy_memory',
      cutoff,
    )
  )
    throw new Error('Complete migration consolidation before retiring legacy memory files');
  // Raw revisions are durable before old active documents are retired. Keep their archived
  // originals, not competing Markdown files that a provider might silently reload.
  const retired = JSON.parse(pending.value) as Array<{ file: string; hash: string; link?: string }>;
  for (const item of retired) {
    if (!fs.existsSync(item.file)) continue;
    if (
      item.link !== undefined
        ? !fs.lstatSync(item.file).isSymbolicLink() || fs.readlinkSync(item.file) !== item.link
        : historyHash(fs.readFileSync(item.file, 'utf8')) !== item.hash
    )
      throw new Error(
        `Legacy source changed during migration: ${item.file}; prepare the migration again`,
      );
  }
  for (const item of retired) if (fs.existsSync(item.file)) fs.unlinkSync(item.file);
  if (sessionId)
    for (const note of store.all<{ id: string }>(
      'SELECT id FROM research_notes WHERE session_id=?',
      sessionId,
    ))
      store.exec(
        'INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)',
        `note-rendered:${sessionId}:${note.id}`,
        'true',
      );
  store.exec('DELETE FROM metadata WHERE key=?', key);
}

/** Scoped memory kept as a `memory/` directory of documents rather than one MEMORY.md. Depth 1:
 * a nested tree is project material, not the memory surface a provider loaded every turn. */
function legacyMemoryDirectory(dir: string): string[] {
  const root = path.join(dir, 'memory');
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.name.endsWith('.md') &&
        (entry.isFile() ||
          (entry.isSymbolicLink() &&
            !!fs.statSync(path.join(root, entry.name), { throwIfNoEntry: false })?.isFile())),
    )
    .map((entry) => path.join('memory', entry.name))
    .sort();
  if (names.length > 256)
    throw new Error(
      `Too many legacy memory documents to archive: ${root}; consolidate them before migrating`,
    );
  return names;
}

/** Explicit migration: preserve every source before changing the active interface. The subsequent
 * full-coverage model pass reconciles old notes; they are never concatenated into current memory. */
export function prepareMemoryScope(
  store: Store,
  sessionId: string | null,
): { pending: boolean; sources: number } {
  const file = memoryFile(store, sessionId),
    dir = path.dirname(file);
  const retired: Array<{ file: string; hash: string; link?: string }> = [];
  const retire = (file: string, hash: string) =>
    retired.push({
      file,
      hash,
      ...(fs.lstatSync(file).isSymbolicLink() ? { link: fs.readlinkSync(file) } : {}),
    });
  const previous = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    `memory-migration:${sessionId ?? 'shared'}`,
  );
  if (previous) retired.push(...JSON.parse(previous.value));
  const seen = new Set<string>();
  const sharedSources = new Set<string>(
    sessionId
      ? JSON.parse(
          store.get<{ value: string }>(
            "SELECT value FROM metadata WHERE key='memory-migration:shared-sources'",
          )?.value ?? '[]',
        )
      : [],
  );
  const sources: string[] = [];
  const preserve = (source: string, legacyMemory: boolean) => {
    if (!fs.existsSync(source)) return '';
    const text = fs.readFileSync(source, 'utf8');
    const hash = historyHash(text);
    const id = `migration:${sessionId ?? 'shared'}:${historyHash(source)}:${hash}`;
    archiveRecord(store, {
      id,
      sessionId,
      kind: legacyMemory ? 'legacy_memory' : 'legacy_instructions',
      source,
      content: text,
      counted: legacyMemory,
    });
    if (legacyMemory) {
      sources.push(id);
      const relative = path.relative(dir, source);
      if (relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
        retire(source, hash);
    }
    return text;
  };
  const visit = (source: string, depth = 0): string => {
    if (!fs.existsSync(source)) return '';
    const real = fs.realpathSync(source);
    if (sharedSources.has(real)) return '';
    if (seen.has(real)) return '';
    if (depth > 20 || seen.size >= 256)
      throw new Error('Legacy instruction import graph too large');
    seen.add(real);
    if (
      /^(MEMORY|CHECKPOINT|RECORDS|decisions|\.working-memory|\.conversation-state)\.md$|^STATE\.json$/.test(
        path.basename(source),
      )
    ) {
      preserve(source, true);
      return '';
    }
    const text = preserve(source, false);
    let fenced = false;
    return text
      .split('\n')
      .map((line) => {
        if (/^\s*(```|~~~)/.test(line)) {
          fenced = !fenced;
          return line;
        }
        const match = !fenced && /^\s*@(?:"([^"]+\.md)"|'([^']+\.md)'|([^\s]+\.md))\s*$/.exec(line);
        const target = match && (match[1] ?? match[2] ?? match[3]);
        return target ? visit(path.resolve(path.dirname(source), target), depth + 1) : line;
      })
      .join('\n');
  };
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const alreadyUnified = hasMemory(text);
  if (alreadyUnified) parseMemory(text);
  else {
    const canonical = ['AGENTS.override.md', 'AGENTS.md', 'SELF.md', 'CLAUDE.md']
      .map((name) => path.join(dir, name))
      .filter((p) => fs.existsSync(p));
    const instructions = canonical.length
      ? visit(canonical[0]!)
      : sessionId
        ? '# Channel agent\n\n## Instructions\n\nFollow the shared instructions and the user’s current request.'
        : DEFAULT_AGENTS;
    text = memoryTemplate(
      instructions +
        '\n\n## Current storage contract\n\nThe harness memory interface is AGENTS.md / MEMORY at the shared and channel scopes. Historical instructions above mentioning separate MEMORY.md, CHECKPOINT.md, research/RECORDS.md or research/STATE.json refer to the corresponding sections of this document now. Do not recreate those retired files. Use memory_update, checkpoint and research_note; use history to retrieve superseded detail. Shared policy is loaded once from the shared AGENTS.md; channel documents do not maintain their own copy.\n',
      historyRoot(store, sessionId),
    );
  }
  if (!sessionId && seen.size)
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      'memory-migration:shared-sources',
      JSON.stringify([...seen]),
    );
  for (const name of ['AGENTS.override.md', 'SELF.md', 'CLAUDE.md']) {
    const source = path.join(dir, name);
    if (fs.existsSync(source)) {
      const raw = preserve(source, false);
      retire(source, historyHash(raw));
    }
  }
  // Reach these directly, not only through an @include chain from the instruction file: the
  // working/conversation documents carry in-flight external identifiers that consolidation's
  // work protection looks for by the same basenames, and it only sees archived sources.
  for (const name of [
    'MEMORY.md',
    'CHECKPOINT.md',
    '.working-memory.md',
    '.conversation-state.md',
    'research/RECORDS.md',
    'research/STATE.json',
    ...legacyMemoryDirectory(dir),
  ]) {
    const source = path.join(dir, name);
    if (fs.existsSync(source) && !retired.some((r) => r.file === source)) preserve(source, true);
  }
  if (!alreadyUnified) writePrivate(file, text);
  const notes = sessionId
    ? store.all<any>(
        'SELECT * FROM research_notes WHERE session_id=? ORDER BY created_at,id',
        sessionId,
      )
    : [];
  for (const note of notes)
    archiveRecord(store, {
      id: `note:${note.id}`,
      sessionId,
      kind: 'research_note',
      content: note,
      at: note.created_at,
    });
  const unrenderedNotes = notes.some(
    (note) =>
      !store.get('SELECT key FROM metadata WHERE key=?', `note-rendered:${sessionId}:${note.id}`),
  );
  if (sources.length || retired.length || unrenderedNotes) {
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      `memory-migration:${sessionId ?? 'shared'}`,
      JSON.stringify([...new Map(retired.map((item) => [item.file, item])).values()]),
    );
  }
  observeMemory(store, sessionId);
  return { pending: migrationPending(store, sessionId), sources: sources.length };
}
export function prepareMemoryMigration(
  store: Store,
): Array<{ sessionId: string | null; pending: boolean; sources: number }> {
  const results: Array<{ sessionId: string | null; pending: boolean; sources: number }> = [
    { sessionId: null, ...prepareMemoryScope(store, null) },
  ];
  for (const session of store.all<Session>('SELECT * FROM sessions ORDER BY created_at,id')) {
    importStoredHistory(store, session.id);
    results.push({ sessionId: session.id, ...prepareMemoryScope(store, session.id) });
  }
  repairHistory(store);
  return results;
}

/** Idle-only workspace relocation. Journal each move; preserve old paths as compatibility links
 * so already-submitted external work can finish. New sessions use stable Discord channel IDs. */
export function moveChannelWorkspaces(store: Store, root: string): void {
  root = path.resolve(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  syncDirectory(path.dirname(root));
  for (const session of store.all<Session>('SELECT * FROM sessions ORDER BY id')) {
    if (!/^[a-zA-Z0-9_-]+$/.test(session.channel_id))
      throw new Error(`Unsafe channel path: ${session.channel_id}`);
    const target = path.join(root, session.channel_id),
      old = session.workspace;
    if (path.resolve(old) === target) continue;
    if (session.remote_id)
      throw new Error(`Consolidate ${session.id} before moving its native session workspace`);
    const key = `workspace-move:${session.id}`;
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      JSON.stringify({ old, target }),
    );
    if (fs.existsSync(target)) {
      if (!fs.existsSync(old) || fs.realpathSync(old) !== fs.realpathSync(target)) {
        // A prior interrupted rename leaves target present and old missing.
        if (fs.existsSync(old)) throw new Error(`Channel destination already exists: ${target}`);
      }
    } else fs.renameSync(old, target);
    if (!fs.existsSync(old)) fs.symlinkSync(target, old, 'dir');
    syncDirectory(path.dirname(old));
    syncDirectory(root);
    store.exec(
      'UPDATE sessions SET workspace=?,remote_id=NULL,fingerprint=NULL WHERE id=?',
      target,
      session.id,
    );
    const document = observeMemory(store, session.id);
    const section = document.sections.find((s) => s.name === 'History access and coverage');
    if (section)
      updateMemory(
        store,
        session.id,
        {
          'History access and coverage': document.text
            .slice(section.body, section.end)
            .replaceAll(path.join(old, 'history'), path.join(target, 'history')),
        },
        document.revision,
      );
    // The old link keeps path-bearing task specs and existing cluster scripts valid. New writes
    // resolve through the canonical session row; do not blindly replace user-authored SQL/text.
    store.exec('DELETE FROM metadata WHERE key=?', key);
  }
  store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    'channels-root',
    root,
  );
}
