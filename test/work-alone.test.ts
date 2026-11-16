import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, ok } from './helpers.js';
import { Store } from '../src/store.js';
import { saveConfig, readConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { addWatch } from '../src/watches.js';
import { WorkAloneMonitor, getWorkAlone, setWorkAlone } from '../src/work-alone.js';

const MIN = 60000;
const T0 = 1_800_000_000_000;

function enabled(t: any) {
  const f = fixture(t);
  f.config.workAlone.enabled = true;
  return f;
}
const wakes = (f: ReturnType<typeof fixture>) =>
  f.store.all<{ id: string; content: string; kind: string }>(
    "SELECT id,content,kind FROM inbound WHERE id LIKE 'work-alone:wake:%' ORDER BY created_at",
  );

async function withMcp(
  t: any,
  workAlone: { enabled: boolean },
  body: (client: Client, store: Store, sessionId: string) => Promise<void>,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-work-alone-'));
  const store = new Store(home);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const session = store.ensureSession('123456');
  saveConfig(home, {
    version: 1,
    discord: { ownerIds: ['123456'] },
    accounts: [{ id: 'a', provider: 'codex', home: 'accounts/a' }],
    workAlone,
  });
  store.enqueue({ id: 'm', sessionId: session.id, author: 'owner', content: 'Task' });
  const run = store.claim(session.id)!.run;
  store.exec('UPDATE runs SET config_json=? WHERE id=?', JSON.stringify(readConfig(home)), run.id);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.resolve('src/cli.ts'), 'mcp'],
    env: {
      PATH: process.env.PATH!,
      CLAWSTRUM_HOME: home,
      CLAWSTRUM_SESSION: session.id,
      CLAWSTRUM_RUN: run.id,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'clawstrum-test', version: '1' });
  try {
    await client.connect(transport);
    await body(client, store, session.id);
  } finally {
    await client.close();
  }
}

test('work-alone tools exist only when workAlone.enabled', async (t) => {
  await withMcp(t, { enabled: false }, async (client) => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes('send_message'));
    assert.ok(!names.includes('work_alone'));
    assert.ok(!names.includes('continue_work'));
  });
});

test('work_alone needs an ask to switch on and records on/off state; continue_work queues one step', async (t) => {
  await withMcp(t, { enabled: true }, async (client, store, sessionId) => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes('work_alone'));
    assert.ok(names.includes('continue_work'));

    const missing = await client.callTool({ name: 'work_alone', arguments: { on: true } });
    assert.equal(missing.isError, true);
    assert.equal(getWorkAlone(store, sessionId), undefined);

    const on = await client.callTool({
      name: 'work_alone',
      arguments: { on: true, ask: 'finish the sweep (Mon 21:40)' },
    });
    assert.ok(!on.isError);
    let state = getWorkAlone(store, sessionId)!;
    assert.equal(state.active, 1);
    assert.equal(state.ask, 'finish the sweep (Mon 21:40)');

    const step = {
      prompt: 'Run the next seed of the sweep and write results/seed2.json',
      produced: 'results/seed1.json',
    };
    const first = await client.callTool({ name: 'continue_work', arguments: step });
    assert.ok(!first.isError);
    const queued = store.all<{ id: string; kind: string; content: string }>(
      "SELECT id,kind,content FROM inbound WHERE id LIKE 'work-alone:continue:%' AND status='queued'",
    );
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.kind, 'task');
    assert.match(queued[0]!.content, /Run the next seed/);
    assert.equal(JSON.parse((first.content as any)[0].text).queued, queued[0]!.id);

    const second = await client.callTool({ name: 'continue_work', arguments: step });
    assert.equal(second.isError, true);
    assert.match((second.content as any)[0].text, /already queued for this conversation/);
    assert.equal(
      store.all("SELECT id FROM inbound WHERE id LIKE 'work-alone:continue:%'").length,
      1,
    );

    const off = await client.callTool({
      name: 'work_alone',
      arguments: { on: false, report: 'sweep done, table in results/' },
    });
    assert.ok(!off.isError);
    state = getWorkAlone(store, sessionId)!;
    assert.equal(state.active, 0);
    assert.equal(state.off_reason, 'agent');
    assert.equal(state.report, 'sweep done, table in results/');
  });
});

