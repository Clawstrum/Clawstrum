import { updateMemory } from '../src/memory.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, settle, ok } from './helpers.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { AccountPool, ProviderFailure } from '../src/accounts.js';
import { configSchema, loadEnv, saveConfig } from '../src/config.js';
import { buildContext } from '../src/context.js';
import { healthChecks } from '../src/health.js';
import { addTask, nextOccurrence, tickScheduler } from '../src/scheduler.js';
import { acquireLock } from '../src/lock.js';
import { collectFiles } from '../src/maintenance.js';
import { Discord } from '../src/discord.js';
import { processTree } from '../src/diagnostics.js';
import { writePrivate } from '../src/files.js';
import { runWorker } from '../src/supervisor.js';
import type { Provider, ProviderRequest } from '../src/types.js';

function models(f: ReturnType<typeof fixture>) {
  f.config.accounts.splice(1);
  const a = f.config.accounts[0]!;
  a.model = 'primary-model';
  a.quotaBuckets = ['model-weekly'];
  a.modelFallbacks = [{ model: 'fallback-model', quotaBuckets: ['fallback-weekly'] }];
  return a;
}

test('failed capacity notices cannot crash admission or provider handoff', async (t) => {
  const f = fixture(t);
  const p: Provider = {
    async run() {
      throw new ProviderFailure('auth', 'Sign in');
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('first');
  engine.tick();
  await settle(engine);
  // Simulate a previous daemon session that failed to deliver these notices; a stuck failed
  // row under a capacity dedupe key must not crash or re-post.
  f.store.exec("UPDATE outbox SET status='failed'");
  f.enqueue('second');
  assert.doesNotThrow(() => engine.tick());
  f.store.exec("UPDATE inbound SET available_at=0 WHERE status='queued'");
  assert.doesNotThrow(() => engine.tick());
  // 3: the switched-account-and-model notice from trying Codex after Claude, the first run's
  // capacity notice, and the second message's own capacity notice (a new waiting episode).
  assert.equal(f.store.all('SELECT * FROM outbox').length, 3);
  assert.equal(f.store.all("SELECT * FROM events WHERE type='engine_error'").length, 0);
});

test('multipart final keys retain both text and file and retry each part idempotently', (t) => {
  const f = fixture(t);
  f.enqueue('m');
  const run = f.store.claim(f.session.id)!.run;
  const file = path.join(f.home, 'answer.txt');
  fs.writeFileSync(file, 'report');
  const read = fs.readFileSync.bind(fs);
  t.mock.method(fs, 'readFileSync', ((...args: any[]) => {
    if (args[0] === file)
      assert.equal((f.store as any).transactionDepth, 0, 'Hash outside write transaction');
    return (read as any)(...args);
  }) as any);
  const textId = f.store.outbox(f.session.id, 'Summary', {
    runId: run.id,
    key: 'part1',
    final: true,
  });
  const fileId = f.store.outbox(f.session.id, 'Details', {
    runId: run.id,
    key: 'part2',
    file,
    final: true,
  });
  assert.notEqual(textId, fileId);
  assert.equal(
    f.store.outbox(f.session.id, 'Details', { runId: run.id, key: 'part2', file, final: true }),
    fileId,
  );
  assert.throws(
    () => f.store.outbox(f.session.id, 'Changed', { runId: run.id, key: 'part1', final: true }),
    /conflict/,
  );
  assert.equal(f.store.recover(), 0);
  assert.equal(f.store.all('SELECT * FROM outbox').length, 2);
});

for (const fails of [false, true])
  test(`non-final MCP output with ${fails ? 'failed' : 'successful empty'} provider completion`, async (t) => {
    const f = fixture(t);
    const p: Provider = {
      async run() {
        const run = f.store.get<any>("SELECT * FROM runs WHERE status='running'")!;
        f.store.outbox(f.session.id, 'A useful finding', { runId: run.id, key: 'finding' });
        if (fails) throw new ProviderFailure('fatal', 'Task failed after progress');
        return '';
      },
    };
    f.enqueue('m');
    const engine = new Engine(f.config, f.store, { claude: p, codex: p });
    engine.tick();
    await settle(engine);
    assert.equal(f.store.get<any>('SELECT status FROM inbound').status, fails ? 'failed' : 'done');
    assert.equal(f.store.all('SELECT * FROM outbox').length, fails ? 2 : 1);
  });

for (const control of ['cancel', 'reset', 'shutdown', 'deadline'])
  test(`unwritable diagnostics cannot prevent ${control}`, async (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.home, 'diagnostics'), 'not a directory');
    f.config.runtime.turnTimeoutMs = 100;
    let request: ProviderRequest | undefined;
    const p: Provider = {
      async run(r) {
        request = r;
        r.onEvent({ type: 'session', sessionId: 'native-before-control' });
        return new Promise((_, reject) =>
          r.controller.signal.addEventListener('abort', () => reject(r.controller.signal.reason), {
            once: true,
          }),
        );
      },
    };
    const engine = new Engine(f.config, f.store, { claude: p, codex: p });
    f.enqueue('m');
    engine.tick();
    while (!request) await delay(1);
    if (control === 'shutdown') await engine.stop();
    else if (control === 'deadline') engine.tick(Date.now() + 200);
    else {
      f.store.exec(
        'INSERT INTO controls(session_id,command,created_at) VALUES(?,?,?)',
        f.session.id,
        control,
        Date.now(),
      );
      engine.tick();
    }
    await settle(engine);
    assert.ok(request.controller.signal.aborted);
    assert.equal(engine.active.size, 0);
    const status = f.store.get<any>('SELECT status FROM inbound').status;
    assert.equal(
      status,
      control === 'cancel' ? 'cancelled' : control === 'deadline' ? 'failed' : 'queued',
    );
    if (control === 'reset') assert.equal(f.store.session(f.session.id).remote_id, null);
  });

