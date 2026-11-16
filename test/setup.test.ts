import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  setup,
  inviteUrl,
  mountType,
  INVITE_PERMISSIONS,
  SETUP_USAGE,
  readEnvToken,
  nodeSupport,
  type SetupIO,
} from '../src/setup.js';
import { doctor, init, type DoctorCheck } from '../src/cli-main.js';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { fileURLToPath } from 'node:url';

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GAbCdE.' + 'x'.repeat(38);
const APP = '123456789012345678';
const OWNER = '111111111111111111';
const GUILD = '222222222222222222';
const CHANNEL = '333333333333333333';

function tempHome(t: any): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-setup-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'home');
}

function scripted(
  answers: string[],
  secrets: string[] = [],
  checks: DoctorCheck[] = [],
  fetchImpl: typeof fetch = async () => {
    throw new TypeError('fetch failed');
  },
) {
  const prompts: string[] = [];
  const printed: string[] = [];
  let doctorRuns = 0;
  const io: SetupIO = {
    isInteractive: true,
    ask: async (prompt) => {
      prompts.push(prompt);
      if (!answers.length) throw new Error(`Unexpected prompt: ${prompt}`);
      return answers.shift()!;
    },
    askSecret: async (prompt) => {
      prompts.push(prompt);
      if (!secrets.length) throw new Error(`Unexpected secret prompt: ${prompt}`);
      return secrets.shift()!;
    },
    print: (line) => printed.push(line),
    doctor: async () => {
      doctorRuns++;
      return checks;
    },
    fetch: fetchImpl,
  };
  return { io, prompts, printed, doctorRuns: () => doctorRuns };
}

test('interactive setup writes config, token, and the agent name', async (t) => {
  const home = tempHome(t);
  const run = scripted(['Ada', 'gpt', 'claude', APP, OWNER, GUILD, CHANNEL], [TOKEN]);
  await setup(home, ['--no-login'], run.io);
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(config.name, 'Ada');
  assert.equal(config.accounts[0].provider, 'claude');
  assert.deepEqual(config.discord.ownerIds, [OWNER]);
  assert.equal(config.discord.guildId, GUILD);
  assert.deepEqual(config.discord.channelIds, [CHANNEL]);
  const env = path.join(home, '.env');
  assert.match(fs.readFileSync(env, 'utf8'), new RegExp(`^DISCORD_BOT_TOKEN=${TOKEN}$`, 'm'));
  assert.equal(fs.statSync(env).mode & 0o777, 0o600);
  const agents = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# Ada$/m);
  assert.match(agents, /You are Ada/);
  assert.doesNotMatch(agents, /You are Clawstrum/);
  const output = [...run.printed, ...run.prompts].join('\n');
  assert.ok(!output.includes(TOKEN), 'the token must never be printed');
  assert.ok(run.printed.includes('Please type claude, codex or gemini.'));
  for (let n = 1; n <= 8; n++) assert.ok(run.printed.some((l) => l.includes(`Step ${n} of 8:`)));
  assert.ok(run.printed.includes(inviteUrl(APP)));
  assert.equal(
    run.printed.at(-1),
    'Then open your main channel: your agent writes there first, with a few ideas to make it yours. Answer it.',
  );
  assert.equal(run.doctorRuns(), 1);
});

test('invite link carries the documented permission bits', () => {
  assert.equal(INVITE_PERMISSIONS, 309237746768n);
  assert.equal(
    inviteUrl(APP),
    `https://discord.com/oauth2/authorize?client_id=${APP}&scope=bot+applications.commands&permissions=309237746768`,
  );
});

test('re-running setup skips completed steps and keeps config and token', async (t) => {
  const home = tempHome(t);
  await setup(home, ['--no-login'], scripted(['Ada', 'codex', APP, OWNER, '', ''], [TOKEN]).io);
  const config = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  const env = fs.readFileSync(path.join(home, '.env'), 'utf8');
  const agents = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
  const again = scripted(['']);
  await setup(home, ['--no-login'], again.io);
  assert.deepEqual(again.prompts, ['Keep the existing token? [Y/n] ']);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), config);
  assert.equal(fs.readFileSync(path.join(home, '.env'), 'utf8'), env);
  assert.equal(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), agents);
  assert.ok(again.printed.includes('Already set: Ada'));
  assert.ok(again.printed.some((l) => l.startsWith('Already set: codex')));
  assert.ok(again.printed.some((l) => l.startsWith('Already done: a bot token is saved')));
  assert.ok(again.printed.some((l) => l.includes('not running init again')));
});

