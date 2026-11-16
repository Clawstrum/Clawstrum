import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { configSchema, readConfig, saveConfig } from '../src/config.js';
import { AccountPool, ProviderFailure, classifyError } from '../src/accounts.js';
import { Engine } from '../src/engine.js';
import { accepts, parseCommand, Discord } from '../src/discord.js';
import { downloadAttachments } from '../src/attachments.js';
import { buildContext } from '../src/context.js';
import { addTask, tickScheduler, listTasks, taskHistory } from '../src/scheduler.js';
import { healthChecks } from '../src/health.js';
import { writePrivate } from '../src/files.js';
import { serviceUnit } from '../src/service.js';
import { acquireLock } from '../src/lock.js';
import { runWorker } from '../src/supervisor.js';
import { createClaudeProvider } from '../src/providers.js';
import type { Provider, ProviderRequest, ProviderEvent } from '../src/types.js';

import { fixture, settle, ok } from './helpers.js';

test('output keys reject different text or files and never acknowledge a failed delivery', (t) => {
  const f = fixture(t);
  f.enqueue('m');
  const run = f.store.claim(f.session.id)!.run;
  const first = f.store.outbox(f.session.id, 'one', { runId: run.id, key: 'progress' });
  assert.throws(
    () => f.store.outbox(f.session.id, 'two', { runId: run.id, key: 'progress' }),
    /conflict/,
  );
  assert.equal(f.store.get<any>('SELECT final_sent FROM runs').final_sent, 0);
  const final = f.store.outbox(f.session.id, 'final', { runId: run.id, final: true });
  assert.equal(f.store.outbox(f.session.id, 'final', { runId: run.id, final: true }), final);
  assert.throws(
    () => f.store.outbox(f.session.id, 'changed', { runId: run.id, final: true }),
    /conflict/,
  );
  f.store.exec("UPDATE outbox SET status='failed' WHERE id=?", first);
  assert.throws(() => f.store.outbox(f.session.id, 'one', { key: 'progress' }), /delivery failed/);
});

for (const boundary of ['INSERT INTO outbox', 'UPDATE runs SET final_sent'])
  test(`process crash after ${boundary} rolls back both final writes`, (t) => {
    const f = fixture(t);
    f.enqueue('m');
    const run = f.store.claim(f.session.id)!.run;
    const script = `import {Store} from ${JSON.stringify(pathToFileURL(path.resolve('src/store.ts')).href)};
    const s=new Store(process.env.TEST_STATE); const exec=s.exec.bind(s);
    s.exec=(sql,...args)=>{const r=exec(sql,...args);if(sql.startsWith(${JSON.stringify(boundary)}))process.exit(77);return r;};
    s.outbox(${JSON.stringify(f.session.id)},'answer',{runId:${JSON.stringify(run.id)},final:true});`;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { env: { ...process.env, TEST_STATE: f.home }, encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(child.status, 77, child.stderr);
    assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
    assert.equal(f.store.get<any>('SELECT final_sent FROM runs').final_sent, 0);
    assert.equal(f.store.recover(), 1);
  });

test('retry keeps its original batch; identical earlier progress can serve as the final answer', async (t) => {
  const f = fixture(t);
  f.enqueue('old');
  const first = f.store.claim(f.session.id)!.run;
  f.store.outbox(f.session.id, 'Finished', {
    runId: first.id,
    key: `${first.logical_id}:message:progress`,
  });
  f.store.finish(first, 'queued');
  f.enqueue('new', Date.now() + 1);
  const engine = new Engine(f.config, f.store, { claude: ok, codex: ok });
  engine.tick();
  await settle(engine);
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='old'").status, 'done');
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='new'").status, 'queued');
  assert.equal(f.store.all('SELECT * FROM outbox').length, 1);
});

test('transient retries count failures per input; new arrivals and controls do not spend the budget', async (t) => {
  const f = fixture(t);
  f.enqueue('a');
  f.enqueue('b');
  f.store.exec("UPDATE inbound SET attempts=2 WHERE id='a'");
  const run = f.store.claim(f.session.id)!.run;
  assert.deepEqual(f.store.retry(run, 3, 'server_error'), { queued: 1, failed: 1 });
  assert.equal(f.store.get<any>("SELECT attempts FROM inbound WHERE id='b'").attempts, 1);
  f.store.exec("UPDATE inbound SET available_at=0 WHERE id='b'");
  const next = f.store.claim(f.session.id)!.run;
  f.store.finish(next, 'queued');
  assert.equal(f.store.get<any>("SELECT attempts FROM inbound WHERE id='b'").attempts, 1);
});

test('an offline stop only cancels inputs at or before its timestamp', async (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.enqueue('before', now - 2000);
  f.enqueue('after', now - 500);
  f.store.exec(
    'INSERT INTO controls(session_id,command,created_at) VALUES(?,?,?)',
    f.session.id,
    'cancel',
    now - 1000,
  );
  const engine = new Engine(f.config, f.store, { claude: ok, codex: ok });
  engine.tick();
  await settle(engine);
  assert.equal(
    f.store.get<any>("SELECT status FROM inbound WHERE id='before'").status,
    'cancelled',
  );
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='after'").status, 'done');
});

test('account homes reject absolute/relative and symlink aliases, including nonexistent leaves', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, 'profiles'));
  fs.symlinkSync(path.join(f.home, 'profiles'), path.join(f.home, 'alias'));
  for (const pair of [
    ['profiles/a', path.join(f.home, 'profiles/a')],
    ['profiles/a', 'alias/a'],
  ]) {
    const config = {
      ...f.config,
      accounts: pair.map((home, i) => ({ id: `a${i}`, provider: 'claude', home })),
    };
    assert.throws(() => saveConfig(f.home, config), /distinct provider home/);
    fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(config));
    assert.throws(() => readConfig(f.home), /distinct provider home/);
  }
});

