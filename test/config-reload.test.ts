import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { channelReloader, readConfig } from '../src/config.js';
import { accepts } from '../src/discord.js';

function setup(t: any) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-reload-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'config.json');
  let version = 0;
  const write = (channelIds: string[] | null) => {
    const body =
      channelIds === null
        ? '{ not json'
        : JSON.stringify({
            version: 1,
            discord: { ownerIds: ['123456'], channelIds, guildId: '555555', allowDMs: false },
            accounts: [{ id: 'a', provider: 'claude', home: path.join(home, 'a') }],
          });
    fs.writeFileSync(file, body);
    // Give every write a distinct modification time, as a later edit would have.
    const at = new Date(Date.UTC(2026, 0, 1) + ++version * 1000);
    fs.utimesSync(file, at, at);
  };
  write(['111111']);
  return { home, write };
}

test('a channel added to config.json is accepted without a restart', (t) => {
  const { home, write } = setup(t);
  const config = readConfig(home);
  const list = config.discord.channelIds;
  const reload = channelReloader(home, config, 1000);
  assert.equal(accepts(config, '123456', '555555', '222222'), false);
  write(['111111', '222222']);
  assert.equal(reload(Date.now() + 500), null, 'checks at most once per interval');
  assert.deepEqual(reload(Date.now() + 2000), { added: ['222222'], removed: [] });
  assert.equal(config.discord.channelIds, list, 'the same array is updated in place');
  assert.equal(accepts(config, '123456', '555555', '222222'), true);
  assert.equal(reload(Date.now() + 4000), null, 'an unchanged file is not reloaded');
});

test('a removed channel stops being accepted', (t) => {
  const { home, write } = setup(t);
  const config = readConfig(home);
  const reload = channelReloader(home, config, 0);
  write([]);
  assert.deepEqual(reload(), { added: [], removed: ['111111'] });
  assert.equal(accepts(config, '123456', '555555', '111111'), false);
});

test('an invalid config.json leaves the channel list alone and is reported once', (t) => {
  const { home, write } = setup(t);
  const config = readConfig(home);
  const reload = channelReloader(home, config, 0);
  write(null);
  assert.throws(() => reload());
  assert.equal(reload(), null, 'the same broken file is not reported again');
  assert.deepEqual(config.discord.channelIds, ['111111']);
  write(['111111', '333333']);
  assert.deepEqual(reload(), { added: ['333333'], removed: [] });
});
