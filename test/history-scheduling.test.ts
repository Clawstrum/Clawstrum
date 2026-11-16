import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { Store } from '../src/store.js';
import { archiveRecord, historyBytes, historyPosition } from '../src/history.js';
import { memoryReviewDue } from '../src/memory-review.js';
import { createGroup } from '../src/groups/store.js';

test('history scheduling uses scoped covering reads, including shared and group scopes', (t) => {
  const f = fixture(t);
  const other = f.store.ensureSession('123457');
  createGroup(f.store, 'science', 'Science', 'Shared experiments');
  const at = Date.now() - 60000;
  const first = archiveRecord(f.store, {
    id: 'channel-first',
    sessionId: f.session.id,
    kind: 'user',
    content: 'first',
    counted: true,
    at,
  });
  archiveRecord(f.store, {
    id: 'channel-second',
    sessionId: f.session.id,
    kind: 'user',
    content: 'second',
    counted: true,
    at,
  });
  archiveRecord(f.store, {
    id: 'other-channel',
    sessionId: other.id,
    kind: 'user',
    content: 'other'.repeat(10000),
    counted: true,
    at,
  });
  archiveRecord(f.store, {
    id: 'shared',
    sessionId: null,
    kind: 'memory_review_request',
    content: 'shared',
    counted: true,
    at,
  });
  archiveRecord(f.store, {
    id: 'group',
    sessionId: null,
    groupId: 'science',
    kind: 'user',
    content: 'group',
    counted: true,
    at,
  });
  const get = f.store.get.bind(f.store);
  let checked = 0;
  f.store.get = (sql, ...args) => {
    if (sql.includes('FROM history_records')) {
      const plan = f.store
        .all<{ detail: string }>('EXPLAIN QUERY PLAN ' + sql, ...args)
        .map((row) => row.detail)
        .join('\n');
      assert.match(plan, /USING COVERING INDEX history_maintenance/);
      assert.match(plan, /session_id=\? AND group_id=\?/);
      checked++;
    }
    return get(sql, ...args);
  };
  assert.equal(historyBytes(f.store, f.session.id, first.seq), 6);
  assert.equal(historyBytes(f.store, other.id, 0), 50000);
  assert.equal(historyBytes(f.store, null, 0), 6);
  assert.equal(historyBytes(f.store, { groupId: 'science' }, 0), 5);
  assert.ok(historyPosition(f.store, f.session.id) > first.seq);
  assert.equal(
    memoryReviewDue(f.store, f.session.id, f.config.runtime.memoryReview, Date.now()),
    true,
  );
  assert.equal(memoryReviewDue(f.store, null, f.config.runtime.memoryReview, Date.now()), true);
  assert.equal(checked, 7);
});

test('opening an existing schema-5 store adds the maintenance index without changing history or sessions', (t) => {
  const f = fixture(t);
  archiveRecord(f.store, {
    id: 'retained',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Keep all raw evidence.',
    counted: true,
  });
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'native-thread', f.session.id);
  const before = f.store.all('SELECT * FROM history_records ORDER BY seq');
  f.store.db.exec('DROP INDEX history_maintenance');
  const reopened = new Store(f.home);
  try {
    assert.deepEqual(reopened.all('SELECT * FROM history_records ORDER BY seq'), before);
    assert.equal(reopened.session(f.session.id).remote_id, 'native-thread');
    assert.equal(
      reopened.get<{ version: number }>('SELECT version FROM schema_version')?.version,
      6,
    );
    assert.ok(reopened.get("SELECT name FROM sqlite_master WHERE name='history_maintenance'"));
  } finally {
    reopened.close();
  }
});
