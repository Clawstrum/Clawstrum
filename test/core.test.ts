import { updateMemory } from '../src/memory.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import {
  configSchema,
  saveConfig,
  readConfig,
  canonicalPath,
  takeDiscordToken,
} from '../src/config.js';
import { AccountPool, ProviderFailure, classifyError } from '../src/accounts.js';
import { accountEnvironment, claudeEvent } from '../src/providers.js';
import { safeText } from '../src/failure-notice.js';
import { scrubbedEnvironment } from '../src/secrets.js';
import { buildContext } from '../src/context.js';
import { archiveRecord } from '../src/history.js';
import { excludeRefusedInput, isSafetyRefusal, refusedRanges } from '../src/refusals.js';
import { Engine } from '../src/engine.js';
import { Delivery, accepts, deliveryPayloads } from '../src/discord.js';
import { addTask, tickScheduler, nextOccurrence } from '../src/scheduler.js';
import { acquireLock } from '../src/lock.js';
import type { Provider, ProviderRequest, Outbound } from '../src/types.js';

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-test-')));
  const store = new Store(home);
  const config = configSchema.parse({
    version: 1,
    discord: { ownerIds: ['123456'], channelIds: ['987654'], guildId: '555555' },
    accounts: [
      { id: 'claude-a', provider: 'claude', home: path.join(home, 'a') },
      { id: 'codex-b', provider: 'codex', home: path.join(home, 'b') },
    ],
    runtime: { debounceMs: 0, debounceMaxMs: 0 },
  });
  const session = store.ensureSession('987654');
  return {
    home,
    store,
    config,
    session,
    close() {
      store.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
const success: Provider = {
  async run(r) {
    r.onEvent({ type: 'session', sessionId: `${r.account.id}-native` });
    return 'Completed.';
  },
};
async function settle(engine: Engine) {
  await Promise.all([...engine.active.values()].map((s) => s.promise));
}

test('configuration fills defaults, resolves homes relative to state, and rejects incompatible account configuration', () => {
  const f = fixture();
  try {
    saveConfig(f.home, {
      ...f.config,
      accounts: [{ id: 'local', provider: 'codex', home: 'accounts/local' }],
    });
    assert.equal(readConfig(f.home).accounts[0]!.home, path.join(f.home, 'accounts/local'));
    assert.equal(f.config.runtime.maxConcurrent, 4);
    assert.throws(
      () =>
        configSchema.parse({ ...f.config, accounts: [f.config.accounts[0], f.config.accounts[0]] }),
      /unique/,
    );
    assert.throws(
      () =>
        configSchema.parse({
          ...f.config,
          accounts: [{ ...f.config.accounts[0], effort: 'ultra' }],
        }),
      /ultra/,
    );
    assert.deepEqual(f.config.mcpServers, {});
    assert.deepEqual(
      configSchema.parse({ ...f.config, mcpServers: { docs: { command: 'docs-mcp' } } }).mcpServers,
      { docs: { command: 'docs-mcp', args: [], env: {} } },
    );
    assert.throws(
      () => configSchema.parse({ ...f.config, mcpServers: { clawstrum: { command: 'x' } } }),
      /mcpServers\.clawstrum is reserved for Clawstrum's own tools/,
    );
  } finally {
    f.close();
  }
});
test('canonical paths resolve links a create would follow and stay bounded on a cycle', () => {
  const f = fixture();
  try {
    const outside = path.join(f.home, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    // Dangling on purpose: creating the file is what the caller is about to do.
    fs.symlinkSync(path.join(outside, 'new.md'), path.join(f.home, 'dangling.md'));
    assert.equal(canonicalPath(path.join(f.home, 'dangling.md')), path.join(outside, 'new.md'));
    assert.equal(
      canonicalPath(path.join(outside, 'later', 'notes.md')),
      path.join(outside, 'later', 'notes.md'),
      'existing ancestors resolve and the rest is kept',
    );
    fs.symlinkSync(path.join(f.home, 'b.md'), path.join(f.home, 'a.md'));
    fs.symlinkSync(path.join(f.home, 'a.md'), path.join(f.home, 'b.md'));
    assert.throws(() => canonicalPath(path.join(f.home, 'a.md')), /ELOOP/);
  } finally {
    f.close();
  }
});
test('incoming Discord ids deduplicate and one session cannot claim two turns', () => {
  const f = fixture();
  try {
    const input = { id: 'm1', sessionId: f.session.id, author: 'Owner', content: 'Do this' };
    assert.equal(f.store.enqueue(input), true);
    assert.equal(f.store.enqueue(input), false);
    const claimed = f.store.claim(f.session.id)!;
    assert.equal(claimed.messages.length, 1);
    assert.equal(f.store.claim(f.session.id), undefined);
    f.store.finish(claimed.run, 'done');
    assert.equal(f.store.get<any>('SELECT status FROM inbound WHERE id=?', 'm1').status, 'done');
  } finally {
    f.close();
  }
});
test('durable recovery preserves pending work and records an interrupted attempt', () => {
  const f = fixture();
  try {
    f.store.enqueue({ id: 'm', sessionId: f.session.id, author: 'Owner', content: 'Keep going' });
    f.store.claim(f.session.id);
    assert.equal(f.store.recover(), 1);
    assert.equal(f.store.get<any>('SELECT status FROM runs').status, 'interrupted');
    assert.equal(f.store.claim(f.session.id)!.messages[0]!.attempts, 0);
    assert.equal(f.store.get<any>('SELECT interruptions FROM inbound').interruptions, 1);
  } finally {
    f.close();
  }
});
test('rate limit classifier handles observed legacy wordings and keeps auth, context, and generic failures distinct', () => {
  for (const text of [
    "You've hit your session limit · resets 10:20am",
    "You've hit your limit · resets tomorrow",
    'usage_limit_reached',
    'rate_limit',
    'HTTP 429',
  ])
    assert.equal(classifyError(text).kind, 'quota');
  assert.equal(classifyError('authentication_failed').kind, 'auth');
  assert.equal(classifyError('prompt is too long').kind, 'context');
  assert.equal(classifyError('No conversation found').kind, 'session');
  assert.equal(classifyError('HTTP 529 overloaded').kind, 'transient');
  assert.equal(classifyError('Unsupported model').kind, 'fatal');
  const busy = Object.assign(new Error('database is locked'), { errcode: 5 });
  assert.equal(classifyError(busy).kind, 'transient');
  assert.equal(classifyError(Object.assign(new Error('x'), { errcode: 517 })).kind, 'transient');
  assert.equal(classifyError('database is locked').kind, 'fatal');
});
test('account cooldowns persist, apply across sessions, and stop exhausted accounts cycling', () => {
  const f = fixture();
  try {
    const pool = new AccountPool(f.config.accounts, f.store, 60000);
    const now = Date.now();
    const a = pool.choose(null, null)!;
    pool.fail(a, new ProviderFailure('quota', 'full', now + 50000), now);
    assert.equal(pool.choose(a.id, a.id)!.id, 'codex-b');
    pool.fail(f.config.accounts[1]!, new ProviderFailure('quota', 'full', now + 60000), now);
    assert.equal(pool.choose(null, null), undefined);
    assert.equal(pool.nextAvailable(now), now + 50000);
    const reopened = new Store(f.home);
    try {
      const next = new AccountPool(f.config.accounts, reopened, 60000);
      assert.equal(next.choose(null, null), undefined);
    } finally {
      reopened.close();
    }
    assert.equal(pool.choose(null, null, new Set(), now + 50001)!.id, a.id);
  } finally {
    f.close();
  }
});
test('account environments never select inherited API keys or another account token', () => {
  const f = fixture();
  try {
    f.config.accounts[0]!.tokenEnv = 'A_TOKEN';
    const env = accountEnvironment(f.config.accounts[0]!, f.config.accounts, {
      PATH: '/bin',
      HOME: '/real-home',
      OPENAI_API_KEY: 'api',
      ANTHROPIC_API_KEY: 'api',
      CLAUDE_CODE_OAUTH_TOKEN: 'wrong',
      A_TOKEN: 'selected',
      CLAUDECODE: '1',
      CODEX_HOME: '/wrong',
    });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'selected');
    assert.equal(env.CLAUDE_CONFIG_DIR, f.config.accounts[0]!.home);
    assert.equal(env.HOME, '/real-home');
    assert.equal(env.A_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(
      accountEnvironment(f.config.accounts[1]!, f.config.accounts, { A_TOKEN: 'secret' }).A_TOKEN,
      undefined,
    );
  } finally {
    f.close();
  }
});
test('the bot token leaves the daemon environment before any child can inherit it', () => {
  const f = fixture();
  try {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', DISCORD_BOT_TOKEN: 'bot-secret' };
    assert.equal(takeDiscordToken(f.config, env), 'bot-secret');
    assert.equal(env.DISCORD_BOT_TOKEN, undefined);
    assert.equal(
      accountEnvironment(f.config.accounts[0]!, f.config.accounts, env).DISCORD_BOT_TOKEN,
      undefined,
    );
    assert.throws(() => takeDiscordToken(f.config, env), /Set DISCORD_BOT_TOKEN before starting/);
    assert.equal(safeText('gateway refused bot-secret'), 'gateway refused [redacted]');
  } finally {
    f.close();
  }
});
test('an account tokenEnv with no credential word in its name is still kept from watches, jobs and failure text', () => {
  const f = fixture();
  const old = process.env.CLAUDE_OAUTH_WORK;
  try {
    process.env.CLAUDE_OAUTH_WORK = 'work-oauth-value-123';
    saveConfig(f.home, {
      ...f.config,
      accounts: [
        { id: 'work', provider: 'claude', home: 'accounts/work', tokenEnv: 'CLAUDE_OAUTH_WORK' },
      ],
    });
    readConfig(f.home);
    assert.equal(scrubbedEnvironment().CLAUDE_OAUTH_WORK, undefined);
    assert.equal(safeText('refused work-oauth-value-123'), 'refused [redacted]');
  } finally {
    if (old === undefined) delete process.env.CLAUDE_OAUTH_WORK;
    else process.env.CLAUDE_OAUTH_WORK = old;
    f.close();
  }
});
test('agent environments carry no inherited credentials, only the selected account token', () => {
  const f = fixture();
  try {
    f.config.accounts[0]!.tokenEnv = 'A_TOKEN';
    const env = accountEnvironment(f.config.accounts[0]!, f.config.accounts, {
      PATH: '/bin',
      HOME: '/real-home',
      SLURM_JOB_ID: '1',
      A_TOKEN: 'selected',
      JEV_API_KEY: 'x',
      TYPESAFE_API_KEY: 'x',
      OPENALEX_API_KEY: 'x',
      SPRINGER_OA_API_KEY: 'x',
      GITHUB_TOKEN: 'x',
      HF_TOKEN: 'x',
      WANDB_API_KEY: 'x',
      AWS_ACCESS_KEY_ID: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      DB_PASSWORD: 'x',
      SIGNING_KEY: 'x',
      GOOGLE_APPLICATION_CREDENTIALS: '/x.json',
    });
    assert.deepEqual(Object.keys(env).sort(), [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
      'HOME',
      'PATH',
      'SLURM_JOB_ID',
    ]);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'selected');
  } finally {
    f.close();
  }
});
test('Claude quota event preserves reset units and rejected status', () => {
  const seconds = claudeEvent({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      resetsAt: 1800000000,
      utilization: 1,
      rateLimitType: 'five_hour',
    },
  })[0]!;
  assert.equal(seconds.quota!.resetsAt, 1800000000000);
  assert.equal(seconds.quota!.rejected, true);
  const millis = claudeEvent({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', resetsAt: 1800000000000, utilization: 0.96 },
  })[0]!;
  assert.equal(millis.quota!.resetsAt, seconds.quota!.resetsAt);
  assert.equal(millis.quota!.rejected, false);
});
test('Claude quota failure automatically hands current work to Codex with checkpoint and tool evidence', async () => {
  const f = fixture();
  try {
    updateMemory(f.store, f.session.id, {
      'Current work': 'Already started job 42. Do not submit it twice.',
    });
    let received: ProviderRequest | undefined;
    const engine = new Engine(f.config, f.store, {
      claude: {
        async run(r) {
          r.onEvent({ type: 'session', sessionId: 'claude-thread' });
          r.onEvent({ type: 'activity', detail: { command: 'submit-job', id: 42 } });
          throw new ProviderFailure('quota', 'full');
        },
      },
      codex: {
        async run(r) {
          received = r;
          r.onEvent({ type: 'session', sessionId: 'codex-thread' });
          return 'Job finished.';
        },
      },
    });
    f.store.enqueue({ id: 'm', sessionId: f.session.id, author: 'Owner', content: 'Run the job' });
    engine.tick();
    await settle(engine);
    assert.equal(received!.sessionId, undefined);
    assert.match(received!.instructions, /job 42/);
    assert.match(received!.prompt, /submit-job/);
    assert.equal(f.store.session(f.session.id).remote_id, 'codex-thread');
    assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'done');
    // 2: the final reply, plus the switched-account-and-model notice from the Claude-to-Codex handoff.
    assert.equal(f.store.all('SELECT * FROM outbox').length, 2);
  } finally {
    f.close();
  }
});
test('same account resumes natively; account changes bootstrap and instruction changes refresh in place', () => {
  const f = fixture();
  try {
    const a = f.config.accounts[0]!;
    let context = buildContext(f.store, f.session, a, [], 4000);
    f.store.exec(
      'UPDATE sessions SET active_account=?,remote_id=?,fingerprint=? WHERE id=?',
      a.id,
      'native',
      context.fingerprint,
      f.session.id,
    );
    context = buildContext(f.store, f.store.session(f.session.id), a, [], 4000);
    assert.equal(context.resumeId, 'native');
    assert.doesNotMatch(context.prompt, /Portable conversation/);
    assert.equal(
      buildContext(f.store, f.store.session(f.session.id), f.config.accounts[1]!, [], 4000)
        .resumeId,
      undefined,
    );
    fs.writeFileSync(path.join(f.home, 'AGENTS.md'), 'Changed identity');
    const changed = buildContext(f.store, f.store.session(f.session.id), a, [], 4000);
    assert.equal(changed.resumeId, 'native');
    assert.match(changed.instructions, /Changed identity/);
  } finally {
    f.close();
  }
});
test('manual switch aborts an active turn and resumes its queued input on the selected provider', async () => {
  const f = fixture();
  try {
    let entered = false;
    const engine = new Engine(f.config, f.store, {
      claude: {
        async run(r) {
          entered = true;
          return await new Promise<string>((_, reject) =>
            r.controller.signal.addEventListener(
              'abort',
              () => reject(r.controller.signal.reason),
              { once: true },
            ),
          );
        },
      },
      codex: success,
    });
    f.store.enqueue({ id: 'm', sessionId: f.session.id, author: 'Owner', content: 'Long task' });
    engine.tick();
    await delay(1);
    assert.equal(entered, true);
    f.store.exec(
      'INSERT INTO controls(session_id,command,argument,created_at) VALUES(?,?,?,?)',
      f.session.id,
      'switch',
      'codex-b',
      Date.now(),
    );
    engine.tick();
    await settle(engine);
    engine.tick();
    await settle(engine);
    assert.equal(f.store.session(f.session.id).active_account, 'codex-b');
    assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'done');
    assert.equal(f.store.all('SELECT * FROM runs').length, 2);
  } finally {
    f.close();
  }
});
test('a same-account model fallback triggered by quota pressure sends a switch notice naming both models', async () => {
  const f = fixture();
  try {
    const a = f.config.accounts[0]!;
    a.model = 'high';
    a.quotaBuckets = ['high_weekly'];
    a.modelFallbacks = [{ model: 'low', quotaBuckets: ['low_weekly'] }];
    f.store.exec('UPDATE sessions SET preferred_account=? WHERE id=?', a.id, f.session.id);
    const engine = new Engine(f.config, f.store, { claude: success, codex: success });
    f.store.enqueue({ id: 'm1', sessionId: f.session.id, author: 'Owner', content: 'First' });
    engine.tick();
    await settle(engine);
    assert.equal(f.store.session(f.session.id).active_account, a.id);
    assert.equal(f.store.session(f.session.id).active_model, 'high');
    engine.pool.quota(
      a,
      { rejected: false, bucket: 'high_weekly', utilization: 0.99, resetsAt: Date.now() + 600000 },
      0.95,
    );
    f.store.enqueue({ id: 'm2', sessionId: f.session.id, author: 'Owner', content: 'Second' });
    engine.tick();
    await settle(engine);
    assert.equal(f.store.session(f.session.id).active_account, a.id);
    assert.equal(f.store.session(f.session.id).active_model, 'low');
    const notice = f.store.get<any>(
      "SELECT content FROM outbox WHERE origin='notice' ORDER BY created_at DESC LIMIT 1",
    );
    assert.match(notice.content, /Switched from claude-a \(high\) to claude-a \(low\)/);
  } finally {
    f.close();
  }
});
test('all accounts exhausted leave work queued and emit one capacity notice per reset window', async () => {
  const f = fixture();
  try {
    const reset = Date.now() + 60000;
    let calls = 0;
    const full: Provider = {
      async run() {
        calls++;
        throw new ProviderFailure('quota', 'full', reset);
      },
    };
    const engine = new Engine(f.config, f.store, { claude: full, codex: full });
    f.store.enqueue({ id: 'm', sessionId: f.session.id, author: 'Owner', content: 'Work' });
    engine.tick();
    await settle(engine);
    for (let i = 0; i < 10; i++) engine.tick();
    assert.equal(calls, 2);
    assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'queued');
    // 2: the capacity notice, plus the switched-account-and-model notice from trying Codex after Claude.
    assert.equal(f.store.all('SELECT * FROM outbox').length, 2);
  } finally {
    f.close();
  }
});
test('a capacity notice posts once per waiting episode even as the retry time drifts within the hour', () => {
  // 2026-11-04: a provider-only channel got 24 identical notices from 13:12 to 18:55 because
  // the next-retry time in the dedupe key moved on every retry.
  const f = fixture();
  try {
    const engine = new Engine(f.config, f.store, { claude: success, codex: success });
    const base = Date.now() + 60000;
    for (let i = 0; i < 20; i++)
      (engine as any).capacityNotice(f.session.id, 'episode-1', base + i * 60000);
    assert.equal(f.store.all('SELECT * FROM outbox').length, 1);
  } finally {
    f.close();
  }
});
test('a capacity notice corrects once when the earliest-free time jumps more than an hour, then stays quiet', () => {
  const f = fixture();
  try {
    const engine = new Engine(f.config, f.store, { claude: success, codex: success });
    const first = Date.now() + 60000;
    (engine as any).capacityNotice(f.session.id, 'episode-1', first);
    (engine as any).capacityNotice(f.session.id, 'episode-1', first + 3600001);
    for (let i = 0; i < 5; i++)
      (engine as any).capacityNotice(f.session.id, 'episode-1', first + 3600001 + i * 60000);
    assert.equal(f.store.all('SELECT * FROM outbox').length, 2);
  } finally {
    f.close();
  }
});
test('a new queued message after the episode is answered opens a fresh capacity-notice episode', () => {
  const f = fixture();
  try {
    const engine = new Engine(f.config, f.store, { claude: success, codex: success });
    const next = Date.now() + 60000;
    (engine as any).capacityNotice(f.session.id, 'episode-1', next);
    (engine as any).capacityNotice(f.session.id, 'episode-1', next + 30000);
    assert.equal(f.store.all('SELECT * FROM outbox').length, 1);
    (engine as any).capacityNotice(f.session.id, 'episode-2', next);
    assert.equal(f.store.all('SELECT * FROM outbox').length, 2);
  } finally {
    f.close();
  }
});
test('the consolidation/review scan runs at most once per scanIntervalMs, then again once it elapses', () => {
  // 2026-11-04: scheduleConsolidation read every session on every tick, about 600
  // point-queries per tick at 99 sessions, and stalled the event loop. Throttling the scan
  // itself (not its per-session query count) keeps this bounded regardless of tick rate.
  const f = fixture();
  try {
    const engine = new Engine(f.config, f.store, { claude: success, codex: success });
    let scans = 0;
    const realAll = f.store.all.bind(f.store);
    (f.store as any).all = (sql: string, ...args: unknown[]) => {
      if (sql === 'SELECT * FROM sessions ORDER BY created_at DESC') scans++;
      return realAll(sql, ...args);
    };
    const start = Date.now();
    // 100 ticks across 10 s: the scan itself must still run exactly once.
    for (let i = 0; i < 100; i++) engine.tick(start + i * 100);
    assert.equal(scans, 1);
    // Past the 60 s default scanIntervalMs, it runs again.
    engine.tick(start + 61000);
    assert.equal(scans, 2);
  } finally {
    f.close();
  }
});
test('a scheduled occurrence advances atomically and does not mix with user input', () => {
  const f = fixture();
  try {
    const now = Date.now();
    addTask(
      f.store,
      f.session.id,
      'Check once',
      'once',
      new Date(now + 1000).toISOString(),
      'UTC',
      now,
    );
    assert.equal(tickScheduler(f.store, now + 1001), 1);
    assert.equal(tickScheduler(f.store, now + 2000), 0);
    assert.equal(f.store.all('SELECT * FROM task_runs').length, 1);
    f.store.enqueue({
      id: 'user',
      sessionId: f.session.id,
      author: 'Owner',
      content: 'Separate request',
      at: now + 1002,
    });
    const run = f.store.claim(f.session.id, now + 2000)!;
    assert.equal(run.messages.length, 1);
    assert.equal(run.messages[0]!.kind, 'user');
    f.store.finish(run.run, 'done');
    assert.equal(f.store.claim(f.session.id, now + 2000)!.messages[0]!.kind, 'task');
  } finally {
    f.close();
  }
});
test('cron uses explicit timezone across daylight saving', () => {
  const after = Date.parse('2026-03-07T14:00:00Z');
  assert.equal(
    new Date(nextOccurrence('cron', '0 9 * * *', 'America/New_York', after)).toISOString(),
    '2026-03-08T13:00:00.000Z',
  );
  assert.throws(() => nextOccurrence('once', '2028-01-01T09:00:00', 'UTC'), /offset/);
});
test('delivery failure retries the same nonce and never replays a provider turn', async () => {
  const f = fixture();
  try {
    const id = f.store.outbox(f.session.id, 'Hello', { key: 'one' });
    assert.equal(f.store.outbox(f.session.id, 'Hello', { key: 'one' }), id);
    const seen: string[] = [];
    const delivery = new Delivery(f.store, async (_, row) => {
      seen.push(deliveryPayloads(row)[0]!.nonce);
      if (seen.length === 1) throw new Error('network lost');
      return 'discord-id';
    });
    await delivery.tick();
    await delivery.tick(Date.now() + 10000);
    assert.deepEqual(seen, [seen[0], seen[0]]);
    assert.equal(f.store.get<any>('SELECT status FROM outbox').status, 'sent');
    assert.equal(f.store.all('SELECT * FROM runs').length, 0);
  } finally {
    f.close();
  }
});
test('delivery keeps retrying through a long outage and fails at once on a rejected request', async () => {
  const f = fixture();
  try {
    const t0 = Date.now();
    f.store.outbox(f.session.id, 'outage');
    let down = true;
    const delivery = new Delivery(f.store, async () => {
      if (down) throw Object.assign(new Error('Service Unavailable'), { status: 503 });
      return 'discord-id';
    });
    // Twenty failed ticks span well past the old eight-attempt limit.
    for (let i = 0; i < 20; i++) await delivery.tick(t0 + i * 600000);
    assert.equal(f.store.get<any>('SELECT status FROM outbox').status, 'pending');
    down = false;
    await delivery.tick(t0 + 20 * 600000);
    assert.equal(f.store.get<any>('SELECT status FROM outbox').status, 'sent');

    f.store.exec('DELETE FROM outbox');
    f.store.outbox(f.session.id, 'rejected');
    const rejected = new Delivery(f.store, async () => {
      throw Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 });
    });
    await rejected.tick();
    assert.equal(f.store.get<any>('SELECT status FROM outbox').status, 'failed');

    f.store.exec('DELETE FROM outbox');
    f.store.outbox(f.session.id, 'stale');
    const stale = new Delivery(f.store, async () => {
      throw new Error('network lost');
    });
    await stale.tick(Date.now() + 24 * 60 * 60 * 1000);
    assert.equal(f.store.get<any>('SELECT status FROM outbox').status, 'failed');
  } finally {
    f.close();
  }
});
test('outbox preserves per-conversation order while allowing another conversation to deliver', async () => {
  const f = fixture();
  try {
    f.store.outbox(f.session.id, 'first');
    f.store.outbox(f.session.id, 'second');
    const other = f.store.ensureSession('other');
    f.store.outbox(other.id, 'independent');
    const sent: string[] = [];
    const delivery = new Delivery(f.store, async (_, row) => {
      sent.push(row.content);
      return row.id;
    });
    await delivery.tick();
    assert.deepEqual(sent.sort(), ['first', 'independent']);
    await delivery.tick();
    assert.equal(sent.at(-1), 'second');
  } finally {
    f.close();
  }
});
test('Discord routing accepts configured thread children and owners only, with bounded attachment output', () => {
  const f = fixture();
  try {
    assert.equal(accepts(f.config, '123456', '555555', 'thread', '987654'), true);
    assert.equal(accepts(f.config, 'other', '555555', '987654'), false);
    assert.equal(accepts(f.config, '123456', 'wrong', '987654'), false);
    const payloads = deliveryPayloads({
      id: 'id',
      content: 'x'.repeat(4000),
      file_path: null,
    } as Outbound);
    // Too long for one Discord message is split across messages, not turned into an attachment.
    assert.equal(payloads.length, 3);
    assert.equal(
      payloads.reduce((n, p) => n + p.files.length, 0),
      0,
    );
    assert.equal(payloads.map((p) => p.content).join(''), 'x'.repeat(4000));
    assert.equal(new Set(payloads.map((p) => p.nonce)).size, 3);
    for (const payload of payloads) {
      assert.ok(payload.content.length < 2000);
      assert.deepEqual(payload.allowedMentions, { parse: [] });
    }
  } finally {
    f.close();
  }
});
test('explicit final message suppresses an additional automatic answer', async () => {
  const f = fixture();
  try {
    const engine = new Engine(f.config, f.store, {
      claude: {
        async run() {
          const run = f.store.get<any>("SELECT id FROM runs WHERE status='running'")!;
          f.store.outbox(f.session.id, 'Already answered', { runId: run.id, final: true });
          return 'A redundant recap';
        },
      },
      codex: success,
    });
    f.store.enqueue({ id: 'm', sessionId: f.session.id, author: 'Owner', content: 'Task' });
    engine.tick();
    await settle(engine);
    assert.equal(f.store.all('SELECT * FROM outbox').length, 1);
  } finally {
    f.close();
  }
});
test('singleton lock does not permit another daemon or remove a live owner lock', () => {
  const f = fixture();
  try {
    const unlock = acquireLock(f.home);
    assert.throws(() => acquireLock(f.home), /already running/);
    unlock();
    const second = acquireLock(f.home);
    second();
  } finally {
    f.close();
  }
});

