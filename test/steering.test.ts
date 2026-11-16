import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { buildContext } from '../src/context.js';
import { readInstructionSnapshot } from '../src/instructions.js';
import { TurnStream } from '../src/turn-stream.js';
import { createClaudeProvider } from '../src/providers.js';
import { ProviderFailure } from '../src/accounts.js';
import type { Provider, ProviderRequest } from '../src/types.js';
import { fixture, ok, settle } from './helpers.js';
import { researchSchema } from '../src/research/config.js';
import { delegate } from '../src/research/workers.js';
import { steerWorker, workerSteers } from '../src/research/steering.js';

const pause = (ms = 25) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for steering state');
    await pause(10);
  }
}

test('TurnStream yields injected turns and closes after the last result', async () => {
  const input = new TurnStream('first');
  const seen: string[] = [];
  const done = (async () => {
    for await (const m of input) seen.push(m.message.content as string);
  })();
  await pause(5);
  assert.equal(input.push('second'), true);
  input.observe({ type: 'result' });
  await pause(5);
  input.observe({ type: 'result' });
  await done;
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal(input.push('late'), false);
});

test('TurnStream with holdTasks stays open until background tasks settle', async () => {
  const input = new TurnStream('work', true, 0);
  const seen: string[] = [];
  const done = (async () => {
    for await (const m of input) seen.push(m.message.content as string);
  })();
  await pause(5);
  input.observe({ type: 'system', subtype: 'task_started', is_backgrounded: true, task_id: 't1' });
  input.observe({ type: 'result' });
  assert.equal(input.push('steer while a task runs'), true);
  await pause(5);
  input.observe({ type: 'result' });
  input.observe({
    type: 'system',
    subtype: 'task_notification',
    status: 'completed',
    task_id: 't1',
  });
  await done;
  assert.deepEqual(seen, ['work', 'steer while a task runs']);
});

test('after background work, input waits out the grace and stays open through a CLI-started turn', async () => {
  const input = new TurnStream('work', true, 40);
  const iterator = input[Symbol.asyncIterator]();
  const first = (await iterator.next()).value;
  let ended = false;
  const end = iterator.next().then((r) => {
    ended = r.done === true;
  });
  input.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'bg' }],
  });
  input.observe({ type: 'result', user_message_uuid: first.uuid });
  input.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  await pause(10);
  assert.equal(ended, false, 'the notification turn has not started yet');
  // The CLI delivers the task notification in a turn nobody pushed.
  input.observe({ type: 'system', subtype: 'init', session_id: 's' });
  await pause(60);
  assert.equal(ended, false, 'input stays open while the CLI-started turn runs');
  input.observe({ type: 'assistant', message: { content: [] } });
  input.observe({ type: 'result', num_turns: 1 });
  await pause(10);
  assert.equal(ended, false, 'the grace restarts after that turn');
  await end;
  assert.equal(ended, true);
});

test('a task that finished during the turn defers the close for its notification turn', async () => {
  const input = new TurnStream('work', false, 40);
  const iterator = input[Symbol.asyncIterator]();
  const first = (await iterator.next()).value;
  let ended = false;
  const end = iterator.next().then(() => {
    ended = true;
  });
  input.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'bg' }],
  });
  input.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  input.observe({ type: 'result', user_message_uuid: first.uuid });
  await pause(10);
  assert.equal(ended, false);
  input.observe({ type: 'stream_event', event: { type: 'message_start' } });
  await pause(60);
  assert.equal(ended, false);
  input.observe({ type: 'result', num_turns: 1 });
  await end;
});

test('turns without background work still close input at the result', async () => {
  const input = new TurnStream('plain', true, 60000);
  const iterator = input[Symbol.asyncIterator]();
  const first = (await iterator.next()).value;
  const end = iterator.next();
  input.observe({ type: 'result', user_message_uuid: first.uuid });
  assert.equal((await end).done, true);
});

test('input pushed during the grace is delivered and the grace re-arms after its result', async () => {
  const input = new TurnStream('work', true, 30);
  const iterator = input[Symbol.asyncIterator]();
  const first = (await iterator.next()).value;
  input.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'bg' }],
  });
  input.observe({ type: 'result', user_message_uuid: first.uuid });
  input.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  await pause(10);
  assert.equal(input.push('late question'), true);
  const second = (await iterator.next()).value;
  assert.equal(second.message.content, 'late question');
  await pause(40);
  let ended = false;
  const end = iterator.next().then(() => {
    ended = true;
  });
  await pause(5);
  assert.equal(ended, false, 'the pushed turn has no result yet');
  input.observe({ type: 'result', user_message_uuid: second.uuid });
  await end;
  assert.equal(input.hasUnfinishedInjection, false);
});

test('an explicit close during the grace ends input at once', async () => {
  const input = new TurnStream('work', true, 60000);
  const iterator = input[Symbol.asyncIterator]();
  const first = (await iterator.next()).value;
  input.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'bg' }],
  });
  input.observe({ type: 'result', user_message_uuid: first.uuid });
  input.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  const end = iterator.next();
  input.close();
  assert.equal((await end).done, true);
});

test('one Claude result can complete several coalesced live messages', async () => {
  const input = new TurnStream('first');
  const iterator = input[Symbol.asyncIterator]();
  const first = (await iterator.next()).value;
  input.push('second');
  input.push('third');
  const second = (await iterator.next()).value;
  const third = (await iterator.next()).value;
  const end = iterator.next();
  input.observe({ type: 'result', user_message_uuids: [first.uuid, second.uuid, third.uuid] });
  assert.equal((await end).done, true);
  assert.equal(input.hasUnfinishedInjection, false);
});

test('Claude consumption maps complete batches once and ignores subagent, unknown and result frames', async () => {
  const input = new TurnStream('first');
  const iterator = input[Symbol.asyncIterator]();
  const first = (await iterator.next()).value;
  input.push('two related questions', ['m2', 'm3']);
  const second = (await iterator.next()).value;
  input.push('a correction', ['m4']);
  const third = (await iterator.next()).value;
  const stamp = {
    type: 'assistant',
    user_message_uuids: [second.uuid, third.uuid],
    user_message_uuid: third.uuid,
  };
  assert.deepEqual(input.observe({ ...stamp, parent_tool_use_id: 'worker' }), []);
  assert.deepEqual(input.observe({ type: 'assistant', user_message_uuid: 'unknown' }), []);
  assert.deepEqual(input.observe({ type: 'result', user_message_uuid: first.uuid }), []);
  assert.deepEqual(input.observe({ ...stamp, type: 'stream_event' }), ['m2', 'm3', 'm4']);
  assert.deepEqual(input.observe(stamp), []);
  assert.equal(input.hasUnfinishedInjection, true, 'consumption is not completion');
  input.observe({ type: 'result', user_message_uuids: [second.uuid, third.uuid] });
  assert.equal((await iterator.next()).done, true);
});

test('prompt hooks recognize exact folded and coalesced inputs without consuming snippets', async () => {
  const input = new TurnStream('first');
  const iterator = input[Symbol.asyncIterator]();
  await iterator.next();
  input.push('question two', ['m2']);
  const second = (await iterator.next()).value;
  input.push('question three', ['m3']);
  await iterator.next();
  assert.deepEqual(input.startPrompt('quoted: question two'), []);
  assert.deepEqual(input.startPrompt('question two\nunknown'), []);
  assert.deepEqual(input.startPrompt('question two\nquestion three'), ['m2', 'm3']);
  assert.deepEqual(input.startPrompt('question two'), []);
  assert.deepEqual(input.observe({ type: 'assistant', user_message_uuid: second.uuid }), []);
  assert.equal(input.hasUnfinishedInjection, true);
  input.close();
});

test('zero-turn background catch-up on resume cannot complete the submitted user prompt', async () => {
  const input = new TurnStream('resume unfinished research');
  const iterator = input[Symbol.asyncIterator]();
  const first = (await iterator.next()).value;
  input.observe({
    type: 'result',
    subtype: 'success',
    num_turns: 0,
    result: '',
    queued_turn_count: 0,
  });
  assert.equal(input.awaitingInput, false);
  assert.equal(input.push('additional user request'), true);
  const second = (await iterator.next()).value;
  const end = iterator.next();
  input.observe({ type: 'result', num_turns: 2, user_message_uuids: [first.uuid, second.uuid] });
  assert.equal((await end).done, true);
});

test('a correlated result cannot consume a newer send or finish it twice', async () => {
  const input = new TurnStream('first');
  const iterator = input[Symbol.asyncIterator]();
  const first = (await iterator.next()).value;
  input.push('second');
  const second = (await iterator.next()).value;
  input.observe({ type: 'result', user_message_uuid: first.uuid });
  input.observe({ type: 'result', user_message_uuids: [first.uuid] });
  input.observe({ type: 'result', user_message_uuids: [] });
  input.observe({ type: 'result', user_message_uuid: 'unrelated-background-result' });
  assert.equal(input.hasUnfinishedInjection, true);
  assert.equal(input.awaitingInput, false);
  const end = iterator.next();
  input.observe({ type: 'result', user_message_uuid: second.uuid });
  assert.equal((await end).done, true);
});

