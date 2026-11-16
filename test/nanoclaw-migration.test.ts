import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, ok } from './helpers.js';
import { Discord, accepts } from '../src/discord.js';
import { Engine } from '../src/engine.js';
import { importNanoClaw, planNanoClaw } from '../src/migration/nanoclaw.js';
import { ClusterMonitor, watchJob } from '../src/research/cluster.js';
import { researchSchema } from '../src/research/config.js';

test('legacy import preserves history, destinations and unread input without replaying sent messages', (t) => {
  const f = fixture(t);
  f.store.exec('DELETE FROM sessions');
  const source = path.join(f.home, 'offline.db');
  const db = new DatabaseSync(source);
  db.exec(`
    CREATE TABLE registered_groups(jid,folder,name,added_at);
    CREATE TABLE messages(id,chat_jid,sender,sender_name,content,timestamp,is_from_me,is_bot_message);
    CREATE TABLE scheduled_tasks(id,group_folder,chat_jid,prompt,schedule_type,schedule_value,next_run,status,created_at);
    CREATE TABLE task_run_logs(id,task_id,run_at,duration_ms,status,result,error);
    CREATE TABLE router_state(key,value);
    CREATE TABLE sessions(group_folder,session_id);
    INSERT INTO registered_groups VALUES('dc:987654','group_a','A','2026-01-01T00:00:00Z'),('dc:987655','group_b','B','2026-01-01T00:00:00Z');
    INSERT INTO messages VALUES('111111','dc:987654','123456','Owner','Completed request','2026-01-01T01:00:00Z',0,0),('111112','dc:987654','bot','Rook','Already sent','2026-01-01T01:01:00Z',1,1),('111113','dc:987654','123456','Owner','Unread request','2026-01-01T02:00:00Z',0,0);
    INSERT INTO messages VALUES('111109','dc:987654','123456','Owner','Mirrored history','2026-01-01T00:30:00Z',0,0),('111109','dc:987655','123456','Owner','Mirrored history','2026-01-01T00:30:00Z',0,0);
    INSERT INTO messages VALUES('111108','dc:987654','123456','Owner','','2026-01-01T03:00:00Z',0,0);
    INSERT INTO sessions VALUES('group_a','old-native-session');
    INSERT INTO messages VALUES('wake-one','dc:987654','watcher','Job watcher','Check job','2026-01-01T00:58:00Z',1,0);
    INSERT INTO router_state VALUES('last_agent_timestamp','{"dc:987654":"2026-01-01T01:00:00Z","dc:987655":"2026-01-01T01:00:00Z"}');
    INSERT INTO scheduled_tasks VALUES('old-task','group_a','dc:987655','Follow up','cron','0 9 * * *','2026-01-02T14:00:00Z','active','2026-01-01T00:00:00Z');
    INSERT INTO task_run_logs VALUES(1,'old-task','2026-01-01T14:00:00Z',100,'success','Previously completed',NULL);
  `);
  db.close();
  const before = fs.readFileSync(source);
  const options = { prefix: 'old_', now: Date.parse('2026-01-01T12:00:00Z') };
  const report = importNanoClaw(f.store, source, path.join(f.home, 'groups'), options);
  assert.equal(report.pending, 1);
  assert.equal(report.outgoing, 1);
  assert.equal(f.store.all("SELECT id FROM inbound WHERE content='Mirrored history'").length, 2);
  assert.equal(f.store.all("SELECT content FROM events WHERE type='assistant'").length, 1);
  assert.equal(
    f.store.get<any>("SELECT kind FROM inbound WHERE id='nanoclaw:dc:987654:wake-one'").kind,
    'task',
  );
  assert.equal(report.taskRuns, 1);
  assert.equal(f.store.pendingOutbox().length, 0);
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='111111'").status, 'done');
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='111113'").status, 'queued');
  assert.equal(
    f.store.get<any>("SELECT session_id FROM tasks WHERE id='old-task'").session_id,
    'old_group_b',
  );
  assert.equal(
    f.store.get<any>("SELECT remote_id FROM sessions WHERE id='old_group_a'").remote_id,
    null,
  );
  assert.equal(
    f.store.get<any>("SELECT message_id FROM discord_cursors WHERE channel_id='987654'").message_id,
    '111113',
  );
  assert.deepEqual(fs.readFileSync(source), before);
  assert.equal(fs.existsSync(path.join(f.home, 'groups', 'group_a')), true);
  assert.throws(
    () => importNanoClaw(f.store, source, path.join(f.home, 'groups'), options),
    /empty destination/,
  );
});

