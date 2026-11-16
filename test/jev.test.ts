import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { Engine } from '../src/engine.js';
import { reviewCoverage } from '../src/memory-review.js';
import { decisionsSchema } from '../src/decisions/config.js';
import {
  DecisionService,
  validateDecision,
  decisionEnvironment,
  type DecisionInput,
} from '../src/decisions/client.js';
import { decisionProfile } from '../src/decisions/profile.js';
import { indexHistory, rankedHistory } from '../src/decisions/history.js';
import { skillAdvice, workerAdvice } from '../src/decisions/advice.js';
import { archiveRecord, historyPage, supersedeHistory } from '../src/history.js';
import { Store } from '../src/store.js';
import { readSkills, buildContext } from '../src/context.js';
import { ensureMemory, observeMemory } from '../src/memory.js';
import { researchTool } from '../src/research/tools.js';

const model = 'jev-1.13.0';
const env = { JEV_API_KEY: 'private-test-key' };
test('MCP receives only the configured Jev key, including alias and no-key fallbacks', () => {
  const config = decisionsSchema.parse({});
  assert.deepEqual(
    decisionEnvironment(config, { TYPESAFE_API_KEY: 'alias-key', UNRELATED_SECRET: 'unrelated' }),
    { JEV_API_KEY: 'alias-key' },
  );
  assert.deepEqual(decisionEnvironment(config, {}), {});
  assert.deepEqual(decisionEnvironment({ ...config, enabled: false }, env), {});
  assert.deepEqual(
    decisionEnvironment({ ...config, apiKeyEnv: 'CUSTOM_JEV' }, { CUSTOM_JEV: 'custom', ...env }),
    { CUSTOM_JEV: 'custom' },
  );
});
const input: DecisionInput = {
  feature: 'test',
  version: '1',
  scope: 'channel:one',
  state: { text: 'input' },
  questions: {
    result: { type: 'choice', instructions: 'Which?', criteria: { yes: 'Yes', no: 'No' } },
  },
};
function answer(choice = 'yes') {
  return {
    type: 'choice',
    choice,
    confidence: 1,
    probabilities: { yes: choice === 'yes' ? 1 : 0, no: choice === 'no' ? 1 : 0 },
  };
}
function response(answers: any = { result: answer() }) {
  return new Response(
    JSON.stringify({ model, answers, usage: { input_tokens: 100, output_tokens: 12 } }),
    { headers: { 'content-type': 'application/json' } },
  );
}
function service(f: ReturnType<typeof fixture>, transport: typeof fetch, overrides: any = {}) {
  return new DecisionService(f.store, decisionsSchema.parse(overrides), transport, env);
}

test('Jev is optional: no key, disabled feature and exhausted budget never call the network', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return response();
  };
  assert.deepEqual(
    await new DecisionService(f.store, f.config.decisions, transport, {}).decide(input),
    { status: 'unavailable', reason: 'missing_key' },
  );
  assert.equal(
    (await service(f, transport, { enabled: false }).decide(input)).status,
    'unavailable',
  );
  const budget = await service(f, transport, { dailyBudgetUsd: 0 }).decide(input);
  assert.equal(budget.status, 'unavailable');
  assert.equal(budget.status === 'unavailable' && budget.reason, 'budget');
  assert.equal(calls, 0);
});

test('strict validation rejects missing answers, wrong labels, model drift and nonfinite probabilities', () => {
  for (const raw of [
    { model, answers: {} },
    { model, answers: { result: answer('unknown') } },
    { model: 'jev-latest', answers: { result: answer() } },
    { model, answers: { result: { ...answer(), confidence: NaN } } },
    { model, answers: { result: { ...answer(), probabilities: { yes: 0.1, no: 0.1 } } } },
  ]) {
    assert.throws(() => validateDecision(raw, model, input.questions));
  }
  assert.equal(
    validateDecision({ model, answers: { n: { type: 'noul', noul: 0.7 } } }, model, {
      n: { type: 'noul', instructions: 'True?' },
    }).answers.n?.type,
    'noul',
  );
  const score = { s: { type: 'score' as const, instructions: 'Rate', criteria: ['low', 'high'] } };
  assert.equal(
    validateDecision(
      {
        model,
        answers: {
          s: { type: 'score', score: 0.4, confidence: 0.3, probabilities: { '0': 0.6, '1': 0.4 } },
        },
      },
      model,
      score,
    ).answers.s?.type,
    'score',
  );
});

