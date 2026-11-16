import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, type Client } from 'discord.js';
import { Delivery, sendDiscordDelivery } from '../src/discord.js';
import { Store } from '../src/store.js';
import type { Outbound } from '../src/types.js';
import { fixture, settle } from './helpers.js';
import { Engine } from '../src/engine.js';
import { ProviderFailure } from '../src/accounts.js';
import { addTask } from '../src/scheduler.js';

const apiError = (code: number) => Object.assign(new Error(`Discord error ${code}`), { code });
function transport() {
  const sent: Array<{ channel: string; payload: any }> = [];
  const channels = new Map<string, any>();
  let creates = 0;
  const thread = (id: string) => ({
    id,
    parentId: '987654',
    isThread: () => true,
    isSendable: () => true,
    send: async (payload: any) => {
      sent.push({ channel: id, payload });
      return { id: `sent-${sent.length}` };
    },
  });
  const parent = {
    ...thread('987654'),
    type: ChannelType.GuildText,
    isThread: () => false,
    threads: {
      create: async ({ startMessage }: { startMessage: string }) => {
        creates++;
        const result = thread(startMessage);
        channels.set(startMessage, result);
        return result;
      },
    },
  };
  channels.set(parent.id, parent);
  const client = {
    channels: {
      fetch: async (id: string) => {
        if (!channels.has(id)) throw apiError(10003);
        return channels.get(id);
      },
    },
  } as unknown as Client;
  return { sent, channels, parent, thread, client, creates: () => creates };
}
function notice(
  f: ReturnType<typeof fixture>,
  messageId = '123451',
  fallback: 'channel' | 'skip' = 'skip',
  text = 'Waiting for account capacity.',
) {
  const id = f.store.outbox(f.session.id, text, { noticeThread: { messageId, fallback } });
  return f.store.get<Outbound>('SELECT * FROM outbox WHERE id=?', id)!;
}

