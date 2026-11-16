import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.js';
import { saveConfig } from '../src/config.js';
import { UsageMeter, initializeUsageLedger, persistUsage } from '../src/usage-ledger.js';
import { usageProfile, usageMarkdown, HOOK_PREFIX } from '../src/usage-profile.js';
import { HookProfiler } from '../src/hook-profile.js';
import { dayWindow } from '../src/review.js';
import { sumUsage, type UsageSnapshot } from '../src/usage.js';
import type { ProviderRequest } from '../src/types.js';

const snapshot = (input: number, output = 0, cache = 0): UsageSnapshot => ({
  totals: {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cache,
    cacheWriteTokens: 0,
    totalTokens: input + output + cache,
    estimatedCostUsd: null,
  },
  source: 'test',
  final: false,
});
const identity = (sessionId: string, id: string, role = 'lead') => ({
  sessionId,
  id,
  role,
  provider: 'claude' as const,
  account: 'A',
  model: 'opus',
});

test('window ledger counts cumulative usage once, preserves nulls and apportions crossing-midnight sessions', (t) => {
  const f = fixture(t),
    start = Date.parse('2026-09-29T03:59:00Z'),
    split = Date.parse('2026-09-29T04:00:00Z');
  const meter = new UsageMeter(f.store, identity(f.session.id, 'lead:one'), start);
  meter.observe(snapshot(100, 10, 1000), start + 1000);
  meter.observe(snapshot(100, 10, 1000), start + 2000);
  meter.observe({ ...snapshot(150, 20, 1500), final: true }, split + 1000);
  meter.finish('completed', split + 2000);
  const before = usageProfile(f.store, { since: start, until: split, now: split + 3000 });
  const after = usageProfile(f.store, { since: split, until: split + 3000, now: split + 3000 });
  assert.equal(before.observed.totals.reportedTotals.totalTokens, 1110);
  assert.equal(after.observed.totals.reportedTotals.totalTokens, 560);
  assert.equal(after.observed.totals.invocations, 1);
  assert.equal(after.observed.totals.started, 0);
  assert.equal(after.observed.totals.missing.estimatedCostUsd, 1);
  assert.equal(after.observed.totals.statuses.completed, 1);
  assert.equal(after.coverage.complete, true);
  // A delayed lower counter cannot subtract or re-add work.
  persistUsage(
    f.store,
    { ...identity(f.session.id, 'lead:one'), snapshot: snapshot(120, 15, 1200) },
    split + 2500,
  );
  assert.equal(
    usageProfile(f.store, { since: split, until: split + 3000 }).observed.totals.reportedTotals
      .totalTokens,
    560,
  );
});

test('all subagent and maintenance roles compare with lead, including critic zero rows, retries and missing usage', (t) => {
  const f = fixture(t),
    now = 100000;
  for (const [id, role, n] of [
    ['l', 'lead', 100],
    ['c', 'coder', 50],
    ['m', 'memory-reviewer', 20],
    ['r', 'consolidator', 10],
    ['g', 'group_reviewer', 5],
  ] as const) {
    const meter = new UsageMeter(f.store, identity(f.session.id, id, role), now);
    meter.observe(snapshot(n), now + 1);
    meter.finish('completed', now + 2);
  }
  const failed = new UsageMeter(f.store, identity(f.session.id, 'retry', 'coder'), now + 3);
  failed.finish('failed', now + 4);
  const r = usageProfile(f.store, {
    since: now,
    until: now + 10,
    now: now + 10,
    roles: ['coder', 'critic'],
  });
  assert.equal(r.observed.totals.reportedTotals.totalTokens, 185);
  assert.equal(r.observed.roles.find((x) => x.role === 'coder')!.invocations, 2);
  assert.equal(r.observed.roles.find((x) => x.role === 'coder')!.percentOfLead.totalTokens, 50);
  assert.equal(r.observed.roles.find((x) => x.role === 'critic')!.invocations, 0);
  assert.equal(r.observed.roles.find((x) => x.role === 'critic')!.reportedTotals.totalTokens, 0);
  assert.equal(r.observed.totals.unknownUsageInvocations, 1);
  assert.equal(
    r.observed.categories.find((x) => x.category === 'maintenance')!.reportedTotals.totalTokens,
    35,
  );
  assert.match(usageMarkdown(r), /\| critic \| 0 \|/);
});

