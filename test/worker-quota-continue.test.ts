import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture } from './helpers.js';
import { AccountPool, ProviderFailure } from '../src/accounts.js';
import { delegate, ResearchWorkers } from '../src/research/workers.js';
import { workerProfile } from '../src/research/worker-profile.js';
import type { Provider } from '../src/types.js';

function manager(f: ReturnType<typeof fixture>, provider: Provider) {
  return new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
  );
}

const row = (f: ReturnType<typeof fixture>, key: string, extra: Record<string, unknown> = {}) =>
  delegate(f.store, f.session.id, f.config, key, { role: 'coder', brief: 'Port it.', ...extra });

const status = (f: ReturnType<typeof fixture>, id: string) =>
  f.store.get<{ status: string; error: string | null; summary: string | null }>(
    'SELECT status,error,summary FROM delegations WHERE id=?',
    id,
  )!;

test('a subagent whose account hits a provider quota continues itself on another account, with one lead wake', async (t) => {
  const f = fixture(t);
  f.config.accounts = [
    { id: 'a', provider: 'claude', home: path.join(f.home, 'a') },
    { id: 'b', provider: 'claude', home: path.join(f.home, 'b') },
  ] as typeof f.config.accounts;
  const seen: string[] = [];
  const provider: Provider = {
    async run(r) {
      seen.push(r.account.id);
      if (r.account.id === 'a')
        throw new ProviderFailure('quota', 'Claude subscription limit reached');
      return 'done on b';
    },
  };
  const m = manager(f, provider);
  const delegation = row(f, 'q');

  m.tick();
  await m.active.get(delegation.id)!.promise;
  assert.deepEqual(seen, ['a']);
  // Requeued under the same id, not failed.
  assert.equal(status(f, delegation.id).status, 'queued');
  const profile = workerProfile(f.store, delegation.id)!;
  assert.equal(profile.quotaContinuing, true);
  assert.equal(profile.quotaContinues, 1);
  assert.equal(profile.quotaFromAccount, 'a');
  // The failed account is excluded by the normal pool cooldown; no provider-specific carve-out.
  assert.equal(
    f.store.get(
      'SELECT 1 FROM inbound WHERE id=?',
      `research:worker-quota-continue:${delegation.id}:1`,
    ),
    undefined,
  );

  m.tick();
  await m.active.get(delegation.id)!.promise;
  assert.deepEqual(seen, ['a', 'b']);
  const final = status(f, delegation.id);
  assert.equal(final.status, 'completed');
  assert.match(final.summary!, /done on b/);
  const wake = f.store.get<{ content: string }>(
    'SELECT content FROM inbound WHERE id=?',
    `research:worker-quota-continue:${delegation.id}:1`,
  )!;
  assert.match(wake.content, new RegExp(`moved from a to b`));
  assert.match(wake.content, /continuation 1 of 2/);
  // Only the one quota-continue wake, plus the normal completion wake; no duplicate.
  assert.equal(
    f.store.all('SELECT 1 FROM inbound WHERE id LIKE ?', `research:worker-quota-continue:%`).length,
    1,
  );
  assert.ok(f.store.get('SELECT 1 FROM inbound WHERE id=?', `research:worker:${delegation.id}`));
});

test('a provider quota failure with no other usable account fails with a plain message naming the account and reset time', async (t) => {
  const f = fixture(t);
  f.config.accounts = [
    { id: 'a', provider: 'claude', home: path.join(f.home, 'a') },
  ] as typeof f.config.accounts;
  const resetAt = Date.now() + 3600000;
  const provider: Provider = {
    async run() {
      throw new ProviderFailure('quota', 'Claude subscription limit reached', resetAt);
    },
  };
  const m = manager(f, provider);
  const delegation = row(f, 'solo');
  m.tick();
  await m.active.get(delegation.id)!.promise;
  const final = status(f, delegation.id);
  assert.equal(final.status, 'failed');
  assert.match(
    final.error!,
    /^The a account reached its provider quota; no other account was free\./,
  );
  assert.ok(final.error!.includes(new Date(resetAt).toISOString()));
  assert.equal(workerProfile(f.store, delegation.id)?.quotaContinuing, false);
});

test('a provider-locked subagent does not move to a free account on a different provider', async (t) => {
  const f = fixture(t); // default fixture: a=claude, b=codex
  const attempts: string[] = [];
  const provider: Provider = {
    async run(r) {
      attempts.push(r.account.id);
      if (r.account.provider === 'claude')
        throw new ProviderFailure('quota', 'Claude subscription limit reached');
      return 'should not run on codex';
    },
  };
  const m = manager(f, provider);
  const delegation = row(f, 'locked', { provider: 'claude' });
  m.tick();
  await m.active.get(delegation.id)!.promise;
  assert.deepEqual(attempts, ['a']);
  const final = status(f, delegation.id);
  assert.equal(final.status, 'failed');
  assert.match(final.error!, /no other account was free/);
  // The codex account never ran, and a further tick does not pick it up either.
  m.tick();
  assert.deepEqual(attempts, ['a']);
  assert.equal(status(f, delegation.id).status, 'failed');
});