test('Engine.stop bounds an adapter that ignores cancellation', async (t) => {
  const f = fixture(t);
  f.config.runtime.abortGraceMs = 100;
  const p: Provider = {
    async run() {
      return new Promise(() => {});
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('m');
  engine.tick();
  await delay(5);
  const at = Date.now();
  await engine.stop();
  assert.ok(Date.now() - at < 6000);
  assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'queued');
});

test('a failed derived conversation ledger cannot reverse a completed turn', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.session.workspace, 'CONVERSATION.json'));
  // Context reads the ledger only at bootstrap, so create the conflict after context preparation.
  fs.rmdirSync(path.join(f.session.workspace, 'CONVERSATION.json'));
  const p: Provider = {
    async run() {
      fs.mkdirSync(path.join(f.session.workspace, 'CONVERSATION.json'));
      return 'Finished';
    },
  };
  f.enqueue('m');
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  engine.tick();
  await settle(engine);
  assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'done');
  assert.equal(f.store.all('SELECT * FROM outbox').length, 1);
});

test('doctor distinguishes waiting behind a live turn from an unattended queue', (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.enqueue('running', now - 700000);
  f.store.claim(f.session.id);
  f.enqueue('waiting', now - 400000);
  const stalled = () =>
    healthChecks(f.store, f.config, now).find((c) => c.check === 'Stalled queue')!;
  assert.ok(stalled().ok);
  f.store.exec("UPDATE runs SET status='done'");
  assert.equal(stalled().detail, '1');
});

