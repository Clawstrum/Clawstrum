import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { ensureMemory } from '../src/memory.js';
import { archiveRecord } from '../src/history.js';
import { Engine } from '../src/engine.js';

// One maintenance tick on a channel with a review due and consolidation over its byte threshold.
// Returns the model of each background (toolless) call; the first call is stopped there.
async function backgroundCalls(
  t: TestContext,
  provider: 'claude' | 'codex',
  review: boolean,
): Promise<string[]> {
  const f = fixture(t);
  f.config.accounts = f.config.accounts.filter((account) => account.provider === provider);
  ensureMemory(f.store, null);
  f.config.runtime.consolidation.thresholdBytes = 1;
  f.config.runtime.maintenance.scanIntervalMs = 0;
  f.config.runtime.memoryReview.enabled = review;
  archiveRecord(f.store, {
    id: 'old',
    sessionId: f.session.id,
    kind: 'user',
    content: 'old result',
    counted: true,
  });
  // The last activity is two minutes old, past the review's 30 s quiet time.
  f.store.exec('UPDATE history_records SET created_at=created_at-120000');
  const calls: string[] = [];
  const runtime = {
    async run(request: { toolless?: boolean; account?: { model?: string } }) {
      if (!request.toolless) return 'ok';
      calls.push(request.account?.model ?? 'account default');
      throw new Error('stop at the first background call');
    },
  };
  const engine = new Engine(f.config, f.store, { claude: runtime, codex: runtime } as never);
  try {
    engine.tick();
    await Promise.all([...engine.consolidations].map((pass) => pass.catch(() => {})));
  } finally {
    await engine.stop();
  }
  return calls;
}

test('a Codex-only install reviews memory on the account model instead of waiting forever', async (t) => {
  assert.equal((await backgroundCalls(t, 'codex', true))[0], 'account default');
});

test('a Codex-only install with the review off consolidates', async (t) => {
  assert.ok((await backgroundCalls(t, 'codex', false)).length > 0);
});

test('a Claude account reviews on the configured review model', async (t) => {
  assert.equal((await backgroundCalls(t, 'claude', true))[0], 'sonnet');
});
