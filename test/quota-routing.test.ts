import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountPool, ProviderFailure, accountRoute } from '../src/accounts.js';
import { Engine } from '../src/engine.js';
import type { Provider } from '../src/types.js';
import { fixture, settle } from './helpers.js';

test('unknown migrated model is initialized without a false switch notice', async (t) => {
  const f = fixture(t);
  f.config.accounts[0]!.model = 'high';
  f.store.exec('UPDATE sessions SET active_account=? WHERE id=?', 'a', f.session.id);
  const p: Provider = {
    async run() {
      return 'Done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('first');
  engine.tick();
  await settle(engine);
  assert.equal(f.store.session(f.session.id).active_model, 'high');
  assert.equal(
    f.store.get<any>("SELECT count(*) n FROM outbox WHERE dedupe_key LIKE 'handoff:%'").n,
    0,
  );
});

test('switch notices use actual previous models and the configured operator channel without threads', async (t) => {
  const f = fixture(t);
  f.config.discord.noticeChannelId = '222222';
  f.config.accounts[0]!.model = 'base';
  f.config.accounts[1]!.model = 'new';
  f.store.exec(
    'UPDATE sessions SET active_account=?,active_model=?,preferred_account=? WHERE id=?',
    'a',
    'fallback',
    'b',
    f.session.id,
  );
  const noticeSession = f.store.ensureSession('222222');
  f.store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    `discord-request:${noticeSession.id}`,
    JSON.stringify({ messageId: '333333' }),
  );
  const p: Provider = {
    async run() {
      return 'Done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('first');
  engine.tick();
  await settle(engine);
  const notice = f.store.get<any>("SELECT * FROM outbox WHERE dedupe_key LIKE 'handoff:%'");
  assert.equal(notice.session_id, noticeSession.id);
  assert.match(notice.content, /a \(fallback\) to b \(new\)/);
  assert.deepEqual(
    JSON.parse(
      f.store.get<any>('SELECT value FROM metadata WHERE key=?', `notice-source:${notice.id}`)
        .value,
    ),
    { channelId: '987654' },
  );
  assert.equal(f.store.noticeThread(notice.id), undefined);
});

test('known provider-default routes still report real model changes after migration', async (t) => {
  const f = fixture(t);
  f.store.exec('UPDATE sessions SET active_account=? WHERE id=?', 'a', f.session.id);
  f.store.event(f.session.id, null, 'route', { account: 'a', model: 'provider default' });
  f.config.accounts[0]!.model = 'high';
  const p: Provider = {
    async run() {
      return 'Done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('first');
  engine.tick();
  await settle(engine);
  assert.match(
    f.store.get<any>("SELECT content FROM outbox WHERE dedupe_key LIKE 'handoff:%'").content,
    /a \(provider default\) to a \(high\)/,
  );
});

test('distinct fallback transitions within one run each produce a notice', async (t) => {
  const f = fixture(t);
  const a = f.config.accounts[0]!;
  a.model = 'high';
  a.quotaBuckets = ['high_weekly'];
  a.modelFallbacks = [{ model: 'low', quotaBuckets: [] }];
  f.store.exec(
    'UPDATE sessions SET preferred_account=?,active_account=?,active_model=? WHERE id=?',
    'a',
    'a',
    'high',
    f.session.id,
  );
  const p: Provider = {
    async run(r) {
      if (r.account.id === 'a')
        throw new ProviderFailure(
          'quota',
          'full',
          Date.now() + 60000,
          r.account.model === 'high' ? 'high_weekly' : undefined,
        );
      return 'Done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('first');
  engine.tick();
  await settle(engine);
  const notices = f.store.all<any>(
    "SELECT content FROM outbox WHERE dedupe_key LIKE 'handoff:%' ORDER BY rowid",
  );
  assert.equal(notices.length, 2);
  assert.match(notices[0].content, /a \(high\) to a \(low\)/);
  assert.match(notices[1].content, /a \(low\) to b/);
});

test('automatic routing chooses measured headroom with stable ties and explicit preference override', (t) => {
  const f = fixture(t),
    now = Date.now();
  const pool = new AccountPool(f.config.accounts, f.store, 60000, 0.9);
  const [a, b] = f.config.accounts;
  const report = (account: typeof a, value: number) =>
    pool.quota(
      account!,
      { rejected: false, bucket: 'five_hour', utilization: value, resetsAt: now + 600000 },
      0.95,
      now,
    );
  report(a, 0.8);
  report(b, 0.2);
  assert.equal(pool.choose(null, a!.id, new Set(), now)!.id, b!.id);
  assert.equal(pool.choose(a!.id, b!.id, new Set(), now)!.id, a!.id);
  report(a, 0.23);
  assert.equal(pool.choose(null, a!.id, new Set(), now)!.id, a!.id);
  assert.equal(pool.choose(null, a!.id, new Set([accountRoute(a!)]), now)!.id, b!.id);
  assert.equal(pool.choose(null, a!.id, new Set(), now + 600001)!.id, a!.id);
});

test('automatic routing treats missing percentages as unknown and tries primary models before fallback', (t) => {
  const f = fixture(t),
    now = Date.now();
  const [a, b] = f.config.accounts;
  a!.model = 'high';
  a!.quotaBuckets = ['high_weekly'];
  a!.modelFallbacks = [{ model: 'low', quotaBuckets: [] }];
  const pool = new AccountPool(f.config.accounts, f.store, 60000, 0.9);
  pool.quota(
    b!,
    { rejected: false, bucket: 'five_hour', utilization: 0.4, resetsAt: now + 600000 },
    0.95,
    now,
  );
  assert.equal(pool.pressure(a!, now), undefined);
  assert.equal(pool.choose(null, a!.id, new Set(), now)!.id, b!.id);
  pool.quota(
    a!,
    { rejected: false, bucket: 'high_weekly', utilization: 0.92, resetsAt: now + 600000 },
    0.95,
    now,
  );
  assert.equal(pool.choose(null, a!.id, new Set(), now)!.id, b!.id);
  assert.equal(pool.choose(a!.id, a!.id, new Set(), now)!.model, 'low');
});

test('automatic routing keeps a usable preferred model above an unstrained fallback', (t) => {
  const f = fixture(t),
    now = Date.now();
  for (const a of f.config.accounts) {
    a.model = 'preferred';
    a.quotaBuckets = ['preferred_weekly'];
    a.modelFallbacks = [{ model: 'fallback', quotaBuckets: [] }];
  }
  const [a, b] = f.config.accounts;
  const pool = new AccountPool(f.config.accounts, f.store, 60000, 0.9);
  pool.quota(
    a!,
    { rejected: false, bucket: 'preferred_weekly', utilization: 0.92, resetsAt: now + 600000 },
    0.95,
    now,
  );
  pool.fail(b!, new ProviderFailure('quota', 'full', now + 600000), now);
  assert.equal(pool.choose(null, a!.id, new Set(), now)!.model, 'preferred');
  // An explicit account preference retains its documented pressure-first policy.
  assert.equal(pool.choose(a!.id, a!.id, new Set(), now)!.model, 'fallback');
  pool.quota(
    a!,
    { rejected: false, bucket: 'preferred_weekly', utilization: 0.96, resetsAt: now + 600000 },
    0.95,
    now,
  );
  assert.equal(pool.choose(null, a!.id, new Set(), now)!.model, 'fallback');
});

test('automatic routing tries each model tier across all accounts and respects bucket scope', (t) => {
  const f = fixture(t),
    now = Date.now();
  for (const a of f.config.accounts) {
    a.model = 'first';
    a.quotaBuckets = ['first_weekly'];
    a.modelFallbacks = [
      { model: 'second', quotaBuckets: [] },
      { model: 'last-resort', quotaBuckets: [] },
    ];
  }
  const [a, b] = f.config.accounts;
  const pool = new AccountPool(f.config.accounts, f.store, 60000, 0.9);
  for (const account of f.config.accounts)
    pool.fail(account, new ProviderFailure('quota', 'full', now + 600000, 'first_weekly'), now);
  const attempted = new Set<string>();
  const first = pool.choose(null, a!.id, attempted, now)!;
  assert.equal(first.model, 'second');
  attempted.add(accountRoute(first));
  const second = pool.choose(null, a!.id, attempted, now)!;
  assert.equal(second.id, b!.id);
  assert.equal(second.model, 'second');
  attempted.add(accountRoute(second));
  assert.equal(pool.choose(null, a!.id, attempted, now)!.model, 'last-resort');
  assert.equal(pool.choose(null, a!.id, new Set(), now + 600001)!.model, 'first');
  for (const account of f.config.accounts)
    pool.fail(account, new ProviderFailure('quota', 'shared full', now + 600000), now);
  assert.equal(pool.choose(null, a!.id, new Set(), now), undefined);
});

for (const migrated of [false, true]) {
  test(`fallback is announced before provider execution on ${migrated ? 'an existing unannounced' : 'a new'} channel`, async (t) => {
    const f = fixture(t);
    for (const a of f.config.accounts) {
      a.model = 'preferred';
      a.quotaBuckets = ['preferred_weekly'];
      a.modelFallbacks = [{ model: 'fallback', quotaBuckets: [] }];
    }
    if (migrated) {
      f.config.discord.noticeChannelId = '222222';
      f.store.exec(
        'UPDATE sessions SET active_account=?,active_model=? WHERE id=?',
        'a',
        'fallback',
        f.session.id,
      );
    }
    // A real request marker must not put the fallback warning in its thread.
    f.store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?)',
      `discord-request:${f.session.id}`,
      JSON.stringify({ messageId: '333333' }),
    );
    let calls = 0;
    const p: Provider = {
      async run(r) {
        calls++;
        const notices = f.store.all<any>("SELECT * FROM outbox WHERE dedupe_key LIKE 'handoff:%'");
        assert.equal(notices.length, 1);
        assert.equal(
          notices[0].session_id,
          migrated ? f.store.ensureSession('222222').id : f.session.id,
        );
        assert.equal(f.store.noticeThread(notices[0].id), undefined);
        assert.match(
          notices[0].content,
          /Using a \(fallback\).*Fallback model in use; preferred model: preferred/,
        );
        assert.doesNotMatch(notices[0].content, /Switched from/);
        assert.equal(r.account.model, 'fallback');
        return 'Done';
      },
    };
    const engine = new Engine(f.config, f.store, { claude: p, codex: p });
    for (const a of f.config.accounts)
      engine.pool.fail(
        a,
        new ProviderFailure('quota', 'full', Date.now() + 600000, 'preferred_weekly'),
      );
    f.enqueue('first');
    engine.tick();
    await settle(engine);
    f.enqueue('second');
    engine.tick();
    await settle(engine);
    assert.equal(calls, 2);
    assert.equal(f.store.get<any>("SELECT count(*) n FROM runs WHERE status='done'").n, 2);
  });
}

test('quota warnings post to the configured notice channel, not the busy session', async (t) => {
  const f = fixture(t);
  f.config.discord.noticeChannelId = '222222';
  f.config.runtime.quotaWarningThreshold = 0.9;
  const p: Provider = {
    async run(r) {
      r.onEvent({
        type: 'quota',
        quota: {
          rejected: false,
          bucket: 'seven_day_overage_included',
          utilization: 0.92,
          resetsAt: Date.now() + 600000,
        },
      });
      return 'Finished';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('m');
  engine.tick();
  await settle(engine);
  // A configured notification channel must work before it has received user input.
  const home = f.store.session(
    f.store.get<{ id: string }>('SELECT id FROM sessions WHERE channel_id=?', '222222')!.id,
  );
  const notices = f.store.all<{ session_id: string; content: string }>(
    "SELECT session_id,content FROM outbox WHERE dedupe_key LIKE 'quota-warning:%'",
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.session_id, home.id);
  assert.notEqual(home.id, f.session.id);
  assert.match(notices[0]!.content, /Seen in /);
});

test('quota warnings stay in the session when no notice channel is configured', async (t) => {
  const f = fixture(t);
  f.config.runtime.quotaWarningThreshold = 0.9;
  const p: Provider = {
    async run(r) {
      r.onEvent({
        type: 'quota',
        quota: {
          rejected: false,
          bucket: 'seven_day_overage_included',
          utilization: 0.95,
          resetsAt: Date.now() + 600000,
        },
      });
      return 'Finished';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('m');
  engine.tick();
  await settle(engine);
  const notices = f.store.all<{ session_id: string }>(
    "SELECT session_id FROM outbox WHERE dedupe_key LIKE 'quota-warning:%'",
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.session_id, f.session.id);
});

test('a strained account is a last resort, never a block', (t) => {
  const f = fixture(t);
  const pool = new AccountPool(f.config.accounts, f.store, 60000, 0.9);
  const now = Date.now();
  const [a, b] = f.config.accounts;
  // Long-window bucket near its limit: no cooldown is recorded, so the account still works.
  pool.quota(
    a!,
    {
      rejected: false,
      bucket: 'seven_day_overage_included',
      utilization: 0.92,
      resetsAt: now + 600000,
    },
    0.95,
    now,
  );
  assert.equal(pool.strained(a!, now), true);
  assert.equal(pool.available(a!.id, now), true);
  // Preferring the strained account still routes work to the fresh one.
  assert.equal(pool.choose(a!.id, a!.id, new Set(), now)!.id, b!.id);
  pool.quota(
    b!,
    {
      rejected: false,
      bucket: 'seven_day_overage_included',
      utilization: 0.97,
      resetsAt: now + 600000,
    },
    0.95,
    now,
  );
  // With every account strained, work proceeds on the preferred one instead of stalling.
  assert.equal(pool.choose(a!.id, a!.id, new Set(), now)!.id, a!.id);
});

test('strain checks are off when the threshold is disabled', (t) => {
  const f = fixture(t);
  const pool = new AccountPool(f.config.accounts, f.store, 60000);
  const now = Date.now();
  pool.quota(
    f.config.accounts[0]!,
    { rejected: false, bucket: 'seven_day', utilization: 0.99, resetsAt: now + 600000 },
    0.95,
    now,
  );
  assert.equal(pool.strained(f.config.accounts[0]!, now), false);
  assert.equal(pool.choose(null, null, new Set(), now)!.id, f.config.accounts[0]!.id);
});

test('soft quota pressure respects model buckets and permits an unstrained fallback', (t) => {
  const f = fixture(t);
  const a = f.config.accounts[0]!;
  a.model = 'high';
  a.quotaBuckets = ['high_weekly'];
  a.modelFallbacks = [{ model: 'low', quotaBuckets: ['low_weekly'] }];
  const pool = new AccountPool(f.config.accounts, f.store, 60000, 0.9);
  const now = Date.now();
  pool.quota(
    a,
    { rejected: false, bucket: 'high_weekly', utilization: 0.91, resetsAt: now + 600000 },
    0.95,
    now,
  );
  const route = pool.choose(a.id, a.id, new Set(), now)!;
  assert.equal(route.id, a.id);
  assert.equal(route.model, 'low');
  assert.equal(pool.strained(route, now), false);
  assert.equal(pool.strained(a, now), true);
  assert.equal(pool.choose(a.id, a.id, new Set(), now + 600001)!.model, 'high');
});

test('soft quota observations without reset times expire instead of straining an account forever', (t) => {
  const f = fixture(t);
  const a = f.config.accounts[0]!;
  const pool = new AccountPool(f.config.accounts, f.store, 60000, 0.9);
  const now = Date.now();
  pool.quota(a, { rejected: false, bucket: 'unknown', utilization: 0.92 }, 0.95, now);
  assert.equal(pool.choose(a.id, a.id, new Set(), now)!.id, 'b');
  assert.equal(pool.choose(a.id, a.id, new Set(), now + 60001)!.id, a.id);
});