test('migration preview names every identifier, path and schedule the import would write', (t) => {
  const f = fixture(t);
  const source = path.join(f.home, 'offline.db');
  const groupsRoot = path.join(f.home, 'install', 'groups');
  const db = new DatabaseSync(source);
  db.exec(`
    CREATE TABLE registered_groups(jid,folder,name,added_at,is_main);
    CREATE TABLE messages(id,chat_jid,sender,sender_name,content,timestamp,is_from_me,is_bot_message);
    CREATE TABLE scheduled_tasks(id,group_folder,chat_jid,prompt,schedule_type,schedule_value,next_run,status,created_at,context_mode);
    CREATE TABLE task_run_logs(id,task_id,run_at,duration_ms,status,result,error);
    CREATE TABLE router_state(key,value);
    CREATE TABLE sessions(group_folder,session_id);
    INSERT INTO registered_groups VALUES('dc:987654','group_a','A','2026-01-01T00:00:00Z',1);
    INSERT INTO messages VALUES('bot-17-x','dc:987654','bot','Agent','Delivered','2026-01-01T01:00:00Z',1,1);
    INSERT INTO messages VALUES('111113','dc:987654','123456','Owner','Unread','2026-01-01T02:00:00Z',0,0);
    INSERT INTO messages VALUES('111114','dc:222222','123456','Owner','Other channel','2026-01-01T02:00:00Z',0,0);
    INSERT INTO router_state VALUES('last_agent_timestamp','{"dc:987654":"2026-01-01T01:00:00Z"}');
    INSERT INTO scheduled_tasks VALUES('overdue-cron','group_a','dc:987654','Sweep /old/install/nanoclaw/logs','cron','0 9 * * *','2026-01-02T14:00:00Z','active','2026-01-01T00:00:00Z','full');
    INSERT INTO scheduled_tasks VALUES('overdue-once','group_a','dc:987654','Report once','once','2026-01-02T14:00:00Z','2026-01-02T14:00:00Z','active','2026-01-01T00:00:00Z','full');
  `);
  db.close();
  const before = fs.readFileSync(source);
  const options = {
    sourceRoots: ['/never/present/nanoclaw'],
    timezone: 'America/New_York',
    now: Date.parse('2026-02-01T12:00:00Z'),
  };
  const plan = planNanoClaw(f.store, source, groupsRoot, options);
  // A preview reads the backup and the destination and writes to neither.
  assert.deepEqual(fs.readFileSync(source), before);
  assert.equal(fs.existsSync(groupsRoot), false);
  assert.equal(f.store.all('SELECT * FROM tasks').length, 0);
  // The destination still holds the fixture conversation, so this plan cannot be applied.
  assert.equal(plan.destinationEmpty, false);
  assert.match(plan.blockers.join(' '), /empty destination/);
  assert.throws(() => importNanoClaw(f.store, source, groupsRoot, options), /empty destination/);

  assert.deepEqual(
    plan.sessions.map((s) => [s.id, s.workspace, s.workspaceExists, s.queued]),
    [['group_a', path.join(groupsRoot, 'group_a'), false, 1]],
  );
  assert.equal(plan.counts.outgoing, 1);
  assert.equal(plan.counts.outgoingWithoutRemoteId, 1);
  assert.deepEqual(plan.ignoredChannels, ['dc:222222']);
  assert.deepEqual(plan.rewrites, [{ root: '/never/present/nanoclaw', prompts: 0 }]);
  assert.deepEqual(plan.residualPaths, [
    { task: 'overdue-cron', sample: '/old/install/nanoclaw/logs' },
  ]);
  assert.deepEqual(plan.provenanceOnlyColumns, {
    registered_groups: ['is_main'],
    scheduled_tasks: ['context_mode'],
  });
  // Both schedules are months overdue: the recurring one moves forward, the one-shot cannot.
  const cron = plan.tasks.find((p) => p.id === 'overdue-cron')!;
  assert.equal(cron.action, 'reschedule');
  assert.equal(cron.status, 'active');
  assert.equal(Date.parse(cron.nextRun!) > options.now, true);
  assert.equal(new Date(cron.nextRun!).toISOString(), '2026-02-01T14:00:00.000Z');
  const once = plan.tasks.find((p) => p.id === 'overdue-once')!;
  assert.deepEqual([once.action, once.status, once.nextRun], ['cancel', 'cancelled', null]);
  assert.equal(
    planNanoClaw(f.store, source, groupsRoot, { ...options, dueTasks: 'fire' }).tasks.every(
      (p) => p.action === 'import',
    ),
    true,
  );

  f.store.exec('DELETE FROM sessions');
  const applied = importNanoClaw(f.store, source, groupsRoot, options);
  assert.equal(applied.plan.blockers.length, 0);
  assert.equal(fs.existsSync(path.join(groupsRoot, 'group_a')), true);
  assert.equal(
    f.store.get<any>("SELECT timezone FROM tasks WHERE id='overdue-cron'").timezone,
    'America/New_York',
  );
  assert.equal(
    f.store.get<any>("SELECT next_run FROM tasks WHERE id='overdue-cron'").next_run,
    Date.parse('2026-02-01T14:00:00Z'),
  );
  assert.equal(
    f.store.get<any>("SELECT status FROM tasks WHERE id='overdue-once'").status,
    'cancelled',
  );
  assert.equal(f.store.get<any>("SELECT id FROM sessions WHERE id='group_a'").id, 'group_a');
});

