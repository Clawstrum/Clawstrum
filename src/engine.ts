import {
  dailyInProgress,
  dailyPassDue,
  localDayHour,
  markDailyPass,
  resolveDailyConfig,
} from './daily-consolidation.js';
import {
  initializeMaintenanceBudget,
  maintenanceBudget,
  reserveMaintenanceCall,
  MaintenanceDeferred,
} from './maintenance-budget.js';
import { memoryReviewDue, memoryReviewKey, requestMemoryReview } from './memory-review.js';
import { ResearchWorkers } from './research/workers.js';
import { ClusterMonitor } from './research/cluster.js';
import { WorkAloneMonitor, workAloneActive } from './work-alone.js';
import { consolidateMemory, consolidationCoverage } from './consolidation.js';
import { consolidationRequestKey } from './compaction.js';
import { ensureMemory } from './memory.js';
import { archiveProviderRecord, archiveRecord, historyBytes } from './history.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type {
  Account,
  Attachment,
  Inbound,
  Provider,
  ProviderName,
  ProviderRequest,
  Run,
  Session,
} from './types.js';
import { Store } from './store.js';
import {
  AccountPool,
  ProviderFailure,
  classifyError,
  accountRoute,
  isModelRefusal,
} from './accounts.js';
import { accountsSection, type AccountRow } from './account-context.js';
import {
  getModelOverride,
  setModelOverride,
  parseSwitchArgument,
  withModelOverride,
} from './account-routing.js';
import { excludeRefusedInput, isSafetyRefusal } from './refusals.js';
import { buildContext, DEFAULT_AGENTS, hostTimeZone, localStamp, readSkills } from './context.js';
import { DecisionService, decisionsAvailable, decisionEnvironment } from './decisions/client.js';
import { skillAdvice } from './decisions/advice.js';
import { messageRecall, rememberInjected } from './research/message-recall.js';
import { replyCorrections, reviewReply } from './research/replies.js';
import {
  accountEnvironment,
  PROVIDER_TOOL_REFUSAL,
  providerToolRefusal,
  toolResultErrorText,
} from './providers.js';
import { downloadAttachments } from './attachments.js';
import { transcribeVoiceNotes } from './voice.js';
import { tickScheduler } from './scheduler.js';
import { supervisedProviders } from './supervisor.js';
import { processTree } from './diagnostics.js';
import { abortAfter } from './async.js';
import { writePrivate } from './files.js';
import { normalizeMessageText, stripQuietMarker } from './message-text.js';
import { WatchMonitor } from './watches.js';
import { drainingRestart } from './restart.js';
import { randomUUID } from 'node:crypto';
import { UsageMeter, initializeUsageLedger } from './usage-ledger.js';
import { timingEvent } from './performance.js';
import { turnFailureNotice } from './failure-notice.js';
import { researchEnvironment } from './research/config.js';
import { GroupReviews } from './groups/review.js';
import { syncGroups, expireGroupEntries } from './groups/store.js';
/** Bound duplicate comparisons to recently delivered messages from the same answer. */
const RECAP_WINDOW_MS = 120_000;
const RECAP_MIN_CHARS = 300;
const WAKE_ECHO =
  /(status|update|result)s? (was|went|were|sent|just)|already (sent|went out|reported|handled)|(sent|out|reported) (a|\d+|two|one) minutes? ago|not (yet )?(passed|past due)|nothing new to report|no (slip |status |new )?update (is )?needed|why this (fired|woke)|this (watcher|wake) fired (for|because)/i;

/** Inbound id prefix for the follow-up that recovers a turn the CLI refused every tool call in. */
const DENIAL_RECOVERY = 'denial-recovery:';
interface Active {
  controller: AbortController;
  reason?: 'switch' | 'cancel' | 'reset' | 'shutdown' | 'handoff';
  promise: Promise<void>;
  lastActivity: number;
  started: number;
  ready: boolean;
  completed: boolean;
  turnStarted: number;
  accountId?: string;
  workerPid?: number;
  runId: string;
  taskRun?: boolean;
  inject?: (ids: string[], text: string) => boolean;
  pendingInject: Set<string>;
  /** Transport-accepted inputs whose provider intake has not been observed. */
  unstartedInject: Set<string>;
  /** Live tool calls, keyed by id so a tool_result can be matched back to its tool name. */
  tools: Map<string, string>;
  backgroundTasks: number;
  /** One entry per refused tool call this turn: the tool name and the provider's own text. */
  denials: { tool: string; text: string }[];
  atResultBoundary: boolean;
  /** Steered input the reply was reopened for, until the provider starts it. Result text
   * flushed before then closes the earlier turn, which already sent its final answer. */
  reopenedFor?: string;
}
/** How this process re-invokes its own CLI as an MCP server. Hoisted because the consolidation pass
 * runs outside any turn and needs the same invocation the lead gets. */
