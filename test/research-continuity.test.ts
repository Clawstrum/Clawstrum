import test from 'node:test';
import { compactionHooks } from '../src/compaction.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, settle } from './helpers.js';
import { Engine } from '../src/engine.js';
import { AccountPool } from '../src/accounts.js';
import { ClaudeUsage, CodexUsage, codexTurnUsage, recordUsage, usageReport } from '../src/usage.js';
import { claudeEvent, createClaudeProvider } from '../src/providers.js';
import type { Provider, ProviderRequest } from '../src/types.js';
import { ResearchHttp } from '../src/research/http.js';
import { verifyCitation, citationRecord } from '../src/research/literature.js';
import { researchSchema } from '../src/research/config.js';
import { researchHooks } from '../src/research/hooks.js';
import { classifyJobFailures, parseAccounting } from '../src/research/cluster.js';
import { delegate, ResearchWorkers } from '../src/research/workers.js';
import { steerWorker, workerSteers, updateWorkerSteer } from '../src/research/steering.js';
import { researchTool } from '../src/research/tools.js';
import { saveNote, noteRevisions, researchState } from '../src/research/records.js';

function enabled(t: any) {
  const f = fixture(t);
  f.config.research = researchSchema.parse({
    enabled: true,
    validation: 'off',
    workers: { minFreeMemoryMB: 0 },
  });
  return f;
}
const assistant = (id: string, input = 10, output = 2, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  subagent_type: parent ? 'explorer' : undefined,
  message: {
    id,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3,
    },
  },
});
const result = (input = 50, output = 10) => ({
  type: 'result',
  total_cost_usd: 0.4,
  modelUsage: {
    model: {
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 30,
      costUSD: 0.4,
    },
  },
});

test('Claude usage deduplicates blocks and reconciles cumulative results without adding native usage twice', () => {
  const u = new ClaudeUsage();
  u.observe(assistant('a'));
  u.observe(assistant('a', 10, 5));
  const split = u.observe(assistant('b', 10, 2, 'tool-agent'))!;
  assert.equal(split.totals.outputTokens, 7);
  assert.deepEqual(
    split.attribution?.map((r) => r.role),
    ['main', 'native-subagent:explorer'],
  );
  const final = u.observe(result())!;
  assert.equal(final.totals.totalTokens, 290);
  assert.equal(u.observe(result())!.totals.totalTokens, 290);
  const next = u.observe(assistant('c'))!;
  assert.equal(next.totals.totalTokens, 325); // 290 + a new request's 10+2+20+3
  assert.equal(u.observe(result(60, 12))!.totals.totalTokens, 325);
  assert.equal(final.totals.estimatedCostUsd, 0.4);
});

test('resumed Claude charges current-turn usage rather than restored native-session totals', () => {
  const u = new ClaudeUsage(true);
  u.observe({
    type: 'assistant',
    message: {
      id: 'current',
      usage: {
        input_tokens: 6,
        output_tokens: 54,
        cache_read_input_tokens: 570422,
        cache_creation_input_tokens: 272326,
      },
    },
  });
  const end = {
    type: 'result',
    uuid: 'end-current',
    total_cost_usd: 42.0879618,
    usage: {
      input_tokens: 6,
      output_tokens: 496,
      cache_read_input_tokens: 570422,
      cache_creation_input_tokens: 272326,
    },
    modelUsage: {
      old: {
        inputTokens: 27262,
        outputTokens: 51201,
        cacheReadInputTokens: 22577099,
        cacheCreationInputTokens: 4565090,
        costUSD: 42.0879618,
      },
    },
  };
  const current = u.observe(end)!;
  assert.equal(current.totals.totalTokens, 843250);
  assert.equal(current.totals.outputTokens, 496);
  assert.equal(current.totals.estimatedCostUsd, null);
  assert.equal(current.source, 'claude-resumed-turn-usage');
  assert.equal(u.observe(end)!.totals.totalTokens, 843250);
});

