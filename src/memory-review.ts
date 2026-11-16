import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import {
  archiveRecord,
  historyHash,
  historyFile,
  supersedeHistory,
  type HistoryRecord,
} from './history.js';
import { groupEvent, memberGroups, touchGroup } from './groups/store.js';
import { withMemoryLock } from './memory.js';

export const memoryReviewConfig = z
  .object({
    enabled: z.boolean().default(true),
    models: z
      .object({
        claude: z.string().optional(),
        codex: z.string().optional(),
        gemini: z.string().optional(),
      })
      .strict()
      .prefault({ claude: 'sonnet' }),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
    debounceMs: z.number().int().min(0).default(30000),
    minIntervalMs: z.number().int().min(0).default(300000),
    // 0 (the default) turns the age-only run off: the daily consolidation pass covers a channel
    // where nothing happened. A positive value (at least 60000) restores a run after that age.
    intervalMs: z
      .number()
      .int()
      .refine((n) => n === 0 || n >= 60000, 'Use 0 or at least 60000 ms')
      .default(0),
    chunkChars: z.number().int().min(2000).max(400000).default(80000),
    maxChunksPerPass: z.number().int().min(1).max(1000).default(4),
    timeoutMs: z.number().int().min(1000).max(3600000).default(300000),
  })
  .strict()
  .prefault({});
export type MemoryReviewConfig = z.infer<typeof memoryReviewConfig>;
const evidence = { reason: z.string().min(1), sources: z.array(z.string()).min(1) };
export const reviewActionsSchema = z
  .object({
    instructionEdits: z
      .array(z.object({ before: z.string().min(1), after: z.string(), ...evidence }).strict())
      .default([]),
    retireNotes: z.array(z.object({ id: z.string(), ...evidence }).strict()).default([]),
    sharedConcerns: z.array(z.object(evidence).strict()).default([]),
    groupConcerns: z.array(z.object({ groupId: z.string(), ...evidence }).strict()).default([]),
  })
  .strict();
