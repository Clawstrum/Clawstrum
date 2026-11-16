import fs from 'node:fs';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { Run } from './types.js';
import type { RegisterFn } from './mcp.js';
import { listWatches } from './watches.js';
import { nextOccurrence } from './scheduler.js';
import { hostTimeZone, localStamp } from './context.js';
import { readableTimes } from './tool-times.js';

const WAKE_TEMPLATE = fs.readFileSync(
  new URL('../templates/work-alone/wake.md', import.meta.url),
  'utf8',
);
const MORNING_TEMPLATE = fs.readFileSync(
  new URL('../templates/work-alone/morning.md', import.meta.url),
  'utf8',
);
const MORNING_KEY = 'work-alone:morning';

export interface WorkAloneState {
  session_id: string;
  active: number;
  since: number | null;
  ask: string | null;
  report: string | null;
  off_at: number | null;
  off_reason: string | null;
  updated_at: number;
}

export function getWorkAlone(store: Store, sessionId: string): WorkAloneState | undefined {
  return store.get<WorkAloneState>('SELECT * FROM work_alone WHERE session_id=?', sessionId);
}

export function workAloneActive(store: Store, sessionId: string): boolean {
  return !!store.get('SELECT 1 FROM work_alone WHERE session_id=? AND active=1', sessionId);
}

export function setWorkAlone(
  store: Store,
  sessionId: string,
  change: { on: true; ask: string } | { on: false; report?: string; reason: string },
  now = Date.now(),
): WorkAloneState {
  if (change.on)
    store.exec(
      `INSERT INTO work_alone(session_id,active,since,ask,report,off_at,off_reason,updated_at)
       VALUES(?,1,?,?,NULL,NULL,NULL,?)
       ON CONFLICT(session_id) DO UPDATE SET active=1,since=excluded.since,ask=excluded.ask,
         report=NULL,off_at=NULL,off_reason=NULL,updated_at=excluded.updated_at`,
      sessionId,
      now,
      change.ask,
      now,
    );
  else
    store.exec(
      `INSERT INTO work_alone(session_id,active,report,off_at,off_reason,updated_at)
       VALUES(?,0,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET active=0,report=excluded.report,off_at=excluded.off_at,
         off_reason=excluded.off_reason,updated_at=excluded.updated_at`,
      sessionId,
      change.report ?? null,
      now,
      change.reason,
      now,
    );
  return getWorkAlone(store, sessionId)!;
}

function maxAt(store: Store, sql: string, ...params: string[]): number {
  return store.get<{ at: number | null }>(sql, ...params)?.at ?? 0;
}

/** Inputs, replies and run ends all count as activity; a wake is due only after a quiet stretch. */
export function lastActivity(store: Store, state: WorkAloneState): number {
  const id = state.session_id;
  return Math.max(
    state.since ?? 0,
    maxAt(store, 'SELECT MAX(created_at) at FROM inbound WHERE session_id=?', id),
    maxAt(store, 'SELECT MAX(created_at) at FROM outbox WHERE session_id=?', id),
    maxAt(store, 'SELECT MAX(ended_at) at FROM runs WHERE session_id=?', id),
  );
}

/** Wakes do not count here: only the human, the agent's own messages and steps, and cluster jobs. */
export function lastProgress(store: Store, state: WorkAloneState): number {
  const id = state.session_id;
  return Math.max(
    state.since ?? 0,
    maxAt(
      store,
      `SELECT MAX(created_at) at FROM inbound i WHERE session_id=? AND kind='user'
         AND NOT EXISTS (SELECT 1 FROM metadata m WHERE m.key='bot-input:'||i.id)`,
      id,
    ),
    maxAt(store, "SELECT MAX(created_at) at FROM outbox WHERE session_id=? AND origin='agent'", id),
    maxAt(
      store,
      "SELECT MAX(created_at) at FROM inbound WHERE session_id=? AND id LIKE 'work-alone:continue:%'",
      id,
    ),
    maxAt(store, 'SELECT MAX(updated_at) at FROM cluster_jobs WHERE session_id=?', id),
  );
}

