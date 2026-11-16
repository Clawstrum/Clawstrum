import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fixture } from './helpers.js';
import { performanceReport, RuntimeProfiler } from '../src/performance.js';
import { Delivery } from '../src/discord.js';
import { buildContext } from '../src/context.js';
import { ContextRefresh } from '../src/instructions.js';
import { updateMemory } from '../src/memory.js';
import { listWatches } from '../src/watches.js';

test('resuming avoids duplicate memory while changed snapshots remain available to both providers', (t) => {
  const f = fixture(t);
  updateMemory(f.store, f.session.id, { 'Working understanding': 'SAVED_FACT '.repeat(1000) });
  for (const account of f.config.accounts) {
    f.store.exec(
      'UPDATE sessions SET active_account=NULL,remote_id=NULL,fingerprint=NULL WHERE id=?',
      f.session.id,
    );
    const first = buildContext(f.store, f.store.session(f.session.id), account, [], 4000, 100000);
    assert.match(first.instructions, /SAVED_FACT/);
    assert.doesNotMatch(first.prompt, /SAVED_FACT/);
    const request = {
      ...first,
      account,
      cwd: f.session.workspace,
      env: {},
      controller: new AbortController(),
      mcp: { command: 'node', args: [], env: {} },
      onEvent() {},
    };
    const refresh = new ContextRefresh(request);
    refresh.delivered(first.contextRefresh.snapshot, 'native');
    f.store.exec(
      'UPDATE sessions SET active_account=?,remote_id=?,fingerprint=? WHERE id=?',
      account.id,
      'native',
      first.fingerprint,
      f.session.id,
    );
    f.store.exec(
      'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
      `context:${f.session.id}`,
      JSON.stringify({
        sessionId: 'native',
        revision: refresh.revision(first.contextRefresh.snapshot),
      }),
    );
    const next = buildContext(f.store, f.store.session(f.session.id), account, [], 4000, 100000);
    assert.equal(next.resumeId, 'native');
    assert.doesNotMatch(next.prompt, /SAVED_FACT/);
    assert.match(next.instructions, /SAVED_FACT/);
    assert.ok(next.prompt.length < 2000);
    const resumed = new ContextRefresh({ ...request, ...next });
    assert.equal(resumed.changed(next.contextRefresh.snapshot), false);
    updateMemory(f.store, f.session.id, { 'Working understanding': 'CORRECTED_FACT' });
    const changed = resumed.read()!;
    assert.equal(resumed.changed(changed), true);
    assert.match(resumed.text(changed), /CORRECTED_FACT/);
    updateMemory(f.store, f.session.id, { 'Working understanding': 'SAVED_FACT '.repeat(1000) });
  }
});

test('a stuck Discord delivery does not block another channel or duplicate its own sends', async (t) => {
  const f = fixture(t),
    other = f.store.ensureSession('999999');
  let release!: () => void;
  const calls: string[] = [];
  const first = f.store.outbox(f.session.id, 'one');
  const delivery = new Delivery(f.store, async (_channel, row) => {
    calls.push(row.id);
    if (row.id === first)
      await new Promise<void>((r) => {
        release = r;
      });
    return row.id;
  });
  const stuck = delivery.tick();
  try {
    const second = f.store.outbox(other.id, 'two');
    f.store.outbox(f.session.id, 'three');
    const next = delivery.tick();
    await Promise.race([next, delay(100)]);
    assert.deepEqual(calls, [first, second]);
    assert.equal(f.store.get<any>('SELECT status FROM outbox WHERE id=?', second).status, 'sent');
  } finally {
    release();
    await stuck;
  }
  await delivery.tick();
  assert.equal(calls.length, 3);
});

test('performance report separates intake, queue, live consumption, compaction and delivery without content', (t) => {
  const f = fixture(t),
    base = Date.now() - 10000;
  f.enqueue('first', base);
  const { run } = f.store.claim(f.session.id, base + 1000)!;
  const event = (type: string, at: number, content: unknown, runId: string | null = run.id) =>
    f.store.exec(
      'INSERT INTO events(session_id,run_id,type,content,created_at) VALUES(?,?,?,?,?)',
      f.session.id,
      runId,
      type,
      JSON.stringify(content),
      at,
    );
  event('input_received', base + 200, { id: 'first' }, null);
  event('route', base + 1100, { account: 'a' });
  event('activity', base + 1200, { type: 'system', subtype: 'status', status: 'compacting' });
  event('activity', base + 2200, { type: 'system', subtype: 'status', status: 'compacting' });
  event('activity', base + 3200, { type: 'system', subtype: 'status', status: null });
  event('activity', base + 3500, {
    type: 'tool_use',
    name: 'Bash',
    input: { secret: 'DO_NOT_EXPOSE' },
  });
  f.enqueue('live', base + 4000);
  event('input_received', base + 4100, { id: 'live' }, null);
  event('steered', base + 4200, { id: 'live' });
  event('input_started', base + 4500, { ids: ['live'] });
  f.store.exec(
    'UPDATE runs SET message_ids=? WHERE id=?',
    JSON.stringify(['first', 'live']),
    run.id,
  );
  const out = f.store.outbox(f.session.id, 'PRIVATE_REPLY', { runId: run.id });
  f.store.exec('UPDATE outbox SET created_at=?,status=? WHERE id=?', base + 5000, 'sent', out);
  event('delivered', base + 5500, { outboxId: out });
  const report = performanceReport(f.store, { since: base, now: base + 7000 });
  const r = report.runs[0]!;
  assert.equal(r.messages[0]!.ingressMs, 200);
  assert.equal(r.messages[0]!.queueMs, 800);
  assert.equal(r.messages[1]!.queueMs, 100);
  assert.equal(r.messages[1]!.consumptionWaitMs, 300);
  assert.equal(r.preparationMs, 100);
  assert.equal(r.nativeCompaction.count, 1);
  assert.equal(r.nativeCompaction.observedMs, 2000);
  assert.equal(r.firstUserReplyMs, 5500);
  assert.equal(report.summary.delivery.p50Ms, 500);
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_EXPOSE|PRIVATE_REPLY/);
});

