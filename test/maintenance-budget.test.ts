import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, settle } from './helpers.js';
import { Store } from '../src/store.js';
import {
  initializeMaintenanceBudget,
  maintenanceBudget,
  reserveMaintenanceCall,
  MaintenanceDeferred,
} from '../src/maintenance-budget.js';
import { Engine } from '../src/engine.js';
import { ensureMemory, updateMemory } from '../src/memory.js';
import { archiveRecord } from '../src/history.js';
import { consolidateMemory, consolidationCoverage } from '../src/consolidation.js';

const DAY = 86400000;
test('maintenance reservations are global, rolling, durable and shared by database connections', (t) => {
  const f = fixture(t),
    now = Date.now();
  assert.equal(f.config.runtime.maintenance.maxCallsPerDay, 24);
  assert.equal(f.config.runtime.maintenance.minIntervalMs, 1800000);
  initializeMaintenanceBudget(f.store, now);
  reserveMaintenanceCall(f.store, 2, 'consolidator', now);
  const other = new Store(f.home);
  try {
    reserveMaintenanceCall(other, 2, 'memory-reviewer', now + 1000);
    assert.throws(
      () => reserveMaintenanceCall(f.store, 2, 'group_reviewer', now + 2000),
      MaintenanceDeferred,
    );
    initializeMaintenanceBudget(other, now + 3000);
    assert.equal(maintenanceBudget(other, 2, now + 3000).remaining, 0);
    assert.equal(maintenanceBudget(other, 2, now + 3000).nextAvailableAt, now + DAY);
    assert.equal(maintenanceBudget(other, 2, now + DAY).remaining, 1);
    assert.throws(
      () => reserveMaintenanceCall(other, 0, 'consolidator', now + DAY),
      MaintenanceDeferred,
    );
    reserveMaintenanceCall(other, 2, 'group_reviewer', now + DAY);
    assert.equal(maintenanceBudget(f.store, 2, now + DAY).used, 2);
  } finally {
    other.close();
  }
});

test('upgrade seeds prior maintenance usage instead of granting another call allowance', (t) => {
  const f = fixture(t),
    now = Date.now();
  for (const [id, role, at] of [
    ['a', 'consolidator', now - 1000],
    ['b', 'memory-reviewer', now - 500],
    ['c', 'lead', now],
    ['d', 'consolidator', now - DAY - 1],
  ] as const)
    f.store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?)',
      'usage:' + id,
      JSON.stringify({ role, updatedAt: at }),
    );
  initializeMaintenanceBudget(f.store, now);
  assert.equal(maintenanceBudget(f.store, 2, now).used, 2);
  assert.throws(() => reserveMaintenanceCall(f.store, 2, 'consolidator', now), MaintenanceDeferred);
  // New usage updates must not double-charge an invocation already reserved under the new ledger.
  f.store.exec(
    'UPDATE metadata SET value=? WHERE key=?',
    JSON.stringify({ role: 'consolidator', updatedAt: now }),
    'usage:a',
  );
  initializeMaintenanceBudget(f.store, now);
  assert.equal(maintenanceBudget(f.store, 2, now).used, 2);
});

test('invalid consolidation repairs consume budget and stop before a third provider dispatch', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  ensureMemory(f.store, f.session.id);
  f.config.runtime.memoryReview.enabled = false;
  f.config.runtime.consolidation.thresholdBytes = 1;
  f.config.runtime.maintenance.maxCallsPerDay = 2;
  f.config.runtime.maintenance.minIntervalMs = 0;
  archiveRecord(f.store, {
    id: 'old',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Remember the result',
    counted: true,
  });
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'keep-native', f.session.id);
  let calls = 0;
  const provider = {
    async run() {
      calls++;
      return '{bad json';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  try {
    engine.tick();
    await Promise.all([...engine.consolidations]);
    assert.equal(calls, 2);
    assert.equal(maintenanceBudget(f.store, 2).remaining, 0);
    engine.tick(Date.now() + 120000);
    await Promise.all([...engine.consolidations]);
    assert.equal(calls, 2);
    assert.equal(consolidationCoverage(f.store, f.session.id), 0);
    assert.equal(f.store.session(f.session.id).remote_id, 'keep-native');
    // Requested conversation work still runs when the maintenance allowance is empty.
    f.enqueue('human request');
    engine.tick();
    await settle(engine);
    assert.equal(calls, 3);
  } finally {
    await engine.stop();
  }
});

