import { z } from 'zod';
import type { Store } from '../store.js';
import { sumUsage, type UsageRecord, type UsageTotals } from '../usage.js';
import { researchWake } from './records.js';

type Reader = Pick<Store, 'get' | 'all'>;
export const workerUpdateSchema = z
  .object({
    state: z.enum(['working', 'blocked', 'report']),
    summary: z.string().min(1).max(3000),
    evidence: z.array(z.string().max(1000)).max(20).default([]),
    verification: z.array(z.string().max(1000)).max(20).default([]),
    uncertainties: z.array(z.string().max(1000)).max(20).default([]),
  })
  .strict();
export const workerReviewSchema = z
  .object({
    id: z.uuid(),
    outcome: z.enum(['accepted', 'rework', 'unused']),
    note: z.string().min(1).max(3000),
  })
  .strict();
export interface WorkerProfile {
  version: 1;
  provider?: string;
  model?: string;
  promptChars?: number;
  instructionChars?: number;
  resultChars?: number;
  returnedChars?: number;
  lastActivityAt?: number;
  lastEvent?: string;
  toolCalls?: number;
  progress?: z.output<typeof workerUpdateSchema> & { at: number };
  review?: z.output<typeof workerReviewSchema> & { at: number };
  /** The provider's own conversation id (Claude session, Codex thread) and the account that holds
   * it, kept so the subagent can continue that conversation after a Clawstrum restart. */
  providerSession?: string;
  providerAccount?: string;
  /** Automatic resumes after a restart so far, and whether the next start is one. */
  restarts?: number;
  resume?: boolean;
  /** Automatic continuations onto a different account after a provider quota failure so far, the
   * account that hit the quota last, and whether the next start is one. The provider conversation
   * stays with the exhausted account, so a quota continuation starts a fresh context rather than
   * resuming a native session. */
  quotaContinues?: number;
  quotaFromAccount?: string;
  quotaContinuing?: boolean;
  /** Accounts that answered this subagent's explicit model request with model_not_found. They are
   * skipped for this subagent only, so the request is tried on every other account of its provider
   * instead of being replaced by another model. */
  modelRefusedBy?: string[];
  /** Why a queued subagent has not started, recorded once per reason for the progress check. */
  waiting?: { reason: 'memory' | 'capacity'; detail: string; since: number };
}
export function workerProfile(store: Reader, id: string): WorkerProfile | undefined {
  const row = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    `worker-profile:${id}`,
  );
  return row ? (JSON.parse(row.value) as WorkerProfile) : undefined;
}
export function patchWorkerProfile(store: Store, id: string, patch: Partial<WorkerProfile>) {
  return store.transaction(() => {
    const value = { version: 1 as const, ...workerProfile(store, id), ...patch };
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      `worker-profile:${id}`,
      JSON.stringify(value),
    );
    return value;
  });
}
export function updateWorker(store: Store, sessionId: string, id: string, raw: unknown) {
  const input = workerUpdateSchema.parse(raw);
  return store.transaction(() => {
    const row = store.get<{ status: string }>(
      'SELECT status FROM delegations WHERE id=? AND session_id=?',
      id,
      sessionId,
    );
    if (row?.status !== 'running')
      throw new Error('Only the running subagent can update its progress');
    const old = workerProfile(store, id)?.progress;
    if (old && JSON.stringify({ ...old, at: undefined }) === JSON.stringify(input)) return old;
    const progress = { ...input, at: Date.now() };
    patchWorkerProfile(store, id, { progress });
    store.event(sessionId, null, 'research_worker_progress', { id, ...progress });
    // Routine progress stays internal. A newly blocked subagent needs a lead decision.
    if (input.state === 'blocked' && (old?.state !== 'blocked' || old.summary !== input.summary))
      researchWake(
        store,
        sessionId,
        `worker-blocked:${id}:${progress.at}`,
        `Subagent ${id} needs a decision: ${input.summary}. Inspect research_status subagents, then research_steer or cancel. It remains running within its budget.`,
      );
    return progress;
  });
}
export function reviewWorker(store: Store, sessionId: string, raw: unknown) {
  const input = workerReviewSchema.parse(raw);
  return store.transaction(() => {
    const row = store.get<{ status: string }>(
      'SELECT status FROM delegations WHERE id=? AND session_id=?',
      input.id,
      sessionId,
    );
    if (!row || !['completed', 'failed', 'cancelled'].includes(row.status))
      throw new Error('Review requires an ended subagent in this conversation');
    const review = { ...input, at: Date.now() };
    patchWorkerProfile(store, input.id, { review });
    store.event(sessionId, null, 'research_worker_review', review);
    return review;
  });
}