test('coalesced completion still waits for background work and buffered input', async () => {
  const input = new TurnStream('first', true, 0);
  const iterator = input[Symbol.asyncIterator]();
  const first = (await iterator.next()).value;
  input.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'bg' }],
  });
  input.push('second');
  input.observe({ type: 'result', user_message_uuids: [first.uuid] });
  assert.equal(input.hasUnfinishedInjection, true);
  const second = (await iterator.next()).value;
  input.observe({ type: 'result', user_message_uuid: second.uuid });
  assert.equal(input.awaitingInput, true);
  assert.equal(input.push('third while background work runs'), true);
  const third = (await iterator.next()).value;
  input.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(input.hasUnfinishedInjection, true);
  const end = iterator.next();
  input.observe({ type: 'result', user_message_uuids: [third.uuid] });
  assert.equal((await end).done, true);
});

test('TurnStream counts background tasks without holdTasks and still closes on the result', async () => {
  const input = new TurnStream('work');
  const done = (async () => {
    for await (const _ of input) void _;
  })();
  await pause(5);
  input.observe({ type: 'system', subtype: 'task_started', is_backgrounded: true, task_id: 't1' });
  assert.equal(input.tasks.size, 1);
  input.observe({ type: 'result' });
  await done;
  input.observe({
    type: 'system',
    subtype: 'task_notification',
    status: 'completed',
    task_id: 't1',
  });
  assert.equal(input.tasks.size, 0);
});

test('queued user messages are injected into a live claude turn', async (t) => {
  const { store, config, enqueue } = fixture(t);
  let release!: () => void;
  const injected: string[] = [];
  const live: Provider = {
    async run(r) {
      r.onEvent({ type: 'ready' });
      r.attachInjector!((ids, text) => {
        injected.push(text);
        r.onEvent({ type: 'injected', detail: { ids, ok: true } });
        return true;
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'Handled everything';
    },
  };
  const engine = new Engine(config, store, { claude: live, codex: ok });
  enqueue('m1');
  engine.tick();
  await pause();
  enqueue('m2');
  engine.tick();
  await pause();
  assert.equal(injected.length, 1);
  assert.match(injected[0]!, /"text":"m2"/);
  const run = store.get<{ id: string; logical_id: string; message_ids: string }>(
    'SELECT * FROM runs',
  )!;
  assert.deepEqual(JSON.parse(run.message_ids), ['m1', 'm2']);
  const row = store.get<{ status: string; batch_id: string }>(
    'SELECT status,batch_id FROM inbound WHERE id=?',
    'm2',
  )!;
  assert.equal(row.status, 'running');
  assert.equal(row.batch_id, run.logical_id);
  engine.tick();
  await pause();
  assert.equal(injected.length, 1);
  release();
  await settle(engine);
  for (const id of ['m1', 'm2'])
    assert.equal(
      store.get<{ status: string }>('SELECT status FROM inbound WHERE id=?', id)!.status,
      'done',
    );
  assert.equal(store.all('SELECT id FROM runs').length, 1);
});

test('task snapshots override unordered bookends and release held input', async () => {
  const input = new TurnStream('work', true, 0);
  const iterator = input[Symbol.asyncIterator]();
  await iterator.next();
  input.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  input.observe({
    type: 'system',
    subtype: 'task_started',
    is_backgrounded: true,
    task_id: 'late',
  });
  assert.equal(input.tasks.size, 0, 'late bookends cannot resurrect a finished task');
  input.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'active' }],
  });
  input.observe({
    type: 'system',
    subtype: 'task_notification',
    status: 'completed',
    task_id: 'active',
  });
  assert.equal(input.tasks.size, 1, 'bookends cannot override a full live snapshot');
  input.observe({ type: 'result' });
  const end = iterator.next();
  input.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal((await end).done, true);
});

test('task bookend fallback tracks background transitions and rejects missing IDs', () => {
  const input = new TurnStream('work');
  input.observe({ type: 'system', subtype: 'task_started', is_backgrounded: true });
  input.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'foreground',
    is_backgrounded: false,
  });
  assert.equal(input.tasks.size, 0);
  input.observe({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'foreground',
    patch: { is_backgrounded: true },
  });
  assert.equal(input.tasks.size, 1);
  input.observe({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'foreground',
    patch: { status: 'killed' },
  });
  assert.equal(input.tasks.size, 0);
});

test('Claude propagates task snapshots and transition counts with research disabled', async (t) => {
  const f = fixture(t);
  const query = ((params: any) =>
    Object.assign(
      (async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        await input.next();
        yield {
          type: 'system',
          subtype: 'task_updated',
          task_id: 'legacy',
          patch: { is_backgrounded: true },
        };
        yield {
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'watcher', ambient: true }, { task_id: 'bash' }],
        };
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'bash',
          status: 'completed',
        };
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
        yield { type: 'system', subtype: 'task_started', task_id: 'bash', is_backgrounded: true };
        yield { type: 'result', subtype: 'success', result: 'done', usage: {} };
        assert.equal((await input.next()).done, true);
      })(),
      { close() {} },
    )) as any;
  const counts: number[] = [];
  assert.equal(
    await createClaudeProvider(query).run({
      account: f.config.accounts[0]!,
      cwd: f.session.workspace,
      prompt: 'watch',
      instructions: '',
      env: {},
      controller: new AbortController(),
      research: f.config.research,
      inputReleaseGraceMs: 0,
      mcp: { command: 'node', args: [], env: {} },
      onEvent: (event) => {
        if (event.type === 'activity') counts.push(event.backgroundTasks!);
      },
    }),
    'done',
  );
  assert.deepEqual(counts, [1, 2, 2, 0, 0]);
});

test('background task state is cleared on a Claude to Codex quota handoff', async (t) => {
  const f = fixture(t);
  f.config.runtime.silenceTimeoutMs = 1000;
  let request!: ProviderRequest;
  const claude: Provider = {
    async run(r) {
      r.onEvent({ type: 'ready', backgroundTasks: 1 });
      throw new ProviderFailure('quota', 'limit');
    },
  };
  const codex: Provider = {
    async run(r) {
      request = r;
      r.onEvent({ type: 'ready' });
      return new Promise<string>((_, reject) =>
        r.controller.signal.addEventListener('abort', () => reject(r.controller.signal.reason), {
          once: true,
        }),
      );
    },
  };
  const engine = new Engine(f.config, f.store, { claude, codex });
  f.enqueue('handoff');
  engine.tick();
  await until(() => !!request);
  const state = engine.active.get(f.session.id)!;
  assert.equal(state.accountId, 'b');
  assert.equal(state.backgroundTasks, 0);
  engine.tick(state.lastActivity + 1001);
  assert.match(String(request.controller.signal.reason), /silence timeout/);
  await settle(engine);
});