test('resumed Claude sums distinct streaming turns and observed native children exactly once', () => {
  const u = new ClaudeUsage(true);
  u.observe(assistant('a')); // 35 initially, 38 after final output reconciliation
  u.observe(assistant('child', 20, 5, 'task')); // 48, excluded from result.usage
  const first = { ...result(10000), uuid: 'r1', usage: assistant('a', 10, 5).message.usage };
  assert.equal(u.observe(first)!.totals.totalTokens, 86);
  assert.equal(u.observe(first)!.totals.totalTokens, 86);
  assert.equal(u.observe(assistant('b'))!.totals.totalTokens, 121);
  // A duplicate prior result must not consume the new turn's in-flight observations.
  assert.equal(u.observe(first)!.totals.totalTokens, 121);
  const second = { ...result(20000), uuid: 'r2', usage: assistant('b', 10, 8).message.usage };
  assert.equal(u.observe(second)!.totals.totalTokens, 127);
  assert.equal(u.observe(assistant('child', 20, 9, 'task'))!.totals.totalTokens, 131);
  assert.equal(u.observe(second)!.totals.totalTokens, 131);
});

test('resumed Claude retains observed work when per-turn counters are missing or zeroed', () => {
  const u = new ClaudeUsage(true);
  u.observe(assistant('a'));
  assert.equal(u.observe({ ...result(1000000), uuid: 'missing' })!.totals.totalTokens, 35);
  u.observe(assistant('b'));
  assert.equal(
    u.observe({ ...result(1000000), uuid: 'second', usage: assistant('b', 10, 5).message.usage })!
      .totals.totalTokens,
    73,
  );
  u.observe(assistant('c'));
  assert.equal(
    u.observe({
      ...result(1000000),
      uuid: 'zero',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    })!.totals.totalTokens,
    108,
  );
  assert.equal(new ClaudeUsage(true).observe(result(1000000))!.totals.totalTokens, null);
});

test('explicit note reconciliation preserves history, excludes obsolete guidance and rejects stale/foreign revisions', (t) => {
  const f = enabled(t);
  const a = saveNote(f.store, f.session.id, 'a', {
    kind: 'decision',
    title: 'old',
    body: 'OBSOLETE_CHOICE',
  });
  const b = saveNote(f.store, f.session.id, 'b', {
    kind: 'finding',
    title: 'duplicate',
    body: 'duplicate',
  });
  const replacement = {
    kind: 'decision' as const,
    title: 'current',
    body: 'REVISED_CHOICE',
    supersedes: [a.id, b.id],
  };
  const c = saveNote(f.store, f.session.id, 'c', replacement);
  assert.equal(saveNote(f.store, f.session.id, 'c', replacement).id, c.id);
  assert.equal(noteRevisions(f.store, f.session.id, a.id).supersededBy, c.id);
  const state = researchState(f.store, f.session.id);
  assert.match(state, /REVISED_CHOICE/);
  assert.doesNotMatch(state, /OBSOLETE_CHOICE/);
  assert.doesNotMatch(fs.readFileSync(c.file, 'utf8'), /OBSOLETE_CHOICE/);
  assert.match(
    f.store.get<any>('SELECT content FROM history_records WHERE id=?', `note:${a.id}`).content,
    /OBSOLETE_CHOICE/,
  );
  assert.throws(
    () => saveNote(f.store, f.session.id, 'd', { ...replacement, supersedes: [a.id] }),
    /already superseded/,
  );
  assert.throws(
    () => saveNote(f.store, f.session.id, 'c', { ...replacement, supersedes: [] }),
    /different content/,
  );
  assert.throws(
    () =>
      saveNote(f.store, f.store.ensureSession('123123').id, 'x', {
        ...replacement,
        supersedes: [c.id],
      }),
    /this conversation/,
  );
  assert.equal(f.store.all('SELECT id FROM research_notes').length, 3);
});

test('Codex usage excludes cached input from uncached input and subtracts earlier native turns', () => {
  const u = new CodexUsage(true);
  const first = {
    total: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 30 },
    last: { inputTokens: 20, cachedInputTokens: 10, outputTokens: 5 },
  };
  const a = u.observe(first);
  assert.equal(a.totals.inputTokens, 10);
  assert.equal(a.totals.totalTokens, 25);
  assert.equal(u.observe(first).totals.totalTokens, 25);
  const b = u.observe({ total: { inputTokens: 130, cachedInputTokens: 70, outputTokens: 40 } });
  assert.equal(b.totals.totalTokens, 65);
  assert.equal(b.totals.estimatedCostUsd, null);
  assert.equal(b.totals.cacheWriteTokens, null);
  assert.equal(
    u.observe({ total: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 } }).totals
      .totalTokens,
    77,
  );
  assert.equal(
    codexTurnUsage({ input_tokens: 50, cached_input_tokens: 20, output_tokens: 10 }).totals
      .totalTokens,
    60,
  );
});