test('old runs have unknown intake splits; profiler storage is bounded and reports a stale heartbeat', (t) => {
  const f = fixture(t),
    now = Date.now();
  f.enqueue('old', now - 1000);
  f.store.claim(f.session.id, now);
  const p = new RuntimeProfiler(f.store);
  try {
    let reads = 0;
    p.flush(() => {
      reads++;
      return {};
    });
    assert.equal(reads, 0, 'No per-tick reporting query');
    for (let i = 0; i < 65; i++) {
      p.measure('engine.tick', () => f.store.get('SELECT 1'));
      p.flush(() => ({ active: [] }), now + i * 15000, true);
    }
    f.store.exec(
      "INSERT OR REPLACE INTO metadata(key,value) VALUES('heartbeat',?)",
      String(now - 60000),
    );
    const report = performanceReport(f.store, { now });
    assert.equal(report.health.heartbeatAgeMs, 60000);
    assert.equal(report.runtime.samples.length, 60);
    assert.equal(report.runs[0]!.messages[0]!.ingressMs, null);
    assert.equal(report.runs[0]!.messages[0]!.queueMs, null);
    assert.equal(report.runtime.operations['engine.tick'].count, 1);
    assert.throws(() => performanceReport(f.store, { limit: 101 }));
  } finally {
    p.close();
  }
  assert.equal(f.store.timing, undefined);
});

test('watch polling uses a namespace index without reading unrelated metadata values', (t) => {
  const f = fixture(t);
  f.store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    'watch:one',
    JSON.stringify({ id: 'one', sessionId: f.session.id, status: 'active' }),
  );
  // Invalid unrelated JSON must never be parsed as a watch.
  f.store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    'usage:large',
    'unrelated '.repeat(10000),
  );
  const original = f.store.all.bind(f.store);
  let indexed = false;
  f.store.all = (sql, ...params) => {
    if (sql.includes('FROM metadata')) {
      const plan = original<{ detail: string }>('EXPLAIN QUERY PLAN ' + sql, ...params);
      indexed = plan.some((row) => /SEARCH metadata USING INDEX/.test(row.detail));
    }
    return original(sql, ...params) as any;
  };
  assert.deepEqual(
    listWatches(f.store, f.session.id).map((w) => w.id),
    ['one'],
  );
  assert.equal(indexed, true, 'Every polling tick must use the existing metadata key index');
});

function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('every flushed sample is appended as one JSON line to the daily history file', (t) => {
  const f = fixture(t),
    now = Date.now();
  const p = new RuntimeProfiler(f.store);
  try {
    p.flush(() => ({}), now, true);
    p.flush(() => ({}), now + 15000, true);
  } finally {
    p.close();
  }
  const file = path.join(f.home, 'performance', `${localDay(now)}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'one line per flush');
  const sample = JSON.parse(lines[0]!);
  assert.equal(sample.pid, process.pid);
  assert.ok('eventLoop' in sample && 'operations' in sample);
  assert.doesNotMatch(
    lines.join(''),
    /version|samples|state/,
    'only the bare sample, not the metadata wrapper',
  );
});

test("the first flush of a new day compresses yesterday's file and never deletes history", (t) => {
  const f = fixture(t),
    day1 = Date.now(),
    day2 = day1 + 86400000;
  const p = new RuntimeProfiler(f.store);
  try {
    p.flush(() => ({}), day1, true);
    p.flush(() => ({}), day1 + 15000, true);
    p.flush(() => ({}), day2, true);
  } finally {
    p.close();
  }
  const dir = path.join(f.home, 'performance');
  const plain = path.join(dir, `${localDay(day1)}.jsonl`);
  const gz = `${plain}.gz`;
  assert.equal(fs.existsSync(plain), false, 'plain file is replaced by the compressed one');
  assert.equal(fs.existsSync(gz), true);
  const restored = zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8').trim().split('\n');
  assert.equal(restored.length, 2, 'both day-1 samples survive compression, nothing dropped');
  assert.equal(fs.existsSync(path.join(dir, `${localDay(day2)}.jsonl`)), true);
});

test('a history write failure is caught, warned at most once, and never breaks flush', (t) => {
  const f = fixture(t),
    now = Date.now();
  fs.writeFileSync(path.join(f.home, 'performance'), 'blocks the history directory');
  const originalError = console.error;
  let warnings = 0;
  console.error = () => {
    warnings++;
  };
  const p = new RuntimeProfiler(f.store);
  try {
    assert.doesNotThrow(() => p.flush(() => ({}), now, true));
    assert.doesNotThrow(() => p.flush(() => ({}), now + 15000, true));
    assert.doesNotThrow(() => p.flush(() => ({}), now + 30000, true));
  } finally {
    p.close();
    console.error = originalError;
  }
  assert.equal(warnings, 1, 'repeated failures log only one warning');
  const meta = f.store.get<{ value: string }>(
    "SELECT value FROM metadata WHERE key='performance:runtime'",
  );
  assert.ok(meta, 'the bounded metadata row still gets written despite the history failure');
});