function mcpInvocation(): string[] {
  const sourceModule = fileURLToPath(import.meta.url);
  const development = sourceModule.endsWith('.ts');
  const cli = path.join(path.dirname(sourceModule), development ? 'cli.ts' : 'cli.js');
  return development ? ['--import', import.meta.resolve('tsx'), cli, 'mcp'] : [cli, 'mcp'];
}
export class Engine {
  readonly active = new Map<string, Active>();
  readonly maintenance = new Map<
    string,
    { accountId: string; controller: AbortController; promise: Promise<string> }
  >();
  readonly consolidations = new Set<Promise<unknown>>();
  private consolidationWorkers = new Map<string, AbortController>();
  private consolidationRetry = new Map<string, number>();
  private lastConsolidationScan = 0;
  private maintenanceUsed(id: string): number {
    return [...this.maintenance.values()].filter((s) => s.accountId === id).length;
  }
  /** Maintenance shares credential slots with leads and research subagents. */
  private runMaintenance(
    request: ProviderRequest,
    role = 'group_reviewer',
    priority = false,
    daily = false,
  ): Promise<string> {
    if (request.controller.signal.aborted) return Promise.reject(request.controller.signal.reason);
    const used =
      [...this.active.values()].filter((s) => s.accountId === request.account.id).length +
      this.researchWorkers.used(request.account.id) +
      this.maintenanceUsed(request.account.id);
    if (
      this.stopping ||
      this.draining ||
      this.maintenance.size >= this.config.runtime.maintenance.maxConcurrent ||
      this.store.get(
        "SELECT id FROM inbound WHERE kind='user' AND status='queued' AND available_at<=? LIMIT 1",
        Date.now(),
      ) ||
      this.active.size + this.maintenance.size + this.researchWorkers.active.size >=
        this.config.runtime.maxConcurrent ||
      used >= (request.account.maxConcurrent ?? this.config.runtime.maxConcurrent)
    )
      return Promise.reject(
        new Error('Maintenance deferred: no credential capacity or daemon draining'),
      );
    let id: string;
    try {
      // The daily consolidation pass counts against its own cap, never the shared one.
      id = reserveMaintenanceCall(
        this.store,
        daily
          ? this.config.runtime.consolidation.daily.maxCallsPerDay
          : this.config.runtime.maintenance.maxCallsPerDay,
        role,
        Date.now(),
        this.config.runtime.maintenance.minIntervalMs,
        daily
          ? { daily: true }
          : { priority, reserve: this.config.runtime.maintenance.requestedReserve },
      ).id;
    } catch (error) {
      return Promise.reject(error);
    }
    let accepting = true;
    let meter: UsageMeter | undefined;
    let failed = false;
    const promise = abortAfter(
      Promise.resolve().then(() => {
        request.controller.signal.throwIfAborted();
        meter = new UsageMeter(this.store, {
          id: `${role}:${id}`,
          sessionId: request.usageScope ?? 'shared',
          role,
          provider: request.account.provider,
          account: request.account.id,
          model: request.account.model,
        });
        return this.adapters[request.account.provider].run({
          ...request,
          onEvent: (event) => {
            if (accepting) {
              if (event.usage) meter?.observe(event.usage);
              request.onEvent(event);
            }
          },
        });
      }),
      request.controller.signal,
      this.config.runtime.abortGraceMs + 2500,
    )
      .catch((error) => {
        failed = true;
        throw error;
      })
      .finally(() => {
        accepting = false;
        this.maintenance.delete(id);
        meter?.finish(
          request.controller.signal.aborted ? 'interrupted' : failed ? 'failed' : 'completed',
        );
      });
    this.maintenance.set(id, {
      accountId: request.account.id,
      controller: request.controller,
      promise,
    });
    return promise;
  }
  readonly pool: AccountPool;
  private readonly memoryReviewPool: AccountPool;
  // A provider without a review model uses the account's own model, as consolidation does. Leaving
  // those accounts out kept a due review waiting forever on a Codex-only install, and consolidation
  // waits behind a due review.
  private memoryReviewAccounts(): Account[] {
    const config = this.config;
    return config.accounts.map((account) => ({
      ...account,
      model: config.runtime.memoryReview.models[account.provider] ?? account.model,
      effort: config.runtime.memoryReview.effort,
      modelFallbacks: [],
      quotaBuckets: [],
    }));
  }
  /**
   * Apply a changed account list (accounts.json or config.json) without a restart. Turns already
   * running keep their account; the next routing decision, memory review, group review and
   * subagent start use the new list, priorities and models. Cached subagent pools are dropped so
   * they are rebuilt from it.
   */
  reloadAccounts(accounts: Config['accounts']): void {
    this.config.accounts = accounts;
    this.pool.replaceAccounts(accounts);
    this.memoryReviewPool.replaceAccounts(this.memoryReviewAccounts());
    this.researchWorkers.resetPools();
    this.groupReviews.refreshAccounts();
  }
  /**
   * The pool to route a conversation with: the shared one, or one in which the conversation's
   * preferred account carries its per-conversation model request (model-override metadata).
   */
  private poolFor(session: Session | undefined): AccountPool {
    const override = session ? getModelOverride(this.store, session.id) : undefined;
    if (!session || !override || override.account !== session.preferred_account) return this.pool;
    if (!this.pool.accounts.some((a) => a.id === override.account)) return this.pool;
    return new AccountPool(
      this.pool.accounts.map((a) =>
        a.id === override.account ? withModelOverride(a, override.model) : a,
      ),
      this.store,
      this.pool.cooldownMs,
      this.pool.strainThreshold,
      this.pool.quotaScopes,
    );
  }
  readonly researchWorkers: ResearchWorkers;
  readonly clusterMonitor: ClusterMonitor;
  readonly watches: WatchMonitor;
  readonly workAlone: WorkAloneMonitor;
  readonly groupReviews: GroupReviews;
  private groupSyncAt = 0;
  daemonInstance?: string;
  draining = false;
  private stopping = false;
  readonly typingUntil = new Map<string, number>();
  /**
   * Whether a run should still wait on this queued input. debounceMs/debounceMaxMs cap the wait
   * while nobody is typing; while the Discord typing signal is live, the cap is the longer
   * typingMaxMs instead, so a person mid-sentence past debounceMaxMs is not cut off (one measured
   * case: 5 messages over 65 s, the reply started 60 s after the first, before the last arrived).
   */
  private debounceActive(sessionId: string, firstAt: number, lastAt: number, now: number): boolean {
    const typing = (this.typingUntil.get(sessionId) ?? 0) > now;
    const cap = typing ? this.config.runtime.typingMaxMs : this.config.runtime.debounceMaxMs;
    return now - firstAt < cap && (now - lastAt < this.config.runtime.debounceMs || typing);
  }
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly adapters: Record<ProviderName, Provider> = supervisedProviders,
  ) {
    initializeMaintenanceBudget(store);
    initializeUsageLedger(store);
    this.pool = new AccountPool(
      config.accounts,
      store,
      config.runtime.unknownQuotaCooldownMs,
      config.runtime.quotaWarningThreshold,
    );
    this.memoryReviewPool = new AccountPool(
      this.memoryReviewAccounts(),
      store,
      config.runtime.unknownQuotaCooldownMs,
      config.runtime.quotaWarningThreshold,
    );
    this.researchWorkers = new ResearchWorkers(
      store,
      config,
      this.pool,
      adapters,
      (id) =>
        [...this.active.values()].filter((s) => s.accountId === id).length +
        this.maintenanceUsed(id),
    );
    this.clusterMonitor = new ClusterMonitor(store, undefined, config.workAlone.enabled);
    this.watches = new WatchMonitor(
      store,
      undefined,
      (id) => config.workAlone.enabled && workAloneActive(store, id),
    );
    this.workAlone = new WorkAloneMonitor(store, config);
    this.groupReviews = new GroupReviews(
      store,
      config,
      (request) => this.runMaintenance(request),
      (id) =>
        [...this.active.values()].filter((s) => s.accountId === id).length +
        this.researchWorkers.used(id) +
        this.maintenanceUsed(id),
      () =>
        config.runtime.maxConcurrent -
        this.active.size -
        this.maintenance.size -
        this.researchWorkers.active.size,
    );
  }
  /** The Accounts section for a lead's instructions (src/account-context.ts); no secret values. */
  private accountsNote(): string {
    return accountsSection(
      this.store.home,
      this.config.accounts,
      (id) =>
        this.store.get<AccountRow>(
          'SELECT cooldown_until,disabled,reason FROM accounts WHERE id=?',
          id,
        ),
      process.env,
    );
  }
  /** Operator notices about account quota belong in one channel, not wherever the run happened. */
  private noticeSession(fallback: string): string {
    const channel = this.config.discord.noticeChannelId;
    if (!channel) return fallback;
    return this.store.ensureSession(channel).id;
  }
  refreshAttachment?: (messageId: string, attachment: Attachment) => Promise<string | undefined>;
  /**
   * Accounts a channel may not use because the owner limited it to one provider (metadata
   * provider-only:<session> = 'codex', 'claude' or 'gemini'). Without this, a quota error can move such a
   * channel to the other provider, where its requests are refused.
   */
  private foreignAccounts(session: Session | undefined, pool = this.pool): Set<string> {
    const only = session
      ? this.store.get<{ value: string }>(
          'SELECT value FROM metadata WHERE key=?',
          `provider-only:${session.id}`,
        )?.value
      : undefined;
    return new Set(only ? pool.accounts.filter((a) => a.provider !== only).map((a) => a.id) : []);
  }
  private choose(
    session: Session | undefined,
    attempted = new Set<string>(),
    now = Date.now(),
    pool = this.pool,
  ) {
    const excluded = new Set([...attempted, ...this.foreignAccounts(session, pool)]);
    if (pool === this.pool) pool = this.poolFor(session);
    for (const account of pool.accounts) {
      const used =
        [...this.active.values()].filter((s) => s.accountId === account.id).length +
        this.researchWorkers.used(account.id) +
        this.maintenanceUsed(account.id);
      if (used >= (account.maxConcurrent ?? this.config.runtime.maxConcurrent))
        excluded.add(account.id);
    }
    return pool.choose(
      session?.preferred_account ?? null,
      session?.active_account ?? null,
      excluded,
      now,
    );
  }
  private bestEffort(operation: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      console.error(JSON.stringify({ event: 'diagnostic_error', operation, error: String(error) }));
    }
  }
  private snapshot(state: Active, reason: string): void {
    this.bestEffort('interruption snapshot', () => {
      const data = {
        at: Date.now(),
        reason,
        pid: process.pid,
        run: state.runId,
        account: state.accountId,
        started: state.turnStarted,
        lastActivity: state.lastActivity,
        ready: state.ready,
        backgroundTasks: state.backgroundTasks,
        processes: processTree(state.workerPid),
        memory: process.memoryUsage(),
        resources: process.resourceUsage(),
        active: [...this.active.entries()].map(([session, s]) => ({
          session,
          run: s.runId,
          account: s.accountId,
          lastActivity: s.lastActivity,
        })),
        events: this.store.all(
          'SELECT type,content,created_at FROM events WHERE run_id=? ORDER BY seq DESC LIMIT 20',
          state.runId,
        ),
      };
      const file = path.join(this.store.home, 'diagnostics', `${state.runId}.json`);
      writePrivate(file, JSON.stringify(data, null, 2));
      console.error(
        JSON.stringify({ event: 'turn_interrupted', run: state.runId, reason, snapshot: file }),
      );
    });
  }
  /** A turn whose tool calls were all refused by the finished-turn CLI state can neither read a
   * file nor send a message, and its own closing text reads as a stop. Queue one follow-up so the
   * work continues in a fresh turn; the follow-up itself never queues another.
   */
  private resumeAfterDenial(sessionId: string, run: Run, state: Active, messages: Inbound[]): void {
    if (!state.denials.length) return;
    const tools = [...new Set(state.denials.map((d) => d.tool))].join(', ');
    if (messages.some((m) => m.id.startsWith(DENIAL_RECOVERY))) return;
    const queued = this.store.enqueue({
      id: `${DENIAL_RECOVERY}${run.id}`,
      sessionId,
      author: 'Clawstrum',
      kind: 'task',
      content: `${state.denials.length} tool call${state.denials.length === 1 ? '' : 's'} in the previous turn (${tools}) returned "${PROVIDER_TOOL_REFUSAL}". No explicit harness stop/reset/switch control ended that attempt. This generic provider error does not establish its cause or prove that the user refused the task. This is one bounded recovery attempt; check the latest user instructions and honour any cancellation. Read the previous turn to see what it was about to do, verify the current state on disk before repeating any command or external action, and finish the work. Continue only the remaining authorized work. If tools still fail, report the observed failure without claiming a human refused it. If there is nothing to report, reply with only the word CLAWSTRUM_QUIET and no other text.`,
      at: Date.now(),
    });
    if (queued)
      this.store.event(sessionId, run.id, 'denial_recovery', {
        denied: state.denials.length,
        denials: state.denials,
      });
  }
  start(): void {
    this.store.recover(this.config.runtime.maxAttempts);
    this.researchWorkers.recover();
    this.clusterMonitor.recover();
    syncGroups(this.store, this.config.groups.enabled);
  }
  performanceSnapshot(now = Date.now()) {
    return {
      active: [...this.active.entries()].map(([sessionId, s]) => ({
        sessionId,
        runId: s.runId,
        account: s.accountId,
        ready: s.ready,
        completed: s.completed,
        injectable: !!s.inject,
        taskOnly: !!s.taskRun,
        ageMs: now - s.turnStarted,
        idleMs: now - s.lastActivity,
        tools: [...s.tools.values()],
        backgroundTasks: s.backgroundTasks,
        awaitingTransport: s.pendingInject.size,
        consumptionUnobserved: s.unstartedInject.size,
      })),
      subagents: this.researchWorkers.active.size,
      maintenance: this.maintenance.size,
      maintenanceBudget: maintenanceBudget(
        this.store,
        this.config.runtime.maintenance.maxCallsPerDay,
        now,
        this.config.runtime.maintenance.minIntervalMs,
      ),
      dailyConsolidationBudget: maintenanceBudget(
        this.store,
        this.config.runtime.consolidation.daily.maxCallsPerDay,
        now,
        0,
        { daily: true },
      ),
      draining: this.draining,
    };
  }
  tick(now = Date.now()): void {
    if (this.stopping) return;
    this.draining = this.daemonInstance
      ? drainingRestart(this.store, this.daemonInstance, now)
      : false;
    tickScheduler(this.store, now);
    this.controls(now);
    if (now >= this.groupSyncAt) {
      this.bestEffort('group context refresh', () => {
        if (this.config.groups.enabled) expireGroupEntries(this.store, now);
        syncGroups(this.store, this.config.groups.enabled);
      });
      this.groupSyncAt = now + 1000;
    }
    if (
      this.draining ||
      this.store.get(
        "SELECT id FROM inbound WHERE kind='user' AND status='queued' AND available_at<=? LIMIT 1",
        now,
      )
    )
      this.groupReviews.yield();
    if (
      this.store.get(
        "SELECT id FROM inbound WHERE kind='user' AND status='queued' AND available_at<=? LIMIT 1",
        now,
      )
    )
      for (const controller of this.consolidationWorkers.values())
        controller.abort(
          new Error('Consolidation yielded to a user request; completed chunks are saved'),
        );
    if (this.config.research.enabled) this.clusterMonitor.tick(now);
    if (!this.draining) this.watches.tick(now);
    if (!this.draining && this.config.workAlone.enabled)
      this.bestEffort('work-alone wakes', () => {
        this.workAlone.wakes(now);
        this.workAlone.morning(now);
      });
    for (const state of this.active.values()) {
      if (state.controller.signal.aborted || state.completed) continue;
      if (
        this.config.runtime.turnTimeoutMs > 0 &&
        now - state.turnStarted > this.config.runtime.turnTimeoutMs
      ) {
        this.snapshot(state, 'Absolute turn timeout');
        state.controller.abort(
          new ProviderFailure(
            'fatal',
            'Absolute turn timeout; inspect saved partial output and checkpoint',
          ),
        );
      } else if (!state.ready && now - state.started > this.config.runtime.startupTimeoutMs) {
        this.snapshot(state, 'Provider startup timeout');
        state.controller.abort(new ProviderFailure('transient', 'Provider startup timeout'));
      } else if (
        state.ready &&
        state.tools.size === 0 &&
        // A turn that armed a background task is told not to poll, so it is legitimately quiet
        // until the task reports. Queued user input has its own recovery check below.
        state.backgroundTasks === 0 &&
        this.config.runtime.silenceTimeoutMs > 0 &&
        now - state.lastActivity > this.config.runtime.silenceTimeoutMs
      ) {
        this.snapshot(state, 'Provider silence timeout');
        state.controller.abort(
          new ProviderFailure(
            'fatal',
            'Provider silence timeout; inspect the checkpoint before retrying',
          ),
        );
      }
    }
    // Existing turns and their delegated work can finish. New top-level inputs
    // remain durable in the queue until the replacement daemon becomes ready.
    if (this.draining) {
      this.researchWorkers.tick();
      return;
    }
    const sessions = this.store.all<{
      session_id: string;
      first_at: number;
      last_at: number;
      kind: string;
    }>(
      "SELECT session_id,COALESCE(MIN(CASE WHEN kind='user' THEN created_at END),MIN(created_at)) first_at,COALESCE(MAX(CASE WHEN kind='user' THEN created_at END),MAX(created_at)) last_at,(SELECT i.kind FROM inbound i WHERE i.session_id=inbound.session_id AND i.status='queued' ORDER BY (i.kind='user') DESC,i.created_at,i.id LIMIT 1) kind FROM inbound WHERE status='queued' AND available_at<=? GROUP BY session_id ORDER BY first_at",
      now,
    );
    for (const row of sessions) {
      const running = this.active.get(row.session_id);
      if (running) {
        this.steer(row, running, now);
        continue;
      }
      if (this.active.size + this.maintenance.size >= this.config.runtime.maxConcurrent) continue;
      if (
        row.kind === 'user' &&
        this.debounceActive(row.session_id, row.first_at, row.last_at, now)
      )
        continue;
      const session = this.store.session(row.session_id);
      const admittedAccount = this.choose(session, new Set(), now);
      if (!admittedAccount) {
        if (
          this.poolFor(session).choose(
            session.preferred_account,
            session.active_account,
            this.foreignAccounts(session),
            now,
          )
        )
          continue;
        const next = this.pool.nextAvailable(now);
        this.store.exec(
          "UPDATE inbound SET available_at=? WHERE session_id=? AND status='queued'",
          next ?? now + 60000,
          session.id,
        );
        const oldestQueued = this.store.get<{ id: string }>(
          "SELECT id FROM inbound WHERE session_id=? AND status='queued' ORDER BY created_at,id LIMIT 1",
          session.id,
        );
        this.capacityNotice(session.id, oldestQueued?.id ?? session.id, next);
        continue;
      }
      const claimed = this.store.claim(session.id, now);
      if (!claimed) continue;
      const state: Active = {
        controller: new AbortController(),
        promise: Promise.resolve(),
        started: now,
        lastActivity: now,
        ready: false,
        completed: false,
        turnStarted: now,
        runId: claimed.run.id,
        accountId: admittedAccount.id,
        pendingInject: new Set(),
        unstartedInject: new Set(),
        tools: new Map(),
        backgroundTasks: 0,
        denials: [],
        atResultBoundary: false,
      };
      this.active.set(session.id, state);
      this.store.exec(
        'UPDATE runs SET config_json=? WHERE id=?',
        JSON.stringify(this.config),
        claimed.run.id,
      );
      state.promise = this.execute(claimed.run, claimed.messages, state)
        .catch((error) => {
          this.store.event(session.id, claimed.run.id, 'engine_error', String(error));
          this.store.finish(claimed.run, 'failed', String(error));
          this.failureNotice(
            claimed.run,
            String(error),
            'Work and history are saved. Inspect status, then resume after fixing the cause.',
            admittedAccount,
            'fatal',
          );
        })
        .finally(() => {
          this.active.delete(session.id);
        });
    }
    this.researchWorkers.tick();
    // Admit user turns and delegated work first; consolidation uses only idle capacity.
    this.scheduleConsolidation(now);
    if (!this.draining && this.maintenanceAvailable(now)) this.groupReviews.tick(now);
  }
  private failureNotice(
    run: Run,
    reason: string,
    next: string,
    account?: Account,
    prefix = 'failed',
  ): void {
    const current = this.store.get<Run>('SELECT * FROM runs WHERE id=?', run.id) ?? run;
    const messages = (JSON.parse(current.message_ids) as string[])
      .map((id) => this.store.get<Inbound>('SELECT * FROM inbound WHERE id=?', id))
      .filter((m): m is Inbound => !!m);
    const task =
      messages.length === 1 && messages[0]!.kind === 'task'
        ? this.store.get<{ prompt: string }>(
            'SELECT t.prompt FROM tasks t JOIN task_runs r ON r.task_id=t.id WHERE r.message_id=?',
            messages[0]!.id,
          )
        : undefined;
    const notice = turnFailureNotice({
      run,
      messages,
      reason,
      next,
      account,
      taskPrompt: task?.prompt,
    });
    this.store.notice(run.session_id, notice.content, `${prefix}:${run.id}`, {
      thread: true,
      messageId: notice.messageId,
    });
  }
  private maintenanceSlotFree(now: number): boolean {
    return (
      this.maintenance.size < this.config.runtime.maintenance.maxConcurrent &&
      !this.store.get(
        "SELECT id FROM inbound WHERE kind='user' AND status='queued' AND available_at<=? LIMIT 1",
        now,
      )
    );
  }
  private maintenanceAvailable(now: number, priority = false): boolean {
    return (
      this.maintenanceSlotFree(now) &&
      maintenanceBudget(
        this.store,
        this.config.runtime.maintenance.maxCallsPerDay,
        now,
        this.config.runtime.maintenance.minIntervalMs,
        { priority, reserve: this.config.runtime.maintenance.requestedReserve },
      ).available
    );
  }
  /** Room under the daily consolidation pass's own call cap (separate from the shared one). */
  private dailyBudgetAvailable(now: number): boolean {
    return maintenanceBudget(
      this.store,
      this.config.runtime.consolidation.daily.maxCallsPerDay,
      now,
      0,
      { daily: true },
    ).available;
  }
  private scheduleConsolidation(now: number): void {
    // A requested pass may use the reserved calls and ignores pacing; everything else may not.
    // The daily pass has its own budget, so it can run when the shared one is used up.
    const dailyConfig = resolveDailyConfig(this.config.runtime);
    const dailyEnabled = this.config.runtime.consolidation.enabled && dailyConfig.enabled;
    if (this.draining || this.stopping) return;
    const sharedOpen = this.maintenanceAvailable(now, true);
    const dailySlot = dailyEnabled && this.maintenanceSlotFree(now);
    if (!sharedOpen && !dailySlot) return;
    const generalAvailable = this.maintenanceAvailable(now);
    // The scan below reads every session on every call; with many sessions that is hundreds
    // of point-queries per engine tick and stalls the event loop for seconds. Run the scan
    // itself at most once per scanIntervalMs; everything after this check is unchanged.
    if (now - this.lastConsolidationScan < this.config.runtime.maintenance.scanIntervalMs) return;
    this.lastConsolidationScan = now;
    const hasRequest = (id: string) =>
      !!this.config.runtime.consolidation.enabled &&
      !!this.store.get('SELECT key FROM metadata WHERE key=?', consolidationRequestKey(id));
    // Channels with a pending compaction request go first, so a backlog elsewhere cannot hold them.
    const all = this.store.all<Session>('SELECT * FROM sessions ORDER BY created_at DESC');
    const sessions: Array<Session | null> = [
      ...all.filter((s) => hasRequest(s.id)),
      ...all.filter((s) => !hasRequest(s.id)),
      null,
    ];
    for (const session of sessions) {
      const sessionId = session?.id ?? null;
      const workerKey = sessionId ?? 'shared';
      const recordEvent = (type: string, content: unknown) =>
        sessionId
          ? this.store.event(sessionId, null, type, content)
          : archiveRecord(this.store, {
              id: `${type}:${randomUUID()}`,
              sessionId: null,
              kind: type,
              content,
            });
      const idle = () =>
        !this.stopping &&
        !this.draining &&
        !(sessionId ? this.active.has(sessionId) : this.active.size > 0) &&
        !this.store.get(
          "SELECT id FROM inbound WHERE (? IS NULL OR session_id=?) AND status='queued' AND available_at<=? LIMIT 1",
          sessionId,
          sessionId,
          Date.now(),
        );
      if (!idle() || this.consolidationWorkers.has(workerKey)) continue;
      // A native compaction queues a pass (compaction.ts). It runs when the channel is idle, on
      // whatever history is new, even below the byte threshold. The pass merges the "Last
      // compaction summary" MEMORY section (written by the PostCompact hook) into the other
      // sections and then rotates the native session, so the next turn starts from AGENTS.md.
      const requested =
        !!sessionId &&
        this.config.runtime.consolidation.enabled &&
        !!this.store.get(
          'SELECT key FROM metadata WHERE key=?',
          consolidationRequestKey(sessionId),
        );
      // Requested passes outrank a due review and backlog catch-up: the lead's own summary is the
      // newest and most perishable memory input.
      if (!requested && !generalAvailable && !dailySlot) continue;
      const rotationDue =
        sessionId &&
        this.config.runtime.consolidation.enabled &&
        (requested ||
          // thresholdBytes 0 (the default) turns the byte trigger off; the daily pass replaces it.
          (this.config.runtime.consolidation.thresholdBytes > 0 &&
            historyBytes(this.store, sessionId, consolidationCoverage(this.store, sessionId)) >=
              this.config.runtime.consolidation.thresholdBytes) ||
          // A saved pass in progress resumes as a rotating pass, unless it started as a daily pass.
          (this.store.get('SELECT key FROM metadata WHERE key=?', `consolidation:${sessionId}`) &&
            !dailyInProgress(this.store, sessionId)));
      // Corrections must not wait behind a permanently due or retrying rotation. Once a review
      // commits its minInterval leaves room for rotation, which retains independent coverage.
      const review =
        !requested &&
        this.config.runtime.memoryReview.enabled &&
        (this.store.get('SELECT key FROM metadata WHERE key=?', memoryReviewKey(sessionId)) ||
          memoryReviewDue(this.store, sessionId, this.config.runtime.memoryReview, now));
      // The daily pass (also for the shared scope) comes after a due review or rotation, and
      // reads the same history once a day at most.
      const dailyRun =
        !requested &&
        !review &&
        !rotationDue &&
        dailyEnabled &&
        (dailyInProgress(this.store, sessionId) ||
          dailyPassDue(this.store, sessionId, dailyConfig, now));
      if (!rotationDue && !review && !dailyRun) continue;
      if (dailyRun ? !dailySlot : !requested && !generalAvailable) continue;
      if (dailyRun && !this.dailyBudgetAvailable(now)) {
        // Out of daily calls: this channel waits for the next window. Log it once per local day.
        const capKey = `consolidation-daily:${workerKey}:cap-logged`;
        const day = localDayHour(now, dailyConfig.timezone).day;
        if (
          this.store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', capKey)
            ?.value !== day
        ) {
          this.store.exec(
            'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            capKey,
            day,
          );
          recordEvent('consolidation_deferred', {
            error: `Daily consolidation call cap (${dailyConfig.maxCallsPerDay} per 24 h) reached; this channel waits for the next window`,
          });
        }
        continue;
      }
      const retryKey = `${workerKey}:${review ? 'review' : dailyRun ? 'daily' : 'rotation'}`;
      const retryStateKey = `maintenance-retry:${retryKey}`;
      const retryState = JSON.parse(
        this.store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', retryStateKey)
          ?.value ?? '{}',
      );
      if (Math.max(this.consolidationRetry.get(retryKey) ?? 0, retryState.retryAt ?? 0) > now)
        continue;
      if (this.consolidationWorkers.size >= this.config.runtime.maintenance.maxConcurrent) break;
      const maintenanceConfig = review
        ? this.config.runtime.memoryReview
        : this.config.runtime.consolidation;
      if (this.active.size + this.maintenance.size >= this.config.runtime.maxConcurrent) break;
      // Route the economical model before quota selection; its limits differ from the lead's.
      const pool = review ? this.memoryReviewPool : this.pool;
      const account = this.choose(session ?? undefined, new Set(), now, pool);
      if (!account) continue;
      ensureMemory(this.store, null, DEFAULT_AGENTS);
      if (sessionId) ensureMemory(this.store, sessionId);
      if (
        review &&
        !this.store.get('SELECT key FROM metadata WHERE key=?', memoryReviewKey(sessionId))
      )
        requestMemoryReview(
          this.store,
          sessionId,
          'Review current memory and standing instructions against corrections, evidence and scope',
        );
      const controller = new AbortController();
      this.consolidationWorkers.set(workerKey, controller);
      const pass = consolidateMemory({
        store: this.store,
        sessionId,
        config: {
          ...maintenanceConfig,
          thresholdBytes: this.config.runtime.consolidation.thresholdBytes,
        },
        review: !!review,
        force: !!review || dailyRun || (requested && !review),
        requested: requested && !review,
        daily: dailyRun,
        tailChunks: dailyRun
          ? dailyConfig.tailChunks
          : this.config.runtime.consolidation.requestedTailChunks,
        // Only the daily pass leaves the native session alone.
        rotate: !dailyRun,
        signal: controller.signal,
        canCommit: idle,
        call: async ({ prompt, instructions, signal }) => {
          const invocation = new AbortController();
          const abort = () => invocation.abort(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          const model = maintenanceConfig.models[account.provider] ?? account.model;
          const routed = { ...account, model, effort: maintenanceConfig.effort };
          if (routed.provider === 'codex' && routed.effort === 'max') routed.effort = 'xhigh';
          try {
            return await this.runMaintenance(
              {
                account: routed,
                usageScope: sessionId ?? 'shared',
                prompt,
                instructions,
                cwd: session?.workspace ?? this.store.home,
                controller: invocation,
                env: accountEnvironment(routed, this.config.accounts),
                mcp: { command: process.execPath, args: mcpInvocation(), env: {} },
                toolless: true,
                maxTurns: 1,
                abortGraceMs: this.config.runtime.abortGraceMs,
                onEvent: (event) => {
                  if (event.quota)
                    pool.quota(account, event.quota, this.config.runtime.proactiveThreshold);
                },
              },
              review ? 'memory-reviewer' : 'consolidator',
              requested && !review,
              dailyRun,
            );
          } finally {
            signal.removeEventListener('abort', abort);
          }
        },
      })
        .then((result) => {
          if (result === 'committed') {
            // The local day is the one the scan found the pass due in, even if the pass ran past midnight.
            if (dailyRun) markDailyPass(this.store, sessionId, dailyConfig, now);
            if (requested && !review && sessionId)
              this.store.exec(
                'DELETE FROM metadata WHERE key=?',
                consolidationRequestKey(sessionId),
              );
            if (review) {
              recordEvent('memory_review_completed', { reason: 'consistency' });
            } else {
              // The just-archived `consolidation` record already carries the coverage this
              // pass committed, so this adds a dedicated completion event at no extra pass cost.
              const archived = this.store.get<{ content: string }>(
                'SELECT content FROM history_records WHERE session_id IS ? AND kind=? ORDER BY seq DESC LIMIT 1',
                sessionId,
                'consolidation',
              );
              const summary = archived ? JSON.parse(archived.content) : undefined;
              recordEvent('consolidation_completed', {
                chunks: summary?.chunks,
                from: summary?.from,
                through: summary?.through,
              });
            }
          }
          this.store.exec('DELETE FROM metadata WHERE key=?', retryStateKey);
          this.consolidationRetry.set(retryKey, Date.now() + 60000);
        })
        .catch((error) => {
          const failure = classifyError(error);
          if (['quota', 'auth'].includes(failure.kind)) pool.fail(account, failure);
          recordEvent(review ? 'memory_review_deferred' : 'consolidation_deferred', {
            error: String(error),
          });
          const failures = (retryState.failures ?? 0) + 1;
          const retryAt =
            error instanceof MaintenanceDeferred
              ? error.retryAt
              : Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(failures - 1, 6));
          this.store.exec(
            'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            retryStateKey,
            JSON.stringify({ failures, retryAt }),
          );
          this.consolidationRetry.set(retryKey, retryAt);
        })
        .finally(() => {
          this.consolidationWorkers.delete(workerKey);
          this.consolidations.delete(pass);
        });
      this.consolidations.add(pass);
    }
  }
  /** Feed queued user messages into a session's live turn instead of waiting for it to end. */
  private steer(
    row: { session_id: string; first_at: number; last_at: number; kind: string },
    state: Active,
    now: number,
  ): void {
    const stallMs = this.config.runtime.queuedInputTimeoutMs;
    // Background task bookkeeping may outlive a usable SDK input stream. A new
    // human request must not wait forever merely because that task count is nonzero.
    // Task wakes (watch expiry, job events) cannot be injected, so they are handed
    // off too once the provider has returned its result and only background work remains.
    if (
      (row.kind === 'user' || state.atResultBoundary) &&
      state.ready &&
      !state.tools.size &&
      !state.reason &&
      !state.controller.signal.aborted &&
      stallMs > 0 &&
      now - Math.max(row.first_at, state.started) >= stallMs &&
      now - state.lastActivity >= stallMs
    ) {
      this.snapshot(state, 'Queued user input stalled; resume conversation in a new provider turn');
      this.store.event(row.session_id, state.runId!, 'queued_input_handoff', {
        waitedMs: now - row.first_at,
        idleMs: now - state.lastActivity,
        injectable: !!state.inject,
        backgroundTasks: state.backgroundTasks,
      });
      state.reason = 'handoff';
      state.controller.abort(new Error('Queued user input stalled; preserve history and resume'));
      return;
    }
    if (
      row.kind !== 'user' ||
      !state.inject ||
      !state.ready ||
      state.completed ||
      state.pendingInject.size > 0 ||
      state.reason ||
      state.controller.signal.aborted
    )
      return;
    if (this.debounceActive(row.session_id, row.first_at, row.last_at, now)) return;
    const rows = this.store.all<Inbound>(
      "SELECT * FROM inbound WHERE session_id=? AND status='queued' AND kind='user' ORDER BY created_at,id LIMIT 20",
      row.session_id,
    );
    const batch: Inbound[] = [];
    let text = 'New user input (JSON records) for the current turn:\n';
    for (const m of rows) {
      // Preserve ordering, retry scopes, and the normal attachment download pipeline.
      if (m.available_at > now || m.batch_id !== null || JSON.parse(m.attachments).length) break;
      const record =
        JSON.stringify({
          id: m.id,
          role: 'user',
          author: m.author,
          at: localStamp(m.created_at, this.config.runtime.timezone ?? hostTimeZone()),
          text: m.content,
          attachments: [],
        }) + '\n';
      // Never acknowledge a record whose text was truncated out of the prompt.
      if (text.length + record.length > this.config.runtime.promptChars) break;
      text += record;
      batch.push(m);
    }
    if (!batch.length) return;
    // A delivered answer is not the end of the provider stream. Keep follow-up
    // intake open during ongoing work; the provider schedules consumption.
    for (const m of batch) state.pendingInject.add(m.id);
    if (
      !state.inject(
        batch.map((m) => m.id),
        text,
      )
    ) {
      for (const m of batch) state.pendingInject.delete(m.id);
      state.inject = undefined;
      this.store.event(row.session_id, state.runId!, 'live_input_rejected', {
        ids: batch.map((m) => m.id),
        transport: 'synchronous',
      });
    }
  }
  private capacityNotice(sessionId: string, episode: string, next?: number): void {
    /* A channel limited to one provider waits for that provider only. Saying "all accounts"
     * there would be false while other channels still run on the other provider. */
    const only = this.store.get<{ value: string }>(
      'SELECT value FROM metadata WHERE key=?',
      `provider-only:${sessionId}`,
    )?.value;
    let text = next
      ? `All configured accounts are cooling down. Your message is queued; Clawstrum will retry after ${new Date(next).toISOString()}.`
      : 'No account is signed in and available. Sign in, then use account reset and resume.';
    let reported = next;
    if (only) {
      const allowed = this.pool.accounts.filter((a) => a.provider === only).map((a) => a.id);
      const ready = this.pool.nextAvailable(
        Date.now(),
        new Set(this.pool.accounts.filter((a) => a.provider !== only).map((a) => a.id)),
      );
      text =
        `This channel is limited to ${only} accounts (${allowed.join(', ') || 'none configured'}), and none of them can run now` +
        (ready ? `; the earliest is free at ${new Date(ready).toISOString()}` : '') +
        '. Other accounts are not used here while the limit is on. Your message is queued.';
      reported = ready;
    }
    /* One notice per waiting episode, not per retry: a session stuck on a provider-only
     * limit would otherwise get an identical notice on every retry, because the retry
     * time in the dedupe key moves each time. A retry that leaves the reported
     * earliest-free time within the same hour sends nothing further; a move of more than
     * an hour from what the first notice for this episode said is wrong enough to correct,
     * once. */
    const metaKey = `capacity-episode:${sessionId}:${episode}`;
    const prior = this.store.get<{ value: string }>(
      'SELECT value FROM metadata WHERE key=?',
      metaKey,
    );
    let dedupeKey = `capacity:${sessionId}:${episode}`;
    if (prior) {
      const state = JSON.parse(prior.value) as { reported: number | null; corrected: boolean };
      if (state.corrected) return;
      const moved =
        (reported ?? null) !== state.reported &&
        (reported === undefined ||
          state.reported === null ||
          Math.abs(reported - state.reported) > 3600000);
      if (!moved) return;
      const bucket = reported !== undefined ? Math.floor(reported / 3600000) : 'auth';
      dedupeKey = `capacity:${sessionId}:${episode}:${bucket}`;
      this.store.exec(
        'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
        metaKey,
        JSON.stringify({ reported: reported ?? null, corrected: true }),
      );
    } else {
      this.store.exec(
        'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
        metaKey,
        JSON.stringify({ reported: reported ?? null, corrected: false }),
      );
    }
    this.store.notice(sessionId, text, dedupeKey, { thread: true });
  }
  private controls(now: number): void {
    const controls = this.store.all<{
      id: number;
      session_id: string;
      command: string;
      argument: string | null;
      created_at: number;
    }>('SELECT * FROM controls ORDER BY id');
    for (const c of controls) {
      archiveRecord(this.store, {
        id: `control:${c.id}:${c.created_at}`,
        sessionId: c.session_id,
        kind: 'control',
        source: 'harness-control',
        content: { command: c.command, argument: c.argument, createdAt: c.created_at },
        counted: true,
        at: c.created_at,
      });
      const state = this.active.get(c.session_id);
      // A switch argument is "ACCOUNT" or "ACCOUNT MODEL" (MODEL "default" or none clears the
      // conversation's model request).
      const target = c.command === 'switch' ? parseSwitchArgument(c.argument) : undefined;
      if (
        c.command === 'switch' &&
        target?.account &&
        !this.config.accounts.some((a) => a.id === target.account)
      ) {
        this.store.outbox(c.session_id, `Unknown account: ${target.account}`);
      } else if (['switch', 'reset', 'cancel'].includes(c.command)) {
        this.consolidationWorkers
          .get(c.session_id)
          ?.abort(new Error(`Consolidation yielded to ${c.command}; completed chunks are saved`));
        if (c.command === 'switch') {
          this.store.exec(
            'UPDATE sessions SET preferred_account=? WHERE id=?',
            target?.account ?? null,
            c.session_id,
          );
          // Switching sets account and model together: no model means the account's own.
          setModelOverride(
            this.store,
            c.session_id,
            target?.account ?? '',
            target?.account ? target.model : null,
          );
        }
        if (c.command === 'reset' || c.command === 'switch') {
          this.store.exec(
            'UPDATE sessions SET remote_id=NULL,fingerprint=NULL WHERE id=?',
            c.session_id,
          );
          this.store.exec(
            "UPDATE inbound SET available_at=? WHERE session_id=? AND status='queued'",
            now,
            c.session_id,
          );
        }
        if (c.command === 'cancel') this.researchWorkers.cancel(c.session_id, c.created_at);
        if (c.command === 'cancel')
          this.store.exec(
            "UPDATE inbound SET status='cancelled' WHERE session_id=? AND status='queued' AND kind='user' AND created_at<=?",
            c.session_id,
            c.created_at,
          );
        if (
          state &&
          (c.command !== 'cancel' ||
            !!this.store.get(
              "SELECT id FROM inbound WHERE session_id=? AND status='running' AND created_at<=?",
              c.session_id,
              c.created_at,
            ))
        ) {
          this.snapshot(state, `Control: ${c.command}`);
          state.reason = c.command as Active['reason'];
          state.controller.abort(new Error(c.command));
        }
      } else if (c.command === 'resume') {
        this.store.exec(
          "UPDATE inbound SET status='queued',attempts=0,interruptions=0,available_at=? WHERE session_id=? AND status IN ('failed','queued')",
          now,
          c.session_id,
        );
      }
      this.store.exec('DELETE FROM controls WHERE id=?', c.id);
    }
  }
  private async execute(run: Run, messages: Inbound[], state: Active): Promise<void> {
    const attempted = new Set<string>();
    let freshSessionRetry = false;
    let contextRetry = false;
    // Set where the native thread is given up, read by buildContext. Function-scoped on purpose: the
    // retry paths below re-enter the loop, and the warning belongs to every attempt after the loss,
    // not just the first one.
    let rotated = false;
    const mcpArgs = mcpInvocation();
    try {
      const attachmentStart = performance.now();
      messages = await abortAfter(
        downloadAttachments(
          this.store,
          messages,
          this.store.session(run.session_id).workspace,
          this.config.runtime.attachmentMaxBytes,
          state.controller.signal,
          this.config.runtime.maxAttempts,
          this.refreshAttachment,
        ),
        state.controller.signal,
      );
      timingEvent(this.store, run, 'attachments', attachmentStart);
      if (this.config.voice.enabled && messages.length) {
        const voiceStart = performance.now();
        await abortAfter(
          transcribeVoiceNotes(
            this.store,
            messages,
            this.config.voice,
            this.store.session(run.session_id).workspace,
            state.controller.signal,
          ),
          state.controller.signal,
        );
        timingEvent(this.store, run, 'voice', voiceStart);
      }
      if (!messages.length) {
        this.store.exec(
          "UPDATE runs SET status='interrupted',error='Attachment preparation failed',ended_at=? WHERE id=?",
          Date.now(),
          run.id,
        );
        return;
      }
      state.taskRun = messages.every((m) => m.kind === 'task');
      const ids = JSON.stringify(messages.map((m) => m.id));
      if (ids !== run.message_ids) {
        run.message_ids = ids;
        run.logical_id = `${run.session_id}:${messages[0]!.id}`;
        this.store.exec(
          'UPDATE runs SET message_ids=?,logical_id=? WHERE id=?',
          ids,
          run.logical_id,
          run.id,
        );
        for (const m of messages)
          this.store.exec('UPDATE inbound SET batch_id=? WHERE id=?', run.logical_id, m.id);
      }
      for (;;) {
        if (state.reason) throw new Error(state.reason);
        const session = this.store.session(run.session_id);
        state.accountId = undefined;
        const account = this.choose(session, attempted);
        if (!account) {
          if (
            this.poolFor(session).choose(
              session.preferred_account,
              session.active_account,
              new Set([...attempted, ...this.foreignAccounts(session)]),
            )
          ) {
            this.store.finish(
              run,
              'queued',
              'Waiting for account concurrency capacity',
              Date.now() + 500,
            );
            return;
          }
          const next = this.pool.nextAvailable();
          this.store.finish(
            run,
            next ? 'queued' : 'failed',
            'No available accounts',
            next ?? Date.now(),
          );
          this.capacityNotice(session.id, run.id, next);
          return;
        }
        const nativeKey = `native:${session.id}`;
        let native = { remoteId: '', turns: 0, bytes: 0, startedAt: Date.now() };
        const storedNative = this.store.get<{ value: string }>(
          'SELECT value FROM metadata WHERE key=?',
          nativeKey,
        );
        if (storedNative) native = JSON.parse(storedNative.value);
        ensureMemory(this.store, null, DEFAULT_AGENTS);
        ensureMemory(this.store, session.id);
        // Reading a request or restoring context is not a request to rehash every artifact.
        // Saved claim observations carry their scope/status; explicit research_status refresh
        // verifies dependencies when needed without blocking every lead turn.
        state.controller.signal.throwIfAborted();
        const adviceStart = performance.now();
        const userText = messages
          .filter((m) => m.kind === 'user' && m.status !== 'done')
          .map((m) => m.content)
          .join('\n');
        // A reply sent through the MCP tool and the run's final result can both be recorded
        // with the same text; drop repeats so the last two are two different replies.
        const previousReplies = this.store
          .all<{ content: string }>(
            "SELECT content FROM history_records WHERE session_id=? AND kind='assistant' ORDER BY seq DESC LIMIT 4",
            session.id,
          )
          .reverse()
          .map((r) => r.content)
          .filter((c, i, all) => c.trim() && c !== all[i - 1]);
        const timeZone = this.config.runtime.timezone ?? hostTimeZone();
        const advisorySkills =
          !contextRetry && decisionsAvailable(this.config.decisions) && this.config.decisions.skills
            ? readSkills([
                path.join(this.store.home, 'skills'),
                path.join(session.workspace, 'skills'),
              ])
            : [];
        const advicePromise = advisorySkills.length
          ? skillAdvice(
              new DecisionService(this.store, this.config.decisions),
              advisorySkills,
              userText,
              {
                scope: `channel:${session.id}`,
                sessionId: session.id,
                runId: run.id,
                signal: state.controller.signal,
              },
              previousReplies,
            )
          : undefined;
        const recallStart = performance.now();
        const recallPromise =
          !contextRetry &&
          decisionsAvailable(this.config.decisions) &&
          this.config.research.enabled &&
          this.config.research.messageRecall.enabled
            ? messageRecall(
                this.store,
                new DecisionService(this.store, this.config.decisions),
                this.config.research.messageRecall,
                {
                  sessionId: session.id,
                  runId: run.id,
                  nativeStartedAt: native.startedAt,
                  userText,
                  previousReply: previousReplies.at(-1) ?? '',
                  timeZone,
                  signal: state.controller.signal,
                },
              ).then((r) => {
                timingEvent(this.store, run, 'message_recall', recallStart, {
                  injected: r.injected.length,
                });
                return r;
              })
            : undefined;
        // Without either call the run stays synchronous here, as it was before message recall.
        const [semanticHint, recalled] =
          advicePromise || recallPromise
            ? await Promise.all([
                (advicePromise ?? Promise.resolve({ decided: false, text: '' })).then((r) => {
                  timingEvent(this.store, run, 'skill_advice', adviceStart);
                  return r;
                }),
                recallPromise ?? Promise.resolve({ text: '', injected: [] as string[] }),
              ])
            : [
                { decided: false, text: '' },
                { text: '', injected: [] as string[] },
              ];
        if (!advicePromise && !recallPromise)
          timingEvent(this.store, run, 'skill_advice', adviceStart);
        const contextStart = performance.now();
        const context = buildContext(
          this.store,
          session,
          account,
          messages,
          contextRetry ? 2000 : this.config.runtime.historyChars,
          contextRetry
            ? Math.min(this.config.runtime.promptChars, 16000)
            : this.config.runtime.promptChars,
          this.config.research,
          replyCorrections(this.store, this.config.research, this.store.replyScope(run.logical_id)),
          // Dropped on the context-overflow retry: there the budget is the scarce thing, and the
          // directive would displace the history it exists to warn about.
          rotated && !contextRetry,
          semanticHint,
          timeZone,
          recalled.text,
          !contextRetry,
          this.config.workAlone.enabled,
          this.accountsNote(),
        );
        timingEvent(this.store, run, 'context', contextStart, {
          promptChars: context.prompt.length,
          instructionChars: context.instructions.length,
          memoryChars: context.contextRefresh.snapshot.memory.length,
          resumed: !!context.resumeId,
        });
        const quietFeedbackKey = `quiet-reply:${this.store.replyScope(run.logical_id)}`;
        const quietFeedback = this.store.get<{ value: string }>(
          'SELECT value FROM metadata WHERE key=?',
          quietFeedbackKey,
        )?.value;
        if (quietFeedback) context.prompt += `\n\nClawstrum delivery feedback:\n${quietFeedback}`;
        const accountChanged = !!session.active_account && session.active_account !== account.id;
        // Schema upgrades leave active_model NULL. Recover the last observed
        // route when possible; an unknown prior model is not a model switch.
        let fromModel: string | null | undefined = session.active_model ?? undefined;
        if (session.active_account && fromModel === undefined) {
          const previous = this.store.get<{ content: string }>(
            "SELECT content FROM events WHERE session_id=? AND type='route' ORDER BY seq DESC LIMIT 1",
            session.id,
          );
          const route = previous ? JSON.parse(previous.content) : undefined;
          if (route?.account === session.active_account && typeof route.model === 'string')
            fromModel = route.model === 'provider default' ? null : route.model;
        }
        const modelChanged =
          !!session.active_account &&
          !accountChanged &&
          fromModel !== undefined &&
          fromModel !== (account.model ?? null);
        const configured = this.config.accounts.find((a) => a.id === account.id)!;
        // A per-conversation model request is this conversation's preferred model for the account.
        const requested = getModelOverride(this.store, session.id);
        const primary =
          requested && requested.account === account.id && session.preferred_account === account.id
            ? { ...configured, model: requested.model }
            : configured;
        const fallback = primary.model !== account.model;
        const noticeKey = `model-notice:${session.id}`;
        const routeKey = accountRoute(account);
        const unannouncedFallback =
          fallback &&
          this.store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', noticeKey)
            ?.value !== routeKey;
        if (accountChanged || modelChanged) {
          this.store.event(session.id, run.id, 'handoff', {
            from: session.active_account,
            to: account.id,
            fromModel,
            toModel: account.model ?? null,
            method: context.resumeId ? 'native session' : 'portable context',
            unfinished: true,
          });
        }
        if (accountChanged || modelChanged || unannouncedFallback) {
          const transition =
            accountChanged || modelChanged
              ? `Switched from ${session.active_account}${fromModel !== undefined ? ` (${fromModel ?? 'provider default'})` : ''} to ${account.id} (${account.model ?? 'provider default'}).`
              : `Using ${account.id} (${account.model ?? 'provider default'}).`;
          const explanation = fallback
            ? ` Fallback model in use; preferred model: ${primary.model}.`
            : '';
          this.store.transaction(() => {
            this.store.notice(
              this.noticeSession(session.id),
              `${transition}${explanation}`,
              `handoff:${run.id}:${JSON.stringify([session.active_account, fromModel, account.id, account.model ?? null])}`,
              {
                thread: !fallback && !this.config.discord.noticeChannelId,
                sourceChannelId: session.channel_id,
              },
            );
            this.store.exec(
              'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
              noticeKey,
              routeKey,
            );
          });
        }
        this.store.exec('UPDATE runs SET account_id=? WHERE id=?', account.id, run.id);
        this.store.exec(
          'UPDATE sessions SET active_account=?,active_model=?,fingerprint=?,remote_id=? WHERE id=?',
          account.id,
          account.model ?? null,
          context.fingerprint,
          context.resumeId ?? null,
          session.id,
        );
        if (!context.resumeId) native = { remoteId: '', turns: 0, bytes: 0, startedAt: Date.now() };
        rememberInjected(this.store, session.id, native.startedAt, recalled.injected);
        native.turns++;
        native.bytes += Buffer.byteLength(
          context.prompt + (context.resumeId ? '' : context.instructions),
        );
        const saveNative = () => {
          if (native.remoteId)
            this.store.exec(
              'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
              nativeKey,
              JSON.stringify(native),
            );
        };
        saveNative();
        this.store.event(session.id, run.id, 'route', {
          account: account.id,
          provider: account.provider,
          model: account.model ?? 'provider default',
          resumed: !!context.resumeId,
        });
        state.accountId = account.id;
        state.workerPid = undefined;
        state.inject = undefined;
        state.pendingInject.clear();
        state.unstartedInject.clear();
        this.store.setUnstarted(run.id, []);
        state.controller.signal.throwIfAborted();
        const ctrl = (state.controller = new AbortController());
        let acceptEvents = true;
        state.started = state.lastActivity = Date.now();
        state.ready = false;
        state.tools.clear();
        state.backgroundTasks = 0;
        state.denials = [];
        state.atResultBoundary = false;
        state.completed = false;
        const usageId = `lead:${run.id}:${randomUUID()}`;
        let usageMeter: UsageMeter | undefined;
        let usageFailed = false;
        const providerStart = performance.now();
        const observedStages = new Set<string>();
        const startedTaskOnly = messages.every((m) => m.kind === 'task');
        try {
          const env = accountEnvironment(account, this.config.accounts);
          Object.assign(env, {
            CLAWSTRUM_HOME: this.store.home,
            CLAWSTRUM_SESSION: session.id,
            CLAWSTRUM_RUN: run.id,
            CLAWSTRUM_WORKSPACE: session.workspace,
          });
          const mcp = {
            command: process.execPath,
            args: mcpArgs,
            env: {
              ...decisionEnvironment(this.config.decisions),
              ...researchEnvironment(this.config.research),
              CLAWSTRUM_HOME: this.store.home,
              CLAWSTRUM_SESSION: session.id,
              CLAWSTRUM_RUN: run.id,
            },
          };
          usageMeter = new UsageMeter(this.store, {
            id: usageId,
            sessionId: session.id,
            runId: run.id,
            role: 'lead',
            provider: account.provider,
            account: account.id,
            model: account.model,
          });
          const mainChannelId = this.config.discord.channelIds[0];
          const rawResult = await abortAfter(
            this.adapters[account.provider].run({
              account,
              // Scheduled/recovery lead work occupies the same conversation. Keep it steerable
              // so a user does not wait behind an entire background turn.
              liveInput: true,
              mainChannel:
                !!mainChannelId &&
                (session.channel_id === mainChannelId ||
                  this.store.parentChannelId(session) === mainChannelId),
              maxTurns: startedTaskOnly
                ? this.config.runtime.scheduledMaxTurns || undefined
                : undefined,
              research: this.config.research,
              prompt: context.prompt,
              instructions: context.instructions,
              contextRefresh: context.contextRefresh,
              cwd: session.workspace,
              sessionId: context.resumeId,
              controller: ctrl,
              env,
              abortGraceMs: this.config.runtime.abortGraceMs,
              inputReleaseGraceMs: this.config.runtime.inputReleaseGraceMs,
              blockedVersions: this.config.runtime.blockedVersions,
              attachInjector: (fn) => {
                state.inject = fn;
              },
              mcp,
              extraMcp: this.config.mcpServers,
              onEvent: (event) => {
                if (
                  !acceptEvents ||
                  (ctrl.signal.aborted && !['diagnostic', 'history'].includes(event.type))
                )
                  return;
                const phase =
                  event.type === 'ready' || event.type === 'session'
                    ? 'provider_ready'
                    : event.type === 'partial' ||
                        event.type === 'usage' ||
                        event.tool?.state === 'started'
                      ? 'first_content'
                      : undefined;
                if (phase && !observedStages.has(phase)) {
                  observedStages.add(phase);
                  timingEvent(this.store, run, phase, providerStart);
                }
                if (event.type === 'history') {
                  archiveProviderRecord(this.store, session.id, event.detail);
                  // Codex reports a compaction as a history event (Claude archives it in its own
                  // hook). Queue the same background memory pass.
                  if ((event.detail as any)?.kind === 'compaction')
                    this.store.exec(
                      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                      consolidationRequestKey(session.id),
                      JSON.stringify({ reason: 'compaction', provider: 'codex', at: Date.now() }),
                    );
                  return;
                }
                if (
                  event.type === 'diagnostic' &&
                  (event.detail as any)?.event === 'worker_started'
                )
                  state.workerPid = (event.detail as any).pid;
                if (event.type === 'context_updated' && event.sessionId) {
                  const detail = event.detail as { revision: string; files: string[] };
                  this.store.exec(
                    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                    `context:${session.id}`,
                    JSON.stringify({ sessionId: event.sessionId, revision: detail.revision }),
                  );
                  this.store.event(session.id, run.id, 'context_updated', detail);
                }
                if (event.type !== 'diagnostic') state.lastActivity = Date.now();
                if (event.type === 'partial' || event.tool?.state === 'started')
                  state.atResultBoundary = false;
                if (event.turnComplete) state.atResultBoundary = true;
                if (typeof event.backgroundTasks === 'number')
                  state.backgroundTasks = event.backgroundTasks;
                // Before the tool_result clears the id, so the refused call can still be named.
                if (event.type === 'activity' && providerToolRefusal(event.detail)) {
                  const denial = {
                    tool: (event.tool?.id && state.tools.get(event.tool.id)) || 'unknown',
                    // The provider's own text, which may carry a suffix naming the cause. The
                    // refused call's arguments stay out; they can hold credentials.
                    text: (toolResultErrorText(event.detail) ?? '').slice(0, 1000),
                  };
                  state.denials.push(denial);
                  // Recorded here rather than only in resumeAfterDenial, so a turn that goes on
                  // to finish normally still leaves the evidence behind.
                  this.store.event(session.id, run.id, 'tool_refusal', denial);
                }
                if (event.tool?.id) {
                  if (event.tool.state === 'started')
                    state.tools.set(event.tool.id, event.tool.name ?? 'unknown');
                  else state.tools.delete(event.tool.id);
                }
                if (event.type === 'ready' || event.type === 'session') state.ready = true;
                if (event.type === 'completed') state.completed = true;
                // Emitted before the next input starts, so a delivered answer sets final_sent
                // first and the injected/input_started handling below reopens the reply for it.
                if (event.type === 'result_text') {
                  const detail = event.detail as { text?: unknown; final?: unknown } | undefined;
                  const text = detail?.text;
                  const reply = stripQuietMarker(
                    normalizeMessageText(
                      typeof text === 'string' ? text : '',
                      this.config.discord.plainDashes,
                    ),
                  ).trim();
                  const skipped = !reply
                    ? 'empty or quiet'
                    : state.reopenedFor && state.unstartedInject.has(state.reopenedFor)
                      ? 'earlier turn already answered'
                      : this.store.hasFinal(run.id)
                        ? 'final already sent'
                        : this.store.findOutput(run.logical_id, reply)
                          ? 'duplicate output'
                          : undefined;
                  if (skipped) {
                    this.store.event(session.id, run.id, 'interim_result_skipped', {
                      reason: skipped,
                    });
                  } else if (
                    reviewReply(this.store, this.config.research, {
                      sessionId: session.id,
                      runId: run.id,
                      scope: this.store.replyScope(run.logical_id),
                      text: reply,
                      route: 'provider-interim',
                    }).blocked
                  ) {
                    this.store.event(session.id, run.id, 'interim_result_blocked', {
                      chars: reply.length,
                    });
                  } else {
                    this.store.transaction(() => {
                      this.store.outbox(session.id, reply, {
                        runId: run.id,
                        final: detail?.final === true,
                      });
                    });
                  }
                  return;
                }
                if (event.type === 'input_started') {
                  const detail = event.detail as { ids?: unknown } | undefined;
                  const ids = Array.isArray(detail?.ids)
                    ? [...new Set(detail.ids)].filter(
                        (id): id is string =>
                          typeof id === 'string' && state.unstartedInject.has(id),
                      )
                    : [];
                  if (ids.length) {
                    // Claude may accept another prompt before the previous prompt's
                    // send_message(final=true), then start it without ending the
                    // native stream. That older final no longer answers current work.
                    const reopened = this.store.transaction(() => {
                      this.store.setUnstarted(
                        run.id,
                        [...state.unstartedInject].filter((id) => !ids.includes(id)),
                      );
                      if (!this.store.hasFinal(run.id)) return false;
                      this.store.reopenReply(run, ids[0]!, state.unstartedInject);
                      return true;
                    });
                    if (reopened) {
                      for (const m of messages)
                        if (!state.unstartedInject.has(m.id)) m.status = 'done';
                      state.turnStarted = Date.now();
                    }
                    for (const id of ids) state.unstartedInject.delete(id);
                    if (state.reopenedFor && ids.includes(state.reopenedFor))
                      state.reopenedFor = undefined;
                    state.atResultBoundary = false;
                    this.store.event(session.id, run.id, 'input_started', { ids });
                  }
                }
                if (event.type === 'injected') {
                  const detail = event.detail as { ids?: unknown; ok?: unknown } | undefined;
                  if (!detail || !Array.isArray(detail.ids) || typeof detail.ok !== 'boolean')
                    return;
                  const ids = [...new Set(detail.ids)].filter(
                    (id): id is string => typeof id === 'string' && state.pendingInject.has(id),
                  );
                  if (!ids.length) return;
                  for (const id of ids) state.pendingInject.delete(id);
                  if (!detail.ok) {
                    state.inject = undefined;
                    this.store.event(session.id, run.id, 'live_input_rejected', { ids });
                    return;
                  }
                  const { accepted, reopened } = this.store.transaction(() => {
                    // Read under the same transaction that attaches accepted input.
                    // An earlier final can race transport acceptance; it must not
                    // discard accepted input or permanently disable this injector.
                    const afterFinal = this.store.hasFinal(run.id);
                    const added: Inbound[] = [];
                    for (const id of ids) {
                      const m = this.store.get<Inbound>(
                        "SELECT * FROM inbound WHERE id=? AND session_id=? AND status='queued' AND kind='user' AND batch_id IS NULL",
                        id,
                        session.id,
                      );
                      if (!m) continue;
                      this.store.exec(
                        "UPDATE inbound SET status='running',batch_id=? WHERE id=?",
                        run.logical_id,
                        id,
                      );
                      added.push({ ...m, status: 'running', batch_id: run.logical_id });
                      this.store.event(session.id, run.id, 'steered', { id });
                    }
                    const reopened = added.length > 0 && afterFinal;
                    if (reopened) {
                      this.store.reopenReply(run, added[0]!.id, state.unstartedInject);
                      state.reopenedFor = added[0]!.id;
                    }
                    this.store.exec(
                      'UPDATE runs SET message_ids=? WHERE id=?',
                      JSON.stringify([...messages, ...added].map((m) => m.id)),
                      run.id,
                    );
                    if (added.length)
                      this.store.setUnstarted(run.id, [
                        ...state.unstartedInject,
                        ...added.map((m) => m.id),
                      ]);
                    return { accepted: added, reopened };
                  });
                  // Update memory only after the transaction commits, so handoff includes the input.
                  if (reopened) {
                    for (const m of messages)
                      if (!state.unstartedInject.has(m.id)) m.status = 'done';
                  }
                  messages.push(...accepted);
                  if (accepted.length) state.taskRun = false;
                  for (const m of accepted) state.unstartedInject.add(m.id);
                  run.message_ids = JSON.stringify(messages.map((m) => m.id));
                  if (accepted.length) {
                    if (reopened) state.turnStarted = Date.now();
                    state.atResultBoundary = false;
                    native.turns++;
                    native.bytes += Buffer.byteLength(accepted.map((m) => m.content).join('\n'));
                    saveNative();
                  }
                }
                if (event.type === 'partial' || event.type === 'diagnostic')
                  this.store.event(
                    session.id,
                    run.id,
                    event.type,
                    typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail),
                  );
                if (event.sessionId) {
                  native.remoteId = event.sessionId;
                  saveNative();
                  this.store.exec(
                    'UPDATE sessions SET remote_id=? WHERE id=?',
                    event.sessionId,
                    session.id,
                  );
                }
                if (event.type === 'activity' || event.type === 'partial')
                  native.bytes += Buffer.byteLength(JSON.stringify(event.detail) ?? '');
                if (event.type === 'activity')
                  this.store.event(session.id, run.id, 'activity', JSON.stringify(event.detail));
                if (event.type === 'usage') {
                  this.store.event(session.id, run.id, 'usage', event.detail);
                  if (event.usage) usageMeter?.observe(event.usage);
                }
                if (event.quota) {
                  const switchesEarly = this.pool.quota(
                    account,
                    event.quota,
                    this.config.runtime.proactiveThreshold,
                  );
                  if (
                    event.quota.utilization !== undefined &&
                    Number.isFinite(event.quota.utilization) &&
                    event.quota.utilization >= this.config.runtime.quotaWarningThreshold
                  ) {
                    const bucket = event.quota.bucket ?? 'unknown';
                    const window = event.quota.resetsAt ?? Math.floor(Date.now() / 3600000);
                    this.store.notice(
                      this.noticeSession(session.id),
                      `Usage warning: ${account.id}, ${bucket} is at ${Math.round(event.quota.utilization! * 100)}%${event.quota.resetsAt ? `; resets ${new Date(event.quota.resetsAt).toISOString()}` : '; reset time unavailable'}. Seen in ${session.id}. Clawstrum moves to the next configured model or account when ${account.id} refuses a request${switchesEarly ? ` or this limit reaches ${Math.round(this.config.runtime.proactiveThreshold * 100)}%` : ''}.`,
                      `quota-warning:${account.id}:${bucket}:${window}`,
                      { thread: !this.config.discord.noticeChannelId },
                    );
                  }
                }
              },
            }),
            ctrl.signal,
            this.config.runtime.abortGraceMs + 2500,
          );
          if (ctrl.signal.aborted) throw ctrl.signal.reason;
          const result = normalizeMessageText(rawResult, this.config.discord.plainDashes);
          const sent = this.store.hasFinal(run.id);
          const taskRun = messages.every((m) => m.kind === 'task');
          const reply = stripQuietMarker(result).trim();
          // A wake (scheduled task, watcher, research event) that has nothing new must stay
          // silent. Two instruction fixes did not stop replies such as "Status sent two minutes
          // ago.\n\nCLAWSTRUM_QUIET" or "The ETA I gave was 14:00, not yet passed." reaching
          // the user (9 of them in five days in one deployment).
          const wakeEcho = taskRun && !!reply && reply.length < 150 && WAKE_ECHO.test(reply);
          if (wakeEcho)
            this.store.event(session.id, run.id, 'wake_echo_suppressed', { text: reply });
          const quiet = (!!result.trim() && !reply) || wakeEcho;
          // Only a person's request must get an answer. Otherwise two bots in one channel answer each
          // other's status notes. A run whose inputs are all wakes or bot messages has no person
          // waiting on it.
          const botRun = messages.every(
            (m) =>
              m.kind === 'task' ||
              !!this.store.get('SELECT 1 FROM metadata WHERE key=?', `bot-input:${m.id}`),
          );
          if (quiet && !taskRun && !botRun && !sent && !this.store.hasOutput(run.logical_id)) {
            const first = this.store.exec(
              'INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)',
              `quiet-reply:${this.store.replyScope(run.logical_id)}`,
              'Your previous response contained only the internal silence marker, but this user request has no answer. Give a concise answer or explain the current blocker/progress. Do not repeat completed external actions. The marker is not a user-facing response.',
            ).changes;
            this.store.event(session.id, run.id, 'quiet_without_answer', { correction: !!first });
            if (first) continue;
            throw new ProviderFailure(
              'fatal',
              'Provider did not answer the user after a delivery correction',
            );
          }
          const recap =
            !sent &&
            reply.length >= RECAP_MIN_CHARS &&
            this.store.recentDuplicate(run.logical_id, Date.now() - RECAP_WINDOW_MS, reply);
          if (recap) {
            this.store.event(session.id, run.id, 'recap_suppressed', { chars: reply.length });
            this.store.exec('UPDATE runs SET final_sent=1 WHERE id=?', run.id);
          } else if (!sent && result.trim() && !quiet) {
            const alreadyQueued = this.store.findOutput(run.logical_id, reply);
            if (
              !alreadyQueued &&
              reviewReply(this.store, this.config.research, {
                sessionId: session.id,
                runId: run.id,
                scope: this.store.replyScope(run.logical_id),
                text: reply,
                route: 'provider-result',
              }).blocked
            )
              continue;
            this.store.transaction(() => {
              const duplicate = this.store.findOutput(run.logical_id, reply);
              if (duplicate) this.store.exec('UPDATE runs SET final_sent=1 WHERE id=?', run.id);
              else this.store.outbox(session.id, reply, { runId: run.id, final: true });
            });
          }
          if (!result.trim() && !sent && this.store.hasOutput(run.logical_id))
            this.store.exec('UPDATE runs SET final_sent=1 WHERE id=?', run.id);
          else if (!result.trim() && !sent)
            throw new ProviderFailure(
              'fatal',
              'Provider completed without an answer; scheduled tasks must explicitly return CLAWSTRUM_QUIET when no notification is needed',
            );
          this.store.event(session.id, run.id, 'assistant', result);
          this.resumeAfterDenial(session.id, run, state, messages);
          this.store.finish(run, 'done');
          return;
        } catch (error) {
          usageFailed = true;
          if (state.reason) throw error;
          const failure = classifyError(ctrl.signal.aborted ? ctrl.signal.reason : error);
          ctrl.abort(failure);
          this.store.event(session.id, run.id, 'interrupted', {
            account: account.id,
            kind: failure.kind,
            error: failure.message,
          });
          if (this.store.hasFinal(run.id)) {
            this.store.transaction(() => {
              this.store.requeueUnstarted(run);
              this.store.finish(run, 'done', `Provider ended after final reply: ${failure.kind}`);
            });
            return;
          }
          // The conversation asked for a model this account refuses (no access, or no such model).
          // When the account has its own models behind it, move to them with the usual notice
          // instead of failing the conversation. Without any, the refusal is reported as before.
          const asked = getModelOverride(this.store, session.id);
          if (
            asked &&
            asked.account === account.id &&
            asked.model === account.model &&
            session.preferred_account === account.id &&
            isModelRefusal(failure) &&
            this.poolFor(session).accounts.find((a) => a.id === account.id)?.modelFallbacks?.length
          ) {
            attempted.add(accountRoute(account));
            state.controller = new AbortController();
            continue;
          }
          if (failure.kind === 'quota' || failure.kind === 'auth') {
            this.pool.fail(account, failure);
            attempted.add(accountRoute(account));
            // This is an intentional handoff. Keep unrelated startup cancellation authoritative.
            state.controller = new AbortController();
            continue;
          }
          if (failure.kind === 'session' && context.resumeId && !freshSessionRetry) {
            freshSessionRetry = true;
            this.store.exec('UPDATE sessions SET remote_id=NULL WHERE id=?', session.id);
            // Same loss as a rotation, involuntary: the thread this run meant to resume is gone.
            rotated = true;
            state.controller = new AbortController();
            continue;
          }
          if (failure.kind === 'context' && !contextRetry) {
            contextRetry = true;
            this.store.exec('UPDATE sessions SET remote_id=NULL WHERE id=?', session.id);
            state.controller = new AbortController();
            continue;
          }
          if (failure.kind === 'transient') {
            // A native thread can itself cause repeat 5xx failures. Rebuild portable context on retry.
            if (context.resumeId)
              this.store.exec('UPDATE sessions SET remote_id=NULL WHERE id=?', session.id);
            const retry = this.store.retry(
              run,
              this.config.runtime.maxAttempts,
              failure.message,
              Date.now(),
              this.config.runtime.slowRetryMs,
            );
            if (
              this.config.runtime.slowRetryMs > 0 &&
              messages.some((m) => m.attempts + 1 >= this.config.runtime.maxAttempts)
            )
              this.store.notice(
                session.id,
                `The provider is still failing transiently. Your input is saved; Clawstrum will retry every ${Math.round(this.config.runtime.slowRetryMs / 60000)} minutes. Use stop to cancel or switch to select another account.`,
                `slow-retry:${run.logical_id}:${Math.floor(Date.now() / 3600000)}`,
                { thread: true },
              );
            if (retry.failed)
              this.failureNotice(
                run,
                failure.message,
                'Transient retries exhausted for some input. Work and history are saved. Inspect status, fix the cause, then resume.',
                account,
              );
            return;
          }
          if (
            failure.kind === 'budget' &&
            startedTaskOnly &&
            messages.some((m) => m.kind === 'user')
          ) {
            // A pre-existing scheduled cap must not fail newly accepted human input. The task
            // retains its budget failure; unanswered users resume in a normal interactive turn.
            this.store.transaction(() => {
              this.store.finish(run, 'failed', failure.message);
              for (const m of messages.filter((m) => m.kind === 'user'))
                this.store.exec(
                  "UPDATE inbound SET status='queued',batch_id=NULL,available_at=? WHERE id=? AND status='failed'",
                  Date.now(),
                  m.id,
                );
            });
            this.store.event(session.id, run.id, 'task_budget_user_handoff', {
              ids: messages.filter((m) => m.kind === 'user').map((m) => m.id),
            });
            return;
          }
          this.store.finish(run, 'failed', failure.message);
          const refused = isSafetyRefusal(failure.message);
          if (refused)
            excludeRefusedInput(
              this.store,
              session.id,
              messages.map((m) => m.id),
            );
          const taskLimit = messages.every((m) => m.kind === 'task')
            ? this.config.runtime.scheduledMaxTurns
            : 0;
          const limitNotice = taskLimit
            ? `Task reached the configured limit of ${taskLimit} ${account.provider === 'claude' ? 'Claude turns' : account.provider === 'gemini' ? 'completed Gemini tool calls' : 'completed Codex tool items'}. Work and history are saved. Set runtime.scheduledMaxTurns to 0 to remove this cap, or increase it, then restart Clawstrum and resume unfinished work.`
            : 'Turn reached a configured execution budget. Work and history are saved. Inspect status, adjust the budget, then resume unfinished work.';
          this.failureNotice(
            run,
            failure.message,
            failure.kind === 'context'
              ? 'Context still exceeds the provider limit after a fresh, smaller handoff. Inspect the saved input/context files, inspect AGENTS.md MEMORY and raw history or select a suitable model, then reset and resume.'
              : failure.kind === 'budget'
                ? limitNotice
                : refused
                  ? 'The model refused this message. It is left out of what this conversation reloads, so later messages still work. Rephrase it to try again.'
                  : 'Work and history are saved. No automatic retry is scheduled. Inspect status, then resume after fixing the cause.',
            account,
          );
          return;
        } finally {
          acceptEvents = false;
          state.inject = undefined;
          usageMeter?.finish(
            ctrl.signal.aborted ? 'interrupted' : usageFailed ? 'failed' : 'completed',
          );
          saveNative();
        }
      }
    } catch (error) {
      if (!state.reason) throw error;
      this.store.event(
        run.session_id,
        run.id,
        'interrupted',
        `${state.reason === 'handoff' ? 'Harness recovery' : 'Control'}: ${state.reason}. Inspect actual workspace and tool events before repeating actions.`,
      );
      this.store.transaction(() => {
        const answered = this.store.hasFinal(run.id);
        if (answered && state.reason === 'cancel') {
          for (const id of this.store.unstarted(run.id))
            this.store.exec(
              "UPDATE inbound SET status='cancelled' WHERE id=? AND status='running' AND kind='user'",
              id,
            );
        } else if (answered) this.store.requeueUnstarted(run);
        this.store.finish(
          run,
          answered ? 'done' : state.reason === 'cancel' ? 'cancelled' : 'queued',
        );
      });
    } finally {
      this.bestEffort('conversation ledger', () => {
        const session = this.store.session(run.session_id);
        writePrivate(
          path.join(session.workspace, 'CONVERSATION.json'),
          JSON.stringify(
            {
              updatedAt: Date.now(),
              session: session.id,
              outstanding: this.store.all(
                "SELECT id,content,status FROM inbound WHERE session_id=? AND status IN ('queued','running','failed') ORDER BY created_at",
                session.id,
              ),
              recentDeliveries: this.store.all(
                'SELECT id,content,status,remote_id FROM outbox WHERE session_id=? ORDER BY created_at DESC LIMIT 10',
                session.id,
              ),
              lastRun: this.store.get('SELECT * FROM runs WHERE id=?', run.id),
            },
            null,
            2,
          ),
        );
      });
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    const stopGroupReviews = this.groupReviews.stop();
    for (const controller of this.consolidationWorkers.values())
      controller.abort(new Error('Service stopping'));
    for (const work of this.maintenance.values())
      work.controller.abort(new Error('Service stopping'));
    for (const state of this.active.values()) {
      this.snapshot(state, 'Service shutdown');
      state.reason = 'shutdown';
      state.controller.abort(new Error('Service stopping'));
    }
    await Promise.allSettled(
      [...this.active.values()]
        .map((s) => s.promise)
        .concat([
          this.researchWorkers.stop(),
          this.clusterMonitor.stop(),
          this.watches.stop(),
          stopGroupReviews,
          ...[...this.maintenance.values()].map((s) => s.promise.then(() => {})),
          ...[...this.consolidations].map((p) => p.then(() => {})),
        ]),
    );
  }
}