test('resumed Codex usage without a last-request baseline stays unknown instead of charging old work', () => {
  const u = new CodexUsage(true);
  assert.equal(
    u.observe({ total: { inputTokens: 100, outputTokens: 20 } }).totals.totalTokens,
    null,
  );
  assert.equal(
    u.observe({ total: { inputTokens: 200, outputTokens: 40 } }).totals.totalTokens,
    null,
  );
  assert.equal(u.observe({ total: { inputTokens: 10, outputTokens: 2 } }).totals.totalTokens, null);
});

test('usage snapshots are durably replaced and paginated within the owning conversation', (t) => {
  const f = enabled(t);
  const snapshot = new ClaudeUsage().observe(result())!;
  const record = {
    id: 'worker:w',
    sessionId: f.session.id,
    role: 'analyst',
    provider: 'claude' as const,
    account: 'a',
    snapshot,
  };
  recordUsage(f.store, record);
  recordUsage(f.store, record);
  recordUsage(f.store, { ...record, sessionId: f.store.ensureSession('123123').id });
  const report = usageReport(f.store, f.session.id, 10, 0);
  assert.equal(report.records.length, 1);
  assert.equal(report.groups[0]!.reportedTotals.estimatedCostUsd, 0.4);
  assert.equal(usageReport(f.store, f.session.id, 1, 1).records.length, 0);
});

test('DataCite fallback validates identity and retains evidence for dataset and software citations', async (t) => {
  const f = enabled(t);
  const seen: string[] = [];
  const doi = '10.1234/dataset';
  const metadata = {
    data: {
      id: doi,
      attributes: {
        doi,
        titles: [{ title: 'A dataset' }],
        creators: [{ name: 'Scientific Consortium' }, { givenName: 'Jane', familyName: 'Doe' }],
        publicationYear: 2025,
        publisher: { name: 'Repository' },
        relatedIdentifiers: [{ relationType: 'IsNewVersionOf', relatedIdentifier: '10.1234/old' }],
      },
    },
  };
  const http = new ResearchHttp(f.config.research, (async (url: any) => {
    seen.push(new URL(url).hostname);
    return new URL(url).hostname === 'api.crossref.org'
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify(metadata));
  }) as typeof fetch);
  const record = await verifyCitation(f.store, f.config.research, doi, http);
  assert.deepEqual(seen, ['api.crossref.org', 'api.datacite.org']);
  assert.deepEqual(record.authors, ['Scientific Consortium', 'Jane Doe']);
  assert.equal(record.venue, 'Repository');
  assert.equal(record.year, 2025);
  assert.equal(record.correctionLinks.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(record.responsePath, 'utf8')), metadata);
  metadata.data.id = '10.1234/other';
  await assert.rejects(verifyCitation(f.store, f.config.research, doi, http), /different DOI/);
  assert.equal(citationRecord(f.store, doi)!.responseHash, record.responseHash);
});

test('DOI lookup does not mask throttling with an unrelated resolver', async (t) => {
  const f = enabled(t);
  let calls = 0;
  const http = new ResearchHttp(f.config.research, (async () => {
    calls++;
    return new Response('', { status: 429 });
  }) as typeof fetch);
  await assert.rejects(verifyCitation(f.store, f.config.research, '10.1234/a', http), /HTTP 429/);
  assert.equal(calls, 1);
});

test('scheduler classifications preserve evidence and do not infer OOM from exit 137', () => {
  const rows = parseAccounting(
    '1|OUT_OF_MEMORY|0:9|00:01:00|1G\n1.batch|FAILED|137:0|00:01:00|1G\n2|PREEMPTED|0:0||\n3|COMPLETED|0:0||',
  );
  const findings = classifyJobFailures(rows);
  assert.deepEqual(
    findings.map((f) => f.kind),
    ['out-of-memory', 'application-or-unknown', 'preempted'],
  );
  assert.equal(findings[1]!.exit, '137:0');
  assert.match(findings[2]!.advice, /requeued/);
  assert.equal(
    classifyJobFailures(parseAccounting('4|COMPLETED||00:01|'))[0]?.kind,
    'unconfirmed-exit',
  );
});