interface Row {
  id: string;
  session_id: string;
  parent_run: string | null;
  status: string;
  spec_json: string;
  account_id: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  result_path: string | null;
  error: string | null;
}
function totals(records: Array<UsageRecord | undefined>) {
  const keys = Object.keys(sumUsage([])) as Array<keyof UsageTotals>;
  return {
    invocations: records.length,
    reportedTotals: sumUsage(records.flatMap((r) => (r ? [r.snapshot.totals] : []))),
    missing: Object.fromEntries(
      keys.map((k) => [k, records.filter((r) => r?.snapshot.totals[k] == null).length]),
    ),
    unfinishedCounters: records.filter((r) => r && !r.snapshot.final).length,
  };
}

/** Cohorts use creation time, not mutable progress timestamps. No model calls or schema writes. */
export function workerReport(
  store: Reader,
  options: { sessionId?: string; since?: number; limit?: number; offset?: number } = {},
  now = Date.now(),
) {
  const { sessionId, since = 0, limit = 100, offset = 0 } = options;
  if (
    ![since, limit, offset].every(Number.isFinite) ||
    since < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    throw new Error('Invalid subagent profile window or pagination');
  const where = `created_at>=?${sessionId ? ' AND session_id=?' : ''}`;
  const params = [since, ...(sessionId ? [sessionId] : [])];
  const total = store.get<{ n: number }>(
    `SELECT count(*) n FROM delegations WHERE ${where}`,
    ...params,
  )!.n;
  const rows = store.all<Row>(
    `SELECT id,session_id,parent_run,status,spec_json,account_id,created_at,started_at,ended_at,result_path,error FROM delegations WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  const workers = rows.map((row) => {
    const profile = workerProfile(store, row.id);
    // A subagent resumed after a restart, or continued onto another account after a provider
    // quota failure, is a separate provider invocation, metered under its own id (workers.ts); its
    // counters restart, so the invocations are added, not merged.
    const records = store
      .all<{
        value: string;
      }>(
        'SELECT value FROM metadata WHERE key=? OR key LIKE ? OR key LIKE ? ORDER BY key',
        `usage:${row.session_id}:worker:${row.id}`,
        `usage:${row.session_id}:worker:${row.id}:restart%`,
        `usage:${row.session_id}:worker:${row.id}:quota%`,
      )
      .map((r) => JSON.parse(r.value) as UsageRecord);
    const usage =
      records.length > 1
        ? {
            ...records[0]!,
            snapshot: {
              ...records.at(-1)!.snapshot,
              totals: sumUsage(records.map((r) => r.snapshot.totals)),
            },
          }
        : records[0];
    return {
      ...row,
      spec: JSON.parse(row.spec_json),
      spec_json: undefined,
      profile,
      queueMs: (row.started_at ?? row.ended_at ?? now) - row.created_at,
      runMs: row.started_at === null ? null : (row.ended_at ?? now) - row.started_at,
      silenceMs:
        row.status === 'running' && profile?.lastActivityAt ? now - profile.lastActivityAt : null,
      usage,
    };
  });
  const parents = new Map(
    rows.filter((r) => r.parent_run).map((r) => [r.parent_run!, r.session_id]),
  );
  const lead: UsageRecord[] = [];
  let parentsWithoutUsage = 0;
  for (const [runId, session] of parents) {
    const records = store
      .all<{
        value: string;
      }>(
        `SELECT value FROM metadata WHERE key LIKE ? AND json_extract(value,'$.runId')=? AND json_extract(value,'$.role')='lead'`,
        `usage:${session}:%`,
        runId,
      )
      .map((r) => JSON.parse(r.value) as UsageRecord);
    lead.push(...records);
    if (!records.length) parentsWithoutUsage++;
  }
  const groups = new Map<string, typeof workers>();
  for (const row of workers) {
    const key = JSON.stringify([
      row.spec.role,
      row.profile?.provider ?? row.usage?.provider ?? null,
      row.profile?.model ?? row.usage?.model ?? null,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return {
    scope:
      'Selected subagents created since the cutoff, plus their distinct parent lead invocations. Parent usage may include other work. Do not sum parent totals across pages. Missing counters are unknown; provider cost estimates are not subscription charges. Native attribution is already inside provider totals. No counterfactual savings are inferred.',
    since,
    limit,
    offset,
    total,
    truncated: offset + rows.length < total,
    totals: totals(workers.map((w) => w.usage)),
    parentLead: { ...totals(lead), parents: parents.size, parentsWithoutUsage },
    groups: [...groups.entries()].map(([key, rows]) => ({
      roleProviderModel: JSON.parse(key),
      ...totals(rows.map((r) => r.usage)),
      statuses: Object.fromEntries(
        ['queued', 'running', 'completed', 'failed', 'cancelled'].map((status) => [
          status,
          rows.filter((r) => r.status === status).length,
        ]),
      ),
      reviews: Object.fromEntries(
        ['accepted', 'rework', 'unused', 'unreviewed'].map((outcome) => [
          outcome,
          rows.filter((r) => (r.profile?.review?.outcome ?? 'unreviewed') === outcome).length,
        ]),
      ),
    })),
    workers,
  };
}
