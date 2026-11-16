import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

test('pendingOutbox reads pending rows through an index, not a full outbox scan', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-test-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new Store(home);
  t.after(() => store.db.close());
  const plan = store
    .all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT o.* FROM outbox o WHERE o.status='pending' AND o.available_at<=?
       AND NOT EXISTS(SELECT 1 FROM outbox p WHERE p.session_id=o.session_id AND p.status='pending'
       AND p.created_at<o.created_at) ORDER BY o.created_at LIMIT 20`,
      0,
    )
    .map((row) => row.detail);
  assert.ok(
    plan.some((d) => /SEARCH (TABLE )?(outbox AS )?o USING INDEX outbox_pending/.test(d)),
    plan.join('\n'),
  );
  assert.ok(!plan.some((d) => /SCAN (TABLE )?(outbox AS )?[op]\b/.test(d)), plan.join('\n'));
  assert.deepEqual(store.pendingOutbox(), []);
});

test('metadata prefix lookups with LIKE use the primary-key index, not a full metadata scan', (t) => {
  // With case-insensitive LIKE every `key LIKE 'worker-steer:<id>:%'` read the whole metadata
  // table (266k rows on NFS in one deployment), about 1 s each, and the daemon stopped answering Discord.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-test-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new Store(home);
  t.after(() => store.db.close());
  store.exec(
    "INSERT INTO metadata(key,value) VALUES ('worker-steer:a:1','1'),('worker-steer:b:1','2')",
  );
  const plan = store
    .all<{
      detail: string;
    }>(
      'EXPLAIN QUERY PLAN SELECT value FROM metadata WHERE key LIKE ? ORDER BY key',
      'worker-steer:a:%',
    )
    .map((row) => row.detail);
  assert.ok(
    plan.some((d) => /SEARCH (TABLE )?metadata USING/.test(d)),
    plan.join('\n'),
  );
  assert.ok(!plan.some((d) => /SCAN (TABLE )?metadata\b/.test(d)), plan.join('\n'));
  assert.deepEqual(
    store
      .all<{
        value: string;
      }>('SELECT value FROM metadata WHERE key LIKE ? ORDER BY key', 'worker-steer:a:%')
      .map((row) => row.value),
    ['1'],
  );
});