test('a rejected injection leaves the message queued for a follow-up run', async (t) => {
  const { store, config, enqueue } = fixture(t);
  let release!: () => void;
  const live: Provider = {
    async run(r) {
      r.onEvent({ type: 'ready' });
      r.attachInjector!((ids) => {
        r.onEvent({ type: 'injected', detail: { ids, ok: false } });
        return true;
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'First turn only';
    },
  };
  const engine = new Engine(config, store, { claude: live, codex: ok });
  enqueue('m1');
  engine.tick();
  await pause();
  enqueue('m2');
  engine.tick();
  await pause();
  assert.equal(
    store.get<{ status: string }>('SELECT status FROM inbound WHERE id=?', 'm2')!.status,
    'queued',
  );
  release();
  await settle(engine);
  assert.equal(
    store.get<{ status: string }>('SELECT status FROM inbound WHERE id=?', 'm2')!.status,
    'queued',
  );
});

test('closing streaming input releases waiters and never yields buffered input after abort', async () => {
  const input = new TurnStream('first');
  const iterator = input[Symbol.asyncIterator]();
  await iterator.next();
  input.push('buffered');
  input.close();
  assert.equal((await iterator.next()).done, true);
  assert.equal(input.push('late'), false);
  const waiting = new TurnStream('first');
  const other = waiting[Symbol.asyncIterator]();
  await other.next();
  const next = other.next();
  waiting.close();
  assert.equal((await next).done, true);
});

test('a result racing queued input cannot close the stream before that input is delivered', async () => {
  const input = new TurnStream('first');
  const iterator = input[Symbol.asyncIterator]();
  await iterator.next();
  input.push('second');
  input.observe({ type: 'result' });
  assert.equal(input.hasUnfinishedInjection, true);
  assert.equal((await iterator.next()).value.message.content, 'second');
  const end = iterator.next();
  input.observe({ type: 'result' });
  assert.equal((await end).done, true);
  assert.equal(input.hasUnfinishedInjection, false);
});

test('extra background results cannot complete a later injected message', async () => {
  const input = new TurnStream('first', true, 0);
  const iterator = input[Symbol.asyncIterator]();
  await iterator.next();
  input.observe({ type: 'system', subtype: 'task_started', is_backgrounded: true, task_id: 'bg' });
  input.observe({ type: 'result' });
  input.observe({ type: 'result' });
  input.push('second');
  await iterator.next();
  input.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(input.hasUnfinishedInjection, true);
  const end = iterator.next();
  input.observe({ type: 'result' });
  assert.equal((await end).done, true);
});

test('Claude rejects premature EOF after a result when accepted steering remains unfinished', async (t) => {
  const f = fixture(t);
  let inject!: (ids: string[], text: string) => boolean;
  const query = ((params: any) =>
    Object.assign(
      (async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        await input.next();
        assert.equal(inject(['second'], 'second'), true);
        await input.next();
        yield { type: 'result', subtype: 'success', result: 'Only the first answer', usage: {} };
      })(),
      { close() {} },
    )) as any;
  const acknowledgments: unknown[] = [];
  await assert.rejects(
    createClaudeProvider(query).run({
      account: f.config.accounts[0]!,
      cwd: f.session.workspace,
      prompt: 'first',
      instructions: '',
      env: {},
      controller: new AbortController(),
      mcp: { command: 'node', args: [], env: {} },
      attachInjector: (fn) => {
        inject = fn;
      },
      onEvent: (event) => {
        if (event.type === 'injected') acknowledgments.push(event.detail);
      },
    }),
    /before all accepted input received a result/,
  );
  assert.deepEqual(acknowledgments, [{ ids: ['second'], ok: true }]);
  assert.equal(inject(['late'], 'late'), false);
});

async function running(
  t: any,
  provider: 'claude' | 'codex' = 'claude',
  task = false,
  taskLimit = 0,
) {
  const f = fixture(t);
  let request!: ProviderRequest;
  let release!: (error?: Error) => void;
  const injections: Array<{ ids: string[]; text: string }> = [];
  const live: Provider = {
    async run(r) {
      request = r;
      r.attachInjector!((ids, text) => {
        injections.push({ ids, text });
        return true;
      });
      r.onEvent({ type: 'ready' });
      await new Promise<void>((resolve, reject) => {
        release = (error) => (error ? reject(error) : resolve());
      });
      return 'Finished';
    },
  };
  f.config.runtime.maxConcurrent = 1;
  f.config.runtime.scheduledMaxTurns = taskLimit;
  if (provider === 'codex')
    f.store.exec('UPDATE sessions SET preferred_account=? WHERE id=?', 'b', f.session.id);
  f.enqueue('m1', 100);
  if (task) f.store.exec("UPDATE inbound SET kind='task' WHERE id='m1'");
  const engine = new Engine(f.config, f.store, { claude: live, codex: live });
  engine.tick();
  await until(() => !!release);
  return {
    ...f,
    engine,
    injections,
    request,
    release,
    ack(ids: string[], ok = true) {
      request.onEvent({ type: 'injected', detail: { ids, ok } });
    },
    status(id: string) {
      return f.store.get<{ status: string }>('SELECT status FROM inbound WHERE id=?', id)!.status;
    },
  };
}

for (const barrier of ['attachment', 'retry-delay', 'retry-batch', 'oversize'])
  test(`steering preserves the ${barrier} barrier and does not skip to later messages`, async (t) => {
    const f = await running(t);
    f.enqueue('m2', 200);
    f.enqueue('m3', 300);
    if (barrier === 'attachment')
      f.store.exec("UPDATE inbound SET attachments='[{}]' WHERE id='m2'");
    if (barrier === 'retry-delay')
      f.store.exec("UPDATE inbound SET available_at=? WHERE id='m2'", Date.now() + 60000);
    if (barrier === 'retry-batch')
      f.store.exec("UPDATE inbound SET batch_id='older-attempt' WHERE id='m2'");
    if (barrier === 'oversize')
      f.store.exec(
        "UPDATE inbound SET content=? WHERE id='m2'",
        'x'.repeat(f.config.runtime.promptChars),
      );
    f.engine.tick();
    assert.equal(f.injections.length, 0);
    f.release();
    await settle(f.engine);
    assert.equal(f.status('m2'), 'queued');
    assert.equal(f.status('m3'), 'queued');
  });

for (const provider of ['claude', 'codex'] as const)
  test(`scheduled ${provider} lead work accepts and batches arriving user input`, async (t) => {
    const f = await running(t, provider, true);
    assert.equal(f.request.liveInput, true);
    assert.equal(f.request.subagent, undefined);
    f.enqueue('m2');
    f.enqueue('m3');
    f.engine.tick();
    assert.deepEqual(f.injections[0]?.ids, ['m2', 'm3']);
    // Acceptance, not merely sending IPC, changes ownership of the input.
    assert.equal(f.status('m2'), 'queued');
    f.ack(['m2', 'm3']);
    assert.equal(f.status('m2'), 'running');
    assert.equal(f.engine.active.get(f.session.id)!.taskRun, false);
    f.release();
    await settle(f.engine);
    assert.equal(f.status('m2'), 'done');
    assert.equal(f.status('m3'), 'done');
  });

test('a scheduled execution cap does not fail user input accepted during that task', async (t) => {
  const f = await running(t, 'claude', true, 1);
  assert.equal(f.request.maxTurns, 1);
  f.enqueue('m2');
  f.engine.tick();
  f.ack(['m2']);
  f.release(new ProviderFailure('budget', 'Configured task limit'));
  await settle(f.engine);
  assert.equal(f.status('m1'), 'failed');
  assert.equal(f.status('m2'), 'queued');
  const next = f.store.claim(f.session.id)!;
  assert.deepEqual(
    next.messages.map((m) => m.id),
    ['m2'],
  );
});

test('steering honors debounce and typing, including the maximum burst delay', async (t) => {
  const f = await running(t);
  const now = Date.now();
  f.config.runtime.debounceMs = 100;
  f.config.runtime.debounceMaxMs = 1000;
  f.config.runtime.typingMaxMs = 2000;
  f.enqueue('m2', now);
  f.engine.typingUntil.set(f.session.id, now + 5000);
  f.engine.tick(now + 200);
  assert.equal(f.injections.length, 0);
  f.engine.tick(now + 1100);
  assert.equal(f.injections.length, 0, 'typing keeps the injection waiting past debounceMaxMs');
  f.engine.tick(now + 2100);
  assert.deepEqual(f.injections[0]!.ids, ['m2']);
  f.ack(['m2']);
  f.release();
  await settle(f.engine);
});

for (const provider of ['claude', 'codex'] as const)
  test(`${provider} live input does not reinstate behavioral policy removed from AGENTS.md`, async (t) => {
    const f = await running(t, provider);
    const file = path.join(f.home, 'AGENTS.md');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(
      file,
      original.replace(
        /## Communication\n[\s\S]*?(?=\n## Memory and continuity)/,
        '## Communication\n\nAnswer directly without a separate acknowledgment.\n',
      ),
    );
    f.enqueue('m2');
    f.engine.tick();
    assert.equal(f.injections.length, 1);
    assert.match(f.injections[0]!.text, /"id":"m2"/);
    assert.doesNotMatch(f.injections[0]!.text, /send_message|First send|generic receipts/);
    const refresh = readInstructionSnapshot(f.request.contextRefresh!.sources);
    assert.match(refresh.instructions, /Answer directly without a separate acknowledgment/);
    assert.doesNotMatch(refresh.instructions, /one short non-final send_message/);
    f.ack(['m2']);
    f.release();
    await settle(f.engine);
    assert.equal(f.status('m2'), 'done');
  });

test('only pending same-session IDs are acknowledged, once, even at full concurrency', async (t) => {
  const f = await running(t);
  const other = f.store.ensureSession('123456');
  f.store.enqueue({ id: 'other', sessionId: other.id, author: 'owner', content: 'other', at: 150 });
  f.enqueue('m2', 200);
  f.engine.tick();
  f.engine.tick();
  assert.equal(f.injections.length, 1);
  assert.equal(f.status('m2'), 'queued');
  f.request.onEvent({ type: 'injected', detail: null });
  f.ack(['other', 'm2', 'm2', 'unknown']);
  f.ack(['m2']);
  assert.equal(f.status('other'), 'queued');
  assert.equal(f.status('m2'), 'running');
  assert.equal(f.store.all("SELECT * FROM events WHERE type='steered'").length, 1);
  assert.deepEqual(JSON.parse(f.store.get<any>('SELECT message_ids FROM runs').message_ids), [
    'm1',
    'm2',
  ]);
  f.release();
  await settle(f.engine);
});

test('unacknowledged input stays queued and rejected input is not repeatedly sent', async (t) => {
  const f = await running(t);
  f.enqueue('m2', 200);
  f.engine.tick();
  f.engine.tick();
  assert.equal(f.injections.length, 1);
  f.ack(['m2'], false);
  f.engine.tick();
  assert.equal(f.injections.length, 1);
  f.release();
  await settle(f.engine);
  assert.equal(f.status('m2'), 'queued');
});

test('missing acknowledgment leaves input available for the next normal claim', async (t) => {
  const f = await running(t);
  f.enqueue('m2', 200);
  f.engine.tick();
  f.release();
  await settle(f.engine);
  assert.equal(f.status('m2'), 'queued');
  const next = f.store.claim(f.session.id)!;
  assert.deepEqual(
    next.messages.map((m) => m.id),
    ['m2'],
  );
  assert.notEqual(
    next.run.logical_id,
    f.store.get<any>("SELECT batch_id FROM inbound WHERE id='m1'").batch_id,
  );
});

test('a closed injector leaves messages queued without retrying it every tick', async (t) => {
  const f = await running(t);
  let calls = 0;
  f.engine.active.get(f.session.id)!.inject = () => {
    calls++;
    return false;
  };
  f.enqueue('m2', 200);
  f.engine.tick();
  f.engine.tick();
  assert.equal(calls, 1);
  f.release();
  await settle(f.engine);
  assert.equal(f.status('m2'), 'queued');
});

test('steering batches are bounded and cancellation wins over a late acknowledgment', async (t) => {
  const f = await running(t);
  for (let i = 2; i <= 22; i++) f.enqueue(`m${i}`, 100 + i);
  f.engine.tick();
  assert.equal(f.injections[0]!.ids.length, 20);
  f.store.exec(
    'INSERT INTO controls(session_id,command,created_at) VALUES(?,?,?)',
    f.session.id,
    'cancel',
    Date.now(),
  );
  f.engine.tick();
  f.ack(f.injections[0]!.ids);
  f.release();
  await settle(f.engine);
  assert.equal(f.store.all("SELECT * FROM inbound WHERE status != 'cancelled'").length, 0);
  assert.equal(f.store.all("SELECT * FROM events WHERE type='steered'").length, 0);
});

test('a final reply racing acceptance reopens the answer without disabling further steering', async (t) => {
  const f = await running(t);
  f.enqueue('m2', 200);
  f.engine.tick();
  const run = f.store.get<any>('SELECT * FROM runs');
  f.store.outbox(f.session.id, 'Already answered', { runId: run.id, final: true });
  f.ack(['m2']);
  assert.equal(f.status('m2'), 'running');
  assert.equal(f.store.hasFinal(run.id), false);
  assert.equal(f.store.hasOutput(run.logical_id), false);
  f.enqueue('m3', 300);
  f.engine.tick();
  assert.equal(f.injections.length, 2);
  f.ack(['m3']);
  f.release();
  await settle(f.engine);
  assert.equal(f.status('m2'), 'done');
  assert.equal(f.status('m3'), 'done');
  assert.equal(f.store.all('SELECT * FROM runs').length, 1);
});

test('acknowledged steering survives quota handoff into Codex portable context', async (t) => {
  const f = fixture(t);
  let fail!: () => void;
  let ready = false;
  let resumed = '';
  const engine = new Engine(f.config, f.store, {
    claude: {
      async run(r) {
        r.attachInjector!((ids) => {
          r.onEvent({ type: 'injected', detail: { ids, ok: true } });
          return true;
        });
        r.onEvent({ type: 'ready' });
        await new Promise<void>((resolve) => {
          fail = resolve;
          ready = true;
        });
        throw new ProviderFailure('quota', 'Subscription limit');
      },
    },
    codex: {
      async run(r) {
        resumed = r.prompt;
        return 'Continued';
      },
    },
  });
  f.enqueue('m1');
  engine.tick();
  await until(() => ready);
  f.enqueue('m2');
  engine.tick();
  fail();
  await settle(engine);
  assert.match(resumed, /"text":"m2"/);
  assert.deepEqual(
    f.store.all<{ status: string }>('SELECT status FROM inbound').map((m) => m.status),
    ['done', 'done'],
  );
});

test('crash recovery requeues the acknowledged batch and preserves unacknowledged input', async (t) => {
  const f = await running(t);
  f.enqueue('m2', 200);
  f.engine.tick();
  f.ack(['m2']);
  f.enqueue('m3', 300);
  f.engine.tick();
  f.engine.active.get(f.session.id)!.controller.abort(new Error('Simulated crash'));
  assert.equal(f.store.recover(), 2);
  assert.equal(f.status('m1'), 'queued');
  assert.equal(f.status('m2'), 'queued');
  assert.equal(f.status('m3'), 'queued');
  f.release();
  await settle(f.engine);
  assert.equal(f.status('m2'), 'queued');
});

for (const research of [false, true])
  test(
    `compiled supervisor, ${research ? 'research' : 'lead'} worker and installed Claude SDK carry steering across real IPC`,
    { timeout: 25000 },
    async (t) => {
      const f = fixture(t);
      const executable = path.join(f.home, 'claude-steering.mjs');
      const record = path.join(f.config.accounts[0]!.home, 'inputs.json');
      fs.mkdirSync(f.config.accounts[0]!.home, { recursive: true });
      fs.writeFileSync(
        executable,
        `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
if (process.argv.includes('--version')) { console.log('2.2.270'); process.exit(0); }
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
const inputs = [];
const result = text => send({type:'result',subtype:'success',result:text,is_error:false,session_id:'native',uuid:text,duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{},modelUsage:{},permission_denials:[]});
for await (const line of createInterface({input:process.stdin})) {
  const m = JSON.parse(line);
  if (m.type === 'control_request') send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],models:[],account:null}}});
  if (m.type === 'user') {
    inputs.push(m.message.content);
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'inputs.json'), JSON.stringify(inputs));
    if (inputs.length === 1) send({type:'system',subtype:'init',session_id:'native',tools:[],mcp_servers:[],model:'test',permissionMode:'bypassPermissions',apiKeySource:'none',cwd:process.cwd(),uuid:'init'});
    else { result('First result'); setTimeout(() => result('Handled steering'), 100); }
  }
}
`,
        { mode: 0o700 },
      );
      f.config.accounts[0]!.executable = executable;
      if (research)
        f.config.research = researchSchema.parse({
          enabled: true,
          validation: 'off',
          workers: { minFreeMemoryMB: 0 },
        });
      // Import compiled code so the test exercises the same child process path as an installation.
      const { Engine: CompiledEngine } = await import('../dist/engine.js' as string);
      const engine: Engine = new CompiledEngine(f.config, f.store);
      try {
        if (research) {
          const worker = delegate(f.store, f.session.id, f.config, 'research', {
            role: 'analyst',
            brief: 'Inspect evidence',
          });
          engine.researchWorkers.tick();
          await until(
            () =>
              engine.researchWorkers.active.get(worker.id)?.ready === true &&
              !!engine.researchWorkers.active.get(worker.id)?.inject,
          );
          steerWorker(
            f.store,
            f.session.id,
            worker.id,
            'correction',
            'Check the control condition',
          );
          engine.researchWorkers.tick();
          await until(() => engine.researchWorkers.active.size === 0);
          const saved = f.store.get<any>('SELECT * FROM delegations WHERE id=?', worker.id);
          assert.equal(saved.status, 'completed');
          assert.equal(workerSteers(f.store, worker.id)[0]?.status, 'accepted');
          assert.match(fs.readFileSync(saved.result_path, 'utf8'), /Handled steering/);
          assert.equal(
            JSON.parse(fs.readFileSync(record, 'utf8'))[1],
            'Check the control condition',
          );
          return;
        }
        f.enqueue('m1');
        engine.tick();
        await until(() => engine.active.get(f.session.id)?.ready === true);
        f.enqueue('m2');
        engine.tick();
        await until(
          () => f.store.get<any>("SELECT status FROM inbound WHERE id='m2'").status === 'done',
        );
        await settle(engine);
        const inputs = JSON.parse(fs.readFileSync(record, 'utf8'));
        assert.equal(inputs.length, 2);
        assert.match(inputs[1], /"text":"m2"/);
        assert.equal(f.store.all('SELECT * FROM runs').length, 1);
        // The first result was superseded by a later one; it is still delivered, as a non-final reply.
        assert.deepEqual(
          f.store.all<any>('SELECT content FROM outbox ORDER BY rowid').map((r) => r.content),
          ['First result', 'Handled steering'],
        );
        assert.equal(f.store.all("SELECT * FROM events WHERE type='steered'").length, 1);
      } finally {
        await engine.stop();
      }
    },
  );

test('a final reply held open by background work accepts new text and creates a distinct answer scope', async (t) => {
  const f = await running(t);
  const run = f.store.get<any>('SELECT * FROM runs');
  f.store.outbox(f.session.id, 'Handled everything', { runId: run.id, final: true });
  const oldScope = f.store.replyScope(run.logical_id);
  f.enqueue('m2', 200);
  f.engine.tick();
  assert.equal(f.injections.length, 1);
  f.ack(['m2']);
  assert.equal(f.status('m2'), 'running');
  assert.equal(f.store.hasFinal(run.id), false);
  assert.notEqual(f.store.replyScope(run.logical_id), oldScope);
  assert.equal(
    f.store.hasOutput(run.logical_id),
    false,
    'previous answer cannot satisfy the new request',
  );
  assert.equal(f.store.findOutput(run.logical_id, 'Handled everything'), undefined);
  assert.equal(f.request.controller.signal.aborted, false, 'background work survives steering');
  f.store.outbox(f.session.id, 'Handled everything', { runId: run.id, final: true });
  f.release();
  await settle(f.engine);
  assert.equal(
    f.store.all('SELECT * FROM outbox').length,
    2,
    'same answer text is valid for a new request',
  );
  assert.equal(f.status('m2'), 'done');
});

for (const provider of ['claude', 'codex'] as const)
  test(`${provider} accepts progress questions after an answer while tool work continues`, async (t) => {
    const f = await running(t, provider);
    const run = f.store.get<any>('SELECT * FROM runs');
    f.store.outbox(f.session.id, 'Answer to the side question', { runId: run.id, final: true });
    f.request.onEvent({
      type: 'activity',
      detail: {},
      tool: { id: 'ongoing-research', name: 'Bash', state: 'started' },
    });
    f.enqueue('progress?', 200);
    f.enqueue('How is the new judge?', 201);
    f.engine.tick();
    assert.deepEqual(f.injections[0]?.ids, ['progress?', 'How is the new judge?']);
    assert.equal(f.request.controller.signal.aborted, false);
    f.ack(f.injections[0]!.ids);
    assert.equal(f.store.hasFinal(run.id), false);
    assert.equal(f.store.hasOutput(run.logical_id), false);
    assert.equal(f.engine.active.get(f.session.id)!.tools.has('ongoing-research'), true);
    f.store.outbox(f.session.id, 'Current progress and judge assessment', {
      runId: run.id,
      final: true,
    });
    f.release();
    await settle(f.engine);
    assert.equal(f.status('progress?'), 'done');
    assert.equal(f.status('How is the new judge?'), 'done');
  });

test('post-final intake preserves earlier accepted input that has not started, including on restart', async (t) => {
  const f = await running(t);
  const run = f.store.get<any>('SELECT * FROM runs');
  f.enqueue('m2', 200);
  f.engine.tick();
  f.ack(['m2']);
  f.store.outbox(f.session.id, 'Answer to m1', { runId: run.id, final: true });
  f.enqueue('m3', 300);
  f.engine.tick();
  f.ack(['m3']);
  assert.equal(f.status('m1'), 'done');
  assert.equal(f.status('m2'), 'running');
  assert.equal(f.status('m3'), 'running');
  assert.deepEqual([...f.engine.active.get(f.session.id)!.unstartedInject], ['m2', 'm3']);
  // A crash must not drop either accepted follow-up or replay the old answer.
  const reopened = new Store(f.home);
  try {
    reopened.recover(3);
    assert.equal(reopened.get<any>("SELECT status FROM inbound WHERE id='m1'").status, 'done');
    assert.equal(reopened.get<any>("SELECT status FROM inbound WHERE id='m2'").status, 'queued');
    assert.equal(reopened.get<any>("SELECT status FROM inbound WHERE id='m3'").status, 'queued');
  } finally {
    reopened.close();
    f.release();
    await f.engine.stop();
  }
});

test('post-final rejected steering keeps the completed answer and queued input intact', async (t) => {
  const f = await running(t);
  const run = f.store.get<any>('SELECT * FROM runs');
  f.store.outbox(f.session.id, 'Done', { runId: run.id, final: true });
  f.request.onEvent({ type: 'usage', detail: {}, turnComplete: true, backgroundTasks: 1 });
  f.enqueue('m2', 200);
  f.engine.tick();
  f.ack(['m2'], false);
  assert.equal(f.store.hasFinal(run.id), true);
  assert.equal(f.store.replyScope(run.logical_id), run.logical_id);
  assert.equal(f.status('m2'), 'queued');
  f.release();
  await settle(f.engine);
});

test('a queued prompt starting after an older final unlocks related input before its result', async (t) => {
  const f = await running(t);
  try {
    const run = f.store.get<any>('SELECT * FROM runs');
    f.enqueue('m2', 200);
    f.engine.tick();
    f.ack(['m2']);
    f.enqueue('m3', 300);
    f.engine.tick();
    f.ack(['m3']);
    f.store.outbox(f.session.id, 'Answer to m1', { runId: run.id, final: true });
    const oldScope = f.store.replyScope(run.logical_id);
    f.request.onEvent({ type: 'input_started', detail: { ids: ['unknown'] } });
    assert.equal(f.store.replyScope(run.logical_id), oldScope);
    f.request.onEvent({ type: 'input_started', detail: { ids: ['m2', 'm2'] } });
    assert.equal(f.store.hasFinal(run.id), false);
    assert.equal(f.status('m1'), 'done');
    assert.equal(f.status('m2'), 'running');
    assert.equal(f.status('m3'), 'running', 'later accepted input must survive too');
    assert.equal(f.store.hasOutput(run.logical_id), false);
    f.request.onEvent({
      type: 'activity',
      detail: {},
      tool: { id: 'check', name: 'Bash', state: 'started' },
    });
    f.enqueue('m4', 400);
    f.enqueue('m5', 500);
    f.engine.tick();
    assert.deepEqual(f.injections.at(-1)!.ids, ['m4', 'm5']);
    f.ack(['m4', 'm5']);
    assert.equal(f.request.controller.signal.aborted, false);
    f.store.outbox(f.session.id, 'Combined answer', { runId: run.id, final: true });
    const scope = f.store.replyScope(run.logical_id);
    f.request.onEvent({ type: 'input_started', detail: { ids: ['m2'] } });
    assert.equal(f.store.replyScope(run.logical_id), scope, 'a duplicate cannot reopen the answer');
    assert.equal(f.store.hasFinal(run.id), true);
    f.release();
    await settle(f.engine);
  } finally {
    f.release();
    await f.engine.stop();
  }
});

test('consumed follow-up and later queued input survive restart after an older final', async (t) => {
  const f = await running(t);
  const run = f.store.get<any>('SELECT * FROM runs');
  f.enqueue('m2', 200);
  f.enqueue('m3', 300);
  f.engine.tick();
  f.ack(['m2', 'm3']);
  f.store.outbox(f.session.id, 'Old answer', { runId: run.id, final: true });
  f.request.onEvent({ type: 'input_started', detail: { ids: ['m2'] } });
  const restarted = new Store(f.home);
  try {
    restarted.recover(3);
    assert.equal(f.status('m1'), 'done');
    assert.equal(f.status('m2'), 'queued');
    assert.equal(f.status('m3'), 'queued');
    assert.equal(restarted.hasOutput(run.logical_id), false);
  } finally {
    restarted.close();
    f.release();
    await f.engine.stop();
  }
});

for (const limit of [1, 3])
  test(`post-final reply scope survives restart without replaying answered inputs (limit=${limit})`, (t) => {
    const f = fixture(t);
    f.enqueue('m1');
    const { run } = f.store.claim(f.session.id)!;
    f.store.outbox(f.session.id, 'First answer', { runId: run.id, final: true });
    f.enqueue('m2');
    f.store.transaction(() => {
      f.store.reopenReply(run, 'm2');
      f.store.exec("UPDATE inbound SET status='running',batch_id=? WHERE id='m2'", run.logical_id);
      f.store.exec(
        'UPDATE runs SET message_ids=? WHERE id=?',
        JSON.stringify(['m1', 'm2']),
        run.id,
      );
    });
    const restarted = new Store(f.home);
    try {
      assert.equal(restarted.hasOutput(run.logical_id), false);
      assert.equal(restarted.replyScope(run.logical_id), `${run.logical_id}:input:m2`);
      restarted.recover(limit);
      assert.equal(restarted.get<any>("SELECT status FROM inbound WHERE id='m1'").status, 'done');
      assert.equal(
        restarted.get<any>("SELECT interruptions FROM inbound WHERE id='m1'").interruptions,
        0,
      );
      assert.equal(
        restarted.get<any>("SELECT status FROM inbound WHERE id='m2'").status,
        limit === 1 ? 'failed' : 'queued',
      );
    } finally {
      restarted.close();
    }
  });

test('custom behavioral policy stays authoritative and answered inputs stay in history', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'AGENTS.md'), 'Custom identity');
  f.enqueue('m1');
  f.enqueue('m2');
  f.store.exec("UPDATE inbound SET status='done' WHERE id='m1'");
  const context = buildContext(
    f.store,
    f.session,
    f.config.accounts[0]!,
    f.store.all<any>('SELECT * FROM inbound'),
    32000,
  );
  assert.match(context.instructions, /Custom identity/);
  assert.doesNotMatch(context.instructions, /one short non-final send_message/);
  assert.match(context.instructions, /Clawstrum delivery protocol/);
  const current = context.prompt.slice(context.prompt.indexOf('Current input (JSON records):'));
  assert.doesNotMatch(current, /"id":"m1"/);
  assert.match(current, /"id":"m2"/);
});

