import { persistUsage } from './usage-ledger.js';
import type { Store } from './store.js';
import type { ProviderName } from './types.js';

export interface UsageTotals {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
}
export interface UsageSnapshot {
  totals: UsageTotals;
  source: string;
  final: boolean;
  /** Observed assistant requests only; a diagnostic subset of totals, never an extra charge. */
  attribution?: Array<{ role: string; totals: UsageTotals }>;
}
const fields: Array<keyof UsageTotals> = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
  'estimatedCostUsd',
];
const number = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
const add = (values: Array<number | null>): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};
export function sumUsage(rows: UsageTotals[]): UsageTotals {
  return Object.fromEntries(
    fields.map((field) => [field, add(rows.map((r) => r[field]))]),
  ) as unknown as UsageTotals;
}
function maximum(a: UsageTotals, b: UsageTotals): UsageTotals {
  return Object.fromEntries(
    fields.map((field) => [
      field,
      a[field] === null ? b[field] : b[field] === null ? a[field] : Math.max(a[field]!, b[field]!),
    ]),
  ) as unknown as UsageTotals;
}
function claudeTotals(u: any, cost?: unknown): UsageTotals {
  const inputTokens = number(u?.inputTokens ?? u?.input_tokens);
  const outputTokens = number(u?.outputTokens ?? u?.output_tokens);
  const cacheReadTokens = number(u?.cacheReadInputTokens ?? u?.cache_read_input_tokens);
  const cacheWriteTokens = number(u?.cacheCreationInputTokens ?? u?.cache_creation_input_tokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: add([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]),
    estimatedCostUsd: number(cost ?? u?.costUSD),
  };
}
/** Fresh-query modelUsage is cumulative. Resumed runtimes can return lifetime session totals,
 * so use per-turn main-loop usage there and leave unobserved internal usage/cost unknown.
 * Assistant blocks share message.id; retain each request once, updating its counters as it grows. */
export class ClaudeUsage {
  private requests = new Map<string, { role: string; totals: UsageTotals }>();
  private authoritative?: UsageTotals;
  private accounted?: UsageTotals;
  private reported?: UsageTotals;
  private turns = new Map<string, UsageTotals>();
  private resumedMainAccounted?: UsageTotals;
  constructor(private readonly resumed = false) {}
  observe(m: any): UsageSnapshot | undefined {
    let reconciled = false;
    if (m.type === 'assistant' && typeof m.message?.id === 'string' && m.message.usage) {
      const id = m.message.id;
      const totals = claudeTotals(m.message.usage);
      const previous = this.requests.get(id);
      this.requests.set(id, {
        role: m.parent_tool_use_id ? `native-subagent:${m.subagent_type ?? 'unknown'}` : 'main',
        totals: previous ? maximum(previous.totals, totals) : totals,
      });
    } else if (m.type === 'result') {
      const models =
        m.modelUsage && typeof m.modelUsage === 'object' ? Object.values(m.modelUsage) : [];
      if (this.resumed) {
        // Some deployed Claude runtimes restore modelUsage/total_cost_usd from the native
        // session on resume. Those are not this invocation's usage. Reconcile the documented
        // per-turn main-loop counters instead, plus separately observed native requests.
        const key = String(
          m.uuid ?? m.result_index ?? [...this.requests.keys()].at(-1) ?? JSON.stringify(m.usage),
        );
        if (!this.turns.has(key)) {
          const main = sumUsage(
            [...this.requests.values()].filter((r) => r.role === 'main').map((r) => r.totals),
          );
          const observedTurn = Object.fromEntries(
            fields.map((field) => [
              field,
              main[field] === null
                ? null
                : Math.max(0, main[field]! - (this.resumedMainAccounted?.[field] ?? 0)),
            ]),
          ) as unknown as UsageTotals;
          const turn = m.usage ? maximum(claudeTotals(m.usage), observedTurn) : observedTurn;
          turn.estimatedCostUsd = null;
          this.turns.set(key, turn);
          this.resumedMainAccounted = main;
          this.authoritative = sumUsage([
            ...this.turns.values(),
            ...[...this.requests.values()].filter((r) => r.role !== 'main').map((r) => r.totals),
          ]);
          reconciled = true;
        }
      } else if (models.length) {
        const totals = sumUsage(models.map((u) => claudeTotals(u)));
        totals.estimatedCostUsd = number(m.total_cost_usd) ?? totals.estimatedCostUsd;
        // Startup/error results can contain zeroed counters. Never erase already observed work.
        this.authoritative = this.authoritative ? maximum(this.authoritative, totals) : totals;
        reconciled = true;
      } else if (!this.requests.size && m.usage) {
        // Legacy/test runtimes without modelUsage cannot establish all-query usage.
        this.requests.set(String(m.uuid ?? 'legacy-result'), {
          role: 'main',
          totals: claudeTotals(m.usage),
        });
      }
    } else return;
    const groups = new Map<string, UsageTotals[]>();
    for (const request of this.requests.values()) {
      const rows = groups.get(request.role) ?? [];
      rows.push(request.totals);
      groups.set(request.role, rows);
    }
    const observed = sumUsage([...this.requests.values()].map((r) => r.totals));
    if (reconciled) this.accounted = observed;
    const current = this.authoritative
      ? (Object.fromEntries(
          fields.map((field) => [
            field,
            this.authoritative![field] === null
              ? observed[field]
              : this.authoritative![field]! +
                Math.max(0, (observed[field] ?? 0) - (this.accounted?.[field] ?? 0)),
          ]),
        ) as unknown as UsageTotals)
      : observed;
    this.reported = this.reported ? maximum(this.reported, current) : current;
    return {
      totals: this.reported,
      source: this.resumed
        ? 'claude-resumed-turn-usage'
        : this.authoritative
          ? 'claude-model-usage'
          : 'claude-observed-requests',
      final: m.type === 'result',
      attribution: [...groups].map(([role, rows]) => ({ role, totals: sumUsage(rows) })),
    };
  }
}
function codexTotals(u: any): UsageTotals {
  const input = number(u?.inputTokens ?? u?.input_tokens);
  const cacheReadTokens = number(u?.cachedInputTokens ?? u?.cached_input_tokens);
  const outputTokens = number(u?.outputTokens ?? u?.output_tokens);
  return {
    // Codex includes cache hits in input, whereas Claude reports them as separate buckets.
    inputTokens:
      input !== null && cacheReadTokens !== null ? Math.max(0, input - cacheReadTokens) : null,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: null,
    // Reasoning tokens are already part of output. Do not add them a second time.
    totalTokens: number(u?.totalTokens) ?? add([input, outputTokens]),
    estimatedCostUsd: null,
  };
}
/** ACP prompt response usage. Gemini counts cached tokens inside the prompt (input) count, as Codex
 * does; thought tokens are billed as output and are reported separately, so they are added once. */
