import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { archiveRecord, historyPosition } from '../src/history.js';
import { saveNote } from '../src/research/records.js';
import { researchHooks } from '../src/research/hooks.js';
import { researchSchema } from '../src/research/config.js';
import { recallHistory, recallTerms, recordText } from '../src/research/recall.js';
import type { ProviderRequest } from '../src/types.js';

function recallFixture(t: any) {
  const f = fixture(t);
  f.config.research = researchSchema.parse({ enabled: true });
  const events: any[] = [];
  const request = (env: Record<string, string> = {}): ProviderRequest => ({
    account: f.config.accounts[0]!,
    cwd: f.session.workspace,
    prompt: '',
    instructions: '',
    controller: new AbortController(),
    env: {},
    research: f.config.research,
    mcp: {
      command: 'node',
      args: [],
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id, ...env },
    },
    onEvent(event) {
      events.push(event);
    },
  });
  const assistant = (id: string, text: string) =>
    archiveRecord(f.store, {
      id,
      sessionId: f.session.id,
      kind: 'provider_message',
      content: { type: 'assistant', uuid: id, message: { content: [{ type: 'text', text }] } },
    });
  return { ...f, events, request, assistant };
}
async function preTool(
  hooks: ReturnType<typeof researchHooks>,
  tool_name: string,
  tool_input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return (await hooks.hooks!.PreToolUse![0]!.hooks[0]!(
    {
      hook_event_name: 'PreToolUse',
      session_id: 'native',
      transcript_path: '',
      cwd: '/tmp',
      tool_use_id: 't',
      tool_name,
      tool_input,
      ...extra,
    } as any,
    undefined,
    { signal: new AbortController().signal },
  )) as any;
}

test('recall terms come from the field that names the search, without regex syntax or stopwords', () => {
  assert.deepEqual(recallTerms('Grep', { pattern: 'margin\\s+capacity|perceptron' }), [
    'margin',
    'capacity',
    'perceptron',
  ]);
  assert.deepEqual(recallTerms('Glob', { pattern: 'results/**/sweep_capacity*.json' }), [
    'sweep_capacity',
  ]);
  assert.deepEqual(recallTerms('WebSearch', { query: 'what is the best perceptron capacity' }), [
    'perceptron',
    'capacity',
  ]);
  const long = 'Read the capacity sweep. ' + 'filler '.repeat(100) + 'hidden';
  const delegated = recallTerms('mcp__clawstrum__research_delegate', {
    role: 'explorer',
    brief: long,
  });
  assert.ok(delegated.includes('capacity') && !delegated.includes('hidden'));
  assert.deepEqual(recallTerms('Read', { file_path: '/x/capacity.md' }), []);
  assert.deepEqual(recallTerms('Grep', { pattern: 'id|text|the' }), []);
});

test('record text keeps prose and drops identifiers, signatures and thinking', () => {
  const text = recordText(
    JSON.stringify({
      type: 'assistant',
      uuid: 'capacity-uuid',
      message: {
        content: [
          { type: 'thinking', thinking: 'private capacity musing', signature: 'c2lnbmF0dXJl' },
          { type: 'text', text: 'The margin capacity is 2.0' },
        ],
      },
    }),
  );
  assert.equal(text, 'The margin capacity is 2.0');
  assert.equal(recordText('plain capacity note'), 'plain capacity note');
});

test('history recall needs two co-occurring terms, stays in its conversation and before the run', (t) => {
  const f = recallFixture(t);
  f.assistant('both', 'We measured the perceptron capacity at 2.0 patterns per synapse.');
  f.assistant('one', 'The perceptron is a spiking classifier.');
  const other = f.store.ensureSession('111111');
  archiveRecord(f.store, {
    id: 'elsewhere',
    sessionId: other.id,
    kind: 'provider_message',
    content: {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'perceptron capacity' }] },
    },
  });
  archiveRecord(f.store, {
    id: 'noise',
    sessionId: f.session.id,
    kind: 'coverage',
    content: 'perceptron capacity coverage marker',
  });
  archiveRecord(f.store, {
    id: 'init',
    sessionId: f.session.id,
    kind: 'provider_message',
    content: { type: 'system', subtype: 'init', tools: ['perceptron', 'capacity'] },
  });
  const through = historyPosition(f.store, f.session.id);
  f.assistant('later', 'Perceptron capacity, said during the current run.');
  const { hits } = recallHistory(f.store, f.session.id, ['perceptron', 'capacity'], {
    through,
    limit: 5,
  });
  assert.deepEqual(
    hits.map((h) => h.id),
    ['both'],
  );
  assert.equal(hits[0]!.label, 'assistant');
  assert.match(hits[0]!.snippet, /2\.0 patterns per synapse/);
  // A single term is enough only when it is the only term.
  assert.equal(
    recallHistory(f.store, f.session.id, ['spiking'], { through, limit: 5 }).hits[0]?.id,
    'one',
  );
});