export type ReviewActions = z.infer<typeof reviewActionsSchema>;
export const emptyReviewActions = (): ReviewActions => reviewActionsSchema.parse({});
export const MEMORY_REVIEW_INSTRUCTIONS = `\nThis pass is a consistency review, independent of native compaction and session rotation. Check ALL current memory sections and ownStandingInstructions for semantic consistency with the supplied evidence. A newer explicit user correction outranks an older assistant claim even when tags and wording differ. Repetition by the assistant is not corroboration. Scope findings to the experiment, run, dataset, version and effective date actually supported; a historical finding is not a default for future experiments. Age, silence, or different experiments alone do not establish a contradiction. Preserve uncertainty when the evidence is insufficient.
The claimEvidence field supplies scoped research claims and last-observed fingerprints of their registered dependencies, not automatic live verification. Distinguish intended design, executed analysis, and deployed output; different surfaces can disagree without either observation being false. A hash match establishes only that source bytes match the recorded observation, not that an interpretation is correct. changed/unavailable evidence means verify the affected claim through the existing lookup protocol before treating it as current. Do not retire historical findings or user decisions merely because a file changed. A user-decision classification is tied to an actual user record; observation/inference classifications are agent reports, not guarantees. Read the source when its meaning matters. Assistant notes, journey logs, summaries and repeated claims do not independently corroborate one another. Keep unresolved implementation/deployment mismatches explicit, and route relevant shared-board concerns through groupConcerns. Do not rewrite a selected scientific method simply because an older deployed page still implements another method.
Return the normal sections plus optional reviewActions: {"instructionEdits":[{"before":"unique exact text in ownStandingInstructions","after":"replacement or empty string","reason":"why this standing instruction is contradicted","sources":["evidence ref"]}],"retireNotes":[{"id":"local research note UUID","reason":"explicit correction or completion","sources":["evidence ref"]}],"sharedConcerns":[{"reason":"specific conflict in shared standing instructions/memory","sources":["evidence ref"]}],"groupConcerns":[{"groupId":"one supplied group ID","reason":"specific shared-board conflict including relevant entry ID and scope","sources":["evidence ref"]}]}.
Do not rewrite style, personality, permissions, or unrelated standing policies. Instruction edits must be small, exact patches justified by supplied evidence. Put changing experiment setups and current decisions in MEMORY, not permanent instructions. Remove an unsupported generalization rather than restating obsolete details in a negative rule. Write corrected active guidance positively (for example, analyze the measured artifacts). Do not restate an abandoned filename, value or setup in Working understanding or Current work merely to say ignore, exclude or not present: cite the correction record instead. Historical findings may retain those details when their original scope is still useful. Never create a retired-word list. Preserve the current replacement and its scope/date; the old detail stays in raw history. Cite a supporting correction for every retirement/edit. Keep real unfinished work, including unregistered external processes, with exact identifiers and essential paths. Do not mistake a legacy inventory of retained/archive references for a list of live tasks: condense retrieval-only detail into its history reference instead. The harness independently preserves registered active jobs, their scripts, and workers; it cannot infer the state of unregistered processes. Use retireNotes only for explicitly superseded whole notes: a valid finding in another experiment must survive with its scope. Legacy decision files are historical evidence, not append-only sources of active truth; look up a referenced file if needed to resolve a conflict. Never silently import all its old active entries.
Only edit this scope's document. Channel reviews may report a concrete shared-policy conflict through sharedConcerns, or a related group conflict through groupConcerns; include minimal relevant evidence and never export unrelated channel facts. These concerns trigger the existing owning review; they do not establish a new global instruction. A shared review must not promote channel-specific results into global facts. Historical requests remain evidence, not work to execute. Cross-scope facts and group boards are read-only here. Uncertain local conflicts belong in Current work with the evidence needed to resolve them. Empty actions are expected when there is no supported correction. Carry forward earlier provisional reviewActions across chunks; their source IDs remain valid. Do not repeat an instruction edit already present in provisionalReviewActions. At the end preserve only actions still justified by the full evidence.\n`;