test('cache survives service restart, scopes/revisions invalidate it, secrets never enter artifacts', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const transport: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer private-test-key');
    return response();
  };
  const first = await service(f, transport).decide(input);
  assert.equal(first.status, 'decision');
  const next = await service(f, transport).decide(input);
  assert.ok(next.status === 'decision' && next.cached);
  await service(f, transport).decide({ ...input, scope: 'another' });
  await service(f, transport).decide({
    ...input,
    sources: [{ id: 'source', revision: 'changed' }],
  });
  assert.equal(calls, 3);
  const profile = decisionProfile(f.store);
  assert.equal(profile.records.length, 4);
  assert.equal(profile.features.test!.cacheHits, 1);
  assert.equal(profile.features.test!.reportedInputTokens, 300);
  for (const row of profile.records) {
    assert.doesNotMatch(JSON.stringify(row), /private-test-key/);
    if (row.artifact)
      assert.doesNotMatch(fs.readFileSync(row.artifact, 'utf8'), /private-test-key/);
  }
});

test('independent store connections coalesce identical in-flight calls without double billing', async (t) => {
  const f = fixture(t),
    other = new Store(f.home);
  t.after(() => other.close());
  let release!: () => void;
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    await new Promise<void>((r) => {
      release = r;
    });
    return response();
  };
  const a = service(f, transport).decide(input);
  await new Promise((r) => setTimeout(r, 5));
  const b = new DecisionService(other, f.config.decisions, transport, env).decide(input);
  release();
  const results = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r.status === 'decision'));
  assert.equal(decisionProfile(f.store).features.test!.reportedInputTokens, 100);
});

test('timeout releases capacity even when transport ignores cancellation; later calls recover', async (t) => {
  const f = fixture(t);
  const svc = service(f, async () => new Promise(() => {}), { foregroundTimeoutMs: 50 });
  const before = Date.now();
  const result = await svc.decide(input);
  assert.equal(result.status === 'unavailable' && result.reason, 'timeout');
  assert.ok(Date.now() - before < 1000);
  assert.equal(
    f.store.all("SELECT key FROM metadata WHERE key LIKE 'jev:lease:%' OR key LIKE 'jev:flight:%'")
      .length,
    0,
  );
  assert.equal((await service(f, async () => response()).decide(input)).status, 'decision');
});

test('cancellation by a cache waiter does not cancel the call it is waiting for', async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const svc = service(f, async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return response();
  });
  const leader = svc.decide(input);
  await new Promise((r) => setTimeout(r, 5));
  const c = new AbortController();
  const follower = svc.decide({ ...input, signal: c.signal });
  c.abort();
  const cancelled = await follower;
  assert.equal(cancelled.status === 'unavailable' && cancelled.reason, 'cancelled');
  release();
  assert.equal((await leader).status, 'decision');
});

test('rate-limit retries honor Retry-After and request deadline, auth never retries', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const result = await service(f, async () =>
    ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : response(),
  ).decide(input);
  assert.equal(result.status, 'decision');
  assert.equal(calls, 2);
  assert.equal(decisionProfile(f.store).features.test!.usageUnknownAttempts, 1);
  calls = 0;
  const auth = await service(f, async () => {
    calls++;
    return new Response('secret echoed: private-test-key', { status: 401 });
  }).decide({ ...input, version: '2' });
  assert.equal(auth.status === 'unavailable' && auth.reason, 'http_401');
  assert.equal(calls, 1);
  const blocked = await service(
    f,
    async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
  ).decide({ ...input, version: '3' });
  assert.equal(blocked.status === 'unavailable' && blocked.reason, 'http_429_deadline');
  for (const r of decisionProfile(f.store).records)
    if (r.artifact) assert.doesNotMatch(fs.readFileSync(r.artifact, 'utf8'), /private-test-key/);
});

