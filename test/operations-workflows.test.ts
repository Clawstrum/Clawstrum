import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, ok, settle } from './helpers.js';
import { Store } from '../src/store.js';
import { isDatabaseBusy } from '../src/storage.js';
import { saveConfig } from '../src/config.js';
import { acquireLock } from '../src/lock.js';
import { liveBackup, verifySnapshot } from '../src/backups.js';
import { lintDecisions, lintDecisionFile } from '../src/decisions.js';
import {
  addWatch,
  cancelWatch,
  getWatch,
  listWatches,
  WatchMonitor,
  WATCH_FAILURE_WAKE_AFTER,
  checkCondition,
  watchSpecSchema,
} from '../src/watches.js';
import {
  requestRestart,
  restartStatus,
  daemonReady,
  drainingRestart,
  commitRestart,
  cancelRestart,
} from '../src/restart.js';
import { Engine } from '../src/engine.js';
import { dayWindow, collectReview, completeReview, pendingReviewDays } from '../src/review.js';
import { backupUnits, healthUnits, serviceUnit } from '../src/service.js';
import { diskCheck, healthChecks, notifyHealth } from '../src/health.js';

test('SQLite contention can retry after the writer releases without treating other failures as busy', (t) => {
  const f = fixture(t);
  const file = path.join(f.home, 'contention.db');
  const owner = new DatabaseSync(file);
  owner.exec('PRAGMA journal_mode=DELETE; CREATE TABLE work(id INTEGER PRIMARY KEY)');
  const contender = new DatabaseSync(file);
  contender.exec('PRAGMA busy_timeout=1');
  try {
    owner.exec('BEGIN IMMEDIATE; INSERT INTO work VALUES(1)');
    assert.throws(() => contender.exec('INSERT INTO work VALUES(2)'), isDatabaseBusy);
    owner.exec('COMMIT');
    contender.exec('INSERT INTO work VALUES(2)');
    assert.equal(contender.prepare('SELECT count(*) n FROM work').get()!.n, 2);
    assert.equal(isDatabaseBusy({ errcode: 517 }), true);
    assert.equal(isDatabaseBusy({ errcode: 11 }), false);
    assert.equal(isDatabaseBusy({ errcode: 6 }), false);
    assert.equal(isDatabaseBusy(new Error('database is locked')), false);
    assert.equal(isDatabaseBusy(null), false);
  } finally {
    contender.close();
    owner.close();
  }
});

for (const failure of ['busy', 'unexpected']) {
  test(`daemon tick ${failure === 'busy' ? 'survives real SQLite reader contention' : 'still reports unexpected faults'}`, (t) => {
    const f = fixture(t);
    const home = path.join(f.home, 'daemon');
    fs.mkdirSync(home);
    saveConfig(home, f.config);
    fs.writeFileSync(
      path.join(home, 'STORAGE.json'),
      JSON.stringify({ host: os.hostname(), directory: home, journalMode: 'DELETE' }),
    );
    const script = `
      import {DatabaseSync} from 'node:sqlite';
      import {main} from ${JSON.stringify(new URL('../dist/cli-main.js', import.meta.url).href)};
      import {Store} from ${JSON.stringify(new URL('../dist/store.js', import.meta.url).href)};
      import {Discord} from ${JSON.stringify(new URL('../dist/discord.js', import.meta.url).href)};
      Discord.prototype.connect = async () => {};
      Discord.prototype.tick = async () => {};
      Discord.prototype.close = async () => {};
      const execute = Store.prototype.exec;
      let attempted = false, ready = false;
      const log = console.log;
      console.log = (...args) => {
        if (args.some(value => typeof value === 'string' && value.includes('"event":"ready"'))) ready = true;
        log(...args);
      };
      Store.prototype.exec = function(sql, ...params) {
        if (!ready || !sql.includes("VALUES('heartbeat'")) return execute.call(this, sql, ...params);
        if (!attempted) {
          attempted = true;
          if (${JSON.stringify(failure)} === 'unexpected') throw new Error('unexpected-test-fault');
          this.db.exec('PRAGMA busy_timeout=1');
          const reader = new DatabaseSync(${JSON.stringify(path.join(home, 'clawstrum.db'))});
          reader.exec('BEGIN');
          reader.prepare('SELECT name FROM sqlite_master').all();
          try { return execute.call(this, sql, ...params); }
          finally { reader.exec('ROLLBACK'); reader.close(); }
        }
        const result = execute.call(this, sql, ...params);
        console.log('RECOVERED_HEARTBEAT');
        setImmediate(() => process.emit('SIGTERM'));
        return result;
      };
      const deadline = setTimeout(() => process.exit(2), 30000);
      try { await main(['start']); } catch(error) { console.error(String(error)); process.exitCode=1; }
      finally { clearTimeout(deadline); }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env,
        CLAWSTRUM_HOME: home,
        [f.config.discord.tokenEnv]: 'isolated-test-token',
      },
      encoding: 'utf8',
      timeout: 35000,
    });
    assert.equal(result.status, failure === 'busy' ? 0 : 1, result.stdout + result.stderr);
    if (failure === 'busy') {
      assert.match(result.stderr, /database_busy/);
      assert.match(result.stdout, /RECOVERED_HEARTBEAT/);
      assert.equal((result.stdout.match(/"event":"ready"/g) ?? []).length, 1);
    } else {
      assert.match(result.stderr, /unexpected-test-fault/);
      assert.doesNotMatch(result.stdout, /RECOVERED_HEARTBEAT/);
    }
  });
}

test('a locked database read in the dashboard watch does not stop the daemon', (t) => {
  // dashboardWatchedFiles once hit "database is locked" outside the tick's busy
  // handler, the daemon exited with daemon_fatal and every running subagent was killed.
  const f = fixture(t);
  const home = path.join(f.home, 'daemon');
  fs.mkdirSync(home);
  f.config.discord.dashboard.enabled = true;
  f.config.discord.dashboard.watchIntervalMs = 10000;
  saveConfig(home, f.config);
  fs.writeFileSync(
    path.join(home, 'STORAGE.json'),
    JSON.stringify({ host: os.hostname(), directory: home, journalMode: 'DELETE' }),
  );
  const script = `
    import {main} from ${JSON.stringify(new URL('../dist/cli-main.js', import.meta.url).href)};
    import {Store} from ${JSON.stringify(new URL('../dist/store.js', import.meta.url).href)};
    import {Discord} from ${JSON.stringify(new URL('../dist/discord.js', import.meta.url).href)};
    Discord.prototype.connect = async () => {};
    Discord.prototype.tick = async () => {};
    Discord.prototype.close = async () => {};
    let ready = false, thrown = false;
    const log = console.log;
    console.log = (...args) => {
      if (args.some(value => typeof value === 'string' && value.includes('"event":"ready"'))) ready = true;
      log(...args);
    };
    const get = Store.prototype.get;
    Store.prototype.get = function(sql, ...params) {
      if (ready && !thrown && new Error().stack.includes('dashboardWatchedFiles')) {
        thrown = true;
        const error = new Error('database is locked');
        error.errcode = 5;
        throw error;
      }
      return get.call(this, sql, ...params);
    };
    const execute = Store.prototype.exec;
    Store.prototype.exec = function(sql, ...params) {
      const result = execute.call(this, sql, ...params);
      if (thrown && sql.includes("VALUES('heartbeat'")) {
        console.log('RECOVERED_HEARTBEAT');
        setImmediate(() => process.emit('SIGTERM'));
      }
      return result;
    };
    const deadline = setTimeout(() => process.exit(2), 40000);
    try { await main(['start']); } catch(error) { console.error(String(error)); process.exitCode=1; }
    finally { clearTimeout(deadline); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      CLAWSTRUM_HOME: home,
      [f.config.discord.tokenEnv]: 'isolated-test-token',
    },
    encoding: 'utf8',
    timeout: 45000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /"event":"database_busy","operation":"dashboard"/);
  assert.match(result.stdout, /RECOVERED_HEARTBEAT/);
  assert.doesNotMatch(result.stderr, /daemon_fatal/);
});

