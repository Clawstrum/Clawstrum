import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Store } from './store.js';
import type { Run } from './types.js';

type Reader = Pick<Store, 'get' | 'all'>;
type TimedRun = Run & { started_at: number; ended_at: number | null; account_id: string | null };
type Metric = { count: number; totalMs: number; maxMs: number };
const round = (n: number) => Math.round(n * 100) / 100;
const decode = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
/** Calendar day in local time, matching the daemon's own clock, not UTC. */
function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Bounded, content-free daemon telemetry. No model calls, SQL text, prompts or tool arguments. */
export class RuntimeProfiler {
  private readonly delay = monitorEventLoopDelay({ resolution: 50 });
  private metrics: Record<string, Metric> = {};
  private since = Date.now();
  private cpu = process.cpuUsage();
  private samples: unknown[] = [];
  private historyDay: string | undefined;
  private historyWarned = false;
  constructor(private readonly store: Store) {
    store.timing = (name, ms) => this.observe(name, ms);
    this.delay.enable();
  }
  /**
   * Appends every sample to <home>/performance/YYYY-MM-DD.jsonl, compressing the previous day's
   * file on rollover. Unlike the bounded metadata row, this never deletes history.
   * A write/compress failure must never break the engine tick; at most one warning is logged.
   */
  private appendHistory(sample: unknown, now: number): void {
    try {
      const dir = path.join(this.store.home, 'performance');
      const day = localDay(now);
      if (this.historyDay !== day) {
        const previous = this.historyDay ?? localDay(now - 86400000);
        this.historyDay = day;
        if (previous !== day) {
          const plain = path.join(dir, `${previous}.jsonl`);
          if (fs.existsSync(plain)) {
            fs.writeFileSync(`${plain}.gz`, zlib.gzipSync(fs.readFileSync(plain)), {
              mode: 0o600,
            });
            fs.rmSync(plain);
          }
        }
      }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, `${day}.jsonl`), JSON.stringify(sample) + '\n', {
        mode: 0o600,
      });
    } catch (error) {
      if (!this.historyWarned) {
        this.historyWarned = true;
        console.error(
          JSON.stringify({ event: 'performance_history_write_failed', error: String(error) }),
        );
      }
    }
  }
  observe(name: string, ms: number): void {
    const m = (this.metrics[name] ??= { count: 0, totalMs: 0, maxMs: 0 });
    m.count++;
    m.totalMs += ms;
    m.maxMs = Math.max(m.maxMs, ms);
  }
  measure<T>(name: string, fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.observe(name, performance.now() - start);
    }
  }
  flush(state: () => unknown, now = Date.now(), force = false): void {
    if (!force && now - this.since < 15000) return;
    const elapsed = Math.max(1, now - this.since);
    const cpu = process.cpuUsage(this.cpu);
    const sample = {
      at: now,
      windowMs: elapsed,
      pid: process.pid,
      cpuPercent: round(((cpu.user + cpu.system) / 1000 / elapsed) * 100),
      rssBytes: process.memoryUsage().rss,
      eventLoop: {
        p50Ms: round(this.delay.percentile(50) / 1e6),
        p95Ms: round(this.delay.percentile(95) / 1e6),
        maxMs: round(this.delay.max / 1e6),
      },
      operations: Object.fromEntries(
        Object.entries(this.metrics).map(([k, v]) => [
          k,
          { count: v.count, totalMs: round(v.totalMs), maxMs: round(v.maxMs) },
        ]),
      ),
    };
    this.samples.push(sample);
    if (this.samples.length > 60) this.samples.shift();
    this.metrics = {};
    this.delay.reset();
    this.cpu = process.cpuUsage();
    this.since = now;
    this.appendHistory(sample, now);
    this.store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      'performance:runtime',
      JSON.stringify({ version: 1, ...sample, state: state(), samples: this.samples }),
    );
  }
  close(): void {
    this.delay.disable();
    this.store.timing = undefined;
  }
}

export function timingEvent(store: Store, run: Run, phase: string, started: number, extra = {}) {
  store.event(run.session_id, run.id, 'performance', {
    phase,
    durationMs: round(performance.now() - started),
    ...extra,
  });
}

function distribution(values: Array<number | null>) {
  const v = values
    .filter((n): n is number => n !== null && n >= 0 && Number.isFinite(n))
    .sort((a, b) => a - b);
  return {
    count: v.length,
    p50Ms: v.length ? v[Math.ceil(v.length * 0.5) - 1] : null,
    p95Ms: v.length ? v[Math.ceil(v.length * 0.95) - 1] : null,
    maxMs: v.at(-1) ?? null,
  };
}

