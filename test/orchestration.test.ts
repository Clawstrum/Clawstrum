import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { AccountPool } from '../src/accounts.js';
import { delegate, ResearchWorkers, writeScopesOverlap } from '../src/research/workers.js';
import { researchTool, registerResearchTools } from '../src/research/tools.js';
import { workerReport, workerProfile } from '../src/research/worker-profile.js';
import { recordUsage, sumUsage } from '../src/usage.js';
import { readInstructionSnapshot, ContextRefresh } from '../src/instructions.js';
import { updateMemory } from '../src/memory.js';
import { compactionHooks } from '../src/compaction.js';
import { createClaudeProvider } from '../src/providers.js';
import { codexOrchestrationConfig, nativeClaudeDelegationTools } from '../src/orchestration.js';
import { buildContext } from '../src/context.js';
import type { Provider, ProviderRequest } from '../src/types.js';

function context(f: ReturnType<typeof fixture>, workerId?: string) {
  return {
    store: f.store,
    config: f.config,
    sessionId: f.session.id,
    scope: 'test',
    worker: !!workerId,
    workerId,
  };
}
function manager(f: ReturnType<typeof fixture>, provider: Provider) {
  return new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
  );
}

test('an explicit worker provider and model replace role defaults on both backends', async (t) => {
  const f = fixture(t);
  const requests: ProviderRequest[] = [];
  const m = manager(f, {
    async run(r) {
      requests.push(r);
      return 'Verified synthetic result.';
    },
  });
  try {
    for (const [provider, model] of [
      ['claude', 'claude-fable-5'],
      ['codex', 'gpt-6-astra'],
    ] as const) {
      const row = delegate(f.store, f.session.id, f.config, provider, {
        role: 'analyst',
        brief: 'Bounded brainstorm',
        provider,
        model,
        effort: 'high',
      });
      m.tick();
      await Promise.all([...m.active.values()].map((r) => r.promise));
      const r = requests.at(-1)!;
      assert.equal(r.account.provider, provider);
      assert.equal(r.account.model, model);
      assert.equal(r.account.effort, 'high');
      assert.match(r.instructions, /Agent role: bounded subagent/);
      assert.ok(r.instructions.includes(`Requested model: ${model}`));
      assert.match(r.instructions, /has no Bedrock or standalone shell-login fallback/);
      assert.deepEqual(r.account.modelFallbacks ?? [], []);
      assert.equal(
        f.store.get<any>('SELECT status FROM delegations WHERE id=?', row.id).status,
        'completed',
      );
      assert.throws(
        () =>
          delegate(f.store, f.session.id, f.config, provider, {
            role: 'analyst',
            brief: 'Bounded brainstorm',
            provider,
            model: 'different',
          }),
        /another task/,
      );
    }
    assert.throws(
      () =>
        delegate(f.store, f.session.id, f.config, 'ambiguous', {
          role: 'analyst',
          brief: 'Bounded',
          model: 'fable',
        }),
      /needs provider/,
    );
  } finally {
    await m.stop();
  }
});

test('lead instructions describe the actual subscription route and enabled worker interface without secrets', (t) => {
  const f = fixture(t);
  for (const account of f.config.accounts) {
    const context = buildContext(f.store, f.session, account, [], 4000, 100000, f.config.research);
    assert.ok(context.instructions.includes(`Configured subscription account: ${account.id}`));
    assert.ok(context.instructions.includes(`Provider: ${account.provider}`));
    assert.match(context.instructions, /Role models are defaults, not an allowed-model list/);
    assert.match(context.instructions, /Native provider delegation: disabled/);
    const disabled = buildContext(f.store, f.session, account, [], 4000, 100000, {
      ...f.config.research,
      enabled: false,
    });
    assert.match(disabled.instructions, /Managed subagent tools are unavailable/);
    assert.match(disabled.instructions, /Native provider delegation: not disabled/);
  }
});

