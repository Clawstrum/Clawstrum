import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountPool, ProviderFailure, accountRoute } from '../src/accounts.js';
import { configSchema } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { delegate } from '../src/research/workers.js';
import type { Provider } from '../src/types.js';
import { fixture, settle } from './helpers.js';

test('account priority beats soft quota pressure and active-account stickiness until cooldown', (t) => {
  const f = fixture(t),
    now = Date.now();
  const [first, backup] = f.config.accounts;
  first!.priority = 100;
  backup!.priority = 50;
  const pool = new AccountPool(f.config.accounts, f.store, 60000, 0.9);
  pool.quota(
    first!,
    { bucket: 'seven_day', rejected: false, utilization: 0.94, resetsAt: now + 600000 },
    0.95,
    now,
  );
  pool.quota(
    backup!,
    { bucket: 'seven_day', rejected: false, utilization: 0.2, resetsAt: now + 600000 },
    0.95,
    now,
  );
  assert.equal(pool.choose(null, backup!.id, new Set(), now)!.id, first!.id);
  pool.fail(first!, new ProviderFailure('quota', 'exhausted', now + 60000), now);
  assert.equal(pool.choose(null, first!.id, new Set(), now)!.id, backup!.id);
  assert.equal(pool.choose(null, backup!.id, new Set(), now + 60001)!.id, first!.id);
  assert.equal(pool.choose(backup!.id, first!.id, new Set(), now)!.id, backup!.id);
});

test('priority preserves model-bucket fallback while respecting auth, attempts, and capacity exclusions', (t) => {
  const f = fixture(t),
    now = Date.now();
  const [first, backup] = f.config.accounts;
  first!.priority = 100;
  first!.model = 'primary';
  first!.quotaBuckets = ['primary_weekly'];
  first!.modelFallbacks = [{ model: 'secondary', quotaBuckets: [] }];
  const pool = new AccountPool(f.config.accounts, f.store, 60000, 0.9);
  pool.fail(
    first!,
    new ProviderFailure('quota', 'primary exhausted', now + 60000, 'primary_weekly'),
    now,
  );
  const secondary = pool.choose(null, backup!.id, new Set(), now)!;
  assert.equal(secondary.id, first!.id);
  assert.equal(secondary.model, 'secondary');
  assert.equal(
    pool.choose(null, first!.id, new Set([accountRoute(secondary)]), now)!.id,
    backup!.id,
  );
  assert.equal(pool.choose(null, first!.id, new Set([first!.id]), now)!.id, backup!.id);
  pool.fail(first!, new ProviderFailure('auth', 'login expired'), now);
  assert.equal(pool.choose(null, first!.id, new Set(), now + 60001)!.id, backup!.id);
});

test('priority works for new conversations and workers without changing their role model', async (t) => {
  const f = fixture(t);
  f.config.accounts[0]!.priority = 100;
  f.config.accounts[0]!.model = 'lead-model';
  f.config.research.validation = 'advisory';
  f.store.exec('UPDATE sessions SET active_account=? WHERE id=?', 'b', f.session.id);
  const fresh = f.store.ensureSession('123457');
  f.enqueue('existing');
  f.store.enqueue({ id: 'new', sessionId: fresh.id, author: 'owner', content: 'Hello' });
  const seen: Array<{ id: string; model?: string; worker: boolean }> = [];
  const provider: Provider = {
    async run(r) {
      seen.push({
        id: r.account.id,
        model: r.account.model,
        worker: !!r.mcp.env.CLAWSTRUM_DELEGATION,
      });
      return 'Done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  t.after(() => engine.stop());
  delegate(f.store, f.session.id, f.config, 'worker', {
    role: 'explorer',
    brief: 'Inspect one file',
  });
  engine.tick();
  await settle(engine);
  await Promise.all([...engine.researchWorkers.active.values()].map((s) => s.promise));
  assert.equal(seen.filter((r) => !r.worker).length, 2);
  assert.equal(seen.filter((r) => r.worker).length, 1);
  assert.ok(seen.every((r) => r.id === 'a'));
  assert.notEqual(seen.find((r) => r.worker)!.model, 'lead-model');
});

test('account priorities must be bounded integers and remain optional', (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() => configSchema.parse(f.config));
  for (const priority of [0.5, 1001, -1001, 'first'])
    assert.throws(() =>
      configSchema.parse({ ...f.config, accounts: [{ ...f.config.accounts[0], priority }] }),
    );
});
