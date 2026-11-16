import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { configSchema } from '../src/config.js';
import { ensureMemory } from '../src/memory.js';
import { archiveRecord } from '../src/history.js';
import {
  consolidateMemory,
  consolidationCoverage,
  DAILY_CONSOLIDATION_INSTRUCTIONS,
} from '../src/consolidation.js';
import { Engine } from '../src/engine.js';
import { memoryReviewDue } from '../src/memory-review.js';
import {
  MaintenanceDeferred,
  maintenanceBudget,
  reserveMaintenanceCall,
} from '../src/maintenance-budget.js';
import {
  dailyInProgress,
  dailyKey,
  localDayHour,
  lastDailyPass,
  resolveDailyConfig,
} from '../src/daily-consolidation.js';

const DAY = 86400000;
// Days that start tomorrow (UTC), so every fake clock is after the real one and the 60 s retry
// timers, which use the real clock, never block a later fake day.
const base = Math.ceil(Date.now() / DAY) * DAY + DAY;
const at = (day: number, hour: number) => base + day * DAY + hour * 3600000;

function setup(t: any, opts: { sessions?: string[] } = {}) {
  const f = fixture(t);
  ensureMemory(f.store, null);
  ensureMemory(f.store, f.session.id);
  f.config.runtime.consolidation.daily = {
    enabled: true,
    hour: 4,
    timezone: 'UTC',
    maxCallsPerDay: 120,
    tailChunks: 8,
  };
  f.config.runtime.memoryReview.enabled = false;
  f.config.runtime.maintenance.scanIntervalMs = 0;
  f.config.runtime.maintenance.minIntervalMs = 0;
  const ids = [f.session.id];
  for (const channel of opts.sessions ?? []) {
    const s = f.store.ensureSession(channel);
    ensureMemory(f.store, s.id);
    ids.push(s.id);
  }
  const requests: any[] = [];
  const provider = {
    async run(r: any) {
      requests.push(r);
      if (!r.toolless) return 'done';
      const p = JSON.parse(r.prompt);
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
  const engine = () => new Engine(f.config, f.store, { claude: provider, codex: provider });
  const say = (sessionId: string | null, id: string, kind = 'user') =>
    archiveRecord(f.store, {
      id,
      sessionId,
      kind,
      content: `Run 4711 uses partition shared. ${id}`,
      counted: true,
    });
  // Reservations use the real clock, but these tests tick a fake one. Move the reservations made so
  // far to the fake time, so the rolling 24 hour window behaves as it would in a real day.
  const moveReservations = (to: number) => {
    const key = 'maintenance-budget:v1';
    const rows = JSON.parse(
      f.store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key)!.value,
    );
    f.store.exec(
      'UPDATE metadata SET value=? WHERE key=?',
      JSON.stringify(rows.map((row: any) => ({ ...row, at: to }))),
      key,
    );
  };
  const run = async (e: Engine, now: number) => {
    e.tick(now);
    await Promise.all([...e.consolidations]);
  };
  return { f, ids, requests, engine, say, run, moveReservations };
}

test('defaults: daily pass on at 4 local hours with 120 calls, byte trigger off, age-only review off', () => {
  const config = configSchema.parse({
    version: 1,
    discord: { ownerIds: ['123456'], channelIds: ['987654'], guildId: '555555', allowDMs: false },
    accounts: [{ id: 'a', provider: 'claude', home: '/tmp/a' }],
  });
  assert.deepEqual(config.runtime.consolidation.daily, {
    enabled: true,
    hour: 4,
    maxCallsPerDay: 120,
    tailChunks: 8,
  });
  assert.equal(config.runtime.consolidation.thresholdBytes, 0);
  assert.equal(config.runtime.memoryReview.intervalMs, 0);
  assert.equal(config.runtime.maintenance.maxCallsPerDay, 24);
  assert.throws(
    () =>
      configSchema.parse({
        version: 1,
        discord: { ownerIds: ['1'], channelIds: ['2'], guildId: '3', allowDMs: false },
        accounts: [{ id: 'a', provider: 'claude', home: '/tmp/a' }],
        runtime: { consolidation: { daily: { timezone: 'Not/AZone' } } },
      }),
    /IANA time zone/,
  );
});

test('an unset daily timezone falls back to runtime.timezone, then the host zone', () => {
  const parse = (runtime: object) =>
    configSchema.parse({
      version: 1,
      discord: { ownerIds: ['123456'], channelIds: ['987654'], guildId: '555555', allowDMs: false },
      accounts: [{ id: 'a', provider: 'claude', home: '/tmp/a' }],
      runtime,
    }).runtime;
  assert.equal(resolveDailyConfig(parse({ timezone: 'Europe/Berlin' })).timezone, 'Europe/Berlin');
  assert.equal(
    resolveDailyConfig(
      parse({ timezone: 'Europe/Berlin', consolidation: { daily: { timezone: 'Asia/Tokyo' } } }),
    ).timezone,
    'Asia/Tokyo',
  );
  assert.equal(
    resolveDailyConfig(parse({})).timezone,
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
});

test('the daily pass runs once per local day, after the hour, when idle, and never rotates the session', async (t) => {
  const { f, ids, requests, engine, say, run } = setup(t);
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'native-1', ids[0]);
  say(ids[0]!, 'u1');
  const e = engine();
  try {
    // 03:00 UTC is before the configured hour 4.
    await run(e, at(0, 3));
    assert.equal(requests.length, 0);
    await run(e, at(0, 5));
    assert.equal(requests.length, 1);
    const call = requests[0];
    assert.equal(call.toolless, true);
    assert.equal(call.usageScope, ids[0]);
    assert.match(call.instructions, /daily memory pass/);
    assert.ok(JSON.parse(call.prompt).noteIndex);
    // Not rotated: the native session id is still there. Coverage and the day are recorded.
    assert.equal(f.store.session(ids[0]!).remote_id, 'native-1');
    assert.ok(consolidationCoverage(f.store, ids[0]!) > 0);
    assert.equal(lastDailyPass(f.store, ids[0]!)?.day, localDayHour(at(0, 5), 'UTC').day);
    // New history the same day does not start a second pass.
    say(ids[0]!, 'u2');
    await run(e, at(0, 9));
    assert.equal(requests.length, 1);
  } finally {
    await e.stop();
  }
  // A restart (a new engine on the same database) does not repeat it the same day.
  const restarted = engine();
  try {
    await run(restarted, at(0, 20));
    assert.equal(requests.length, 1);
    // The next local day, with the new history, runs once more, again without rotating.
    await run(restarted, at(1, 5));
    assert.equal(requests.length, 2);
    assert.equal(f.store.session(ids[0]!).remote_id, 'native-1');
  } finally {
    await restarted.stop();
  }
});

test('a channel with no new history since its last daily pass is skipped', async (t) => {
  const { f, ids, requests, engine, say, run } = setup(t);
  say(ids[0]!, 'u1');
  const e = engine();
  try {
    await run(e, at(0, 5));
    assert.equal(requests.length, 1);
    // Day 2 and 3 have nothing new (the pass's own bookkeeping records do not count).
    await run(e, at(1, 5));
    await run(e, at(2, 5));
    assert.equal(requests.length, 1);
    say(ids[0]!, 'u2');
    await run(e, at(3, 5));
    assert.equal(requests.length, 2);
  } finally {
    await e.stop();
  }
  assert.ok(f.store.get('SELECT key FROM metadata WHERE key=?', dailyKey(ids[0]!)));
});

test('a busy channel waits: no daily pass while a message is queued', async (t) => {
  const { f, ids, requests, engine, say, run } = setup(t);
  say(ids[0]!, 'u1');
  f.store.enqueue({
    id: 'queued',
    sessionId: ids[0]!,
    author: 'owner',
    content: 'queued',
    at: Date.now() - 1000,
  });
  const e = engine();
  try {
    // The queued message makes the lead run first; the daily pass never starts in the same tick.
    e.tick(at(0, 5));
    await Promise.all([...e.consolidations]);
    assert.equal(requests.filter((r) => r.toolless).length, 0);
  } finally {
    await e.stop();
  }
});

test('the shared scope gets its own daily pass once a day', async (t) => {
  const { f, requests, engine, say, run } = setup(t);
  // Only shared-scope activity exists; the channel has none.
  say(null, 'shared-request', 'memory_review_request');
  const e = engine();
  try {
    await run(e, at(0, 5));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].usageScope, 'shared');
    assert.ok(lastDailyPass(f.store, null));
    await run(e, at(0, 8));
    assert.equal(requests.length, 1);
  } finally {
    await e.stop();
  }
});