for (const absolute of [false, true])
  test(`quiet tools suspend only the silence timeout (absolute=${absolute})`, async (t) => {
    const f = fixture(t);
    f.config.runtime.silenceTimeoutMs = 20;
    f.config.runtime.turnTimeoutMs = absolute ? 100 : 0;
    let request!: ProviderRequest;
    let start!: () => void;
    const started = new Promise<void>((r) => {
      start = r;
    });
    const p: Provider = {
      async run(r) {
        request = r;
        r.onEvent({ type: 'ready' });
        r.onEvent({ type: 'activity', detail: {}, tool: { id: 'tool', state: 'started' } });
        start();
        await new Promise<void>((resolve) =>
          r.controller.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return 'partial';
      },
    };
    const engine = new Engine(f.config, f.store, { claude: p, codex: p });
    f.enqueue('quiet-tool');
    engine.tick();
    await started;
    const state = [...engine.active.values()][0]!;
    // Isolate the tool-wait phase from variable filesystem/provider setup time on CI.
    state.turnStarted = state.lastActivity;
    engine.tick(state.lastActivity + 30);
    assert.equal(request.controller.signal.aborted, false);
    if (absolute) engine.tick(state.turnStarted + 101);
    else {
      request.onEvent({ type: 'activity', detail: {}, tool: { id: 'tool', state: 'completed' } });
      engine.tick(state.lastActivity + 30);
    }
    assert.equal(request.controller.signal.aborted, true);
    await settle(engine);
  });

test('Claude tool lifecycle matches tool results to invocation IDs', () => {
  assert.deepEqual(
    claudeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'one' }] } })[0]!
      .tool,
    { id: 'one', state: 'started' },
  );
  assert.deepEqual(
    claudeEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'one' }] },
    })[0]!.tool,
    { id: 'one', state: 'completed' },
  );
});

test('Claude compaction status keeps an active provider alive but silence remains bounded', async (t) => {
  const f = enabled(t);
  f.config.runtime.silenceTimeoutMs = 20;
  f.config.runtime.turnTimeoutMs = 0;
  let request!: ProviderRequest;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const provider: Provider = {
    async run(r) {
      request = r;
      r.onEvent({ type: 'ready' });
      start();
      await new Promise<void>((resolve) =>
        r.controller.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return 'partial';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  f.enqueue('compact');
  engine.tick();
  await started;
  const state = [...engine.active.values()][0]!;
  const heartbeatAt = Date.now();
  state.lastActivity = heartbeatAt - 100;
  for (const event of claudeEvent({ type: 'system', subtype: 'status', status: 'compacting' }))
    request.onEvent(event);
  engine.tick(heartbeatAt + 10);
  assert.equal(request.controller.signal.aborted, false);
  engine.tick(state.lastActivity + 21);
  assert.equal(request.controller.signal.aborted, true);
  await settle(engine);
});

function hookFixture(t: any) {
  const f = enabled(t);
  const transcript = path.join(f.home, 'native.jsonl');
  fs.writeFileSync(transcript, 'original evidence');
  const request: ProviderRequest = {
    account: f.config.accounts[0]!,
    prompt: 'task',
    instructions: '',
    cwd: f.session.workspace,
    research: f.config.research,
    controller: new AbortController(),
    env: {},
    mcp: {
      command: process.execPath,
      args: [],
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id },
    },
    onEvent() {},
  };
  const hooks = compactionHooks(request);
  t.after(() => hooks.close());
  const invoke = (event: string, extra = {}) =>
    (hooks.hooks as any)[event][0].hooks[0](
      {
        session_id: 'native',
        cwd: f.session.workspace,
        transcript_path: transcript,
        hook_event_name: event,
        ...extra,
      },
      undefined,
      { signal: request.controller.signal },
    );
  return { ...f, invoke };
}

test('confirmed compaction restores once before a tool even with validation off, but no-op compaction does not', async (t) => {
  const f = hookFixture(t);
  const tool = { tool_name: 'Read', tool_input: {}, tool_use_id: 'r' };
  await f.invoke('PreCompact', { trigger: 'manual' });
  assert.deepEqual(await f.invoke('PreToolUse', tool), {});
  await f.invoke('PostCompact', { trigger: 'manual', compact_summary: 'summary' });
  const restored = await f.invoke('PreToolUse', tool);
  assert.match(restored.hookSpecificOutput.additionalContext, /Current work/);
  assert.deepEqual(await f.invoke('PreToolUse', tool), {});
  await f.invoke('PreCompact', { trigger: 'auto' });
  await f.invoke('SessionStart', { source: 'compact' });
  await f.invoke('PostCompact', { trigger: 'auto', compact_summary: 'summary' });
  // SessionStart ran first and the summary goes to MEMORY, so nothing more arrives before a tool.
  assert.deepEqual(await f.invoke('PreToolUse', tool), {});
  await f.invoke('PreCompact', { trigger: 'auto', agent_id: 'child' });
  await f.invoke('PostCompact', { trigger: 'auto', agent_id: 'child', compact_summary: 'summary' });
  assert.deepEqual(await f.invoke('PreToolUse', tool), {});
  assert.ok(
    (await f.invoke('PreToolUse', { ...tool, agent_id: 'child' })).hookSpecificOutput
      .additionalContext,
  );
});

function manager(f: ReturnType<typeof enabled>, provider: Provider) {
  return new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 60000),
    { claude: provider, codex: provider },
    () => 0,
  );
}

