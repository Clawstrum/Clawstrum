import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { Store } from '../src/store.js';
import { ensureMemory, updateMemory } from '../src/memory.js';
import { archiveRecord, historyPosition, historyBytes } from '../src/history.js';
import { consolidateMemory } from '../src/consolidation.js';
import { MaintenanceDeferred } from '../src/maintenance-budget.js';

function setup(t: any, review = false) {
  const f = fixture(t);
  ensureMemory(f.store, null);
  ensureMemory(f.store, f.session.id);
  const key = `${review ? 'memory-review' : 'consolidation'}:${f.session.id}`;
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
  const config = {
    ...f.config.runtime.consolidation,
    thresholdBytes: 1,
    chunkChars: 2000,
    maxChunksPerPass: 1,
  };
  const input = { store: f.store, sessionId: f.session.id, config, review, force: true };
  const state = (store = f.store) =>
    JSON.parse(store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key)!.value);
  return { ...f, input, state };
}
function proposal(prompt: string, valid = true) {
  const p = JSON.parse(prompt);
  return JSON.stringify({
    chunk: p.chunk,
    sections: { 'Working understanding': 'Current fact', 'Current work': '', 'Research state': '' },
    sources: valid ? p.sourceParts.map((s: any) => s.ref) : ['unknown-source'],
  });
}

for (const review of [false, true])
  test(`${review ? 'review' : 'consolidation'} keeps rejection records distinct across slices of one history row and restarts`, async (t) => {
    const f = setup(t, review);
    const bytes = historyBytes(f.store, f.session.id, 0);
    const reject = async ({ prompt }: any) => proposal(prompt, false);
    await assert.rejects(consolidateMemory({ ...f.input, call: reject }), /invalid chunk coverage/);
    const first = f.state();
    assert.equal(first.rejections, 1);
    const other = new Store(f.home);
    try {
      await consolidateMemory({
        ...f.input,
        store: other,
        call: async ({ prompt }) => {
          assert.match(JSON.parse(prompt).validationError, /unknown-source/);
          return proposal(prompt);
        },
      });
    } finally {
      other.close();
    }
    const advanced = f.state();
    assert.equal(advanced.cursor, first.cursor);
    assert.ok(advanced.offset > first.offset);
    assert.equal(advanced.rejectedChunk, undefined);
    assert.equal(advanced.rejectedOffset, undefined);
    assert.equal(advanced.lastError, undefined);
    assert.equal(advanced.rejections, undefined);
    await assert.rejects(consolidateMemory({ ...f.input, call: reject }), /invalid chunk coverage/);
    const records = f.store.all<{ id: string; content: string }>(
      'SELECT id,content FROM history_records WHERE kind=?',
      review ? 'memory_review_rejected' : 'consolidation_rejected',
    );
    assert.equal(records.length, 2);
    assert.notEqual(records[0]!.id, records[1]!.id);
    const rejected = records.map((r) => JSON.parse(r.content));
    assert.equal(rejected[0].offset, first.offset);
    assert.equal(rejected[1].offset, advanced.offset);
    assert.notEqual(rejected[0].chunk, rejected[1].chunk);
    assert.equal(
      historyBytes(f.store, f.session.id, 0),
      bytes,
      'Rejected attempts do not increase the rotation byte counter',
    );
  });

for (const change of ['memory rebase', 'chunk resize'])
  test(`feedback belongs to the exact chunk, not the reused cursor after a ${change}`, async (t) => {
    const f = setup(t);
    await assert.rejects(
      consolidateMemory({ ...f.input, call: async ({ prompt }) => proposal(prompt, false) }),
    );
    const cursor = f.state().cursor;
    if (change === 'memory rebase')
      updateMemory(f.store, null, { 'Working understanding': 'Corrected current guidance' });
    else f.input.config.chunkChars = 3000;
    await consolidateMemory({
      ...f.input,
      call: async ({ prompt }) => {
        const p = JSON.parse(prompt);
        assert.equal(f.state().cursor, cursor);
        assert.equal(p.rebasing, change === 'memory rebase');
        assert.equal(
          p.validationError,
          undefined,
          'A different input chunk must not inherit an old coverage error',
        );
        return proposal(prompt);
      },
    });
  });

test('a pacing deferral on the repair call keeps the rejection feedback for the next pass', async (t) => {
  const f = setup(t);
  let rejected = '';
  let calls = 0;
  await assert.rejects(
    consolidateMemory({
      ...f.input,
      call: async ({ prompt }) => {
        if (calls++) throw new MaintenanceDeferred('Maintenance pacing interval', Date.now() + 1);
        rejected = proposal(prompt, false);
        return rejected;
      },
    }),
    MaintenanceDeferred,
  );
  assert.equal(calls, 2);
  assert.equal(f.state().rejections, 1, 'the invalid proposal counts; the deferral adds nothing');
  let seen: any;
  await consolidateMemory({
    ...f.input,
    call: async ({ prompt }) => {
      seen = JSON.parse(prompt);
      return proposal(prompt);
    },
  });
  assert.match(seen.validationError, /unknown-source/);
  assert.equal(seen.previousResponse, rejected);
});