test('live snapshots preserve a running database and restore with manifests, checksums and private modes', async (t) => {
  const f = fixture(t);
  const unlock = acquireLock(f.home);
  t.after(unlock);
  f.enqueue('retained');
  const result = await liveBackup(f.home, path.join(f.home, 'backups'));
  const manifest = verifySnapshot(result.directory);
  assert.equal(manifest.sha256, result.manifest.sha256);
  assert.match(manifest.scope, /SQLite snapshot only/);
  assert.equal(fs.statSync(path.join(result.directory, 'clawstrum.db')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(result.directory, 'SNAPSHOT.json')).mode & 0o777, 0o600);
  f.enqueue('after-backup');
  const restoredHome = path.join(f.home, 'restored');
  fs.mkdirSync(restoredHome);
  fs.copyFileSync(
    path.join(result.directory, 'clawstrum.db'),
    path.join(restoredHome, 'clawstrum.db'),
  );
  const restored = new Store(restoredHome);
  try {
    assert.deepEqual(
      restored.all<any>('SELECT id FROM inbound').map((row) => row.id),
      ['retained'],
    );
  } finally {
    restored.close();
  }
  fs.appendFileSync(path.join(result.directory, 'clawstrum.db'), 'tamper');
  assert.throws(() => verifySnapshot(result.directory), /checksum/);
});

test('snapshot retention preserves the last copies, daily copies and unrelated files; failure keeps the previous latest', async (t) => {
  const f = fixture(t);
  const directory = path.join(f.home, 'backups');
  const start = Date.parse('2026-09-10T12:00:00Z');
  const results = [];
  for (const offset of [0, 86400000, 86400001, 86400002])
    results.push(
      await liveBackup(f.home, directory, { keepLast: 2, keepDays: 2, now: start + offset }),
    );
  assert.ok(fs.existsSync(results[0]!.directory));
  assert.ok(!fs.existsSync(results[1]!.directory));
  assert.ok(fs.existsSync(results[2]!.directory));
  assert.ok(fs.existsSync(results[3]!.directory));
  const foreign = path.join(directory, 'notes.db');
  fs.writeFileSync(foreign, 'not a snapshot');
  const latest = fs.readFileSync(path.join(directory, 'latest.json'));
  await assert.rejects(liveBackup(path.join(f.home, 'missing'), directory), /missing/);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'latest.json')), latest);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'not a snapshot');
  assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')).length, 0);
  const first = liveBackup(f.home, directory);
  await assert.rejects(liveBackup(f.home, directory), /Another backup/);
  await first;
});