test('the daily pass has its own call cap, separate from the shared maintenance cap', async (t) => {
  const { f, ids, requests, engine, say, run, moveReservations } = setup(t, {
    sessions: ['555111'],
  });
  f.config.runtime.consolidation.daily.maxCallsPerDay = 1;
  say(ids[0]!, 'u1');
  say(ids[1]!, 'u2');
  // The shared cap is already used up by the memory reviewer. The daily pass must still run.
  for (let i = 0; i < 24; i++)
    reserveMaintenanceCall(f.store, 24, 'memory-reviewer', Date.now() - 1000 + i, 0, {
      priority: true,
    });
  assert.equal(maintenanceBudget(f.store, 24, Date.now()).available, false);
  const e = engine();
  try {
    await run(e, at(0, 5));
    moveReservations(at(0, 5));
    assert.equal(requests.length, 1, 'one channel used the single daily call');
    // Same day: the other channel waits for the next window, and this is logged once.
    await run(e, at(0, 6));
    await run(e, at(0, 7));
    assert.equal(requests.length, 1);
    const logged = f.store
      .all<{
        type: string;
        content: string;
      }>("SELECT type,content FROM events WHERE type='consolidation_deferred'")
      .filter((row) => /Daily consolidation call cap/.test(row.content));
    assert.equal(logged.length, 1);
    // The daily call did not touch the shared bucket, and the reviewer's calls did not touch the daily one.
    const now = at(0, 7);
    assert.equal(maintenanceBudget(f.store, 24, now).used, 24);
    assert.equal(maintenanceBudget(f.store, 1, now, 0, { daily: true }).used, 1);
    // A day later the daily window has rolled over (the call itself reserves on the real clock, so
    // age the reservations instead), and the waiting channel runs.
    moveReservations(Date.now() - 2 * DAY);
    await run(e, at(1, 5));
    assert.equal(requests.length, 2);
    assert.deepEqual(
      ids.map((id) => consolidationCoverage(f.store, id) > 0),
      [true, true],
    );
  } finally {
    await e.stop();
  }
});