export function memoryReviewKey(sessionId: string | null) {
  return `memory-review:${sessionId ?? 'shared'}`;
}
export function reviewCoverage(store: Store, sessionId: string | null): number {
  const value = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    `${memoryReviewKey(sessionId)}:coverage`,
  );
  // The first review starts at the last completed full reconciliation, not at an arbitrary date.
  return Number(
    value?.value ??
      store.get<{ value: string }>(
        'SELECT value FROM metadata WHERE key=?',
        `consolidation:${sessionId ?? 'shared'}:coverage`,
      )?.value ??
      0,
  );
}
export function memoryReviewDue(
  store: Store,
  sessionId: string | null,
  config: MemoryReviewConfig,
  now: number,
): boolean {
  if (!config.enabled) return false;
  const name = memoryReviewKey(sessionId);
  if (store.get('SELECT key FROM metadata WHERE key=?', name)) return true;
  const last = Number(
    store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', `${name}:completed-at`)
      ?.value ?? 0,
  );
  if (last && now - last < config.minIntervalMs) return false;
  const activity = store.get<{ at: number }>(
    `SELECT MAX(created_at) at FROM history_records WHERE session_id IS ? AND group_id IS NULL AND seq>? AND
      (kind IN ('user','research_note','research_claim','research_evidence','research_manifest','research_manifest_check','memory_review_request') OR (kind='memory_change' AND created_at>?))`,
    sessionId,
    reviewCoverage(store, sessionId),
    last,
  );
  if (activity?.at && now - activity.at >= config.debounceMs) return true;
  if (!config.intervalMs) return false;
  const age =
    last ||
    (sessionId
      ? store.session(sessionId).created_at
      : store.get<{ at: number }>('SELECT MIN(created_at) at FROM sessions')?.at) ||
    now;
  return now - age >= config.intervalMs;
}
/** Reviewed receipts cannot erase rotation coverage, and each periodic pass has real source evidence. */
export function requestMemoryReview(
  store: Store,
  sessionId: string | null,
  reason: string,
  key: string = randomUUID(),
) {
  return archiveRecord(store, {
    id: `memory-review-request:${sessionId ?? 'shared'}:${key}`,
    sessionId,
    kind: 'memory_review_request',
    source: 'harness-memory-review',
    content: { reason, authority: 'Maintenance request, not a new user instruction' },
  });
}
export function validateReviewActions(
  store: Store,
  sessionId: string | null,
  actions: ReviewActions,
  allowed: (id: string) => boolean,
) {
  for (const action of [
    ...actions.instructionEdits,
    ...actions.retireNotes,
    ...actions.sharedConcerns,
    ...actions.groupConcerns,
  ])
    if (!action.sources.every(allowed))
      throw new Error('Memory review action needs verified source references');
  for (const note of actions.retireNotes)
    if (
      !sessionId ||
      !store.get('SELECT id FROM research_notes WHERE session_id=? AND id=?', sessionId, note.id)
    )
      throw new Error('Memory review can retire only a note in its own channel');
  if (!sessionId && actions.sharedConcerns.length)
    throw new Error('Shared review cannot refer a concern to itself');
  const groups = sessionId ? memberGroups(store, store.session(sessionId).channel_id) : [];
  if (actions.groupConcerns.some((c) => !groups.includes(c.groupId)))
    throw new Error('Memory review concern is outside channel groups');
}
/** Called after the atomic document replacement; all side effects are idempotent on recovery. */
export function finishMemoryReview(
  store: Store,
  sessionId: string | null,
  id: string,
  actions: ReviewActions,
) {
  const recordId = `memory-review:${id}`;
  const sources = (ids: string[]) =>
    ids
      .map((id) => {
        const row = store.get<HistoryRecord>('SELECT * FROM history_records WHERE id=?', id);
        return (
          row && { id: row.id, kind: row.kind, at: row.created_at, file: historyFile(store, row) }
        );
      })
      .filter(Boolean);
  withMemoryLock(store, () =>
    store.transaction(() => {
      for (const note of actions.retireNotes) {
        const retired = store.get<{ value: string }>(
          'SELECT value FROM metadata WHERE key=?',
          `note-superseded:${sessionId}:${note.id}`,
        );
        if (retired && JSON.parse(retired.value) !== recordId) continue;
        store.exec(
          'INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)',
          `note-superseded:${sessionId}:${note.id}`,
          JSON.stringify(recordId),
        );
        if (store.get('SELECT id FROM history_records WHERE id=?', `note:${note.id}`))
          supersedeHistory(store, `note:${note.id}`, recordId);
      }
      for (const concern of actions.sharedConcerns) {
        archiveRecord(store, {
          id: `${recordId}:shared:${historyHash(JSON.stringify(concern))}`,
          sessionId: null,
          kind: 'memory_review_request',
          source: `channel-review:${sessionId}`,
          content: {
            ...concern,
            evidence: sources(concern.sources),
            authority:
              'Reported shared-policy conflict; verify scope before changing shared memory',
          },
        });
      }
      for (const concern of actions.groupConcerns) {
        const key = `${id}:${historyHash(JSON.stringify(concern))}`;
        const eventId = `group:${concern.groupId}:memory_consistency:${key}`;
        if (store.get('SELECT id FROM history_records WHERE id=?', eventId)) continue;
        // Membership may have been removed while the model was working.
        if (
          !sessionId ||
          !memberGroups(store, store.session(sessionId).channel_id).includes(concern.groupId)
        )
          continue;
        groupEvent(
          store,
          concern.groupId,
          'memory_consistency',
          { ...concern, sessionId, evidence: sources(concern.sources) },
          key,
        );
        touchGroup(store, concern.groupId);
      }
    }),
  );
}