test('--yes without --owner fails naming the flag', async (t) => {
  const home = tempHome(t);
  const tokenFile = path.join(path.dirname(home), 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n');
  const run = scripted([]);
  await assert.rejects(
    setup(home, ['--yes', '--provider', 'codex', '--token-file', tokenFile, '--no-login'], run.io),
    /--owner/,
  );
  assert.equal(run.prompts.length, 0);
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
});

test('a token with the wrong shape is asked for again', async (t) => {
  const home = tempHome(t);
  const run = scripted(['', 'codex', APP, OWNER, '', ''], ['short', 'a.b.c', TOKEN]);
  await setup(home, ['--no-login'], run.io);
  assert.equal(run.prompts.filter((p) => p === 'Bot token: ').length, 3);
  assert.equal(
    run.printed.filter((l) => l.startsWith('That does not look like a bot token')).length,
    2,
  );
  assert.match(fs.readFileSync(path.join(home, '.env'), 'utf8'), new RegExp(`=${TOKEN}$`, 'm'));
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(config.name, 'Clawstrum');
  assert.match(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), /^# Clawstrum$/m);
});

/** Run with PATH set to a fresh directory holding only the named fake executables. */
function withPath(t: any, executables: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-path-'));
  for (const name of executables) {
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  const before = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => {
    process.env.PATH = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function raw(home: string): any {
  return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
}

function writeRaw(home: string, value: any): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(value, null, 2) + '\n');
}

function tokenFile(home: string): string {
  const file = path.join(path.dirname(home), 'token');
  fs.writeFileSync(file, TOKEN + '\n');
  return file;
}

const flagRun = (home: string, extra: string[] = []) => [
  '--yes',
  '--provider',
  'codex',
  '--token-file',
  tokenFile(home),
  '--owner',
  OWNER,
  ...extra,
];

test('--help and -h print every setup flag and run no step', async (t) => {
  for (const flag of ['--help', '-h']) {
    const home = tempHome(t);
    const run = scripted([]);
    await setup(home, [flag], run.io);
    assert.deepEqual(run.printed, [SETUP_USAGE]);
    assert.equal(fs.existsSync(home), false);
    assert.equal(run.doctorRuns(), 0);
  }
  for (const flag of [
    '--name',
    '--provider',
    '--application-id',
    '--token-file',
    '--owner',
    '--guild',
    '--channel',
    '--no-login',
    '--yes',
    '--reconfigure',
    '--status',
    '--main-channel',
    '--json',
    '--help',
  ])
    assert.ok(SETUP_USAGE.includes(flag), flag);
});

test('without sbatch, a new config gets Slurm helpers off; an existing one keeps the user choice', async (t) => {
  withPath(t, []);
  const home = tempHome(t);
  await setup(home, flagRun(home), scripted([]).io);
  assert.equal(raw(home).research.slurm.enabled, false);
  const config = raw(home);
  config.research.slurm.enabled = true;
  writeRaw(home, config);
  const again = scripted([]);
  await setup(home, flagRun(home), again.io);
  assert.equal(raw(home).research.slurm.enabled, true);
  assert.ok(
    again.printed.some((l) => l.startsWith('config.json has Slurm helpers on, but sbatch')),
  );

  const sbatch = path.join(path.dirname(home), 'sbatch-elsewhere');
  fs.writeFileSync(sbatch, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(sbatch, 0o755);
  config.research.slurm.commands.sbatch = sbatch;
  writeRaw(home, config);
  const third = scripted([]);
  await setup(home, flagRun(home), third.io);
  assert.equal(raw(home).research.slurm.enabled, true);
  assert.ok(third.printed.some((l) => l.startsWith('sbatch: found')));
  assert.ok(!third.printed.some((l) => l.startsWith('config.json has Slurm helpers on')));
});

test('with sbatch on PATH, Slurm helpers stay on', async (t) => {
  withPath(t, ['sbatch']);
  const home = tempHome(t);
  await setup(home, flagRun(home), scripted([]).io);
  assert.equal(raw(home).research.slurm.enabled, true);
});

test('a missing pdftotext is a warning, not a failure', async (t) => {
  const home = tempHome(t);
  await setup(home, flagRun(home), scripted([]).io);
  const config = raw(home);
  config.research.pdftotext = path.join(path.dirname(home), 'no-such-pdftotext');
  config.research.slurm.enabled = false;
  const runtime = path.join(path.dirname(home), 'runtime');
  fs.writeFileSync(runtime, '#!/bin/sh\necho 1.2.3\n');
  fs.chmodSync(runtime, 0o755);
  config.accounts[0].executable = runtime;
  writeRaw(home, config);
  const store = new Store(home);
  t.after(() => store.close());
  let checks: DoctorCheck[] = [];
  const exitCode = process.exitCode;
  try {
    await doctor(readConfig(home), store, false, (c) => {
      checks = c;
    });
  } finally {
    process.exitCode = exitCode;
  }
  const pdf = checks.find((c) => c.check.startsWith('Research executable'))!;
  assert.equal(pdf.ok, false);
  assert.equal(pdf.warn, true);

  const run = scripted([], [], [{ ...pdf }, { check: 'SQLite', ok: true, detail: '' }]);
  await setup(home, flagRun(home), run.io);
  assert.ok(run.printed.some((l) => l.startsWith('WARN Research executable')));
  assert.ok(!run.printed.some((l) => l.startsWith('Some checks above failed')));
});

test('an owner ID equal to the application ID is refused', async (t) => {
  const home = tempHome(t);
  const run = scripted(['', 'codex', APP, APP, OWNER, '', ''], [TOKEN]);
  await setup(home, ['--no-login'], run.io);
  assert.equal(run.printed.filter((l) => l.startsWith('That is the Application ID.')).length, 1);
  assert.deepEqual(raw(home).discord.ownerIds, [OWNER]);

  const other = tempHome(t);
  await assert.rejects(
    setup(other, [...flagRun(other).filter((a) => a !== OWNER), APP, '--application-id', APP], {
      ...scripted([]).io,
    }),
    /That is the Application ID/,
  );
});

test('--reconfigure changes name, provider and Discord IDs and keeps everything else', async (t) => {
  const home = tempHome(t);
  await setup(
    home,
    ['--no-login'],
    scripted(['Ada', 'codex', APP, OWNER, GUILD, CHANNEL], [TOKEN]).io,
  );
  const before = raw(home);
  before.discord.plainDashes = false;
  before.runtime = { ...(before.runtime ?? {}), maxConcurrent: 3 };
  writeRaw(home, before);
  const env = fs.readFileSync(path.join(home, '.env'), 'utf8');
  const NEW_OWNER = '444444444444444444';
  const NEW_CHANNEL = '555555555555555555';
  const run = scripted(['Bob', 'claude', '', '', APP, NEW_OWNER, 'none', NEW_CHANNEL]);
  await setup(home, ['--reconfigure', '--no-login'], run.io);
  const after = raw(home);
  assert.equal(after.name, 'Bob');
  assert.equal(after.accounts[0].provider, 'claude');
  assert.equal(after.accounts[0].home, 'accounts/main/claude');
  assert.deepEqual(after.discord.ownerIds, [NEW_OWNER]);
  assert.equal(after.discord.guildId, undefined);
  assert.deepEqual(after.discord.channelIds, [NEW_CHANNEL]);
  assert.equal(before.review.channelId, CHANNEL);
  assert.equal(after.review.channelId, NEW_CHANNEL);
  const store = new Store(home);
  const status = (id: string) =>
    store.get<{ status: string }>('SELECT status FROM tasks WHERE id=?', `review:${id}`)?.status;
  assert.equal(status(CHANNEL), 'cancelled');
  assert.equal(status(NEW_CHANNEL), 'active');
  store.close();
  assert.equal(after.discord.plainDashes, false);
  assert.equal(after.runtime.maxConcurrent, 3);
  assert.equal(after.discord.applicationId, APP);
  assert.equal(fs.readFileSync(path.join(home, '.env'), 'utf8'), env);
  assert.ok(run.printed.some((l) => l.startsWith('That is the Application ID.')));
  delete after.name;
  delete after.accounts;
  delete after.discord;
  delete after.review.channelId;
  delete before.name;
  delete before.accounts;
  delete before.discord;
  delete before.review.channelId;
  assert.deepEqual(after, before);
});

test('--reconfigure: Enter keeps the server and channel, and a rename reaches AGENTS.md', async (t) => {
  const home = tempHome(t);
  await setup(
    home,
    ['--no-login'],
    scripted(['Bob', 'codex', APP, OWNER, GUILD, CHANNEL], [TOKEN]).io,
  );
  const before = raw(home);
  const run = scripted(['Alice', '', '', '', '', '', '']);
  await setup(home, ['--reconfigure', '--no-login'], run.io);
  const after = raw(home);
  assert.equal(after.discord.guildId, GUILD);
  assert.deepEqual(after.discord.channelIds, before.discord.channelIds);
  assert.deepEqual(after.discord.ownerIds, [OWNER]);
  assert.equal(after.discord.applicationId, APP);
  assert.equal(after.accounts[0].provider, 'codex');
  assert.ok(
    run.prompts.includes(`Server ID [${GUILD}] (Enter keeps it; none = direct messages only): `),
  );
  assert.ok(run.prompts.includes(`Channel ID [${CHANNEL}] (Enter keeps it; none = no channel): `));
  assert.ok(run.prompts.includes(`Your Discord user ID [${OWNER}] (Enter keeps it): `));
  assert.ok(run.prompts.includes(`Application ID [${APP}] (Enter keeps it): `));
  const agents = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# Alice$/m);
  assert.match(agents, /You are Alice/);
  assert.doesNotMatch(agents, /Bob/);
});

test('answers of a first run that stops before the config exists are kept for the next run', async (t) => {
  const home = tempHome(t);
  await assert.rejects(
    setup(home, ['--no-login'], scripted(['Ada', 'codex', APP], [TOKEN]).io),
    /Unexpected prompt: Your Discord user ID/,
  );
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
  const again = scripted(['', '', '', APP, OWNER, '', '']);
  await setup(home, ['--no-login'], again.io);
  assert.ok(again.prompts.includes('What should your agent be called? [Ada] (Enter keeps it) '));
  assert.ok(again.prompts.some((p) => p.endsWith('[codex] (Enter keeps it): ')));
  assert.ok(!again.prompts.some((p) => p.startsWith('Application ID')));
  assert.ok(again.printed.includes(inviteUrl(APP)));
  assert.ok(again.printed.some((l) => l.startsWith('That is the Application ID.')));
  const config = raw(home);
  assert.equal(config.name, 'Ada');
  assert.equal(config.accounts[0].provider, 'codex');
  assert.equal(config.discord.applicationId, APP);
  assert.deepEqual(config.discord.ownerIds, [OWNER]);
  assert.match(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), /^# Ada$/m);
  assert.equal(fs.existsSync(path.join(home, '.setup-progress.json')), false);

  // A first run without an application ID: the next interactive run asks for it.
  const other = tempHome(t);
  await assert.rejects(
    setup(
      other,
      ['--yes', '--provider', 'codex', '--token-file', tokenFile(other)],
      scripted([]).io,
    ),
    /--owner/,
  );
  const next = scripted(['', '', APP, '', APP, OWNER, '', '']);
  await setup(other, ['--no-login'], next.io);
  assert.ok(next.prompts.some((p) => p.startsWith('Application ID, from General Information')));
  assert.equal(raw(other).discord.applicationId, APP);
  assert.deepEqual(raw(other).discord.ownerIds, [OWNER]);
});

test('a rerun with sbatch found says when Slurm helpers are off', async (t) => {
  const bin = withPath(t, []);
  const home = tempHome(t);
  await setup(home, flagRun(home), scripted([]).io);
  assert.equal(raw(home).research.slurm.enabled, false);
  fs.writeFileSync(path.join(bin, 'sbatch'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(bin, 'sbatch'), 0o755);
  const again = scripted([]);
  await setup(home, flagRun(home), again.io);
  assert.equal(raw(home).research.slurm.enabled, false);
  assert.ok(again.printed.some((l) => l.startsWith('Slurm helpers are off in config.json')));
});

test('the network file system warning reads the type from the mount table', () => {
  const table = [
    'auto.home /n/home autofs rw 0 0',
    'server:/home /n/home nfs rw 0 0',
    'mds@o2ib:/lfs /n/lab\\040data lustre rw 0 0',
    '/dev/sda1 / xfs rw 0 0',
  ].join('\n');
  assert.equal(mountType('/n/home/ada', table), 'nfs');
  assert.equal(mountType('/n/lab data/x', table), 'lustre');
  assert.equal(mountType('/n/homework', table), 'xfs');
});

test('the application ID is saved and the invite link is printed again once a token exists', async (t) => {
  const home = tempHome(t);
  await setup(home, ['--no-login'], scripted(['', 'codex', APP, OWNER, '', ''], [TOKEN]).io);
  assert.equal(raw(home).discord.applicationId, APP);
  const again = scripted(['']);
  await setup(home, ['--no-login'], again.io);
  assert.ok(again.printed.some((l) => l.startsWith('Already done: a bot token is saved')));
  assert.ok(again.printed.includes(inviteUrl(APP)));
});

const signInFailed: DoctorCheck = {
  check: 'main sign-in',
  ok: false,
  detail: 'run clawstrum account login main',
};

test('a skipped login shows the sign-in check as SKIP, not as a failure', async (t) => {
  const home = tempHome(t);
  const run = scripted([], [], [signInFailed]);
  await setup(home, flagRun(home, ['--no-login']), run.io);
  assert.ok(
    run.printed.includes(
      'SKIP main sign-in: you chose not to log in. Later: clawstrum account login main',
    ),
  );
  assert.ok(!run.printed.some((l) => l.startsWith('Some checks above failed')));
});

test('--yes never logs in, even on a terminal', async (t) => {
  const home = tempHome(t);
  const run = scripted([], [], [signInFailed]);
  await setup(home, flagRun(home), run.io);
  assert.equal(run.prompts.length, 0);
  assert.ok(run.printed.includes('Skipped (--yes). Later: clawstrum account login main'));
  assert.ok(run.printed.some((l) => l.startsWith('SKIP main sign-in')));
  assert.ok(!run.printed.some((l) => l.startsWith('Some checks above failed')));
});

test('a failed login prints the end of the provider error output and the check fails', async (t) => {
  const home = tempHome(t);
  await setup(home, flagRun(home), scripted([]).io);
  const runtime = path.join(path.dirname(home), 'runtime');
  fs.writeFileSync(
    runtime,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi',
      'if [ "$2" = "status" ]; then exit 1; fi',
      'i=1; while [ $i -le 15 ]; do echo "provider line $i" >&2; i=$((i+1)); done',
      'exit 3',
    ].join('\n') + '\n',
  );
  fs.chmodSync(runtime, 0o755);
  const config = raw(home);
  config.accounts[0].executable = runtime;
  writeRaw(home, config);
  const run = scripted(['', 'y', ''], [], [signInFailed]);
  const write = process.stderr.write;
  process.stderr.write = (() => true) as any;
  try {
    await setup(home, [], run.io);
  } finally {
    process.stderr.write = write;
  }
  const failure = run.printed.find((l) => l.startsWith('Login did not finish'))!;
  assert.match(failure, /code 3/);
  assert.match(failure, /provider line 15/);
  assert.match(failure, /provider line 6\b/);
  assert.doesNotMatch(failure, /provider line 5\b/);
  assert.ok(run.printed.some((l) => l.startsWith('FAIL main sign-in')));
  assert.ok(run.printed.some((l) => l.startsWith('Some checks above failed')));
});

function discordFetch(routes: Record<string, number | unknown[]>, calls: [string, any][]) {
  return (async (url: string, init: any) => {
    calls.push([url, init]);
    const route = url.replace('https://discord.com/api/v10', '');
    const answer = routes[route];
    if (answer === undefined) throw new TypeError('fetch failed');
    if (typeof answer === 'number') return new Response('{}', { status: answer });
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
}

async function discordRun(t: any, routes: Record<string, number | unknown[]>) {
  const home = tempHome(t);
  const calls: [string, any][] = [];
  const run = scripted([], [], [], discordFetch(routes, calls));
  await setup(
    home,
    flagRun(home, ['--guild', GUILD, '--channel', CHANNEL, '--application-id', APP]),
    run.io,
  );
  const output = [...run.printed, ...run.prompts].join('\n');
  assert.ok(!output.includes(TOKEN), 'the token must never be printed');
  return { printed: run.printed, calls };
}

test('the Discord check reports a rejected token', async (t) => {
  const { printed, calls } = await discordRun(t, { '/users/@me/guilds': 401 });
  assert.ok(
    printed.includes(
      'FAIL Discord bot token: Discord rejected the bot token. Copy a new one with Reset Token and run clawstrum setup again',
    ),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![1].headers.Authorization, `Bot ${TOKEN}`);
  assert.ok(printed.some((l) => l.startsWith('Some checks above failed')));
});

test('the Discord check reports a server the bot is not in and a channel it cannot see', async (t) => {
  const { printed } = await discordRun(t, {
    '/users/@me/guilds': [{ id: '999999999999999999' }],
    [`/channels/${CHANNEL}`]: 404,
  });
  assert.ok(printed.includes('ok   Discord bot token'));
  assert.ok(
    printed.includes(
      `WARN Discord server ${GUILD}: the bot is not in server ${GUILD} yet: open the invite link`,
    ),
  );
  assert.ok(printed.includes(`     ${inviteUrl(APP)}`));
  assert.ok(
    printed.includes(`WARN Discord channel ${CHANNEL}: the bot cannot see channel ${CHANNEL}`),
  );
});

test('the Discord check passes when the bot sees the server and channel', async (t) => {
  const { printed } = await discordRun(t, {
    '/users/@me/guilds': [{ id: GUILD }],
    [`/channels/${CHANNEL}`]: [],
  });
  assert.ok(printed.includes(`ok   Discord server ${GUILD}`));
  assert.ok(printed.includes(`ok   Discord channel ${CHANNEL}`));
});

test('the Discord check is one skipped line when Discord cannot be reached', async (t) => {
  const { printed } = await discordRun(t, {});
  assert.deepEqual(
    printed.filter((l) => / Discord/.test(l) && /^(ok|WARN)/.test(l)),
    ['WARN Discord: could not reach Discord, skipped'],
  );
});

const MANAGE_CHANNELS = String(1n << 4n);
const NEW_CHANNEL = '666666666666666666';

function saveToken(home: string, text = `DISCORD_BOT_TOKEN=${TOKEN}\n`): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.env'), text, { mode: 0o600 });
}

interface ApiCall {
  method: string;
  route: string;
  body?: any;
}

/** Routes are keyed "METHOD /route"; a number answers with that status, anything else as JSON. */
function apiFetch(routes: Record<string, unknown>, calls: ApiCall[]) {
  return (async (url: string, init: any) => {
    const route = url.replace('https://discord.com/api/v10', '');
    const method = init?.method ?? 'GET';
    calls.push({ method, route, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    assert.equal(init.headers.Authorization, `Bot ${TOKEN}`);
    const answer = routes[`${method} ${route}`];
    if (answer === undefined) throw new TypeError('fetch failed');
    if (typeof answer === 'number') return new Response('{}', { status: answer });
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
}

function botRoutes(
  options: {
    intent?: boolean;
    guilds?: unknown[];
    permissions?: string;
    channels?: unknown[];
  } = {},
): Record<string, unknown> {
  return {
    'GET /users/@me': { id: APP, username: 'ada-bot' },
    'GET /oauth2/applications/@me': { id: APP, flags: options.intent === false ? 0 : 1 << 18 },
    'GET /users/@me/guilds': options.guilds ?? [
      { id: GUILD, name: 'Lab', permissions: options.permissions ?? MANAGE_CHANNELS },
    ],
    [`GET /guilds/${GUILD}`]: { id: GUILD, owner_id: OWNER },
    [`GET /users/${OWNER}`]: { id: OWNER, username: 'ada', global_name: 'Ada Lovelace' },
    [`GET /guilds/${GUILD}/channels`]: options.channels ?? [
      { id: CHANNEL, name: 'general', type: 0 },
      { id: '777777777777777777', name: 'Voice', type: 2 },
    ],
  };
}

async function status(t: any, home: string, routes: Record<string, unknown>) {
  const calls: ApiCall[] = [];
  const run = scripted([], [], [], apiFetch(routes, calls));
  await setup(home, ['--status'], run.io);
  const output = [...run.printed, ...run.prompts].join('\n');
  assert.ok(!output.includes(TOKEN), 'the token must never be printed');
  assert.equal(run.printed.length, 1);
  assert.equal(run.doctorRuns(), 0);
  return { result: JSON.parse(run.printed[0]!), calls };
}

test('--status without a token says save-token and creates nothing', async (t) => {
  const home = tempHome(t);
  const { result, calls } = await status(t, home, {});
  assert.equal(result.next, 'save-token');
  assert.equal(result.home, home);
  assert.equal(result.discord, null);
  assert.equal(result.config.exists, false);
  assert.deepEqual(result.token, { saved: false, looksValid: false });
  assert.equal(result.mainChannel, null);
  assert.equal(result.login, null);
  assert.equal(typeof result.node.ok, 'boolean');
  assert.ok(result.hint.includes(`${path.join(home, '.env')} after DISCORD_BOT_TOKEN=`));
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(home), false);

  saveToken(home);
  const rejected = await status(t, home, { 'GET /users/@me': 401 });
  assert.equal(rejected.result.next, 'save-token');
  assert.deepEqual(rejected.result.discord, { reachable: true, tokenAccepted: false });
  assert.match(rejected.result.hint, /Reset Token/);
});

test('--status with a working token and no config says main-channel and lists the server', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  const { result } = await status(t, home, botRoutes());
  assert.equal(result.next, 'main-channel');
  assert.deepEqual(result.token, { saved: true, looksValid: true });
  assert.equal(result.discord.reachable, true);
  assert.equal(result.discord.tokenAccepted, true);
  assert.deepEqual(result.discord.bot, { id: APP, username: 'ada-bot' });
  assert.equal(result.discord.applicationId, APP);
  assert.equal(result.discord.messageContentIntent, true);
  assert.equal(result.discord.inviteUrl, inviteUrl(APP));
  assert.deepEqual(result.discord.guilds, [
    {
      id: GUILD,
      name: 'Lab',
      ownerId: OWNER,
      ownerName: 'Ada Lovelace',
      canManageChannels: true,
      textChannels: [{ id: CHANNEL, name: 'general' }],
    },
  ]);
  assert.match(result.hint, /clawstrum setup --main-channel NAME --provider claude\|codex/);
  assert.deepEqual(result.review, { channelId: null, scheduled: false });
  assert.equal(result.node.nightlyReviewOk, nodeSupport().nightlyReviewOk);
  assert.deepEqual(fs.readdirSync(home), ['.env']);
});

test('--status says message-content-intent when the intent is off', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  const { result } = await status(t, home, botRoutes({ intent: false }));
  assert.equal(result.discord.messageContentIntent, false);
  assert.equal(result.next, 'message-content-intent');
  assert.match(result.hint, /Message Content Intent/);
});

test('--status says invite-bot with the invite link when the bot is in no server', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  const { result } = await status(t, home, botRoutes({ guilds: [] }));
  assert.equal(result.next, 'invite-bot');
  assert.deepEqual(result.discord.guilds, []);
  assert.ok(result.hint.includes(inviteUrl(APP)));
  const permissions = BigInt(new URL(result.discord.inviteUrl).searchParams.get('permissions')!);
  assert.notEqual(permissions & (1n << 4n), 0n, 'the invite asks for Manage Channels');
});

test('readEnvToken takes the last assignment, as the daemon does', (t) => {
  const home = tempHome(t);
  saveToken(home, `# Discord bot token\nDISCORD_BOT_TOKEN=\nDISCORD_BOT_TOKEN=${TOKEN}\n`);
  assert.equal(readEnvToken(path.join(home, '.env')), TOKEN);
  saveToken(home, `DISCORD_BOT_TOKEN=${TOKEN}\nDISCORD_BOT_TOKEN=second\n`);
  assert.equal(readEnvToken(path.join(home, '.env')), 'second');
});

async function mainChannel(home: string, args: string[], routes: Record<string, unknown>) {
  const calls: ApiCall[] = [];
  const run = scripted([], [], [], apiFetch(routes, calls));
  try {
    await setup(home, ['--main-channel', ...args], run.io);
  } finally {
    const output = [...run.printed, ...run.prompts].join('\n');
    assert.ok(!output.includes(TOKEN), 'the token must never be printed');
  }
  assert.equal(run.prompts.length, 0);
  return { printed: run.printed, calls };
}

test('--main-channel creates the channel and config.json with the server owner', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  const routes = {
    ...botRoutes(),
    [`POST /guilds/${GUILD}/channels`]: { id: NEW_CHANNEL, name: 'therapy', type: 0 },
  };
  const { printed, calls } = await mainChannel(
    home,
    ['therapy', '--provider', 'codex', '--name', 'Ada'],
    routes,
  );
  const posts = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts, [
    {
      method: 'POST',
      route: `/guilds/${GUILD}/channels`,
      body: {
        name: 'therapy',
        type: 0,
        topic: 'Main channel: talk to Ada about itself, its setup and your projects.',
      },
    },
  ]);
  const config = raw(home);
  assert.deepEqual(config.discord.ownerIds, [OWNER]);
  assert.equal(config.discord.guildId, GUILD);
  assert.deepEqual(config.discord.channelIds, [NEW_CHANNEL]);
  assert.equal(config.discord.applicationId, APP);
  assert.equal(config.name, 'Ada');
  assert.equal(config.accounts[0].provider, 'codex');
  assert.equal(
    printed.at(-1),
    `Main channel: #therapy (${NEW_CHANNEL}). Start your agent with clawstrum start; on a new installation it writes there first.`,
  );
  assert.ok(printed.includes(`Created #therapy (${NEW_CHANNEL}) in Lab.`));
  assert.ok(
    printed.includes(
      `Owner: ${OWNER} (Ada Lovelace), the owner of server Lab. Only this Discord user can talk to the agent; if that is not you, set your own ID in discord.ownerIds in config.json.`,
    ),
  );
  assert.equal(config.review.channelId, NEW_CHANNEL);
  assert.ok(
    printed.some((l) =>
      /^Nightly self-review scheduled in this channel at 03:00 \(.+\)\.$/.test(l),
    ),
  );
  const store = new Store(home);
  t.after(() => store.close());
  const task = store.get<{ status: string }>(
    'SELECT status FROM tasks WHERE id=?',
    `review:${NEW_CHANNEL}`,
  );
  assert.equal(task?.status, 'active');
});

test('--main-channel without Manage Channels asks for the channel to be made by hand', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  const calls: ApiCall[] = [];
  const run = scripted([], [], [], apiFetch(botRoutes({ permissions: '0' }), calls));
  await assert.rejects(
    setup(home, ['--main-channel', 'therapy', '--provider', 'codex'], run.io),
    /Create a text channel named therapy \(click \+ next to Text Channels\), then run this again/,
  );
  assert.ok(!calls.some((c) => c.method === 'POST'));
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
});

test('--main-channel uses an existing channel found by name and writes the guide once', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  const first = await mainChannel(home, ['General', '--provider', 'codex', '--json'], botRoutes());
  assert.ok(!first.calls.some((c) => c.method === 'POST'));
  const firstResult = JSON.parse(first.printed.at(-1)!);
  assert.equal(typeof firstResult.review.timezone, 'string');
  assert.deepEqual(firstResult, {
    channel: { id: CHANNEL, name: 'general', guildId: GUILD },
    created: false,
    configCreated: true,
    ownerId: OWNER,
    ownerSource: 'server-owner',
    ownerName: 'Ada Lovelace',
    review: {
      channelId: CHANNEL,
      at: '03:00',
      timezone: firstResult.review.timezone,
      scheduled: true,
    },
    warnings: nodeSupport().nightlyReviewOk ? [] : [firstResult.warnings[0]],
  });
  assert.equal(first.printed.length, 1);
  assert.deepEqual(raw(home).discord.channelIds, [CHANNEL]);
  const agents = path.join(home, 'channels', CHANNEL, 'AGENTS.md');
  const text = fs.readFileSync(agents, 'utf8');
  assert.equal(text.split('## Main channel').length, 2);
  assert.equal(text.split('## Clawstrum for this channel').length, 2);
  assert.ok(text.indexOf('## Main channel') < text.indexOf('## Clawstrum for this channel'));

  const OTHER = '888888888888888888';
  const config = raw(home);
  config.discord.channelIds = [OTHER, CHANNEL];
  writeRaw(home, config);
  const second = await mainChannel(home, ['general'], botRoutes());
  assert.ok(!second.calls.some((c) => c.method === 'POST'));
  assert.deepEqual(raw(home).discord.channelIds, [CHANNEL, OTHER]);
  assert.deepEqual(raw(home).discord.ownerIds, [OWNER]);
  assert.ok(
    second.printed.includes('A running agent reads the change after: clawstrum restart request'),
  );
  assert.ok(!second.printed.some((l) => l.startsWith('Added the main channel guide')));
  assert.equal(fs.readFileSync(agents, 'utf8'), text);
  assert.equal(raw(home).review.channelId, CHANNEL);
  assert.equal(
    second.printed.at(-1),
    `Main channel: #general (${CHANNEL}). Start your agent with clawstrum start; on a new installation it writes there first.`,
  );
});

