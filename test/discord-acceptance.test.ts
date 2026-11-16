import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { fixture, ok } from './helpers.js';
import { Engine } from '../src/engine.js';
import { Discord } from '../src/discord.js';

function message(overrides: Record<string, any> = {}) {
  return {
    id: '123451',
    author: { id: '123456', bot: true, displayName: 'Automated input' },
    webhookId: '123456',
    guildId: '555555',
    channelId: '987654',
    channel: { id: '987654', parentId: null },
    content: 'Synthetic acceptance input',
    createdTimestamp: Date.now(),
    attachments: new Map(),
    react: async () => {},
    ...overrides,
  };
}
test('normal Discord instances reject even owner-listed bots and webhooks', async (t) => {
  const f = fixture(t);
  const discord = new Discord(
    f.config,
    f.store,
    new Engine(f.config, f.store, { claude: ok, codex: ok }),
  );
  try {
    await (discord as any).onMessage(message());
    assert.equal(f.store.all('SELECT * FROM inbound').length, 0);
    await (discord as any).onMessage(
      message({ author: { id: '123456', bot: false, displayName: 'Human' }, webhookId: null }),
    );
    assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
  } finally {
    await discord.close();
  }
});
test('automated ingress requires an explicitly isolated configuration', (t) => {
  const f = fixture(t);
  const engine = new Engine(f.config, f.store, { claude: ok, codex: ok });
  const hook = { id: '123456', channelId: '987654', guildId: '555555' };
  assert.throws(() => new Discord(f.config, f.store, engine, { testWebhook: hook }), /isolated/);
  for (const change of [
    { allowDMs: true },
    { allowAllSenders: true },
    { respondToBots: true },
    { ownerIds: ['123456', '444444'] },
    { channelIds: ['987654', '111111'] },
    { guildId: '666666' },
  ])
    assert.throws(
      () =>
        new Discord({ ...f.config, discord: { ...f.config.discord, ...change } }, f.store, engine, {
          registerCommands: false,
          testWebhook: hook,
        }),
      /isolated/,
    );
});
test('only the exact acceptance webhook and channel or child thread are admitted', async (t) => {
  const f = fixture(t);
  const discord = new Discord(
    f.config,
    f.store,
    new Engine(f.config, f.store, { claude: ok, codex: ok }),
    {
      registerCommands: false,
      testWebhook: { id: '123456', channelId: '987654', guildId: '555555' },
    },
  );
  try {
    for (const bad of [
      { webhookId: null },
      { webhookId: '111111' },
      { guildId: '666666' },
      { channelId: '111111', channel: { id: '111111', parentId: null } },
      { author: { id: '111111', bot: true } },
    ])
      await (discord as any).onMessage(message(bad));
    assert.equal(f.store.all('SELECT * FROM inbound').length, 0);
    await (discord as any).onMessage(message());
    await (discord as any).onMessage(message());
    await (discord as any).onMessage(
      message({ id: '123452', channelId: '888888', channel: { id: '888888', parentId: '987654' } }),
    );
    assert.equal(f.store.all('SELECT * FROM inbound').length, 2);
    assert.equal(f.store.all('SELECT * FROM sessions').length, 2);
  } finally {
    await discord.close();
  }
});
test('the live acceptance connection skips application-command writes and still recovers history', async (t) => {
  const f = fixture(t);
  const discord = new Discord(
    f.config,
    f.store,
    new Engine(f.config, f.store, { claude: ok, codex: ok }),
    { registerCommands: false },
  );
  let recovered = false;
  (discord.client as any).login = async () => {
    discord.client.emit(Events.ClientReady, discord.client as any);
    return 'unused';
  };
  (discord.client as any).application = {
    commands: {
      create() {
        throw new Error('Shared application commands must stay untouched');
      },
    },
  };
  discord.backfill = async () => {
    recovered = true;
  };
  try {
    await discord.connect('synthetic-token');
    assert.equal(recovered, true);
  } finally {
    await discord.close();
  }
});

test('human requests are durably queued with a notice anchor, without automatic receipt messages', async (t) => {
  const f = fixture(t);
  const discord = new Discord(
    f.config,
    f.store,
    new Engine(f.config, f.store, { claude: ok, codex: ok }),
  );
  const human = message({
    author: { id: '123456', bot: false, displayName: 'Human' },
    webhookId: null,
    react: async () => {
      throw new Error('missing reaction permission');
    },
  });
  try {
    await (discord as any).onMessage(human);
    await (discord as any).onMessage(human);
    assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
    assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
    assert.equal(
      JSON.parse(
        f.store.get<{ value: string }>(
          'SELECT value FROM metadata WHERE key=?',
          `discord-request:${f.session.id}`,
        )!.value,
      ).messageId,
      human.id,
    );
    assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'queued');
    await (discord as any).onMessage({ ...human, id: 'backfill' }, false);
    assert.equal(
      f.store.all('SELECT * FROM outbox').length,
      0,
      'old history does not emit receipts',
    );
    f.config.discord.respondToBots = true;
    await (discord as any).onMessage(message({ id: 'bot' }));
    assert.equal(
      f.store.all('SELECT * FROM outbox').length,
      0,
      'bot receipts cannot create reply loops',
    );
  } finally {
    await discord.close();
  }
});