for (const boundary of ['result', 'ongoing-tool'])
  test(
    `compiled Claude worker accepts a post-final request at ${boundary} while preserving its stream`,
    { timeout: 25000 },
    async (t) => {
      const f = fixture(t);
      f.config.research = researchSchema.parse({
        enabled: true,
        validation: 'off',
        workers: { minFreeMemoryMB: 0 },
      });
      const executable = path.join(f.home, 'held-turn.mjs');
      const record = path.join(f.config.accounts[0]!.home, 'held-inputs.json');
      fs.mkdirSync(f.config.accounts[0]!.home, { recursive: true });
      fs.writeFileSync(
        executable,
        `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('2.1.270');process.exit(0);}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let n=0;const uuids=[];
const result=text=>send({type:'result',subtype:'success',result:text,is_error:false,session_id:'native',uuid:text,user_message_uuids:uuids,duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{},modelUsage:{},permission_denials:[]});
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],models:[],account:null}}});
 if(m.type==='user'){
  n++;uuids.push(m.uuid);fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'held-inputs.json'),JSON.stringify({n,input:m.message.content}));
  if(n===1){
   send({type:'system',subtype:'init',session_id:'native',tools:[],mcp_servers:[],model:'test',permissionMode:'bypassPermissions',apiKeySource:'none',cwd:process.cwd(),uuid:'init'});
   send({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'bg',task_type:'local_bash',description:'long work'}],session_id:'native',uuid:'tasks'});
   if(${JSON.stringify(boundary)}==='result')result('First answer');
   else send({type:'assistant',session_id:'native',uuid:'working',parent_tool_use_id:null,message:{role:'assistant',content:[{type:'tool_use',id:'work',name:'Bash',input:{command:'long research'}}]}});
  }else{
   if(${JSON.stringify(boundary)}==='ongoing-tool')send({type:'user',session_id:'native',uuid:'tool-done',parent_tool_use_id:null,message:{role:'user',content:[{type:'tool_result',tool_use_id:'work',content:'Research continues'}]}});
   send({type:'system',subtype:'background_tasks_changed',tasks:[],session_id:'native',uuid:'done'});
   result('Second answer');
  }
 }
}`,
        { mode: 0o700 },
      );
      f.config.accounts[0]!.executable = executable;
      const { Engine: CompiledEngine } = await import('../dist/engine.js' as string);
      const engine: Engine = new CompiledEngine(f.config, f.store);
      try {
        f.enqueue('first');
        engine.tick();
        await until(() =>
          boundary === 'result'
            ? engine.active.get(f.session.id)?.atResultBoundary === true
            : engine.active.get(f.session.id)?.tools.has('work') === true,
        );
        const state = engine.active.get(f.session.id)!;
        assert.equal(state.backgroundTasks, 1);
        f.store.outbox(f.session.id, 'First answer', { runId: state.runId, final: true });
        f.enqueue('second');
        engine.tick();
        await until(() => engine.active.size === 0);
        assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).n, 2);
        assert.equal(
          f.store.get<any>("SELECT status FROM inbound WHERE id='second'").status,
          'done',
        );
        assert.deepEqual(
          f.store.all<any>('SELECT content FROM outbox ORDER BY rowid').map((r) => r.content),
          ['First answer', 'Second answer'],
        );
        assert.equal(f.store.all('SELECT * FROM runs').length, 1);
      } finally {
        await engine.stop();
      }
    },
  );