test('worker steering is ordered, deduplicated, acknowledged and visible to the lead', async (t) => {
  const f = enabled(t);
  let release!: () => void;
  const delivered: string[] = [];
  const p: Provider = {
    async run(r) {
      assert.equal(r.liveInput, true);
      assert.equal(r.subagent, true);
      r.onEvent({ type: 'ready' });
      r.attachInjector?.((ids, message) => {
        delivered.push(message);
        r.onEvent({ type: 'injected', detail: { ids, ok: true } });
        return true;
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'done';
    },
  };
  const row = delegate(f.store, f.session.id, f.config, 'w', { role: 'analyst', brief: 'analyze' });
  const first = steerWorker(f.store, f.session.id, row.id, 'first', 'new constraint');
  await researchTool(
    'research_steer',
    { id: row.id, key: 'k'.repeat(200), message: 'then verify' },
    { store: f.store, config: f.config, sessionId: f.session.id, scope: 'test-input' },
  );
  const m = manager(f, p);
  m.tick();
  m.tick();
  m.tick();
  assert.deepEqual(delivered, ['new constraint', 'then verify']);
  assert.equal(steerWorker(f.store, f.session.id, row.id, 'first', 'new constraint').id, first.id);
  assert.equal(workerSteers(f.store, row.id)[0]!.status, 'accepted');
  assert.throws(
    () => steerWorker(f.store, f.session.id, row.id, 'first', 'different'),
    /another instruction/,
  );
  release();
  await m.active.get(row.id)!.promise;
  assert.equal(
    steerWorker(f.store, f.session.id, row.id, 'first', 'new constraint').status,
    'accepted',
  );
  assert.throws(() => steerWorker(f.store, f.session.id, row.id, 'third', 'late'), /ended/);
});

test('lost worker acknowledgments remain unknown across restart and foreign cancellation cannot alter them', async (t) => {
  const f = enabled(t);
  let release!: () => void;
  const p: Provider = {
    async run(r) {
      r.onEvent({ type: 'ready' });
      r.attachInjector?.(() => true);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'done';
    },
  };
  const row = delegate(f.store, f.session.id, f.config, 'w', { role: 'analyst', brief: 'analyze' });
  steerWorker(f.store, f.session.id, row.id, 'first', 'correct');
  const m = manager(f, p);
  m.tick();
  m.tick();
  const other = f.store.ensureSession('123123');
  await researchTool(
    'research_status',
    { collection: 'workers', id: row.id, cancelWorker: true },
    { store: f.store, config: f.config, sessionId: other.id, scope: 'other' },
  );
  assert.equal(workerSteers(f.store, row.id)[0]!.status, 'sending');
  release();
  await m.active.get(row.id)!.promise;
  assert.equal(workerSteers(f.store, row.id)[0]!.status, 'unknown');
  assert.equal(updateWorkerSteer(f.store, workerSteers(f.store, row.id)[0]!, 'accepted'), false);
  m.recover();
  assert.equal(workerSteers(f.store, row.id)[0]!.status, 'unknown');
});

test('worker token limits retain usage and partial evidence before stopping execution', async (t) => {
  const f = enabled(t);
  f.config.research.workers.roles.analyst!.maxTokens = 30;
  const p: Provider = {
    async run(r) {
      r.onEvent({
        type: 'usage',
        detail: {},
        usage: new ClaudeUsage().observe(assistant('budget'))!,
      });
      assert.equal(r.controller.signal.aborted, true);
      return 'untrusted final';
    },
  };
  const row = delegate(f.store, f.session.id, f.config, 'budget', {
    role: 'analyst',
    brief: 'analyze',
  });
  const m = manager(f, p);
  m.tick();
  await m.active.get(row.id)!.promise;
  const saved = f.store.get<any>('SELECT * FROM delegations WHERE id=?', row.id)!;
  assert.equal(saved.status, 'failed');
  assert.match(saved.error, /token budget/);
  assert.ok(saved.usage_json);
  assert.match(fs.readFileSync(saved.result_path, 'utf8'), /Partial tool work/);
  assert.equal(
    usageReport(f.store, f.session.id, 10, 0).records[0]!.snapshot.totals.totalTokens,
    35,
  );
});

test('explicit worker continuation points to prior artifacts and preserves the ended record', async (t) => {
  const f = enabled(t);
  let prompt = '';
  const prior = delegate(f.store, f.session.id, f.config, 'old', {
    role: 'analyst',
    brief: 'original',
  });
  f.store.exec(
    "UPDATE delegations SET status='failed',summary='saved intermediate output' WHERE id=?",
    prior.id,
  );
  const next = delegate(f.store, f.session.id, f.config, 'new', {
    role: 'analyst',
    brief: 'continue',
    resumeFrom: prior.id,
  });
  assert.equal(
    delegate(f.store, f.session.id, f.config, 'new', {
      role: 'analyst',
      brief: 'continue',
      resumeFrom: prior.id,
    }).id,
    next.id,
  );
  const m = manager(f, {
    async run(r) {
      prompt = r.prompt;
      return 'continued';
    },
  });
  m.tick();
  await m.active.get(next.id)!.promise;
  assert.match(prompt, new RegExp(prior.id));
  assert.match(prompt, /do not replay them blindly/);
  assert.equal(
    f.store.get<any>('SELECT status FROM delegations WHERE id=?', prior.id)!.status,
    'failed',
  );
  const other = f.store.ensureSession('123123');
  assert.throws(
    () =>
      delegate(f.store, other.id, f.config, 'foreign', {
        role: 'analyst',
        brief: 'continue',
        resumeFrom: prior.id,
      }),
    /this conversation/,
  );
});

test('Claude native cost ceiling is forwarded, while an unsupported Codex cost cap prevents execution', async (t) => {
  const f = enabled(t);
  let options: any;
  const provider = createClaudeProvider(((args: any) => {
    options = args.options;
    const stream: any = {
      async *[Symbol.asyncIterator]() {
        await args.prompt[Symbol.asyncIterator]().next();
        yield { type: 'result', subtype: 'success', result: 'done', is_error: false };
      },
      close() {},
    };
    return stream;
  }) as any);
  await provider.run({
    account: f.config.accounts[0]!,
    prompt: 'test',
    instructions: '',
    cwd: f.session.workspace,
    controller: new AbortController(),
    env: {},
    mcp: { command: process.execPath, args: [], env: {} },
    onEvent() {},
    maxBudgetUsd: 0.25,
  });
  assert.equal(options.maxBudgetUsd, 0.25);
  f.config.research.workers.account = 'b';
  f.config.research.workers.roles.analyst!.maxBudgetUsd = 0.25;
  const row = delegate(f.store, f.session.id, f.config, 'cost', {
    role: 'analyst',
    brief: 'analyze',
  });
  let calls = 0;
  const m = manager(f, {
    async run() {
      calls++;
      return 'unexpected';
    },
  });
  m.tick();
  await m.active.get(row.id)!.promise;
  assert.equal(calls, 0);
  assert.match(
    f.store.get<any>('SELECT error FROM delegations WHERE id=?', row.id)!.error,
    /requires Claude/,
  );
});