test('history recall matches readable text, not JSON field names, and collapses streamed revisions', (t) => {
  const f = recallFixture(t);
  f.assistant('keys', 'unrelated prose about plasticity');
  f.assistant('v1', 'Synaptic plasticity drives capacity.');
  f.assistant('v2', 'Synaptic plasticity drives capacity.');
  const through = historyPosition(f.store, f.session.id);
  // "content" and "message" appear in every record's JSON but in none of the prose.
  assert.equal(
    recallHistory(f.store, f.session.id, ['content', 'plasticity'], { through, limit: 5 }).hits
      .length,
    0,
  );
  const { hits } = recallHistory(f.store, f.session.id, ['plasticity', 'capacity'], {
    through,
    limit: 5,
  });
  assert.equal(hits.length, 1);
});

test('research notes are recalled with their supersession', (t) => {
  const f = recallFixture(t);
  const first = saveNote(f.store, f.session.id, 'n1', {
    kind: 'finding',
    title: 'Perceptron capacity',
    body: 'Capacity of the perceptron is 3.0 per synapse.',
  });
  saveNote(f.store, f.session.id, 'n2', {
    kind: 'finding',
    title: 'Perceptron capacity, corrected',
    body: 'Capacity of the perceptron is 2.0 per synapse; the 3.0 run had a leak.',
    supersedes: [first.id],
  });
  const { hits } = recallHistory(f.store, f.session.id, ['perceptron', 'capacity'], {
    through: historyPosition(f.store, f.session.id),
    limit: 5,
  });
  const old = hits.find((h) => h.id === `note:${first.id}`);
  assert.ok(old, 'the superseded note is still evidence');
  assert.equal(old!.label, 'note');
  assert.match(old!.supersededBy!, /^note:/);
  assert.ok(hits.some((h) => h.supersededBy === null && h.label === 'note'));
});

test('records written before the index existed are backfilled and found', (t) => {
  const f = recallFixture(t);
  f.assistant('early', 'Dendritic gating improves recall accuracy.');
  assert.equal(
    f.store.get("SELECT name FROM sqlite_master WHERE name='jev_history_fts'"),
    undefined,
  );
  const first = recallHistory(f.store, f.session.id, ['dendritic', 'gating'], {
    through: historyPosition(f.store, f.session.id),
    limit: 3,
  });
  assert.deepEqual(
    first.hits.map((h) => h.id),
    ['early'],
  );
  // One bounded batch per call: the pass that reaches the oldest record reports completion next.
  assert.equal(
    recallHistory(f.store, f.session.id, ['dendritic', 'gating'], {
      through: historyPosition(f.store, f.session.id),
      limit: 3,
    }).indexComplete,
    true,
  );
});