export function pendingWork(store: Store, sessionId: string): string[] {
  const watches = listWatches(store)
    .filter((w) => w.sessionId === sessionId && w.status === 'active')
    .map((w) => `watch ${w.key}`);
  const jobs = store
    .all<{
      id: string;
      job_id: string | null;
    }>(
      "SELECT id,job_id FROM cluster_jobs WHERE session_id=? AND status NOT IN ('completed','failed','cancelled') ORDER BY created_at",
      sessionId,
    )
    .map((j) => `cluster job ${j.job_id ?? j.id}`);
  return [...watches, ...jobs];
}

export function wakePrompt(ask: string, minutes: number, pending: string[]): string {
  return WAKE_TEMPLATE.replace('{{ask}}', () => ask)
    .replace('{{minutes}}', String(minutes))
    .replace(
      '{{pending}}',
      pending.length ? ` Still pending: ${pending.join(', ')}.` : ' No job or watch is pending.',
    )
    .trim();
}

export class WorkAloneMonitor {
  private lastScan = 0;
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {}
  wakes(now = Date.now()): void {
    if (!this.config.workAlone.enabled || now - this.lastScan < 60000) return;
    this.lastScan = now;
    const quietMs = this.config.workAlone.quietMinutes * 60000;
    const staleMs = this.config.workAlone.staleHours * 3600000;
    for (const state of this.store.all<WorkAloneState>('SELECT * FROM work_alone WHERE active=1')) {
      const sessionId = state.session_id;
      if (now - lastProgress(this.store, state) > staleMs) {
        setWorkAlone(this.store, sessionId, { on: false, reason: 'stale' }, now);
        this.store.event(sessionId, null, 'work_alone_off', { reason: 'stale' });
        console.log(
          JSON.stringify({
            event: 'work_alone_stale',
            sessionId,
            staleHours: this.config.workAlone.staleHours,
          }),
        );
        continue;
      }
      if (this.store.get("SELECT id FROM runs WHERE session_id=? AND status='running'", sessionId))
        continue;
      const quiet = now - lastActivity(this.store, state);
      if (quiet < quietMs) continue;
      const pending = pendingWork(this.store, sessionId);
      this.store.transaction(() => {
        const created = this.store.enqueue({
          id: `work-alone:wake:${sessionId}:${Math.floor(now / quietMs)}`,
          sessionId,
          author: 'Clawstrum work-alone',
          kind: 'task',
          content: wakePrompt(state.ask ?? '', Math.round(quiet / 60000), pending),
          at: now,
        });
        if (created)
          this.store.event(sessionId, null, 'work_alone_wake', {
            quietMinutes: Math.round(quiet / 60000),
            pending,
          });
      });
    }
  }
  morning(now = Date.now()): void {
    const { enabled, morning } = this.config.workAlone;
    if (!enabled || !morning.enabled) return;
    const timezone = morning.timezone ?? this.config.runtime.timezone ?? hostTimeZone();
    const raw = this.store.get<{ value: string }>(
      'SELECT value FROM metadata WHERE key=?',
      MORNING_KEY,
    )?.value;
    const saved = raw
      ? (JSON.parse(raw) as { schedule: string; timezone: string; next: number })
      : undefined;
    const arm = () =>
      this.store.exec(
        'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
        MORNING_KEY,
        JSON.stringify({
          schedule: morning.cron,
          timezone,
          next: nextOccurrence('cron', morning.cron, timezone, now),
        }),
      );
    if (!saved || saved.schedule !== morning.cron || saved.timezone !== timezone) return void arm();
    if (now < saved.next) return;
    if (now - saved.next > 3600000) {
      console.log(JSON.stringify({ event: 'work_alone_morning_skipped', due: saved.next, now }));
      return void arm();
    }
    const sessions = this.store.all<{ session_id: string; at: number }>(
      `SELECT session_id, MAX(created_at) at FROM inbound i WHERE kind='user' AND created_at>=?
         AND NOT EXISTS (SELECT 1 FROM metadata m WHERE m.key='bot-input:'||i.id)
       GROUP BY session_id ORDER BY session_id`,
      now - morning.activeHours * 3600000,
    );
    this.store.transaction(() => {
      sessions.forEach(({ session_id: sessionId, at }, i) => {
        const id = `work-alone:morning:${sessionId}:${saved.next}`;
        const created = this.store.enqueue({
          id,
          sessionId,
          author: 'Clawstrum work-alone',
          kind: 'task',
          content: MORNING_TEMPLATE.replace('{{since}}', localStamp(at, timezone)).trim(),
          at: now,
        });
        if (!created) return;
        this.store.exec('UPDATE inbound SET available_at=? WHERE id=?', now + i * 600000, id);
        this.store.event(sessionId, null, 'work_alone_morning', { id });
      });
      arm();
    });
  }
}