test('historical snapshots stay separate, channel scopes exclude shared/group usage, and truncation is visible', (t) => {
  const f = fixture(t),
    now = 100000;
  f.store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    `usage:${f.session.id}:old`,
    JSON.stringify({
      ...identity(f.session.id, 'old'),
      updatedAt: now - 10,
      snapshot: snapshot(9999),
    }),
  );
  initializeUsageLedger(f.store, now);
  for (const [sessionId, id] of [
    [f.session.id, 'channel'],
    ['shared', 'global'],
    ['group:science', 'group'],
  ]) {
    const meter = new UsageMeter(f.store, identity(sessionId!, id!, 'memory-reviewer'), now);
    meter.observe(snapshot(20), now + 1);
    meter.finish('completed', now + 2);
  }
  const scoped = usageProfile(f.store, {
    since: now - 100,
    until: now + 10,
    now: now + 10,
    sessionId: f.session.id,
  });
  assert.equal(scoped.observed.totals.reportedTotals.totalTokens, 20);
  assert.equal(scoped.legacySnapshots.totals.reportedTotals.totalTokens, 9999);
  assert.equal(scoped.coverage.complete, false);
  const all = usageProfile(f.store, { since: now, until: now + 10, now: now + 10 });
  assert.equal(all.observed.totals.reportedTotals.totalTokens, 60);
  assert.equal(
    usageProfile(f.store, { since: now, until: now + 10, maxRecords: 1 }).coverage.truncated,
    true,
  );
});

test('Jev cached lookups add zero tokens, unknown attempts stay disclosed and output counters are used', (t) => {
  const f = fixture(t),
    now = 100000;
  initializeUsageLedger(f.store, now);
  for (const [i, cached, input, output, unknown] of [
    [1, false, 10, 2, 0],
    [2, true, 0, 0, 0],
    [3, false, 0, undefined, 1],
  ] as const) {
    f.store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?)',
      `jev:call:${String(now + i).padStart(16, '0')}:${i}`,
      JSON.stringify({
        id: String(i),
        at: now + i,
        sessionId: f.session.id,
        feature: 'skill-advice',
        requestedModel: 'jev-test',
        cached,
        reportedInputTokens: input,
        reportedOutputTokens: output,
        usageUnknownAttempts: unknown,
        estimatedUsd: 0,
        attempts: cached ? 0 : 1,
        status: unknown ? 'unavailable' : 'decision',
      }),
    );
  }
  const r = usageProfile(f.store, { since: now, until: now + 10, now: now + 10 });
  const j = r.observed.roles.find((x) => x.role === 'jev:skill-advice')!;
  assert.equal(j.reportedTotals.totalTokens, 12);
  assert.equal(j.invocations, 3);
  assert.equal(j.unknownUsageInvocations, 1);
  assert.equal(j.missing.outputTokens, 1);
  assert.equal(r.decisions[0]!.cacheHits, 1);
  assert.equal(r.decisions[0]!.attempts, 2);
});