test('an empty response to post-result steering cannot reuse the preceding answer', async (t) => {
  const f = fixture(t);
  let inject!: (ids: string[], text: string) => boolean;
  const query = ((params: any) =>
    Object.assign(
      (async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        await input.next();
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg' }] };
        yield { type: 'result', subtype: 'success', result: 'Old answer', usage: {} };
        assert.equal(inject(['new'], 'New request'), true);
        await input.next();
        yield { type: 'result', subtype: 'success', result: '', usage: {} };
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
        assert.equal((await input.next()).done, true);
      })(),
      { close() {} },
    )) as any;
  const result = await createClaudeProvider(query).run({
    account: f.config.accounts[0]!,
    cwd: f.home,
    prompt: 'old',
    instructions: '',
    env: {},
    controller: new AbortController(),
    research: researchSchema.parse({
      enabled: true,
      validation: 'off',
      workers: { minFreeMemoryMB: 0 },
    }),
    inputReleaseGraceMs: 0,
    mcp: { command: 'node', args: [], env: {} },
    attachInjector: (fn) => {
      inject = fn;
    },
    onEvent() {},
  });
  assert.equal(result, '');
});

for (const boundary of ['frame', 'hook'])
  test(
    `compiled Claude ${boundary} consumption reopens an older final before batching more related questions`,
    { timeout: 25000 },
    async (t) => {
      const f = fixture(t);
      const executable = path.join(f.home, 'consumed-turn.mjs');
      const profile = f.config.accounts[0]!.home;
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(
        executable,
        `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('2.1.270');process.exit(0);}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');const inputs=[];const home=process.env.CLAUDE_CONFIG_DIR;let hooks;
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.type==='control_request'){hooks=m.request.hooks??hooks;send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],models:[],account:null}}});}
 if(m.type==='user'){
  inputs.push(m);fs.writeFileSync(path.join(home,'inputs.json'),JSON.stringify(inputs));
  if(inputs.length===1)send({type:'system',subtype:'init',session_id:'native',tools:[],mcp_servers:[],model:'test',permissionMode:'bypassPermissions',apiKeySource:'none',cwd:process.cwd(),uuid:'init'});
  if(inputs.length===2){
   const timer=setInterval(()=>{if(!fs.existsSync(path.join(home,'old-final')))return;clearInterval(timer);
    if(${JSON.stringify(boundary)}==='hook')send({type:'control_request',request_id:'consume',request:{subtype:'hook_callback',callback_id:hooks.UserPromptSubmit[0].hookCallbackIds[0],input:{hook_event_name:'UserPromptSubmit',session_id:'native',cwd:process.cwd(),transcript_path:'',source:'sdk',prompt:m.message.content}}});
    else send({type:'assistant',uuid:'started',session_id:'native',parent_tool_use_id:null,user_message_uuids:[m.uuid],message:{role:'assistant',content:[{type:'text',text:'Checking the related evidence'}]}});
   },10);
  }
  if(inputs.length===3)send({type:'result',subtype:'success',result:'Combined answer to all related questions',is_error:false,session_id:'native',uuid:'done',user_message_uuids:inputs.map(i=>i.uuid),duration_ms:1,duration_api_ms:1,num_turns:3,total_cost_usd:0,usage:{},modelUsage:{},permission_denials:[]});
 }
}`,
        { mode: 0o700 },
      );
      f.config.accounts[0]!.executable = executable;
      const { Engine: CompiledEngine } = await import('../dist/engine.js' as string);
      const engine: Engine = new CompiledEngine(f.config, f.store);
      try {
        f.enqueue('first');
        engine.tick();
        await until(() => engine.active.get(f.session.id)?.ready === true);
        f.enqueue('followup');
        engine.tick();
        await until(
          () =>
            f.store.get<any>("SELECT status FROM inbound WHERE id='followup'").status === 'running',
        );
        const run = f.store.get<any>('SELECT * FROM runs');
        f.store.outbox(f.session.id, 'Answer to the earlier question', {
          runId: run.id,
          final: true,
        });
        fs.writeFileSync(path.join(profile, 'old-final'), 'sent');
        await until(() => !!f.store.get("SELECT seq FROM events WHERE type='input_started'"));
        assert.equal(f.store.hasFinal(run.id), false);
        f.enqueue('tapestry');
        f.enqueue('story');
        engine.tick();
        await until(() => engine.active.size === 0);
        const inputs = JSON.parse(fs.readFileSync(path.join(profile, 'inputs.json'), 'utf8'));
        assert.equal(inputs.length, 3);
        assert.match(inputs[2].message.content, /"id":"tapestry"/);
        assert.match(inputs[2].message.content, /"id":"story"/);
        assert.equal(f.store.all('SELECT * FROM runs').length, 1);
        assert.deepEqual(
          f.store.all<any>('SELECT content FROM outbox ORDER BY rowid').map((r) => r.content),
          ['Answer to the earlier question', 'Combined answer to all related questions'],
        );
        assert.equal(f.store.all("SELECT id FROM inbound WHERE status!='done'").length, 0);
      } finally {
        await engine.stop();
      }
    },
  );