test('oversized state is explicitly unavailable rather than silently truncated', async (t) => {
  const f = fixture(t);
  let called = false;
  const result = await service(f, async () => {
    called = true;
    return response();
  }).decide({ ...input, state: 'x'.repeat(30000) });
  assert.equal(result.status === 'unavailable' && result.reason, 'request_too_large');
  assert.equal(called, false);
});

test('daily budget reservations serialize across processes and missing usage stays unknown', async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const svc = service(
    f,
    async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return new Response(JSON.stringify({ model, answers: { result: answer() } }));
    },
    { maxConcurrent: 1 },
  );
  const first = svc.decide(input);
  await new Promise((r) => setTimeout(r, 5));
  const second = await svc.decide({ ...input, state: 'different' });
  assert.equal(second.status === 'unavailable' && second.reason, 'capacity');
  release();
  await first;
  const page = decisionProfile(f.store, { limit: 1 });
  assert.equal(page.nextOffset, 1);
  const all = decisionProfile(f.store);
  assert.equal(all.features.test!.usageUnknownAttempts, 1);
  assert.ok(all.features.test!.estimatedUsd > 0);
});

test('local ranked history works without Jev, isolates channel/shared/group scopes and preserves replacements', async (t) => {
  const f = fixture(t),
    other = f.store.ensureSession('112233');
  archiveRecord(f.store, {
    id: 'old',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Experiment A old clustering method was connected components.',
  });
  archiveRecord(f.store, {
    id: 'new',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Current decision: use Louvain in experiment A.',
  });
  archiveRecord(f.store, {
    id: 'private-other',
    sessionId: other.id,
    kind: 'user',
    content: 'Experiment A clustering secret from another channel.',
  });
  archiveRecord(f.store, {
    id: 'shared',
    sessionId: null,
    kind: 'user',
    content: 'Experiment A clustering shared guidance.',
  });
  supersedeHistory(f.store, 'old', 'new');
  const noKey = new DecisionService(
    f.store,
    f.config.decisions,
    async () => {
      throw new Error('must not call');
    },
    {},
  );
  const result = await rankedHistory(f.store, f.session.id, { query: 'clustering method' }, noKey);
  assert.ok(result.records.some((r) => r.id === 'old'));
  assert.ok(result.replacements.some((r) => r.id === 'new'));
  assert.ok(result.records.every((r) => r.id !== 'shared' && r.id !== 'private-other'));
  assert.equal(result.decision.status, 'unavailable');
  assert.equal(
    (historyPage(f.store, f.session.id, { action: 'read', id: 'old' }) as any).content,
    'Experiment A old clustering method was connected components.',
  );
  const shared = await rankedHistory(f.store, null, { query: 'clustering' }, noKey);
  assert.deepEqual(
    shared.records.map((r) => r.id),
    ['shared'],
  );
});