test('hook profiling preserves results, batches writes, does not count repeated fields twice, and records errors', async (t) => {
  const f = fixture(t),
    events: unknown[] = [];
  const request = {
    mcp: { env: { CLAWSTRUM_SESSION: f.session.id, CLAWSTRUM_RUN: 'r' } },
    onEvent: (x: unknown) => events.push(x),
  } as ProviderRequest;
  const profiler = new HookProfiler(f.store, request);
  const value = {
    systemMessage: 'abc',
    hookSpecificOutput: { hookEventName: 'PreToolUse' as const, additionalContext: 'abc' },
  };
  const wrapped = profiler.wrap('research.validation', async () => value);
  assert.equal(await wrapped({} as any, undefined, {} as any), value);
  assert.equal(f.store.all("SELECT key FROM metadata WHERE key GLOB 'usage-hooks:*'").length, 0);
  await assert.rejects(
    profiler.wrap('research.validation', async () => {
      throw Error('original');
    })({} as any, undefined, {} as any),
    /original/,
  );
  profiler.record('research.validation', {
    hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'fix' },
  });
  profiler.close();
  profiler.close();
  const r = usageProfile(f.store, { since: 0, until: Date.now() + 1 });
  const h = r.hooks.find((x) => x.hook === 'research.validation')!;
  assert.equal(h.checks, 3);
  assert.equal(h.responses, 2);
  assert.equal(h.emittedChars, 6);
  assert.equal(h.blocks, 1);
  assert.equal(h.errors, 1);
  assert.equal(h.directTokens, 0);
  assert.equal(h.indirectTokens, null);
  assert.deepEqual(events, []);
});

test('metadata report queries use the primary-key range, and do not read events or hold transactions', (t) => {
  const f = fixture(t),
    sqls: string[] = [];
  const reader = {
    get<T>(sql: string, ...args: any[]) {
      sqls.push(sql);
      return f.store.get<T>(sql, ...args);
    },
    all<T>(sql: string, ...args: any[]) {
      sqls.push(sql);
      return f.store.all<T>(sql, ...args);
    },
  };
  usageProfile(reader, { since: 0, until: Date.now() });
  assert(sqls.every((sql) => !sql.includes('FROM events') && !sql.includes('BEGIN')));
  const plan = f.store.all<{ detail: string }>(
    'EXPLAIN QUERY PLAN SELECT key,value FROM metadata WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?',
    HOOK_PREFIX,
    HOOK_PREFIX + '~',
    HOOK_PREFIX,
    256,
  );
  assert(plan.some((x) => /SEARCH metadata USING INDEX/.test(x.detail)));
});

test('calendar-day reports honor DST and CLI is read-only and emits markdown without provider calls', (t) => {
  const spring = dayWindow('2026-03-08', 'America/New_York'),
    fall = dayWindow('2026-11-01', 'America/New_York');
  assert.equal(spring.end - spring.start, 23 * 3600000);
  assert.equal(fall.end - fall.start, 25 * 3600000);
  const f = fixture(t);
  saveConfig(f.home, f.config);
  const file = path.join(f.home, 'clawstrum.db');
  const before = fs.statSync(file).mtimeMs;
  const run = spawnSync(
    process.execPath,
    [
      'dist/cli.js',
      'usage',
      'profile',
      '--day',
      'yesterday',
      '--timezone',
      'America/New_York',
      '--format',
      'markdown',
    ],
    { encoding: 'utf8', env: { ...process.env, CLAWSTRUM_HOME: f.home }, timeout: 20000 },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Clawstrum usage by role/);
  assert.match(run.stdout, /checker/);
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.throws(() => usageProfile(f.store, { since: NaN, until: 1 }), /Invalid/);
});

test('usage with no reported fields remains unknown rather than a zero-cost invocation', (t) => {
  const f = fixture(t);
  const meter = new UsageMeter(f.store, identity(f.session.id, 'missing'), 100);
  meter.observe({ totals: sumUsage([]), source: 'missing', final: true }, 101);
  meter.finish('completed', 102);
  const r = usageProfile(f.store, { since: 100, until: 103, now: 103 });
  assert.equal(r.observed.totals.reportedTotals.totalTokens, null);
  assert.equal(r.observed.totals.missing.totalTokens, 1);
});