test('an unavailable explicitly requested provider queues without silently downgrading or switching provider', async (t) => {
  const f = fixture(t);
  const pool = new AccountPool(f.config.accounts, f.store, 100);
  pool.quota(f.config.accounts[0]!, {
    rejected: true,
    bucket: 'five_hour',
    resetsAt: Date.now() + 100000,
  });
  let calls = 0;
  const provider = {
    async run() {
      calls++;
      return 'done';
    },
  };
  const m = new ResearchWorkers(
    f.store,
    f.config,
    pool,
    { claude: provider, codex: provider },
    () => 0,
  );
  const row = delegate(f.store, f.session.id, f.config, 'fable', {
    role: 'analyst',
    brief: 'Brainstorm',
    provider: 'claude',
    model: 'claude-fable-5',
  });
  try {
    m.tick();
    assert.equal(calls, 0);
    assert.equal(
      f.store.get<any>('SELECT status FROM delegations WHERE id=?', row.id).status,
      'queued',
    );
    assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
    const wakes = f.store.all<{ id: string; content: string }>('SELECT * FROM inbound');
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]!.id, /^research:/);
    assert.match(wakes[0]!.content, /claude-fable-5/);
  } finally {
    await m.stop();
  }
});

test('worker progress, reports and review receipts survive manager completion, enforce ownership and preserve history', async (t) => {
  const f = fixture(t);
  const row = delegate(f.store, f.session.id, f.config, 'one', {
    role: 'explorer',
    brief: 'Read an artifact',
    context: 'Latest user correction',
    deliverables: ['Cite the evidence'],
  });
  let release!: () => void;
  const m = manager(f, {
    async run(r) {
      assert.match(r.prompt, /Latest user correction/);
      r.onEvent({ type: 'activity', tool: { id: 'tool1', state: 'started' } });
      r.onEvent({ type: 'activity', tool: { id: 'tool1', state: 'completed' } });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'Finding backed by artifact.csv; checked 2 records.';
    },
  });
  m.tick();
  assert.equal(workerProfile(f.store, row.id)!.toolCalls, 1);
  const update = { state: 'blocked', summary: 'Which input version?' };
  await researchTool('research_worker_update', update, context(f, row.id));
  await researchTool('research_worker_update', update, context(f, row.id));
  assert.equal(
    f.store.all("SELECT * FROM inbound WHERE kind='task'").length,
    1,
    'Identical blocked updates wake once',
  );
  await assert.rejects(
    researchTool('research_worker_update', update, context(f)),
    /current subagent/,
  );
  const other = f.store.ensureSession('112233');
  await assert.rejects(
    researchTool('research_worker_update', update, { ...context(f, row.id), sessionId: other.id }),
    /running subagent/,
  );
  await assert.rejects(
    researchTool(
      'research_worker_review',
      { id: row.id, outcome: 'accepted', note: 'checked' },
      context(f),
    ),
    /ended subagent/,
  );
  await researchTool(
    'research_worker_update',
    {
      state: 'report',
      summary: 'Found 2 records',
      evidence: ['artifact.csv'],
      verification: ['Counted rows'],
      uncertainties: ['Other versions not checked'],
    },
    context(f, row.id),
  );
  release();
  await Promise.all([...m.active.values()].map((s) => s.promise));
  const ended = f.store.get<any>('SELECT * FROM delegations WHERE id=?', row.id)!;
  const report = JSON.parse(
    fs.readFileSync(path.join(path.dirname(ended.result_path), 'REPORT.json'), 'utf8'),
  );
  assert.deepEqual(report.workerReport.verification, ['Counted rows']);
  await assert.rejects(
    researchTool('research_worker_update', update, context(f, row.id)),
    /running subagent/,
  );
  await researchTool(
    'research_worker_review',
    { id: row.id, outcome: 'accepted', note: 'Read artifact.csv and recounted rows' },
    context(f),
  );
  assert.equal(workerReport(f.store).groups[0]!.reviews.accepted, 1);
  assert.equal(f.store.all("SELECT * FROM events WHERE type='research_worker_progress'").length, 2);
  assert.equal(
    f.store.all('SELECT * FROM outbox').length,
    0,
    'No worker progress is delivered to Discord',
  );
  await m.stop();
});

