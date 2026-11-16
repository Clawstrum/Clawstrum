import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';

const KEY = 'maintenance-budget:v1';
const DAY = 86_400_000;
const ROLES = new Set(['consolidator', 'memory-reviewer', 'group_reviewer']);
/** Reservation role of the once-a-day consolidation pass. Its calls are counted in their own
 * bucket (runtime.consolidation.daily.maxCallsPerDay), never against the shared limit, so a long
 * daily pass cannot use up the calls the memory reviewer needs. Usage is still labelled
 * `consolidator`. */
export const DAILY_ROLE = 'consolidator-daily';
interface Reservation {
  id: string;
  at: number;
  role: string;
}
export class MaintenanceDeferred extends Error {
  constructor(
    message: string,
    readonly retryAt: number,
  ) {
    super(message);
  }
}
function read(store: Store, now: number): Reservation[] {
  const saved = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', KEY);
  if (saved) return (JSON.parse(saved.value) as Reservation[]).filter((r) => r.at > now - DAY);
  // Upgrade conservatively: old usage records already spent the subscription. Completion time
  // may overstate the remaining window, but a deploy/restart must not grant another day's calls.
  return store
    .all<{ key: string; value: string }>("SELECT key,value FROM metadata WHERE key GLOB 'usage:*'")
    .flatMap((row) => {
      const usage = JSON.parse(row.value);
      return ROLES.has(usage.role) && usage.updatedAt > now - DAY
        ? [{ id: row.key, at: usage.updatedAt, role: usage.role }]
        : [];
    });
}
function save(store: Store, rows: Reservation[]) {
  store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    KEY,
    JSON.stringify(rows),
  );
}
/** A requested pass (a channel's compaction summary waiting to be merged into MEMORY) is a
 * priority call: it may use the whole daily limit and ignores the pacing interval. Everything
 * else (backlog catch-up, periodic review) can only use `limit - reserve` calls per window, so a
 * backlog can never leave a requested pass with no call. `reserve` is capped at a quarter of the limit, so a small limit keeps its whole allowance. */
export interface BudgetOptions {
  priority?: boolean;
  reserve?: number;
  /** Count only the daily consolidation bucket (the default counts every other role). The daily
   * bucket has no pacing interval and no requested-pass reserve. */
  daily?: boolean;
}
function bucket(rows: Reservation[], options: BudgetOptions): Reservation[] {
  return rows.filter((r) => (r.role === DAILY_ROLE) === !!options.daily);
}
/** The daily bucket is not paced and has no requested reserve, so it needs the priority behaviour. */
function daily(options: BudgetOptions): BudgetOptions {
  return options.daily ? { priority: true } : options;
}
function report(
  rows: Reservation[],
  limit: number,
  now: number,
  minIntervalMs: number,
  options: BudgetOptions = {},
) {
  const times = rows.map((r) => r.at).sort((a, b) => a - b);
  const reserve = options.priority ? 0 : Math.min(options.reserve ?? 0, Math.floor(limit / 4));
  const usable = limit - reserve;
  const budgetAt =
    rows.length < usable ? now : usable > 0 ? times[rows.length - usable]! + DAY : null;
  const pacingAt = options.priority ? now : times.length ? times.at(-1)! + minIntervalMs : now;
  const nextAvailableAt = budgetAt === null ? null : Math.max(budgetAt, pacingAt);
  return {
    windowHours: 24,
    maxCalls: limit,
    reservedForRequested: reserve,
    used: rows.length,
    remaining: Math.max(0, usable - rows.length),
    minIntervalMs,
    available: nextAvailableAt !== null && nextAvailableAt <= now,
    nextAvailableAt,
    roles: Object.fromEntries(
      [...new Set(rows.map((r) => r.role))].map((role) => [
        role,
        rows.filter((r) => r.role === role).length,
      ]),
    ),
    scope:
      'All channels and accounts: consolidation, memory review and group review. Every provider invocation, including repairs, lookups, failures and cancellations, consumes one reservation. Lead turns and requested research subagents are excluded.',
  };
}
export function maintenanceBudget(
  store: Store,
  limit: number,
  now = Date.now(),
  minIntervalMs = 0,
  options: BudgetOptions = {},
) {
  return report(bucket(read(store, now), options), limit, now, minIntervalMs, daily(options));
}
export function initializeMaintenanceBudget(store: Store, now = Date.now()) {
  store.transaction(() => save(store, read(store, now)));
}
/** Reserve durably before dispatch. Never refund a possibly billed request on failure or crash. */
export function reserveMaintenanceCall(
  store: Store,
  limit: number,
  role: string,
  now = Date.now(),
  minIntervalMs = 0,
  options: BudgetOptions = {},
) {
  return store.transaction(() => {
    const rows = read(store, now),
      status = report(bucket(rows, options), limit, now, minIntervalMs, daily(options));
    if (!status.available)
      throw new MaintenanceDeferred(
        status.remaining
          ? 'Maintenance pacing interval; history and unfinished progress retained'
          : options.daily
            ? 'Daily consolidation call cap reached; history and unfinished progress retained until the next window'
            : status.reservedForRequested && status.used < limit
              ? 'Maintenance calls left today are reserved for requested passes; history and unfinished progress retained'
              : 'Maintenance call budget exhausted; history and unfinished progress retained',
        status.nextAvailableAt ?? now + DAY,
      );
    const reservation = { id: randomUUID(), at: now, role: options.daily ? DAILY_ROLE : role };
    rows.push(reservation);
    save(store, rows);
    return reservation;
  });
}