test('a wake comes after quietMinutes of quiet, not before, once per quiet stretch', (t) => {
  const f = enabled(t);
  setWorkAlone(f.store, f.session.id, { on: true, ask: 'write the appendix' }, T0);
  const monitor = new WorkAloneMonitor(f.store, f.config);
  monitor.wakes(T0 + 59 * MIN);
  assert.equal(wakes(f).length, 0);
  monitor.wakes(T0 + 61 * MIN);
  assert.equal(wakes(f).length, 1);
  assert.equal(wakes(f)[0]!.kind, 'task');
  assert.match(wakes(f)[0]!.content, /write the appendix/);
  assert.match(wakes(f)[0]!.content, /No job or watch is pending/);
  // A second monitor (or a later scan) in the same stretch adds nothing.
  new WorkAloneMonitor(f.store, f.config).wakes(T0 + 61 * MIN);
  monitor.wakes(T0 + 63 * MIN);
  assert.equal(wakes(f).length, 1);
  monitor.wakes(T0 + 123 * MIN);
  assert.equal(wakes(f).length, 2);
});

test('no wake while a run is running', (t) => {
  const f = enabled(t);
  setWorkAlone(f.store, f.session.id, { on: true, ask: 'write the appendix' }, T0);
  f.enqueue('m', T0);
  const run = f.store.claim(f.session.id, T0)!.run;
  assert.equal(run.status, 'running');
  new WorkAloneMonitor(f.store, f.config).wakes(T0 + 120 * MIN);
  assert.equal(wakes(f).length, 0);
});

test('no wake when work-alone is off or the feature is disabled', (t) => {
  const f = enabled(t);
  setWorkAlone(f.store, f.session.id, { on: true, ask: 'write the appendix' }, T0);
  setWorkAlone(f.store, f.session.id, { on: false, reason: 'agent' }, T0);
  new WorkAloneMonitor(f.store, f.config).wakes(T0 + 120 * MIN);
  assert.equal(wakes(f).length, 0);

  const g = fixture(t);
  setWorkAlone(g.store, g.session.id, { on: true, ask: 'write the appendix' }, T0);
  new WorkAloneMonitor(g.store, g.config).wakes(T0 + 120 * MIN);
  assert.equal(wakes(g).length, 0);
});

test('the wake lists pending watches', (t) => {
  const f = enabled(t);
  setWorkAlone(f.store, f.session.id, { on: true, ask: 'write the appendix' }, T0);
  addWatch(
    f.store,
    f.session.id,
    'sweep-output',
    { condition: { type: 'file', path: 'out.txt' }, message: 'Read it' },
    T0,
  );
  new WorkAloneMonitor(f.store, f.config).wakes(T0 + 61 * MIN);
  assert.equal(wakes(f).length, 1);
  assert.match(wakes(f)[0]!.content, /Still pending: watch sweep-output\./);
});

test('after staleHours without progress work-alone switches off as stale and does not wake', (t) => {
  const f = enabled(t);
  setWorkAlone(f.store, f.session.id, { on: true, ask: 'write the appendix' }, T0);
  new WorkAloneMonitor(f.store, f.config).wakes(T0 + 25 * 60 * MIN);
  const state = getWorkAlone(f.store, f.session.id)!;
  assert.equal(state.active, 0);
  assert.equal(state.off_reason, 'stale');
  assert.equal(wakes(f).length, 0);
});

test('watch status wakes skip conversations working alone and still reach the others', (t) => {
  const f = enabled(t);
  const other = f.store.ensureSession('987655');
  const engine = new Engine(f.config, f.store, { claude: ok, codex: ok });
  const now = Date.now();
  const spec = { condition: { type: 'file', path: 'out.txt' }, message: 'Read it' };
  addWatch(f.store, f.session.id, 'alone', spec, now - 2 * 60 * MIN);
  addWatch(f.store, other.id, 'with-user', spec, now - 2 * 60 * MIN);
  setWorkAlone(f.store, f.session.id, { on: true, ask: 'write the appendix' }, now);
  engine.watches.statusWakes(now);
  const status = f.store.all<{ session_id: string }>(
    "SELECT session_id FROM inbound WHERE id LIKE 'watch-status:%'",
  );
  assert.deepEqual(
    status.map((s) => s.session_id),
    [other.id],
  );
});