test('FTS incremental backfill includes old records and new writes without duplicate or lost rows', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++)
    archiveRecord(f.store, {
      id: `row${i}`,
      sessionId: f.session.id,
      kind: 'user',
      content: `Uniquephrase entry ${i}`,
    });
  let state = indexHistory(f.store, 2);
  assert.equal(state.complete, false);
  archiveRecord(f.store, {
    id: 'newrow',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Uniquephrase new',
  });
  // Deleting a not-yet-indexed source must not corrupt FTS.
  f.store.exec("DELETE FROM history_records WHERE id='row0'");
  while (!(state = indexHistory(f.store, 2)).complete) {}
  const rows = f.store.all<any>(
    "SELECT rowid FROM jev_history_fts WHERE jev_history_fts MATCH 'uniquephrase'",
  );
  assert.equal(rows.length, 6);
  f.store.exec("UPDATE history_records SET content='Revisedphrase' WHERE id='newrow'");
  assert.equal(
    f.store.all("SELECT rowid FROM jev_history_fts WHERE jev_history_fts MATCH 'revisedphrase'")
      .length,
    1,
  );
});

test('reranking reorders a shortlist but never deletes raw evidence or a correction', async (t) => {
  const f = fixture(t);
  for (const [id, text] of [
    ['older', 'Experiment A cluster method previously old.'],
    ['current', 'Experiment A cluster method now new.'],
  ])
    archiveRecord(f.store, { id: id!, sessionId: f.session.id, kind: 'user', content: text! });
  supersedeHistory(f.store, 'older', 'current');
  const svc = service(f, async (_, req) => {
    const body = JSON.parse(req!.body as string);
    return response(
      Object.fromEntries(
        body.state.candidates.map((r: any, i: number) => [
          `candidate_${i}`,
          { type: 'noul', noul: r.id === 'current' ? 0.99 : 0.1 },
        ]),
      ),
    );
  });
  const result = await rankedHistory(
    f.store,
    f.session.id,
    { query: 'cluster method', limit: 1 },
    svc,
  );
  assert.equal(result.decision.status, 'decision');
  assert.equal(result.records[0]!.id, 'current');
  assert.ok(f.store.get("SELECT id FROM history_records WHERE id='older'"));
});

test('worker advice is optional and cannot spawn or override an explicit model request', async (t) => {
  const f = fixture(t);
  const svc = service(f, async (_, req) => {
    const q = JSON.parse(req!.body as string).questions.role;
    const probabilities = Object.fromEntries(
      Object.keys(q.criteria).map((k) => [k, k === 'lead' ? 1 : 0]),
    );
    return response({ role: { type: 'choice', choice: 'lead', confidence: 0.4, probabilities } });
  });
  const result = await workerAdvice(
    svc,
    f.config,
    { brief: 'Explain the design only', provider: 'claude', model: 'claude-fable-5' },
    { scope: 'test' },
  );
  assert.ok('suggestedRole' in result && result.suggestedRole === 'lead');
  assert.equal(f.store.all('SELECT id FROM delegations').length, 0);
});

