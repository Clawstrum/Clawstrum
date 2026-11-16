import { readInstructionSnapshot, REFRESH_PROTOCOL } from '../instructions.js';
import fs from 'node:fs';
import path from 'node:path';
import { archiveProviderRecord } from '../history.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalPath, configSchema, type Config } from '../config.js';
import type { Store } from '../store.js';
import type { Account, Provider, ProviderName } from '../types.js';
import { AccountPool, classifyError, isModelRefusal } from '../accounts.js';
import { accountEnvironment } from '../providers.js';
import { writePrivate } from '../files.js';
import { bounded, hostTimeZone, readSkills, skillCatalog, skillHints } from '../context.js';
import { abortAfter } from '../async.js';
import { researchWake } from './records.js';
import { researchEnvironment } from './config.js';
import { briefContextSection } from './brief-context.js';
import { memoryFile, parseMemory, RESEARCH_STATE_PLACEHOLDER } from '../memory.js';
import { summarizeChecker, evidenceReader } from './checker.js';
import { summarizeReviewer } from './reviewer.js';
import { reviewSnapshot } from './paper-push.js';
import { workerEvidence, workerFindings } from './validate.js';
import { UsageMeter } from '../usage-ledger.js';
import { patchWorkerProfile, workerProfile, type WorkerProfile } from './worker-profile.js';
import { availableMemory, SUBAGENT_MEMORY_MB, type MemoryReading } from './memory.js';
import { harnessSetup } from '../orchestration.js';
import { DecisionService, decisionsAvailable, decisionEnvironment } from '../decisions/client.js';
import { skillAdvice } from '../decisions/advice.js';
import {
  workerSteers,
  steerWorker,
  updateWorkerSteer,
  closeWorkerSteers,
  type WorkerSteer,
} from './steering.js';
import * as holds from './file-holds.js';

export const delegationSchema = z
  .object({
    role: z.string().min(1),
    provider: z.enum(['claude', 'codex', 'gemini']).optional(),
    model: z.string().min(1).max(200).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    brief: z.string().min(1).max(30000),
    paths: z.array(z.string()).max(100).default([]),
    resumeFrom: z.uuid().optional(),
    reason: z.string().max(1000).optional(),
    context: z.string().max(12000).optional(),
    deliverables: z.array(z.string().max(2000)).max(20).default([]),
    constraints: z.array(z.string().max(2000)).max(20).default([]),
    writePaths: z.array(z.string()).max(100).default([]),
    /** The file a checker or reviewer reads. Absolute, or relative to the workspace. */
    artifact: z.string().min(1).max(4000).optional(),
  })
  .strict();
/**
 * Errors that mean the subagent ran out of a configured limit (steps, tokens, dollars or time). Claude
 * reports its step limit as "Configured Claude turn limit reached (N)" (providers.ts).
 */
export function limitHit(error: string | undefined): boolean {
  return !!error && /budget (exhausted|reached)|turn limit reached/i.test(error);
}
/**
 * A retry of a subagent that ran out of its limit with the same brief tends to run out again, and each
 * retry pays to re-read the same sources.
 */
export const SMALLER_RETRY =
  'This subagent ran out of its limit. Do not rerun the same brief. Give the next subagent (new or resumeFrom) at most half of the unfinished items, list exactly which ones, and point it at the files this subagent already saved so it does not re-read finished sources. Split the rest across later or parallel subagents.';
/** The message a subagent receives when it continues its own conversation after a restart. */
export const RESTART_PROMPT =
  'Clawstrum restarted while you were working. Edits and commands you started may not have finished: check the files and state you were changing, then continue your task.';
/**
 * The message a subagent receives when its account hit a provider quota and Clawstrum moved it, under
 * the same id, to another account. The provider conversation stays with the exhausted account, so
 * this is a fresh context rather than a native session resume: the subagent is pointed at its own
 * prior artifacts instead of being handed restored conversation history.
 */
export const QUOTA_CONTINUE_PROMPT =
  'Clawstrum moved this subagent to a different account after its previous account reached a provider quota. This is a fresh conversation, not a restored one: read BRIEF.md, RESULT.md if present, and EVENTS.jsonl in your working directory, and check actual project state, before continuing. Edits and commands you started may not have finished; do not replay them blindly.';
/**
 * What a subagent is told about the machinery it is running inside.
 *
 * Everything here was already true and none of it was stated. The costly omission is the first
 * paragraph: only the final message's first resultChars reach the lead, so a subagent that ends
 * with "the analysis is in analysis.md" has produced a run whose result the lead has to go and
 * reconstruct. A subagent that does not know where the boundary falls cannot write for it.
 *
 * Deliberately absent: the result is also passed through an evidence and findings check whose
 * output the lead sees as a caveat. Naming a check in the prompt tells the subagent what shape of
 * text satisfies it, which is a different thing from doing the work the check is looking for.
 */
