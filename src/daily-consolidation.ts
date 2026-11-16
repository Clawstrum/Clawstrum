import type { Store } from './store.js';
import type { Config } from './config.js';
import { consolidationCoverage } from './consolidation.js';
import { hostTimeZone } from './context.js';

export type DailyConfig = Config['runtime']['consolidation']['daily'] & { timezone: string };

/** The daily settings with the zone resolved: daily.timezone, else runtime.timezone, else the host's. */
export function resolveDailyConfig(runtime: Config['runtime']): DailyConfig {
  const daily = runtime.consolidation.daily;
  return { ...daily, timezone: daily.timezone ?? runtime.timezone ?? hostTimeZone() };
}

/** Kinds of new history that make a daily pass worth its calls: what people and the lead said,
 * and the research records. Memory-change and bookkeeping records do not count, so a pass never
 * triggers the next day's pass by writing its own result. */
const ACTIVITY =
  "kind IN ('user','assistant','partial','interrupted','handoff','research_note','research_claim','research_evidence','research_manifest','research_manifest_check','compaction_summary','memory_review_request')";

export const dailyKey = (sessionId: string | null) =>
  `consolidation-daily:${sessionId ?? 'shared'}:last`;

/** The local calendar day (YYYY-MM-DD) and hour (0-23) of a time in an IANA zone. */
export function localDayHour(ms: number, timeZone: string): { day: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function lastDailyPass(
  store: Store,
  sessionId: string | null,
): { day: string; at: number } | undefined {
  const saved = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    dailyKey(sessionId),
  );
  return saved ? JSON.parse(saved.value) : undefined;
}

/** True when the pass is already in progress (a saved daily state): resume it whatever the hour. */
export function dailyInProgress(store: Store, sessionId: string | null): boolean {
  const saved = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    `consolidation:${sessionId ?? 'shared'}`,
  );
  return !!saved && JSON.parse(saved.value).daily === true;
}

/** Does this scope have new history since its consolidation coverage point? */
export function hasNewHistory(store: Store, sessionId: string | null): boolean {
  return !!store.get(
    `SELECT seq FROM history_records WHERE session_id IS ? AND group_id IS NULL AND seq>? AND ${ACTIVITY} LIMIT 1`,
    sessionId,
    consolidationCoverage(store, sessionId),
  );
}

/** Due once per local day, at or after the configured hour, and only with new history. */
export function dailyPassDue(
  store: Store,
  sessionId: string | null,
  config: DailyConfig,
  now: number,
): boolean {
  if (!config.enabled) return false;
  const { day, hour } = localDayHour(now, config.timezone);
  if (hour < config.hour) return false;
  if (lastDailyPass(store, sessionId)?.day === day) return false;
  return hasNewHistory(store, sessionId);
}

/** Record that a daily pass committed. Stored in the database, so a restart does not repeat it. */
export function markDailyPass(
  store: Store,
  sessionId: string | null,
  config: DailyConfig,
  now: number,
): void {
  store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    dailyKey(sessionId),
    JSON.stringify({ day: localDayHour(now, config.timezone).day, at: now }),
  );
}
