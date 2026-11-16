import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { configSchema, type Config } from '../src/config.js';
import { DEFAULT_AGENTS } from '../src/default-instructions.js';
import { memoryTemplate } from '../src/memory.js';
import { ensureWelcome } from '../src/welcome.js';

function home(t: any, channelIds: string[], agents = DEFAULT_AGENTS) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-welcome-')));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const parsed = configSchema.parse({
    version: 1,
    name: 'Atlas',
    discord: { ownerIds: ['123456'] },
    accounts: [{ id: 'a', provider: 'claude', home: path.join(dir, 'a') }],
  });
  // Channel IDs are Discord snowflakes in config.json; the test sets short IDs after validation.
  const config: Config = { ...parsed, discord: { ...parsed.discord, channelIds } };
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), memoryTemplate(agents, path.join(dir, 'history')));
  return { store, config };
}

const inbound = (store: Store) =>
  store.all<{ id: string; kind: string; session_id: string; content: string }>(
    'SELECT id, kind, session_id, content FROM inbound',
  );

test('a fresh installation queues one welcome task in the main channel', (t) => {
  const { store, config } = home(t, ['C1']);
  assert.match(DEFAULT_AGENTS, /^## First conversation\b/m);
  assert.equal(ensureWelcome(store, config), true);
  const rows = inbound(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, 'welcome:C1');
  assert.equal(rows[0]!.kind, 'task');
  assert.equal(rows[0]!.session_id, store.ensureSession('C1').id);
  assert.match(rows[0]!.content, /Atlas/);
  assert.equal(ensureWelcome(store, config), false);
  assert.equal(inbound(store).length, 1);
});

test('an existing conversation in the main channel is never welcomed', (t) => {
  const { store, config } = home(t, ['C1']);
  store.enqueue({
    id: 'm1',
    sessionId: store.ensureSession('C1').id,
    author: 'owner',
    content: 'hi',
  });
  assert.equal(ensureWelcome(store, config), false);
  assert.ok(!inbound(store).some((r) => r.id === 'welcome:C1'));
  assert.equal(ensureWelcome(store, config), false);
  assert.ok(!inbound(store).some((r) => r.id === 'welcome:C1'));
});

test('no welcome once onboarding removed the First conversation section', (t) => {
  const agents = DEFAULT_AGENTS.replace(/^## First conversation\b/m, '## Notes');
  const { store, config } = home(t, ['C1'], agents);
  assert.equal(ensureWelcome(store, config), false);
  assert.equal(inbound(store).length, 0);
});

test('no welcome without a main channel', (t) => {
  const { store, config } = home(t, []);
  assert.equal(ensureWelcome(store, config), false);
  assert.equal(inbound(store).length, 0);
});