test('skill advice changes per-turn prompt only; missing Jev preserves lexical hints on both providers', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const dir = path.join(f.home, 'skills', 'stats');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\ndescription: Analyze statistics\ntriggers: statistics\nnot_for: Chat about a result\nexamples: run a t-test | check the p-values\n---\nUse data.',
  );
  const skills = readSkills([path.dirname(dir)]);
  const bodies: any[] = [];
  const reply = (choice: string) => async (_: unknown, request?: RequestInit) => {
    bodies.push(JSON.parse(request!.body as string));
    return response({
      skill: {
        type: 'choice',
        choice,
        confidence: 0.8,
        probabilities: { none: choice === 'none' ? 0.9 : 0.1, s0: choice === 's0' ? 0.9 : 0.1 },
      },
    });
  };
  const hint = await skillAdvice(service(f, reply('s0')), skills, 'statistics', {
    scope: 'test',
  });
  assert.equal(hint.decided, true);
  assert.match(hint.text, /Skill `stats` was loaded for this turn/);
  assert.match(hint.text, /Use data\./);
  assert.ok(hint.text.includes(`Base directory for this skill: ${dir}`));
  assert.doesNotMatch(hint.text, /confidence|description:/);
  assert.deepEqual(bodies[0].questions.skill.criteria.s0, {
    skill: 'stats',
    what: 'Analyze statistics',
    not_for: 'Chat about a result',
    examples: ['run a t-test', 'check the p-values'],
  });
  assert.ok(bodies[0].questions.skill.criteria.none.what);
  assert.deepEqual(bodies[0].state, { task: 'statistics' });
  const noneHint = await skillAdvice(
    service(f, reply('none')),
    skills,
    'thanks',
    { scope: 'test' },
    ['first', 'second', 'x'.repeat(900)],
  );
  assert.deepEqual(noneHint, { decided: true, text: '' });
  assert.deepEqual(bodies[1].state, {
    task: 'thanks',
    previous_agent_messages: ['second', 'x'.repeat(800)],
  });
  const absent = await skillAdvice(
    new DecisionService(f.store, f.config.decisions, fetch, {}),
    skills,
    'statistics',
    { scope: 'test' },
  );
  assert.deepEqual(absent, { decided: false, text: '' });
  f.store.enqueue({
    id: 'question',
    sessionId: f.session.id,
    author: 'user',
    content: 'statistics',
  });
  const messages = f.store.claim(f.session.id)!.messages;
  for (const account of f.config.accounts) {
    const base = buildContext(f.store, f.session, account, messages, 2000);
    const advised = buildContext(
      f.store,
      f.session,
      account,
      messages,
      2000,
      100000,
      undefined,
      undefined,
      false,
      hint,
    );
    const declined = buildContext(
      f.store,
      f.session,
      account,
      messages,
      2000,
      100000,
      undefined,
      undefined,
      false,
      noneHint,
    );
    const fallback = buildContext(
      f.store,
      f.session,
      account,
      messages,
      2000,
      100000,
      undefined,
      undefined,
      false,
      absent,
    );
    assert.equal(base.instructions, advised.instructions);
    assert.equal(base.fingerprint, advised.fingerprint);
    assert.match(advised.prompt, /loaded for this turn by the skill router/);
    assert.match(base.prompt, /matched statistics/);
    assert.match(fallback.prompt, /matched statistics/);
    assert.match(fallback.prompt, /Skill `stats` was loaded for this turn by keyword match/);
    assert.match(fallback.prompt, /Use data\./);
    assert.doesNotMatch(fallback.prompt, /not_for:/);
    assert.doesNotMatch(advised.prompt, /by keyword match/);
    assert.doesNotMatch(declined.prompt, /by keyword match|Use data\./);
    // Once Jev has decided, its pick (or none) replaces the keyword match.
    assert.doesNotMatch(advised.prompt, /matched statistics/);
    assert.doesNotMatch(declined.prompt, /matched statistics/);
  }
});