test('--status reports the scheduled review and the login step', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  await mainChannel(home, ['general', '--provider', 'codex'], botRoutes());
  const runtime = path.join(path.dirname(home), 'runtime');
  fs.writeFileSync(runtime, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(runtime, 0o755);
  const config = raw(home);
  config.accounts[0].executable = runtime;
  writeRaw(home, config);
  const { result } = await status(t, home, botRoutes());
  assert.deepEqual(result.review, { channelId: CHANNEL, scheduled: true });
  assert.deepEqual(result.mainChannel, { id: CHANNEL, name: 'general', guildId: GUILD });
  assert.deepEqual(result.login, { account: 'main', provider: 'codex', signedIn: false });
  assert.equal(result.next, 'login');
  assert.match(result.hint, /clawstrum account login main --device/);
});

test('a Claude token kept in .env (tokenEnv) counts as signed in for --status and doctor', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  await mainChannel(home, ['general', '--provider', 'claude'], botRoutes());
  // Stands in for the Claude runtime: auth status passes only when the token reaches it.
  const runtime = path.join(path.dirname(home), 'runtime');
  fs.writeFileSync(
    runtime,
    '#!/bin/sh\nif [ "$1" = auth ]; then [ "$CLAUDE_CODE_OAUTH_TOKEN" = test-claude-token ]; exit $?; fi\necho 1.2.3\n',
  );
  fs.chmodSync(runtime, 0o755);
  const config = raw(home);
  config.accounts[0].executable = runtime;
  config.accounts[0].tokenEnv = 'CLAWSTRUM_CLAUDE_TOKEN';
  writeRaw(home, config);
  const before = await status(t, home, botRoutes());
  assert.deepEqual(before.result.login, { account: 'main', provider: 'claude', signedIn: false });
  assert.equal(before.result.next, 'login');

  saveToken(home, `DISCORD_BOT_TOKEN=${TOKEN}\nCLAWSTRUM_CLAUDE_TOKEN=test-claude-token\n`);
  const after = await status(t, home, botRoutes());
  assert.deepEqual(after.result.login, { account: 'main', provider: 'claude', signedIn: true });
  assert.equal(after.result.next, 'start');
  assert.equal(process.env.CLAWSTRUM_CLAUDE_TOKEN, undefined, '--status leaves process.env alone');

  // doctor runs after loadEnv, so the token is in process.env there.
  process.env.CLAWSTRUM_CLAUDE_TOKEN = 'test-claude-token';
  t.after(() => delete process.env.CLAWSTRUM_CLAUDE_TOKEN);
  const store = new Store(home);
  t.after(() => store.close());
  let checks: DoctorCheck[] = [];
  const exitCode = process.exitCode;
  try {
    await doctor(readConfig(home), store, false, (c) => {
      checks = c;
    });
  } finally {
    process.exitCode = exitCode;
  }
  const signIn = checks.find((c) => c.check === 'main sign-in')!;
  assert.equal(signIn.ok, true);
  assert.equal(signIn.detail, 'signed in with a token: env CLAWSTRUM_CLAUDE_TOKEN (set)');
});