test('collaborator and bot opt-ins retain channel limits, ignore self, and keep controls with owners', async (t) => {
  const f = fixture(t);
  f.config.discord.allowAllSenders = true;
  f.config.discord.respondToBots = true;
  // Admission only; answering only when named is covered in mention-only.test.ts.
  f.config.discord.mentionOnlyWithBots = false;
  assert.equal(accepts(f.config, '999999', '555555', '987654'), true);
  assert.equal(accepts(f.config, '999999', '555555', '000000'), false);
  assert.equal(accepts(f.config, '999999', null, '987654'), false);
  const discord = new Discord(
    f.config,
    f.store,
    new Engine(f.config, f.store, { claude: ok, codex: ok }),
  );
  (discord.client as any).user = { id: '555000' };
  const send = (id: string, author: string, bot: boolean, content = 'Continue') =>
    (discord as any).onMessage({
      id,
      author: { id: author, bot, displayName: author },
      guildId: '555555',
      channelId: '987654',
      channel: { id: '987654', parentId: null },
      content,
      createdTimestamp: Date.now(),
      attachments: new Map(),
      react: async () => {},
    });
  try {
    await send('200001', '555000', true);
    await send('200002', '444000', true);
    await send('200003', '999999', false);
    await send('200004', '999999', false, '!clawstrum stop');
    await send('200005', '123456', true, '!clawstrum stop');
    assert.equal(f.store.all('SELECT * FROM inbound').length, 2);
    assert.equal(f.store.all('SELECT * FROM controls').length, 0);
    await send('200006', '123456', false, '!clawstrum stop');
    assert.equal(f.store.all('SELECT * FROM controls').length, 1);
  } finally {
    await discord.close();
  }
});