test('on the context-overflow retry a keyword-matched skill is only a pointer, so the current input survives', (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const dir = path.join(f.home, 'skills', 'big');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\ndescription: Big\ntriggers: statistics\n---\n' + 'Rule line.\n'.repeat(1100),
  );
  f.store.enqueue({
    id: 'q',
    sessionId: f.session.id,
    author: 'user',
    content: 'statistics for the capacity sweep, CURRENT-INPUT-MARKER',
  });
  // A deployment's skill inventory leaves the 16k retry budget little room for a loaded body.
  for (let i = 0; i < 40; i++) {
    const d = path.join(f.home, 'skills', `s${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, 'SKILL.md'),
      `---\nname: s${i}\ndescription: ${'A long skill description. '.repeat(7)}\n---\nBody.`,
    );
  }
  const messages = f.store.claim(f.session.id)!.messages;
  const retry = buildContext(
    f.store,
    f.session,
    f.config.accounts[0]!,
    messages,
    2000,
    16000,
    undefined,
    undefined,
    false,
    { decided: false, text: '' },
    undefined,
    '',
    false,
  );
  assert.match(retry.prompt, /CURRENT-INPUT-MARKER/);
  assert.match(retry.prompt, /- big \(matched statistics\): read /);
  assert.doesNotMatch(retry.prompt, /Rule line\./);
});

test('memory review makes no auxiliary observer calls even with a legacy enabled Jev setting', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  f.config.runtime.memoryReview.debounceMs = 0;
  f.config.decisions.memoryReview = true;
  f.config.decisions.apiKeyEnv = 'CLAWSTRUM_TEST_JEV_KEY';
  const old = process.env.CLAWSTRUM_TEST_JEV_KEY;
  process.env.CLAWSTRUM_TEST_JEV_KEY = 'test-only';
  t.after(() => {
    if (old === undefined) delete process.env.CLAWSTRUM_TEST_JEV_KEY;
    else process.env.CLAWSTRUM_TEST_JEV_KEY = old;
  });
  let decisions = 0,
    calls = 0;
  t.mock.method(DecisionService.prototype, 'decide', async () => {
    decisions++;
    return { status: 'unavailable', reason: 'test' };
  });
  archiveRecord(f.store, {
    id: 'correction',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Use new setup for experiment B only.',
    counted: true,
  });
  const provider = {
    async run(r: any) {
      calls++;
      const p = JSON.parse(r.prompt);
      return JSON.stringify({
        chunk: p.chunk,
        sections: {
          'Working understanding': 'Use new setup for B only',
          'Current work': '',
          'Research state': '',
        },
        sources: p.sourceParts.map((s: any) => s.ref),
      });
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  try {
    engine.tick();
    await Promise.all([...engine.consolidations]);
    assert.equal(calls, 1);
    assert.equal(decisions, 0);
    assert.ok(reviewCoverage(f.store, f.session.id) > 0);
    assert.equal(decisionProfile(f.store).records.length, 0);
  } finally {
    await engine.stop();
  }
});

test('skill advice keeps a large catalog complete without duplicating descriptions or sending local paths', async (t) => {
  const f = fixture(t);
  const root = path.join(f.home, 'long/private/installation/'.repeat(20));
  fs.mkdirSync(path.join(root, 'skill49'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skill49', 'SKILL.md'), '---\nname: skill49\n---\nBody 49.');
  const skills = Array.from({ length: 50 }, (_, i) => ({
    name: `skill${i}`,
    description: 'A'.repeat(290),
    triggers: [],
    file: path.join(root, `skill${i}/SKILL.md`),
    line: `skill${i}: ` + 'A'.repeat(290) + ' — ' + '/long/private/installation/'.repeat(20),
  }));
  let calls = 0;
  const svc = service(f, async (_, request) => {
    calls++;
    const body = JSON.parse(request!.body as string);
    assert.equal(Object.keys(body.questions.skill.criteria).length, 51);
    assert.deepEqual(body.state, { task: 'Select the matching skill.' });
    assert.doesNotMatch(request!.body as string, /private\/installation/);
    const probabilities = Object.fromEntries(
      Object.keys(body.questions.skill.criteria).map((k) => [k, k === 's49' ? 1 : 0]),
    );
    return response({ skill: { type: 'choice', choice: 's49', confidence: 1, probabilities } });
  });
  const hint = await skillAdvice(svc, skills, 'Select the matching skill.', { scope: 'test' });
  assert.equal(calls, 1);
  assert.ok(hint.text.includes(path.dirname(skills[49]!.file)));
  assert.match(hint.text, /Body 49\./);
});

test('research tool returns usable role defaults without Jev and profile is read-only', async (t) => {
  const f = fixture(t);
  f.config.decisions.enabled = false;
  const ctx = { store: f.store, config: f.config, sessionId: f.session.id, scope: 'test' };
  const advice: any = await researchTool('research_worker_advice', { brief: 'Read logs' }, ctx);
  assert.equal(advice.status, 'unavailable');
  assert.ok(advice.roles.explorer.models);
  const profile: any = await researchTool('research_status', { collection: 'decisions' }, ctx);
  assert.deepEqual(profile.records, []);
});