test('gemini is a provider choice in the wizard, with --yes, in init and with --main-channel', async (t) => {
  const wizard = tempHome(t);
  const run = scripted(['Ada', 'gemini', APP, OWNER, GUILD, CHANNEL], [TOKEN]);
  await setup(wizard, ['--no-login'], run.io);
  assert.ok(run.prompts.some((p) => p.includes('gemini (Google subscription with Gemini)')));
  assert.equal(raw(wizard).accounts[0].provider, 'gemini');
  assert.equal(raw(wizard).accounts[0].home, 'accounts/main/gemini');

  const flagged = tempHome(t);
  await setup(
    flagged,
    ['--yes', '--provider', 'gemini', '--token-file', tokenFile(flagged), '--owner', OWNER],
    scripted([]).io,
  );
  assert.equal(raw(flagged).accounts.length, 1);
  assert.equal(raw(flagged).accounts[0].provider, 'gemini');
  assert.equal(raw(flagged).accounts[0].home, 'accounts/main/gemini');

  const initHome = tempHome(t);
  await init(initHome, ['--provider', 'gemini', '--owner', OWNER], {
    isInteractive: false,
    print: () => {},
  });
  assert.equal(raw(initHome).accounts[0].provider, 'gemini');

  const channelHome = tempHome(t);
  saveToken(channelHome);
  await mainChannel(channelHome, ['general', '--provider', 'gemini'], botRoutes());
  assert.equal(raw(channelHome).accounts[0].provider, 'gemini');
  assert.equal(raw(channelHome).accounts[0].home, 'accounts/main/gemini');

  const other = tempHome(t);
  saveToken(other);
  await assert.rejects(
    mainChannel(other, ['general', '--provider', 'gpt'], botRoutes()),
    /--provider must be claude, codex or gemini/,
  );
});