test('overlapping declared writes queue across channels and worker routing uses role entitlements', async (t) => {
  const f = fixture(t);
  f.config.accounts = [
    { ...f.config.accounts[0]!, model: 'opus', quotaBuckets: ['seven_day_opus'] },
  ];
  const pool = new AccountPool(f.config.accounts, f.store, 100);
  pool.quota(f.config.accounts[0]!, {
    rejected: true,
    bucket: 'seven_day_opus',
    resetsAt: Date.now() + 100000,
  });
  assert.equal(pool.choose(null, null), undefined);
  let release!: () => void;
  let invoked = 0;
  const provider: Provider = {
    async run(r) {
      invoked++;
      assert.equal(r.account.model, 'haiku');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'done';
    },
  };
  const m = new ResearchWorkers(
    f.store,
    f.config,
    pool,
    { claude: provider, codex: provider },
    () => 0,
  );
  const p = path.join(f.home, 'shared');
  const a = delegate(f.store, f.session.id, f.config, 'a', {
    role: 'explorer',
    brief: 'Edit',
    writePaths: [p],
  });
  const other = f.store.ensureSession('112233');
  const b = delegate(f.store, other.id, f.config, 'b', {
    role: 'explorer',
    brief: 'Edit',
    writePaths: [path.join(p, 'data.txt')],
  });
  m.tick();
  assert.equal(invoked, 1);
  assert.equal(
    f.store.get<any>('SELECT status FROM delegations WHERE id=?', b.id)!.status,
    'queued',
  );
  release();
  await Promise.all([...m.active.values()].map((s) => s.promise));
  m.tick();
  assert.equal(invoked, 2);
  release();
  await Promise.all([...m.active.values()].map((s) => s.promise));
  assert.equal(
    f.store.get<any>('SELECT status FROM delegations WHERE id=?', a.id)!.status,
    'completed',
  );
  fs.mkdirSync(p);
  fs.symlinkSync(p, path.join(f.home, 'alias'));
  assert.equal(writeScopesOverlap([path.join(f.home, 'alias')], [path.join(p, 'new.txt')]), true);
  assert.equal(writeScopesOverlap([p], [p + '-other']), false);
  const cycle = path.join(f.home, 'cycle');
  fs.symlinkSync(cycle, cycle);
  assert.equal(
    writeScopesOverlap([cycle], [p]),
    true,
    'Unresolvable paths serialize without crashing',
  );
  await m.stop();
});

test('worker context excludes accumulated memory at start, refresh and native compaction', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'AGENTS.md'), 'SHARED_POLICY\n');
  updateMemory(f.store, f.session.id, { 'Current work': 'IRRELEVANT_LARGE_MEMORY' });
  let captured!: ProviderRequest;
  const m = manager(f, {
    async run(r) {
      captured = r;
      return 'done';
    },
  });
  delegate(f.store, f.session.id, f.config, 'memory', { role: 'analyst', brief: 'Bounded work' });
  m.tick();
  await Promise.all([...m.active.values()].map((s) => s.promise));
  assert.match(captured.instructions, /SHARED_POLICY/);
  assert.doesNotMatch(captured.prompt + captured.instructions, /IRRELEVANT_LARGE_MEMORY/);
  assert.match(captured.prompt, /Memory reference:/);
  const refresh = new ContextRefresh(captured);
  updateMemory(f.store, f.session.id, { 'Current work': 'NEW_MEMORY_ONLY' });
  assert.doesNotMatch(refresh.text(refresh.read()!), /NEW_MEMORY_ONLY/);
  const hook = compactionHooks(captured);
  try {
    const cb = hook.hooks!.SessionStart![0]!.hooks[0]!;
    const result = await cb(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'native',
        transcript_path: '',
        cwd: captured.cwd,
      },
      null,
      { signal: new AbortController().signal },
    );
    assert.doesNotMatch(JSON.stringify(result), /NEW_MEMORY_ONLY/);
    assert.match(JSON.stringify(result), /Memory reference:/);
  } finally {
    hook.close();
  }
  assert.match(
    readInstructionSnapshot({ ...captured.contextRefresh!.sources, memoryMode: 'full' }).memory,
    /NEW_MEMORY_ONLY/,
  );
  await m.stop();
});

test('profiling counts cumulative snapshots once, includes distinct parents and exposes unknown counters', (t) => {
  const f = fixture(t);
  const a = delegate(
    f.store,
    f.session.id,
    f.config,
    'a',
    { role: 'explorer', brief: 'A' },
    'parent',
  );
  delegate(f.store, f.session.id, f.config, 'b', { role: 'explorer', brief: 'B' }, 'parent');
  const snap = (input: number) => ({
    source: 'test',
    final: true,
    totals: { ...sumUsage([]), inputTokens: input, cacheReadTokens: 80 },
  });
  const base = {
    sessionId: f.session.id,
    runId: 'parent',
    provider: 'claude' as const,
    account: 'a',
  };
  recordUsage(f.store, {
    ...base,
    id: `worker:${a.id}`,
    workerId: a.id,
    role: 'explorer',
    snapshot: snap(10),
  });
  recordUsage(f.store, {
    ...base,
    id: `worker:${a.id}`,
    workerId: a.id,
    role: 'explorer',
    snapshot: snap(25),
  });
  recordUsage(f.store, { ...base, id: 'lead:parent:0', role: 'lead', snapshot: snap(50) });
  const report = workerReport(f.store);
  assert.equal(report.totals.reportedTotals.inputTokens, 25);
  assert.equal(report.totals.missing.inputTokens, 1);
  assert.equal(report.totals.reportedTotals.estimatedCostUsd, null);
  assert.equal(report.parentLead.reportedTotals.inputTokens, 50);
  assert.equal(report.parentLead.invocations, 1);
  assert.equal(workerReport(f.store, { limit: 1 }).truncated, true);
  assert.equal(workerReport(f.store, { since: Date.now() + 1000 }).total, 0);
  assert.throws(() => workerReport(f.store, { since: NaN }), /Invalid/);
});

