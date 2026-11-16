import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.js';
import { configSchema, saveConfig } from '../src/config.js';
import { ensureReviewTask, reviewTaskPrompt, reviewTaskId } from '../src/review.js';
import { ensureReviewChannelGuide, memoryFile } from '../src/memory.js';
import { init } from '../src/cli-main.js';
import { workflowCommand } from '../src/workflow-cli.js';
import { Store } from '../src/store.js';

test('review.channelId must also be a configured Discord channel', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      configSchema.parse({
        ...f.config,
        review: { channelId: '111111111', at: '03:00' },
      }),
    /review.channelId must also be listed/,
  );
  assert.doesNotThrow(() =>
    configSchema.parse({ ...f.config, review: { channelId: f.session.channel_id, at: '03:00' } }),
  );
});

test('the nightly review task prompt names no absolute paths', () => {
  const prompt = reviewTaskPrompt();
  assert.doesNotMatch(prompt, /\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/);
  assert.match(prompt, /self-review skill/);
  assert.match(prompt, /CLAWSTRUM_QUIET/);
});

test('ensureReviewTask creates one task, is idempotent, and updates in place on a new time', (t) => {
  const f = fixture(t);
  const channel = f.session.channel_id;
  const id = ensureReviewTask(f.store, channel, '03:00', 'UTC', 1000);
  assert.equal(id, reviewTaskId(channel));
  const rows = () => f.store.all<any>('SELECT * FROM tasks');
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].schedule, '0 3 * * *');
  assert.equal(rows()[0].status, 'active');
  // Calling again with the same settings must not add a second row.
  assert.equal(ensureReviewTask(f.store, channel, '03:00', 'UTC', 2000), id);
  assert.equal(rows().length, 1);
  // A changed time updates the existing row instead of creating a new one.
  assert.equal(ensureReviewTask(f.store, channel, '04:30', 'America/New_York', 3000), id);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].schedule, '30 4 * * *');
  assert.equal(rows()[0].timezone, 'America/New_York');
});

test('ensureReviewTask requires the channel to already have a session', (t) => {
  const f = fixture(t);
  assert.throws(() => ensureReviewTask(f.store, '999999999', '03:00', 'UTC'), /No session/);
});

test('ensureReviewChannelGuide adds one marked section and never overwrites it', (t) => {
  const f = fixture(t);
  const file = memoryFile(f.store, f.session.id);
  fs.writeFileSync(
    file,
    '# Agent\n\n## Instructions\n\nCustom note the user wrote.\n\n## MEMORY\n\nSome memory text.\n',
  );
  ensureReviewChannelGuide(f.store, f.session.id);
  const once = fs.readFileSync(file, 'utf8');
  assert.match(once, /## Clawstrum for this channel/);
  assert.match(once, /Custom note the user wrote\./);
  assert.match(once, /Some memory text\./);
  assert.equal(once.indexOf('## MEMORY'), once.lastIndexOf('## MEMORY'));
  ensureReviewChannelGuide(f.store, f.session.id);
  const twice = fs.readFileSync(file, 'utf8');
  assert.equal(twice, once, 'a second call must not duplicate or otherwise change the section');
  assert.equal(
    (twice.match(/## Clawstrum for this channel/g) ?? []).length,
    1,
    'the guide section must appear exactly once',
  );
});

test('review schedule is idempotent and updates the time without duplicating the task', (t) => {
  const f = fixture(t);
  const home = f.home;
  saveConfig(home, f.config);
  const channel = f.session.channel_id;
  const run = (args: string[]) => workflowCommand(args, home);
  const tasks = () => {
    const store = new Store(home);
    try {
      return store.all<any>('SELECT * FROM tasks');
    } finally {
      store.close();
    }
  };
  return (async () => {
    assert.equal(await run(['review', 'schedule', '--channel', channel, '--at', '03:00']), true);
    assert.equal(tasks().length, 1);
    assert.equal(tasks()[0].schedule, '0 3 * * *');
    assert.equal(await run(['review', 'schedule', '--channel', channel, '--at', '03:00']), true);
    assert.equal(tasks().length, 1, 'repeating the same schedule call must not duplicate the task');
    assert.equal(await run(['review', 'schedule', '--channel', channel, '--at', '05:15']), true);
    assert.equal(tasks().length, 1, 'changing the time updates the existing task');
    assert.equal(tasks()[0].schedule, '15 5 * * *');
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(raw.review.channelId, channel);
    assert.ok(raw.discord.channelIds.includes(channel));
    const guide = fs.readFileSync(memoryFile(new Store(home), f.session.id), 'utf8');
    assert.match(guide, /## Clawstrum for this channel/);
  })();
});

test('clawstrum init with --review-channel schedules the task and writes the channel guide', (t) => {
  const f = fixture(t);
  const home = fs.mkdtempSync(path.join(f.home, 'init-with-'));
  const result = spawnSync(
    process.execPath,
    [
      'dist/cli.js',
      'init',
      '--owner',
      '123456',
      '--channel',
      '222222',
      '--review-channel',
      '333333',
    ],
    { env: { ...process.env, CLAWSTRUM_HOME: home }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nightly self-review is scheduled/);
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(config.review.channelId, '333333');
  assert.ok(config.discord.channelIds.includes('333333'));
  const store = new Store(home);
  try {
    const session = store.get<any>('SELECT * FROM sessions WHERE channel_id=?', '333333');
    assert.ok(session, 'init must create the review channel session directly');
    assert.equal(store.all('SELECT * FROM tasks').length, 1);
    const guide = fs.readFileSync(path.join(session.workspace, 'AGENTS.md'), 'utf8');
    assert.match(guide, /## Clawstrum for this channel/);
  } finally {
    store.close();
  }
});

test('clawstrum init without --review-channel recommends one and schedules nothing', (t) => {
  const f = fixture(t);
  const home = fs.mkdtempSync(path.join(f.home, 'init-without-'));
  const result = spawnSync(process.execPath, ['dist/cli.js', 'init', '--owner', '123456'], {
    env: { ...process.env, CLAWSTRUM_HOME: home },
    encoding: 'utf8',
    input: '',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Recommended: make a quiet channel/);
  assert.doesNotMatch(result.stdout, /nightly self-review is scheduled/);
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(config.review.channelId, undefined);
  const store = new Store(home);
  try {
    assert.equal(store.all('SELECT * FROM tasks').length, 0);
  } finally {
    store.close();
  }
});

test('init only prompts for a review channel when interactive and none was given', async (t) => {
  const f = fixture(t);
  const home = fs.mkdtempSync(path.join(f.home, 'init-prompt-'));
  const asked: string[] = [];
  const answers = ['123456', '', '', 'codex', '444444'];
  await init(home, [], {
    isInteractive: true,
    ask: async (prompt) => {
      asked.push(prompt);
      return answers.shift() ?? '';
    },
  });
  assert.ok(
    asked.some((p) => /nightly self-review/.test(p)),
    'must explain the review channel in the prompt',
  );
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(config.review.channelId, '444444');

  const home2 = fs.mkdtempSync(path.join(f.home, 'init-no-prompt-'));
  const asked2: string[] = [];
  await init(home2, ['--owner', '123456', '--review-channel', '555555'], {
    isInteractive: true,
    ask: async (prompt) => {
      asked2.push(prompt);
      return '';
    },
  });
  assert.equal(asked2.length, 0, '--review-channel must suppress every interactive prompt');
  const config2 = JSON.parse(fs.readFileSync(path.join(home2, 'config.json'), 'utf8'));
  assert.equal(config2.review.channelId, '555555');
});
