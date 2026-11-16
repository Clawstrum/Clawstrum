import { requestMemoryReview, memoryReviewKey, reviewCoverage } from './memory-review.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Store } from './store.js';
import { historyPage } from './history.js';
import { rankedHistory } from './decisions/history.js';
import { DecisionService } from './decisions/client.js';
import {
  ensureMemory,
  observeMemory,
  updateMemory,
  memoryFile,
  MEMORY_SECTIONS,
  nestMemoryContent,
} from './memory.js';
import { configSchema, readConfig, type Config } from './config.js';
import { writeDashboardSyncRequest, readDashboardSyncResult } from './dashboard.js';
import { registerResearchTools } from './research/tools.js';
import { registerWorkAloneTools } from './work-alone.js';
import { reviewReply } from './research/replies.js';
import { citationDocumentPath, readCitationDocument } from './research/citations.js';
import type { Delegation } from './research/workers.js';
import { addTask, listTasks } from './scheduler.js';
import { hostTimeZone } from './context.js';
import { readableTimes, inputTime, timeInput } from './tool-times.js';
import { spoolFile } from './attachments.js';
import { keyPlaces, sendFileRefusal } from './worker-sandbox.js';
import { normalizeMessageText, stripQuietMarker } from './message-text.js';
import type { Run } from './types.js';
import { addWatch, listWatches, cancelWatch, watchSpecSchema } from './watches.js';
import { boardInput } from './groups/config.js';
import { groupBoard, groupHistory } from './groups/store.js';

const toolText = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
});
/** Loose enough to match both a real McpServer#registerTool and a definition collector that
 * never starts a server (dashboard.ts); registration only reads `description`/`inputSchema`. */
export type RegisterFn = (
  name: string,
  definition: { description: string; inputSchema?: Record<string, z.ZodTypeAny> },
  callback: (...args: any[]) => any,
) => void;
export interface CoreToolContext {
  store: Store;
  config: Config;
  sessionId: string;
  session: { workspace: string };
  owner: { id: string };
  run?: Run;
  worker?: Delegation;
  runId?: string;
  deliveryScope: () => string;
}
/** Every tool the lead (worker absent) or a subagent (worker present) gets, besides the research
 * tools in research/tools.ts. Registration itself only reads config/worker, never store or owner;
 * dashboard.ts calls this with a collecting register and a throwaway context to list descriptors
 * without opening a session, a run or an MCP server.
 */