test('quota buckets retain their longest block and never clear authentication state', (t) => {
  const f = fixture(t);
  const pool = new AccountPool(f.config.accounts, f.store, 60000);
  const a = f.config.accounts[0]!;
  const now = Date.now();
  // The return value tells the usage notice whether this bucket also switches at the threshold.
  assert.equal(
    pool.quota(
      a,
      { bucket: 'seven_day', rejected: false, utilization: 0.96, resetsAt: now + 4 * 86400000 },
      0.95,
      now,
    ),
    false,
  );
  assert.equal(pool.available(a.id, now), true);
  pool.quota(a, { bucket: 'seven_day', rejected: true, resetsAt: now + 4 * 86400000 }, 0.95, now);
  assert.equal(
    pool.quota(a, { bucket: 'five_hour', rejected: true, resetsAt: now + 100000 }, 0.95, now),
    true,
  );
  assert.equal(
    f.store.get<any>('SELECT cooldown_until FROM accounts WHERE id=?', a.id).cooldown_until,
    now + 4 * 86400000,
  );
  pool.fail(a, new ProviderFailure('auth', 'expired'), now);
  pool.fail(a, new ProviderFailure('quota', 'full', now + 200000), now);
  assert.equal(f.store.get<any>('SELECT disabled FROM accounts WHERE id=?', a.id).disabled, 1);
  assert.equal(f.store.all('SELECT * FROM account_quotas').length, 3);
  f.enqueue('wake');
  f.store.exec('UPDATE inbound SET available_at=?', now + 100000);
  pool.reset(a.id);
  assert.ok(f.store.get<any>('SELECT available_at FROM inbound').available_at <= Date.now());
});

test('every pinned Claude assistant error enum has an explicit classification', () => {
  const expected = {
    authentication_failed: 'auth',
    oauth_org_not_allowed: 'auth',
    account_on_hold: 'auth',
    verification_required: 'auth',
    billing_error: 'auth',
    rate_limit: 'quota',
    overloaded: 'transient',
    invalid_request: 'fatal',
    model_not_found: 'fatal',
    server_error: 'transient',
    unknown: 'fatal',
    max_output_tokens: 'fatal',
    cloud_credential_error: 'auth',
  };
  const sdk = fs.readFileSync(
    path.resolve('node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts'),
    'utf8',
  );
  const names = [
    .../type SDKAssistantMessageError = ([^;]+);/.exec(sdk)![1]!.matchAll(/'([^']+)'/g),
  ].map((m) => m[1]);
  assert.deepEqual(names.sort(), Object.keys(expected).sort());
  for (const [name, kind] of Object.entries(expected))
    assert.equal(classifyError(name).kind, kind, name);
});

test('attachment transient failure leaves unrelated input runnable and retries only the failed input', async (t) => {
  const f = fixture(t);
  f.enqueue('bad');
  f.enqueue('good');
  f.store.exec(
    'UPDATE inbound SET attachments=? WHERE id=?',
    JSON.stringify([{ name: 'file.txt', url: 'https://cdn.discordapp.com/file', size: 3 }]),
    'bad',
  );
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch failed');
  });
  const engine = new Engine(f.config, f.store, { claude: ok, codex: ok });
  engine.tick();
  await settle(engine);
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='bad'").status, 'queued');
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='good'").status, 'done');
  assert.equal(f.store.get<any>("SELECT attempts FROM inbound WHERE id='bad'").attempts, 1);
});

test('attachment refresh, stream size enforcement, cancellation and private files', async (t) => {
  const f = fixture(t);
  f.enqueue('file');
  f.store.exec(
    'UPDATE inbound SET attachments=?',
    JSON.stringify([{ name: '../file.txt', url: 'https://cdn.discordapp.com/expired', size: 3 }]),
  );
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1 ? new Response('', { status: 403 }) : new Response('abc'),
  );
  const claim = f.store.claim(f.session.id)!;
  const ready = await downloadAttachments(
    f.store,
    claim.messages,
    f.session.workspace,
    3,
    undefined,
    3,
    async () => 'https://cdn.discordapp.com/fresh',
  );
  const file = JSON.parse(ready[0]!.attachments)[0].path;
  assert.equal(fs.readFileSync(file, 'utf8'), 'abc');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(calls, 2);
  const ctrl = new AbortController();
  ctrl.abort(new Error('cancel download'));
  await assert.rejects(
    downloadAttachments(f.store, claim.messages, f.session.workspace, 3, ctrl.signal),
    /cancel download/,
  );
  f.store.finish(claim.run, 'done');
  f.enqueue('oversize');
  f.store.exec(
    'UPDATE inbound SET attachments=? WHERE id=?',
    JSON.stringify([{ name: 'big.txt', url: 'https://cdn.discordapp.com/big', size: 1 }]),
    'oversize',
  );
  t.mock.method(globalThis, 'fetch', async () => new Response('toolarge'));
  assert.equal(
    (
      await downloadAttachments(
        f.store,
        f.store.claim(f.session.id)!.messages,
        f.session.workspace,
        3,
      )
    ).length,
    0,
  );
  assert.equal(
    fs.readdirSync(path.dirname(file)).some((n) => n.endsWith('.part')),
    false,
  );
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='oversize'").status, 'failed');
});