test('paced repairs cannot bypass the rejection cap across passes', async (t) => {
  const f = setup(t);
  for (let pass = 1; pass <= 3; pass++) {
    let calls = 0;
    await assert.rejects(
      consolidateMemory({
        ...f.input,
        call: async ({ prompt }) => {
          if (calls++) throw new MaintenanceDeferred('Maintenance pacing interval', Date.now() + 1);
          return proposal(prompt, false);
        },
      }),
      MaintenanceDeferred,
    );
    assert.equal(f.state().rejections, pass);
  }
  const before = f.state();
  let calls = 0;
  await assert.rejects(
    consolidateMemory({
      ...f.input,
      call: async ({ prompt }) => {
        calls++;
        return proposal(prompt);
      },
    }),
    MaintenanceDeferred,
  );
  assert.equal(calls, 0);
  assert.equal(f.state().cursor, before.cursor);
  assert.equal(f.state().offset, before.offset);
  assert.ok(f.state().blockedUntil >= Date.now() + 5 * 3600000);
});

test('three rejections at one position, even across a rebase, block model calls without skipping coverage', async (t) => {
  const f = setup(t);
  const reject = async ({ prompt }: any) => proposal(prompt, false);
  await assert.rejects(consolidateMemory({ ...f.input, call: reject }), /invalid chunk coverage/);
  await assert.rejects(consolidateMemory({ ...f.input, call: reject }), /invalid chunk coverage/);
  const before = f.state();
  updateMemory(f.store, null, { 'Working understanding': 'Corrected current guidance' });
  let chunk = '';
  await assert.rejects(
    consolidateMemory({
      ...f.input,
      call: async ({ prompt }) => {
        chunk = JSON.parse(prompt).chunk;
        return proposal(prompt, false);
      },
    }),
    /invalid chunk coverage/,
  );
  assert.notEqual(chunk, before.rejectedChunk, 'the rebase changed the chunk identifier');
  assert.equal(f.state().rejections, 3);
  let calls = 0;
  const counting = async ({ prompt }: any) => {
    calls++;
    return proposal(prompt);
  };
  const start = Date.now();
  const blocked = await consolidateMemory({ ...f.input, call: counting }).then(
    () => assert.fail('a blocked chunk must not complete'),
    (error) => error,
  );
  assert.ok(blocked instanceof MaintenanceDeferred);
  assert.ok(blocked.retryAt >= start + 6 * 3600000);
  await assert.rejects(consolidateMemory({ ...f.input, call: counting }), MaintenanceDeferred);
  assert.equal(calls, 0);
  const after = f.state();
  assert.equal(after.cursor, before.cursor);
  assert.equal(after.offset, before.offset);
  assert.equal(after.processed, before.processed);
  assert.equal(
    f.store.all("SELECT id FROM history_records WHERE kind='consolidation_blocked'").length,
    1,
  );
});

for (const review of [false, true])
  test(`a repeat block of the same ${review ? 'review' : 'consolidation'} chunk is archived and saved, not swallowed by an id collision`, async (t) => {
    const f = setup(t, review);
    const reject = async ({ prompt }: any) => proposal(prompt, false);
    await assert.rejects(consolidateMemory({ ...f.input, call: reject }), /invalid chunk coverage/);
    await assert.rejects(consolidateMemory({ ...f.input, call: reject }), /invalid chunk coverage/);
    await assert.rejects(consolidateMemory({ ...f.input, call: reject }), /invalid chunk coverage/);
    const firstBlock = await consolidateMemory({ ...f.input, call: reject }).then(
      () => assert.fail('three rejections at one position must block'),
      (error) => error,
    );
    assert.ok(firstBlock instanceof MaintenanceDeferred);
    const kind = review ? 'memory_review_blocked' : 'consolidation_blocked';
    const firstRows = f.store.all<{ id: string; content: string }>(
      'SELECT id,content FROM history_records WHERE kind=?',
      kind,
    );
    assert.equal(firstRows.length, 1);
    assert.equal(JSON.parse(firstRows[0]!.content).rejections, 3);

    // Force the backoff window closed without waiting hours, so the next pass retries the model
    // instead of throwing the still-blocked MaintenanceDeferred.
    const progressKey = `${review ? 'memory-review' : 'consolidation'}:${f.session.id}`;
    const row = f.store.get<{ value: string }>(
      'SELECT value FROM metadata WHERE key=?',
      progressKey,
    )!;
    f.store.exec(
      'UPDATE metadata SET value=? WHERE key=?',
      JSON.stringify({ ...JSON.parse(row.value), blockedUntil: Date.now() - 1000 }),
      progressKey,
    );

    // The one retry the expired backoff allows is rejected again, growing past blockedRejections
    // while blockedUntil and blockedRejections stay at their stale, already-expired values.
    await assert.rejects(consolidateMemory({ ...f.input, call: reject }), /invalid chunk coverage/);
    assert.equal(f.state().rejections, 4);

    // The next pass must re-block at the same cursor/offset: same id prefix, different content
    // (rejections 4, a new retryAt). Before the fix this threw "History ID already names
    // different content", rolled back the new blockedUntil, and retried forever.
    const secondBlock = await consolidateMemory({ ...f.input, call: reject }).then(
      () => assert.fail('the repeat block must defer, not succeed'),
      (error) => error,
    );
    assert.ok(
      secondBlock instanceof MaintenanceDeferred,
      `expected a clean MaintenanceDeferred, got: ${secondBlock}`,
    );
    const rows = f.store.all<{ id: string; content: string }>(
      'SELECT id,content FROM history_records WHERE kind=?',
      kind,
    );
    assert.equal(rows.length, 2, 'the repeat block is archived, not dropped by an id collision');
    assert.notEqual(rows[0]!.id, rows[1]!.id, 'each block gets a unique, stable archive id');
    assert.equal(JSON.parse(rows[1]!.content).rejections, 4);
    const after = f.state();
    assert.equal(after.blockedRejections, 4);
    assert.ok(
      after.blockedUntil > Date.now(),
      'the repeat block must persist its new retryAt, not roll back on the id collision',
    );
  });