test(
  'rollback-journal writers survive a snapshot read lock longer than five seconds',
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t),
      home = path.join(f.home, 'rollback');
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(home, 'STORAGE.json'),
      JSON.stringify({ host: os.hostname(), directory: home, journalMode: 'DELETE' }),
    );
    const writer = new Store(home);
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1],{readOnly:true});
    db.exec('BEGIN DEFERRED');
    db.prepare('SELECT count(*) FROM metadata').get();
    process.stdout.write('LOCKED');
    setTimeout(()=>{db.exec('ROLLBACK');db.close();},5500);
  `,
        path.join(home, 'clawstrum.db'),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(() => child.kill());
    try {
      const ended = new Promise<number | null>((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Reader exited before locking')));
      });
      writer.exec('INSERT INTO metadata(key,value) VALUES(?,?)', 'after-lock', 'retained');
      assert.equal(await ended, 0);
      const snapshot = await liveBackup(home, path.join(home, 'backups'));
      const restored = new DatabaseSync(path.join(snapshot.directory, 'clawstrum.db'), {
        readOnly: true,
      });
      try {
        assert.equal(
          restored.prepare("SELECT value FROM metadata WHERE key='after-lock'").get()?.value,
          'retained',
        );
      } finally {
        restored.close();
      }
    } finally {
      writer.close();
    }
  },
);

test('snapshot obeys the pinned storage location and rejects a different host', async (t) => {
  const f = fixture(t);
  const policyHome = path.join(f.home, 'policy');
  fs.mkdirSync(policyHome);
  const policy = path.join(policyHome, 'STORAGE.json');
  fs.writeFileSync(
    policy,
    JSON.stringify({ host: os.hostname(), directory: f.home, journalMode: 'WAL' }),
  );
  const snapshot = await liveBackup(policyHome, path.join(f.home, 'backups'));
  assert.equal(verifySnapshot(snapshot.directory).source, path.join(f.home, 'clawstrum.db'));
  fs.writeFileSync(
    policy,
    JSON.stringify({ host: 'different-host', directory: f.home, journalMode: 'WAL' }),
  );
  await assert.rejects(liveBackup(policyHome, path.join(f.home, 'backups')), /belongs to host/);
});

test('decision lint ignores examples, accepts dotted tags, and reports conflicts and invalid dates without editing', (t) => {
  const f = fixture(t);
  const text = [
    '## Active',
    '- 2026-09-17 [merge-5.1]: Keep.',
    '```md',
    '- 2026-09-17 [merge-5.1]: Example.',
    '```',
    '- 2026-09-18 [merge-5.1]: Changed.',
    '- 2026-02-30 [bad-date]: Impossible.',
    '## Superseded',
    '- 2026-09-10 [old]: Superseded by [merge-5.1].',
    '- 2026-09-09 [orphan]: No explanation.',
  ].join('\n');
  assert.deepEqual(
    lintDecisions(text).map((finding) => finding.code),
    ['duplicate', 'date', 'retirement'],
  );
  const target = path.join(f.home, 'decisions.md'),
    link = path.join(f.home, 'project.md');
  fs.writeFileSync(target, '- 2026-09-17 [simple.tag]: One decision.\n');
  fs.symlinkSync(target, link);
  assert.deepEqual(lintDecisionFile(link, target), []);
  assert.equal(lintDecisionFile(target, target)[0]!.code, 'shared-target');
  assert.equal(fs.readFileSync(target, 'utf8'), '- 2026-09-17 [simple.tag]: One decision.\n');
  assert.throws(() => lintDecisionFile(path.join(f.home, 'missing')), /ENOENT/);
});

test('durable file watches deduplicate, warn once and complete once after reopening state', async (t) => {
  const f = fixture(t),
    now = Date.now();
  const spec = {
    condition: { type: 'file', path: 'done.txt', nonempty: true },
    message: 'Read the result',
    intervalMs: 1000,
    timeoutMs: 60000,
    warnAfterMs: 1000,
  };
  const watch = addWatch(f.store, f.session.id, 'result', spec, now);
  assert.equal(addWatch(f.store, f.session.id, 'result', spec, now + 1).id, watch.id);
  assert.throws(
    () => addWatch(f.store, f.session.id, 'result', { ...spec, message: 'Changed' }),
    /key conflict/,
  );
  const reopened = new Store(f.home);
  const monitor = new WatchMonitor(reopened);
  try {
    await monitor.poll(now + 1001);
    await monitor.poll(now + 2002);
    assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
    fs.writeFileSync(path.join(f.session.workspace, 'done.txt'), 'complete');
    await monitor.poll(now + 3003);
    await monitor.poll(now + 4004);
    assert.equal(getWatch(f.store, watch.id)!.status, 'completed');
    assert.equal(f.store.all('SELECT * FROM inbound').length, 2);
    assert.match(f.store.all<any>('SELECT content FROM inbound')[1].content, /Read the result/);
  } finally {
    await monitor.stop();
    reopened.close();
  }
});