/** Read-only report. Paging bounds work; older runs lack intake stamps and report unknowns. */
export function performanceReport(
  store: Reader,
  input: { sessionId?: string; since?: number; limit?: number; now?: number } = {},
) {
  const now = input.now ?? Date.now(),
    since = input.since ?? now - 6 * 3600000,
    limit = input.limit ?? 20;
  if (!Number.isFinite(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Invalid performance range (limit 1–100)');
  const meta = (key: string) =>
    decode(
      store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key)?.value ?? 'null',
    );
  const selected = store.all<TimedRun>(
    `SELECT id,session_id,message_ids,status,started_at,ended_at,account_id FROM runs WHERE started_at>=? ${input.sessionId ? 'AND session_id=?' : ''} ORDER BY started_at DESC,id DESC LIMIT ?`,
    since,
    ...(input.sessionId ? [input.sessionId] : []),
    limit + 1,
  );
  const more = selected.length > limit;
  const runs = selected.slice(0, limit).map((r) => {
    // Read only timing/lifecycle fields; never load tool arguments or response text into this report.
    const events = store.all<{
      type: string;
      created_at: number;
      phase: string | null;
      duration: number | null;
      event: string | null;
      outboxId: string | null;
      status: string | null;
      inputId: string | null;
      ids: string | null;
      tool: string | null;
      profile: string | null;
    }>(
      `SELECT type,created_at,
       CASE WHEN json_valid(content) THEN json_extract(content,'$.phase') END phase,
       CASE WHEN json_valid(content) THEN json_extract(content,'$.durationMs') END duration,
       CASE WHEN json_valid(content) THEN json_extract(content,'$.event') END event,
       CASE WHEN json_valid(content) THEN json_extract(content,'$.outboxId') END outboxId,
       CASE WHEN json_valid(content) THEN json_extract(content,'$.status') END status,
       CASE WHEN json_valid(content) THEN json_extract(content,'$.id') END inputId,
       CASE WHEN json_valid(content) THEN json_extract(content,'$.ids') END ids,
       CASE WHEN type='activity' AND json_valid(content) AND json_extract(content,'$.type')='tool_use' THEN json_extract(content,'$.name') END tool,
       CASE WHEN type='performance' THEN content END profile
       FROM events WHERE session_id=? AND run_id=? AND type IN ('route','diagnostic','performance','activity','steered','input_started','delivered','delivery_error') ORDER BY seq LIMIT 10001`,
      r.session_id,
      r.id,
    );
    const truncated = events.length > 10000;
    events.length = Math.min(events.length, 10000);
    const first = (type: string) => events.find((e) => e.type === type)?.created_at ?? null;
    const route = first('route');
    const outputs = store.all<{ id: string; created_at: number; status: string; attempts: number }>(
      'SELECT id,created_at,status,attempts FROM outbox WHERE run_id=? AND origin=? ORDER BY created_at',
      r.id,
      'agent',
    );
    const deliveries = outputs.map((o) => ({
      id: o.id,
      status: o.status,
      attempts: o.attempts,
      at: o.created_at,
      deliveredAt:
        events.find((e) => e.type === 'delivered' && e.outboxId === o.id)?.created_at ?? null,
    }));
    const messages = (JSON.parse(r.message_ids) as string[]).map((id) => {
      const m = store.get<{ created_at: number; kind: string }>(
        'SELECT created_at,kind FROM inbound WHERE id=?',
        id,
      );
      const intake =
        store.get<{ created_at: number }>(
          "SELECT created_at FROM events WHERE session_id=? AND type='input_received' AND json_extract(content,'$.id')=? ORDER BY seq LIMIT 1",
          r.session_id,
          id,
        )?.created_at ?? null;
      const steer = events.find((e) => e.type === 'steered' && e.inputId === id)?.created_at;
      const acceptedAt = steer ?? (m && m.created_at <= r.started_at ? r.started_at : null);
      const consumedAt = steer
        ? (events.find(
            (e) => e.type === 'input_started' && (decode(e.ids ?? '[]') as string[]).includes(id),
          )?.created_at ?? null)
        : r.started_at;
      return {
        id,
        kind: m?.kind,
        sentAt: m?.created_at,
        receivedAt: intake,
        acceptedAt,
        consumedAt,
        ingressMs: m && intake !== null ? Math.max(0, intake - m.created_at) : null,
        queueMs: intake !== null && acceptedAt !== null ? Math.max(0, acceptedAt - intake) : null,
        sentToAcceptedMs: m && acceptedAt !== null ? Math.max(0, acceptedAt - m.created_at) : null,
        consumptionWaitMs: steer && consumedAt ? consumedAt - steer : null,
      };
    });
    let compactStart: number | null = null,
      compactMs = 0,
      compactCount = 0;
    for (const e of events) {
      if (e.type !== 'activity') continue;
      if (e.status === 'compacting') {
        if (compactStart === null) {
          compactStart = e.created_at;
          compactCount++;
        }
      } else if (compactStart !== null) {
        compactMs += e.created_at - compactStart;
        compactStart = null;
      }
    }
    if (compactStart !== null) compactMs += (r.ended_at ?? now) - compactStart;
    const firstDelivered = deliveries.find((o) => o.deliveredAt !== null)?.deliveredAt ?? null;
    const inputAt = messages
      .filter((m) => m.kind === 'user')
      .map((m) => m.sentAt!)
      .filter((t) => t <= r.started_at);
    return {
      id: r.id,
      sessionId: r.session_id,
      status: r.status,
      account: r.account_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationMs: (r.ended_at ?? now) - r.started_at,
      preparationMs: route === null ? null : route - r.started_at,
      firstActivityMs:
        route !== null && first('activity') !== null ? first('activity')! - route : null,
      firstReplyCreatedMs: outputs[0] ? outputs[0].created_at - r.started_at : null,
      firstReplyDeliveredMs: firstDelivered === null ? null : firstDelivered - r.started_at,
      firstUserReplyMs:
        firstDelivered !== null && inputAt.length ? firstDelivered - Math.min(...inputAt) : null,
      nativeCompaction: {
        count: compactCount,
        observedMs: compactMs,
        active: compactStart !== null,
      },
      stages: events
        .filter((e) => e.type === 'performance')
        .map((e) => {
          const p = decode(e.profile ?? '{}');
          return {
            phase: e.phase,
            durationMs: e.duration,
            ...(e.phase === 'context'
              ? {
                  promptChars: p?.promptChars,
                  instructionChars: p?.instructionChars,
                  memoryChars: p?.memoryChars,
                  resumed: p?.resumed,
                }
              : {}),
          };
        }),
      tools: Object.fromEntries(
        [...new Set(events.map((e) => e.tool).filter(Boolean))].map((tool) => [
          tool,
          events.filter((e) => e.tool === tool).length,
        ]),
      ),
      messages,
      deliveries: deliveries.map((o) => ({
        ...o,
        deliveryMs: o.deliveredAt === null ? null : o.deliveredAt - o.at,
      })),
      truncated,
    };
  });
  const runtime = meta('performance:runtime');
  const heartbeat = Number(meta('heartbeat') ?? 0);
  const queue = store.all<{
    session_id: string;
    kind: string;
    count: number;
    oldest: number;
    run_id: string | null;
    run_started: number | null;
  }>(
    `SELECT i.session_id,i.kind,count(*) count,min(i.created_at) oldest,r.id run_id,r.started_at run_started FROM inbound i LEFT JOIN runs r ON r.session_id=i.session_id AND r.status='running' WHERE i.status='queued' ${input.sessionId ? 'AND i.session_id=?' : ''} GROUP BY i.session_id,i.kind,r.id ORDER BY oldest LIMIT 100`,
    ...(input.sessionId ? [input.sessionId] : []),
  );
  return {
    at: now,
    since,
    limit,
    more,
    scope: input.sessionId ?? 'all',
    health: {
      heartbeatAgeMs: heartbeat ? Math.max(0, now - heartbeat) : null,
      runtimeSampleAgeMs: runtime ? Math.max(0, now - runtime.at) : null,
      warnings: [
        ...(!heartbeat || now - heartbeat > 30000 ? ['daemon_heartbeat_missing_or_stale'] : []),
        ...(!runtime || now - runtime.at > 45000 ? ['runtime_profile_missing_or_stale'] : []),
        ...(runtime?.eventLoop?.maxMs > 10000 ? ['event_loop_stall_observed'] : []),
        ...(queue.some((q) => q.kind === 'user' && now - q.oldest > 60000)
          ? ['user_queue_over_one_minute']
          : []),
        ...(runs.some((r) => r.nativeCompaction.active && r.status === 'running')
          ? ['provider_native_compaction_active']
          : []),
      ],
      recovery: meta('discord-recovery'),
      queued: queue.map((q) => ({
        ...q,
        ageMs: Math.max(0, now - q.oldest),
        blockedByRun: !!q.run_id,
      })),
      outbox: store.all<{ status: string; count: number; oldest: number }>(
        'SELECT status,count(*) count,min(created_at) oldest FROM outbox WHERE status IN (?,?) GROUP BY status',
        'pending',
        'failed',
      ),
    },
    runtime,
    summary: {
      preparation: distribution(runs.map((r) => r.preparationMs)),
      firstReply: distribution(runs.map((r) => r.firstUserReplyMs)),
      queue: distribution(
        runs.flatMap((r) => r.messages.filter((m) => m.kind === 'user').map((m) => m.queueMs)),
      ),
      delivery: distribution(runs.flatMap((r) => r.deliveries.map((d) => d.deliveryMs))),
      nativeCompactionMs: runs.reduce((sum, r) => sum + r.nativeCompaction.observedMs, 0),
    },
    runs,
    interpretation:
      'Totals cover selected runs only. First reply means an agent delivery, not task completion or proof that each live-injected question was answered. Intake timestamps exist only after instrumentation; earlier ingress/queue splits are unknown. Compaction time is observed provider status time, not token usage. Operation durations overlap (inclusive); do not sum them. Runtime samples cover this daemon only, reset on restart, and retain at most 15 minutes. No message text, tool arguments or model calls are included.',
  };
}
