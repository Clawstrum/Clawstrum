import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { acquireLock } from '../src/lock.js';
import { planNanoClaw, importNanoClaw } from '../src/migration/nanoclaw.js';

function legacy(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-import-'));
  const backup = path.join(root, 'offline.db');
  const home = path.join(root, 'new-home');
  const groups = path.join(root, 'install', 'groups');
  const db = new DatabaseSync(backup);
  db.exec(`
    CREATE TABLE registered_groups(jid,folder,name,added_at);
    CREATE TABLE messages(id,chat_jid,sender,sender_name,content,timestamp,is_from_me,is_bot_message);
    CREATE TABLE scheduled_tasks(id,group_folder,chat_jid,prompt,schedule_type,schedule_value,next_run,status,created_at);
    CREATE TABLE task_run_logs(id,task_id,run_at,duration_ms,status,result,error);
    CREATE TABLE router_state(key,value);
    CREATE TABLE sessions(group_folder,session_id);
    INSERT INTO registered_groups VALUES('dc:987654','group_a','Agent','2020-01-01 00:00:00');
    INSERT INTO messages VALUES('111111','dc:987654','owner','Human','Already handled','2020-01-01T01:00:00',0,0);
    INSERT INTO messages VALUES('111112','dc:987654','owner','Human','Unread','2020-01-01T02:00:00',0,0);
    INSERT INTO router_state VALUES('last_agent_timestamp','{"dc:987654":"2020-01-01T01:00:00"}');
    INSERT INTO scheduled_tasks VALUES('cron','group_a','dc:987654','Read /old/nanoclaw/sub/logs and /old/nanoclaw-copy/logs and /old/nanoclaw/foo','cron','0 9 * * *','2020-01-02T09:00:00','active','2020-01-01T00:00:00');
    INSERT INTO scheduled_tasks VALUES('once','group_a','dc:987654','Report','once','2020-01-02T09:00:00','2020-01-02T09:00:00','active','2020-01-01T00:00:00');
  `);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['dist/cli.js', 'import', 'nanoclaw', ...args], {
      encoding: 'utf8',
      env: { ...process.env, CLAWSTRUM_HOME: home, ...env },
      timeout: 15000,
    });
  const edit = (sql: string) => {
    const db = new DatabaseSync(backup);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  return { root, backup, home, groups, cli, edit };
}

test('CLI preview needs no config, creates no home or workspaces, and leaves the source unchanged', (t) => {
  const f = legacy(t),
    before = fs.readFileSync(f.backup);
  const r = f.cli(['--groups-root', f.groups, '--source-root', '/old/nanoclaw', f.backup]);
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.equal(p.applied, false);
  assert.equal(p.plan.destinationEmpty, true);
  assert.equal(p.plan.counts.pending, 1);
  assert.equal(p.plan.sessions[0].id, 'group_a');
  assert.equal(fs.existsSync(f.home), false);
  assert.equal(fs.existsSync(f.groups), false);
  assert.deepEqual(fs.readFileSync(f.backup), before);
});

test('preview inspects existing state read-only without upgrading its schema or loading credentials', (t) => {
  const f = legacy(t);
  fs.mkdirSync(f.home);
  const file = path.join(f.home, 'clawstrum.db');
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE sessions(id); INSERT INTO sessions VALUES('existing'); CREATE TABLE schema_version(version); INSERT INTO schema_version VALUES(1)",
  );
  db.close();
  fs.chmodSync(file, 0o400);
  fs.writeFileSync(path.join(f.home, '.env'), 'deliberately invalid credentials file');
  const before = fs.readFileSync(file);
  const r = f.cli([f.backup, '--groups-root', f.groups]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).plan.blockers.join(' '), /empty destination/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mode & 0o777, 0o400);
  assert.equal(fs.existsSync(f.groups), false);
});

test('missing, misspelled and ambiguous import arguments fail before creating state', (t) => {
  const f = legacy(t);
  for (const args of [
    [f.backup, '--groups-root'],
    [f.backup, '--groups-root', f.groups, '--source-root'],
    [f.backup, '--groups-root', f.groups, '--timezone'],
    [f.backup, '--groups-root', f.groups, '--prefix'],
    [f.backup, '--groups-root', f.groups, '--aply'],
    [f.backup, '--groups-root', f.groups, '--due-tasks', 'oops'],
    [f.backup, '--groups-root', f.groups, '--prefix', 'one', '--prefix', 'two'],
    [f.backup, f.backup, '--groups-root', f.groups],
  ]) {
    const r = f.cli([...args, '--apply']);
    assert.notEqual(r.status, 0, JSON.stringify(args));
    assert.equal(fs.existsSync(f.home), false);
    assert.equal(fs.existsSync(f.groups), false);
  }
});

test('apply refuses while the destination daemon mutex is held', (t) => {
  const f = legacy(t);
  const s = new Store(f.home);
  s.close();
  const unlock = acquireLock(f.home);
  try {
    const r = f.cli([f.backup, '--groups-root', f.groups, '--apply']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /already running/);
    assert.equal(fs.existsSync(f.groups), false);
    const db = new DatabaseSync(path.join(f.home, 'clawstrum.db'), { readOnly: true });
    try {
      assert.equal((db.prepare('SELECT count(*) n FROM sessions').get() as any).n, 0);
    } finally {
      db.close();
    }
  } finally {
    unlock();
  }
});