test('a conversation waiting on watches gets one status wake per quiet hour', (t) => {
  const f = fixture(t),
    now = Date.now(),
    hour = 3600000;
  const spec = {
    condition: { type: 'file', path: 'never.txt' },
    message: 'Report the copy',
    intervalMs: 1000,
    timeoutMs: 10 * hour,
  };
  addWatch(f.store, f.session.id, 'copy', spec, now);
  addWatch(f.store, f.session.id, 'guard', { ...spec, message: 'Guard' }, now);
  const monitor = new WatchMonitor(f.store);
  const wakes = () =>
    f.store.all<{ content: string }>("SELECT content FROM inbound WHERE id LIKE 'watch-status:%'");
  monitor.statusWakes(now + hour - 120000);
  assert.equal(wakes().length, 0, 'not before an hour has passed');
  monitor.statusWakes(now + hour);
  assert.equal(wakes().length, 1, 'one wake for two watches');
  assert.match(wakes()[0]!.content, /copy, guard/);
  monitor.statusWakes(now + hour + 120000);
  assert.equal(wakes().length, 1, 'not again within the hour');
  f.store.exec(
    "INSERT INTO outbox(id,dedupe_key,session_id,content,status,created_at,available_at,payload_hash,origin) VALUES('o1','k1',?,'status','sent',?,?,'h','agent')",
    f.session.id,
    now + 2 * hour - 60000,
    now + 2 * hour - 60000,
  );
  monitor.statusWakes(now + 2 * hour + 60000);
  assert.equal(wakes().length, 1, 'a message sent in the last hour resets the clock');
  monitor.statusWakes(now + 3 * hour);
  assert.equal(wakes().length, 2);
});