for (const provider of ['claude', 'codex'] as const)
  for (const answered of [true, false])
    test(`${provider} recovers a quiet background turn with queued input (answered=${answered})`, async (t) => {
      const f = fixture(t);
      f.config.runtime.turnTimeoutMs = 0;
      f.config.runtime.silenceTimeoutMs = 600000;
      f.config.runtime.queuedInputTimeoutMs = 120000;
      f.config.runtime.consolidation.enabled = false;
      f.config.runtime.memoryReview.enabled = false;
      if (provider === 'codex')
        f.store.exec('UPDATE sessions SET preferred_account=? WHERE id=?', 'b', f.session.id);
      const requests: ProviderRequest[] = [];
      const live: Provider = {
        async run(r) {
          requests.push(r);
          r.onEvent({ type: 'session', sessionId: 'preserved-native' });
          r.onEvent({ type: 'ready', backgroundTasks: 1 });
          if (requests.length > 1) return 'Handled follow-up';
          r.attachInjector!(() => false);
          if (answered) {
            const run = f.store.get<any>("SELECT id FROM runs WHERE status='running'")!;
            f.store.outbox(f.session.id, 'Old answer', { runId: run.id, final: true });
          }
          return await new Promise<string>((_, reject) =>
            r.controller.signal.addEventListener(
              'abort',
              () => reject(r.controller.signal.reason),
              { once: true },
            ),
          );
        },
      };
      const engine = new Engine(f.config, f.store, { claude: live, codex: live });
      try {
        f.enqueue('old');
        engine.tick();
        await until(() => requests.length === 1);
        const now = Date.now();
        f.enqueue('follow-up', now);
        engine.tick(now);
        assert.equal(requests[0]!.controller.signal.aborted, false);
        assert.equal(engine.performanceSnapshot().active[0]!.injectable, false);
        assert.equal(
          f.store.all("SELECT * FROM events WHERE type='live_input_rejected'").length,
          1,
        );
        engine.tick(now + 120001);
        await settle(engine);
        assert.equal(requests[0]!.controller.signal.aborted, true);
        assert.equal(
          f.store.get<any>("SELECT status FROM inbound WHERE id='old'").status,
          answered ? 'done' : 'queued',
        );
        assert.equal(f.store.session(f.session.id).remote_id, 'preserved-native');
        assert.equal(
          f.store.all("SELECT * FROM events WHERE type='queued_input_handoff'").length,
          1,
        );
        engine.tick();
        await settle(engine);
        // An unfinished earlier batch is resumed before the still-queued follow-up.
        engine.tick();
        await settle(engine);
        assert.equal(
          f.store.get<any>("SELECT status FROM inbound WHERE id='follow-up'").status,
          'done',
        );
        assert.equal(requests[1]!.sessionId, 'preserved-native');
        if (answered) assert.equal(requests.length, 2, 'completed request is not replayed');
        assert.equal(
          f.store.all("SELECT * FROM outbox WHERE content LIKE '%cancelled%'").length,
          0,
        );
      } finally {
        await engine.stop();
      }
    });