/** A stand-in for agy that answers the login probe; `authfail` means no Google login. */
function fakeAgy(home: string, scenario: 'text' | 'authfail'): string {
  const agent = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
  const file = path.join(path.dirname(home), 'agy');
  fs.writeFileSync(
    file,
    `#!/bin/sh\nFAKE_ACP_SCENARIO=${scenario} exec "${process.execPath}" "${agent}" "$@"\n`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

test('--status reports the gemini sign-in from the login probe', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  await mainChannel(home, ['general', '--provider', 'gemini'], botRoutes());
  const config = raw(home);
  config.accounts[0].executable = fakeAgy(home, 'authfail');
  writeRaw(home, config);
  const out = await status(t, home, botRoutes());
  assert.deepEqual(out.result.login, { account: 'main', provider: 'gemini', signedIn: false });
  assert.equal(out.result.next, 'login');
  assert.match(out.result.hint, /run clawstrum account login main\. It runs agy acp --login/);
  assert.match(out.result.hint, /Google account that has the Gemini subscription/);
  assert.doesNotMatch(out.result.hint, /--device/);

  config.accounts[0].executable = fakeAgy(home, 'text');
  writeRaw(home, config);
  const signed = await status(t, home, botRoutes());
  assert.deepEqual(signed.result.login, { account: 'main', provider: 'gemini', signedIn: true });
  assert.equal(signed.result.next, 'start');
});

test('--main-channel leaves a review channel set elsewhere in config.json', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  await mainChannel(home, ['general', '--provider', 'codex'], botRoutes());
  const OTHER = '888888888888888888';
  const config = raw(home);
  config.discord.channelIds = [CHANNEL, OTHER];
  config.review.channelId = OTHER;
  writeRaw(home, config);
  const NEXT = '999999999999999999';
  const routes = botRoutes({
    channels: [{ id: NEXT, name: 'lab-main', type: 0 }],
  });
  const run = await mainChannel(home, ['lab-main', '--json'], routes);
  const result = JSON.parse(run.printed.at(-1)!);
  assert.equal(result.review.channelId, OTHER);
  assert.equal(result.review.scheduled, false);
  assert.match(result.review.reason, new RegExp(OTHER));
  assert.equal(result.ownerSource, 'config');
  assert.equal(result.ownerName, undefined);
  assert.equal(raw(home).review.channelId, OTHER);
  assert.deepEqual(raw(home).discord.channelIds, [NEXT, CHANNEL, OTHER]);
  const text = fs.readFileSync(path.join(home, 'channels', NEXT, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes('## Main channel'));
  assert.ok(!text.includes('## Clawstrum for this channel'));
});

test('--main-channel normalizes the name as Discord does and refuses other characters', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  const OWNER2 = '444444444444444444';
  const routes = botRoutes({ channels: [{ id: CHANNEL, name: 'main-channel', type: 0 }] });
  const { printed, calls } = await mainChannel(
    home,
    ['  Main   Channel ', '--provider', 'codex', '--owner', OWNER2, '--json'],
    routes,
  );
  const result = JSON.parse(printed.at(-1)!);
  assert.deepEqual(result.channel, { id: CHANNEL, name: 'main-channel', guildId: GUILD });
  assert.equal(result.created, false);
  assert.equal(result.ownerSource, 'flag');
  assert.deepEqual(raw(home).discord.ownerIds, [OWNER2]);
  assert.ok(!calls.some((c) => c.method === 'POST' || c.route.startsWith('/users/4')));

  await assert.rejects(
    mainChannel(home, ['#main!'], routes),
    /^Error: Channel name: use lowercase letters, digits, - or _ \(for example main\)$/,
  );
});