export function workerContract(dir: string, resultChars: number, maxTurns: number): string {
  return [
    'You are a bounded research subagent with full host access. Work only on this brief.',
    'Your reasoning is provided by the configured Claude Code Agent SDK, Codex SDK or Antigravity CLI (ACP) subscription account. Do not launch replacement agents through a shell login, Bedrock or another model API. Experimental subject/judge API calls are a separate operation and require support in the brief; they are not a delegation fallback.',
    `Your final message is the deliverable: its first ${resultChars} characters are what wakes the lead, who reads no further unless something in them sends it there. It is saved to RESULT.md in ${dir}, unless you already wrote a longer report there yourself with the Write tool, in which case RESULT.md is kept as is and your final message is saved to FINAL.md instead. So lead with the answer, give exact evidence paths, say what you verified and how, and name what you could not resolve. Do not end with a pointer to a file and nothing else. Anything that does not fit belongs in a file beside RESULT.md, referenced by absolute path.`,
    `Your working directory is that artifact directory. BRIEF.md there is this brief, EVENTS.jsonl is the running record of this run. Read source material from the supplied paths, keep bulk output in the artifact directory rather than in the result, and persist findings worth outliving this subagent with research_note.`,
    'Use research_subagent_update for meaningful progress or a blocker, and state=report before your final response with summary, evidence paths, verification performed, and uncertainties. Do not poll or report on a timer. A blocked update wakes the lead; it does not pause your resource budget.',
    'You have the brief and the paths, not the conversation they came from. If the brief is underspecified, say so in the result rather than widening the scope to cover the ambiguity. The lead may send a correction while you are running: adopt it and say in the result what changed. Do not send Discord messages and do not start nested Clawstrum subagents.',
    'If AGENTS.md changes while you run, Clawstrum sends you the changed sections. On Claude they arrive as a message that starts "Clawstrum update (not a new task)"; on Codex, as a developer message. Sometimes they come instead as hook context marked CLAWSTRUM_CONTEXT_UPDATE. In every form they come from Clawstrum, not from the person, and replace the matching part of your system prompt: follow them and continue the brief.',
    maxTurns
      ? `Resource budget: ${maxTurns} Claude turns or completed Codex tool items; stop earlier and report partial progress when needed. Save each finished item to your artifact directory as soon as it is done, so a stop at the limit loses nothing finished.`
      : 'No step limit. The lead checks your progress periodically and cancels a subagent that has stopped making progress, so send research_subagent_update when you finish a meaningful piece. Save each finished item to your artifact directory as soon as it is done, so a cancellation loses nothing finished.',
  ].join('\n');
}
export interface Delegation {
  id: string;
  session_id: string;
  parent_run: string | null;
  spec_json: string;
  config_json: string;
  status: string;
  account_id: string | null;
  result_path: string | null;
  summary: string | null;
  error: string | null;
  created_at: number;
}
export function delegate(
  store: Store,
  sessionId: string,
  config: Config,
  key: string,
  input: z.input<typeof delegationSchema>,
  parentRun?: string,
): Delegation & { advisory?: string } {
  if (!config.research.enabled) throw new Error('Enable research.enabled first');
  const spec = delegationSchema.parse(input);
  if (!config.research.workers.roles[spec.role])
    throw new Error(`Unknown research role: ${spec.role}`);
  if (spec.model && !spec.provider)
    throw new Error('A subagent model override needs provider=claude|codex|gemini');
  if (spec.provider && !config.accounts.some((a) => a.provider === spec.provider))
    throw new Error(`No configured ${spec.provider} account for this subagent`);
  if (spec.resumeFrom) {
    const previous = store.get<Delegation>(
      'SELECT * FROM delegations WHERE id=? AND session_id=?',
      spec.resumeFrom,
      sessionId,
    );
    if (!previous || !['completed', 'failed', 'cancelled'].includes(previous.status))
      throw new Error('resumeFrom requires an ended subagent in this conversation');
  }
  spec.paths = spec.paths.map((p) => path.resolve(store.session(sessionId).workspace, p));
  if (spec.artifact)
    spec.artifact = path.resolve(store.session(sessionId).workspace, spec.artifact);
  let advisory: string | undefined;
  if (spec.role === 'checker' || spec.role === 'reviewer') {
    const setting = config.research.workers.review.artifact;
    const missing = !spec.artifact
      ? 'names no artifact'
      : !fs.existsSync(spec.artifact)
        ? `names an artifact that does not exist: ${spec.artifact}`
        : '';
    if (missing && setting === 'deny')
      throw new Error(
        `This ${spec.role} delegation ${missing}. A checker or reviewer reads one existing file; write the plan, result or draft to a file and pass it as artifact (workers.review.artifact=deny).`,
      );
    if (missing && setting === 'advise')
      advisory = `Advisory: this ${spec.role} delegation ${missing}; the ${spec.role} will have only the brief to read.`;
  }
  spec.writePaths = spec.writePaths.map((p) =>
    canonicalPath(path.resolve(store.session(sessionId).workspace, p)),
  );
  const stable = `${sessionId}:worker:${key}`;
  return store.transaction(() => {
    const old = store.get<Delegation>('SELECT * FROM delegations WHERE dedupe_key=?', stable);
    if (old) {
      if (
        JSON.stringify(delegationSchema.parse(JSON.parse(old.spec_json))) !== JSON.stringify(spec)
      )
        throw new Error('Subagent key already names another task');
      return advisory ? { ...old, advisory } : old;
    }
    const id = randomUUID();
    store.exec(
      'INSERT INTO delegations(id,session_id,parent_run,dedupe_key,spec_json,config_json,created_at) VALUES(?,?,?,?,?,?,?)',
      id,
      sessionId,
      parentRun ?? null,
      stable,
      JSON.stringify(spec),
      JSON.stringify(config),
      Date.now(),
    );
    const row = store.get<Delegation>('SELECT * FROM delegations WHERE id=?', id)!;
    return advisory ? { ...row, advisory } : row;
  });
}
/** Declared write scopes coordinate shared files, without imposing a filesystem sandbox. */
export function writeScopesOverlap(left: string[], right: string[]): boolean {
  const contains = (a: string, b: string) => {
    let rel: string;
    try {
      rel = path.relative(canonicalPath(a), canonicalPath(b));
    } catch {
      return true;
    } // A path changed into an unresolved link: serialize, never crash the daemon.
    return (
      rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep))
    );
  };
  return left.some((a) => right.some((b) => contains(a, b) || contains(b, a)));
}
/**
 * Many subagents write a full report to RESULT.md with the Write tool, then end on a short final
 * message ("Done. Here's the short version..."). Writing the final message over RESULT.md loses
 * that report, leaving it findable only inside EVENTS.jsonl. When the subagent's own RESULT.md is
 * longer than its final message and is not just an earlier copy of it, keep RESULT.md as is and
 * save the final message to FINAL.md instead.
 */
