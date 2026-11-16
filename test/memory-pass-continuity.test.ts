import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, settle } from './helpers.js';
import { ensureMemory, updateMemory } from '../src/memory.js';
import { archiveRecord, historyPosition } from '../src/history.js';
import { consolidateMemory } from '../src/consolidation.js';
import { consolidationRequestKey } from '../src/compaction.js';
import {
  MaintenanceDeferred,
  maintenanceBudget,
  reserveMaintenanceCall,
} from '../src/maintenance-budget.js';
import { Engine } from '../src/engine.js';

const valid = (prompt: string) => {
  const p = JSON.parse(prompt);
  return JSON.stringify({
    chunk: p.chunk,
    sections: { 'Working understanding': 'Current fact', 'Current work': '', 'Research state': '' },
    sources: p.sourceParts.map((s: any) => s.ref),
  });
};
const invalid = (prompt: string) =>
  JSON.stringify({ ...JSON.parse(valid(prompt)), sources: ['unknown-source'] });

// ---- Fix 1b: the blocked-record write cannot loop -------------------------------------------

test('a block record at a position that was already blocked once does not collide and loop', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  ensureMemory(f.store, f.session.id);
  const key = `consolidation:${f.session.id}`;
  f.store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    `${key}:coverage`,
    String(historyPosition(f.store, f.session.id)),
  );
  archiveRecord(f.store, {
    id: 'long-source',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Complete source text. '.repeat(1000),
    counted: true,
  });
  const input = {
    store: f.store,
    sessionId: f.session.id,
    force: true,
    config: {
      ...f.config.runtime.consolidation,
      thresholdBytes: 1,
      chunkChars: 2000,
      maxChunksPerPass: 1,
    },
  };
  const state = () =>
    JSON.parse(
      f.store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key)!.value,
    );
  const reject = (call = async ({ prompt }: any) => invalid(prompt)) =>
    consolidateMemory({ ...input, call });
  const blockRecords = () =>
    f.store.all<{ id: string }>(
      "SELECT id FROM history_records WHERE kind='consolidation_blocked'",
    );

  // Three rejections of one chunk, then the fourth pass blocks it.
  for (let i = 0; i < 3; i++) await assert.rejects(reject(), /invalid chunk coverage/);
  await assert.rejects(reject(), MaintenanceDeferred);
  assert.equal(blockRecords().length, 1);
  const position = { cursor: state().cursor, offset: state().offset };

  // A memory edit makes the next pass rebase. After the backoff the rebase chunk succeeds, which
  // clears the rejection count but keeps the cursor on the same chunk.
  updateMemory(f.store, null, { 'Working understanding': 'Corrected current guidance' });
  f.store.exec(
    'UPDATE metadata SET value=? WHERE key=?',
    JSON.stringify({ ...state(), blockedUntil: Date.now() - 1 }),
    key,
  );
  await consolidateMemory({ ...input, call: async ({ prompt }) => valid(prompt) });
  assert.equal(state().rejections, undefined);
  assert.deepEqual({ cursor: state().cursor, offset: state().offset }, position);

  // The same chunk is rejected three more times and blocked again: same state id, cursor, offset
  // and rejection count as the first block. This must record a second block and defer, not throw
  // "History ID already names different content" on every scan.
  for (let i = 0; i < 3; i++) await assert.rejects(reject(), /invalid chunk coverage/);
  await assert.rejects(reject(), MaintenanceDeferred);
  assert.equal(blockRecords().length, 2);
  assert.ok(state().blockedUntil > Date.now(), 'the block is saved, so no model call is made');
  let calls = 0;
  await assert.rejects(
    reject(async () => {
      calls++;
      return '{}';
    }),
    MaintenanceDeferred,
  );
  assert.equal(calls, 0);
});

// ---- Fix 1a: a requested pass finishes in a bounded number of calls --------------------------