test('migrated job watches retain one stall wake, completion instructions and cancellation policy', async (t) => {
  const f = fixture(t);
  const config = researchSchema.parse({ enabled: true, slurm: { enabled: true, pollMs: 60000 } });
  const log = path.join(f.home, 'slurm.log');
  fs.writeFileSync(log, 'waiting');
  fs.utimesSync(log, 1, 1);
  const watch = {
    followup: 'Upload the validated captures; do not launch another job.',
    logPath: log,
    stallAfterMs: 1000,
    quietCancelledBy: 1234,
  };
  const job = watchJob(f.store, f.session.id, config, '12345', undefined, undefined, watch);
  let running = true;
  const monitor = new ClusterMonitor(f.store, async (cmd) =>
    cmd === 'squeue'
      ? running
        ? '12345|RUNNING|test'
        : ''
      : `12345|${running ? 'RUNNING' : 'COMPLETED'}|0:0|1:00|1M`,
  );
  const now = Date.now() + 1000;
  await monitor.poll(now);
  await monitor.poll(now + 60001);
  assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
  running = false;
  await monitor.poll(now + 120002);
  const inputs = f.store.all<{ content: string }>('SELECT content FROM inbound');
  assert.equal(inputs.length, 2);
  assert.match(inputs[1]!.content, /Upload the validated captures/);
  assert.equal(
    f.store.get<any>('SELECT status FROM cluster_jobs WHERE id=?', job.id).status,
    'completed',
  );
  assert.throws(
    () =>
      watchJob(f.store, f.session.id, config, '12345', undefined, undefined, {
        followup: 'Changed',
      }),
    /different follow-up/,
  );
  watchJob(f.store, f.session.id, config, '12346', undefined, undefined, {
    quietCancelledBy: 1234,
  });
  const cancellation = new ClusterMonitor(f.store, async (cmd) =>
    cmd === 'squeue' ? '' : '12346|CANCELLED by 1234|0:15|1:00|1M',
  );
  await cancellation.poll(Date.now() + 200000);
  assert.equal(f.store.all('SELECT * FROM inbound').length, 2);
});

test('pinned storage rejects another host before creating a database and preserves exclusive daemon locking', async (t) => {
  const os = await import('node:os');
  const { Store } = await import('../src/store.js');
  const { acquireLock } = await import('../src/lock.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-storage-'));
  const directory = path.join(home, 'database');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const policy = path.join(home, 'STORAGE.json');
  fs.writeFileSync(
    policy,
    JSON.stringify({ host: 'another-host', directory, journalMode: 'DELETE' }),
  );
  assert.throws(() => new Store(home), /belongs to host/);
  assert.throws(() => acquireLock(home), /belongs to host/);
  assert.equal(fs.existsSync(directory), false);
  fs.writeFileSync(
    policy,
    JSON.stringify({ host: os.hostname(), directory, journalMode: 'DELETE' }),
  );
  const store = new Store(home);
  try {
    assert.equal(store.get<any>('PRAGMA journal_mode').journal_mode, 'delete');
    const release = acquireLock(home);
    assert.throws(() => acquireLock(home), /already running/);
    release();
    acquireLock(home)();
    store.ensureSession('12345');
  } finally {
    store.close();
  }
  const reopened = new Store(home);
  assert.equal(reopened.all('SELECT * FROM sessions').length, 1);
  reopened.close();
});

test('zero initial lookback skips unrelated old thread history while existing cursors still recover gaps', async (t) => {
  const f = fixture(t);
  f.config.discord.newConversationLookbackMs = 0;
  const discord = new Discord(
    f.config,
    f.store,
    new Engine(f.config, f.store, { claude: ok, codex: ok }),
  );
  const snowflake = (ms: number) => String((BigInt(ms) - 1420070400000n) << 22n);
  const before = f.session.created_at - 3600000,
    after = f.session.created_at + 1;
  const channel: any = { id: '987654', parentId: null, isTextBased: () => true };
  const message = (at: number) => ({
    id: snowflake(at),
    createdTimestamp: at,
    author: { id: '123456', bot: false, displayName: 'Owner' },
    guildId: '555555',
    channelId: channel.id,
    channel,
    content: 'History at ' + at,
    attachments: new Map(),
  });
  channel.messages = {
    fetch: async () => new Map([before, after].map((at) => [snowflake(at), message(at)])),
  };
  (discord.client.channels as any).fetch = async () => channel;
  try {
    await discord.backfill();
    assert.deepEqual(
      f.store.all<any>('SELECT id FROM inbound').map((r) => r.id),
      [snowflake(after)],
    );
    f.store.exec(
      'UPDATE discord_cursors SET message_id=? WHERE channel_id=?',
      snowflake(before - 1),
      channel.id,
    );
    await discord.backfill();
    assert.equal(f.store.all('SELECT id FROM inbound').length, 2);
  } finally {
    await discord.close();
  }
});