test('a new memory revision reconciles the saved summary without replaying processed history', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  ensureMemory(f.store, f.session.id);
  for (let i = 0; i < 3; i++)
    archiveRecord(f.store, {
      id: 'source-' + i,
      sessionId: f.session.id,
      kind: 'user',
      content: ('source-' + i + ' ').repeat(180),
      counted: true,
    });
  const config = {
    ...f.config.runtime.consolidation,
    thresholdBytes: 1,
    chunkChars: 2000,
    maxChunksPerPass: 1,
  };
  const seen: any[] = [];
  const call = async ({ prompt }: any) => {
    const p = JSON.parse(prompt);
    seen.push(p);
    return JSON.stringify({
      chunk: p.chunk,
      sections: {
        'Working understanding': p.rebasing ? 'Use corrected method' : 'Earlier evidence retained',
        'Current work': '',
        'Research state': '',
      },
      sources: p.sourceParts.map((s: any) => s.ref),
    });
  };
  await consolidateMemory({ store: f.store, sessionId: f.session.id, config, call });
  const key = 'consolidation:' + f.session.id;
  const prior = JSON.parse(f.store.get<any>('SELECT value FROM metadata WHERE key=?', key).value);
  assert.ok(prior.cursor > prior.after + 1 || prior.offset > 0);
  updateMemory(f.store, f.session.id, { 'Working understanding': 'Use corrected method' });
  await consolidateMemory({ store: f.store, sessionId: f.session.id, config, call });
  const after = JSON.parse(f.store.get<any>('SELECT value FROM metadata WHERE key=?', key).value);
  assert.equal(seen[1].rebasing, true);
  assert.match(JSON.stringify(seen[1].sourceParts), /Use corrected method/);
  assert.equal(after.cursor, prior.cursor);
  assert.equal(after.offset, prior.offset);
  assert.equal(after.processed, prior.processed + 1);
  assert.equal(after.sections['Working understanding'], 'Use corrected method');
  await consolidateMemory({ store: f.store, sessionId: f.session.id, config, call });
  assert.equal(seen[2].rebasing, false);
  assert.notDeepEqual(seen[2].sourceParts, seen[0].sourceParts);
  assert.equal(consolidationCoverage(f.store, f.session.id), 0);
  // A second edit during the same consolidation has its own immutable conflict record.
  const beforeSecond = JSON.parse(
    f.store.get<any>('SELECT value FROM metadata WHERE key=?', key).value,
  );
  updateMemory(f.store, null, { 'Working understanding': 'Updated shared guidance' });
  await consolidateMemory({ store: f.store, sessionId: f.session.id, config, call });
  const second = JSON.parse(f.store.get<any>('SELECT value FROM metadata WHERE key=?', key).value);
  assert.equal(seen[3].rebasing, true);
  assert.equal(second.cursor, beforeSecond.cursor);
  assert.equal(second.offset, beforeSecond.offset);
  assert.equal(
    f.store.all("SELECT id FROM history_records WHERE kind='consolidation_conflict'").length,
    2,
  );
});