test('maintenance dispatch records every role and failed attempt, independently of provider usage callbacks', async (t) => {
  const { Engine } = await import('../src/engine.js');
  const f = fixture(t);
  f.config.runtime.maintenance.minIntervalMs = 0;
  let fail = false;
  const adapter = {
    async run(r: ProviderRequest) {
      if (fail) throw Error('synthetic failure');
      r.onEvent({ type: 'usage', usage: snapshot(30), detail: {} });
      return 'ok';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: adapter, codex: adapter });
  const request = {
    account: f.config.accounts[0]!,
    prompt: '',
    instructions: '',
    cwd: f.home,
    controller: new AbortController(),
    env: {},
    mcp: { command: '', args: [], env: {} },
    onEvent: () => {},
  };
  for (const role of ['consolidator', 'memory-reviewer', 'group_reviewer'])
    await (engine as any).runMaintenance(
      { ...request, usageScope: role === 'group_reviewer' ? 'group:test' : f.session.id },
      role,
    );
  fail = true;
  await assert.rejects(
    (engine as any).runMaintenance({ ...request, usageScope: f.session.id }, 'consolidator'),
    /synthetic/,
  );
  const report = usageProfile(f.store, { since: 0, until: Date.now() + 1 });
  assert.equal(
    report.observed.categories.find((x) => x.category === 'maintenance')!.invocations,
    4,
  );
  assert.equal(report.observed.totals.reportedTotals.totalTokens, 90);
  assert.equal(
    report.observed.roles.find((x) => x.role === 'consolidator')!.unknownUsageInvocations,
    1,
  );
  assert.equal(engine.maintenance.size, 0);
  await engine.stop();
});

test('a failed hook telemetry write cannot deny a tool or replace its result', async (t) => {
  const f = fixture(t),
    diagnostics: unknown[] = [];
  const profiler = new HookProfiler(f.store, {
    mcp: { env: { CLAWSTRUM_SESSION: f.session.id } },
    onEvent: (event: unknown) => {
      diagnostics.push(event);
      throw Error('diagnostic sink unavailable');
    },
  } as ProviderRequest);
  const original = f.store.exec.bind(f.store);
  f.store.exec = ((...args: Parameters<typeof original>) => {
    if (String(args[1]).startsWith(HOOK_PREFIX)) throw Error('telemetry unavailable');
    return original(...args);
  }) as typeof f.store.exec;
  const result = { systemMessage: 'keep working' };
  assert.equal(
    await profiler.wrap('research.validation', async () => result)({} as any, undefined, {} as any),
    result,
  );
  assert.doesNotThrow(() => profiler.close());
  assert.equal(diagnostics.length, 1);
  f.store.exec = original;
});

test('corrected ledger excludes earlier inflated observations and discloses accounting sources', (t) => {
  const f = fixture(t),
    now = 100000;
  f.store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    'usage-ledger:coverage:v1',
    JSON.stringify({ since: now - 1000, version: 1 }),
  );
  f.store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    `usage-ledger:v1:${String(now + 1).padStart(16, '0')}:old`,
    JSON.stringify({
      ...identity(f.session.id, 'old'),
      kind: 'delta',
      at: now + 1,
      totals: snapshot(27000000).totals,
    }),
  );
  const meter = new UsageMeter(f.store, identity(f.session.id, 'current'), now);
  meter.observe({ ...snapshot(100), source: 'claude-resumed-turn-usage' }, now + 1);
  meter.finish('completed', now + 2);
  const report = usageProfile(f.store, { since: now, until: now + 3, now: now + 3 });
  assert.equal(report.coverage.since, now);
  assert.equal(report.observed.totals.reportedTotals.totalTokens, 100);
  assert.equal(report.observed.totals.accountingSources['claude-resumed-turn-usage'], 1);
  assert.equal(report.legacySnapshots.reliable, false);
  assert.equal(report.legacySnapshots.roles[0]!.percentOfLead.totalTokens, null);
  assert(f.store.get('SELECT value FROM metadata WHERE key=?', 'usage-ledger:coverage:v1'));
});
