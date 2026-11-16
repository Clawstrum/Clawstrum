import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  codexProvider,
  PROVIDER_TOOL_REFUSAL,
  providerToolRefusal,
  toolResultErrorText,
} from '../src/providers.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { configSchema } from '../src/config.js';
import type { Provider, ProviderEvent } from '../src/types.js';

test('CLI entrypoint executes through an npm-style bin symlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-bin-'));
  try {
    const bin = path.join(dir, 'clawstrum');
    fs.symlinkSync(path.resolve('src/cli.ts'), bin);
    const result = spawnSync(process.execPath, ['--import', 'tsx', bin, '--version'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '0.1.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repeated abrupt service crashes stop replaying input at the configured attempt bound', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-crash-cap-'));
  const store = new Store(home);
  try {
    const session = store.ensureSession('channel');
    store.enqueue({ id: 'm', sessionId: session.id, author: 'owner', content: 'Work' });
    for (let i = 0; i < 3; i++) {
      assert.ok(store.claim(session.id));
      store.recover(3);
    }
    assert.equal(store.get<any>('SELECT status FROM inbound').status, 'failed');
    assert.equal(store.claim(session.id), undefined);
    assert.equal(store.pendingOutbox().length, 1);
  } finally {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('installed Codex SDK drives a real subprocess with full access, resume and the selected account environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-sdk-'));
  try {
    const fake = path.join(dir, 'codex');
    const record = path.join(dir, 'invocation.json');
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env node
import fs from 'node:fs';
let prompt=''; for await(const chunk of process.stdin) prompt+=chunk;
fs.writeFileSync(process.env.RECORD, JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,prompt}));
for(const event of [
  {type:'thread.started',thread_id:'thread-123'}, {type:'turn.started'},
  {type:'item.completed',item:{id:'message-1',type:'agent_message',text:'CLAWSTRUM_OK'}},
  {type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}}
]) process.stdout.write(JSON.stringify(event)+'\\n');
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    const events: string[] = [];
    const request = {
      account: { id: 'test', provider: 'codex' as const, home: dir, executable: fake },
      prompt: 'Test input',
      instructions: 'Clawstrum instructions',
      cwd: dir,
      controller: new AbortController(),
      env: { PATH: process.env.PATH!, CODEX_HOME: dir, RECORD: record },
      mcp: { command: process.execPath, args: ['fake-mcp.js'], env: { CLAWSTRUM_SESSION: 'test' } },
      onEvent: (event: { type: string }) => events.push(event.type),
    };
    assert.equal(await codexProvider.run(request), 'CLAWSTRUM_OK');
    let call = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.equal(call.home, dir);
    assert.equal(call.prompt.trim(), 'Test input');
    assert.ok(call.args.includes('danger-full-access'));
    assert.match(call.args.join(' '), /approval_policy="never"/);
    assert.match(call.args.join(' '), /forced_login_method="chatgpt"/);
    assert.match(call.args.join(' '), /mcp_servers.clawstrum/);
    assert.ok(events.includes('session'));
    assert.ok(events.includes('usage'));
    await codexProvider.run({ ...request, sessionId: 'thread-123' });
    call = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.ok(call.args.includes('resume'));
    assert.ok(call.args.includes('thread-123'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('crash after durable final output does not replay completed model work', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-recovery-'));
  const store = new Store(home);
  try {
    const session = store.ensureSession('channel');
    store.enqueue({ id: 'm', sessionId: session.id, author: 'owner', content: 'Run once' });
    const run = store.claim(session.id)!.run;
    store.outbox(session.id, 'Final answer', { runId: run.id, final: true });
    assert.equal(store.recover(), 0);
    assert.equal(store.get<any>('SELECT status FROM inbound').status, 'done');
    assert.equal(store.pendingOutbox().length, 1);
    assert.equal(store.claim(session.id), undefined);
  } finally {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test('startup watchdog retries a silent provider only up to the persisted attempt limit', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-watchdog-'));
  const store = new Store(home);
  let engine: Engine | undefined;
  try {
    const config = configSchema.parse({
      version: 1,
      discord: { ownerIds: ['123456'] },
      accounts: [{ id: 'a', provider: 'claude', home: path.join(home, 'a') }],
      runtime: {
        debounceMs: 0,
        debounceMaxMs: 0,
        startupTimeoutMs: 100,
        maxAttempts: 2,
        slowRetryMs: 0,
      },
    });
    let calls = 0;
    const silent: Provider = {
      async run(r) {
        calls++;
        return new Promise<string>((_, reject) =>
          r.controller.signal.addEventListener('abort', () => reject(r.controller.signal.reason), {
            once: true,
          }),
        );
      },
    };
    engine = new Engine(config, store, { claude: silent, codex: silent });
    const session = store.ensureSession('channel');
    store.enqueue({ id: 'm', sessionId: session.id, author: 'owner', content: 'Work' });
    for (let i = 0; i < 2; i++) {
      store.exec('UPDATE inbound SET available_at=0');
      engine.tick();
      await Promise.resolve();
      await Promise.resolve();
      engine.tick(Date.now() + 1000);
      await Promise.all([...engine.active.values()].map((s) => s.promise));
    }
    assert.equal(calls, 2);
    assert.equal(store.get<any>('SELECT status FROM inbound').status, 'failed');
    engine.tick(Date.now() + 1e6);
    assert.equal(engine.active.size, 0);
  } finally {
    await engine?.stop();
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
for (const absolute of [false, true])
  test(`background waits suspend silence but retain the absolute deadline (absolute=${absolute})`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-silence-'));
    const store = new Store(home);
    try {
      const config = configSchema.parse({
        version: 1,
        discord: { ownerIds: ['123456'] },
        accounts: [{ id: 'a', provider: 'claude', home: path.join(home, 'a') }],
        runtime: { debounceMs: 0, debounceMaxMs: 0, silenceTimeoutMs: 1000 },
      });
      let emit!: (event: ProviderEvent) => void;
      const waiting: Provider = {
        async run(r) {
          emit = r.onEvent;
          r.onEvent({ type: 'ready' });
          r.onEvent({
            type: 'activity',
            detail: { type: 'system', subtype: 'task_started' },
            backgroundTasks: 1,
          });
          return new Promise<string>((_, reject) =>
            r.controller.signal.addEventListener(
              'abort',
              () => reject(r.controller.signal.reason),
              {
                once: true,
              },
            ),
          );
        },
      };
      const engine = new Engine(config, store, { claude: waiting, codex: waiting });
      const session = store.ensureSession('channel');
      store.enqueue({ id: 'm', sessionId: session.id, author: 'owner', content: 'Upload it' });
      engine.tick();
      await Promise.resolve();
      await Promise.resolve();
      const state = engine.active.get(session.id)!;
      assert.ok(state, 'turn should be active');
      engine.tick(Date.now() + 600000);
      assert.equal(state.controller.signal.aborted, false);
      if (absolute) engine.tick(state.turnStarted + config.runtime.turnTimeoutMs + 1);
      else {
        emit({
          type: 'activity',
          detail: { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
          backgroundTasks: 0,
        });
        engine.tick(Date.now() + 600000);
      }
      assert.equal(state.controller.signal.aborted, true);
      assert.match(
        String(state.controller.signal.reason?.message),
        absolute ? /Absolute turn timeout/ : /silence timeout/,
      );
      await state.promise;
    } finally {
      store.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
test('new messages arriving during work wait for the same conversation to finish and are not lost', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-queue-'));
  const store = new Store(home);
  try {
    const config = configSchema.parse({
      version: 1,
      discord: { ownerIds: ['123456'] },
      accounts: [{ id: 'a', provider: 'claude', home: path.join(home, 'a') }],
      runtime: { debounceMs: 0, debounceMaxMs: 0 },
    });
    let finish: (text: string) => void = () => {};
    let calls = 0;
    const provider: Provider = {
      async run() {
        calls++;
        return calls === 1
          ? new Promise<string>((resolve) => {
              finish = resolve;
            })
          : 'Follow-up done';
      },
    };
    const engine = new Engine(config, store, { claude: provider, codex: provider });
    const s = store.ensureSession('channel');
    store.enqueue({ id: 'one', sessionId: s.id, author: 'owner', content: 'First' });
    engine.tick();
    await Promise.resolve();
    await Promise.resolve();
    store.enqueue({ id: 'two', sessionId: s.id, author: 'owner', content: 'Correction' });
    engine.tick();
    assert.equal(calls, 1);
    finish('First done');
    await Promise.all([...engine.active.values()].map((s) => s.promise));
    engine.tick();
    await Promise.all([...engine.active.values()].map((s) => s.promise));
    assert.equal(calls, 2);
    assert.equal(store.get<any>("SELECT count(*) n FROM inbound WHERE status='done'").n, 2);
  } finally {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test('providerToolRefusal recognizes the generic CLI refusal without treating other errors as refusals', () => {
  assert.equal(
    providerToolRefusal({ type: 'tool_result', is_error: true, content: PROVIDER_TOOL_REFUSAL }),
    true,
  );
  assert.equal(
    providerToolRefusal({
      type: 'tool_result',
      is_error: true,
      content: [{ type: 'text', text: `${PROVIDER_TOOL_REFUSAL} extra` }],
    }),
    true,
  );
  assert.equal(
    providerToolRefusal({ type: 'tool_result', is_error: false, content: PROVIDER_TOOL_REFUSAL }),
    false,
  );
  assert.equal(
    providerToolRefusal({ type: 'tool_result', is_error: true, content: 'command not found' }),
    false,
  );
  assert.equal(providerToolRefusal({ type: 'tool_use', name: 'Bash' }), false);
  assert.equal(providerToolRefusal(undefined), false);
  // The text itself is kept, including any suffix, so a refusal can be diagnosed later.
  assert.equal(
    toolResultErrorText({
      type: 'tool_result',
      is_error: true,
      content: [{ type: 'text', text: `${PROVIDER_TOOL_REFUSAL} extra` }],
    }),
    `${PROVIDER_TOOL_REFUSAL} extra`,
  );
  assert.equal(
    toolResultErrorText({ type: 'tool_result', is_error: false, content: 'fine' }),
    undefined,
  );
});
test('a generic CLI refusal queues only one bounded recovery attempt', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-denial-'));
  const store = new Store(home);
  try {
    const config = configSchema.parse({
      version: 1,
      discord: { ownerIds: ['123456'] },
      accounts: [{ id: 'a', provider: 'claude', home: path.join(home, 'a') }],
      runtime: { debounceMs: 0, debounceMaxMs: 0 },
    });
    const denying: Provider = {
      async run(r) {
        r.onEvent({ type: 'ready' });
        for (const [id, name] of [
          ['t1', 'Bash'],
          ['t2', 'Read'],
        ]) {
          r.onEvent({
            type: 'activity',
            detail: { type: 'tool_use', id, name },
            tool: { id, state: 'started', name },
          });
          r.onEvent({
            type: 'activity',
            detail: {
              type: 'tool_result',
              tool_use_id: id,
              is_error: true,
              content: PROVIDER_TOOL_REFUSAL,
            },
            tool: { id, state: 'completed' },
          });
        }
        return 'Stopping, my tool calls were refused.';
      },
    };
    const engine = new Engine(config, store, { claude: denying, codex: denying });
    const session = store.ensureSession('channel');
    store.enqueue({ id: 'm', sessionId: session.id, author: 'owner', content: 'Read the log' });
    const drain = async () => {
      store.exec('UPDATE inbound SET available_at=0');
      engine.tick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.all([...engine.active.values()].map((s) => s.promise));
    };
    await drain();
    const first = store.get<{ id: string }>("SELECT id FROM runs WHERE status='done'")!;
    const follow = store.get<{ id: string; kind: string; content: string }>(
      'SELECT id,kind,content FROM inbound WHERE id LIKE ?',
      'denial-recovery:%',
    )!;
    assert.equal(follow.id, `denial-recovery:${first.id}`);
    assert.equal(follow.kind, 'task');
    assert.match(follow.content, /2 tool calls in the previous turn \(Bash, Read\) returned/);
    assert.match(follow.content, /CLAWSTRUM_QUIET/);
    assert.equal(
      store.get<{ n: number }>("SELECT COUNT(*) n FROM events WHERE type='denial_recovery'")!.n,
      1,
    );
    // Each refusal names its own tool and keeps the provider's text, so the next occurrence
    // can be diagnosed instead of counted.
    const refusals = store.all<{ content: string }>(
      "SELECT content FROM events WHERE type='tool_refusal' ORDER BY seq",
    );
    assert.equal(refusals.length, 2);
    assert.deepEqual(
      refusals.map((r) => JSON.parse(r.content).tool),
      ['Bash', 'Read'],
    );
    assert.equal(JSON.parse(refusals[0].content).text, PROVIDER_TOOL_REFUSAL);
    // The recovery run is refused the same way, and must not queue a second recovery.
    await drain();
    assert.equal(
      store.get<{ n: number }>("SELECT COUNT(*) n FROM inbound WHERE id LIKE 'denial-recovery:%'")!
        .n,
      1,
    );
  } finally {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