test('--main-channel refuses an owner, provider or name that differs from config.json', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  await mainChannel(home, ['general', '--provider', 'codex', '--name', 'Ada'], botRoutes());
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  for (const [flag, value] of [
    ['--owner', '444444444444444444'],
    ['--provider', 'claude'],
    ['--name', 'Bob'],
  ] as const)
    await assert.rejects(
      mainChannel(home, ['general', flag, value], botRoutes()),
      new RegExp(
        `${flag} differs from .* in config.json. To change it, run clawstrum setup --reconfigure`,
      ),
    );
  await mainChannel(
    home,
    ['general', '--owner', OWNER, '--provider', 'codex', '--name', 'Ada'],
    botRoutes(),
  );
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
});

test('saving a token leaves exactly one token line and keeps the other lines', async (t) => {
  const home = tempHome(t);
  saveToken(home, 'DISCORD_BOT_TOKEN=old\nOTHER=1\nDISCORD_BOT_TOKEN=older\n');
  fs.chmodSync(path.join(home, '.env'), 0o644);
  await setup(home, flagRun(home), scripted([]).io);
  const env = path.join(home, '.env');
  assert.equal(fs.readFileSync(env, 'utf8'), `OTHER=1\nDISCORD_BOT_TOKEN=${TOKEN}\n`);
  assert.equal(fs.statSync(env).mode & 0o777, 0o600);
});