test('a requested pass with a large backlog reads only the newest chunks and commits', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  ensureMemory(f.store, f.session.id);
  for (let i = 0; i < 60; i++)
    archiveRecord(f.store, {
      id: `backlog-${i}`,
      sessionId: f.session.id,
      kind: 'user',
      content: `backlog ${i} `.padEnd(2000, 'x'),
      counted: true,
    });
  const input: any = {
    store: f.store,
    sessionId: f.session.id,
    force: true,
    requested: true,
    tailChunks: 2,
    config: {
      ...f.config.runtime.consolidation,
      thresholdBytes: 1,
      chunkChars: 2000,
      maxChunksPerPass: 8,
    },
  };
  let calls = 0;
  const seen: string[] = [];
  const result = await consolidateMemory({
    ...input,
    call: async ({ prompt }: any) => {
      calls++;
      for (const part of JSON.parse(prompt).sourceParts) seen.push(part.id);
      return valid(prompt);
    },
  });
  assert.equal(result, 'committed');
  assert.ok(calls <= 4, `bounded calls, got ${calls}`);
  assert.ok(seen.includes('backlog-59'), 'the newest record is summarized');
  assert.ok(!seen.includes('backlog-0'), 'the old backlog is not');
  const skip = f.store.get<{ content: string }>(
    "SELECT content FROM history_records WHERE kind='coverage' AND id LIKE 'consolidation-skip:%'",
  );
  assert.match(skip!.content, /were not summarized into memory/);
  assert.equal(
    f.store.get('SELECT key FROM metadata WHERE key=?', `consolidation:${f.session.id}`),
    undefined,
  );
});

test('a requested pass jumps ahead of a half-done backlog pass and keeps its progress', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  ensureMemory(f.store, f.session.id);
  for (let i = 0; i < 40; i++)
    archiveRecord(f.store, {
      id: `old-${i}`,
      sessionId: f.session.id,
      kind: 'user',
      content: `old ${i} `.padEnd(2000, 'x'),
      counted: true,
    });
  const config = {
    ...f.config.runtime.consolidation,
    thresholdBytes: 1,
    chunkChars: 2000,
    maxChunksPerPass: 1,
  };
  const base: any = { store: f.store, sessionId: f.session.id, force: true, config };
  assert.equal(
    await consolidateMemory({ ...base, call: async ({ prompt }: any) => valid(prompt) }),
    'pending',
  );
  const name = `consolidation:${f.session.id}`;
  const before = JSON.parse(
    f.store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', name)!.value,
  );
  assert.equal(before.processed, 1);
  let calls = 0;
  const result = await consolidateMemory({
    ...base,
    requested: true,
    tailChunks: 2,
    config: { ...config, maxChunksPerPass: 8 },
    call: async ({ prompt }: any) => {
      calls++;
      return valid(prompt);
    },
  });
  assert.equal(result, 'committed');
  assert.ok(calls <= 3, `bounded calls, got ${calls}`);
});

// ---- Fix 1a: backlog cannot starve a requested pass ------------------------------------------

test('the budget keeps a reserve that only requested (priority) calls can use', (t) => {
  const f = fixture(t);
  const now = Date.now();
  // Limit 8, reserve 2: general work may use 6 calls; the last 2 are for requested passes.
  const opts = { reserve: 2 };
  const priority = { ...opts, priority: true };
  for (let i = 0; i < 6; i++)
    reserveMaintenanceCall(
      f.store,
      8,
      i % 2 ? 'consolidator' : 'memory-reviewer',
      now + i,
      0,
      opts,
    );
  assert.equal(maintenanceBudget(f.store, 8, now + 7, 0, opts).available, false);
  assert.throws(
    () => reserveMaintenanceCall(f.store, 8, 'consolidator', now + 7, 0, opts),
    (e: any) => e instanceof MaintenanceDeferred && /reserved for requested passes/.test(e.message),
  );
  assert.equal(maintenanceBudget(f.store, 8, now + 7, 0, priority).available, true);
  reserveMaintenanceCall(f.store, 8, 'consolidator', now + 7, 0, priority);
  reserveMaintenanceCall(f.store, 8, 'consolidator', now + 8, 0, priority);
  assert.throws(
    () => reserveMaintenanceCall(f.store, 8, 'consolidator', now + 9, 0, priority),
    /budget exhausted/,
  );
});