test('watch cancellation wins over an in-flight result and expiry cannot claim success', async (t) => {
  const f = fixture(t),
    now = Date.now();
  const spec = {
    condition: { type: 'file', path: 'result' },
    message: 'SUCCESS ONLY',
    intervalMs: 1000,
    timeoutMs: 2000,
  };
  const watch = addWatch(f.store, f.session.id, 'cancel-me', spec, now);
  let release!: (value: boolean) => void;
  const monitor = new WatchMonitor(
    f.store,
    async () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const pending = monitor.poll(now);
  assert.equal(cancelWatch(f.store, watch.id, 'wrong-session'), false);
  assert.equal(cancelWatch(f.store, watch.id, f.session.id), true);
  release(true);
  await pending;
  assert.equal(f.store.all('SELECT * FROM inbound').length, 0);
  const expired = addWatch(f.store, f.session.id, 'expired', spec, now);
  await monitor.poll(now + 2001);
  assert.equal(getWatch(f.store, expired.id)!.status, 'timed_out');
  assert.match(
    f.store.all<any>('SELECT content FROM inbound')[0].content,
    /without confirmed completion/,
  );
  await monitor.poll(now + 4000);
  assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
  await monitor.stop();
});

test('command watches use argv without a shell and terminate a hung process group', async (t) => {
  const f = fixture(t);
  const signal = new AbortController().signal;
  const escaped = 'literal $(touch SHOULD_NOT_EXIST)';
  const spec = watchSpecSchema.parse({
    condition: {
      type: 'command',
      cwd: f.home,
      argv: [process.execPath, '-e', 'process.exit(process.argv[1].includes("$(")?0:1)', escaped],
    },
    message: 'Done',
    checkTimeoutMs: 200,
  });
  assert.equal(await checkCondition(spec, signal), true);
  assert.equal(fs.existsSync(path.join(f.home, 'SHOULD_NOT_EXIST')), false);
  const pidFile = path.join(f.home, 'probe.pid');
  spec.condition = {
    type: 'command',
    cwd: f.home,
    argv: [
      process.execPath,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
    ],
  };
  const before = Date.now();
  await assert.rejects(checkCondition(spec, signal), /timed out/);
  assert.ok(Date.now() - before < 3000);
  if (fs.existsSync(pidFile))
    assert.throws(() => process.kill(Number(fs.readFileSync(pidFile)), 0));
});

test('command watches do not inherit credentials from the daemon', async (t) => {
  const f = fixture(t);
  t.after(() => delete process.env.WATCH_PROBE_API_KEY);
  process.env.WATCH_PROBE_API_KEY = 'probe-secret';
  const spec = watchSpecSchema.parse({
    condition: {
      type: 'command',
      cwd: f.home,
      argv: [process.execPath, '-e', 'process.exit(process.env.WATCH_PROBE_API_KEY?1:0)'],
    },
    message: 'Done',
  });
  assert.equal(await checkCondition(spec, new AbortController().signal), true);
});

test('a crashing check is an error, not "not yet", and wakes the conversation once', async (t) => {
  const f = fixture(t);
  const signal = new AbortController().signal;
  const crash = watchSpecSchema.parse({
    condition: {
      type: 'command',
      cwd: f.home,
      argv: [
        process.execPath,
        '-e',
        'process.stderr.write("Traceback (most recent call last):\\nTypeError: bad keyword\\n");process.exit(1)',
      ],
    },
    message: 'Serve idle',
  });
  await assert.rejects(
    checkCondition(crash, signal),
    /crashed \(exit 1\).*TypeError: bad keyword/s,
  );
  // A plain "not yet" that writes ordinary stderr stays false.
  const notYet = watchSpecSchema.parse({
    condition: {
      type: 'command',
      argv: [
        process.execPath,
        '-e',
        'process.stderr.write("grep: no such file\\n");process.exit(2)',
      ],
    },
    message: 'Done',
  });
  assert.equal(await checkCondition(notYet, signal), false);
  // A probe that leaves a child holding stderr still finishes after it exits.
  const lingering = watchSpecSchema.parse({
    condition: {
      type: 'command',
      argv: [
        process.execPath,
        '-e',
        "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:['ignore','ignore','inherit']});process.exit(0)",
      ],
    },
    message: 'Done',
    checkTimeoutMs: 3000,
  });
  const before = Date.now();
  assert.equal(await checkCondition(lingering, signal), true);
  assert.ok(Date.now() - before < 2000);

  const now = Date.now();
  const watch = addWatch(f.store, f.session.id, 'serve-idle', crash, now);
  const monitor = new WatchMonitor(f.store);
  for (let i = 0; i < WATCH_FAILURE_WAKE_AFTER + 2; i++) await monitor.poll(now + i * 600000);
  const wakes = f.store.all<any>('SELECT content FROM inbound');
  assert.equal(wakes.length, 1);
  assert.match(wakes[0].content, /serve-idle cannot fire: its check failed 3 times in a row/);
  assert.match(wakes[0].content, /TypeError: bad keyword/);
  const saved = getWatch(f.store, watch.id)!;
  assert.equal(saved.status, 'active');
  assert.equal(saved.failureReported, true);
  await monitor.stop();
});

test('stopping the watch monitor aborts checks without completing or losing durable watches', async (t) => {
  const f = fixture(t);
  const watch = addWatch(f.store, f.session.id, 'stop', {
    condition: { type: 'command', argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'] },
    message: 'Done',
  });
  const monitor = new WatchMonitor(f.store);
  monitor.tick();
  await delay(40);
  await monitor.stop();
  assert.equal(getWatch(f.store, watch.id)!.status, 'active');
  assert.equal(f.store.all('SELECT * FROM inbound').length, 0);
  assert.equal(monitor.busy, false);
});

function ready(f: ReturnType<typeof fixture>, now = Date.now()) {
  const unlock = acquireLock(f.home);
  const instance = daemonReady(f.store, true, now);
  f.store.exec(
    "INSERT INTO metadata(key,value) VALUES('heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    String(now),
  );
  return { unlock, instance };
}
test('coordinated drain finishes existing work, holds newly arriving inputs and can be cancelled', async (t) => {
  const f = fixture(t);
  const { unlock, instance } = ready(f);
  t.after(unlock);
  let release!: (value: string) => void;
  const provider = {
    run: async () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  engine.daemonInstance = instance.id;
  t.after(() => engine.stop());
  f.enqueue('first');
  engine.tick();
  await delay(20);
  const request = requestRestart(f.store);
  f.enqueue('arrived-during-drain');
  engine.tick();
  assert.equal(engine.draining, true);
  assert.equal(engine.active.size, 1);
  assert.equal(
    f.store.get<any>("SELECT status FROM inbound WHERE id='arrived-during-drain'").status,
    'queued',
  );
  assert.equal(commitRestart(f.store, instance.id), false);
  release('Completed');
  await settle(engine);
  assert.equal(commitRestart(f.store, instance.id), false, 'Pending deliveries also block restart');
  f.store.exec("UPDATE outbox SET status='sent'");
  assert.equal(commitRestart(f.store, instance.id), true);
  assert.equal(cancelRestart(f.store), false, 'Committed restart cannot be cancelled');
  const replacement = daemonReady(f.store, true);
  assert.equal(restartStatus(f.store)!.id, request.id);
  assert.equal(restartStatus(f.store)!.status, 'ready');
  assert.notEqual(replacement.id, instance.id);
  const next = new Engine(f.config, f.store, { claude: ok, codex: ok });
  next.daemonInstance = replacement.id;
  requestRestart(f.store);
  next.tick();
  assert.equal(next.active.size, 0);
  assert.equal(cancelRestart(f.store), true);
  next.tick();
  await settle(next);
  assert.equal(
    f.store.get<any>("SELECT status FROM inbound WHERE id='arrived-during-drain'").status,
    'done',
  );
  await next.stop();
});

test('restart timeout releases admission; unsupervised and unresponsive daemons reject requests', (t) => {
  const f = fixture(t),
    now = Date.now();
  const { unlock, instance } = ready(f, now);
  t.after(unlock);
  requestRestart(f.store, 1000, now);
  assert.equal(drainingRestart(f.store, instance.id, now), true);
  assert.equal(drainingRestart(f.store, instance.id, now + 1000), false);
  assert.equal(restartStatus(f.store)!.status, 'timed_out');
  daemonReady(f.store, false, now);
  assert.throws(() => requestRestart(f.store, 1000, now), /supervision/);
  daemonReady(f.store, true, now);
  assert.throws(() => requestRestart(f.store, 1000, now + 16000), /responsive/);
});

test('restart grace is bounded even with background work and deliveries; idle-only remains explicit', (t) => {
  const f = fixture(t),
    now = Date.now();
  const { unlock, instance } = ready(f, now);
  t.after(unlock);
  const request = requestRestart(f.store, 60000, now);
  assert.equal(request.checkpointAt, now + 30000);
  drainingRestart(f.store, instance.id, now);
  f.store.outbox(f.session.id, 'Pending');
  assert.equal(commitRestart(f.store, instance.id, now + 29999, false), false);
  assert.equal(commitRestart(f.store, instance.id, now + 30000, false), true);
  const next = daemonReady(f.store, true, now + 30001);
  requestRestart(f.store, 60000, now + 30001, 0);
  drainingRestart(f.store, next.id, now + 30001);
  assert.equal(commitRestart(f.store, next.id, now + 60001, false), false);
  assert.equal(cancelRestart(f.store), true);
  assert.throws(() => requestRestart(f.store, 60000, now + 30001, -1), /drain/);
});

test('compiled restart checkpoints a long turn and resumes native history and queued channel requests', async (t) => {
  const f = fixture(t);
  saveConfig(f.home, f.config);
  f.enqueue('long');
  const initial = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {Discord} from './dist/discord.js';
    import {main} from './dist/cli-main.js';
    import {Store} from './dist/store.js';
    import {supervisedProviders} from './dist/supervisor.js';
    import {requestRestart} from './dist/restart.js';
    const store=new Store(process.env.CLAWSTRUM_HOME);
    Discord.prototype.connect=async function(){};
    Discord.prototype.tick=async function(){};
    Discord.prototype.close=async function(){};
    supervisedProviders.claude={run:async r=>{
      r.onEvent({type:'session',sessionId:'native-long'});
      r.onEvent({type:'partial',detail:'Saved progress'});
      requestRestart(store,10000,Date.now(),100);
      const channel=store.ensureSession('777777');
      store.enqueue({id:'other-channel',sessionId:channel.id,author:'owner',content:'Waiting'});
      await new Promise((_,reject)=>r.controller.signal.addEventListener('abort',()=>reject(r.controller.signal.reason),{once:true}));
      return '';
    }};
    await main(['start']);store.close();
  `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAWSTRUM_HOME: f.home,
        CLAWSTRUM_SUPERVISED: '1',
        DISCORD_BOT_TOKEN: 'test',
      },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(initial.status, 75, initial.stderr);
  assert.equal(f.store.session(f.session.id).remote_id, 'native-long');
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='long'").status, 'queued');
  assert.equal(
    f.store.get<any>("SELECT status FROM inbound WHERE id='other-channel'").status,
    'queued',
  );
  assert.match(initial.stdout, /planned_restart/);
  assert.equal(restartStatus(f.store)!.status, 'restarting');
  assert.ok(f.store.get("SELECT seq FROM events WHERE type='interrupted'"));
  const resumes: Array<string | undefined> = [];
  const p = {
    async run(r: import('../src/types.js').ProviderRequest) {
      resumes.push(r.sessionId);
      return 'Finished';
    },
  };
  const replacement = new Engine(f.config, f.store, { claude: p, codex: p });
  replacement.start();
  replacement.daemonInstance = daemonReady(f.store, true).id;
  replacement.tick();
  await settle(replacement);
  assert.ok(resumes.includes('native-long'));
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='long'").status, 'done');
  assert.equal(
    f.store.get<any>("SELECT status FROM inbound WHERE id='other-channel'").status,
    'done',
  );
  assert.equal(restartStatus(f.store)!.status, 'ready');
  await replacement.stop();
});

test('compiled daemon exits 75 only after drain; replacement reports readiness and handles queued input', (t) => {
  const f = fixture(t);
  saveConfig(f.home, f.config);
  const common = `
    import {Discord} from './dist/discord.js';
    import {main} from './dist/cli-main.js';
    import {Store} from './dist/store.js';
    import {supervisedProviders} from './dist/supervisor.js';
    import {requestRestart} from './dist/restart.js';
    const store=new Store(process.env.CLAWSTRUM_HOME);
    Discord.prototype.connect=async function(){};
    Discord.prototype.tick=async function(){store.exec("UPDATE outbox SET status='sent'");};
    Discord.prototype.close=async function(){};
    supervisedProviders.claude={run:async()=>{await new Promise(r=>setTimeout(r,800));return 'Finished';}};
  `;
  f.enqueue('first');
  const initial = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      common +
        `
    supervisedProviders.claude={run:async()=>{
      requestRestart(store,10000);
      store.enqueue({id:'late',sessionId:${JSON.stringify(f.session.id)},author:'owner',content:'Later'});
      await new Promise(r=>setTimeout(r,800));return 'Finished';
    }};
    await main(['start']);store.close();
  `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAWSTRUM_HOME: f.home,
        CLAWSTRUM_SUPERVISED: '1',
        DISCORD_BOT_TOKEN: 'local-test-only',
      },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(initial.status, 75, initial.stderr);
  assert.match(initial.stdout, /planned_restart/);
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='first'").status, 'done');
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='late'").status, 'queued');
  assert.equal(fs.existsSync(path.join(f.home, 'daemon.lock')), false);
  const replacement = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      common +
        `
    const timer=setInterval(()=>{
      if(store.get("SELECT id FROM inbound WHERE id='late' AND status='done'") && !store.get("SELECT id FROM outbox WHERE status='pending'")) {
        clearInterval(timer);process.kill(process.pid,'SIGTERM');
      }
    },50);
    await main(['start']);store.close();
  `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAWSTRUM_HOME: f.home,
        CLAWSTRUM_SUPERVISED: '1',
        DISCORD_BOT_TOKEN: 'local-test-only',
      },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(replacement.status, 0, replacement.stderr);
  assert.equal(restartStatus(f.store)!.status, 'ready');
  assert.equal(restartStatus(f.store)!.readyPid, replacement.pid);
  assert.notEqual(initial.pid, replacement.pid);
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='late'").status, 'done');
});

test('review day windows follow local calendar boundaries on 23-hour, 25-hour and fractional-offset days', () => {
  const spring = dayWindow('2026-03-08', 'America/New_York');
  const fall = dayWindow('2026-11-01', 'America/New_York');
  assert.equal(spring.end - spring.start, 23 * 3600000);
  assert.equal(fall.end - fall.start, 25 * 3600000);
  assert.equal(
    new Date(dayWindow('2026-09-17', 'Asia/Kathmandu').start).toISOString(),
    '2026-09-16T18:15:00.000Z',
  );
  assert.throws(() => dayWindow('2026-02-30', 'UTC'), /valid/);
  assert.throws(() => dayWindow('2011-12-30', 'Pacific/Apia'), /does not exist/);
});

test('review snapshots count actual delivery, exclude notices, allow next-day replies and leave live state untouched', async (t) => {
  const f = fixture(t);
  const at = Date.parse('2026-09-16T23:55:00Z'),
    now = Date.parse('2026-09-18T00:00:00Z');
  f.store.enqueue({
    id: 'question',
    sessionId: f.session.id,
    author: 'owner',
    content: 'Question',
    at,
  });
  const reply = f.store.outbox(f.session.id, 'Answer', { key: 'reply', origin: 'agent' });
  f.store.exec("UPDATE outbox SET status='sent',created_at=? WHERE id=?", at - 86400000, reply);
  f.store.exec(
    'INSERT INTO events(session_id,type,content,created_at) VALUES(?,?,?,?)',
    f.session.id,
    'delivered',
    JSON.stringify({ outboxId: reply }),
    at + 10 * 60000,
  );
  f.store.outbox(f.session.id, 'Unsent answer', { key: 'unsent', origin: 'agent' });
  const notice = f.store.outbox(f.session.id, 'Capacity notice', {
    key: 'notice',
    origin: 'notice',
  });
  f.store.exec("UPDATE outbox SET status='sent',created_at=? WHERE id=?", at + 60000, notice);
  const before = f.store.all('SELECT * FROM inbound');
  const output = path.join(f.home, 'reviews');
  await collectReview(f.home, output, ['2026-09-16'], {}, now);
  const result = JSON.parse(fs.readFileSync(path.join(output, '2026-09-16/METRICS.json'), 'utf8'))
    .metrics[0];
  assert.equal(result.inputs, 1);
  assert.equal(result.replies, 0, 'The reply was delivered on the next calendar date');
  assert.equal(result.notices, 1);
  assert.equal(result.inputsWithReplyWithinWindow, 1);
  assert.equal(result.medianReplyLatencySeconds, 600);
  assert.deepEqual(f.store.all('SELECT * FROM inbound'), before);
  assert.equal(fs.statSync(path.join(output, '2026-09-16/MESSAGES.json')).mode & 0o777, 0o600);
  assert.deepEqual(
    pendingReviewDays(output, '2026-09-16', '2026-09-16'),
    ['2026-09-16'],
    'Collection is not a completed review',
  );
});

test('review catch-up detects holes before later completed dates and rejects stale reports or settings', async (t) => {
  const f = fixture(t);
  const output = path.join(f.home, 'reviews');
  await collectReview(
    f.home,
    output,
    ['2026-09-14', '2026-09-15', '2026-09-16'],
    {},
    Date.parse('2026-09-18T00:00:00Z'),
  );
  const report = path.join(output, 'report.md');
  fs.writeFileSync(report, 'Evidence, action and predicted outcome.');
  for (const day of ['2026-09-14', '2026-09-16']) completeReview(output, day, report);
  assert.deepEqual(pendingReviewDays(output, '2026-09-14', '2026-09-16'), ['2026-09-15']);
  await collectReview(f.home, output, ['2026-09-14'], {}, Date.parse('2026-09-18T00:00:00Z'));
  assert.deepEqual(pendingReviewDays(output, '2026-09-14', '2026-09-16'), [
    '2026-09-14',
    '2026-09-15',
  ]);
  assert.equal(
    pendingReviewDays(output, '2026-09-14', '2026-09-16', { timezone: 'America/New_York' }).length,
    3,
  );
  fs.writeFileSync(report, 'Changed report');
  assert.equal(pendingReviewDays(output, '2026-09-14', '2026-09-16').length, 3);
  await assert.rejects(
    collectReview(path.join(f.home, 'missing'), output, ['2026-09-16']),
    /missing/,
  );
});

test('review collection serializes output and does not allow a partial day to be marked reviewed', async (t) => {
  const f = fixture(t),
    directory = path.join(f.home, 'reviews');
  const now = Date.parse('2026-09-16T12:00:00Z');
  const running = collectReview(f.home, directory, ['2026-09-16'], {}, now);
  await assert.rejects(collectReview(f.home, directory, ['2026-09-16'], {}, now), /Another review/);
  await running;
  const report = path.join(directory, 'report.md');
  fs.writeFileSync(report, 'Partial evidence.');
  assert.throws(() => completeReview(directory, '2026-09-16', report), /completed calendar day/);
});

test('file-watch completion enters the regular engine queue once without polling a model', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const provider = {
    run: async () => {
      calls++;
      return 'Validated result';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  const watch = addWatch(f.store, f.session.id, 'engine-watch', {
    condition: { type: 'file', path: 'result' },
    message: 'Validate output',
  });
  await engine.watches.poll();
  assert.equal(calls, 0);
  fs.writeFileSync(path.join(f.session.workspace, 'result'), 'done');
  await engine.watches.poll(Date.now() + 60001);
  engine.tick(Date.now() + 60002);
  await settle(engine);
  assert.equal(calls, 1);
  assert.equal(getWatch(f.store, watch.id)!.status, 'completed');
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE kind='task'").status, 'done');
  await engine.stop();
});

test('backup service units escape paths and preserve supervision for planned restarts', (t) => {
  const f = fixture(t);
  const units = backupUnits(
    f.home,
    process.execPath,
    path.resolve('dist/cli.js'),
    path.join(f.home, 'back ups $HOME %x'),
    123,
    3,
    2,
  );
  assert.match(units.service, /\$\$HOME %%x/);
  assert.match(units.timer, /OnUnitInactiveSec=123s/);
  assert.match(
    serviceUnit(f.home, process.execPath, path.resolve('dist/cli.js')),
    /CLAWSTRUM_SUPERVISED=1/,
  );
  assert.throws(
    () => backupUnits(f.home, process.execPath, 'cli', '/tmp/out\nExecStart=bad'),
    /control characters/,
  );
  const service = path.join(f.home, 'clawstrum-backup.service');
  const timer = path.join(f.home, 'clawstrum-backup.timer');
  fs.writeFileSync(service, units.service);
  fs.writeFileSync(timer, units.timer);
  const result = spawnSync('systemd-analyze', ['--user', 'verify', service, timer], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (
    !result.error &&
    !/Failed to (connect|initialize|lookup)|No such file or directory/.test(result.stderr)
  )
    assert.equal(result.status, 0, result.stderr);
});

test('health timer posts each failing set once, retries a failed post, and reports recovery', async (t) => {
  const f = fixture(t);
  const posts: string[] = [];
  const post = async (content: string) => void posts.push(content);
  const daemon = { check: 'Daemon', ok: true, detail: 'live' };
  const disk = { check: 'Disk space', ok: false, detail: '0.5 GiB free of 100.0 GiB' };
  assert.equal(await notifyHealth(f.store, [daemon], post), false);
  assert.equal(await notifyHealth(f.store, [daemon, disk], post), true);
  assert.equal(await notifyHealth(f.store, [daemon, { ...disk, detail: '0.4 GiB' }], post), false);
  await assert.rejects(
    notifyHealth(f.store, [{ ...daemon, ok: false }, disk], async () => {
      throw new Error('offline');
    }),
    /offline/,
  );
  assert.equal(await notifyHealth(f.store, [{ ...daemon, ok: false }, disk], post), true);
  assert.equal(await notifyHealth(f.store, [daemon], post), true);
  assert.equal(posts.length, 3);
  assert.match(posts[0]!, /Disk space: 0\.5 GiB free/);
  assert.match(posts[2]!, /pass again/);
  assert.equal(diskCheck(2 ** 30, 10 * 2 ** 30).ok, true);
  assert.equal(diskCheck(2 ** 30 - 1, 10 * 2 ** 30).ok, false);
  assert.equal(diskCheck(3 * 2 ** 30, 1000 * 2 ** 30).ok, false);
  assert.ok(healthChecks(f.store, f.config).some((c) => c.check === 'Disk space'));
  const units = healthUnits(f.home, process.execPath, path.resolve('dist/cli.js'), 120);
  assert.match(units.service, /cli\.js" doctor --notify/);
  assert.match(units.timer, /OnUnitInactiveSec=120s\nUnit=clawstrum-health\.service/);
  assert.throws(() => healthUnits(f.home, process.execPath, 'cli', 5), /intervalSeconds/);
});

test('the health check also watches the database disk when STORAGE.json moves the database', (t) => {
  const f = fixture(t);
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-db-'));
  t.after(() => fs.rmSync(dbDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(f.home, 'STORAGE.json'),
    JSON.stringify({ host: os.hostname(), journalMode: 'WAL', directory: dbDir }),
  );
  const gib = 2 ** 30;
  const statfs = (dir: string) =>
    dir === dbDir
      ? { type: 2, bsize: 4096, blocks: (100 * gib) / 4096, bavail: (0.2 * gib) / 4096 }
      : { type: 1, bsize: 4096, blocks: (100 * gib) / 4096, bavail: (50 * gib) / 4096 };
  const checks = healthChecks(f.store, f.config, Date.now(), statfs);
  assert.equal(checks.find((c) => c.check === 'Disk space')!.ok, true);
  const db = checks.find((c) => c.check === 'Database disk space');
  assert.equal(db?.ok, false);
  assert.match(db!.detail, /0\.2 GiB free/);
  // Same filesystem as home: one check, not two.
  const same = healthChecks(f.store, f.config, Date.now(), () => statfs(f.home));
  assert.equal(same.filter((c) => /Disk space/i.test(c.check)).length, 1);
});