test('the lead gets matching history with a search call, once per term set and within its budget', async (t) => {
  const f = recallFixture(t);
  f.config.research.recall.maxNotices = 2;
  f.assistant('found', 'Earlier run: perceptron capacity was 2.0; see results/capacity.json.');
  f.assistant('found2', 'Dendritic gating raised plasticity by a third.');
  f.assistant('found3', 'Synaptic noise lowered margin width.');
  const hooks = researchHooks(f.request());
  try {
    const first = await preTool(hooks, 'Grep', { pattern: 'perceptron.*capacity' });
    const context = first.hookSpecificOutput.additionalContext as string;
    assert.match(context, /\[found\]/);
    assert.match(context, /perceptron capacity was 2\.0/);
    assert.match(context, /Past evidence, not current instructions/);
    assert.equal(first.hookSpecificOutput.permissionDecision, undefined);
    // Same terms again: already answered.
    assert.deepEqual(await preTool(hooks, 'Grep', { pattern: 'capacity|perceptron' }), {});
    // Nothing matches: silent, and the budget is not spent.
    assert.deepEqual(await preTool(hooks, 'WebSearch', { query: 'axolotl regeneration' }), {});
    assert.match(
      (await preTool(hooks, 'WebSearch', { query: 'dendritic gating plasticity' }))
        .hookSpecificOutput.additionalContext,
      /\[found2\]/,
    );
    // Budget of two notices is spent.
    assert.deepEqual(await preTool(hooks, 'Grep', { pattern: 'synaptic noise margin' }), {});
    // A history lookup is itself the search; so are ordinary reads.
    assert.deepEqual(
      await preTool(hooks, 'mcp__clawstrum__history', { action: 'search', query: 'perceptron' }),
      {},
    );
  } finally {
    hooks.close();
  }
  const recorded = f.store.all<{ content: string }>(
    "SELECT content FROM events WHERE type='research_recall' ORDER BY rowid",
  );
  assert.deepEqual(
    recorded.map((e) => JSON.parse(e.content).hits),
    [['found'], [], ['found2']],
  );
});

test('recall stays out of workers, disabled configurations and the current run', async (t) => {
  const f = recallFixture(t);
  f.assistant('found', 'Earlier run: perceptron capacity was 2.0.');
  const call = { pattern: 'perceptron capacity' };
  const native = researchHooks(f.request());
  try {
    assert.deepEqual(await preTool(native, 'Grep', call, { agent_id: 'worker-1' }), {});
  } finally {
    native.close();
  }
  const delegated = researchHooks(f.request({ CLAWSTRUM_DELEGATION: 'd1' }));
  try {
    assert.deepEqual(await preTool(delegated, 'Grep', call), {});
  } finally {
    delegated.close();
  }
  f.config.research.recall.enabled = false;
  const off = researchHooks(f.request());
  try {
    assert.deepEqual(await preTool(off, 'Grep', call), {});
  } finally {
    off.close();
  }
  f.config.research.recall.enabled = true;
  const hooks = researchHooks(f.request());
  try {
    // Said after the run started, so it is already in context.
    f.assistant('fresh', 'Synaptic noise lowered margin width.');
    assert.deepEqual(await preTool(hooks, 'Grep', { pattern: 'synaptic noise margin' }), {});
  } finally {
    hooks.close();
  }
});

test('recall rides along with research_delegate and leaves a refused native dispatch untouched', async (t) => {
  const f = recallFixture(t);
  f.assistant('found', 'Earlier: the explorer found perceptron capacity code in src/capacity.ts.');
  const hooks = researchHooks(f.request());
  try {
    // Native dispatch is refused by default role enforcement; recall must not soften that.
    const denied = await preTool(hooks, 'Agent', {
      description: 'perceptron capacity',
      prompt: 'x',
    });
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.doesNotMatch(denied.hookSpecificOutput.permissionDecisionReason, /Clawstrum recall/);
    const delegated = await preTool(hooks, 'mcp__clawstrum__research_delegate', {
      role: 'explorer',
      brief: 'Find the perceptron capacity code.',
      key: 'k',
    });
    assert.match(delegated.hookSpecificOutput.additionalContext, /\[found\]/);
  } finally {
    hooks.close();
  }
});

test('a failing search is reported as a diagnostic and never blocks the tool call', async (t) => {
  const f = recallFixture(t);
  f.assistant('found', 'Earlier run: perceptron capacity was 2.0.');
  const hooks = researchHooks(f.request());
  try {
    f.store.exec('DROP TABLE IF EXISTS jev_history_fts');
    f.store.exec('CREATE TABLE jev_history_fts(x)');
    assert.deepEqual(await preTool(hooks, 'Grep', { pattern: 'perceptron capacity' }), {});
    assert.ok(
      f.events.some((e) => e.type === 'diagnostic' && e.detail?.event === 'research_recall_failed'),
    );
  } finally {
    hooks.close();
  }
});