test('a small limit keeps its whole allowance for general work', (t) => {
  const f = fixture(t);
  const now = Date.now();
  reserveMaintenanceCall(f.store, 2, 'consolidator', now, 0, { reserve: 6 });
  reserveMaintenanceCall(f.store, 2, 'consolidator', now + 1, 0, { reserve: 6 });
  assert.equal(maintenanceBudget(f.store, 2, now + 2, 0, { reserve: 6 }).remaining, 0);
});

test('a priority call ignores the pacing interval; a general call does not', (t) => {
  const f = fixture(t);
  const now = Date.now();
  reserveMaintenanceCall(f.store, 24, 'memory-reviewer', now, 1800000);
  assert.equal(maintenanceBudget(f.store, 24, now + 1000, 1800000).available, false);
  assert.equal(
    maintenanceBudget(f.store, 24, now + 1000, 1800000, { priority: true }).available,
    true,
  );
});

test('with the budget used up by backlog work, a requested channel still gets its pass', async (t) => {
  const f = fixture(t);
  // The fixture channel is the older one and holds the compaction request; the engine scans the
  // newest channel first, and that one has a backlog that is due.
  const backlog = f.store.ensureSession('555111');
  ensureMemory(f.store, null);
  ensureMemory(f.store, f.session.id);
  ensureMemory(f.store, backlog.id);
  f.config.runtime.memoryReview.enabled = false;
  f.config.runtime.maintenance.scanIntervalMs = 0;
  f.config.runtime.maintenance.maxCallsPerDay = 16;
  f.config.runtime.maintenance.requestedReserve = 4;
  f.config.runtime.consolidation.thresholdBytes = 1;
  for (const id of [f.session.id, backlog.id])
    archiveRecord(f.store, {
      id: `src-${id}`,
      sessionId: id,
      kind: 'user',
      content: 'Run 4711 uses partition shared.',
      counted: true,
    });
  archiveRecord(f.store, {
    id: 'summary',
    sessionId: f.session.id,
    kind: 'compaction_summary',
    content: 'Native compaction summary. Run 4711.',
  });
  f.store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    consolidationRequestKey(f.session.id),
    JSON.stringify({ reason: 'compaction' }),
  );
  // Twelve calls already spent today: the whole general share of a 16-call limit with a reserve of 4.
  for (let i = 0; i < 12; i++)
    reserveMaintenanceCall(f.store, 16, 'memory-reviewer', Date.now() - 3600000 + i, 0, {
      priority: true,
    });
  const sessions: string[] = [];
  const provider = {
    async run(r: any) {
      const p = JSON.parse(r.prompt);
      sessions.push(r.usageScope);
      return JSON.stringify({
        chunk: p.chunk,
        sections: {
          'Working understanding': 'Run 4711 uses partition shared.',
          'Current work': '',
          'Research state': '',
        },
        sources: p.sourceParts.map((s: any) => s.ref),
      });
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  try {
    engine.tick();
    await Promise.all([...engine.consolidations]);
    assert.deepEqual([...new Set(sessions)], [f.session.id]);
    assert.equal(
      f.store.get('SELECT key FROM metadata WHERE key=?', consolidationRequestKey(f.session.id)),
      undefined,
    );
    assert.equal(f.store.session(f.session.id).remote_id, null);
    assert.equal(
      f.store.get('SELECT key FROM metadata WHERE key=?', `consolidation:${backlog.id}`),
      undefined,
    );
  } finally {
    await settle(engine);
  }
});
