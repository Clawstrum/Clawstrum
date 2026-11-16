import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { Discord } from '../src/discord.js';
import { Engine } from '../src/engine.js';
import { fixture, ok } from './helpers.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('shutdown awaits one asynchronous destroy and accepted handlers, refusing late events', async (t) => {
  const f = fixture(t);
  const discord = new Discord(
    f.config,
    f.store,
    new Engine(f.config, f.store, { claude: ok, codex: ok }),
  );
  const destroy = gate(),
    handler = gate();
  let destroyed = 0,
    handled = 0,
    closed = false;
  t.mock.method(discord.client, 'destroy', async () => {
    destroyed++;
    await destroy.promise;
  });
  t.mock.method(discord as any, 'onMessage', async () => {
    handled++;
    await handler.promise;
  });
  discord.client.emit(Events.MessageCreate, {} as any);
  const pending = discord.close();
  assert.equal(discord.close(), pending);
  void pending.then(() => {
    closed = true;
  });
  discord.client.emit(Events.MessageCreate, {} as any);
  discord.client.emit(Events.TypingStart, {} as any);
  discord.client.emit(Events.InteractionCreate, {} as any);
  await discord.tick();
  await discord.backfill();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(destroyed, 1);
  assert.equal(handled, 1);
  assert.equal(closed, false);
  destroy.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false, 'accepted handlers must finish before SQLite can close');
  handler.release();
  await pending;
  assert.equal(closed, true);
});

test('destroy rejection is observed and cleanup still waits for accepted work', async (t) => {
  const f = fixture(t);
  const discord = new Discord(
    f.config,
    f.store,
    new Engine(f.config, f.store, { claude: ok, codex: ok }),
  );
  const handler = gate();
  const error = new Error('synthetic destroy failure');
  t.mock.method(discord.client, 'destroy', async () => {
    throw error;
  });
  t.mock.method(discord as any, 'onMessage', async () => {
    await handler.promise;
  });
  discord.client.emit(Events.MessageCreate, {} as any);
  let closed = false;
  const observed = assert.rejects(discord.close(), (e: any) => {
    closed = true;
    assert.deepEqual(e.errors, [error]);
    return true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  handler.release();
  await observed;
});

test('ready timeout rejects even if login never settles and removes temporary listeners', async (t) => {
  const f = fixture(t);
  const discord = new Discord(
    f.config,
    f.store,
    new Engine(f.config, f.store, { claude: ok, codex: ok }),
  );
  t.mock.method(discord.client, 'login', async () => new Promise<string>(() => {}));
  const errorsBefore = discord.client.listenerCount(Events.Error);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(discord.connect('synthetic-token'), /Discord login timed out/);
  t.mock.timers.tick(45001);
  await rejected;
  assert.equal(discord.client.listenerCount(Events.Error), errorsBefore);
  assert.equal(discord.client.listenerCount(Events.ClientReady), 0);
  await discord.close();
});

test('gateway shard errors are observable without triggering a second shutdown', async (t) => {
  const f = fixture(t);
  const discord = new Discord(
    f.config,
    f.store,
    new Engine(f.config, f.store, { claude: ok, codex: ok }),
  );
  const log = t.mock.method(console, 'error', () => {});
  discord.client.emit(Events.ShardError, new Error('Opening handshake has timed out'), 0);
  const event = JSON.parse(log.mock.calls[0]!.arguments[0]);
  assert.equal(event.event, 'discord_shard_error');
  assert.equal(event.shardId, 0);
  assert.match(event.message, /handshake/);
  await discord.close();
});
function channel(id: string, at: number) {
  const result: any = { id, name: `channel-${id}`, isTextBased: () => true, isThread: () => false };
  result.messages = {
    fetch: async () =>
      new Map([
        [
          String((BigInt(at) - 1420070400000n) << 22n),
          {
            id: String((BigInt(at) - 1420070400000n) << 22n),
            createdTimestamp: at,
            author: { id: '123456', bot: false, displayName: 'owner' },
            guildId: '555555',
            channelId: id,
            channel: result,
            content: 'Recover this unanswered request',
            attachments: new Map(),
          },
        ],
      ]),
  };
  return result;
}

test('known messages recover before stalled thread discovery and replay stays idempotent', async (t) => {
  const f = fixture(t),
    pause = gate(),
    discovered = gate();
  const discord = new Discord(
    f.config,
    f.store,
    new Engine(f.config, f.store, { claude: ok, codex: ok }),
  );
  const parent = channel(f.session.channel_id, Date.now());
  parent.threads = {
    fetchActive: async () => {
      discovered.release();
      await pause.promise;
      return { threads: new Map() };
    },
    fetchArchived: async () => ({ threads: new Map() }),
  };
  t.mock.method(discord.client.channels, 'fetch', async () => parent);
  const pending = discord.backfill();
  try {
    await discovered.promise;
    assert.equal(f.store.all('SELECT * FROM inbound').length, 1, 'discovery cannot gate intake');
    pause.release();
    await pending;
    await discord.backfill();
    assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
    assert.equal(
      JSON.parse(f.store.get<any>("SELECT value FROM metadata WHERE key='discord-recovery'").value)
        .stage,
      'completed',
    );
  } finally {
    pause.release();
    await pending;
    await discord.close();
  }
});

test('a slow known conversation does not block a different conversation or advance its cursor', async (t) => {
  const f = fixture(t),
    pause = gate(),
    fetched = gate();
  f.config.discord.channelIds.push('999999');
  f.store.ensureSession('999999');
  const discord = new Discord(
    f.config,
    f.store,
    new Engine(f.config, f.store, { claude: ok, codex: ok }),
  );
  const slow = channel('987654', Date.now()),
    fast = channel('999999', Date.now() + 1);
  const fetchSlow = slow.messages.fetch,
    fetchFast = fast.messages.fetch;
  slow.messages.fetch = async () => {
    await pause.promise;
    return fetchSlow();
  };
  fast.messages.fetch = async () => {
    const result = await fetchFast();
    fetched.release();
    return result;
  };
  t.mock.method(discord.client.channels, 'fetch', async (id: any) =>
    id === slow.id ? slow : fast,
  );
  const pending = discord.backfill();
  try {
    await fetched.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
    assert.equal(
      f.store.get<any>('SELECT session_id FROM inbound').session_id,
      f.store.ensureSession('999999').id,
    );
    pause.release();
    await pending;
    assert.equal(f.store.all('SELECT * FROM inbound').length, 2);
  } finally {
    pause.release();
    await pending;
    await discord.close();
  }
});
