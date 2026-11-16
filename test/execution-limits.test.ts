import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { ProviderFailure } from '../src/accounts.js';
import { createClaudeProvider } from '../src/providers.js';
import type { ProviderRequest } from '../src/types.js';
import { fixture, settle } from './helpers.js';

function scriptedClaude(script: (options: any) => AsyncGenerator<any>) {
  return createClaudeProvider(((args: any) =>
    Object.assign(script(args.options), { close() {} })) as any);
}

for (const [code, kind] of [
  ['invalid_request', 'fatal'],
  ['authentication_failed', 'auth'],
] as const) {
  test(`Claude preserves ${code} explanation and structured failure kind`, async (t) => {
    const f = fixture(t);
    const provider = scriptedClaude(async function* () {
      yield {
        type: 'assistant',
        error: code,
        message: {
          content: [{ type: 'text', text: 'Provider explanation; request ID: req_example' }],
        },
      };
    });
    await assert.rejects(
      provider.run({
        account: f.config.accounts[0]!,
        cwd: f.home,
        prompt: 'summarize completed work',
        instructions: '',
        env: {},
        controller: new AbortController(),
        mcp: { command: process.execPath, args: [], env: {} },
        onEvent() {},
      }),
      (error: unknown) =>
        error instanceof ProviderFailure &&
        error.kind === kind &&
        error.message === `${code}: Provider explanation; request ID: req_example`,
    );
  });
}

for (const subtype of ['error_max_turns', 'error_max_budget_usd']) {
  test(`Claude ${subtype} is a configured budget, even without explanatory text`, async (t) => {
    const f = fixture(t);
    const provider = scriptedClaude(async function* () {
      yield { type: 'result', subtype, errors: [] };
    });
    const request: ProviderRequest = {
      account: f.config.accounts[0]!,
      cwd: f.home,
      prompt: 'continue the task',
      instructions: '',
      env: {},
      controller: new AbortController(),
      maxTurns: 60,
      mcp: { command: process.execPath, args: [], env: {} },
      onEvent() {},
    };
    await assert.rejects(
      provider.run(request),
      (error: unknown) => error instanceof ProviderFailure && error.kind === 'budget',
    );
  });
}

for (const id of ['task:scheduled-review', 'denial-recovery:previous-run']) {
  test(`default task execution has no 60-turn cutoff: ${id}`, async (t) => {
    const f = fixture(t);
    let calls = 0;
    const provider = scriptedClaude(async function* (options) {
      calls++;
      assert.equal(options.maxTurns, undefined);
      for (let i = 0; i < 61; i++) {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Read' }] },
        };
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'read' }] },
        };
      }
      yield { type: 'result', subtype: 'success', result: 'Work completed', is_error: false };
    });
    f.store.enqueue({
      id,
      sessionId: f.session.id,
      author: 'Clawstrum',
      kind: 'task',
      content: 'Work',
    });
    const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
    engine.tick();
    await settle(engine);
    assert.equal(calls, 1);
    assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'done');
    assert.deepEqual(
      f.store.pendingOutbox().map((o) => o.content),
      ['Work completed'],
    );
  });
}

test('an explicit task limit saves progress, explains the cap, and only continues on resume', async (t) => {
  const f = fixture(t);
  f.config.runtime.scheduledMaxTurns = 60;
  let calls = 0;
  const provider = scriptedClaude(async function* (options) {
    calls++;
    if (calls === 1) {
      assert.equal(options.maxTurns, 60);
      yield { type: 'system', subtype: 'init', session_id: 'native-saved' };
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Partial evidence' }] },
      };
      yield {
        type: 'result',
        subtype: 'error_max_turns',
        errors: ['Reached maximum number of turns (60)'],
      };
    } else {
      assert.equal(options.maxTurns, undefined);
      assert.equal(options.resume, 'native-saved');
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Finished remaining work',
        is_error: false,
      };
    }
  });
  f.store.enqueue({
    id: 'task:m',
    sessionId: f.session.id,
    author: 'Clawstrum',
    kind: 'task',
    content: 'Work',
  });
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  engine.tick();
  await settle(engine);
  assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'failed');
  assert.match(
    f.store.get<any>('SELECT error FROM runs').error,
    /Configured Claude turn limit reached \(60\)/,
  );
  const notice = f.store.pendingOutbox()[0]!.content;
  assert.match(notice, /60 Claude turns/);
  assert.match(notice, /runtime\.scheduledMaxTurns to 0/);
  assert.doesNotMatch(notice, /fatal/);
  assert.match(
    f.store.get<any>("SELECT content FROM events WHERE type='partial'").content,
    /Partial evidence/,
  );
  assert.equal(f.store.session(f.session.id).remote_id, 'native-saved');
  assert.equal(f.store.all('SELECT * FROM account_quotas').length, 0);
  engine.tick();
  await settle(engine);
  assert.equal(calls, 1, 'Do not defeat an explicit budget by automatically retrying');
  f.config.runtime.scheduledMaxTurns = 0;
  f.store.exec(
    "INSERT INTO controls(session_id,command,created_at) VALUES(?,'resume',?)",
    f.session.id,
    Date.now(),
  );
  engine.tick();
  await settle(engine);
  assert.equal(calls, 2);
  assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'done');
  assert.equal(
    f.store.get<any>("SELECT count(*) n FROM outbox WHERE content='Finished remaining work'").n,
    1,
  );
});

test('ordinary Claude execution errors retain their original failure class', async (t) => {
  const f = fixture(t);
  const provider = scriptedClaude(async function* () {
    yield { type: 'result', subtype: 'error_during_execution', errors: ['HTTP 503 unavailable'] };
  });
  await assert.rejects(
    provider.run({
      account: f.config.accounts[0]!,
      cwd: f.home,
      prompt: 'Work',
      instructions: '',
      env: {},
      controller: new AbortController(),
      mcp: { command: process.execPath, args: [], env: {} },
      onEvent() {},
    }),
    (error: unknown) => error instanceof ProviderFailure && error.kind === 'transient',
  );
});

test('Claude lead turns get owner MCP servers with Clawstrum intact; toolless turns get none', async (t) => {
  const f = fixture(t);
  const seen: any[] = [];
  const provider = scriptedClaude(async function* (options) {
    seen.push(options.mcpServers);
    yield { type: 'result', subtype: 'success', result: 'Done', is_error: false };
  });
  const mcp = { command: process.execPath, args: ['mcp.js'], env: { CLAWSTRUM_SESSION: 's' } };
  const request: ProviderRequest = {
    account: f.config.accounts[0]!,
    cwd: f.home,
    prompt: 'use the docs tool',
    instructions: '',
    env: {},
    controller: new AbortController(),
    mcp,
    extraMcp: {
      docs: { command: '/usr/bin/docs-mcp', args: ['--stdio'], env: { A: '1' } },
      clawstrum: { command: '/bin/false', args: [], env: {} },
    },
    onEvent() {},
  };
  await provider.run(request);
  await provider.run({ ...request, toolless: true, controller: new AbortController() });
  assert.deepEqual(seen[0], {
    docs: { type: 'stdio', command: '/usr/bin/docs-mcp', args: ['--stdio'], env: { A: '1' } },
    clawstrum: { type: 'stdio', ...mcp },
  });
  assert.deepEqual(seen[1], {});
});