test('latest task status is one row per task; malformed schedules do not stop healthy tasks', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const id = addTask(f.store, f.session.id, 'check', 'cron', '* * * * *', 'UTC', now);
  const once = addTask(
    f.store,
    f.session.id,
    'once',
    'once',
    new Date(now + 1).toISOString(),
    'UTC',
    now,
  );
  tickScheduler(f.store, now + 120000);
  f.store.exec("UPDATE inbound SET status='done' WHERE kind='task'");
  tickScheduler(f.store, now + 240000);
  assert.equal(listTasks(f.store, f.session.id).length, 2);
  assert.equal(taskHistory(f.store, id).length, 2);
  f.store.exec("UPDATE tasks SET schedule='invalid',next_run=? WHERE id=?", now, id);
  const healthy = addTask(
    f.store,
    f.session.id,
    'healthy',
    'once',
    new Date(now + 1).toISOString(),
    'UTC',
    now,
  );
  assert.equal(tickScheduler(f.store, now + 300000), 1);
  assert.equal(f.store.get<any>('SELECT status FROM tasks WHERE id=?', id).status, 'failed');
  assert.equal(
    f.store.get<any>('SELECT status FROM tasks WHERE id=?', healthy).status,
    'completed',
  );
  assert.throws(
    () =>
      addTask(
        f.store,
        f.session.id,
        'different',
        'once',
        new Date(now + 10).toISOString(),
        'UTC',
        now,
        once,
      ),
    /conflict/,
  );
});

test('recurring tasks coalesce missed slots and persist their cursor across a real reopen', (t) => {
  const f = fixture(t);
  const now = Date.now();
  addTask(f.store, f.session.id, 'check', 'cron', '* * * * *', 'UTC', now);
  assert.equal(tickScheduler(f.store, now + 86400000), 1);
  const reopened = new Store(f.home);
  try {
    assert.equal(tickScheduler(reopened, now + 86400000), 0);
    assert.equal(reopened.all('SELECT * FROM task_runs').length, 1);
    assert.ok(reopened.get<any>('SELECT next_run FROM tasks').next_run > now + 86400000);
  } finally {
    reopened.close();
  }
});

test('scheduled output survives missing MCP messaging, and quiet wakes are explicit', async (t) => {
  const f = fixture(t);
  let answer = 'Meaningful finding';
  const engine = new Engine(f.config, f.store, {
    claude: {
      async run() {
        return answer;
      },
    },
    codex: ok,
  });
  for (const id of ['one', 'two']) {
    f.store.enqueue({
      id,
      sessionId: f.session.id,
      author: 'scheduler',
      content: 'check',
      kind: 'task',
    });
    engine.tick();
    await settle(engine);
    answer = 'CLAWSTRUM_QUIET';
  }
  assert.equal(f.store.all('SELECT * FROM outbox').length, 1);
  assert.equal(f.store.get<any>('SELECT content FROM outbox').content, 'Meaningful finding');
});

test('the quiet sentinel is stripped from task replies and never reaches the channel', async (t) => {
  const f = fixture(t);
  const answers = [
    'Job 1 done, all good.\n\nCLAWSTRUM_QUIET',
    'CLAWSTRUM_QUIET\n\nJob 2 done.\n\nCLAWSTRUM_QUIET',
    '  CLAWSTRUM_QUIET  \n\nCLAWSTRUM_QUIET',
    'User reply mentioning CLAWSTRUM_QUIET inline stays untouched',
  ];
  let turn = 0;
  const engine = new Engine(f.config, f.store, {
    claude: {
      async run() {
        return answers[turn++]!;
      },
    },
    codex: ok,
  });
  for (const [i, id] of ['one', 'two', 'three', 'four'].entries()) {
    f.store.enqueue({
      id,
      sessionId: f.session.id,
      author: i === 3 ? 'owner' : 'scheduler',
      content: 'check',
      kind: i === 3 ? 'user' : 'task',
    });
    engine.tick();
    await settle(engine);
  }
  const contents = f.store
    .all<any>('SELECT content FROM outbox ORDER BY created_at')
    .map((r) => r.content);
  assert.deepEqual(contents, [
    'Job 1 done, all good.',
    'Job 2 done.',
    'User reply mentioning CLAWSTRUM_QUIET inline stays untouched',
  ]);
});