test('the daily and shared call buckets are counted apart', (t) => {
  const f = fixture(t);
  const now = Date.now();
  reserveMaintenanceCall(f.store, 1, 'consolidator', now, 0, { daily: true });
  assert.throws(
    () => reserveMaintenanceCall(f.store, 1, 'consolidator', now, 0, { daily: true }),
    (error: any) =>
      error instanceof MaintenanceDeferred && /Daily consolidation call cap/.test(error.message),
  );
  // The shared bucket is untouched.
  assert.equal(maintenanceBudget(f.store, 1, now).used, 0);
  reserveMaintenanceCall(f.store, 1, 'memory-reviewer', now);
  assert.equal(maintenanceBudget(f.store, 1, now).used, 1);
  assert.equal(maintenanceBudget(f.store, 1, now, 0, { daily: true }).used, 1);
});

test('the byte-threshold trigger is off by default and still works when set', async (t) => {
  const { f, ids, requests, engine, say, run } = setup(t);
  f.config.runtime.consolidation.daily.enabled = false;
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'native-1', ids[0]);
  say(ids[0]!, 'u1');
  assert.equal(f.config.runtime.consolidation.thresholdBytes, 0);
  const e = engine();
  try {
    await run(e, at(0, 5));
    assert.equal(requests.length, 0);
    assert.equal(f.store.session(ids[0]!).remote_id, 'native-1');
    // Switching it on restores the old rotating pass.
    f.config.runtime.consolidation.thresholdBytes = 1;
    await run(e, at(0, 6));
    assert.equal(requests.length, 1);
    assert.equal(f.store.session(ids[0]!).remote_id, null);
  } finally {
    await e.stop();
  }
});

test('the memory reviewer no longer runs on age alone, but still runs on activity', (t) => {
  const f = fixture(t);
  ensureMemory(f.store, f.session.id);
  const review = f.config.runtime.memoryReview;
  assert.equal(review.intervalMs, 0);
  f.store.exec('UPDATE sessions SET created_at=?', Date.now() - 10 * DAY);
  const later = Date.now() + 5 * DAY;
  assert.equal(memoryReviewDue(f.store, f.session.id, review, later), false);
  // The option still exists: a positive interval restores the age-only run.
  assert.equal(memoryReviewDue(f.store, f.session.id, { ...review, intervalMs: DAY }, later), true);
  // Event-driven runs are unchanged: a user message and the debounce make a review due.
  archiveRecord(f.store, {
    id: 'u1',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Run 4711 uses partition shared.',
    counted: true,
  });
  assert.equal(memoryReviewDue(f.store, f.session.id, review, Date.now() + 60000), true);
});

test('an unfinished daily pass stays a daily pass (no rotation) when it is resumed', async (t) => {
  const { f, ids, say } = setup(t);
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'native-1', ids[0]);
  say(ids[0]!, 'u1');
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: ids[0]!,
      config: f.config.runtime.consolidation,
      force: true,
      daily: true,
      rotate: false,
      call: async () => {
        throw new MaintenanceDeferred('cap', Date.now() + 1000);
      },
    }),
    MaintenanceDeferred,
  );
  assert.equal(dailyInProgress(f.store, ids[0]!), true);
  assert.equal(f.store.session(ids[0]!).remote_id, 'native-1');
});

test('the daily instructions say what the pass must do, in plain words', () => {
  const text = DAILY_CONSOLIDATION_INSTRUCTIONS;
  assert.match(text, /daily memory pass/);
  assert.match(text, /new history/);
  assert.match(text, /reusable knowledge/);
  assert.match(text, /#### Reusable knowledge/);
  assert.match(text, /memory reviewer already checks/);
  assert.match(text, /word target and the advice to be concise/);
  assert.match(text, /Never remove a line only to save space/);
  assert.match(text, /Add durable facts/);
  assert.match(text, /research note id/);
  assert.match(text, /Never invent facts/);
  assert.match(text, /\[source:REF\]/);
  assert.doesNotMatch(text, /[\u2013\u2014]/);
});
