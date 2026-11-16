import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { researchSchema } from '../src/research/config.js';
import { watchJob, ClusterMonitor, type Command } from '../src/research/cluster.js';
import { buildContext } from '../src/context.js';
import { WorkAloneMonitor } from '../src/work-alone.js';

const HOUR = 3600000;

function morningFixture(t: any) {
  const f = fixture(t);
  f.config.workAlone.enabled = true;
  f.config.workAlone.morning.enabled = true;
  f.config.workAlone.morning.cron = '0 4 * * *';
  f.config.workAlone.morning.timezone = 'UTC';
  f.config.workAlone.morning.activeHours = 24;
  return { ...f, monitor: new WorkAloneMonitor(f.store, f.config) };
}
const armed = (f: ReturnType<typeof fixture>) => {
  const row = f.store.get<{ value: string }>(
    "SELECT value FROM metadata WHERE key='work-alone:morning'",
  );
  return row ? (JSON.parse(row.value) as { next: number }).next : undefined;
};
const mornings = (f: ReturnType<typeof fixture>) =>
  f.store.all<{ id: string; session_id: string; available_at: number; content: string }>(
    "SELECT id,session_id,available_at,content FROM inbound WHERE id LIKE 'work-alone:morning:%' ORDER BY available_at",
  );

test('morning check arms first, then wakes only sessions with a human message in the window, staggered and deduplicated', (t) => {
  const f = morningFixture(t);
  const t0 = Date.UTC(2026, 10, 3, 12);
  f.monitor.morning(t0);
  const next = armed(f)!;
  assert.equal(next, Date.UTC(2026, 10, 4, 4));
  assert.equal(mornings(f).length, 0);

  const other = f.store.ensureSession('111111');
  const old = f.store.ensureSession('222222');
  const botOnly = f.store.ensureSession('333333');
  f.store.enqueue({
    id: 'h1',
    sessionId: f.session.id,
    author: 'owner',
    content: 'hi',
    at: next - 2 * HOUR,
  });
  f.store.enqueue({
    id: 'h2',
    sessionId: other.id,
    author: 'owner',
    content: 'hi',
    at: next - 20 * HOUR,
  });
  f.store.enqueue({
    id: 'h3',
    sessionId: old.id,
    author: 'owner',
    content: 'hi',
    at: next - 30 * HOUR,
  });
  f.store.enqueue({
    id: 'b1',
    sessionId: botOnly.id,
    author: 'bot',
    content: 'hi',
    at: next - HOUR,
  });
  f.store.exec("INSERT INTO metadata(key,value) VALUES('bot-input:b1','1')");

  f.monitor.morning(next - 1000);
  assert.equal(mornings(f).length, 0);

  const now = next + 5 * 60000;
  f.monitor.morning(now);
  const woken = mornings(f);
  assert.deepEqual(woken.map((w) => w.session_id).sort(), [f.session.id, other.id].sort());
  assert.deepEqual(
    woken.map((w) => w.available_at),
    [now, now + 10 * 60000],
  );
  assert.ok(woken.every((w) => w.id.endsWith(`:${next}`)));
  assert.match(woken[0]!.content, /harness wake, not a message from the user/);
  assert.match(woken[0]!.content, /CLAWSTRUM_QUIET/);
  assert.equal(armed(f), Date.UTC(2026, 10, 5, 4));

  f.store.exec(
    "UPDATE metadata SET value=json_set(value,'$.next',?) WHERE key='work-alone:morning'",
    next,
  );
  f.monitor.morning(now + 60000);
  assert.equal(mornings(f).length, 2);
});

test('morning check skips a round more than an hour late and re-arms', (t) => {
  const f = morningFixture(t);
  f.monitor.morning(Date.UTC(2026, 10, 3, 12));
  const next = armed(f)!;
  f.store.enqueue({
    id: 'h1',
    sessionId: f.session.id,
    author: 'owner',
    content: 'hi',
    at: next - HOUR,
  });
  f.monitor.morning(next + HOUR + 60000);
  assert.equal(mornings(f).length, 0);
  assert.equal(armed(f), Date.UTC(2026, 10, 5, 4));
});

test('morning check is off unless work-alone and morning are both enabled', (t) => {
  const f = morningFixture(t);
  f.config.workAlone.morning.enabled = false;
  f.monitor.morning(Date.UTC(2026, 10, 3, 12));
  assert.equal(armed(f), undefined);
  f.config.workAlone.morning.enabled = true;
  f.config.workAlone.enabled = false;
  f.monitor.morning(Date.UTC(2026, 10, 3, 12));
  assert.equal(armed(f), undefined);
});

test('work-alone rules are in the agent instructions only when enabled', (t) => {
  const f = fixture(t);
  const build = (workAlone: boolean) =>
    buildContext(
      f.store,
      f.session,
      f.config.accounts[0]!,
      [],
      2000,
      100000,
      undefined,
      undefined,
      false,
      undefined,
      'UTC',
      '',
      true,
      workAlone,
    ).instructions;
  assert.match(build(true), /the result you expect and what you will do on each outcome/);
  assert.doesNotMatch(build(false), /the result you expect and what you will do on each outcome/);
});

const NOTE = 'Read the output against this follow-up first';
async function jobEnd(t: any, workAlone: boolean, followup?: string) {
  const f = fixture(t);
  f.config.research = researchSchema.parse({
    enabled: true,
    slurm: { enabled: true },
    workers: { minFreeMemoryMB: 0 },
  });
  watchJob(
    f.store,
    f.session.id,
    f.config.research,
    '123',
    undefined,
    undefined,
    followup ? { followup } : undefined,
  );
  const fakeCmd: Command = async (name) =>
    name === 'squeue' ? '' : '123|COMPLETED|0:0|00:01:00|100K';
  const monitor = new ClusterMonitor(f.store, fakeCmd, workAlone);
  const now = Date.now() + 100;
  await monitor.poll(now);
  await monitor.poll(now + f.config.research.slurm.pollMs);
  const wakes = f.store.all<{ content: string }>("SELECT content FROM inbound WHERE kind='task'");
  assert.equal(wakes.length, 1);
  return wakes[0]!.content;
}

test('job-end wake adds the follow-up reading note only in work-alone mode with a follow-up', async (t) => {
  const withNote = await jobEnd(
    t,
    true,
    'Expect loss < 0.1; if so run the sweep, else check the lr.',
  );
  assert.ok(withNote.includes('Expect loss < 0.1'));
  assert.ok(withNote.includes(NOTE));
  assert.ok(!(await jobEnd(t, false, 'Expect loss < 0.1.')).includes(NOTE));
  assert.ok(!(await jobEnd(t, true)).includes(NOTE));
});
