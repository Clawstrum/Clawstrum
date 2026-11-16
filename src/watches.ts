import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Store } from './store.js';
import { scrubbedEnvironment } from './secrets.js';

export const watchSpecSchema = z
  .object({
    condition: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('file'),
          path: z.string().min(1),
          nonempty: z.boolean().default(false),
        })
        .strict(),
      z
        .object({
          type: z.literal('command'),
          argv: z.array(z.string()).min(1).max(100),
          cwd: z.string().optional(),
        })
        .strict(),
    ]),
    message: z.string().trim().min(1).max(32000),
    intervalMs: z.number().int().min(1000).max(86400000).default(60000),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(30 * 86400000)
      .default(86400000),
    checkTimeoutMs: z.number().int().min(100).max(60000).default(10000),
    warnAfterMs: z.number().int().min(0).default(0),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.warnAfterMs >= spec.timeoutMs)
      ctx.addIssue({ code: 'custom', message: 'warnAfterMs must be less than timeoutMs' });
    if (spec.condition.type === 'command' && !spec.condition.argv[0]?.trim())
      ctx.addIssue({ code: 'custom', message: 'Command executable cannot be empty' });
  });
export type WatchSpec = z.infer<typeof watchSpecSchema>;
export interface Watch {
  id: string;
  sessionId: string;
  key: string;
  spec: WatchSpec;
  status: 'active' | 'completed' | 'timed_out' | 'cancelled';
  createdAt: number;
  nextCheck: number;
  deadline: number;
  checks: number;
  warned?: boolean;
  endedAt?: number;
  lastError?: string;
  /** Checks in a row that crashed, timed out or could not start, and whether the lead was told. */
  failedChecks?: number;
  failureReported?: boolean;
}
/** Checks in a row that must fail before the conversation is told its watch cannot fire. */
export const WATCH_FAILURE_WAKE_AFTER = 3;
/**
 * Exit status alone cannot tell "not done yet" from a crashed check: a Python traceback exits 1,
 * the same code a probe uses for "not yet". These stderr markers mean the probe itself broke.
 */