test('Node 22.13 runs setup; below 22.16 only the nightly review is flagged', () => {
  assert.deepEqual(nodeSupport('20.18.0'), { ok: false, nightlyReviewOk: false });
  assert.deepEqual(nodeSupport('22.13.0'), { ok: true, nightlyReviewOk: false });
  assert.deepEqual(nodeSupport('v22.15.1'), { ok: true, nightlyReviewOk: false });
  assert.deepEqual(nodeSupport('22.16.0'), { ok: true, nightlyReviewOk: true });
  assert.deepEqual(nodeSupport('24.1.0'), { ok: true, nightlyReviewOk: true });
});

test('the wizard turns on the nightly self-review in its channel, and not without one', async (t) => {
  const home = tempHome(t);
  const run = scripted([]);
  await setup(home, flagRun(home, ['--guild', GUILD, '--channel', CHANNEL]), run.io);
  assert.equal(raw(home).review.channelId, CHANNEL);
  assert.ok(
    run.printed.some((l) =>
      /^Nightly self-review scheduled in this channel at 03:00 \(.+\)\.$/.test(l),
    ),
  );
  const text = fs.readFileSync(path.join(home, 'channels', CHANNEL, 'AGENTS.md'), 'utf8');
  assert.ok(text.indexOf('## Main channel') >= 0);
  assert.ok(text.indexOf('## Main channel') < text.indexOf('## Clawstrum for this channel'));
  const store = new Store(home);
  t.after(() => store.close());
  assert.equal(
    store.get<{ status: string }>('SELECT status FROM tasks WHERE id=?', `review:${CHANNEL}`)
      ?.status,
    'active',
  );

  const other = tempHome(t);
  const plain = scripted([]);
  await setup(other, flagRun(other), plain.io);
  assert.equal(raw(other).review.channelId, undefined);
  assert.ok(!plain.printed.some((l) => /self-review/i.test(l)));
  const otherStore = new Store(other);
  t.after(() => otherStore.close());
  assert.equal(otherStore.get('SELECT id FROM tasks WHERE id LIKE ?', 'review:%'), undefined);
});