export function reconcileResult(
  resultPath: string,
  text: string,
): { finalPath: string; selfWritten?: { chars: number } } {
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(resultPath, 'utf8');
  } catch {
    existing = undefined;
  }
  if (existing !== undefined && existing.length > text.length && existing.trim() !== text.trim()) {
    const finalPath = path.join(path.dirname(resultPath), 'FINAL.md');
    writePrivate(finalPath, text + '\n');
    return { finalPath, selfWritten: { chars: existing.length } };
  }
  writePrivate(resultPath, text + '\n');
  return { finalPath: resultPath };
}
export function workerAccount(
  account: Account,
  role: Config['research']['workers']['roles'][string],
): Account {
  const model = role.models[account.provider];
  return {
    ...account,
    ...(model && model !== account.model ? { model, quotaBuckets: undefined } : {}),
    modelFallbacks: undefined,
    effort: account.provider === 'codex' && role.effort === 'max' ? 'xhigh' : role.effort,
  };
}
export function delegationRole(config: Config, spec: z.output<typeof delegationSchema>) {
  const role = config.research.workers.roles[spec.role]!;
  return {
    ...role,
    models: {
      ...role.models,
      ...(spec.model && spec.provider ? { [spec.provider]: spec.model } : {}),
    },
    effort: spec.effort ?? role.effort,
  };
}
interface Running {
  accountId: string;
  sessionId: string;
  createdAt: number;
  controller: AbortController;
  promise: Promise<void>;
  ready: boolean;
  finished: boolean;
  inject?: (ids: string[], text: string) => boolean;
  pending?: WorkerSteer;
  /** Stopped by a daemon shutdown and left running in the database, to be resumed at startup. */
  held?: boolean;
}
export class ResearchWorkers {
  readonly active = new Map<string, Running>();
  private stopping = false;
  private rolePools = new Map<string, AccountPool>();
  /** Drop cached per-role pools so the next subagent start rebuilds them from config.accounts. */
  resetPools(): void {
    this.rolePools.clear();
  }
  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly pool: AccountPool,
    readonly adapters: Record<ProviderName, Provider>,
    readonly mainUse: (id: string) => number,
    readonly memory: () => MemoryReading = availableMemory,
  ) {}
  /** Start times of recent subagents, whose processes may not show in a memory reading yet. */
  private recentStarts: number[] = [];
  used(id: string) {
    return [...this.active.values()].filter((row) => row.accountId === id).length;
  }
  /** A subagent whose provider conversation can be continued after this restart. */
  private resumable(profile: WorkerProfile | undefined): boolean {
    return (
      !!profile?.providerSession &&
      !!profile.providerAccount &&
      (profile.restarts ?? 0) < this.config.research.workers.restartResumes
    );
  }
  /**
   * Subagents still marked running belonged to the previous daemon. One whose provider conversation
   * id was saved goes back to the queue and continues that conversation (run() sends RESTART_PROMPT),
   * up to workers.restartResumes times; any other fails as interrupted, as before.
   */
  recover() {
    for (const row of this.store.all<Delegation>(
      "SELECT * FROM delegations WHERE status='running'",
    ))
      this.store.transaction(() => {
        const profile = workerProfile(this.store, row.id);
        if (this.resumable(profile)) {
          const restarts = (profile!.restarts ?? 0) + 1;
          const limit = this.config.research.workers.restartResumes;
          this.store.exec(
            "UPDATE delegations SET status='queued' WHERE id=? AND status='running'",
            row.id,
          );
          patchWorkerProfile(this.store, row.id, { restarts, resume: true });
          // An instruction in flight when the daemon stopped may or may not have reached the
          // provider. Queued instructions stay queued and are delivered to the resumed subagent.
          for (const steer of workerSteers(this.store, row.id))
            if (steer.status === 'sending')
              updateWorkerSteer(
                this.store,
                steer,
                'unknown',
                'Clawstrum restarted before the subagent acknowledged this instruction; inspect its artifacts before repeating it',
              );
          this.store.event(row.session_id, null, 'research_worker_resume', {
            id: row.id,
            restarts,
            limit,
            providerSession: profile!.providerSession,
            account: profile!.providerAccount,
          });
          researchWake(
            this.store,
            row.session_id,
            `worker-resume:${row.id}:${restarts}`,
            `Subagent ${row.id} was running when Clawstrum restarted. It has been queued to continue its own provider conversation with its full history (automatic resume ${restarts} of ${limit}), and it is told that edits and commands it had started may not have finished. Its result will wake you as usual; steering and progress checks still apply.`,
          );
          return;
        }
        this.store.exec(
          'UPDATE delegations SET status=?,error=?,ended_at=? WHERE id=?',
          'failed',
          profile?.providerSession && this.config.research.workers.restartResumes
            ? `Daemon interrupted the subagent after ${profile.restarts ?? 0} automatic resumes (limit ${this.config.research.workers.restartResumes}); inspect partial artifacts before retrying`
            : 'Daemon interrupted the subagent; inspect partial artifacts before retrying',
          Date.now(),
          row.id,
        );
        closeWorkerSteers(this.store, row.id);
        holds.releaseFileHolds(this.store, row.id);
        researchWake(
          this.store,
          row.session_id,
          `worker:${row.id}`,
          `Subagent ${row.id} was interrupted. Inspect ${row.result_path ?? 'the workspace research/workers directory'} before creating a new subagent; no automatic replay of edits or external actions.\n${holds.changedFilesReport(this.store, row.id)}`,
        );
      });
  }
  private lastCheckScan = 0;
  /**
   * Wake a lead whose subagents are running, every workers.checkMinutes, with each subagent's state, so
   * the lead can cancel or correct one that has stalled or drifted. This replaces fixed step and time
   * limits, which ended long but healthy subagents. One wake per conversation per interval, and none
   * while the previous one is still waiting to be read.
   */
  progressChecks(now = Date.now()): void {
    const minutes = this.config.research.workers.checkMinutes;
    if (!minutes || now - this.lastCheckScan < 60000) return;
    this.lastCheckScan = now;
    const running = new Map<string, Array<Delegation & { started_at: number | null }>>();
    // A queued subagent is listed only when something it cannot clear itself (memory, account
    // capacity) holds it, so the lead can see why it has not started.
    for (const row of this.store.all<Delegation & { started_at: number | null }>(
      "SELECT * FROM delegations WHERE status IN ('running','queued') ORDER BY started_at, id",
    ))
      if (row.status === 'running' || workerProfile(this.store, row.id)?.waiting)
        running.set(row.session_id, [...(running.get(row.session_id) ?? []), row]);
    for (const [sessionId, rows] of running) {
      const key = `worker-check:${sessionId}`;
      const last = Number(
        this.store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key)?.value ??
          0,
      );
      const oldest = Math.min(...rows.map((r) => r.started_at ?? r.created_at));
      if (now - Math.max(oldest, last) < minutes * 60000) continue;
      if (
        this.store.get(
          "SELECT 1 FROM inbound WHERE session_id=? AND id LIKE 'research:worker-check:%' AND status IN ('queued','running')",
          sessionId,
        )
      )
        continue;
      const ago = (at: number | undefined) =>
        at === undefined ? 'never' : `${Math.round((now - at) / 60000)} min ago`;
      // A stalled subagent can sit through many consecutive progress checks ("last activity
      // 7 min ago" up to "253 min ago") with no reply. An IDLE prefix
      // and a leading sentence make a stalled subagent impossible to read past as fine.
      let idleCount = 0;
      const lines = rows.map((row) => {
        const spec = JSON.parse(row.spec_json) as { role: string; brief: string };
        const profile = workerProfile(this.store, row.id);
        if (row.status === 'queued')
          return [
            `- ${row.id} (${spec.role}), queued ${Math.round((now - row.created_at) / 60000)} min, not started: ${profile?.waiting?.detail}`,
            `  Brief: ${bounded(spec.brief, 200)}`,
          ].join('\n');
        const note = profile?.progress
          ? `last progress note ${ago(profile.progress.at)} (${profile.progress.state}): ${bounded(profile.progress.summary, 300)}`
          : 'no progress note yet';
        const since = profile?.lastActivityAt ?? row.started_at ?? row.created_at;
        const idleMinutes = Math.round((now - since) / 60000);
        const idlePrefix =
          idleMinutes >= 30 ? `IDLE ${idleMinutes} min, no tool call or output: ` : '';
        if (idlePrefix) idleCount++;
        return [
          `- ${idlePrefix}${row.id} (${spec.role}), running ${Math.round((now - (row.started_at ?? row.created_at)) / 60000)} min, ${profile?.toolCalls ?? 0} tool calls, last activity ${ago(profile?.lastActivityAt)}; ${note}`,
          `  Brief: ${bounded(spec.brief, 200)}`,
          `  Record of its steps: ${row.result_path ? path.join(path.dirname(row.result_path), 'EVENTS.jsonl') : 'not created yet'}`,
        ].join('\n');
      });
      const idleNotice = idleCount
        ? `${idleCount} subagent(s) marked IDLE have done nothing for 30+ minutes. Steer each one or stop it in this turn; do not reply CLAWSTRUM_QUIET while one is IDLE.\n`
        : '';
      this.store.transaction(() => {
        this.store.exec(
          'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          key,
          String(now),
        );
        researchWake(
          this.store,
          sessionId,
          `worker-check:${sessionId}:${now}`,
          `Subagent progress check (every ${minutes} minutes while subagents run; subagents have no step or time limit, so this check is what stops a bad one). For each subagent decide: leave it running, correct it with research_steer, or stop it with research_status collection=subagents id=<id> cancelWorker=true. Stop or correct a subagent that has had no activity for a long time, keeps repeating the same steps, has drifted from its brief, or has used far more steps than its brief should need; read the end of its step record when unsure. Tell the people here only what you stopped or corrected and why. A queued subagent listed as not started waits for the reason shown and starts by itself when it clears. If every subagent is fine, reply with only CLAWSTRUM_QUIET.\n${idleNotice}${lines.join('\n')}`,
        );
        this.store.event(sessionId, null, 'research_worker_check', {
          workers: rows.map((r) => r.id),
          minutes,
        });
      });
    }
  }
  tick() {
    if (this.stopping || !this.config.research.enabled) return;
    this.progressChecks();
    for (const cancelled of this.store.all<{ id: string }>(
      "SELECT id FROM delegations WHERE status='cancelled'",
    )) {
      const active = this.active.get(cancelled.id);
      if (active) {
        active.controller.abort(new Error('Subagent cancelled'));
        closeWorkerSteers(this.store, cancelled.id);
      }
    }
    for (const [id, state] of this.active) this.drainSteering(id, state);
    let reading: MemoryReading | undefined;
    for (const row of this.store.all<Delegation>(
      "SELECT * FROM delegations WHERE status='queued' ORDER BY created_at LIMIT 100",
    )) {
      if (this.active.size >= this.config.research.workers.maxConcurrent) break;
      const session = this.store.session(row.session_id);
      const excluded = new Set(
        this.config.accounts
          .filter(
            (a) =>
              this.mainUse(a.id) + this.used(a.id) >=
              (a.maxConcurrent ?? this.config.runtime.maxConcurrent),
          )
          .map((a) => a.id),
      );
      const saved = configSchema.parse(JSON.parse(row.config_json));
      const spec = delegationSchema.parse(JSON.parse(row.spec_json));
      if (
        spec.writePaths.length &&
        this.store
          .all<{ spec_json: string }>("SELECT spec_json FROM delegations WHERE status='running'")
          .some((other) =>
            writeScopesOverlap(spec.writePaths, JSON.parse(other.spec_json).writePaths ?? []),
          )
      )
        continue;
      const floor = this.config.research.workers.minFreeMemoryMB;
      if (floor) {
        // A subagent started in the last minute may not have reached its full size yet, so it is
        // counted at its measured cost on top of the reading.
        const now = Date.now();
        this.recentStarts = this.recentStarts.filter((at) => now - at < 60000);
        reading ??= this.memory();
        const free = reading.availableMB - this.recentStarts.length * SUBAGENT_MEMORY_MB;
        if (free < floor) {
          this.waiting(
            row,
            'memory',
            `not enough free memory (${free} MB available after counting ${this.recentStarts.length} subagent(s) started in the last minute at ${SUBAGENT_MEMORY_MB} MB each, limit set by ${reading.source}; workers.minFreeMemoryMB is ${floor})`,
          );
          continue;
        }
      }
      const profile = workerProfile(this.store, row.id);
      // A resumed subagent's conversation is stored under its account's home, so only that account
      // can continue it.
      const pinned = profile?.resume ? profile.providerAccount : undefined;
      if (pinned && !this.config.accounts.some((a) => a.id === pinned)) {
        this.store.transaction(() => {
          this.store.exec(
            "UPDATE delegations SET status='failed',error=?,ended_at=? WHERE id=? AND status='queued'",
            `Account ${pinned}, which holds this subagent's conversation, is no longer configured; it cannot be resumed after the restart`,
            Date.now(),
            row.id,
          );
          closeWorkerSteers(this.store, row.id);
          researchWake(
            this.store,
            row.session_id,
            `worker:${row.id}`,
            `Subagent ${row.id} could not be resumed after the restart: account ${pinned} is no longer configured. Inspect ${row.result_path ?? 'the workspace research/workers directory'} before creating a new subagent.`,
          );
        });
        continue;
      }
      // Select on the subagent model's entitlements, before choosing an account. Keep the lead's
      // known bucket catalog so an Opus-only cooldown need not block a Haiku subagent.
      const role = delegationRole(saved, spec);
      const poolKey = JSON.stringify({ role, provider: spec.provider });
      let pool = this.rolePools.get(poolKey);
      if (!pool) {
        pool = new AccountPool(
          this.config.accounts
            .filter((a) => !spec.provider || a.provider === spec.provider)
            .map((a) => workerAccount(a, role)),
          this.store,
          this.pool.cooldownMs,
          this.pool.strainThreshold,
          this.config.accounts,
        );
        this.rolePools.set(poolKey, pool);
      }
      if (pinned) for (const a of this.config.accounts) if (a.id !== pinned) excluded.add(a.id);
      // An account that answered this explicit model request with model_not_found will answer the
      // same way again, so it is skipped for this delegation only; other models still use it.
      const refused = new Set(profile?.modelRefusedBy ?? []);
      for (const id of refused) excluded.add(id);
      const account = pool.choose(
        pinned ?? saved.research.workers.account ?? session.preferred_account,
        pinned ? null : session.active_account,
        excluded,
      );
      if (!account) {
        if (
          pinned ||
          pool.choose(
            saved.research.workers.account ?? session.preferred_account,
            session.active_account,
            refused,
          )
        )
          this.waiting(
            row,
            'capacity',
            pinned
              ? `waiting for account ${pinned}, which holds its conversation, to have a free slot or quota`
              : 'every eligible account is at its maxConcurrent, counting lead conversations and other subagents',
          );
        else
          researchWake(
            this.store,
            row.session_id,
            `research-capacity:${row.session_id}:${Math.floor(Date.now() / 3600000)}:${row.id}`,
            `Research subagent ${row.id} is queued for ${spec.provider ?? 'a configured provider'}${spec.model ? ` / ${spec.model}` : ` using the ${spec.role} role model`}: no eligible account is available. Explicit model requests are preserved. Use research_status to inspect or cancel it.`,
          );
        continue;
      }
      if (
        !this.store.exec(
          "UPDATE delegations SET status='running',account_id=?,started_at=COALESCE(started_at,?) WHERE id=? AND status='queued'",
          account.id,
          Date.now(),
          row.id,
        ).changes
      )
        continue;
      this.recentStarts.push(Date.now());
      if (profile?.waiting) patchWorkerProfile(this.store, row.id, { waiting: undefined });
      const state: Running = {
        accountId: account.id,
        sessionId: row.session_id,
        createdAt: row.created_at,
        controller: new AbortController(),
        promise: Promise.resolve(),
        ready: false,
        finished: false,
      };
      this.active.set(row.id, state);
      state.promise = this.run(row, saved, account, state)
        .catch((error) => {
          this.store.event(row.session_id, null, 'research_worker_error', {
            id: row.id,
            error: String(error),
          });
          this.store.transaction(() => {
            this.store.exec(
              "UPDATE delegations SET status='failed',error=?,ended_at=? WHERE id=? AND status='running'",
              String(error),
              Date.now(),
              row.id,
            );
            holds.releaseFileHolds(this.store, row.id);
            researchWake(
              this.store,
              row.session_id,
              `worker:${row.id}`,
              `Subagent ${row.id} failed while recording its result: ${String(error)}. Inspect its artifacts.`,
            );
          });
        })
        .finally(() => {
          state.finished = true;
          if (!state.held) closeWorkerSteers(this.store, row.id);
          this.active.delete(row.id);
        });
    }
  }
  /** Record once per reason why a queued subagent did not start; the progress check shows it. */
  private waiting(row: Delegation, reason: 'memory' | 'capacity', detail: string) {
    const profile = workerProfile(this.store, row.id);
    if (profile?.waiting?.reason === reason) return;
    patchWorkerProfile(this.store, row.id, { waiting: { reason, detail, since: Date.now() } });
    this.store.event(row.session_id, null, 'research_worker_waiting', {
      id: row.id,
      reason,
      detail,
    });
  }
  private drainSteering(id: string, state: Running) {
    if (
      !state.ready ||
      state.finished ||
      state.pending ||
      !state.inject ||
      state.controller.signal.aborted
    )
      return;
    const next = workerSteers(this.store, id).find((r) => r.status === 'queued');
    if (!next || !updateWorkerSteer(this.store, next, 'sending')) return;
    state.pending = next;
    try {
      if (state.inject([next.id], next.message)) return;
      updateWorkerSteer(this.store, next, 'rejected', 'Provider is no longer accepting live input');
    } catch (error) {
      updateWorkerSteer(
        this.store,
        next,
        'unknown',
        `Delivery threw before acknowledgment: ${String(error)}`,
      );
    }
    state.pending = undefined;
  }
  // Parsed straight from the file: observeMemory would archive a revision as a side effect, and a
  // missing or malformed AGENTS.md means no notes, never a created or repaired file.
  private researchNotes(sessionId: string, limit: number): string {
    let doc;
    try {
      doc = parseMemory(fs.readFileSync(memoryFile(this.store, sessionId), 'utf8'));
    } catch {
      return '';
    }
    const section = doc.sections.find((s) => s.name === 'Research state');
    const body = section
      ? doc.text.slice(section.body, section.end).replace(RESEARCH_STATE_PLACEHOLDER, '').trim()
      : '';
    return body ? bounded(body, limit, true) : '';
  }
  private async run(row: Delegation, config: Config, account: Account, state: Running) {
    const spec = delegationSchema.parse(JSON.parse(row.spec_json));
    const role = delegationRole(config, spec);
    const session = this.store.session(row.session_id);
    const startedAt = Date.now();
    const fileHolds = config.research.workers.fileHolds;
    const dir = path.join(session.workspace, 'research', 'workers', row.id);
    const resultPath = path.join(dir, 'RESULT.md');
    const partialPath = path.join(dir, 'EVENTS.jsonl');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Set by recover(): continue this subagent's own provider conversation after a restart.
    const before = workerProfile(this.store, row.id);
    const resumeId = before?.resume ? before.providerSession : undefined;
    // Set by the quota-continue handling in the catch block below: this subagent's previous account
    // hit a provider quota, another account was free, and it was requeued under the same id. The
    // provider conversation stays with the exhausted account, so this is a fresh context, not a
    // native session resume.
    const quotaContinuing = !!before?.quotaContinuing;
    const priorTools = resumeId || quotaContinuing ? (before?.toolCalls ?? 0) : 0;
    const prior = spec.resumeFrom
      ? this.store.get<Delegation>(
          'SELECT * FROM delegations WHERE id=? AND session_id=?',
          spec.resumeFrom,
          row.session_id,
        )
      : undefined;
    const continuation = prior
      ? `\nExplicit continuation of subagent ${prior.id} (${prior.status}). Previous artifacts: ${path.join(session.workspace, 'research', 'workers', prior.id)}. Read BRIEF.md, RESULT.md and EVENTS.jsonl there and inspect actual project state before acting. Prior commands may have succeeded; do not replay them blindly. This is a fresh context with its own resource budget.\nPrevious summary: ${bounded(prior.summary ?? prior.error ?? '', 4000)}\n`
      : '';
    const instructionSources = {
      memoryMode: 'references' as const,
      home: this.store.home,
      workspace: session.workspace,
      parentWorkspace: this.store.parentWorkspace(session),
      profile: account.home,
      maxChars: Math.max(2000, Math.floor(config.runtime.promptChars * 0.6) - 4000),
    };
    const instructionSnapshot = readInstructionSnapshot(instructionSources);
    // The lead is given every installed skill because it decides what the turn is. A subagent has one
    // brief, so it gets the subset its role names, resolved against the same two directories. This
    // is how a workflow the role always wants stops having to be restated in every brief.
    const installed = readSkills([
      path.join(this.store.home, 'skills'),
      path.join(session.workspace, 'skills'),
    ]);
    const roleSkills = installed.filter((skill) => role.skills.includes(skill.name));
    const missingSkills = role.skills.filter((name) => !roleSkills.some((s) => s.name === name));
    const catalog = roleSkills.length
      ? `\n\nSkills available to this role:\n${skillCatalog(roleSkills, path.join(dir, 'SKILLS.txt'))}`
      : '';
    // Matched against the brief rather than a conversation, because the brief is the whole of what
    // this subagent was asked. Appended to the prompt, never the instructions: the instruction text
    // feeds the revision check that decides whether the provider needs a refresh.
    const semanticHint =
      !resumeId &&
      roleSkills.length &&
      config.decisions.skills &&
      decisionsAvailable(config.decisions)
        ? await skillAdvice(
            new DecisionService(this.store, config.decisions),
            roleSkills,
            spec.brief,
            {
              scope: `channel:${row.session_id}`,
              sessionId: row.session_id,
              workerId: row.id,
              runId: row.parent_run ?? undefined,
              signal: state.controller.signal,
            },
          )
        : { decided: false, text: '' };
    const hints = semanticHint.decided
      ? semanticHint.text
      : [skillHints(roleSkills, spec.brief), semanticHint.text].filter(Boolean).join('\n\n');
    const artifact =
      (spec.role === 'checker' || spec.role === 'reviewer') &&
      spec.artifact &&
      fs.existsSync(spec.artifact)
        ? `Artifact under review: ${spec.artifact}\n`
        : '';
    // An explicit resumeFrom continuation already points the subagent at the prior BRIEF.md
    // (built with this same section, since the change that added it), so it is not rebuilt here.
    const contextSection = prior
      ? ''
      : briefContextSection(
          this.store,
          row.session_id,
          session.workspace,
          config.research.workers.briefContext,
          config.name,
          config.runtime.timezone ?? hostTimeZone(),
        );
    const brief = `${artifact}Role: ${spec.role}\nTask: ${spec.brief}\nWhy delegated: ${spec.reason ?? 'Bounded specialist task'}\nRelevant context and corrections: ${spec.context ?? 'Read only sources needed for the brief'}\nDeliverables / acceptance checks:\n${spec.deliverables.join('\n') || 'Answer with evidence, verification and uncertainties'}\nConstraints:\n${spec.constraints.join('\n') || 'Stay within the assigned task'}\nDeclared write scopes:\n${spec.writePaths.join('\n') || 'None declared; coordinate changes with the lead'}\nSupplied project paths:\n${spec.paths.join('\n') || session.workspace}\nParent workspace: ${session.workspace}\nSubagent artifacts: ${dir}\n${continuation}${contextSection}`;
    if (resumeId)
      fs.appendFileSync(
        partialPath,
        JSON.stringify({
          at: Date.now(),
          type: 'restart_resume',
          detail: { providerSession: resumeId, restarts: before?.restarts },
        }) + '\n',
        { mode: 0o600 },
      );
    else if (quotaContinuing)
      fs.appendFileSync(
        partialPath,
        JSON.stringify({
          at: Date.now(),
          type: 'quota_continue_resume',
          detail: { from: before?.quotaFromAccount, continues: before?.quotaContinues },
        }) + '\n',
        { mode: 0o600 },
      );
    else {
      writePrivate(path.join(dir, 'BRIEF.md'), brief);
      writePrivate(partialPath, '');
    }
    this.store.exec('UPDATE delegations SET result_path=? WHERE id=?', resultPath, row.id);
    const routed = workerAccount(account, role);
    const notes =
      (spec.role === 'checker' || spec.role === 'reviewer') &&
      config.research.workers.review.notesChars > 0
        ? this.researchNotes(row.session_id, config.research.workers.review.notesChars)
        : '';
    this.store.event(row.session_id, null, 'research_worker_route', {
      id: row.id,
      role: spec.role,
      account: routed.id,
      model: routed.model ?? 'provider default',
      provider: routed.provider,
      maxTurns: role.maxTurns,
      timeoutMs: config.research.workers.timeoutMs,
      skills: roleSkills.map((skill) => skill.name),
      // A role naming a skill this installation does not have is a configuration mismatch, not a
      // reason to fail the dispatch. It is recorded because the alternative is a role that silently
      // loses the workflow it was written around.
      skillsMissing: missingSkills,
      requestedProvider: spec.provider,
      requestedModel: spec.model,
      notesChars: notes.length,
      ...(resumeId ? { resumedSession: resumeId, restarts: before?.restarts } : {}),
      ...(quotaContinuing
        ? { quotaContinueFrom: before?.quotaFromAccount, quotaContinues: before?.quotaContinues }
        : {}),
    });
    if (quotaContinuing)
      researchWake(
        this.store,
        row.session_id,
        `worker-quota-continue:${row.id}:${before?.quotaContinues}`,
        `Subagent ${row.id} moved from ${before?.quotaFromAccount} to ${routed.id} after ${before?.quotaFromAccount} reached its provider quota; it continues from its saved record (continuation ${before?.quotaContinues} of ${config.research.workers.quotaContinues}).`,
      );
    const source = fileURLToPath(import.meta.url);
    const dev = source.endsWith('.ts');
    const cli = path.resolve(path.dirname(source), '..', dev ? 'cli.ts' : 'cli.js');
    const timer = config.research.workers.timeoutMs
      ? setTimeout(
          () => state.controller.abort(new Error('Research subagent time budget exhausted')),
          config.research.workers.timeoutMs,
        )
      : undefined;
    const notesBlock = notes
      ? `\n\nResearch notes (Research state section of ${memoryFile(this.store, row.session_id)}, as of this dispatch):\n${notes}`
      : '';
    const prompt = resumeId
      ? RESTART_PROMPT
      : quotaContinuing
        ? QUOTA_CONTINUE_PROMPT
        : `${brief}\n\n${instructionSnapshot.memory}${notesBlock}${hints ? `\n\n${hints}` : ''}`;
    const instructions = `${REFRESH_PROTOCOL}\n${instructionSnapshot.instructions}\n${harnessSetup(routed, config.research, true)}\n${role.prompt}${catalog}\n${workerContract(dir, config.research.workers.resultChars, role.maxTurns)}`;
    patchWorkerProfile(this.store, row.id, {
      provider: routed.provider,
      model: routed.model,
      promptChars: prompt.length,
      instructionChars: instructions.length,
      toolCalls: priorTools,
      lastActivityAt: Date.now(),
      resume: false,
      quotaContinuing: false,
    });
    let savedSession = before?.providerSession;
    const toolsSeen = new Set<string>();
    let lastPersisted = 0;
    const usage: unknown[] = [];
    let text = '';
    let error: string | null = null;
    let usageMeter: UsageMeter | undefined;
    // Set in the catch block below when a provider quota failure is handled by requeuing this
    // delegation, under the same id, onto another account rather than recording a terminal result.
    let quotaContinued = false;
    // Set in the catch block when an account refused the explicit model and the delegation was
    // requeued onto an account that has not refused it yet.
    let modelRerouted = false;
    try {
      if (role.maxBudgetUsd && account.provider !== 'claude')
        throw new Error(
          'maxBudgetUsd requires Claude native estimated-cost enforcement; configure maxTokens for Codex or select a Claude subagent account',
        );
      usageMeter = new UsageMeter(this.store, {
        id: resumeId
          ? `worker:${row.id}:restart${before?.restarts}`
          : quotaContinuing
            ? `worker:${row.id}:quota${before?.quotaContinues}`
            : `worker:${row.id}`,
        sessionId: row.session_id,
        runId: row.parent_run ?? undefined,
        workerId: row.id,
        role: spec.role,
        account: routed.id,
        provider: routed.provider,
        model: routed.model,
      });
      text = await abortAfter(
        this.adapters[account.provider].run({
          account: routed,
          liveInput: true,
          subagent: true,
          role: spec.role,
          sandbox: {
            ...config.sandbox,
            accountHomes: config.accounts.map((a) => a.home),
            workspace: session.workspace,
          },
          maxBudgetUsd: role.maxBudgetUsd,
          prompt,
          sessionId: resumeId,
          contextRefresh: { sources: instructionSources, snapshot: instructionSnapshot },
          // The contract goes last because the skills do not know they are being read by a subagent:
          // several are written for a lead and recommend delegating, which a subagent cannot do. The
          // contract's own prohibition is then the most recent thing the subagent was told.
          instructions,
          cwd: dir,
          controller: state.controller,
          env: accountEnvironment(routed, config.accounts),
          research: config.research,
          maxTurns: role.maxTurns || undefined,
          attachInjector: (inject) => {
            state.inject = inject;
          },
          abortGraceMs: config.runtime.abortGraceMs,
          inputReleaseGraceMs: config.runtime.inputReleaseGraceMs,
          blockedVersions: config.runtime.blockedVersions,
          mcp: {
            command: process.execPath,
            args: dev ? ['--import', import.meta.resolve('tsx'), cli, 'mcp'] : [cli, 'mcp'],
            env: {
              ...decisionEnvironment(config.decisions),
              ...researchEnvironment(config.research),
              CLAWSTRUM_HOME: this.store.home,
              CLAWSTRUM_SESSION: session.id,
              CLAWSTRUM_DELEGATION: row.id,
            },
          },
          onEvent: (event) => {
            if (state.controller.signal.aborted && event.type !== 'history') return;
            if (event.type === 'history') {
              archiveProviderRecord(this.store, row.session_id, event.detail);
              return;
            }
            // Saved as soon as the provider names its conversation, so a restart can resume it.
            if (event.type === 'session' && event.sessionId && event.sessionId !== savedSession) {
              savedSession = event.sessionId;
              patchWorkerProfile(this.store, row.id, {
                providerSession: event.sessionId,
                providerAccount: routed.id,
              });
            }
            if (event.tool?.id) toolsSeen.add(event.tool.id);
            if (fileHolds && event.type === 'activity')
              this.codexFileChange(row, dir, event.detail);
            if (Date.now() - lastPersisted >= 5000 || event.tool || event.type === 'completed') {
              patchWorkerProfile(this.store, row.id, {
                lastActivityAt: Date.now(),
                lastEvent: event.type,
                toolCalls: priorTools + toolsSeen.size,
              });
              lastPersisted = Date.now();
            }
            if (event.type === 'session' || event.type === 'ready') state.ready = true;
            if (event.type === 'completed') state.finished = true;
            if (event.type === 'injected') {
              const ack = event.detail as
                | { ids?: unknown; ok?: unknown; uncertain?: unknown }
                | undefined;
              const pending = state.pending;
              if (
                pending &&
                Array.isArray(ack?.ids) &&
                ack.ids.length === 1 &&
                ack.ids[0] === pending.id &&
                typeof ack.ok === 'boolean'
              ) {
                updateWorkerSteer(
                  this.store,
                  pending,
                  ack.ok ? 'accepted' : ack.uncertain === true ? 'unknown' : 'rejected',
                  ack.ok
                    ? undefined
                    : ack.uncertain === true
                      ? 'Delivery was not acknowledged; inspect artifacts before repeating the instruction'
                      : 'Provider rejected live input',
                );
                state.pending = undefined;
              }
            }
            if (event.type === 'usage') usage.push(event.detail);
            if (event.usage) {
              usageMeter?.observe(event.usage);
              // Persist progress before aborting, including when the supervisor must kill a subagent.
              this.store.exec(
                'UPDATE delegations SET usage_json=? WHERE id=?',
                JSON.stringify(usage),
                row.id,
              );
            }
            if (event.quota)
              this.pool.quota(routed, event.quota, config.runtime.proactiveThreshold);
            fs.appendFileSync(
              partialPath,
              JSON.stringify({
                at: Date.now(),
                ...event,
                detail:
                  event.detail === undefined
                    ? undefined
                    : bounded(JSON.stringify(event.detail), 12000),
              }) + '\n',
              { mode: 0o600 },
            );
            if (
              role.maxTokens &&
              event.usage?.totals.totalTokens !== null &&
              event.usage?.totals.totalTokens !== undefined &&
              event.usage.totals.totalTokens >= role.maxTokens
            )
              state.controller.abort(
                new Error(
                  `Research subagent observed token budget exhausted (${event.usage.totals.totalTokens}/${role.maxTokens}); inspect partial artifacts`,
                ),
              );
          },
        }),
        state.controller.signal,
        config.runtime.abortGraceMs + 2500,
      );
      state.controller.signal.throwIfAborted();
      if (!text.trim()) throw new Error('Subagent ended without a result');
    } catch (e) {
      const failure = classifyError(e);
      error = failure.message;
      if (failure.kind === 'quota' || failure.kind === 'auth') this.pool.fail(routed, failure);
      // The account the subagent was on is already on cooldown from pool.fail above, so the live
      // config's own accounts (not this delegation's saved snapshot) decide whether routing has
      // anywhere else to send it, the same source tick() uses to build each role/provider pool.
      if (failure.kind === 'quota' && !this.stopping) {
        const cap = config.research.workers.quotaContinues;
        const already = before?.quotaContinues ?? 0;
        const elsewhere = this.config.accounts.some(
          (a) => (!spec.provider || a.provider === spec.provider) && a.id !== routed.id,
        );
        if (elsewhere && already < cap) {
          quotaContinued = true;
          this.store.transaction(() => {
            this.store.exec(
              "UPDATE delegations SET status='queued' WHERE id=? AND status='running'",
              row.id,
            );
            patchWorkerProfile(this.store, row.id, {
              quotaContinuing: true,
              quotaContinues: already + 1,
              quotaFromAccount: routed.id,
              waiting: undefined,
            });
          });
        } else if (!elsewhere) {
          error = `The ${routed.id} account reached its provider quota; no other account was free.${failure.retryAt ? ` It resets at ${new Date(failure.retryAt).toISOString()}.` : ''}`;
        } else {
          error = `${error} The subagent's automatic quota-continuation limit (${already} of ${cap}) has been reached; inspect partial artifacts before retrying.`;
        }
      }
      // An explicit model request is never downgraded. When the account says it does not have that
      // model, try the other accounts of the same provider and fail only when all have refused.
      if (
        spec.model &&
        spec.provider &&
        isModelRefusal(failure) &&
        !this.stopping &&
        !resumeId &&
        !state.controller.signal.aborted
      ) {
        const refusedBy = [...new Set([...(before?.modelRefusedBy ?? []), routed.id])];
        const eligible = this.config.accounts.filter((a) => a.provider === spec.provider);
        const untried = eligible.filter((a) => !refusedBy.includes(a.id));
        if (untried.length) {
          modelRerouted = true;
          this.store.transaction(() => {
            this.store.exec(
              "UPDATE delegations SET status='queued' WHERE id=? AND status='running'",
              row.id,
            );
            patchWorkerProfile(this.store, row.id, {
              modelRefusedBy: refusedBy,
              quotaContinuing,
              waiting: undefined,
            });
          });
        } else {
          const names = eligible.map((a) => a.id);
          error = `${spec.model} was refused by ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]} (${failure.message}). The requested model was not replaced with another one; ask for a model these accounts can use, or sign in an account that has access to ${spec.model}.`;
          patchWorkerProfile(this.store, row.id, { modelRefusedBy: refusedBy });
        }
      }
      text = `Subagent stopped: ${error}\nPartial tool work and output: ${partialPath}\nInspect actual files before repeating any action.\n${limitHit(error) ? `${SMALLER_RETRY}\n` : ''}${text}`;
    } finally {
      // A daemon shutdown leaves a subagent whose conversation can be continued marked running, so
      // recover() at the next start queues it to resume. Its queued steering stays queued. A quota
      // failure handled above by requeuing onto another account holds the same way: neither records
      // a terminal result here.
      const stoppingHeld =
        this.stopping &&
        !!error &&
        this.store.get<{ status: string }>('SELECT status FROM delegations WHERE id=?', row.id)
          ?.status === 'running' &&
        this.resumable(workerProfile(this.store, row.id));
      state.held = stoppingHeld || quotaContinued || modelRerouted;
      usageMeter?.finish(
        state.controller.signal.aborted ? 'interrupted' : error ? 'failed' : 'completed',
      );
      state.finished = true;
      if (!state.held) closeWorkerSteers(this.store, row.id);
      clearTimeout(timer);
    }
    if (state.held) {
      const continuedProfile =
        quotaContinued || modelRerouted ? workerProfile(this.store, row.id) : undefined;
      fs.appendFileSync(
        partialPath,
        JSON.stringify({
          at: Date.now(),
          type: modelRerouted
            ? 'model_refused_requeued'
            : quotaContinued
              ? 'quota_continue_queued'
              : 'held_for_restart',
          detail: {
            error,
            ...(modelRerouted ? { refusedBy: continuedProfile?.modelRefusedBy } : {}),
          },
        }) + '\n',
        { mode: 0o600 },
      );
      this.store.event(
        row.session_id,
        null,
        modelRerouted
          ? 'research_worker_model_refused_requeued'
          : quotaContinued
            ? 'research_worker_quota_continue_queued'
            : 'research_worker_held',
        modelRerouted
          ? { id: row.id, model: spec.model, refusedBy: continuedProfile?.modelRefusedBy, error }
          : quotaContinued
            ? {
                id: row.id,
                error,
                from: continuedProfile?.quotaFromAccount,
                continues: continuedProfile?.quotaContinues,
              }
            : { id: row.id, error },
      );
      return;
    }
    const kept = reconcileResult(resultPath, text);
    const summary = bounded(text, config.research.workers.resultChars);
    const profile = patchWorkerProfile(this.store, row.id, {
      resultChars: text.length,
      returnedChars: summary.length,
      toolCalls: priorTools + toolsSeen.size,
    });
    writePrivate(
      path.join(dir, 'REPORT.json'),
      JSON.stringify(
        {
          version: 1,
          workerId: row.id,
          workerReport: workerProfile(this.store, row.id)?.progress,
          finalResult: resultPath,
          ...(kept.selfWritten ? { finalMessage: kept.finalPath } : {}),
          summary,
          error,
          profile,
        },
        null,
        2,
      ) + '\n',
    );
    // Checked against the runtime's own event log rather than the subagent's prose. A failed subagent
    // already reports the failure, and its text is the runtime's message, so there is nothing there
    // to check. The event is written either way: an unrecorded zero is why the previous deployment's
    // validator went months without anyone noticing it never matched anything.
    const evidence = workerEvidence(partialPath, spec.paths);
    const findings = error ? [] : workerFindings(text, evidence);
    this.store.event(row.session_id, null, 'research_worker_result', {
      id: row.id,
      role: spec.role,
      failed: Boolean(error),
      toolEvents: evidence.toolEvents,
      suppliedPaths: evidence.suppliedPaths.length,
      suppliedPathsSeen: evidence.suppliedPathsSeen,
      findings,
    });
    const bases = [session.workspace, ...(spec.artifact ? [path.dirname(spec.artifact)] : [])];
    const checked =
      error || (spec.role !== 'checker' && spec.role !== 'reviewer')
        ? undefined
        : spec.role === 'checker'
          ? {
              type: 'research_checker_result',
              ...summarizeChecker(text, bases, evidenceReader(dir)),
            }
          : {
              type: 'research_reviewer_result',
              ...summarizeReviewer(text, bases, evidenceReader(dir)),
            };
    if (checked)
      this.store.event(row.session_id, null, checked.type, {
        id: row.id,
        artifact: spec.artifact,
        ...reviewSnapshot(spec.artifact),
        ...checked.record,
      });
    const caveat = findings.length
      ? `Checks on this result, which the subagent did not write:\n${findings.map((f) => `- ${f}`).join('\n')}\n`
      : '';
    let gitSkipped: string[] = [];
    // Skipped while the daemon stops, so shutdown does not wait on git.
    if (fileHolds && spec.writePaths.length && !this.stopping)
      try {
        const changed = await holds.gitChangedFiles(spec.writePaths, startedAt);
        for (const file of changed.files) holds.recordWorkerFile(this.store, row.id, file, 'git');
        gitSkipped = changed.skipped;
      } catch (e) {
        gitSkipped = [String(e)];
      }
    this.store.transaction(() => {
      const cancelled =
        this.store.get<{ status: string }>('SELECT status FROM delegations WHERE id=?', row.id)
          ?.status === 'cancelled';
      this.store.exec(
        'UPDATE delegations SET status=?,result_path=?,summary=?,usage_json=?,error=?,ended_at=? WHERE id=?',
        cancelled ? 'cancelled' : error ? 'failed' : 'completed',
        resultPath,
        summary,
        JSON.stringify(usage),
        error,
        Date.now(),
        row.id,
      );
      holds.releaseFileHolds(this.store, row.id);
      const files = fileHolds
        ? `\n\n${holds.changedFilesReport(this.store, row.id, { gitScopes: spec.writePaths.length, skipped: gitSkipped })}`
        : '';
      const keptNote = kept.selfWritten
        ? `\n${resultPath} (${kept.selfWritten.chars} chars) holds a longer self-written report and was kept; the final message above was saved to ${kept.finalPath} (${text.length} chars).`
        : '';
      if (!cancelled)
        researchWake(
          this.store,
          row.session_id,
          `worker:${row.id}`,
          `Subagent ${row.id} (${spec.role}) ${error ? 'failed' : 'completed'}. Full result: ${resultPath}\n${caveat}${summary}${keptNote}${checked ? `\n\n${checked.block}` : ''}${files}`,
        );
    });
  }
  /**
   * Codex applies a file change without asking (approval_policy never), so Clawstrum sees it only as
   * it happens and cannot refuse it. Record the change, take the hold if it is free, and when another
   * running subagent holds the file, tell this one through live steering and leave the overlap to
   * the completion wake.
   */
  private codexFileChange(row: Delegation, cwd: string, item: unknown) {
    const change = item as { type?: unknown; changes?: Array<{ path?: unknown }> };
    if (!['fileChange', 'file_change'].includes(String(change?.type))) return;
    for (const entry of Array.isArray(change.changes) ? change.changes : []) {
      if (typeof entry?.path !== 'string' || !entry.path) continue;
      const file = holds.holdPath(entry.path, cwd);
      holds.recordWorkerFile(this.store, row.id, file, 'codex');
      const holder = holds.acquireFileHold(this.store, row.id, file);
      if (!holder) continue;
      this.store.event(row.session_id, null, 'research_file_hold_conflict', {
        path: file,
        worker: row.id,
        holder: holder.holder,
      });
      try {
        steerWorker(
          this.store,
          row.session_id,
          row.id,
          `file-hold:${file}`.slice(0, 512),
          holds.holdNotice(holder),
        );
      } catch {
        /* The subagent may have ended; the completion wake still flags the overlap. */
      }
    }
  }
  cancel(sessionId: string, cutoff = Date.now()) {
    const rows = this.store.all<{ id: string }>(
      "SELECT id FROM delegations WHERE session_id=? AND created_at<=? AND status IN ('queued','running')",
      sessionId,
      cutoff,
    );
    this.store.exec(
      "UPDATE delegations SET status='cancelled',ended_at=? WHERE session_id=? AND created_at<=? AND status IN ('queued','running')",
      Date.now(),
      sessionId,
      cutoff,
    );
    for (const row of rows) {
      closeWorkerSteers(this.store, row.id);
      holds.releaseFileHolds(this.store, row.id);
    }
    for (const row of this.active.values())
      if (row.sessionId === sessionId && row.createdAt <= cutoff)
        row.controller.abort(new Error('Subagent cancelled'));
  }
  async stop() {
    this.stopping = true;
    for (const row of this.active.values()) row.controller.abort(new Error('Daemon stopping'));
    await Promise.allSettled([...this.active.values()].map((row) => row.promise));
  }
}
