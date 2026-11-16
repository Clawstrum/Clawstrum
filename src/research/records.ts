import { claimSchema } from './evidence.js';
import { noteClaim, normalizeClaim, saveClaim, renderClaimStatus } from './claims.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../store.js';
import {
  ensureMemory,
  observeMemory,
  updateMemory,
  memoryFile,
  nestMemoryContent,
} from '../memory.js';
import { archiveRecord, supersedeHistory } from '../history.js';
import { bounded } from '../context.js';
import { userDecisionsBlock } from '../user-decisions.js';

export const noteSchema = z
  .object({
    kind: z.enum(['finding', 'decision', 'method', 'question']),
    title: z.string().min(1).max(300),
    body: z.string().min(1).max(50000),
    evidence: z.array(z.string().min(1).max(2000)).max(100).default([]),
    supersedes: z.array(z.uuid()).max(20).default([]),
    claim: claimSchema.optional(),
  })
  .strict();
export function saveNote(
  store: Store,
  sessionId: string,
  key: string,
  input: z.input<typeof noteSchema>,
) {
  const note = noteSchema.parse(input);
  if (note.claim) note.claim = normalizeClaim(store, sessionId, note.claim);
  note.supersedes = [...new Set(note.supersedes)].sort();
  const dedupe = `${sessionId}:note:${key}`;
  const id = store.transaction(() => {
    const existing = store.get<{
      id: string;
      kind: string;
      title: string;
      body: string;
      evidence_json: string;
    }>('SELECT * FROM research_notes WHERE dedupe_key=?', dedupe);
    if (existing) {
      if (
        existing.kind !== note.kind ||
        existing.title !== note.title ||
        existing.body !== note.body ||
        existing.evidence_json !== JSON.stringify(note.evidence) ||
        JSON.stringify(noteClaim(store, sessionId, existing.id)?.spec) !==
          JSON.stringify(note.claim) ||
        JSON.stringify(noteRevisions(store, sessionId, existing.id).supersedes) !==
          JSON.stringify(note.supersedes)
      )
        throw new Error('Note key already names different content; use a new key for a revision');
      return existing.id;
    }
    for (const previous of note.supersedes) {
      if (
        !store.get('SELECT id FROM research_notes WHERE id=? AND session_id=?', previous, sessionId)
      )
        throw new Error('A superseded note must belong to this conversation');
      if (noteRevisions(store, sessionId, previous).supersededBy)
        throw new Error('Note was already superseded; inspect and revise its current replacement');
    }
    const id = randomUUID();
    store.exec(
      'INSERT INTO research_notes(id,session_id,dedupe_key,kind,title,body,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
      id,
      sessionId,
      dedupe,
      note.kind,
      note.title,
      note.body,
      JSON.stringify(note.evidence),
      Date.now(),
    );
    if (note.claim) saveClaim(store, sessionId, id, note.claim);
    if (note.supersedes.length) {
      store.exec(
        'INSERT INTO metadata(key,value) VALUES(?,?)',
        `note-revision:${sessionId}:${id}`,
        JSON.stringify(note.supersedes),
      );
      for (const previous of note.supersedes)
        store.exec(
          'INSERT INTO metadata(key,value) VALUES(?,?)',
          `note-superseded:${sessionId}:${previous}`,
          JSON.stringify(id),
        );
    }
    return id;
  });
  const file = renderNotes(store, sessionId);
  return { id, file };
}
export function noteRevisions(
  store: Store,
  sessionId: string,
  id: string,
): { supersedes: string[]; supersededBy: string | null } {
  const prior = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    `note-revision:${sessionId}:${id}`,
  );
  const next = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    `note-superseded:${sessionId}:${id}`,
  );
  return {
    supersedes: prior ? JSON.parse(prior.value) : [],
    supersededBy: next ? JSON.parse(next.value) : null,
  };
}
export function managedBlock(
  store: Store,
  sessionId: string,
  name: string,
  content: string,
): string {
  ensureMemory(store, sessionId);
  const current = observeMemory(store, sessionId);
  const section = current.sections.find((s) => s.name === 'Research state');
  let body = section ? current.text.slice(section.body, section.end).trim() : '';
  const begin = `<!-- clawstrum:${name}:start -->`,
    end = `<!-- clawstrum:${name}:end -->`;
  const a = body.indexOf(begin),
    b = body.indexOf(end);
  if (a < 0 !== b < 0 || (a >= 0 && (b < a || body.indexOf(begin, a + begin.length) >= 0)))
    throw new Error('Ambiguous managed research block; repair AGENTS.md before retrying');
  const block = `${begin}\n${content}\n${end}`;
  body = a >= 0 ? body.slice(0, a) + block + body.slice(b + end.length) : body + '\n\n' + block;
  updateMemory(store, sessionId, { 'Research state': body }, current.revision);
  return memoryFile(store, sessionId);
}
export function renderNotes(store: Store, sessionId: string): string {
  const rows = store.all<any>(
    'SELECT * FROM research_notes WHERE session_id=? ORDER BY created_at,id',
    sessionId,
  );
  for (const row of rows)
    archiveRecord(store, {
      id: `note:${row.id}`,
      sessionId,
      kind: 'research_note',
      content: row,
      at: row.created_at,
    });
  for (const row of rows) {
    const revision = noteRevisions(store, sessionId, row.id);
    for (const prior of revision.supersedes)
      supersedeHistory(store, `note:${prior}`, `note:${row.id}`);
  }
  ensureMemory(store, sessionId);
  const document = observeMemory(store, sessionId);
  const section = document.sections.find((s) => s.name === 'Research state');
  let body = section ? document.text.slice(section.body, section.end).trim() : '';
  const newIds: string[] = [];
  for (const row of rows) {
    const key = `note-rendered:${sessionId}:${row.id}`;
    const revision = noteRevisions(store, sessionId, row.id);
    const begin = `<!-- clawstrum:note:${row.id}:start -->`,
      end = `<!-- clawstrum:note:${row.id}:end -->`;
    const a = body.indexOf(begin),
      b = body.indexOf(end);
    if (a < 0 !== b < 0 || (a >= 0 && b < a)) throw new Error('Ambiguous research note block');
    if (revision.supersededBy) {
      if (a >= 0) body = body.slice(0, a) + body.slice(b + end.length);
      newIds.push(row.id);
      continue;
    }
    // AGENTS is current authority. A note that was condensed or removed there must never be
    // reconstructed from the audit database on an unrelated subsequent save.
    if (store.get('SELECT key FROM metadata WHERE key=?', key) || a >= 0) continue;
    const claim = noteClaim(store, sessionId, row.id);
    const provenance = claim
      ? `\nClaim scope: ${JSON.stringify(claim.spec.scope)}. Basis: ${claim.spec.basis} (agent classification). Sources: ${JSON.stringify(claim.spec.sources)}. See Claim evidence status for current dependencies.\n`
      : '\nClaim scope: unspecified. Basis: unclassified source report.\n';
    const text = `#### ${row.kind}: ${row.title.replace(/\s+/g, ' ')}\n\n${nestMemoryContent(row.body)}${provenance}\n\nRecorded ${new Date(row.created_at).toISOString()}; history:note:${row.id}${revision.supersedes.length ? '; supersedes ' + revision.supersedes.map((id) => 'history:note:' + id).join(', ') : ''}.\nEvidence: ${JSON.parse(row.evidence_json).join(', ') || 'Not supplied'}`;
    body += `\n\n${begin}\n${text}\n${end}`;
    newIds.push(row.id);
  }
  updateMemory(store, sessionId, { 'Research state': body }, document.revision);
  for (const id of newIds)
    store.exec(
      'INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)',
      `note-rendered:${sessionId}:${id}`,
      'true',
    );
  renderClaimStatus(store, sessionId);
  return memoryFile(store, sessionId);
}
export function researchState(
  store: Store,
  sessionId: string,
  limit = 12000,
  timeZone?: string,
): string {
  const workers = store.all(
    "SELECT id,status,result_path,summary,error FROM delegations WHERE session_id=? AND status IN ('queued','running') ORDER BY created_at",
    sessionId,
  );
  const jobs = store.all(
    "SELECT id,job_id,cluster,status,observation_json,error FROM cluster_jobs WHERE session_id=? AND status NOT IN ('completed','cancelled','failed') ORDER BY created_at",
    sessionId,
  );
  const full = JSON.stringify({ subagents: workers, jobs }, null, 2);
  const decisions = userDecisionsBlock(store, sessionId, undefined, timeZone);
  if (decisions) managedBlock(store, sessionId, 'user-decisions', decisions);
  const file = managedBlock(
    store,
    sessionId,
    'operational-state',
    `#### Current operational state\n\nCanonical source: SQLite. Use research_status for all records.\n\n\`\`\`json\n${full}\n\`\`\``,
  );
  const document = observeMemory(store, sessionId);
  const section = document.sections.find((s) => s.name === 'Research state')!;
  return `Current research state (${file}, MEMORY / Research state):\n${bounded(document.text.slice(section.body, section.end), limit)}`;
}
export function researchWake(store: Store, sessionId: string, id: string, content: string): void {
  store.enqueue({
    id: `research:${id}`,
    sessionId,
    author: 'Clawstrum research monitor',
    kind: 'task',
    content: `Harness-generated research event, not a new human request. Inspect the artifact and write any useful result to the people in this conversation, addressed to them as "you"; if nothing needs reporting, reply with only the word CLAWSTRUM_QUIET and no other text.\n${content}`,
  });
}