test('a safety-refused request stays out of later continuations', () => {
  const f = fixture();
  try {
    const add = (id: string, kind: string, content: string) =>
      archiveRecord(f.store, { id, sessionId: f.session.id, kind, content, counted: true });
    add('inbound:1', 'user', 'earlier ordinary request');
    add('inbound:2', 'user', 'REFUSED request text');
    add('provider:2', 'provider_message', 'REFUSED request text echoed by the provider');
    add('inbound:3', 'user', 'REFUSED follow-up that also failed');
    add('inbound:4', 'user', 'later ordinary request');
    f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'native', f.session.id);
    assert.equal(isSafetyRefusal("API Error: Opus 5.5's safeguards flagged this message"), true);
    assert.equal(isSafetyRefusal('HTTP 529 overloaded'), false);
    excludeRefusedInput(f.store, f.session.id, ['2']);
    excludeRefusedInput(f.store, f.session.id, ['3']);
    assert.equal(f.store.session(f.session.id).remote_id, null);
    assert.equal(refusedRanges(f.store, f.session.id).length, 2);
    const context = buildContext(
      f.store,
      f.store.session(f.session.id),
      f.config.accounts[0]!,
      [],
      4000,
    );
    assert.doesNotMatch(context.prompt, /REFUSED/);
    assert.match(context.prompt, /earlier ordinary request/);
    assert.match(context.prompt, /later ordinary request/);
    assert.match(context.prompt, /safety filter refused \(inbound:2, inbound:3\)/);
  } finally {
    f.close();
  }
});