test('the automatic quota-continuation cap stops further account switches', async (t) => {
  const f = fixture(t);
  f.config.accounts = [
    { id: 'a', provider: 'claude', home: path.join(f.home, 'a') },
    { id: 'b', provider: 'claude', home: path.join(f.home, 'b') },
  ] as typeof f.config.accounts;
  f.config.research.workers.quotaContinues = 1;
  const attempts: string[] = [];
  const provider: Provider = {
    async run(r) {
      attempts.push(r.account.id);
      throw new ProviderFailure('quota', 'Claude subscription limit reached');
    },
  };
  const m = manager(f, provider);
  const delegation = row(f, 'cap');

  m.tick();
  await m.active.get(delegation.id)!.promise;
  assert.equal(status(f, delegation.id).status, 'queued');
  assert.equal(workerProfile(f.store, delegation.id)?.quotaContinues, 1);

  m.tick();
  await m.active.get(delegation.id)!.promise;
  assert.deepEqual(attempts, ['a', 'b']);
  const final = status(f, delegation.id);
  assert.equal(final.status, 'failed');
  assert.match(final.error!, /automatic quota-continuation limit \(1 of 1\) has been reached/);
});

test('an explicit model refused by one account is tried on the next account of that provider, with no downgrade', async (t) => {
  const f = fixture(t);
  f.config.accounts = [
    { id: 'a', provider: 'claude', home: path.join(f.home, 'a'), priority: 100 },
    { id: 'b', provider: 'claude', home: path.join(f.home, 'b'), priority: 50 },
  ] as typeof f.config.accounts;
  const seen: Array<[string, string | undefined]> = [];
  const provider: Provider = {
    async run(r) {
      seen.push([r.account.id, r.account.model]);
      if (r.account.id === 'a')
        throw new ProviderFailure('fatal', 'model may not exist or you may not have access');
      return 'done on b';
    },
  };
  const m = manager(f, provider);
  const delegation = row(f, 'refused', { provider: 'claude', model: 'claude-fable-5-2' });

  m.tick();
  await m.active.get(delegation.id)!.promise;
  assert.equal(status(f, delegation.id).status, 'queued');
  assert.deepEqual(workerProfile(f.store, delegation.id)?.modelRefusedBy, ['a']);
  // Not a quota event: no cooldown on a, no quota counters.
  assert.equal(workerProfile(f.store, delegation.id)?.quotaContinues, undefined);

  m.tick();
  await m.active.get(delegation.id)!.promise;
  // Same model on both accounts, and a was skipped the second time.
  assert.deepEqual(seen, [
    ['a', 'claude-fable-5-2'],
    ['b', 'claude-fable-5-2'],
  ]);
  const final = status(f, delegation.id);
  assert.equal(final.status, 'completed');
  assert.match(final.summary!, /done on b/);
});

test('an explicit model refused by every account of the provider fails and names them', async (t) => {
  const f = fixture(t);
  f.config.accounts = [
    { id: 'a', provider: 'claude', home: path.join(f.home, 'a'), priority: 100 },
    { id: 'b', provider: 'claude', home: path.join(f.home, 'b'), priority: 50 },
    // Another provider's account is never a candidate for a claude-locked model.
    { id: 'c', provider: 'codex', home: path.join(f.home, 'c') },
  ] as typeof f.config.accounts;
  const seen: string[] = [];
  const provider: Provider = {
    async run(r) {
      seen.push(r.account.id);
      throw new ProviderFailure('fatal', 'model_not_found');
    },
  };
  const m = manager(f, provider);
  const delegation = row(f, 'all-refused', { provider: 'claude', model: 'claude-fable-5-2' });
  m.tick();
  await m.active.get(delegation.id)!.promise;
  m.tick();
  await m.active.get(delegation.id)!.promise;
  assert.deepEqual(seen, ['a', 'b']);
  const final = status(f, delegation.id);
  assert.equal(final.status, 'failed');
  assert.match(final.error!, /claude-fable-5-2 was refused by a and b/);
  assert.doesNotMatch(final.error!, /\bc\b/);
  m.tick();
  assert.deepEqual(seen, ['a', 'b']);
});

test('model_not_found on a role-default model, and other fatal errors, still fail at once', async (t) => {
  const f = fixture(t);
  f.config.accounts = [
    { id: 'a', provider: 'claude', home: path.join(f.home, 'a') },
    { id: 'b', provider: 'claude', home: path.join(f.home, 'b') },
  ] as typeof f.config.accounts;
  const seen: string[] = [];
  const provider: Provider = {
    async run(r) {
      seen.push(r.account.id);
      throw new ProviderFailure('fatal', 'model_not_found');
    },
  };
  const m = manager(f, provider);
  const roleDefault = row(f, 'role-default');
  m.tick();
  await m.active.get(roleDefault.id)!.promise;
  assert.equal(status(f, roleDefault.id).status, 'failed');
  assert.deepEqual(seen, ['a']);

  const other: Provider = {
    async run(r) {
      seen.push(r.account.id);
      throw new ProviderFailure('fatal', 'invalid_request');
    },
  };
  const m2 = manager(f, other);
  const explicit = row(f, 'explicit-other', { provider: 'claude', model: 'claude-fable-5-2' });
  m2.tick();
  await m2.active.get(explicit.id)!.promise;
  assert.equal(status(f, explicit.id).status, 'failed');
  assert.equal(workerProfile(f.store, explicit.id)?.modelRefusedBy, undefined);
});