test('CLI apply uses portable UTC timestamps and whole-root rewrites, preserving unread input', (t) => {
  const f = legacy(t),
    before = fs.readFileSync(f.backup);
  const r = f.cli(
    [
      f.backup,
      '--groups-root',
      f.groups,
      '--source-root',
      '/old/nanoclaw/',
      '--source-root',
      '/old/nanoclaw/sub',
      '--timezone',
      'America/New_York',
      '--apply',
    ],
    { TZ: 'Asia/Tokyo' },
  );
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.equal(p.applied, true);
  const s = new Store(f.home);
  try {
    assert.deepEqual(
      s.all<any>('SELECT id,status FROM inbound ORDER BY id').map((r) => [r.id, r.status]),
      [
        ['111111', 'done'],
        ['111112', 'queued'],
      ],
    );
    assert.equal(
      s.get<any>("SELECT created_at FROM inbound WHERE id='111112'").created_at,
      Date.parse('2020-01-01T02:00:00Z'),
    );
    const cron = s.get<any>("SELECT * FROM tasks WHERE id='cron'");
    assert.equal(
      cron.prompt,
      `Read ${path.dirname(f.groups)}/logs and /old/nanoclaw-copy/logs and ${path.dirname(f.groups)}/foo`,
    );
    assert.equal(cron.timezone, 'America/New_York');
    assert.ok(cron.next_run > Date.now());
    assert.equal(s.get<any>("SELECT status FROM tasks WHERE id='once'").status, 'cancelled');
    assert.equal(fs.statSync(s.session('group_a').workspace).isDirectory(), true);
  } finally {
    s.close();
  }
  assert.deepEqual(fs.readFileSync(f.backup), before);
  const repeat = f.cli([f.backup, '--groups-root', f.groups, '--apply']);
  assert.notEqual(repeat.status, 0);
  assert.match(repeat.stderr, /empty destination/);
});

test('preview blocks invalid roots, clocks, policies and cron expressions before apply writes', (t) => {
  const f = legacy(t);
  for (const options of [
    { sourceRoots: [''] },
    { sourceRoots: ['/'] },
    { sourceRoots: ['relative/path'] },
    { now: NaN },
    { dueTasks: 'wrong' as any },
    { timezone: 'Not/A_Zone' },
  ]) {
    assert.ok(planNanoClaw(f.home, f.backup, f.groups, options).blockers.length > 0);
    assert.equal(fs.existsSync(f.home), false);
  }
  f.edit("UPDATE scheduled_tasks SET schedule_value='bad cron' WHERE id='cron'");
  const r = f.cli([f.backup, '--groups-root', f.groups, '--apply']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Legacy cron/);
  assert.equal(fs.existsSync(f.home), false);
  assert.equal(fs.existsSync(f.groups), false);
});

test('duplicate workspace mappings and non-directory workspaces are visible blockers', (t) => {
  const f = legacy(t);
  f.edit(
    "INSERT INTO registered_groups VALUES('dc:987655','group_a','Other','2020-01-01T00:00:00Z')",
  );
  assert.match(
    planNanoClaw(f.home, f.backup, f.groups).blockers.join(' '),
    /Duplicate legacy workspace/,
  );
  f.edit("DELETE FROM registered_groups WHERE jid='dc:987655'");
  fs.mkdirSync(f.groups, { recursive: true });
  fs.writeFileSync(path.join(f.groups, 'group_a'), 'Existing file');
  assert.match(planNanoClaw(f.home, f.backup, f.groups).blockers.join(' '), /not a directory/);
});

test('cancel/fire policies and missing cron next-run produce the advertised plan', (t) => {
  const f = legacy(t);
  const now = Date.parse('2026-01-01T12:00:00Z');
  const cancel = planNanoClaw(f.home, f.backup, f.groups, { now, dueTasks: 'cancel' });
  assert.ok(cancel.tasks.every((task) => task.status === 'cancelled' && task.nextRun === null));
  const fire = planNanoClaw(f.home, f.backup, f.groups, { now, dueTasks: 'fire' });
  assert.ok(fire.tasks.every((task) => task.action === 'import' && task.status === 'active'));
  assert.match(fire.warnings.join(' '), /already due/);
  f.edit("UPDATE scheduled_tasks SET next_run=NULL WHERE id='cron'");
  const reschedule = planNanoClaw(f.home, f.backup, f.groups, { now });
  assert.equal(reschedule.tasks.find((task) => task.id === 'cron')!.action, 'reschedule');
  assert.doesNotMatch(reschedule.warnings.join(' '), /will never fire/);
});

test('library apply detects a nonempty destination before creating workspaces', (t) => {
  const f = legacy(t),
    s = new Store(f.home);
  try {
    s.ensureSession('123456');
    assert.throws(() => importNanoClaw(s, f.backup, f.groups), /empty destination/);
    assert.equal(fs.existsSync(f.groups), false);
  } finally {
    s.close();
  }
});

test('preview respects storage host ownership before opening a destination database', (t) => {
  const f = legacy(t);
  fs.mkdirSync(f.home);
  fs.writeFileSync(
    path.join(f.home, 'STORAGE.json'),
    JSON.stringify({ host: os.hostname() + '-other', directory: f.home, journalMode: 'DELETE' }),
  );
  const r = f.cli([f.backup, '--groups-root', f.groups]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /belongs to host/);
  assert.equal(fs.existsSync(path.join(f.home, 'clawstrum.db')), false);
});