export interface WorkAloneToolContext {
  store: Store;
  config: Config;
  sessionId: string;
  run: Run;
}

const text = (value: unknown, isError = false) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
  ...(isError ? { isError: true } : {}),
});

export function registerWorkAloneTools(register: RegisterFn, ctx: WorkAloneToolContext): void {
  if (!ctx.config.workAlone.enabled) return;
  const { store, sessionId } = ctx;
  const quiet = ctx.config.workAlone.quietMinutes;
  const state = (value: unknown) =>
    text(readableTimes(value, ctx.config.runtime.timezone ?? hostTimeZone()));
  register(
    'work_alone',
    {
      description: `Switch work-alone mode on when the user hands you work to do without them (their words and the time in \`ask\`), off with your end report (one line in \`report\`) when done, blocked, out of budget, or nothing worth doing is left. While on: a check wakes you after ${quiet} quiet minutes, you may hand yourself steps with continue_work, and you message the user only for results that change an answer, blockers, and the end report.`,
      inputSchema: {
        on: z.boolean().describe('true to switch on, false to switch off.'),
        ask: z
          .string()
          .optional()
          .describe('Required when on: their words and the time they wrote them.'),
        report: z.string().optional().describe('When off: one line of the end report.'),
      },
    },
    async ({ on, ask, report }) => {
      if (on) {
        if (!ask?.trim())
          return text('ask is required when switching on: the user’s words and the time.', true);
        return state(setWorkAlone(store, sessionId, { on: true, ask: ask.trim() }));
      }
      return state(setWorkAlone(store, sessionId, { on: false, report, reason: 'agent' }));
    },
  );
  register(
    'continue_work',
    {
      description:
        'Hand yourself your next step as the next turn, which starts shortly after this one ends in this conversation. For lead-only steps in work the user gave you to do on your own: a derivation, reading, writing, an analysis, the next piece after this one. While a cluster job runs, keep working on anything that does not depend on its result; its end wakes you. Not to ask the user something. No cap, every call is logged. If nothing worth doing is left under their ask, do not call it: send the user the end report and switch work_alone off. Call it as the last thing in the turn, then end the turn.',
      inputSchema: {
        prompt: z
          .string()
          .min(20)
          .describe(
            'The next step, written out so a fresh turn can do it: what to do, which files, what done looks like.',
          ),
        produced: z
          .string()
          .min(3)
          .describe(
            'One line: what this turn produced (a file, a number, a decision), or "nothing new". Logged.',
          ),
      },
    },
    async ({ prompt, produced }) => {
      if (
        store.get(
          "SELECT id FROM inbound WHERE session_id=? AND status='queued' AND id LIKE 'work-alone:continue:%'",
          sessionId,
        )
      )
        return text('A continue_work step is already queued for this conversation.', true);
      const id = `work-alone:continue:${ctx.run.logical_id}`;
      const created = store.transaction(() => {
        const created = store.enqueue({
          id,
          sessionId,
          author: 'Clawstrum work-alone',
          kind: 'task',
          content: `[Clawstrum continue_work: a step you handed yourself, not a message from the user]\n${prompt}`,
        });
        if (created) store.event(sessionId, ctx.run.id, 'continue_work', { id, produced });
        return created;
      });
      return created
        ? text({ queued: id })
        : text('This turn already queued its continue_work step.', true);
    },
  );
}
