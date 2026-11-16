import type { Store } from '../store.js';
import type { DecisionRecord } from './client.js';

export function decisionProfile(
  store: Pick<Store, 'all'>,
  input: { sessionId?: string; since?: number; limit?: number; offset?: number } = {},
) {
  const since = input.since ?? 0,
    limit = input.limit ?? 100,
    offset = input.offset ?? 0;
  if (
    !Number.isFinite(since) ||
    since < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    throw new Error('Invalid profile range');
  const records = store
    .all<{ value: string }>(
      `SELECT value FROM metadata WHERE key GLOB 'jev:call:*'
    AND json_extract(value,'$.at')>=? AND (? IS NULL OR json_extract(value,'$.sessionId')=?) ORDER BY key DESC LIMIT ? OFFSET ?`,
      since,
      input.sessionId ?? null,
      input.sessionId ?? null,
      limit + 1,
      offset,
    )
    .map((r) => JSON.parse(r.value) as DecisionRecord);
  const more = records.length > limit;
  records.length = Math.min(records.length, limit);
  const features: Record<
    string,
    {
      calls: number;
      cacheHits: number;
      unavailable: number;
      reportedInputTokens: number;
      usageUnknownAttempts: number;
      estimatedUsd: number;
      latencies: number[];
    }
  > = {};
  for (const r of records) {
    const f = (features[r.feature] ??= {
      calls: 0,
      cacheHits: 0,
      unavailable: 0,
      reportedInputTokens: 0,
      usageUnknownAttempts: 0,
      estimatedUsd: 0,
      latencies: [],
    });
    f.calls++;
    f.cacheHits += Number(r.cached);
    f.unavailable += Number(r.status !== 'decision');
    f.reportedInputTokens += r.reportedInputTokens;
    f.usageUnknownAttempts += r.usageUnknownAttempts;
    f.estimatedUsd += r.estimatedUsd;
    f.latencies.push(r.latencyMs);
  }
  return {
    records,
    nextOffset: more ? offset + limit : null,
    features: Object.fromEntries(
      Object.entries(features).map(([key, f]) => {
        const { latencies, ...metrics } = f;
        latencies.sort((a, b) => a - b);
        return [
          key,
          {
            ...metrics,
            p50Ms: latencies[Math.ceil(latencies.length * 0.5) - 1],
            p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
          },
        ];
      }),
    ),
    guidance:
      'Totals cover only this page. Follow nextOffset before reporting all-time totals. API charges are estimated; unknown-usage attempts retain conservative reservations. Subscription savings and scientific accuracy are not inferred from classifier calls.',
  };
}