export function geminiTurnUsage(response: any): UsageSnapshot {
  const u = response?.usage;
  const input = number(u?.inputTokens);
  const cacheReadTokens = number(u?.cachedReadTokens);
  const output = number(u?.outputTokens);
  const thought = number(u?.thoughtTokens);
  const outputTokens = output !== null || thought !== null ? add([output, thought]) : null;
  return {
    totals: {
      inputTokens:
        input !== null && cacheReadTokens !== null ? Math.max(0, input - cacheReadTokens) : input,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: null,
      totalTokens: number(u?.totalTokens) ?? add([input, outputTokens]),
      estimatedCostUsd: null,
    },
    source: 'gemini-acp-turn',
    final: true,
  };
}
export function codexTurnUsage(usage: unknown): UsageSnapshot {
  return { totals: codexTotals(usage), source: 'codex-turn', final: true };
}
/** App Server totals belong to a thread. A resumed turn starts at total-last on its first
 * current-turn update. Repeated cumulative notifications do not count as more model calls. */
export class CodexUsage {
  private baseline?: UsageTotals;
  private previous?: UsageTotals;
  private carry = sumUsage([]);
  constructor(readonly resumed: boolean) {}
  observe(usage: any): UsageSnapshot {
    const total = codexTotals(usage?.total);
    const last = codexTotals(usage?.last);
    if (!this.baseline)
      this.baseline = Object.fromEntries(
        fields.map((field) => [
          field,
          this.resumed
            ? total[field] !== null && last[field] !== null
              ? Math.max(0, total[field]! - last[field]!)
              : null
            : 0,
        ]),
      ) as unknown as UsageTotals;
    // A provider counter reset cannot subtract previous work from the invocation.
    if (
      this.previous?.totalTokens !== null &&
      this.previous?.totalTokens !== undefined &&
      total.totalTokens !== null &&
      total.totalTokens < this.previous.totalTokens
    ) {
      this.carry = sumUsage([this.carry, this.delta(this.previous)]);
      this.baseline = Object.fromEntries(
        fields.map((field) => [field, this.baseline![field] === null ? null : 0]),
      ) as unknown as UsageTotals;
    }
    this.previous = total;
    return {
      totals: sumUsage([this.carry, this.delta(total)]),
      source: 'codex-thread-delta',
      final: false,
    };
  }
  private delta(total: UsageTotals): UsageTotals {
    return Object.fromEntries(
      fields.map((field) => [
        field,
        total[field] === null || this.baseline?.[field] === null
          ? null
          : Math.max(0, total[field]! - (this.baseline?.[field] ?? 0)),
      ]),
    ) as unknown as UsageTotals;
  }
}
export interface UsageRecord {
  id: string;
  sessionId: string;
  runId?: string;
  workerId?: string;
  role: string;
  provider: ProviderName;
  account: string;
  model?: string;
  snapshot: UsageSnapshot;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  status?: string;
}
export function recordUsage(store: Store, record: Omit<UsageRecord, 'updatedAt'>) {
  persistUsage(store, record);
}
export function usageReport(store: Store, sessionId: string, limit: number, offset: number) {
  const records = store
    .all<{
      value: string;
    }>(
      'SELECT value FROM metadata WHERE key LIKE ? ORDER BY key LIMIT ? OFFSET ?',
      `usage:${sessionId}:%`,
      limit,
      offset,
    )
    .map((r) => JSON.parse(r.value) as UsageRecord);
  const grouped = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = JSON.stringify([record.role, record.provider, record.account]);
    const rows = grouped.get(key) ?? [];
    rows.push(record);
    grouped.set(key, rows);
  }
  return {
    scope:
      'Selected recorded invocations only; no historical backfill. Costs are provider estimates, not subscription charges. Missing fields are not zero. Native attribution is a subset, not additional usage.',
    limit,
    offset,
    records,
    groups: [...grouped.values()].map((rows) => ({
      role: rows[0]!.role,
      provider: rows[0]!.provider,
      account: rows[0]!.account,
      invocations: rows.length,
      reportedTotals: sumUsage(rows.map((r) => r.snapshot.totals)),
      missing: Object.fromEntries(
        fields.map((field) => [
          field,
          rows.filter((r) => r.snapshot.totals[field] === null).length,
        ]),
      ),
    })),
  };
}