test('a failed request explains the cause in its own thread even after a newer request arrives', async (t) => {
  const f = fixture(t),
    api = transport();
  f.store.enqueue({
    id: '123451',
    sessionId: f.session.id,
    author: 'owner',
    content: 'Check the research results',
  });
  f.store.discordRequest(f.session.id, '123451', 10);
  const provider = {
    async run() {
      f.store.discordRequest(f.session.id, '123452', 20);
      throw new ProviderFailure(
        'fatal',
        'invalid_request: Provider rejected the request [reasoning_extraction]; Request ID: req_example',
      );
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  engine.tick();
  await settle(engine);
  const [row] = f.store.pendingOutbox();
  assert.ok(row);
  assert.equal(row.origin, 'notice');
  assert.equal(f.store.noticeThread(row.id)?.messageId, '123451');
  assert.match(row.content, /Request “Check the research results” stopped on Claude/);
  assert.match(row.content, /reasoning_extraction.*req_example/);
  assert.match(row.content, /No automatic retry/);
  assert.match(row.content, /Run: /);
  await sendDiscordDelivery(api.client, f.store, '987654', row);
  assert.equal(api.sent[0]!.channel, '123451');
  assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'failed');
});

test('a scheduled failure names its task, preserves provider detail and redacts secrets', async (t) => {
  const f = fixture(t);
  const task = addTask(
    f.store,
    f.session.id,
    'Daily self-review.\nRead the delivered conversation evidence.',
    'once',
    new Date(Date.now() + 60000).toISOString(),
  );
  f.store.exec('UPDATE tasks SET next_run=? WHERE id=?', Date.now() - 1, task);
  f.store.discordRequest(f.session.id, '123451', 10);
  const secret = 'private-value-for-notice-regression';
  const old = process.env.CLAWSTRUM_NOTICE_TEST_TOKEN;
  process.env.CLAWSTRUM_NOTICE_TEST_TOKEN = secret;
  t.after(() => {
    if (old === undefined) delete process.env.CLAWSTRUM_NOTICE_TEST_TOKEN;
    else process.env.CLAWSTRUM_NOTICE_TEST_TOKEN = old;
  });
  let calls = 0;
  const provider = {
    async run() {
      calls++;
      throw new ProviderFailure(
        'fatal',
        `invalid_request: Safeguards flagged this message [reasoning_extraction]; token=${secret}; Bearer abc123456789`,
      );
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  engine.tick();
  await settle(engine);
  engine.tick();
  const [row] = f.store.pendingOutbox();
  assert.ok(row);
  assert.equal(calls, 1, 'a provider rejection is not automatically retried or rerouted');
  assert.match(row.content, /Scheduled task “Daily self-review\.” stopped/);
  assert.doesNotMatch(row.content, /Scheduled follow-up|private-value|abc123456789/);
  assert.match(row.content, /reasoning_extraction/);
  assert.equal(f.store.noticeThread(row.id)?.messageId, '123451');
  assert.match(
    f.store.get<any>('SELECT error FROM runs').error,
    new RegExp(secret),
    'the original error remains in private diagnostics',
  );
});

test('an unanchored failure remains visible with the task and actual cause', async (t) => {
  const f = fixture(t);
  f.store.enqueue({
    id: 'task:review',
    sessionId: f.session.id,
    author: 'scheduler',
    kind: 'task',
    content: 'Scheduled follow-up. Report only meaningful findings.\nCheck results',
  });
  const provider = {
    async run() {
      throw new Error('Model configuration is invalid');
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  engine.tick();
  await settle(engine);
  const [row] = f.store.pendingOutbox();
  assert.ok(row);
  assert.equal(f.store.noticeThread(row.id), undefined);
  assert.match(row.content, /Scheduled task “Check results”/);
  assert.match(row.content, /Cause: Model configuration is invalid/);
});

test('optional and actionable notices share the actual message thread; agent output stays in the channel', async (t) => {
  const f = fixture(t),
    api = transport();
  const receipt = notice(f);
  await sendDiscordDelivery(api.client, f.store, '987654', receipt);
  f.store.discordRequest(f.session.id, '123451', 10);
  f.store.discordRequest(f.session.id, '123450', 9);
  f.store.notice(f.session.id, 'Waiting for capacity.', 'capacity', { thread: true });
  const waiting = f.store.get<Outbound>("SELECT * FROM outbox WHERE dedupe_key='capacity'")!;
  assert.equal(f.store.noticeThread(waiting.id)?.messageId, '123451');
  await sendDiscordDelivery(api.client, f.store, '987654', waiting);
  const id = f.store.outbox(f.session.id, 'I will check the results.', { origin: 'agent' });
  await sendDiscordDelivery(
    api.client,
    f.store,
    '987654',
    f.store.get<Outbound>('SELECT * FROM outbox WHERE id=?', id)!,
  );
  assert.equal(api.creates(), 1);
  assert.deepEqual(
    api.sent.map((s) => s.channel),
    ['123451', '123451', '987654'],
  );
  assert.match(api.sent[0]!.payload.content, /Waiting for account capacity/);
  assert.deepEqual(api.sent[0]!.payload.allowedMentions, { parse: [] });
});

test('an existing thread is reused without renaming or creating a second one', async (t) => {
  const f = fixture(t),
    api = transport();
  api.channels.set('123451', api.thread('123451'));
  await sendDiscordDelivery(api.client, f.store, '987654', notice(f));
  assert.equal(api.creates(), 0);
  assert.equal(api.sent[0]!.channel, '123451');
});

test('lost thread creation acknowledgment recovers the created thread', async (t) => {
  const f = fixture(t),
    api = transport();
  const create = api.parent.threads.create;
  api.parent.threads.create = async (args) => {
    await create(args);
    throw new Error('connection lost after POST');
  };
  await sendDiscordDelivery(api.client, f.store, '987654', notice(f));
  assert.equal(api.creates(), 1);
  assert.equal(api.sent[0]!.channel, '123451');
});

test('optional DM notices are quiet, actionable notices fall back, and nested threads are never created', async (t) => {
  const f = fixture(t),
    api = transport();
  api.parent.type = ChannelType.DM;
  assert.equal(await sendDiscordDelivery(api.client, f.store, '987654', notice(f)), undefined);
  await sendDiscordDelivery(api.client, f.store, '987654', notice(f, '123451', 'channel'));
  assert.equal(api.sent[0]!.channel, '987654');
  api.parent.isThread = () => true;
  await sendDiscordDelivery(api.client, f.store, '987654', notice(f, '123452'));
  assert.equal(api.sent[1]!.channel, '987654');
  assert.equal(api.creates(), 0);
});

test('missing permissions and deleted starter messages do not put optional notices in the main channel', async (t) => {
  for (const code of [50013, 10008]) {
    const f = fixture(t),
      api = transport();
    api.parent.threads.create = async () => {
      throw apiError(code);
    };
    const row = notice(f);
    const delivery = new Delivery(f.store, (channel, output) =>
      sendDiscordDelivery(api.client, f.store, channel, output),
    );
    await delivery.tick();
    assert.equal(api.sent.length, 0);
    assert.deepEqual(
      { ...f.store.get<any>('SELECT status,remote_id FROM outbox WHERE id=?', row.id) },
      { status: 'sent', remote_id: null },
    );
    assert.ok(f.store.get("SELECT rowid FROM events WHERE type='notice_suppressed'"));
    await sendDiscordDelivery(api.client, f.store, '987654', notice(f, '123452', 'channel'));
    assert.equal(api.sent[0]!.channel, '987654');
  }
});

test('send permission failure falls back before any part is delivered, never after partial delivery', async (t) => {
  const f = fixture(t),
    api = transport();
  const thread = api.thread('123451');
  thread.send = async () => {
    throw apiError(50013);
  };
  api.channels.set(thread.id, thread);
  assert.equal(await sendDiscordDelivery(api.client, f.store, '987654', notice(f)), undefined);
  await sendDiscordDelivery(api.client, f.store, '987654', notice(f, '123451', 'channel'));
  assert.equal(api.sent[0]!.channel, '987654');
  let calls = 0;
  thread.send = async () => {
    if (++calls === 1) return { id: 'first-part' };
    throw apiError(50013);
  };
  const long = notice(f, '123451', 'channel', 'long notice '.repeat(500));
  await assert.rejects(sendDiscordDelivery(api.client, f.store, '987654', long));
  assert.equal(api.sent.length, 1, 'partial thread output never spills into the parent');
});

test('pending thread retries do not block ordered main replies or notices on a newer message', async (t) => {
  const f = fixture(t),
    api = transport();
  const first = notice(f);
  api.parent.threads.create = async () => {
    throw new Error('temporary network failure');
  };
  const delivery = new Delivery(f.store, (channel, row) =>
    sendDiscordDelivery(api.client, f.store, channel, row),
  );
  const a = f.store.outbox(f.session.id, 'Acknowledged', { origin: 'agent' });
  const b = f.store.outbox(f.session.id, 'Answer', { origin: 'agent' });
  const sameThread = notice(f);
  const newerThread = notice(f, '123452');
  assert.deepEqual(
    new Set(f.store.pendingOutbox(Date.now()).map((r) => r.id)),
    new Set([first.id, a, newerThread.id]),
  );
  await delivery.tick();
  assert.equal(
    f.store.get<any>('SELECT status FROM outbox WHERE id=?', first.id).status,
    'pending',
  );
  assert.equal(f.store.get<any>('SELECT status FROM outbox WHERE id=?', a).status, 'sent');
  await delivery.tick();
  assert.equal(f.store.get<any>('SELECT status FROM outbox WHERE id=?', b).status, 'sent');
  assert.equal(
    f.store.get<any>('SELECT attempts FROM outbox WHERE id=?', sameThread.id).attempts,
    0,
  );
});

test('thread destination and multipart progress survive restart and a newer user message', async (t) => {
  const f = fixture(t),
    api = transport();
  const thread = api.thread('123451');
  api.channels.set(thread.id, thread);
  const send = thread.send;
  let calls = 0;
  thread.send = async (payload) => {
    if (++calls === 2) throw new Error('transient');
    return send(payload);
  };
  const row = notice(f, '123451', 'channel', 'update '.repeat(700));
  await assert.rejects(sendDiscordDelivery(api.client, f.store, '987654', row));
  f.store.discordRequest(f.session.id, '123452', 100);
  const reopened = new Store(f.home);
  try {
    await sendDiscordDelivery(api.client, reopened, '987654', row);
    assert.ok(api.sent.length > 1);
    assert.ok(api.sent.every((s) => s.channel === '123451'));
    assert.equal(new Set(api.sent.map((s) => s.payload.nonce)).size, api.sent.length);
  } finally {
    reopened.close();
  }
});

test('notice anchors are atomic, immutable under deduplication, and optional for operator notices', (t) => {
  const f = fixture(t);
  f.store.discordRequest(f.session.id, '123451', 10);
  f.store.discordRequest(f.session.id, '123452', 10);
  f.store.notice(f.session.id, 'Operator alert', 'operator');
  const operator = f.store.get<Outbound>("SELECT * FROM outbox WHERE dedupe_key='operator'")!;
  assert.equal(f.store.noticeThread(operator.id), undefined);
  f.store.notice(f.session.id, 'Routine wait', 'wait', { thread: true });
  const wait = f.store.get<Outbound>("SELECT * FROM outbox WHERE dedupe_key='wait'")!;
  assert.equal(f.store.noticeThread(wait.id)?.messageId, '123452');
  f.store.discordRequest(f.session.id, '123453', 11);
  f.store.notice(f.session.id, 'Routine wait', 'wait', { thread: true });
  assert.equal(f.store.noticeThread(wait.id)?.messageId, '123452');
  assert.throws(
    () =>
      f.store.outbox(f.session.id, 'Routine wait', {
        key: 'wait',
        noticeThread: { messageId: '123453', fallback: 'channel' },
      }),
    /destination/,
  );
});

test('unsent receipts from previous builds are retired without Discord messages or threads', async (t) => {
  const f = fixture(t),
    api = transport();
  const receipt = f.store.outbox(f.session.id, 'Received — your message is queued.', {
    key: 'receipt:123451',
  });
  const threaded = f.store.outbox(f.session.id, 'Message queued.', {
    key: 'receipt:123452',
    noticeThread: { messageId: '123452', fallback: 'skip' },
  });
  const delivery = new Delivery(f.store, (channel, row) =>
    sendDiscordDelivery(api.client, f.store, channel, row),
  );
  await delivery.tick();
  assert.equal(api.sent.length, 0);
  assert.equal(api.creates(), 0);
  for (const id of [receipt, threaded]) {
    assert.deepEqual(
      { ...f.store.get<any>('SELECT status,remote_id FROM outbox WHERE id=?', id) },
      { status: 'sent', remote_id: null },
    );
  }
});

test('operator notices distinguish DM, guild and unavailable source conversations without mentions', async (t) => {
  for (const kind of ['dm', 'guild', 'missing']) {
    const f = fixture(t),
      api = transport();
    api.channels.set(
      '333333',
      kind === 'dm'
        ? { type: ChannelType.DM }
        : { type: ChannelType.GuildText, name: 'research', isThread: () => false },
    );
    if (kind === 'missing') api.channels.delete('333333');
    f.store.notice(f.session.id, 'Switched from A to B.', `switch:${kind}`, {
      sourceChannelId: '333333',
    });
    const row = f.store.pendingOutbox()[0]!;
    await sendDiscordDelivery(api.client, f.store, f.session.channel_id, row);
    const text = api.sent[0]!.payload.content;
    assert.equal(api.sent[0]!.channel, f.session.channel_id);
    assert.match(text, /ID 333333/);
    assert.doesNotMatch(text, /<#|unknown/i);
    if (kind === 'dm') assert.match(text, /direct message/);
    if (kind === 'guild') assert.match(text, /Channel: #research/);
    api.channels.delete('333333');
    await sendDiscordDelivery(api.client, f.store, f.session.channel_id, row);
    assert.equal(
      api.sent.length,
      1,
      'a retry must preserve the frozen payload and delivery receipt',
    );
  }
});

test('delivery suppresses bare quiet markers from tools and old spools without losing prose or files', async (t) => {
  const f = fixture(t),
    api = transport();
  for (const content of ['CLAWSTRUM_QUIET', 'Useful update\nCLAWSTRUM_QUIET']) {
    const id = f.store.outbox(f.session.id, content, { origin: 'agent' });
    const row = f.store.get<Outbound>('SELECT * FROM outbox WHERE id=?', id)!;
    // Simulate a payload frozen by the older build, before it reached Discord.
    f.store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?)',
      `discord-delivery:${id}`,
      JSON.stringify({
        payloads: [
          { content, files: [], nonce: id, enforceNonce: true, allowedMentions: { parse: [] } },
        ],
        remoteIds: [],
      }),
    );
    await sendDiscordDelivery(api.client, f.store, f.session.channel_id, row);
    await sendDiscordDelivery(api.client, f.store, f.session.channel_id, row);
    const saved = JSON.parse(
      f.store.get<{ value: string }>(
        'SELECT value FROM metadata WHERE key=?',
        `discord-delivery:${id}`,
      )!.value,
    );
    assert.equal(saved.payloads[0].content, content === 'CLAWSTRUM_QUIET' ? '' : 'Useful update');
    assert.equal(saved.payloads[0].nonce, id);
    assert.equal(saved.remoteIds.length, 1);
    assert.equal(!!saved.remoteIds[0], content !== 'CLAWSTRUM_QUIET');
  }
  assert.deepEqual(
    api.sent.map((r) => r.payload.content.trim()),
    ['Useful update'],
  );
  const id = f.store.outbox(f.session.id, 'CLAWSTRUM_QUIET', { origin: 'agent' });
  const row = f.store.get<Outbound>('SELECT * FROM outbox WHERE id=?', id)!;
  await sendDiscordDelivery(api.client, f.store, f.session.channel_id, {
    ...row,
    file_path: '/tmp/example.txt',
  });
  assert.equal(api.sent[1]!.payload.files.length, 1);
  assert.equal(api.sent[1]!.payload.content, '');
});