export function registerCoreTools(register: RegisterFn, ctx: CoreToolContext): void {
  const { store, config, sessionId, session, run, worker, runId, deliveryScope } = ctx;
  const result = (value: unknown) =>
    toolText(readableTimes(value, config.runtime.timezone ?? hostTimeZone()));
  register(
    'history',
    {
      description:
        'Navigate raw history without truncation loss. search/list return stable record IDs and nextAfter; read returns nextOffset. rank returns a local lexical shortlist, optionally reranked by Jev, with raw paths and superseding corrections; use full reads to verify passages and search/list for exhaustive coverage. from/to take a time with an offset, as records show it. Superseded records are historical evidence, not current guidance.',
      inputSchema: {
        action: z.enum(['search', 'list', 'read', 'rank']),
        scope: z.enum(['channel', 'shared', 'group']).default('channel'),
        group: z.string().optional(),
        query: z.string().optional(),
        id: z.string().optional(),
        after: z.number().int().nonnegative().optional(),
        before: z.number().int().nonnegative().optional(),
        from: timeInput.optional(),
        to: timeInput.optional(),
        kind: z.string().optional(),
        source: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().nonnegative().optional(),
        chars: z.number().int().min(1).max(50000).optional(),
      },
    },
    async ({ scope, group, from, to, ...rest }, extra) => {
      const query = { ...rest, from: inputTime(from, 'from'), to: inputTime(to, 'to') };
      if (query.action === 'rank') {
        if (!query.query?.trim()) throw new Error('rank requires query');
        if (scope === 'group') {
          if (!config.groups.enabled || !group)
            throw new Error('Group history requires enabled groups and a group ID');
          groupHistory(store, sessionId, group, { action: 'list', limit: 1 });
        }
        return result(
          await rankedHistory(
            store,
            scope === 'group' ? { groupId: group! } : scope === 'shared' ? null : sessionId,
            { ...query, query: query.query },
            new DecisionService(store, config.decisions),
            { sessionId, runId, workerId: worker?.id, signal: extra.signal },
          ),
        );
      }
      if (scope === 'group') {
        if (!config.groups.enabled || !group)
          throw new Error('Group history requires enabled groups and a group ID');
        return result(groupHistory(store, sessionId, group, { ...query, action: query.action }));
      }
      return result(
        historyPage(store, scope === 'shared' ? null : sessionId, {
          ...query,
          action: query.action,
        }),
      );
    },
  );
  if (!worker) {
    if (config.groups.enabled)
      register(
        'group_board',
        {
          description:
            'Read memberships/current shared boards, or publish, revise, retract and resolve group information with stable keys and expected revisions. Updates appear immediately; economical consistency review runs asynchronously. Supply group IDs when several memberships exist. Cite raw history, evidence and applicable dataset/version; received board context is not a new user request.',
          inputSchema: boardInput.shape,
        },
        async (input) => {
          const latest = store.get<Run>('SELECT * FROM runs WHERE id=?', run!.id)!;
          const message = (JSON.parse(latest.message_ids) as string[]).at(-1);
          // Raw epoch milliseconds: entries take observedAt/expiresAt/reviewAfter back that way.
          return toolText(
            groupBoard(
              store,
              sessionId,
              input,
              message && /^\d+$/.test(message) ? message : undefined,
            ),
          );
        },
      );
    register(
      'memory_review',
      {
        description:
          'Request semantic review of active memory and standing instructions without resetting the native session. Use after corrections to persistent assumptions; update MEMORY immediately as well. Preserves history and supersedes stale claims, not words.',
        inputSchema: {
          action: z.enum(['request', 'status']).default('request'),
          scope: z.enum(['channel', 'shared']).default('channel'),
          reason: z.string().min(1).max(4000).optional(),
        },
      },
      async ({ action, scope, reason }) => {
        const target = scope === 'shared' ? null : sessionId;
        if (action === 'request')
          requestMemoryReview(
            store,
            target,
            reason ?? 'Review current assumptions against the latest user corrections',
          );
        const name = memoryReviewKey(target);
        return result({
          scope,
          enabled: config.runtime.memoryReview.enabled,
          coverage: reviewCoverage(store, target),
          pending: !!store.get('SELECT key FROM metadata WHERE key=?', name),
          completedAt: Number(
            store.get<{ value: string }>(
              'SELECT value FROM metadata WHERE key=?',
              `${name}:completed-at`,
            )?.value ?? 0,
          ),
          message:
            action === 'request'
              ? 'Requested; runs on idle capacity after debounce/cooldown. Apply the user’s correction to current work immediately.'
              : undefined,
        });
      },
    );
    register(
      'memory_update',
      {
        description:
          'Read or replace one AGENTS.md MEMORY subsection. Use the returned revision for updates; preserves standing instructions and archives old revisions. Keep current decisions with brief change dates/history references; superseded detail belongs in raw history. Shared scope is for deliberately shared lessons.',
        inputSchema: {
          scope: z.enum(['channel', 'shared']).default('channel'),
          section: z.enum(MEMORY_SECTIONS).optional(),
          markdown: z.string().optional(),
          revision: z.string().optional(),
        },
      },
      async ({ scope, section, markdown, revision }) => {
        const target = scope === 'shared' ? null : sessionId;
        ensureMemory(store, target);
        const doc =
          section && markdown !== undefined
            ? updateMemory(
                store,
                target,
                { [section]: markdown },
                revision ??
                  (() => {
                    throw new Error(
                      'Supply the revision returned by memory_update before replacing a section',
                    );
                  })(),
              )
            : observeMemory(store, target);
        return result({
          file: memoryFile(store, target),
          revision: doc.revision,
          memory: doc.memory,
        });
      },
    );
    register(
      'watch',
      {
        description:
          'Watch a file or a cheap observation command without model polling. Durable across daemon restarts; completion/expiry queues one follow-up. Use a stable key, observation-only command argv, and explicit timeout. Commands have full host access and no implicit shell. action=list/cancel manages this conversation’s watches.',
        inputSchema: {
          action: z.enum(['add', 'list', 'cancel']),
          key: z.string().optional(),
          spec: watchSpecSchema.optional(),
          id: z.string().optional(),
        },
      },
      async ({ action, key, spec, id }) => {
        if (action === 'list') return result(listWatches(store, sessionId));
        if (action === 'cancel') {
          if (!id) throw new Error('cancel needs id');
          return result({ cancelled: cancelWatch(store, id, sessionId) });
        }
        if (!key || !spec) throw new Error('add needs key and spec');
        return result(addWatch(store, sessionId, key, spec));
      },
    );
    register(
      'send_message',
      {
        description:
          'Send text to this Discord conversation. Use actual newlines for paragraphs; put literal escape sequences and code in backticks. Write for someone who sees only the chat: lead with the result and explain necessary unfamiliar terms. final=true marks the completed answer and prevents an automatic recap. Use distinct stable keys for multipart output and mark the last part final.',
        inputSchema: {
          text: z.string().min(1),
          final: z.boolean().default(false),
          key: z.string().min(1),
        },
      },
      async ({ text, final, key }) => {
        text = stripQuietMarker(normalizeMessageText(text, config.discord.plainDashes)).trim();
        if (!text)
          return result({
            queued: false,
            quiet: true,
            advice:
              'The silence marker is internal. Answer any outstanding human request; otherwise return it as the final result without calling send_message.',
          });
        const stableKey = `${deliveryScope()}:message:${key}`;
        const review = store.get('SELECT id FROM outbox WHERE dedupe_key=?', stableKey)
          ? { blocked: false }
          : reviewReply(store, config.research, {
              sessionId,
              runId: run!.id,
              scope: deliveryScope(),
              text,
              route: 'send_message',
            });
        if (review.blocked) throw new Error(review.feedback);
        const id = store.outbox(sessionId, text, {
          runId,
          final,
          key: stableKey,
        });
        store.event(sessionId, runId ?? null, 'assistant', text);
        return result({
          id,
          queued: true,
          review: review.feedback,
          advice:
            config.discord.sendAdviceChars > 0 && text.length > config.discord.sendAdviceChars
              ? `Over the ${config.discord.sendAdviceChars}-character target. Next time drop whole points or send them as a second labeled part; do not shorten each point until it stops explaining itself. Every number kept says what it measures and which side is which.`
              : undefined,
        });
      },
    );
    register(
      'send_file',
      {
        description:
          'Attach a local file to this Discord conversation. Uses an immutable copy for reliable delivery. Refuses the files subagents cannot see (keys, logins, history, the database, home dotfiles) and secret files such as .env.',
        inputSchema: {
          path: z.string(),
          caption: z.string().default(''),
          final: z.boolean().default(false),
          key: z.string().min(1),
        },
      },
      async ({ path: filename, caption, final, key }) => {
        caption = normalizeMessageText(caption, config.discord.plainDashes);
        const source = path.resolve(session.workspace, filename);
        const refusal = sendFileRefusal(
          source,
          keyPlaces(
            store.home,
            session.workspace,
            config.accounts.map((a) => a.home),
          ),
        );
        if (refusal) throw new Error(refusal);
        const file = spoolFile(store, source, config.runtime.attachmentMaxBytes);
        try {
          const stableKey = `${deliveryScope()}:file:${key}`;
          let document: { path: string; text?: string; error?: string } | undefined;
          const existing = store.get('SELECT id FROM outbox WHERE dedupe_key=?', stableKey);
          if (
            !existing &&
            config.research.enabled &&
            config.research.validation !== 'off' &&
            citationDocumentPath(filename)
          ) {
            try {
              document = { path: filename, text: readCitationDocument(file) };
            } catch (error) {
              document = { path: filename, error: String(error) };
            }
          }
          const review = existing
            ? { blocked: false }
            : reviewReply(store, config.research, {
                sessionId,
                runId: run!.id,
                scope: deliveryScope(),
                text: caption,
                route: 'send_file',
                document,
              });
          if (review.blocked) throw new Error(review.feedback);
          const id = store.outbox(sessionId, caption, {
            runId,
            file,
            final,
            key: stableKey,
          });
          const retained = store.get<{ file_path: string }>(
            'SELECT file_path FROM outbox WHERE id=?',
            id,
          )!.file_path;
          if (retained !== file) fs.rmSync(file, { force: true });
          return result({ id, queued: true, review: review.feedback });
        } catch (error) {
          fs.rmSync(file, { force: true });
          throw error;
        }
      },
    );
    register(
      'checkpoint',
      {
        description:
          'Persist a provider-independent handoff: objective, decisions, completed work, pending work, artifacts, and already-started external actions.',
        inputSchema: { markdown: z.string().min(1) },
      },
      async ({ markdown }) => {
        ensureMemory(store, sessionId);
        const current = observeMemory(store, sessionId);
        const saved = updateMemory(
          store,
          sessionId,
          { 'Current work': nestMemoryContent(markdown) },
          current.revision,
        );
        return result({
          saved: memoryFile(store, sessionId),
          section: 'MEMORY / Current work',
          revision: saved.revision,
        });
      },
    );
    register(
      'schedule_task',
      {
        description:
          'Durable follow-up. A key deduplicates within this logical input, including retries; later inputs can reuse it. Reusing a key for different parameters is an error. Prefer one-shots; cron needs an IANA timezone.',
        inputSchema: {
          prompt: z.string().min(1),
          kind: z.enum(['once', 'cron']),
          schedule: z.string(),
          timezone: z.string().default('UTC'),
          key: z.string().min(1),
        },
      },
      async ({ prompt, kind, schedule, timezone, key }) => {
        const stable = createHash('sha256').update(`${deliveryScope()}:task:${key}`).digest('hex');
        const existed = !!store.get('SELECT id FROM tasks WHERE id=?', stable);
        const id = addTask(store, sessionId, prompt, kind, schedule, timezone, Date.now(), stable);
        return result({
          id,
          created: !existed,
          ...store.get<{ status: string; next_run: number | null }>(
            'SELECT status,next_run FROM tasks WHERE id=?',
            id,
          ),
        });
      },
    );
    register(
      'list_tasks',
      {
        description: 'List this conversation’s durable tasks and their run outcomes.',
        inputSchema: {},
      },
      async () => result(listTasks(store, sessionId)),
    );
    register(
      'cancel_task',
      { description: 'Cancel future wakes for a task.', inputSchema: { id: z.string() } },
      async ({ id }) =>
        result({
          changed: Number(store.exec("UPDATE tasks SET status='cancelled' WHERE id=?", id).changes),
        }),
    );
    register(
      'status',
      { description: 'Read account state and recent run outcomes.', inputSchema: {} },
      async () =>
        result({
          accounts: store.all('SELECT id,cooldown_until,disabled,reason,usage_json FROM accounts'),
          runs: store.all(
            'SELECT id,status,account_id,error,started_at FROM runs WHERE session_id=? ORDER BY started_at DESC LIMIT 5',
            sessionId,
          ),
        }),
    );
    register(
      'dashboard_sync',
      {
        description:
          'Ask the daemon to update the private dashboard forum now, instead of waiting for its automatic sync. Use after changing Clawstrum config, an AGENTS.md, a skill, or Clawstrum code that a dashboard post shows. Returns created/edited/unchanged/archived post counts, or says plainly why nothing synced.',
        inputSchema: {},
      },
      async () => {
        if (!config.discord.dashboard.enabled)
          return result({
            enabled: false,
            message: 'Dashboard disabled (discord.dashboard.enabled=false); nothing to sync.',
          });
        const id = randomUUID();
        writeDashboardSyncRequest(store, { id, requestedAt: Date.now() });
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const outcome = readDashboardSyncResult(store, id);
          if (outcome) return result(outcome);
          await delay(300);
        }
        return result({
          error: 'Timed out waiting for the daemon to run the sync. Check the daemon is running.',
        });
      },
    );
  }
}
export async function serveMcp(home: string): Promise<void> {
  const sessionId = process.env.CLAWSTRUM_SESSION;
  const runId = process.env.CLAWSTRUM_RUN;
  const workerId = process.env.CLAWSTRUM_DELEGATION;
  if (!sessionId || (!runId && !workerId)) throw new Error('MCP needs a Clawstrum session and run');
  const store = new Store(home);
  const session = store.session(sessionId);
  const run = runId ? store.get<Run>('SELECT * FROM runs WHERE id=?', runId) : undefined;
  const worker = workerId
    ? store.get<Delegation>('SELECT * FROM delegations WHERE id=?', workerId)
    : undefined;
  const owner = worker ?? run;
  if (
    !owner ||
    owner.session_id !== sessionId ||
    owner.status !== 'running' ||
    (workerId && !worker)
  )
    throw new Error('Unknown or inactive Clawstrum run/subagent');
  const config = owner.config_json
    ? configSchema.parse(JSON.parse(owner.config_json))
    : readConfig(home);
  // A key belongs to a logical input, not the entire lifetime of a conversation.
  // The first input id survives retries and provider changes; the attempt id does not.
  const deliveryScope = () => worker?.id ?? store.replyScope(run!.logical_id);
  const server = new McpServer({ name: 'clawstrum', version: '0.1.0' });
  const register: RegisterFn = (name, definition, callback) =>
    server.registerTool(
      name as any,
      definition as any,
      (async (...args: any[]) => {
        if (
          !store.get(
            `SELECT id FROM ${worker ? 'delegations' : 'runs'} WHERE id=? AND status='running'`,
            owner.id,
          )
        )
          throw new Error('This Clawstrum run is no longer active');
        return callback(...args);
      }) as any,
    );
  registerCoreTools(register, {
    store,
    config,
    sessionId,
    session,
    owner,
    run,
    worker,
    runId,
    deliveryScope,
  });
  if (!worker) registerWorkAloneTools(register, { store, config, sessionId, run: run! });
  registerResearchTools(register, {
    store,
    config,
    sessionId,
    get scope() {
      return deliveryScope();
    },
    runId,
    worker: !!worker,
    workerId: worker?.id,
  });
  await server.connect(new StdioServerTransport());
  process.stdin.once('end', () => {
    void server.close().finally(() => store.close());
  });
}