test('persistent slow retries retain input and throttle notices; resume resets counters', async (t) => {
  const f = fixture(t);
  f.config.runtime.maxAttempts = 2;
  f.config.runtime.slowRetryMs = 60000;
  const p: Provider = {
    async run() {
      throw new ProviderFailure('transient', 'server_error');
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('m');
  for (let i = 0; i < 6; i++) {
    f.store.exec('UPDATE inbound SET available_at=0');
    engine.tick();
    await settle(engine);
  }
  const input = f.store.get<any>('SELECT * FROM inbound');
  assert.equal(input.status, 'queued');
  assert.equal(input.attempts, 6);
  assert.ok(input.available_at >= Date.now() + 59000);
  assert.equal(f.store.all('SELECT * FROM outbox').length, 1);
  const reopened = new Store(f.home);
  assert.equal(reopened.get<any>('SELECT batch_id FROM inbound').batch_id, input.batch_id);
  reopened.close();
  f.store.exec(
    'INSERT INTO controls(session_id,command,created_at) VALUES(?,?,?)',
    f.session.id,
    'resume',
    Date.now(),
  );
  // Capacity is temporarily occupied so the test observes the reset without another attempt.
  f.config.runtime.maxConcurrent = 0;
  engine.tick();
  assert.equal(f.store.get<any>('SELECT attempts FROM inbound').attempts, 0);
});

test('model-specific quota selects another model in the same account and restores preference after reset', (t) => {
  const f = fixture(t);
  const a = models(f);
  const now = Date.now();
  const pool = new AccountPool(f.config.accounts, f.store, 900000);
  pool.fail(a, new ProviderFailure('quota', 'Model full', now + 10000, 'model-weekly'), now);
  assert.equal(pool.choose(a.id, a.id, new Set(), now)?.model, 'fallback-model');
  assert.equal(pool.choose(a.id, a.id, new Set(), now + 10001)?.model, 'primary-model');
  pool.fail(a, new ProviderFailure('quota', 'Shared limit', now + 20000, 'five_hour'), now);
  assert.equal(pool.choose(a.id, a.id, new Set(), now), undefined);
  assert.equal(pool.nextAvailable(now), now + 20000);
  pool.reset(a.id);
  pool.fail(a, new ProviderFailure('quota', 'Unidentified limit', now + 30000), now);
  assert.equal(pool.choose(a.id, a.id, new Set(), now), undefined);
  pool.fail(a, new ProviderFailure('auth', 'Login required'), now);
  assert.equal(pool.choose(a.id, a.id, new Set(), now + 1000000), undefined);
});

test('a mid-turn model rejection hands off portably and emits one early quota warning', async (t) => {
  const f = fixture(t);
  models(f);
  const seen: string[] = [];
  const reset = Date.now() + 60000;
  const p: Provider = {
    async run(r) {
      seen.push(r.account.model!);
      if (r.account.model === 'primary-model') {
        r.onEvent({ type: 'session', sessionId: 'old-native' });
        for (const utilization of [0.9, 0.91, 1])
          r.onEvent({
            type: 'quota',
            quota: {
              bucket: 'model-weekly',
              utilization,
              resetsAt: reset,
              rejected: utilization === 1,
            },
          });
        throw new ProviderFailure('quota', 'Model rejected', reset, 'model-weekly');
      }
      assert.equal(r.sessionId, undefined);
      assert.match(r.prompt, /New native session/);
      return 'Fallback completed';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('m');
  engine.tick();
  await settle(engine);
  assert.deepEqual(seen, ['primary-model', 'fallback-model']);
  assert.equal(
    f.store.all("SELECT * FROM outbox WHERE dedupe_key LIKE 'quota-warning:%'").length,
    1,
  );
  assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'done');
});

test('model fallback configuration rejects ambiguous models and shared-bucket scoping', (t) => {
  const f = fixture(t);
  const a = models(f);
  a.quotaBuckets = ['five_hour'];
  assert.throws(() => configSchema.parse(f.config), /Shared/);
  a.quotaBuckets = [];
  a.modelFallbacks[0]!.model = a.model!;
  assert.throws(() => configSchema.parse(f.config), /distinct model/);
});

test('shared memory edits refresh without invalidating resume', (t) => {
  const f = fixture(t);
  const a = f.config.accounts[0]!;
  const first = buildContext(f.store, f.session, a, [], 2000);
  f.store.exec(
    'UPDATE sessions SET active_account=?,remote_id=?,fingerprint=? WHERE id=?',
    a.id,
    'native',
    first.fingerprint,
    f.session.id,
  );
  assert.equal(
    buildContext(f.store, f.store.session(f.session.id), a, [], 2000).resumeId,
    'native',
  );
  updateMemory(f.store, null, { 'Working understanding': 'Shared preference changed' });
  const next = buildContext(f.store, f.store.session(f.session.id), a, [], 2000);
  assert.equal(next.resumeId, 'native');
  assert.match(next.contextRefresh.snapshot.memory, /Shared preference changed/);
});

for (const limit of ['turns', 'bytes', 'age'])
  test(`retired native ${limit} budget cannot rotate before completed consolidation`, async (t) => {
    const f = fixture(t);
    const seen: Array<string | undefined> = [];
    if (limit === 'bytes') f.config.accounts[0]!.provider = 'codex';
    f.config.runtime.nativeSessionMaxTurns = limit === 'turns' ? 1 : 0;
    f.config.runtime.nativeSessionMaxBytes = limit === 'bytes' ? 1 : 0;
    f.config.runtime.nativeSessionMaxAgeMs = limit === 'age' ? 1 : 0;
    const p: Provider = {
      async run(r) {
        seen.push(r.sessionId);
        r.onEvent({ type: 'session', sessionId: 'native' });
        return 'Done';
      },
    };
    const engine = new Engine(f.config, f.store, { claude: p, codex: p });
    f.enqueue('first');
    engine.tick();
    await settle(engine);
    await delay(5);
    f.enqueue('second');
    engine.tick();
    await settle(engine);
    assert.deepEqual(seen, [undefined, 'native']);
    assert.equal(
      f.store.all("SELECT * FROM events WHERE type='consolidation_completed'").length,
      0,
    );
  });

test('transient failures in a resumed thread clear that thread before delayed recovery', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const resumes: Array<string | undefined> = [];
  const p: Provider = {
    async run(r) {
      resumes.push(r.sessionId);
      calls++;
      if (calls === 2) throw new ProviderFailure('transient', 'HTTP 500');
      r.onEvent({ type: 'session', sessionId: 'native' });
      return 'Done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('first');
  engine.tick();
  await settle(engine);
  f.enqueue('second');
  engine.tick();
  await settle(engine);
  assert.equal(f.store.session(f.session.id).remote_id, null);
  f.store.exec("UPDATE inbound SET available_at=0 WHERE status='queued'");
  engine.tick();
  await settle(engine);
  assert.deepEqual(resumes, [undefined, 'native', undefined]);
});

test('recurring backlog is coalesced and cannot precede new human input', (t) => {
  const f = fixture(t);
  const now = Date.now();
  assert.throws(
    () => nextOccurrence('cron', '*/5 * * * * *', 'UTC', now),
    /one occurrence per minute/,
  );
  assert.ok(nextOccurrence('cron', '15 * * * * *', 'UTC', now) > now);
  addTask(f.store, f.session.id, 'Watch', 'cron', '* * * * *', 'UTC', now);
  for (let n = 1; n <= 30; n++) tickScheduler(f.store, now + n * 60000);
  assert.equal(f.store.all('SELECT * FROM task_runs').length, 1);
  f.enqueue('human', now + 31 * 60000);
  const run = f.store.claim(f.session.id, now + 32 * 60000)!;
  assert.equal(run.messages[0]!.kind, 'user');
});

test('new Discord conversations use their registration lookback instead of an old global cutoff', async (t) => {
  const f = fixture(t);
  const engine = new Engine(f.config, f.store, { claude: ok, codex: ok });
  const discord = new Discord(f.config, f.store, engine);
  const now = Date.now();
  const snow = (ms: number) => String((BigInt(ms) - 1420070400000n) << 22n);
  f.store.exec(
    "INSERT INTO metadata(key,value) VALUES('discord_since',?)",
    String(now - 90 * 86400000),
  );
  const channel: any = { id: '987654', isTextBased: () => true };
  const message = (at: number) => ({
    id: snow(at),
    createdTimestamp: at,
    author: { id: '123456', bot: false, displayName: 'owner' },
    guildId: '555555',
    channel,
    channelId: channel.id,
    content: 'Historical message',
    attachments: new Map(),
  });
  const records = [message(now - 30 * 86400000), message(now - 3600000)];
  channel.messages = {
    async fetch() {
      return new Map(records.map((m) => [m.id, m]));
    },
  };
  t.mock.method(discord.client.channels, 'fetch', async () => channel);
  try {
    await discord.backfill();
    assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
    await discord.backfill();
    assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
  } finally {
    await discord.close();
  }
});

test('an acquired modern mutex recovers stale metadata even if its PID has been reused', (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.home, 'daemon.lock'),
    JSON.stringify({ lock: 'sqlite', host: os.hostname(), pid: process.pid }),
  );
  const unlock = acquireLock(f.home);
  assert.throws(() => acquireLock(f.home), /already running/);
  unlock();
  fs.writeFileSync(
    path.join(f.home, 'daemon.lock'),
    JSON.stringify({ host: os.hostname(), pid: process.pid }),
  );
  assert.throws(
    () => acquireLock(f.home),
    /already running/,
    'Legacy live owners remain protected',
  );
});

test('init preserves an existing identity and env; malformed env reports only the line', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'SELF.md'), 'My identity');
  fs.writeFileSync(path.join(f.home, '.env'), '# keep this file\n');
  const result = spawnSync(process.execPath, ['dist/cli.js', 'init', '--owner', '123456'], {
    env: { ...process.env, CLAWSTRUM_HOME: f.home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.home, 'SELF.md'), 'utf8'), 'My identity');
  assert.match(fs.readFileSync(path.join(f.home, 'AGENTS.md'), 'utf8'), /^My identity\n/);
  assert.equal(fs.readFileSync(path.join(f.home, '.env'), 'utf8'), '# keep this file\n');
  fs.writeFileSync(
    path.join(f.home, '.env'),
    'CLAWSTRUM_REVIEW_TOKEN=first\nPRIVATE_WRAPPED_TOKEN\n',
  );
  assert.throws(
    () => loadEnv(f.home),
    (error) => /line 2/.test(String(error)) && !/PRIVATE_WRAPPED_TOKEN/.test(String(error)),
  );
  fs.writeFileSync(path.join(f.home, '.env'), 'CLAWSTRUM_REVIEW_TOKEN="wrapped\ntoken"');
  assert.throws(() => loadEnv(f.home), /line 1/);
});