for (const condition of ['no-user', 'active', 'tool', 'disabled', 'accepted'] as const)
  test(`queued recovery preserves a ${condition} turn`, async (t) => {
    const f = await running(t);
    try {
      const state = f.engine.active.get(f.session.id)!;
      const now = Date.now() + 120001;
      state.backgroundTasks = 1;
      if (condition !== 'no-user') f.enqueue('m2', now - 120001);
      if (condition === 'active') state.lastActivity = now;
      if (condition === 'tool') state.tools.set('tool', 'Bash');
      if (condition === 'disabled') f.config.runtime.queuedInputTimeoutMs = 0;
      if (condition === 'accepted') {
        f.engine.tick();
        f.ack(['m2']);
      }
      f.engine.tick(now);
      assert.equal(f.request.controller.signal.aborted, false);
      f.release();
      await settle(f.engine);
    } finally {
      f.release();
      await f.engine.stop();
    }
  });

for (const boundary of [true, false])
  test(`queued task wake ${boundary ? 'hands off' : 'waits for'} a background-held turn (result boundary=${boundary})`, async (t) => {
    const f = await running(t);
    try {
      const state = f.engine.active.get(f.session.id)!;
      const now = Date.now() + 120001;
      state.backgroundTasks = 1;
      state.atResultBoundary = boundary;
      f.enqueue('watch', now - 120001);
      f.store.exec("UPDATE inbound SET kind='task' WHERE id='watch'");
      f.engine.tick(now);
      assert.equal(f.request.controller.signal.aborted, boundary);
      assert.equal(
        f.store.all("SELECT * FROM events WHERE type='queued_input_handoff'").length,
        boundary ? 1 : 0,
      );
      f.release();
      await settle(f.engine);
    } finally {
      f.release();
      await f.engine.stop();
    }
  });

for (const ending of ['provider error', 'shutdown', 'crash', 'cancel'] as const)
  test(`input accepted before an unrelated final is preserved or explicitly cancelled after ${ending}`, async (t) => {
    const f = await running(t);
    try {
      const run = f.store.get<any>('SELECT * FROM runs');
      f.enqueue('m2', 200);
      f.engine.tick();
      f.ack(['m2']);
      assert.equal(f.status('m2'), 'running');
      f.store.outbox(f.session.id, 'Answer to m1', { runId: run.id, final: true });
      assert.equal(f.store.hasFinal(run.id), true);
      if (ending === 'provider error') {
        f.release(new Error('stream reset'));
        await settle(f.engine);
      } else if (ending === 'shutdown') {
        await f.engine.stop();
      } else if (ending === 'cancel') {
        f.store.exec(
          "INSERT INTO controls(session_id,command,argument,created_at) VALUES(?,'cancel',NULL,?)",
          f.session.id,
          Date.now(),
        );
        f.engine.tick();
        await settle(f.engine);
      } else {
        const restarted = new Store(f.home);
        try {
          restarted.recover(3);
        } finally {
          restarted.close();
        }
      }
      assert.equal(f.status('m1'), 'done');
      assert.equal(f.status('m2'), ending === 'cancel' ? 'cancelled' : 'queued');
      if (ending !== 'cancel')
        assert.equal(f.store.get<any>("SELECT batch_id FROM inbound WHERE id='m2'").batch_id, null);
      assert.equal(
        f.store.get('SELECT value FROM metadata WHERE key=?', `unstarted:${run.id}`),
        undefined,
      );
    } finally {
      f.release();
      await f.engine.stop();
    }
  });

test('stop cancels queued user messages but keeps queued task wakes', async (t) => {
  const f = fixture(t);
  f.enqueue('user', 100);
  f.enqueue('wake', 100);
  f.store.exec("UPDATE inbound SET kind='task',available_at=? WHERE id='wake'", Date.now() + 60000);
  f.store.exec("UPDATE inbound SET available_at=? WHERE id='user'", Date.now() + 60000);
  f.store.exec(
    "INSERT INTO controls(session_id,command,argument,created_at) VALUES(?,'cancel',NULL,?)",
    f.session.id,
    Date.now(),
  );
  const engine = new Engine(f.config, f.store, { claude: ok, codex: ok });
  try {
    engine.tick();
    const status = (id: string) =>
      f.store.get<any>('SELECT status FROM inbound WHERE id=?', id).status;
    assert.equal(status('user'), 'cancelled');
    assert.equal(status('wake'), 'queued');
  } finally {
    await engine.stop();
  }
});

test('unsent result text reaches the outbox before injected input replaces it', async (t) => {
  const f = fixture(t);
  f.config.research = researchSchema.parse({
    enabled: true,
    validation: 'off',
    workers: { minFreeMemoryMB: 0 },
  });
  let finished = false;
  const query = ((params: any) =>
    Object.assign(
      (async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        await input.next();
        yield { type: 'system', subtype: 'init', session_id: 'native' };
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg' }] };
        yield { type: 'result', subtype: 'success', result: 'Answer to A', usage: {} };
        const next = await input.next();
        const uuid = next.value.uuid;
        yield {
          type: 'assistant',
          session_id: 'native',
          parent_tool_use_id: null,
          user_message_uuids: [uuid],
          message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at B' }] },
        };
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Answer to B',
          user_message_uuids: [uuid],
          usage: {},
        };
        finished = (await input.next()).done === true;
      })(),
      { close() {} },
    )) as any;
  const engine = new Engine(f.config, f.store, { claude: createClaudeProvider(query), codex: ok });
  try {
    f.enqueue('A', 100);
    engine.tick();
    await until(() => engine.active.get(f.session.id)?.atResultBoundary === true);
    f.enqueue('B', 200);
    engine.tick();
    assert.deepEqual(
      f.store.all<any>('SELECT content FROM outbox ORDER BY rowid').map((r) => r.content),
      ['Answer to A'],
    );
    const status = (id: string) =>
      f.store.get<any>('SELECT status FROM inbound WHERE id=?', id).status;
    assert.equal(status('A'), 'done');
    assert.equal(status('B'), 'running', 'accepted input is not answered by the earlier result');
    await settle(engine);
    assert.equal(finished, true);
    assert.deepEqual(
      f.store.all<any>('SELECT content FROM outbox ORDER BY rowid').map((r) => r.content),
      ['Answer to A', 'Answer to B'],
    );
    assert.equal(status('B'), 'done');
    assert.equal(f.store.all('SELECT * FROM runs').length, 1);
  } finally {
    await engine.stop();
  }
});

