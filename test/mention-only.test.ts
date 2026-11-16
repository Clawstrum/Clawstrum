import test from 'node:test';
import assert from 'node:assert/strict';
import { Discord } from '../src/discord.js';
import { Engine } from '../src/engine.js';
import { fixture, ok } from './helpers.js';

function setup(t: any) {
  const f = fixture(t);
  (f.config.discord as any).respondToBots = true;
  (f.config.discord as any).allowAllSenders = true;
  const discord = new Discord(
    f.config,
    f.store,
    new Engine(f.config, f.store, { claude: ok, codex: ok }),
  );
  (discord.client as any).user = { id: '999999', username: 'Rook' };
  const channel: any = {
    id: '987654',
    name: 'shared',
    isTextBased: () => true,
    isThread: () => false,
  };
  let n = 0;
  const send = (
    content: string,
    opts: { bot?: boolean; mentions?: string[]; author?: string; id?: string } = {},
  ) =>
    (discord as any).onMessage(
      {
        id: opts.id ?? String(1000 + n++),
        createdTimestamp: Date.now() + n,
        author: {
          id: opts.bot ? '777777' : '123456',
          bot: !!opts.bot,
          displayName: opts.author ?? 'owner',
        },
        guildId: '555555',
        channelId: '987654',
        channel,
        content,
        attachments: new Map(),
        mentions: { users: new Map((opts.mentions ?? []).map((id) => [id, {}])), roles: new Map() },
        react: async () => undefined,
      },
      false,
    );
  const inbound = () => f.store.all<any>('SELECT content FROM inbound ORDER BY created_at');
  return { f, send, inbound };
}

test('without another bot, every message starts a turn', async (t) => {
  const { send, inbound } = setup(t);
  await send('what is the status?');
  assert.equal(inbound().length, 1);
});

test('after another bot posts, only messages naming this bot start a turn', async (t) => {
  const { f, send, inbound } = setup(t);
  await send('here. what is up?', { bot: true, author: 'PIP' });
  await send('ana / ben: what do you want me on?', { bot: true, author: 'PIP' });
  await send('Pip, run the pilot');
  await send('rookery birds are not a mention');
  assert.equal(inbound().length, 0);
  assert.equal(
    f.store.get<any>("SELECT count(*) AS c FROM history_records WHERE id LIKE 'inbound:%'").c,
    4,
    'unaddressed messages are still archived',
  );
  await send('Rook, add a rule for this channel');
  const rows = inbound();
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, /did not name you/);
  assert.match(rows[0].content, /PIP: here\. what is up\?/);
  assert.match(rows[0].content, /owner: Pip, run the pilot/);
  assert.match(rows[0].content, /Rook, add a rule for this channel$/);
  await send('@ mention only', { mentions: ['999999'] });
  await send('(rook) in parentheses');
  await send('a bot naming ROOK', { bot: true, author: 'PIP' });
  const later = inbound();
  assert.equal(later.length, 4);
  assert.doesNotMatch(later[1].content, /did not name you/, 'held messages are given once');
});

test('a second delivery of a naming message leaves later held messages in place', async (t) => {
  const { send, inbound } = setup(t);
  await send('here', { bot: true, author: 'PIP' });
  await send('Rook, start', { id: '5000' });
  await send('an aside for Pip');
  await send('Rook, start', { id: '5000' });
  await send('Rook, next');
  const rows = inbound();
  assert.equal(rows.length, 2);
  assert.match(rows[1].content, /owner: an aside for Pip/);
});

test('the gate can be turned off', async (t) => {
  const { f, send, inbound } = setup(t);
  (f.config.discord as any).mentionOnlyWithBots = false;
  await send('hello', { bot: true, author: 'PIP' });
  await send('no name here');
  assert.equal(inbound().length, 2);
});
