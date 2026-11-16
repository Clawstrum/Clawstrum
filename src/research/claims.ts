import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from '../store.js';
import { archiveRecord, historyHash, type HistoryRecord } from '../history.js';
import { ensureMemory, observeMemory, updateMemory } from '../memory.js';
import { requestMemoryReview } from '../memory-review.js';
import { claimSchema, fingerprint, type Claim, type Observation } from './evidence.js';

export interface ClaimRecord {
  spec: Claim;
  recordedAt: number;
  baseline: Observation[] | null;
  observations: Observation[];
  status: 'unverified' | 'unchanged' | 'changed' | 'unavailable';
  checkedAt?: number;
}
const key = (session: string, id: string) => `note-claim:${session}:${id}`;
export function noteClaim(store: Store, session: string, id: string): ClaimRecord | undefined {
  const row = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    key(session, id),
  );
  return row ? JSON.parse(row.value) : undefined;
}
export function normalizeClaim(store: Store, session: string, raw: Claim): Claim {
  const spec = claimSchema.parse(raw);
  spec.sources = spec.sources.map((source) =>
    'file' in source
      ? { ...source, file: path.resolve(store.session(session).workspace, source.file) }
      : source,
  );
  for (const source of spec.sources)
    if ('historyId' in source) {
      const row = store.get<HistoryRecord>(
        'SELECT * FROM history_records WHERE id=?',
        source.historyId,
      );
      if (!row || row.group_id || (row.session_id !== session && row.session_id !== null))
        throw new Error('Claim history evidence must exist in this conversation or shared history');
    }
  if (
    spec.basis === 'user_decision' &&
    !spec.sources.some(
      (source) =>
        'historyId' in source &&
        store.get<{ kind: string }>('SELECT kind FROM history_records WHERE id=?', source.historyId)
          ?.kind === 'user',
    )
  )
    throw new Error(
      'A user decision needs an actual user history record, not an assistant assertion',
    );
  return spec;
}
export function saveClaim(store: Store, session: string, id: string, spec: Claim) {
  const record: ClaimRecord = {
    spec,
    recordedAt: Date.now(),
    baseline: null,
    observations: [],
    status: 'unverified',
  };
  store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    key(session, id),
    JSON.stringify(record),
  );
  archiveRecord(store, {
    id: `claim:${id}`,
    sessionId: session,
    kind: 'research_claim',
    content: { noteId: id, ...record },
  });
}
export function claimIndex(store: Store, session: string) {
  return store
    .all<{
      id: string;
    }>(
      "SELECT n.id FROM research_notes n WHERE n.session_id=? AND NOT EXISTS (SELECT 1 FROM metadata m WHERE m.key='note-superseded:'||n.session_id||':'||n.id) ORDER BY n.created_at,n.id",
      session,
    )
    .flatMap((row) => {
      const claim = noteClaim(store, session, row.id);
      return claim ? [{ noteId: row.id, ...claim }] : [];
    });
}
async function observe(
  store: Store,
  session: string,
  source: Claim['sources'][number],
  signal?: AbortSignal,
): Promise<Observation> {
  try {
    signal?.throwIfAborted();
    if ('file' in source)
      return { source, ...(await fingerprint(source.file, 16 * 1024 * 1024, signal)) };
    const row = store.get<HistoryRecord>(
      'SELECT * FROM history_records WHERE id=?',
      source.historyId,
    );
    if (!row || row.group_id || (row.session_id !== session && row.session_id !== null))
      throw new Error('Evidence is unavailable in this scope');
    const replacement = store.get<{ replacement_id: string }>(
      'SELECT replacement_id FROM history_supersessions WHERE previous_id=?',
      row.id,
    );
    return {
      source,
      kind: row.kind,
      sha256: historyHash(row.content),
      bytes: row.bytes,
      ...(replacement ? { supersededBy: replacement.replacement_id } : {}),
    };
  } catch (error) {
    signal?.throwIfAborted();
    return { source, error: String(error) };
  }
}
const signature = (values: Observation[]) => JSON.stringify(values);
const pending = new WeakMap<Store, Map<string, Promise<void>>>();
/** Observe only registered dependencies. A changed source requests review; it never declares a claim false. */
export async function refreshClaimEvidence(
  store: Store,
  session: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let jobs = pending.get(store);
  if (!jobs) pending.set(store, (jobs = new Map()));
  if (jobs.has(session)) return jobs.get(session)!;
  const task = refresh(store, session, signal);
  jobs.set(session, task);
  try {
    await task;
  } finally {
    jobs.delete(session);
  }
}
async function refresh(store: Store, session: string, signal?: AbortSignal) {
  const claims = claimIndex(store, session);
  if (!claims.length) {
    renderClaimStatus(store, session);
    return;
  }
  const cache = new Map<string, Promise<Observation>>();
  for (const claim of claims) {
    const observations: Observation[] = [];
    for (const source of claim.spec.sources) {
      const name = JSON.stringify(source);
      if (!cache.has(name)) cache.set(name, observe(store, session, source, signal));
      observations.push(await cache.get(name)!);
    }
    signal?.throwIfAborted();
    // A concurrent retirement wins over a check begun earlier.
    if (
      store.get(
        'SELECT key FROM metadata WHERE key=?',
        `note-superseded:${session}:${claim.noteId}`,
      )
    )
      continue;
    const baseline = noteClaim(store, session, claim.noteId)?.baseline ?? observations;
    const status: ClaimRecord['status'] = observations.some((o) => o.error)
      ? 'unavailable'
      : observations.some(
            (o) =>
              o.supersededBy ||
              ('file' in o.source && o.source.sha256 && o.source.sha256 !== o.sha256),
          ) || signature(baseline) !== signature(observations)
        ? 'changed'
        : 'unchanged';
    const changed =
      claim.status !== status || signature(claim.observations) !== signature(observations);
    const next: ClaimRecord = {
      spec: claim.spec,
      recordedAt: claim.recordedAt,
      baseline,
      observations,
      status,
      checkedAt: Date.now(),
    };
    store.exec(
      'UPDATE metadata SET value=? WHERE key=?',
      JSON.stringify(next),
      key(session, claim.noteId),
    );
    if (changed) {
      const record = archiveRecord(store, {
        id: `claim-evidence:${randomUUID()}`,
        sessionId: session,
        kind: 'research_evidence',
        content: { noteId: claim.noteId, ...next },
      });
      if (status === 'changed' || status === 'unavailable')
        requestMemoryReview(
          store,
          session,
          `Evidence for ${claim.noteId} (${claim.spec.subject}) is ${status}. Inspect history:${record.id}; reconcile dependent memory and group entries. A source change does not itself retire a scientific finding.`,
          record.id,
        );
    }
  }
  renderClaimStatus(store, session);
}
export function renderClaimStatus(store: Store, session: string) {
  const claims = claimIndex(store, session);
  if (
    !claims.length &&
    !store.get('SELECT key FROM metadata WHERE key=?', `claim-status-rendered:${session}`)
  )
    return;
  ensureMemory(store, session);
  const doc = observeMemory(store, session);
  const section = doc.sections.find((s) => s.name === 'Research state')!;
  const body = doc.text.slice(section.body, section.end).trim();
  const begin = '<!-- clawstrum:claim-evidence:start -->',
    end = '<!-- clawstrum:claim-evidence:end -->';
  const a = body.indexOf(begin),
    b = body.indexOf(end);
  if (a < 0 !== b < 0 || (a >= 0 && (b < a || body.indexOf(begin, a + begin.length) >= 0)))
    throw new Error('Ambiguous claim evidence block');
  const rows = claims.map((c) => ({
    noteId: c.noteId,
    subject: c.spec.subject,
    scope: c.spec.scope,
    basis: c.spec.basis,
    evidenceStatus: c.status,
    checkedAt: c.checkedAt ?? null,
    sources: c.spec.sources,
  }));
  const block = claims.length
    ? `${begin}\n#### Claim evidence status\n\nSource fingerprints are last-observed provenance, not live verification or scientific truth. Use research_status collection=notes refresh=true when current dependency verification is needed. Changed/unavailable evidence requires verification before relying on the affected claim. Values remain in current memory; history:note:<noteId> preserves their recorded form.\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n${end}`
    : '';
  const updated =
    a >= 0 ? body.slice(0, a) + block + body.slice(b + end.length) : body + '\n\n' + block;
  if (updated.trim() !== body)
    updateMemory(store, session, { 'Research state': updated }, doc.revision);
  store.exec(
    'INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)',
    `claim-status-rendered:${session}`,
    'true',
  );
}