test('a later CLI-started result does not overwrite unsent result text', async (t) => {
  const f = fixture(t);
  f.config.research = researchSchema.parse({
    enabled: true,
    validation: 'off',
    workers: { minFreeMemoryMB: 0 },
  });
  const query = ((params: any) =>
    Object.assign(
      (async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        await input.next();
        yield { type: 'system', subtype: 'init', session_id: 'native' };
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg' }] };
        yield { type: 'result', subtype: 'success', result: 'Answer to A', usage: {} };
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
        yield { type: 'result', subtype: 'success', result: 'Background task finished', usage: {} };
      })(),
      { close() {} },
    )) as any;
  const engine = new Engine(f.config, f.store, { claude: createClaudeProvider(query), codex: ok });
  try {
    f.enqueue('A', 100);
    engine.tick();
    await settle(engine);
    assert.equal(
      f.store.get<any>('SELECT content FROM outbox ORDER BY rowid LIMIT 1')?.content,
      'Answer to A',
    );
    assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='A'").status, 'done');
    assert.deepEqual(
      f.store.all<any>('SELECT content FROM outbox ORDER BY rowid').map((r) => r.content),
      ['Answer to A', 'Background task finished'],
    );
  } finally {
    await engine.stop();
  }
});

test('a quiet later result does not force a correction after unsent result text', async (t) => {
  const f = fixture(t);
  f.config.research = researchSchema.parse({
    enabled: true,
    validation: 'off',
    workers: { minFreeMemoryMB: 0 },
  });
  const query = ((params: any) =>
    Object.assign(
      (async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        await input.next();
        yield { type: 'system', subtype: 'init', session_id: 'native' };
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg' }] };
        yield { type: 'result', subtype: 'success', result: 'Answer to A', usage: {} };
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
        yield { type: 'result', subtype: 'success', result: 'CLAWSTRUM_QUIET', usage: {} };
      })(),
      { close() {} },
    )) as any;
  const engine = new Engine(f.config, f.store, { claude: createClaudeProvider(query), codex: ok });
  try {
    f.enqueue('A', 100);
    engine.tick();
    await settle(engine);
    assert.deepEqual(
      f.store.all<any>('SELECT content FROM outbox ORDER BY rowid').map((r) => r.content),
      ['Answer to A'],
    );
    assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='A'").status, 'done');
    assert.equal(f.store.all("SELECT * FROM events WHERE type='quiet_without_answer'").length, 0);
    assert.equal(f.store.all('SELECT * FROM runs').length, 1);
  } finally {
    await engine.stop();
  }
});

test('a quiet answer to another bot is accepted without a correction', async (t) => {
  const f = fixture(t);
  const query = ((params: any) =>
    Object.assign(
      (async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        await input.next();
        yield { type: 'system', subtype: 'init', session_id: 'native' };
        yield { type: 'result', subtype: 'success', result: 'CLAWSTRUM_QUIET', usage: {} };
      })(),
      { close() {} },
    )) as any;
  const engine = new Engine(f.config, f.store, { claude: createClaudeProvider(query), codex: ok });
  try {
    f.enqueue('B', 100);
    f.store.exec("INSERT INTO metadata(key,value) VALUES('bot-input:B','1')");
    engine.tick();
    await settle(engine);
    assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
    assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='B'").status, 'done');
    assert.equal(f.store.all("SELECT * FROM events WHERE type='quiet_without_answer'").length, 0);
    assert.equal(f.store.all('SELECT * FROM runs').length, 1);
  } finally {
    await engine.stop();
  }
});

for (const [name, result, delivered] of [
  ['a short reply next to the quiet marker', 'Status sent two minutes ago.\n\nCLAWSTRUM_QUIET', []],
  ['a status-already-sent reply', 'The ETA I gave was 14:00 (sent 12:18), not yet passed.', []],
  [
    'a why-this-fired reply',
    "The sweeper is stopped on purpose for the redo. That's why this fired.",
    [],
  ],
  [
    'a no-update-needed reply',
    "I gave no start time for 12345678, so no slip update is needed. It's still pending.",
    [],
  ],
  [
    'a real short status',
    'Branch copies: 727 of 800 cycles done.',
    ['Branch copies: 727 of 800 cycles done.'],
  ],
] as const)
  test(`scheduled wake: ${name}`, async (t) => {
    const f = fixture(t);
    const query = ((params: any) =>
      Object.assign(
        (async function* () {
          const input = params.prompt[Symbol.asyncIterator]();
          await input.next();
          yield { type: 'system', subtype: 'init', session_id: 'native' };
          yield { type: 'result', subtype: 'success', result, usage: {} };
        })(),
        { close() {} },
      )) as any;
    const engine = new Engine(f.config, f.store, {
      claude: createClaudeProvider(query),
      codex: ok,
    });
    try {
      f.store.enqueue({
        id: 'T',
        sessionId: f.session.id,
        author: 'Clawstrum scheduler',
        content: 'Hourly status',
        kind: 'task',
        at: 100,
      });
      engine.tick();
      await settle(engine);
      assert.deepEqual(
        f.store.all<any>('SELECT content FROM outbox ORDER BY rowid').map((r) => r.content),
        delivered,
      );
      assert.equal(
        f.store.all("SELECT * FROM events WHERE type='wake_echo_suppressed'").length,
        delivered.length ? 0 : 1,
      );
    } finally {
      await engine.stop();
    }
  });

test('a quiet answer to a wake batched with bot messages is accepted', async (t) => {
  const f = fixture(t);
  const query = ((params: any) =>
    Object.assign(
      (async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        await input.next();
        yield { type: 'system', subtype: 'init', session_id: 'native' };
        yield { type: 'result', subtype: 'success', result: 'CLAWSTRUM_QUIET', usage: {} };
      })(),
      { close() {} },
    )) as any;
  const engine = new Engine(f.config, f.store, { claude: createClaudeProvider(query), codex: ok });
  try {
    f.store.enqueue({
      id: 'W',
      sessionId: f.session.id,
      author: 'Clawstrum watcher',
      content: 'done',
      kind: 'task',
      at: 100,
    });
    f.enqueue('B', 100);
    f.store.exec("INSERT INTO metadata(key,value) VALUES('bot-input:B','1')");
    engine.tick();
    await settle(engine);
    assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
    assert.equal(f.store.all("SELECT * FROM events WHERE type='quiet_without_answer'").length, 0);
  } finally {
    await engine.stop();
  }
});

test('the earlier turn closing text after steering does not take the new answer final key', async (t) => {
  // A watch turn sent its answer with final=true,
  // the user's question was steered in (reopening the reply), then the watch turn's closing text
  // was flushed as final under the new scope and the real answer failed with a key conflict.
  const f = await running(t);
  const run = f.store.get<any>('SELECT * FROM runs');
  f.store.outbox(f.session.id, 'Figure sent', { runId: run.id, final: true });
  f.enqueue('m2', 200);
  f.engine.tick();
  f.ack(f.injections[0]!.ids);
  f.request.onEvent({
    type: 'result_text',
    detail: { text: 'Wrap-up of the earlier turn', final: true },
  });
  f.request.onEvent({ type: 'input_started', detail: { ids: ['m2'] } });
  f.request.onEvent({ type: 'result_text', detail: { text: 'Answer to m2', final: true } });
  f.release();
  await settle(f.engine);
  const sent = f.store.all<any>('SELECT content FROM outbox ORDER BY rowid').map((r) => r.content);
  assert.ok(sent.includes('Answer to m2'), JSON.stringify(sent));
  assert.ok(!sent.includes('Wrap-up of the earlier turn'), JSON.stringify(sent));
  assert.equal(f.store.get<any>('SELECT status FROM runs').status, 'done');
});

test('a channel limited to one provider waits for it instead of falling back', async (t) => {
  const f = fixture(t);
  const used: string[] = [];
  const provider = (name: string): Provider => ({
    async run() {
      used.push(name);
      return `answer from ${name}`;
    },
  });
  f.store.exec('UPDATE sessions SET preferred_account=? WHERE id=?', 'b', f.session.id);
  f.store.exec(
    "INSERT INTO metadata(key,value) VALUES(?, 'codex')",
    `provider-only:${f.session.id}`,
  );
  const engine = new Engine(f.config, f.store, {
    claude: provider('claude'),
    codex: provider('codex'),
  });
  try {
    engine.pool.fail(engine.pool.accounts.find((a) => a.id === 'b')!, {
      kind: 'quota',
      retryAt: Date.now() + 60_000,
    } as any);
    f.enqueue('m1', 100);
    engine.tick();
    await settle(engine);
    assert.deepEqual(used, [], 'claude was not used while codex is out of quota');
    assert.equal(
      f.store.all('SELECT * FROM outbox').filter((r: any) => /answer from/.test(r.content)).length,
      0,
    );
    assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='m1'").status, 'queued');
    const notices = f.store
      .all<any>('SELECT content FROM outbox')
      .map((r) => r.content)
      .filter((c: string) => /queued/.test(c));
    assert.ok(notices.length > 0, 'a capacity notice was sent');
    for (const c of notices) {
      assert.match(c, /limited to codex accounts \(b\)/);
      assert.doesNotMatch(c, /All configured accounts/);
    }
  } finally {
    await engine.stop();
  }
});