test('cleanup includes diagnostics and history artifacts while excluding external workspaces', (t) => {
  const f = fixture(t);
  const old = new Date(Date.now() - 86400000);
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-external-'));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  const files = [
    path.join(f.home, 'diagnostics', 'old.json'),
    path.join(f.home, 'transcripts', 'old.jsonl'),
    path.join(external, 'attachments', 'original.txt'),
  ];
  for (const file of files) {
    writePrivate(file, 'retained evidence');
    fs.utimesSync(file, old, old);
  }
  f.store.exec('UPDATE sessions SET workspace=? WHERE id=?', external, f.session.id);
  assert.deepEqual(collectFiles(f.store, Date.now() - 1000, true).sort(), files.slice(0, 2).sort());
  assert.ok(fs.existsSync(files[2]!));
});

test('atomic writer removes its temporary file when fsync fails', (t) => {
  const f = fixture(t);
  const file = path.join(f.home, 'private.txt');
  fs.writeFileSync(file, 'old');
  t.mock.method(fs, 'fsyncSync', () => {
    throw new Error('Simulated full disk');
  });
  assert.throws(() => writePrivate(file, 'new'), /full disk/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  assert.equal(
    fs.readdirSync(f.home).filter((n) => n.startsWith('private.txt.') && n.endsWith('.tmp')).length,
    0,
  );
});

test('process snapshots attribute the current process without command lines or environment', () => {
  const result = processTree(process.pid);
  assert.equal(result[0]!.pid, process.pid);
  if (process.platform === 'linux') {
    assert.match(result[0]!.status!, /PPid:/);
    assert.ok('waitChannel' in result[0]!);
  }
  assert.doesNotMatch(JSON.stringify(result), /cmdline|environ/);
});

test('worker records and quarantines the actual executable version before any model work', async (t) => {
  const f = fixture(t);
  const executable = path.join(f.home, 'runtime.mjs');
  const marker = path.join(f.home, 'called');
  fs.writeFileSync(
    executable,
    `#!${process.execPath}\nimport fs from 'node:fs';\nif(process.argv.includes('--version')){console.log('codex-cli 0.154.0');process.exit(0);}fs.writeFileSync(${JSON.stringify(marker)},'unexpected');\n`,
    { mode: 0o700 },
  );
  const events: any[] = [];
  const request: ProviderRequest = {
    account: { id: 'probe', provider: 'codex', home: f.home, executable },
    prompt: 'Should not run',
    instructions: '',
    cwd: f.home,
    env: { PATH: process.env.PATH! },
    controller: new AbortController(),
    mcp: { command: process.execPath, args: [], env: {} },
    onEvent: (event) => events.push(event),
    blockedVersions: [{ provider: 'codex', version: '0.154.0', reason: 'Test quarantine' }],
  };
  await assert.rejects(runWorker(request), /quarantined: Test quarantine/);
  assert.ok(
    events.some((e) => e.detail?.event === 'runtime_version' && e.detail.version === '0.154.0'),
  );
  assert.equal(fs.existsSync(marker), false);
});

test('a completed worker answer is not timed out during bounded process cleanup', async (t) => {
  const f = fixture(t);
  let release: (() => void) | undefined;
  f.config.runtime.turnTimeoutMs = 100;
  const p: Provider = {
    async run(r) {
      r.onEvent({ type: 'completed' });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'Completed before deadline';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('m');
  engine.tick();
  while (!release) await delay(1);
  engine.tick(Date.now() + 1000);
  release();
  await settle(engine);
  assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'done');
});

test('an uncaught worker callback reports its failure over IPC before process-group cleanup', async (t) => {
  const f = fixture(t);
  const preload = path.join(f.home, 'preload.mjs');
  fs.writeFileSync(
    preload,
    "process.on('message', message => { if(message.type==='run') setInterval(function(){if(process.listenerCount('uncaughtException')){clearInterval(this);throw new Error('server_error');}},5); });",
  );
  const request: ProviderRequest = {
    account: { id: 'probe', provider: 'codex', home: f.home },
    prompt: 'No model work',
    instructions: '',
    cwd: f.home,
    env: { PATH: process.env.PATH!, NODE_OPTIONS: `--import=${preload}` },
    controller: new AbortController(),
    mcp: { command: process.execPath, args: [], env: {} },
    onEvent: () => {},
  };
  await assert.rejects(
    runWorker(request),
    (e: any) => e.kind === 'transient' && e.message === 'server_error',
  );
});

test('compiled daemon handles an uncaught callback by cleaning up and exiting for restart', (t) => {
  const f = fixture(t);
  saveConfig(f.home, f.config);
  const script = `
    import {Discord} from './dist/discord.js';
    import {main} from './dist/cli-main.js';
    Discord.prototype.connect=async function(){setTimeout(()=>{throw new Error('simulated websocket callback')},100);};
    Discord.prototype.tick=async function(){};
    Discord.prototype.close=async function(){console.log('DISCORD_CLOSED');};
    try {await main(['start']);process.exitCode=9;} catch(error){console.error(String(error));process.exitCode=1;}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, CLAWSTRUM_HOME: f.home, DISCORD_BOT_TOKEN: 'local-test-only' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /DISCORD_CLOSED/);
  assert.match(result.stderr, /daemon_fatal/);
  assert.equal(fs.existsSync(path.join(f.home, 'daemon.lock')), false);
});

test('zero warning/rotation thresholds never invent missing quota utilization', async (t) => {
  const f = fixture(t);
  f.config.runtime.quotaWarningThreshold = f.config.runtime.proactiveThreshold = 0;
  const p: Provider = {
    async run(r) {
      r.onEvent({
        type: 'quota',
        quota: { rejected: false, bucket: 'five_hour', resetsAt: Date.now() + 60000 },
      });
      return 'Finished';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  f.enqueue('m');
  engine.tick();
  await settle(engine);
  assert.equal(f.store.all('SELECT * FROM outbox').length, 1);
  assert.equal(engine.pool.available(f.config.accounts[0]!.id, Date.now()), true);
});