const CRASH_MARKERS = [
  /Traceback \(most recent call last\)/,
  /: command not found/,
  /SyntaxError:/,
];
const prefix = 'watch:';
function save(store: Store, watch: Watch): void {
  store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    prefix + watch.id,
    JSON.stringify(watch),
  );
}
export function getWatch(store: Store, id: string): Watch | undefined {
  const row = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', prefix + id);
  return row ? JSON.parse(row.value) : undefined;
}
export function listWatches(store: Store, sessionId?: string): Watch[] {
  return (
    store
      // Metadata keys are case-sensitive namespaces. GLOB uses the primary-key range index;
      // default SQLite LIKE scans every value, including large unrelated usage/history records.
      .all<{ value: string }>("SELECT value FROM metadata WHERE key GLOB 'watch:*'")
      .map((row) => JSON.parse(row.value) as Watch)
      .filter((row) => !sessionId || row.sessionId === sessionId)
  );
}
export function addWatch(
  store: Store,
  sessionId: string,
  key: string,
  input: unknown,
  now = Date.now(),
): Watch {
  if (!key.trim() || key.length > 200) throw new Error('Watch key must have 1–200 characters');
  const session = store.session(sessionId);
  const spec = watchSpecSchema.parse(input);
  if (spec.condition.type === 'file')
    spec.condition.path = path.resolve(session.workspace, spec.condition.path);
  else spec.condition.cwd = path.resolve(session.workspace, spec.condition.cwd ?? '.');
  const id = createHash('sha256')
    .update(sessionId + '\0' + key)
    .digest('hex');
  return store.transaction(() => {
    const existing = getWatch(store, id);
    if (existing) {
      if (JSON.stringify(existing.spec) !== JSON.stringify(spec))
        throw new Error('Watch key conflict; use a new key for a different condition or follow-up');
      return existing;
    }
    const watch: Watch = {
      id,
      sessionId,
      key,
      spec,
      status: 'active',
      createdAt: now,
      nextCheck: now,
      deadline: now + spec.timeoutMs,
      checks: 0,
    };
    save(store, watch);
    store.event(sessionId, null, 'watch_created', { id, key, spec });
    return watch;
  });
}
export function cancelWatch(
  store: Store,
  id: string,
  sessionId?: string,
  now = Date.now(),
): boolean {
  return store.transaction(() => {
    const watch = getWatch(store, id);
    if (!watch || (sessionId && watch.sessionId !== sessionId) || watch.status !== 'active')
      return false;
    watch.status = 'cancelled';
    watch.endedAt = now;
    save(store, watch);
    store.event(watch.sessionId, null, 'watch_cancelled', { id });
    return true;
  });
}
export async function checkCondition(spec: WatchSpec, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  if (spec.condition.type === 'file') {
    try {
      const stat = await fs.stat(spec.condition.path);
      signal.throwIfAborted();
      return stat.isFile() && (!spec.condition.nonempty || stat.size > 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  const condition = spec.condition;
  return new Promise((resolve, reject) => {
    const child = spawn(condition.argv[0]!, condition.argv.slice(1), {
      cwd: condition.cwd,
      env: scrubbedEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    // Keep only the end of stderr; a crash names its cause on the last lines.
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    const kill = (kind: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(kind);
        else process.kill(-child.pid, kind);
      } catch {
        /* The child/group may have already exited. */
      }
    };
    const abort = (error: Error) => {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 250);
    };
    const onAbort = () => abort(new Error('Watch check cancelled'));
    const timer = setTimeout(() => abort(new Error('Watch check timed out')), spec.checkTimeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    let done = false;
    const finish = (error?: Error, code?: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      // Probe commands must not leave a background process tree behind.
      kill('SIGKILL');
      if (error || failure) reject(error ?? failure);
      else if (code !== 0 && CRASH_MARKERS.some((m) => m.test(stderr)))
        reject(new Error(`Watch check crashed (exit ${code}): ${stderr.trim().slice(-600)}`));
      else resolve(code === 0);
    };
    child.once('error', (error) => finish(error));
    // 'close' waits for stderr to be read to the end. A probe that leaves a background process
    // holding stderr never closes it, so finish 200 ms after exit at the latest.
    let exited: NodeJS.Timeout | undefined;
    child.once('exit', (code) => {
      exited = setTimeout(() => finish(undefined, code), 200);
    });
    child.once('close', (code) => {
      clearTimeout(exited);
      finish(undefined, code);
    });
  });
}
/** Only the daemon polls; state transitions and durable wakes commit together. */
export class WatchMonitor {
  private current?: Promise<void>;
  private controller = new AbortController();
  private stopped = false;
  constructor(
    readonly store: Store,
    readonly check = checkCondition,
    /** Work-alone sessions get their own wake naming pending watches; skip the hourly status. */
    readonly skipStatus: (sessionId: string) => boolean = () => false,
  ) {}
  get busy(): boolean {
    return !!this.current;
  }
  tick(now = Date.now()): void {
    if (this.stopped || this.current) return;
    this.current = this.poll(now)
      .catch((error) => {
        console.error(JSON.stringify({ event: 'watch_poll_error', error: String(error) }));
      })
      .finally(() => {
        this.current = undefined;
      });
  }
  private lastStatusScan = 0;
  /**
   * While a conversation waits on watches, wake it for a one-line status after an hour with no
   * message from it. As an instruction only, the hourly-status rule still let an agent go an hour
   * and more silent during a long copy, with the user asking "progress?". At most one wake per
   * conversation per hour, whatever the number
   * of watches.
   */
  statusWakes(now = Date.now(), quietMs = 3600000): void {
    if (now - this.lastStatusScan < 60000) return;
    this.lastStatusScan = now;
    const waiting = new Map<string, Watch[]>();
    for (const watch of listWatches(this.store))
      if (watch.status === 'active')
        waiting.set(watch.sessionId, [...(waiting.get(watch.sessionId) ?? []), watch]);
    for (const [sessionId, watches] of waiting) {
      if (this.skipStatus(sessionId)) continue;
      watches.sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
      const since = Math.min(...watches.map((w) => w.createdAt));
      const sent =
        this.store.get<{ at: number | null }>(
          "SELECT MAX(created_at) at FROM outbox WHERE session_id=? AND origin='agent'",
          sessionId,
        )?.at ?? 0;
      const key = 'watch-status:' + sessionId;
      const woke = Number(
        this.store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key)?.value ??
          0,
      );
      if (now - Math.max(since, sent, woke) < quietMs) continue;
      this.store.transaction(() => {
        this.store.exec(
          'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          key,
          String(now),
        );
        this.store.enqueue({
          id: `watch-status:${sessionId}:${now}`,
          sessionId,
          author: 'Clawstrum watcher',
          kind: 'task',
          content: `Hourly status: nothing has been sent in this conversation for ${Math.round((now - Math.max(since, sent)) / 60000)} minutes while these watches are still pending: ${watches.map((w) => w.key).join(', ')}. Check the actual state of what they wait on and send one short status line: what is done, what is left, and a new ETA if the old one no longer holds. If nothing anyone here is waiting on is still running, or they asked for no updates, reply with only the word CLAWSTRUM_QUIET.`,
          at: now,
        });
        this.store.event(sessionId, null, 'watch_status', {
          watches: watches.map((w) => w.key),
          quietSince: Math.max(since, sent),
        });
      });
    }
  }
  async poll(now = Date.now()): Promise<void> {
    if (this.stopped) return;
    this.statusWakes(now);
    const due = listWatches(this.store)
      .filter(
        (watch) => watch.status === 'active' && Math.min(watch.nextCheck, watch.deadline) <= now,
      )
      .sort((a, b) => Math.min(a.nextCheck, a.deadline) - Math.min(b.nextCheck, b.deadline))
      .slice(0, 4);
    await Promise.all(
      due.map(async (watch) => {
        let success = false,
          error: string | undefined;
        if (now < watch.deadline) {
          try {
            success = await this.check(watch.spec, this.controller.signal);
          } catch (e) {
            error = String(e).slice(0, 2000);
          }
        }
        if (this.stopped) return;
        // A slow probe can cross the deadline; it cannot report late completion as timely success.
        const at = Math.max(now, Date.now());
        this.store.transaction(() => {
          const current = getWatch(this.store, watch.id);
          if (!current || current.status !== 'active') return;
          current.checks++;
          current.lastError = error;
          current.failedChecks = error ? (current.failedChecks ?? 0) + 1 : 0;
          current.nextCheck = at + current.spec.intervalMs;
          const wake = (kind: string, content: string) => {
            this.store.enqueue({
              id: `watch:${current.id}:${kind}`,
              sessionId: current.sessionId,
              author: 'Clawstrum watcher',
              kind: 'task',
              content,
              at,
            });
            this.store.event(current.sessionId, null, 'watch_' + kind, {
              id: current.id,
              checks: current.checks,
              error,
            });
          };
          if (at >= current.deadline) {
            current.status = 'timed_out';
            current.endedAt = at;
            wake(
              'timed_out',
              `Watch ${current.key} expired without confirmed completion.${error ? ' Last check: ' + error : ''}\nDo not treat the success follow-up as completed. Original follow-up: ${current.spec.message}`,
            );
          } else if (success) {
            current.status = 'completed';
            current.endedAt = at;
            wake(
              'completed',
              `Watch ${current.key}: its condition is satisfied. Follow-up: ${current.spec.message}`,
            );
          } else if (
            error &&
            !current.failureReported &&
            (current.failedChecks ?? 0) >= WATCH_FAILURE_WAKE_AFTER
          ) {
            // A check that crashes on every run reads as "not yet", so the watch could never fire
            // and nobody would know.
            current.failureReported = true;
            wake(
              'check_failing',
              `Watch ${current.key} cannot fire: its check failed ${current.failedChecks} times in a row. Last error: ${error}\nRun the check yourself with the same interpreter, arguments and cwd, fix it, then cancel this watch and add a corrected one (or cancel it if it is no longer needed). It keeps polling until then. What it was waiting for: ${current.spec.message}`,
            );
          } else if (
            !current.warned &&
            current.spec.warnAfterMs > 0 &&
            at >= current.createdAt + current.spec.warnAfterMs
          ) {
            current.warned = true;
            wake(
              'warning',
              `Watch ${current.key} is still pending after its warning threshold. It continues watching until its deadline. Follow-up context: ${current.spec.message}`,
            );
          }
          save(this.store, current);
        });
      }),
    );
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    await this.current;
  }
}
