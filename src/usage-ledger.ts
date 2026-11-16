import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { UsageRecord, UsageSnapshot, UsageTotals } from './usage.js';
import { sumUsage } from './usage.js';

export const USAGE_COVERAGE = 'usage-ledger:coverage:v2';
export const USAGE_PREFIX = 'usage-ledger:v2:';
export const usageFields: Array<keyof UsageTotals> = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
  'estimatedCostUsd',
];
export type UsageIdentity = Omit<
  UsageRecord,
  'snapshot' | 'updatedAt' | 'startedAt' | 'endedAt' | 'status'
>;
export interface UsageDelta extends UsageIdentity {
  at: number;
  kind: 'start' | 'delta' | 'finish';
  totals: UsageTotals;
  status?: string;
  final?: boolean;
  source?: string;
}
export function timeKey(prefix: string, at: number): string {
  return prefix + String(Math.floor(at)).padStart(16, '0') + ':';
}
export function initializeUsageLedger(store: Store, now = Date.now()): void {
  store.exec(
    'INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)',
    USAGE_COVERAGE,
    JSON.stringify({ since: now, version: 2 }),
  );
}
export function appendUsageDelta(store: Store, value: UsageDelta): void {
  store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    timeKey(USAGE_PREFIX, value.at) + randomUUID(),
    JSON.stringify(value),
  );
}
/** Snapshot replacement and its positive difference commit together. Duplicate cumulative events
 * do not add usage. Unknown fields stay null; native attribution remains inside parent totals. */
export function persistUsage(
  store: Store,
  record: Omit<UsageRecord, 'updatedAt'>,
  now = Date.now(),
): void {
  store.transaction(() => {
    const key = `usage:${record.sessionId}:${record.id}`;
    const previous = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key);
    const old: UsageRecord | undefined = previous ? JSON.parse(previous.value) : undefined;
    const totals = Object.fromEntries(
      usageFields.map((field) => {
        const a = old?.snapshot.totals[field] ?? null,
          b = record.snapshot.totals[field];
        return [field, b === null ? a : a === null ? b : Math.max(a, b)];
      }),
    ) as unknown as UsageTotals;
    const delta = Object.fromEntries(
      usageFields.map((field) => [
        field,
        totals[field] === null
          ? null
          : Math.max(0, totals[field]! - (old?.snapshot.totals[field] ?? 0)),
      ]),
    ) as unknown as UsageTotals;
    if (
      usageFields.some(
        (field) =>
          delta[field] !== null && (delta[field]! > 0 || old?.snapshot.totals[field] == null),
      )
    ) {
      const {
        snapshot: _,
        updatedAt: _at,
        startedAt: _start,
        endedAt: _end,
        status: _status,
        ...identity
      } = { ...record, updatedAt: now };
      appendUsageDelta(store, {
        ...identity,
        at: now,
        kind: 'delta',
        totals: delta,
        final: record.snapshot.final,
        source: record.snapshot.source,
      });
    }
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      JSON.stringify({
        ...old,
        ...record,
        snapshot: { ...record.snapshot, totals },
        updatedAt: now,
      }),
    );
  });
}
/** Created only when a provider invocation is dispatched, including failures with no usage event. */
export class UsageMeter {
  readonly startedAt: number;
  private ended = false;
  constructor(
    readonly store: Store,
    readonly identity: UsageIdentity,
    now = Date.now(),
  ) {
    this.startedAt = now;
    store.transaction(() => {
      initializeUsageLedger(store, now);
      appendUsageDelta(store, { ...identity, at: now, kind: 'start', totals: sumUsage([]) });
      store.exec(
        'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING',
        `usage:${identity.sessionId}:${identity.id}`,
        JSON.stringify({
          ...identity,
          startedAt: now,
          updatedAt: now,
          status: 'running',
          snapshot: { totals: sumUsage([]), source: 'unreported', final: false },
        }),
      );
    });
  }
  observe(snapshot: UsageSnapshot, now = Date.now()): void {
    if (!this.ended)
      persistUsage(this.store, { ...this.identity, startedAt: this.startedAt, snapshot }, now);
  }
  finish(status: 'completed' | 'failed' | 'interrupted', now = Date.now()): void {
    if (this.ended) return;
    this.ended = true;
    this.store.transaction(() => {
      appendUsageDelta(this.store, {
        ...this.identity,
        at: now,
        kind: 'finish',
        totals: sumUsage([]),
        status,
      });
      this.store.exec(
        "UPDATE metadata SET value=json_set(value,'$.status',?,'$.endedAt',?,'$.updatedAt',?) WHERE key=?",
        status,
        now,
        now,
        `usage:${this.identity.sessionId}:${this.identity.id}`,
      );
    });
  }
}