test('queued human input blocks maintenance in other idle channels despite spare capacity', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  f.config.runtime.memoryReview.enabled = false;
  f.config.runtime.consolidation.enabled = false;
  f.config.runtime.consolidation.thresholdBytes = 1;
  f.config.runtime.maxConcurrent = 4;
  let calls = 0;
  const provider = {
    async run(r: any) {
      calls++;
      return new Promise<string>((_, reject) =>
        r.controller.signal.addEventListener('abort', () => reject(r.controller.signal.reason), {
          once: true,
        }),
      );
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  try {
    f.enqueue('first');
    engine.tick();
    // Let the first provider start; it does not support live input injection.
    for (let i = 0; i < 30 && !calls; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(calls, 1);
    const idle = f.store.ensureSession('765432');
    ensureMemory(f.store, idle.id);
    archiveRecord(f.store, {
      id: 'idle-backlog',
      sessionId: idle.id,
      kind: 'user',
      content: 'Pending history',
      counted: true,
    });
    f.config.runtime.consolidation.enabled = true;
    f.enqueue('followup');
    engine.tick();
    await Promise.all([...engine.consolidations]);
    assert.equal(
      f.store.get<any>("SELECT status FROM inbound WHERE id='followup'").status,
      'queued',
    );
    assert.equal(calls, 1);
    assert.equal(maintenanceBudget(f.store, 48).used, 0);
  } finally {
    await engine.stop();
  }
});

test('maintenance pacing survives restart, spans roles and never charges deferred attempts', (t) => {
  const f = fixture(t),
    now = Date.now(),
    interval = 1800000;
  initializeMaintenanceBudget(f.store, now);
  assert.equal(maintenanceBudget(f.store, 24, now, interval).available, true);
  reserveMaintenanceCall(f.store, 24, 'consolidator', now, interval);
  const other = new Store(f.home);
  try {
    initializeMaintenanceBudget(other, now + 1000);
    const status = maintenanceBudget(other, 24, now + 1000, interval);
    assert.equal(status.remaining, 23);
    assert.equal(status.available, false);
    assert.equal(status.nextAvailableAt, now + interval);
    for (const role of ['consolidator', 'memory-reviewer', 'group_reviewer'])
      assert.throws(
        () => reserveMaintenanceCall(other, 24, role, now + interval - 1, interval),
        (e: any) => e instanceof MaintenanceDeferred && e.retryAt === now + interval,
      );
    assert.equal(maintenanceBudget(other, 24, now + interval, interval).used, 1);
    reserveMaintenanceCall(other, 24, 'memory-reviewer', now + interval, interval);
    assert.equal(maintenanceBudget(f.store, 24, now + interval, interval).used, 2);
    assert.equal(
      maintenanceBudget(f.store, 24, now + interval, interval).nextAvailableAt,
      now + 2 * interval,
    );
    // Lowering an existing daily cap does not grant new calls or ignore pacing.
    assert.equal(
      maintenanceBudget(f.store, 1, now + interval, interval).nextAvailableAt,
      now + interval + DAY,
    );
    assert.equal(maintenanceBudget(f.store, 24, now + DAY + interval, interval).available, true);
  } finally {
    other.close();
  }
});

test('pacing defers consolidation repairs before a second provider call and retains native history', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  ensureMemory(f.store, f.session.id);
  f.config.runtime.memoryReview.enabled = false;
  f.config.runtime.consolidation.thresholdBytes = 1;
  archiveRecord(f.store, {
    id: 'paced-source',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Saved evidence',
    counted: true,
  });
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'keep-native', f.session.id);
  let calls = 0;
  const provider = {
    async run() {
      calls++;
      return '{bad json';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  try {
    engine.tick();
    await Promise.all([...engine.consolidations]);
    assert.equal(calls, 1);
    engine.tick();
    await Promise.all([...engine.consolidations]);
    assert.equal(calls, 1);
    assert.equal(maintenanceBudget(f.store, 24).used, 1);
    assert.equal(consolidationCoverage(f.store, f.session.id), 0);
    assert.equal(f.store.session(f.session.id).remote_id, 'keep-native');
    assert.ok(f.store.get('SELECT id FROM history_records WHERE id=?', 'paced-source'));
  } finally {
    await engine.stop();
  }
});
