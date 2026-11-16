import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { buildContext, localStamp } from '../src/context.js';
import { archiveRecord } from '../src/history.js';
import { configSchema } from '../src/config.js';
import { readableTimes, inputTime } from '../src/tool-times.js';

const summer = Date.UTC(2026, 8, 26, 18, 56, 3);
const winter = Date.UTC(2026, 0, 15, 14, 0, 0);

test('localStamp renders local ISO-8601 time with numeric offset', () => {
  assert.equal(localStamp(summer, 'America/New_York'), '2026-09-26T14:56:03-04:00');
  assert.equal(localStamp(winter, 'America/New_York'), '2026-01-15T09:00:00-05:00');
  assert.equal(localStamp(summer, 'UTC'), '2026-09-26T18:56:03+00:00');
  assert.equal(localStamp(summer, 'Asia/Kolkata'), '2026-09-27T00:26:03+05:30');
  assert.equal(
    localStamp(Date.UTC(2026, 8, 27, 4, 0, 0), 'America/New_York'),
    '2026-09-27T00:00:00-04:00',
  );
});

test('buildContext stamps current input and puts current time in the prompt only', (t) => {
  const f = fixture(t);
  f.enqueue('m1', summer);
  const context = buildContext(
    f.store,
    f.session,
    f.config.accounts[0]!,
    f.store.all<any>('SELECT * FROM inbound'),
    32000,
    100000,
    undefined,
    undefined,
    false,
    { decided: false, text: '' },
    'America/New_York',
  );
  const time = context.prompt.indexOf('Current time: ');
  const input = context.prompt.indexOf('Current input (JSON records):');
  assert.ok(time >= 0 && time < input);
  assert.match(
    context.prompt,
    /Current time: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d \(America\/New_York\)\.\n\nCurrent input/,
  );
  const current = context.prompt.slice(input);
  assert.match(
    current,
    /"id":"m1","role":"user","author":"owner","at":"2026-09-26T14:56:03-04:00"/,
  );
  assert.doesNotMatch(context.instructions, /Current time/);
});

test('non-resume continuation records carry local timestamps', (t) => {
  const f = fixture(t);
  archiveRecord(f.store, {
    id: 'earlier',
    sessionId: f.session.id,
    kind: 'assistant',
    content: 'earlier reply',
    counted: true,
    at: winter,
  });
  f.enqueue('m1', summer);
  const context = buildContext(
    f.store,
    f.session,
    f.config.accounts[0]!,
    f.store.all<any>('SELECT * FROM inbound'),
    32000,
    100000,
    undefined,
    undefined,
    false,
    '',
    'UTC',
  );
  assert.ok(context.prompt.includes('Recent uncovered records'));
  assert.match(
    context.prompt,
    /\{"id":"earlier","kind":"assistant","seq":\d+,"at":"2026-01-15T14:00:00\+00:00","content":"earlier reply"\}/,
  );
  assert.doesNotMatch(context.prompt, /"created_at"/);
});

test('runtime.timezone accepts IANA zones and rejects others', () => {
  const base = {
    version: 1,
    discord: { ownerIds: ['123456'], channelIds: ['987654'], guildId: '555555', allowDMs: false },
    accounts: [{ id: 'a', provider: 'claude', home: '/tmp/a' }],
  };
  assert.equal(
    configSchema.parse({ ...base, runtime: { timezone: 'America/New_York' } }).runtime.timezone,
    'America/New_York',
  );
  assert.throws(
    () => configSchema.parse({ ...base, runtime: { timezone: 'Mars/Olympus' } }),
    /runtime\.timezone must be an IANA time zone/,
  );
});

test('tool results show epoch-millisecond times as local stamps; time inputs take them back', () => {
  const row = Object.assign(Object.create(null), {
    id: 'task',
    next_run: winter,
    created_at: summer,
    seq: 12,
    cooldown_until: 0,
    timeoutMs: 600000,
    usage_json: JSON.stringify([
      {
        bucket: 'five_hour',
        cooldown_until: winter,
        usage_json: JSON.stringify({ utilization: 0.5, resetsAt: winter }),
      },
    ]),
    spec_json: '{"role":"reader"}',
  });
  const shown = readableTimes(
    { tasks: [row], nextCheck: summer, deadline: winter, at: summer, nextAfter: 40 },
    'America/New_York',
  ) as any;
  const task = shown.tasks[0];
  assert.equal(task.next_run, '2026-01-15T09:00:00-05:00');
  assert.equal(task.created_at, '2026-09-26T14:56:03-04:00');
  assert.deepEqual([task.seq, task.cooldown_until, task.timeoutMs], [12, 0, 600000]);
  assert.equal(task.spec_json, '{"role":"reader"}');
  const usage = JSON.parse(task.usage_json);
  assert.equal(usage[0].cooldown_until, '2026-01-15T09:00:00-05:00');
  assert.equal(JSON.parse(usage[0].usage_json).resetsAt, '2026-01-15T09:00:00-05:00');
  assert.equal(shown.nextCheck, '2026-09-26T14:56:03-04:00');
  assert.equal(shown.deadline, '2026-01-15T09:00:00-05:00');
  assert.equal(shown.at, '2026-09-26T14:56:03-04:00');
  assert.equal(shown.nextAfter, 40);
  assert.equal(inputTime(task.next_run, 'from'), winter);
  assert.equal(inputTime('2026-01-15T14:00:00Z', 'from'), winter);
  assert.equal(inputTime(winter, 'from'), winter);
  assert.equal(inputTime(undefined, 'from'), undefined);
  assert.throws(() => inputTime('2026-01-15 09:00', 'from'), /offset/);
  assert.throws(() => inputTime('yesterday', 'until'), /until needs/);
});
