import type { Store } from './store.js';
import type { UsageRecord, UsageTotals } from './usage.js';
import { sumUsage } from './usage.js';
import {
  USAGE_COVERAGE,
  USAGE_PREFIX,
  timeKey,
  usageFields,
  type UsageDelta,
} from './usage-ledger.js';
import type { DecisionRecord } from './decisions/client.js';

export type UsageReader = Pick<Store, 'get' | 'all'>;
const LIMIT = 50000;
/** Keyset pages release read locks between batches and never scan the large event/history tables. */
function scan<T>(store: UsageReader, low: string, high: string, max: number) {
  const rows: T[] = [];
  let after = low;
  while (rows.length <= max) {
    const page = store.all<{ key: string; value: string }>(
      'SELECT key,value FROM metadata WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?',
      low,
      high,
      after,
      Math.min(256, max + 1 - rows.length),
    );
    rows.push(...page.map((row) => JSON.parse(row.value) as T));
    if (page.length < Math.min(256, max + 1 - (rows.length - page.length))) break;
    after = page.at(-1)!.key;
  }
  return { rows: rows.slice(0, max), truncated: rows.length > max };
}
const maintenance = new Set(['consolidator', 'memory-reviewer', 'group_reviewer']);
function category(role: string) {
  return role === 'lead'
    ? 'lead'
    : maintenance.has(role)
      ? 'maintenance'
      : role.startsWith('jev:')
        ? 'decision'
        : 'subagent';
}
interface Item {
  identity: string;
  sessionId: string;
  role: string;
  provider: string;
  account: string;
  model?: string;
  totals: UsageTotals;
  kind?: string;
  status?: string;
  unknownUsage?: boolean;
  source?: string;
}
function aggregate(items: Item[]) {
  const byInvocation = new Map<string, Item[]>();
  for (const item of items) {
    const list = byInvocation.get(item.identity) ?? [];
    list.push(item);
    byInvocation.set(item.identity, list);
  }
  const invocations = [...byInvocation.values()].map((list) => ({
    totals: sumUsage(list.map((x) => x.totals)),
    status: list.findLast((x) => x.status)?.status,
    source: list.findLast((x) => x.source)?.source ?? 'unreported',
    unknownUsage: list.some((x) => x.unknownUsage),
    started: list.some((x) => x.kind === 'start'),
  }));
  return {
    invocations: invocations.length,
    started: invocations.filter((x) => x.started).length,
    accountingSources: Object.fromEntries(
      [...new Set(invocations.map((x) => x.source))].map((source) => [
        source,
        invocations.filter((x) => x.source === source).length,
      ]),
    ),
    statuses: Object.fromEntries(
      [...new Set(invocations.map((x) => x.status ?? 'ongoing-or-unobserved'))].map((status) => [
        status,
        invocations.filter((x) => (x.status ?? 'ongoing-or-unobserved') === status).length,
      ]),
    ),
    reportedTotals: invocations.length
      ? sumUsage(invocations.map((x) => x.totals))
      : (Object.fromEntries(usageFields.map((field) => [field, 0])) as unknown as UsageTotals),
    missing: Object.fromEntries(
      usageFields.map((field) => [
        field,
        invocations.filter((x) => x.totals[field] === null).length,
      ]),
    ),
    unknownUsageInvocations: invocations.filter(
      (x) => x.unknownUsage || x.totals.totalTokens === null,
    ).length,
  };
}
function percent(a: number | null, b: number | null) {
  return a === null || b === null || b === 0 ? null : (100 * a) / b;
}
function cohort(items: Item[], roles: string[], comparisons = true) {
  const lead = aggregate(items.filter((x) => x.role === 'lead'));
  const all = aggregate(items);
  const names = [...new Set(['lead', ...maintenance, ...roles, ...items.map((x) => x.role)])];
  const rows = names.map((role) => {
    const row = aggregate(items.filter((x) => x.role === role));
    const t = row.reportedTotals;
    return {
      role,
      category: category(role),
      ...row,
      percentOfAllReportedTokens: comparisons
        ? percent(t.totalTokens, all.reportedTotals.totalTokens)
        : null,
      percentOfLead: Object.fromEntries(
        usageFields.map((field) => [
          field,
          comparisons ? percent(t[field], lead.reportedTotals[field]) : null,
        ]),
      ),
      cacheReadInputPercent: percent(
        t.cacheReadTokens,
        t.inputTokens === null && t.cacheWriteTokens === null && t.cacheReadTokens === null
          ? null
          : (t.inputTokens ?? 0) + (t.cacheWriteTokens ?? 0) + (t.cacheReadTokens ?? 0),
      ),
    };
  });
  const dimensions = new Map<string, Item[]>();
  for (const item of items) {
    const key = JSON.stringify([item.role, item.provider, item.account, item.model ?? null]);
    const list = dimensions.get(key) ?? [];
    list.push(item);
    dimensions.set(key, list);
  }
  return {
    totals: all,
    roles: rows,
    categories: ['lead', 'subagent', 'maintenance', 'decision'].map((name) => ({
      category: name,
      ...aggregate(items.filter((x) => category(x.role) === name)),
    })),
    byProviderModelAccount: [...dimensions.values()].map((list) => ({
      role: list[0]!.role,
      provider: list[0]!.provider,
      account: list[0]!.account,
      model: list[0]!.model ?? null,
      ...aggregate(list),
    })),
  };
}
export interface HookUsage {
  at: number;
  sessionId: string;
  runId?: string;
  workerId?: string;
  hook: string;
  checks: number;
  responses: number;
  blocks: number;
  errors: number;
  emittedChars: number;
  durationMs: number;
}
export const HOOK_PREFIX = 'usage-hooks:v1:';
const hooks = [
  'context-refresh',
  'research.validation',
  'research.recall',
  'research.post-tool',
  'research.session-start',
  'compaction.before',
  'compaction.after',
  'compaction.restore',
  'compaction.restore-fallback',
];
export function usageProfile(
  store: UsageReader,
  input: {
    since?: number;
    until?: number;
    sessionId?: string;
    roles?: string[];
    maxRecords?: number;
    now?: number;
  } = {},
) {
  const now = input.now ?? Date.now(),
    since = input.since ?? now - 86400000,
    until = input.until ?? now,
    max = input.maxRecords ?? LIMIT;
  if (
    !Number.isFinite(since) ||
    !Number.isFinite(until) ||
    since < 0 ||
    until <= since ||
    !Number.isInteger(max) ||
    max < 1 ||
    max > LIMIT
  )
    throw Error('Invalid usage range');
  const saved = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    USAGE_COVERAGE,
  );
  const coverage = saved ? (JSON.parse(saved.value) as { since: number }) : null;
  const selected = (row: { sessionId?: string | null }) =>
    !input.sessionId || row.sessionId === input.sessionId;
  const ledger = scan<UsageDelta>(
    store,
    timeKey(USAGE_PREFIX, since),
    timeKey(USAGE_PREFIX, until),
    max,
  );
  const items: Item[] = ledger.rows
    .filter(selected)
    .map((row) => ({ ...row, identity: JSON.stringify([row.sessionId, row.id]) }));
  // Legacy snapshots are a separate cohort; their lifetime total cannot be assigned to a day.
  const legacy =
    since < (coverage?.since ?? Infinity)
      ? scan<UsageRecord>(store, 'usage:', 'usage;', max)
      : { rows: [], truncated: false };
  const older: Item[] = legacy.rows
    .filter(
      (row) =>
        selected(row) &&
        row.startedAt === undefined &&
        row.updatedAt >= since &&
        row.updatedAt < until,
    )
    .map((row) => ({
      ...row,
      identity: JSON.stringify([row.sessionId, row.id]),
      totals: row.snapshot.totals,
      source: row.snapshot.source,
      unknownUsage: !row.snapshot.final,
    }));
  const decisions = scan<DecisionRecord>(
    store,
    timeKey('jev:call:', since),
    timeKey('jev:call:', until),
    max,
  );
  const decisionRows = decisions.rows.filter(selected);
  for (const row of decisionRows) {
    const inputTokens =
      row.reportedInputTokens === 0 && row.usageUnknownAttempts > 0
        ? null
        : row.reportedInputTokens;
    const outputTokens = row.reportedOutputTokens ?? (row.cached ? 0 : null);
    const totals: UsageTotals = {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens:
        inputTokens === null && outputTokens === null
          ? null
          : (inputTokens ?? 0) + (outputTokens ?? 0),
      estimatedCostUsd: row.estimatedUsd,
    };
    const item: Item = {
      identity: `jev:${row.id}`,
      sessionId: row.sessionId ?? row.scope,
      role: `jev:${row.feature}`,
      provider: 'jev',
      account: 'api',
      model: row.resolvedModel ?? row.requestedModel,
      totals,
      status: row.cached ? 'cached' : row.status,
      source: 'jev-reported',
      unknownUsage: row.usageUnknownAttempts > 0,
    };
    // Timestamped Jev calls are exact records, but align comparison with the ledger's coverage.
    (coverage && row.at >= coverage.since ? items : older).push(item);
  }
  const hookRecords = scan<HookUsage>(
    store,
    timeKey(HOOK_PREFIX, since),
    timeKey(HOOK_PREFIX, until),
    max,
  );
  const hookRows = hookRecords.rows.filter(selected);
  const truncated =
    ledger.truncated || legacy.truncated || decisions.truncated || hookRecords.truncated;
  return {
    version: 1,
    at: now,
    range: { since, until, scope: input.sessionId ?? 'all' },
    coverage: {
      since: coverage?.since ?? null,
      complete: !!coverage && coverage.since <= since && !truncated && until <= now,
      truncated,
      maxRecords: max,
      scanned: {
        ledger: ledger.rows.length,
        legacy: legacy.rows.length,
        decisions: decisions.rows.length,
        hooks: hookRecords.rows.length,
      },
    },
    observed: cohort(items, input.roles ?? []),
    legacySnapshots: {
      reliable: false,
      basis:
        'Historical recorded counters, not daily usage. Older Claude modelUsage may include native-session history across resumes and overcount substantially. Do not use these totals or their ratios as a reliable baseline. Separate from observed deltas.',
      ...cohort(older, input.roles ?? [], false),
    },
    decisions: [...new Set(decisionRows.map((x) => x.feature))].map((feature) => {
      const rows = decisionRows.filter((x) => x.feature === feature);
      return {
        feature,
        records: rows.length,
        attempts: rows.reduce((n, x) => n + x.attempts, 0),
        cacheHits: rows.filter((x) => x.cached).length,
        unavailable: rows.filter((x) => x.status !== 'decision').length,
        unknownUsageAttempts: rows.reduce((n, x) => n + x.usageUnknownAttempts, 0),
      };
    }),
    hooks: [...new Set([...hooks, ...hookRows.map((x) => x.hook)])].map((hook) => {
      const rows = hookRows.filter((x) => x.hook === hook);
      return {
        hook,
        directModelCalls: 0,
        directTokens: 0,
        ...(Object.fromEntries(
          ['checks', 'responses', 'blocks', 'errors', 'emittedChars', 'durationMs'].map((field) => [
            field,
            rows.reduce((n, x) => n + (x[field as keyof HookUsage] as number), 0),
          ]),
        ) as Record<
          'checks' | 'responses' | 'blocks' | 'errors' | 'emittedChars' | 'durationMs',
          number
        >),
        indirectTokens: null,
      };
    }),
    notes: [
      'Observed usage sums positive differences of cumulative provider counters once per invocation. Times are when counters were observed, not exact inference timestamps; final reconciliation can arrive later.',
      'Dispatch records include provider attempts, failures and repairs; a hard crash may leave completion unknown. A role with no observed invocations has zero reported usage. Missing counters are unknown and reported totals are lower bounds. Zero invocations means no observed calls, not missing usage reported as zero.',
      'Cache reads, cache writes and fresh input are separate. Percentages use reported tokens, not subscription quota or actual bills. Models have different costs; inspect provider/model/account rows.',
      'Only Clawstrum-owned callbacks are instrumented; external scripts/plugins are outside this hook inventory. These callback hooks are Claude SDK hooks; no observations on Codex means not applicable, not free indirect processing. Local hooks make no separate model calls. Returned text is counted in characters, with identical fields deduplicated; its later processing is included in lead/subagent usage and cannot be separately attributed in tokens. Hook batches flush every 30 seconds or on close and can be lost on hard kills.',
      'Fresh Claude queries use modelUsage totals. Resumed Claude uses per-turn main-loop usage plus observed native requests because some runtimes return lifetime modelUsage on resume. Unobserved native compaction/sidechain tokens and cost are unknown on resumed queries; totals can be lower bounds. Native requests are never added twice.',
      'Historical snapshots and new time-window deltas are separate. Jev output counters are unknown on old records; cached Jev lookups add no API tokens. Group/shared maintenance appears only in all-scope reports.',
      'Reports use bounded keyset scans of small metadata records, no model calls, no event/history scan and no long read transaction. Truncation makes totals incomplete.',
    ],
  };
}
export function usageMarkdown(report: ReturnType<typeof usageProfile>): string {
  const n = (value: number | null) =>
    value === null ? 'unknown' : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const lines = [
    '# Clawstrum usage by role',
    '',
    `Window: ${new Date(report.range.since).toISOString()} to ${new Date(report.range.until).toISOString()}. Scope: ${report.range.scope}.`,
    `Exact observation ledger began: ${report.coverage.since ? new Date(report.coverage.since).toISOString() : 'not yet enabled'}. Full-window coverage: ${report.coverage.complete}. Truncated: ${report.coverage.truncated}.`,
    '',
  ];
  for (const [label, data] of [['Observed counter increments', report.observed]] as const) {
    lines.push(
      `## ${label}`,
      '',
      '| Role | Invocations | Fresh input | Cache write | Cache read | Output | Total | % of lead tokens |',
      '|---|---:|---:|---:|---:|---:|---:|---:|',
    );
    for (const row of data.roles) {
      const t = row.reportedTotals;
      const cell = (field: keyof UsageTotals) =>
        n(t[field]) +
        (t[field] !== null && row.missing[field] ? ` (+${row.missing[field]} unknown)` : '');
      lines.push(
        `| ${row.role} | ${row.invocations} | ${cell('inputTokens')} | ${cell('cacheWriteTokens')} | ${cell('cacheReadTokens')} | ${cell('outputTokens')} | ${cell('totalTokens')} | ${n(row.percentOfLead.totalTokens as number | null)} |`,
      );
    }
    lines.push('');
  }
  lines.push(
    `${report.legacySnapshots.totals.invocations} historical snapshots retained in JSON for diagnosis; excluded from this table because resumed Claude counters may be inflated.`,
    '',
    '## Local hooks',
    '',
    '| Hook | Checks | Responses | Blocks | Returned characters | Direct model tokens |',
    '|---|---:|---:|---:|---:|---:|',
  );
  for (const row of report.hooks)
    lines.push(
      `| ${row.hook} | ${row.checks} | ${row.responses} | ${row.blocks} | ${row.emittedChars} | 0 |`,
    );
  lines.push(
    '',
    'Indirect hook token cost is included in the parent invocation and is not separately measurable.',
    '',
    ...report.notes.map((note) => `- ${note}`),
    '',
  );
  return lines.join('\n');
}