test('debounce delays a human burst but releases it at the configured ceiling when nobody is typing', async (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.config.runtime.debounceMs = 100;
  f.config.runtime.debounceMaxMs = 1000;
  let calls = 0;
  const p: Provider = {
    async run() {
      calls++;
      return 'done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('one', now);
  engine.tick(now + 50);
  assert.equal(calls, 0);
  f.enqueue('two', now + 60);
  engine.tick(now + 200);
  assert.equal(calls, 0);
  engine.tick(now + 1001);
  await settle(engine);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(f.store.get<any>('SELECT message_ids FROM runs').message_ids).length, 2);
});

test('a live typing signal keeps a run waiting past debounceMaxMs, until typingMaxMs releases it', async (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.config.runtime.debounceMs = 100;
  f.config.runtime.debounceMaxMs = 1000;
  f.config.runtime.typingMaxMs = 2000;
  let calls = 0;
  const p: Provider = {
    async run() {
      calls++;
      return 'done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('one', now);
  engine.typingUntil.set(f.session.id, now + 12000);
  engine.tick(now + 1001);
  assert.equal(calls, 0, 'typing keeps the run waiting past debounceMaxMs');
  engine.tick(now + 1999);
  assert.equal(calls, 0, 'still inside typingMaxMs');
  engine.tick(now + 2001);
  await settle(engine);
  assert.equal(calls, 1, 'typingMaxMs releases a typing signal that never stopped');
});

test('a run starts once the typing signal stops, even before typingMaxMs', async (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.config.runtime.debounceMs = 100;
  f.config.runtime.debounceMaxMs = 1000;
  f.config.runtime.typingMaxMs = 300000;
  let calls = 0;
  const p: Provider = {
    async run() {
      calls++;
      return 'done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('one', now);
  engine.typingUntil.set(f.session.id, now + 500);
  engine.tick(now + 1001);
  await settle(engine);
  assert.equal(calls, 1);
});

test('Discord command grammar preserves natural-language mentions and all allowlist branches', (t) => {
  const f = fixture(t);
  for (const content of [
    '!clawstrumish',
    '!clawstrum is broken again',
    '!clawstrum status please explain',
  ])
    assert.equal(parseCommand(content), undefined);
  assert.deepEqual(parseCommand('!clawstrum switch a'), { command: 'switch', argument: 'a' });
  assert.equal(accepts(f.config, '123456', '555555', 'not-allowed'), false);
  assert.equal(accepts(f.config, '123456', '555555', 'thread', 'not-allowed'), false);
  assert.equal(accepts(f.config, '123456', '555555', '987654'), true);
  assert.equal(accepts(f.config, '123456', '555555', 'thread', '987654'), true);
  assert.equal(accepts(f.config, '123456', null, 'dm'), false);
  f.config.discord.allowDMs = true;
  assert.equal(accepts(f.config, '123456', null, 'dm'), true);
  assert.equal(accepts(f.config, 'stranger', null, 'dm'), false);
});

test('complete skills and oversized context remain in real artifacts and config changes invalidate resume', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 40; i++) {
    const dir = path.join(f.home, 'skills', `skill-${String(i).padStart(2, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'description: ' + 'd'.repeat(300));
  }
  fs.writeFileSync(path.join(f.home, 'SELF.md'), 'instructions '.repeat(3000));
  f.enqueue('large');
  f.store.exec('UPDATE inbound SET content=?', 'large-input '.repeat(3000));
  const claim = f.store.claim(f.session.id)!;
  let c = buildContext(f.store, f.session, f.config.accounts[0]!, claim.messages, 2000, 12000);
  assert.ok(c.prompt.length + c.instructions.length <= 12000);
  assert.match(
    fs.readFileSync(path.join(f.session.workspace, 'artifacts', 'skills-index.txt'), 'utf8'),
    /skill-39/,
  );
  assert.match(c.instructions, /skill-39/);
  assert.match(
    fs.readFileSync(path.join(f.session.workspace, 'history', 'input.full.txt'), 'utf8'),
    /large-input/,
  );
  f.store.exec(
    'UPDATE sessions SET active_account=?,remote_id=?,fingerprint=? WHERE id=?',
    'a',
    'native',
    c.fingerprint,
    f.session.id,
  );
  fs.mkdirSync(path.join(f.session.workspace, '.claude'));
  fs.writeFileSync(path.join(f.session.workspace, '.claude/settings.json'), '{}');
  c = buildContext(
    f.store,
    f.store.session(f.session.id),
    f.config.accounts[0]!,
    claim.messages,
    2000,
    12000,
  );
  assert.equal(c.resumeId, undefined);
});

test('doctor flags a dead daemon, overdue task, failed delivery and broad credential modes', (t) => {
  const f = fixture(t);
  f.enqueue('old', Date.now() - 1000000);
  const id = addTask(
    f.store,
    f.session.id,
    'check',
    'once',
    new Date(Date.now() + 1000).toISOString(),
  );
  f.store.exec('UPDATE tasks SET next_run=? WHERE id=?', Date.now() - 120000, id);
  f.store.outbox(f.session.id, 'failed');
  f.store.exec("UPDATE outbox SET status='failed'");
  const envPath = path.join(f.home, '.env');
  fs.writeFileSync(envPath, '');
  fs.chmodSync(envPath, 0o644); // writeFileSync's mode option is still masked by the process umask
  const checks = healthChecks(f.store, f.config);
  for (const name of [
    'Daemon',
    'Overdue tasks',
    'Stalled queue',
    'Failed deliveries',
    '.env permissions',
  ])
    assert.equal(checks.find((c) => c.check === name)!.ok, false, name);
  writePrivate(path.join(f.home, '.env'), 'private');
  assert.equal(fs.statSync(path.join(f.home, '.env')).mode & 0o777, 0o600);
});

test('a task not yet due leaves a never-started daemon healthy; a due one does not', (t) => {
  const f = fixture(t);
  const id = addTask(
    f.store,
    f.session.id,
    'review',
    'once',
    new Date(Date.now() + 3600000).toISOString(),
  );
  const daemon = () => healthChecks(f.store, f.config).find((c) => c.check === 'Daemon')!;
  assert.equal(daemon().ok, true);
  assert.match(daemon().detail, /new installation/);
  f.store.exec('UPDATE tasks SET next_run=? WHERE id=?', Date.now() - 120000, id);
  assert.equal(daemon().ok, false);
});

test('database v1 migrates transactionally and a future schema is rejected without changing its file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clawstrum.db');
  let db = new DatabaseSync(file);
  db.exec(fs.readFileSync('test/fixtures/schema-v1.sql', 'utf8'));
  db.close();
  const migrated = new Store(dir);
  assert.equal(migrated.get<any>('SELECT version FROM schema_version').version, 6);
  migrated.close();
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=DELETE; UPDATE schema_version SET version=99');
  db.close();
  const before = fs.readFileSync(file);
  assert.throws(() => new Store(dir), /version/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('empty legacy lock metadata is recoverable and an exclusive owner cannot be displaced', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'daemon.lock'), '');
  const unlock = acquireLock(f.home);
  try {
    assert.throws(() => acquireLock(f.home), /already running/);
  } finally {
    unlock();
  }
  acquireLock(f.home)();
});

test('systemd parses the generated unit with spaces and percent signs in state paths', (t) => {
  const f = fixture(t);
  const home = path.join(f.home, 'state with %');
  fs.mkdirSync(home);
  const file = path.join(f.home, 'clawstrum.service');
  fs.writeFileSync(file, serviceUnit(home, process.execPath, path.resolve('dist/cli.js')));
  assert.match(fs.readFileSync(file, 'utf8'), /WorkingDirectory=\//);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /WorkingDirectory="/);
  const result = spawnSync('systemd-analyze', ['verify', file], {
    encoding: 'utf8',
    timeout: 20000,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    t.skip('systemd is not installed on this platform');
    return;
  }
  assert.doesNotMatch(
    result.stderr,
    /WorkingDirectory= path is not absolute|bad unit file setting/,
  );
  assert.equal(result.status, 0, result.stderr);
});

test(
  'a supervised worker and its subprocess are killed after ignoring abort and SIGTERM',
  { timeout: 15000 },
  async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX process-group contract');
      return;
    }
    const f = fixture(t);
    const worker = path.join(f.home, 'wedged.mjs');
    fs.writeFileSync(
      worker,
      `import {spawn} from 'node:child_process';
    process.on('SIGTERM',()=>{});
    process.on('message',m=>{if(m.type==='run') {
      const sub=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
      process.send({type:'event',event:{type:'ready',detail:{childPid:sub.pid}}});
    }});setInterval(()=>{},1000);`,
    );
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const work = runWorker(
      {
        account: f.config.accounts[0]!,
        cwd: f.home,
        prompt: 'test',
        instructions: '',
        controller,
        env: { PATH: process.env.PATH! },
        mcp: { command: process.execPath, args: [], env: {} },
        abortGraceMs: 100,
        onEvent: (e) => {
          events.push(e);
          if (e.type === 'ready') ready();
        },
      },
      pathToFileURL(worker),
    );
    // Attach rejection handling before aborting to avoid an unhandled-rejection race.
    const stopped = assert.rejects(work, /stop test/);
    await entered;
    const before = Date.now();
    controller.abort(new Error('stop test'));
    await stopped;
    assert.ok(Date.now() - before < 4000);
    const workerPid = (
      events.find((e) => (e.detail as any)?.event === 'worker_started')!.detail as any
    ).pid;
    assert.throws(() => process.kill(workerPid, 0), /ESRCH/);
    const childPid = (events.find((e) => e.type === 'ready')!.detail as any).childPid;
    // Group signals reach descendants asynchronously. A dead orphan may also wait for init
    // as a zombie on either Linux or macOS; kill(pid, 0) alone does not establish liveness.
    const terminated = () => {
      const result = spawnSync('ps', ['-o', 'stat=', '-p', String(childPid)], {
        encoding: 'utf8',
        timeout: 1000,
      });
      assert.ifError(result.error);
      assert.ok(result.status === 0 || result.status === 1, result.stderr);
      return (result.status === 1 && !result.stdout.trim()) || /^Z/.test(result.stdout.trim());
    };
    const reapDeadline = Date.now() + 2000;
    while (!terminated() && Date.now() < reapDeadline) await delay(20);
    assert.ok(terminated(), 'The descendant must exit or become a non-executing zombie');
  },
);

test('Claude adapter preserves partial text, loads operator settings, closes on quota and classifies server errors', async (t) => {
  const f = fixture(t);
  let closed = false;
  let options: any;
  const events: ProviderEvent[] = [];
  const factory = (messages: any[]) =>
    createClaudeProvider(((r: any) => {
      options = r.options;
      return Object.assign(
        (async function* () {
          yield* messages;
        })(),
        {
          close() {
            closed = true;
          },
        },
      );
    }) as any);
  const request: ProviderRequest = {
    account: f.config.accounts[0]!,
    cwd: f.home,
    prompt: 'test',
    instructions: 'instructions',
    env: {},
    controller: new AbortController(),
    mcp: { command: process.execPath, args: [], env: {} },
    onEvent: (e) => events.push(e),
  };
  const p = factory([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Saved progress' }] } },
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1800000000, rateLimitType: 'seven_day' },
    },
  ]);
  await assert.rejects(
    p.run(request),
    (e: any) => e.kind === 'quota' && e.retryAt === 1800000000000 && e.bucket === 'seven_day',
  );
  assert.equal(closed, true);
  assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
  assert.equal(options.permissionMode, 'bypassPermissions');
  assert.equal(options.sandbox.enabled, false);
  assert.equal(typeof options.stderr, 'function');
  assert.ok(events.some((e) => e.type === 'partial' && e.detail === 'Saved progress'));
  await assert.rejects(
    factory([{ type: 'assistant', error: 'server_error' }]).run(request),
    (e: any) => e.kind === 'transient',
  );
});

test('context overflow retries once with fresh bounded context, then gives actionable instructions', async (t) => {
  const f = fixture(t);
  f.enqueue('m');
  let calls = 0;
  const p: Provider = {
    async run(r) {
      calls++;
      assert.ok(r.prompt.length + r.instructions.length <= f.config.runtime.promptChars);
      throw new ProviderFailure('context', 'prompt too long');
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  engine.tick();
  await settle(engine);
  assert.equal(calls, 2);
  assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'failed');
  assert.match(f.store.get<any>('SELECT content FROM outbox').content, /AGENTS.md MEMORY/);
});

test('silence deadline saves partial output and frees the session; activity cannot extend the absolute ceiling', async (t) => {
  const f = fixture(t);
  f.config.runtime.silenceTimeoutMs = 100;
  // Far above the silence deadline, and every tick below is placed relative to the turn's own
  // timestamps, so a slow host cannot let the absolute deadline pass first.
  f.config.runtime.turnTimeoutMs = 60_000;
  const p: Provider = {
    async run(r) {
      r.onEvent({ type: 'ready' });
      r.onEvent({ type: 'partial', detail: 'Work completed before stall' });
      return new Promise((_, reject) =>
        r.controller.signal.addEventListener('abort', () => reject(r.controller.signal.reason), {
          once: true,
        }),
      );
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('m');
  const started = async () => {
    for (let i = 0; i < 2000; i++) {
      const state = [...engine.active.values()][0];
      if (state?.ready) return state;
      await delay(5);
    }
    throw new Error('provider never became ready');
  };
  engine.tick();
  const first = await started();
  engine.tick(first.lastActivity + 200);
  await settle(engine);
  assert.equal(engine.active.size, 0);
  assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'failed');
  assert.match(
    f.store.get<any>("SELECT content FROM events WHERE type='partial'").content,
    /before stall/,
  );
  const snapshot = fs.readFileSync(
    path.join(f.home, 'diagnostics', fs.readdirSync(path.join(f.home, 'diagnostics'))[0]!),
    'utf8',
  );
  assert.match(snapshot, /silence timeout/);
  assert.match(snapshot, /before stall/);
  f.enqueue('second');
  engine.tick();
  const active = await started();
  active.lastActivity = active.turnStarted + 120_000;
  engine.tick(active.turnStarted + 60_001);
  await settle(engine);
  assert.match(
    f.store.get<any>('SELECT error FROM runs ORDER BY started_at DESC LIMIT 1').error,
    /Absolute turn timeout/,
  );
});

test('Discord recovery discovers an unused configured thread and replays again after a gateway gap', async (t) => {
  const f = fixture(t);
  const engine = new Engine(f.config, f.store, { claude: ok, codex: ok });
  const discord = new Discord(f.config, f.store, engine);
  const snowflake = (ms: number) => String((BigInt(ms) - 1420070400000n) << 22n);
  const now = Date.now();
  let fetches = 0;
  const thread: any = {
    id: '1234567',
    parentId: '987654',
    isTextBased: () => true,
    messages: {
      async fetch() {
        fetches++;
        return new Map([
          [
            snowflake(now),
            {
              id: snowflake(now),
              createdTimestamp: now,
              author: { id: '123456', bot: false, displayName: 'owner' },
              guildId: '555555',
              channel: thread,
              channelId: thread.id,
              content: 'Created during downtime',
              attachments: new Map(),
            },
          ],
        ]);
      },
    },
  };
  const parent: any = {
    id: '987654',
    isTextBased: () => false,
    threads: {
      async fetchActive() {
        return { threads: new Map([[thread.id, thread]]) };
      },
      async fetchArchived() {
        return { threads: new Map() };
      },
    },
  };
  t.mock.method(discord.client.channels, 'fetch', async (id: any) =>
    id === thread.id ? thread : parent,
  );
  await discord.backfill();
  assert.ok(f.store.get('SELECT id FROM inbound WHERE id=?', snowflake(now)));
  const before = fetches;
  await discord.backfill();
  assert.ok(fetches > before);
  assert.equal(f.store.get<any>('SELECT count(*) n FROM inbound').n, 1);
  discord.close();
});

test(
  'installed Claude SDK drives a real JSONL subprocess and passes full-access settings and resume',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    const fake = path.join(f.home, 'claude.mjs');
    const record = path.join(f.home, 'claude-argv.json');
    fs.writeFileSync(
      fake,
      `import fs from 'node:fs'; import {createInterface} from 'node:readline';
    fs.writeFileSync(process.env.RECORD,JSON.stringify({args:process.argv.slice(2),home:process.env.CLAUDE_CONFIG_DIR}));
    const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    for await(const line of createInterface({input:process.stdin})) {
      const m=JSON.parse(line);
      if(m.type==='control_request') send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],models:[],account:null}}});
      if(m.type==='user') {
        send({type:'system',subtype:'init',session_id:'claude-native',tools:[],mcp_servers:[],model:'test',permissionMode:'bypassPermissions',apiKeySource:'none',cwd:process.cwd(),uuid:'init'});
        send({type:'assistant',session_id:'claude-native',uuid:'assistant',parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:'Saved text'}]}});
        send({type:'result',subtype:'success',result:'CLAUDE_OK',is_error:false,session_id:'claude-native',uuid:'result',duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{},modelUsage:{},permission_denials:[]});
      }
    }`,
    );
    const events: ProviderEvent[] = [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Claude contract timeout')), 12000);
    try {
      const result = await createClaudeProvider().run({
        account: { ...f.config.accounts[0]!, executable: fake },
        cwd: f.home,
        prompt: 'Test input',
        instructions: 'Clawstrum test',
        sessionId: '11111111-1111-4111-8111-111111111111',
        controller,
        env: {
          PATH: process.env.PATH!,
          CLAUDE_CONFIG_DIR: f.config.accounts[0]!.home,
          RECORD: record,
        },
        mcp: { command: process.execPath, args: ['-e', 'process.exit(0)'], env: {} },
        onEvent: (e) => events.push(e),
      });
      assert.equal(result, 'CLAUDE_OK');
      const args = JSON.parse(fs.readFileSync(record, 'utf8'));
      assert.equal(args.home, f.config.accounts[0]!.home);
      assert.ok(args.args.includes('bypassPermissions'));
      assert.ok(
        args.args.includes('--resume=11111111-1111-4111-8111-111111111111'),
        JSON.stringify(args.args),
      );
      assert.ok(args.args.includes('--setting-sources=user,project,local'));
      assert.ok(events.some((e) => e.type === 'partial' && e.detail === 'Saved text'));
      assert.ok(events.some((e) => e.sessionId === 'claude-native'));
    } finally {
      clearTimeout(timeout);
    }
  },
);

test('CLI diagnoses an unsupported Node version before importing SQLite', (t) => {
  const f = fixture(t);
  const prelude = path.join(f.home, 'node20.mjs');
  fs.writeFileSync(prelude, "Object.defineProperty(process.versions,'node',{value:'20.20.2'});");
  const result = spawnSync(
    process.execPath,
    ['--import', prelude, path.resolve('dist/cli.js'), 'doctor'],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires Node.js >=22.13.0/);
  assert.doesNotMatch(result.stderr, /ERR_UNKNOWN_BUILTIN_MODULE|node:sqlite|ExperimentalWarning/);
});

test('failed migrations roll back all schema changes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-schema-rollback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clawstrum.db');
  let db = new DatabaseSync(file);
  db.exec(fs.readFileSync('test/fixtures/schema-v1.sql', 'utf8'));
  db.exec('DROP TABLE runs');
  db.close();
  assert.throws(() => new Store(dir), /runs/);
  db = new DatabaseSync(file);
  assert.equal((db.prepare('SELECT version FROM schema_version').get() as any).version, 1);
  assert.ok(
    !db
      .prepare('PRAGMA table_info(inbound)')
      .all()
      .some((c: any) => c.name === 'batch_id'),
  );
  db.close();
});

test('profile concurrency routes another conversation to an available profile', async (t) => {
  const f = fixture(t);
  f.config.accounts[0]!.maxConcurrent = 1;
  let release!: (value: string) => void;
  const calls: string[] = [];
  const p: Provider = {
    async run(r) {
      calls.push(r.account.id);
      return r.account.id === 'a'
        ? new Promise<string>((resolve) => {
            release = resolve;
          })
        : 'Other finished';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('first');
  const other = f.store.ensureSession('other');
  f.store.enqueue({ id: 'second', sessionId: other.id, author: 'owner', content: 'second' });
  engine.tick();
  await delay(10);
  assert.deepEqual(calls, ['a', 'b']);
  release('First finished');
  await settle(engine);
});

test('offline backup restores SQLite and transfer cleanup protects pending and failed work', async (t) => {
  const { backupState, collectFiles } = await import('../src/maintenance.js');
  const f = fixture(t);
  f.enqueue('m');
  const dir = path.join(f.home, 'outgoing');
  fs.mkdirSync(dir);
  const sent = path.join(dir, 'sent.txt');
  const pending = path.join(dir, 'pending.txt');
  for (const file of [sent, pending]) {
    fs.writeFileSync(file, 'artifact');
    fs.utimesSync(file, 1, 1);
  }
  f.store.outbox(f.session.id, 'sent', { file: sent });
  f.store.exec("UPDATE outbox SET status='sent'");
  f.store.outbox(f.session.id, 'pending', { file: pending });
  const files = collectFiles(f.store, Date.now() - 1000);
  assert.deepEqual(files, [sent]);
  assert.ok(fs.existsSync(sent));
  const unlock = acquireLock(f.home);
  try {
    assert.throws(() => collectFiles(f.store, Date.now() - 1000, true), /already running/);
  } finally {
    unlock();
  }
  const destination = f.home + '-backup';
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  backupState(f.store, destination);
  const restored = new Store(destination);
  try {
    assert.equal(restored.get<any>('SELECT count(*) n FROM inbound').n, 1);
  } finally {
    restored.close();
  }
  collectFiles(f.store, Date.now() - 1000, true);
  assert.equal(fs.existsSync(sent), false);
  assert.equal(fs.existsSync(pending), true);
});

test('legacy audit includes committed WAL rows without modifying its source', (t) => {
  const f = fixture(t);
  const script = `import importlib.util,sqlite3,pathlib