async function setupRun(home: string, args: string[], routes: Record<string, unknown>) {
  const calls: ApiCall[] = [];
  const run = scripted([], [], [], apiFetch(routes, calls));
  try {
    await setup(home, args, run.io);
  } finally {
    const output = [...run.printed, ...run.prompts].join('\n');
    assert.ok(!output.includes(TOKEN), 'the token must never be printed');
  }
  assert.equal(run.prompts.length, 0);
  return { printed: run.printed, calls };
}

test('--add-channel creates a project channel and appends it to discord.channelIds', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  await mainChannel(home, ['general', '--provider', 'codex', '--name', 'Ada'], botRoutes());
  const OTHER = '888888888888888888';
  const config = raw(home);
  config.discord.channelIds = [CHANNEL, OTHER];
  writeRaw(home, config);
  const guide = fs.readFileSync(path.join(home, 'channels', CHANNEL, 'AGENTS.md'), 'utf8');
  const routes = {
    ...botRoutes(),
    [`POST /guilds/${GUILD}/channels`]: { id: NEW_CHANNEL, name: 'project-x', type: 0 },
  };
  const { printed, calls } = await setupRun(home, ['--add-channel', 'Project X'], routes);
  assert.deepEqual(
    calls.filter((c) => c.method === 'POST').map((c) => c.body),
    [{ name: 'project-x', type: 0, topic: 'Project channel for Ada.' }],
  );
  const after = raw(home);
  assert.deepEqual(after.discord.channelIds, [CHANNEL, OTHER, NEW_CHANNEL]);
  assert.equal(after.review.channelId, CHANNEL);
  assert.equal(
    printed.at(-1),
    `Added #project-x (${NEW_CHANNEL}) to discord.channelIds; the running agent picks it up within seconds.`,
  );
  assert.ok(fs.existsSync(path.join(home, 'channels', NEW_CHANNEL, 'AGENTS.md')));
  assert.equal(fs.readFileSync(path.join(home, 'channels', CHANNEL, 'AGENTS.md'), 'utf8'), guide);
});

test('--add-channel adds an existing channel once and never duplicates an ID', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  await mainChannel(home, ['general', '--provider', 'codex'], botRoutes());
  const PROJECT = '101010101010101010';
  const routes = botRoutes({
    channels: [
      { id: CHANNEL, name: 'general', type: 0 },
      { id: PROJECT, name: 'proj', type: 0 },
    ],
  });
  const first = await setupRun(home, ['--add-channel', 'proj', '--json'], routes);
  assert.deepEqual(JSON.parse(first.printed.at(-1)!), {
    channel: { id: PROJECT, name: 'proj', guildId: GUILD },
    created: false,
    added: true,
  });
  const second = await setupRun(home, ['--add-channel', 'proj', '--json'], routes);
  assert.equal(JSON.parse(second.printed.at(-1)!).added, false);
  const main = await setupRun(home, ['--add-channel', 'general'], routes);
  assert.equal(main.printed.at(-1), `Already configured: #general (${CHANNEL}).`);
  for (const run of [first, second, main]) assert.ok(!run.calls.some((c) => c.method === 'POST'));
  assert.deepEqual(raw(home).discord.channelIds, [CHANNEL, PROJECT]);
});

test('--add-channel needs a config.json and cannot be combined with --main-channel', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  await assert.rejects(
    setupRun(home, ['--add-channel', 'proj'], botRoutes()),
    /no config\.json yet.*clawstrum setup --main-channel NAME/,
  );
  await assert.rejects(
    setupRun(home, ['--main-channel', 'general', '--add-channel', 'proj'], botRoutes()),
    /Use --main-channel or --add-channel, not both/,
  );
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
});

test('the main channel guide points at --add-channel, not a restart', async (t) => {
  const home = tempHome(t);
  saveToken(home);
  await mainChannel(home, ['general', '--provider', 'codex'], botRoutes());
  const text = fs.readFileSync(path.join(home, 'channels', CHANNEL, 'AGENTS.md'), 'utf8');
  const guide = text.slice(text.indexOf('## Main channel'), text.indexOf('## Clawstrum for this'));
  assert.ok(guide.includes('clawstrum setup --add-channel NAME'));
  assert.ok(!guide.includes('restart request'));
});