test('native delegation is removed from Claude requests without changing full host access or advisory validation', async (t) => {
  const f = fixture(t);
  let options: any;
  const query = ((p: any) => {
    options = p.options;
    return Object.assign(
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'test' };
        yield { type: 'result', subtype: 'success', result: 'done', usage: {} };
      })(),
      { close() {} },
    );
  }) as any;
  const r: ProviderRequest = {
    account: f.config.accounts[0]!,
    research: f.config.research,
    cwd: f.home,
    prompt: 'test',
    instructions: 'test',
    controller: new AbortController(),
    env: {},
    mcp: { command: 'node', args: [], env: {} },
    onEvent() {},
  };
  await createClaudeProvider(query).run(r);
  assert.deepEqual(options.disallowedTools, nativeClaudeDelegationTools);
  assert.equal(options.permissionMode, 'bypassPermissions');
  assert.equal(options.sandbox.enabled, false);
  assert.equal(options.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS, '1');
  assert.equal(codexOrchestrationConfig(r)['agents.enabled'], false);
  f.config.research.workers.enforceRoles = 'off';
  assert.deepEqual(codexOrchestrationConfig(r), {});
  r.mcp.env.CLAWSTRUM_DELEGATION = 'worker';
  assert.equal(codexOrchestrationConfig(r)['agents.enabled'], false);
  assert.equal(codexOrchestrationConfig(r).project_doc_max_bytes, 0);
  const leadNames: string[] = [],
    workerNames: string[] = [];
  registerResearchTools(((name: string) => leadNames.push(name)) as any, context(f));
  registerResearchTools(((name: string) => workerNames.push(name)) as any, context(f, 'worker'));
  assert.ok(leadNames.includes('research_worker_review'));
  assert.ok(!leadNames.includes('research_worker_update'));
  assert.ok(workerNames.includes('research_worker_update'));
  assert.ok(!workerNames.includes('research_worker_review'));
  assert.ok(!workerNames.includes('research_delegate'));
});

test('profile CLI is read-only and reports the same durable worker cohort', async (t) => {
  const f = fixture(t);
  delegate(f.store, f.session.id, f.config, 'cli', { role: 'explorer', brief: 'fixture' });
  const before = f.store.all('SELECT * FROM metadata ORDER BY key');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    ['dist/cli.js', 'workers', 'profile', f.session.id, '--limit', '1'],
    { env: { ...process.env, CLAWSTRUM_HOME: f.home }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.total, 1);
  assert.equal(report.workers[0].status, 'queued');
  assert.equal('config_json' in report.workers[0], false);
  assert.deepEqual(f.store.all('SELECT * FROM metadata ORDER BY key'), before);
});
test('clawstrum subagents profile is the advertised CLI name, and workers is an accepted alias for it', async (t) => {
  const f = fixture(t);
  delegate(f.store, f.session.id, f.config, 'cli', { role: 'explorer', brief: 'fixture' });
  const { spawnSync } = await import('node:child_process');
  const run = (command: string) =>
    spawnSync(process.execPath, ['dist/cli.js', command, 'profile', f.session.id, '--limit', '1'], {
      env: { ...process.env, CLAWSTRUM_HOME: f.home },
      encoding: 'utf8',
    });
  const subagents = run('subagents');
  assert.equal(subagents.status, 0, subagents.stderr);
  const workers = run('workers');
  assert.equal(workers.status, 0, workers.stderr);
  // queueMs is elapsed time since creation, so it drifts between the two separate CLI calls;
  // every other field is stable and should match exactly between the two command names.
  const strip = (text: string) => JSON.parse(text.replace(/"queueMs":\s*\d+/g, '"queueMs":0'));
  assert.deepEqual(strip(subagents.stdout), strip(workers.stdout));
});