spec=importlib.util.spec_from_file_location('audit',${JSON.stringify(path.resolve('scripts/audit-legacy.py'))})
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
p=pathlib.Path(${JSON.stringify(f.home)})/'legacy.db'
db=sqlite3.connect(str(p));db.execute('PRAGMA journal_mode=WAL');db.execute('PRAGMA wal_autocheckpoint=0')
db.executescript('CREATE TABLE messages(timestamp TEXT,chat_jid TEXT,content TEXT,is_from_me INTEGER,is_bot_message INTEGER); CREATE TABLE scheduled_tasks(schedule_type TEXT); CREATE TABLE task_run_logs(status TEXT);')
db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
db.execute("INSERT INTO messages VALUES('2026-09-13','channel','content',0,0)");db.commit()
assert pathlib.Path(str(p)+'-wal').stat().st_size>0
assert audit.inspect(p)['total']==1
db.close()
`;
  const result = spawnSync('python3', ['-c', script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test(
  'concurrent processes cannot both reclaim stale daemon ownership',
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.home, 'daemon.lock'), '');
    const gate = path.join(f.home, 'gate');
    const release = path.join(f.home, 'release-lock');
    const script = `import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
    import {acquireLock} from ${JSON.stringify(pathToFileURL(path.resolve('src/lock.ts')).href)};
    process.stdout.write('ready\\n');
    while(!fs.existsSync(${JSON.stringify(gate)}))await delay(5);
    let unlock;try{unlock=acquireLock(${JSON.stringify(f.home)});}catch{process.stdout.write('lost\\n');process.exit(0);}
    process.stdout.write('won\\n');while(!fs.existsSync(${JSON.stringify(release)}))await delay(5);unlock();`;
    const children = Array.from({ length: 4 }, () => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let outcome!: (s: string) => void;
      const result = new Promise<string>((resolve) => {
        outcome = resolve;
      });
      const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
      child.stdout.on('data', (data) => {
        const text = data.toString();
        if (text.includes('ready')) ready();
        if (text.includes('won')) outcome('won');
        if (text.includes('lost')) outcome('lost');
      });
      return { child, started, result, exited };
    });
    try {
      await Promise.all(children.map((c) => c.started));
      fs.writeFileSync(gate, 'go');
      const results = await Promise.all(children.map((c) => c.result));
      assert.equal(results.filter((r) => r === 'won').length, 1);
    } finally {
      fs.writeFileSync(release, 'release');
      await Promise.all(children.map((c) => c.exited));
    }
  },
);

test('opening schema 1 refuses migration under a live legacy daemon', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-live-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clawstrum.db');
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync('test/fixtures/schema-v1.sql', 'utf8'));
  db.close();
  fs.writeFileSync(
    path.join(dir, 'daemon.lock'),
    JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'legacy' }),
  );
  const before = fs.readFileSync(file);
  assert.throws(() => new Store(dir), /already running/);
  assert.deepEqual(fs.readFileSync(file), before);
});
