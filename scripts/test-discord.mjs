#!/usr/bin/env node
// Explicit live acceptance command. Never run as part of npm test / PR CI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { parseArgs, parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { REST, Routes, WebhookClient, PermissionFlagsBits } from 'discord.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../dist/store.js';
import { Engine } from '../dist/engine.js';
import { Discord } from '../dist/discord.js';
import { configSchema } from '../dist/config.js';
import { ProviderFailure } from '../dist/accounts.js';
import { supervisedProviders } from '../dist/supervisor.js';
import { writePrivate } from '../dist/files.js';

const { values } = parseArgs({
  options: {
    guild: { type: 'string' },
    'env-file': { type: 'string' },
    'token-env': { type: 'string', default: 'DISCORD_BOT_TOKEN' },
    report: { type: 'string' },
    models: { type: 'boolean', default: false },
    'claude-only': { type: 'boolean', default: false },
    'claude-model': { type: 'string', default: 'haiku' },
    'claude-effort': { type: 'string', default: 'low' },
    'claude-token-env': { type: 'string', default: 'CLAUDE_CODE_OAUTH_TOKEN' },
    'codex-home': { type: 'string' },
    'codex-model': { type: 'string' },
    'keep-channel': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
const withClaude = values.models || values['claude-only'];
if (values.help) {
  console.log(
    'npm run test:discord -- --guild ID [--env-file FILE] [--token-env NAME] [--report FILE] [--models --codex-home DIR --codex-model MODEL | --claude-only] [--claude-token-env NAME --claude-model MODEL --claude-effort EFFORT] [--keep-channel]\nCreates and cleans up a private test channel/webhooks. Requires Manage Channels + Manage Webhooks and Message Content Intent. Uses isolated state; does not register application commands. --models makes bounded subscription calls with existing credentials.',
  );
  process.exit(0);
}
if (!values.guild || !/^\d{5,25}$/.test(values.guild))
  throw new Error('--guild requires a Discord server ID');
const credentials = {
  ...(values['env-file'] ? parseEnv(fs.readFileSync(values['env-file'], 'utf8')) : {}),
  ...process.env,
};
const token = credentials[values['token-env']];
if (!token) throw new Error(`Missing ${values['token-env']}; use the environment or --env-file`);
const secrets = [token];
const runId = randomUUID();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-discord-e2e-'));
const reportPath = path.resolve(
  values.report ?? path.join(os.homedir(), 'clawstrum-test-results', runId, 'discord.json'),
);
const report = {
  runId,
  startedAt: new Date().toISOString(),
  mode: values.models
    ? 'live-discord-and-subscription-models'
    : values['claude-only']
      ? 'live-discord-and-claude'
      : 'live-discord-scripted-provider',
  stateHome: home,
  guildId: values.guild,
  cases: [],
  cleanup: {},
  limitations: [
    'Webhook ingress is explicitly enabled only in this isolated runner; normal Clawstrum rejects bot/webhook input.',
    'Human DM/slash invocation, real quota exhaustion, long-duration soak and native compaction are not proven by this run.',
  ],
};
const rest = new REST({ version: '10', timeout: 15000, retries: 1 }).setToken(token);
let store, engine, discord, channel, input, stranger, interval;
let fatal;
let deadlineReached = false;
const requestStop = () => {
  deadlineReached = true;
  void engine?.stop();
  void discord?.close();
};
const deadline = setTimeout(requestStop, 12 * 60 * 1000);
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);
const safe = (error) =>
  secrets
    .reduce(
      (s, secret) => (secret ? s.replaceAll(secret, '[redacted]') : s),
      String(error?.message ?? error),
    )
    .replace(/(webhooks\/\d+\/)[^\s?/'"]+/g, '$1[redacted]');
const persist = () => writePrivate(reportPath, JSON.stringify(report, null, 2) + '\n');
async function until(fn, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end && !deadlineReached) {
    if (fatal) throw fatal;
    const result = await fn();
    if (result) return result;
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}
async function check(name, fn) {
  const started = Date.now();
  try {
    const evidence = await fn();
    report.cases.push({ name, status: 'passed', durationMs: Date.now() - started, evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.cases.push({
      name,
      status: 'failed',
      durationMs: Date.now() - started,
      error: safe(error),
    });
    console.log(`FAIL ${name}: ${safe(error)}`);
    throw error;
  } finally {
    persist();
  }
}
async function tool(r, name, args) {
  const client = new Client({ name: 'clawstrum-discord-acceptance', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: r.mcp.command,
        args: r.mcp.args,
        env: { PATH: process.env.PATH, ...r.mcp.env },
        stderr: 'pipe',
      }),
    );
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content?.[0]?.text ?? 'MCP error');
    return result;
  } finally {
    await client.close();
  }
}
const adapter = {
  async run(r) {
    if (r.account.id.endsWith('-live')) return supervisedProviders[r.account.provider].run(r);
    r.onEvent({ type: 'ready' });
    const run = store.get('SELECT * FROM runs WHERE id=?', r.mcp.env.CLAWSTRUM_RUN);
    const messages = JSON.parse(run.message_ids).map((id) =>
      store.get('SELECT * FROM inbound WHERE id=?', id),
    );
    const text = messages
      .map((m) => (m.kind === 'task' ? m.content.slice(m.content.indexOf('\n') + 1) : m.content))
      .join('\n');
    if (text.startsWith('echo:')) return text.replace('echo:', 'ECHO:');
    if (text.startsWith('paragraphs:') || text.startsWith('paragraphs-auto:')) {
      const nonce = text.slice(text.indexOf(':') + 1);
      const gap = String.raw`\n\n`;
      const body = `PARAGRAPHS:${nonce}${gap}Second paragraph.\nLiteral: \`${gap}\`.`;
      if (text.startsWith('paragraphs-auto:')) return body;
      await tool(r, 'send_message', { text: body, final: true, key: 'paragraphs' });
      return 'This automatic recap must not be delivered';
    }
    if (text.startsWith('wake:')) return text.replace('wake:', 'WAKE:');
    if (text === 'quiet') return 'CLAWSTRUM_QUIET';
    if (text.startsWith('long:'))
      return `LONG:${text.slice(5)}\n${'Long response evidence. '.repeat(120)}`;
    if (text.startsWith('attachment:')) {
      const attached = JSON.parse(messages[0].attachments);
      assert.equal(attached.length, 1);
      const bytes = fs.readFileSync(attached[0].path);
      return `ATTACHMENT:${createHash('sha256').update(bytes).digest('hex')}`;
    }
    if (text.startsWith('file:')) {
      const file = path.join(r.cwd, 'acceptance-result.txt');
      writePrivate(file, `FILE:${text.slice(5)}`);
      await tool(r, 'send_file', {
        path: file,
        caption: `FILE:${text.slice(5)}`,
        final: true,
        key: 'result',
      });
      return 'This automatic recap must not be delivered';
    }
    if (text.startsWith('schedule:') || text.startsWith('schedule-quiet:')) {
      const nonce = text.slice(text.indexOf(':') + 1);
      await tool(r, 'schedule_task', {
        prompt: text.startsWith('schedule-quiet:') ? 'quiet' : `wake:${nonce}`,
        kind: 'once',
        schedule: new Date(Date.now() + 2500).toISOString(),
        key: 'wake',
      });
      return `SCHEDULED:${nonce}`;
    }
    if (text.startsWith('hold:') || (text.startsWith('switch:') && r.account.id === 'fixture-a')) {
      await tool(r, 'checkpoint', {
        markdown: `Acceptance pending: ${text}. No external jobs were started.`,
      });
      if (r.controller.signal.aborted) throw r.controller.signal.reason;
      await new Promise((resolve) =>
        r.controller.signal.addEventListener('abort', resolve, { once: true }),
      );
      throw r.controller.signal.reason;
    }
    if (text.startsWith('switch:')) {
      assert.match(
        fs.readFileSync(path.join(r.cwd, 'CHECKPOINT.md'), 'utf8'),
        /Acceptance pending/,
      );
      return `SWITCHED:${text.slice(7)}:${r.account.id}`;
    }
    if (text.startsWith('quota:')) {
      if (r.account.id === 'fixture-a')
        throw new ProviderFailure('quota', 'Synthetic quota rejection for acceptance only');
      return `QUOTA_RECOVERED:${text.slice(6)}:${r.account.id}`;
    }
    throw new Error(`Scripted adapter received an unsupported acceptance command`);
  },
};
let config;
async function start() {
  store = new Store(home);
  engine = new Engine(config, store, { claude: adapter, codex: adapter });
  discord = new Discord(config, store, engine, {
    registerCommands: false,
    testWebhook: { id: input.id, channelId: channel.id, guildId: values.guild },
  });
  engine.start();
  await discord.connect(token);
  interval = setInterval(() => {
    try {
      engine.tick();
      void discord.tick().catch((e) => {
        fatal = e;
      });
    } catch (error) {
      fatal = error;
    }
  }, 150);
}
async function stop() {
  clearInterval(interval);
  if (engine) await engine.stop();
  if (discord) await discord.close();
  store?.close();
  engine = discord = store = undefined;
}
async function send(content, extra = {}) {
  return input.send({ content, allowedMentions: { parse: [] }, ...extra });
}
async function delivered(content, channelId = channel.id, timeout = 45000) {
  const row = await until(
    () =>
      store.get(
        "SELECT o.* FROM outbox o JOIN sessions s ON s.id=o.session_id WHERE s.channel_id=? AND o.content=? AND o.status='sent'",
        channelId,
        content,
      ),
    `delivery ${content.slice(0, 70)}`,
    timeout,
  );
  const message = await rest.get(Routes.channelMessage(channelId, row.remote_id));
  assert.equal(message.author.id, report.botId);
  return { row, message };
}
async function command(action) {
  const sent = await send(`!clawstrum ${action}`);
  return until(
    () =>
      store.get("SELECT * FROM outbox WHERE dedupe_key=? AND status='sent'", `command:${sent.id}`),
    `command ${action}`,
  );
}
try {
  const me = await rest.get(Routes.user());
  assert.equal(me.bot, true);
  report.botId = me.id;
  const guilds = await rest.get(Routes.userGuilds());
  const guild = guilds.find((g) => g.id === values.guild);
  if (!guild) throw new Error('The bot is not a member of the selected server');
  const permissions = BigInt(guild.permissions);
  const needed = PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageWebhooks;
  if (!(permissions & PermissionFlagsBits.Administrator) && (permissions & needed) !== needed)
    throw new Error(
      'Live acceptance needs Manage Channels and Manage Webhooks in the selected server',
    );
  const topic = `Clawstrum automated acceptance ${runId}; temporary synthetic messages only.`;
  report.channelTopic = topic;
  channel = await rest.post(Routes.guildChannels(values.guild), {
    body: {
      name: `clawstrum-test-${runId.slice(0, 8)}`,
      type: 0,
      topic,
      permission_overwrites: [
        { id: values.guild, type: 0, deny: String(PermissionFlagsBits.ViewChannel) },
        {
          id: me.id,
          type: 1,
          allow: String(
            PermissionFlagsBits.ViewChannel |
              PermissionFlagsBits.SendMessages |
              PermissionFlagsBits.ReadMessageHistory |
              PermissionFlagsBits.AttachFiles |
              PermissionFlagsBits.AddReactions |
              PermissionFlagsBits.ManageWebhooks |
              PermissionFlagsBits.CreatePublicThreads |
              PermissionFlagsBits.SendMessagesInThreads,
          ),
        },
      ],
    },
  });
  report.channelId = channel.id;
  persist();
  const makeWebhook = async (name) => {
    const w = await rest.post(Routes.channelWebhooks(channel.id), { body: { name } });
    secrets.push(w.token);
    return new WebhookClient({ id: w.id, token: w.token });
  };
  input = await makeWebhook('Clawstrum acceptance input');
  stranger = await makeWebhook('Clawstrum untrusted input');
  config = configSchema.parse({
    version: 1,
    discord: {
      ownerIds: [input.id],
      guildId: values.guild,
      channelIds: [channel.id],
      allowDMs: false,
    },
    accounts: [
      { id: 'fixture-a', provider: 'claude', home: path.join(home, 'fixture-a') },
      { id: 'fixture-b', provider: 'codex', home: path.join(home, 'fixture-b') },
    ],
    runtime: {
      debounceMs: 0,
      debounceMaxMs: 0,
      startupTimeoutMs: 90000,
      silenceTimeoutMs: 90000,
      turnTimeoutMs: 180000,
      slowRetryMs: 0,
      maxAttempts: 1,
    },
  });
  if (withClaude) {
    const claudeToken = credentials[values['claude-token-env']];
    if (!claudeToken || (values.models && !values['codex-home']))
      throw new Error('Live Claude needs an OAuth token; --models also needs --codex-home');
    secrets.push(claudeToken);
    process.env.CLAWSTRUM_ACCEPTANCE_CLAUDE_TOKEN = claudeToken;
    const codexHome = path.join(home, 'codex-live');
    if (values.models)
      writePrivate(
        path.join(codexHome, 'auth.json'),
        fs.readFileSync(path.join(path.resolve(values['codex-home']), 'auth.json'), 'utf8'),
      );
    config = configSchema.parse({
      ...config,
      accounts: [
        ...config.accounts,
        {
          id: 'claude-live',
          provider: 'claude',
          home: path.join(home, 'claude-live'),
          tokenEnv: 'CLAWSTRUM_ACCEPTANCE_CLAUDE_TOKEN',
          model: values['claude-model'],
          effort: values['claude-effort'],
        },
        ...(values.models
          ? [
              {
                id: 'codex-live',
                provider: 'codex',
                home: codexHome,
                model: values['codex-model'],
                effort: 'low',
              },
            ]
          : []),
      ],
    });
  }
  writePrivate(path.join(home, 'config.json'), JSON.stringify(config, null, 2));
  await start();
  await check('gateway input, automatic reply and REST readback', async () => {
    const m = await send(`echo:${runId}`);
    const out = await delivered(`ECHO:${runId}`);
    assert.equal(store.get('SELECT status FROM inbound WHERE id=?', m.id).status, 'done');
    return { inputId: m.id, outputId: out.message.id };
  });
  await check('input stays quiet while useful notices use the real message thread', async () => {
    const m = await send(`echo:notice-thread-${runId}`);
    const out = await delivered(`ECHO:notice-thread-${runId}`);
    assert.equal(
      store.get('SELECT id FROM outbox WHERE dedupe_key=?', `receipt:${m.id}`),
      undefined,
    );
    await assert.rejects(
      () => rest.get(Routes.channel(m.id)),
      (error) => error.code === 10003,
    );
    assert.equal(out.message.channel_id, channel.id);
    const session = store.ensureSession(channel.id);
    for (const [key, content] of [
      ['capacity', 'Acceptance: waiting for account capacity.'],
      ['retry', 'Acceptance: provider retry scheduled.'],
    ]) {
      store.notice(session.id, content, `thread-notice:${key}:${runId}`, { thread: true });
      const notice = await until(
        () =>
          store.get(
            "SELECT * FROM outbox WHERE dedupe_key=? AND status='sent'",
            `thread-notice:${key}:${runId}`,
          ),
        key + ' notice',
      );
      const update = await rest.get(Routes.channelMessage(m.id, notice.remote_id));
      assert.ok(update.content.includes(content));
    }
    const thread = await rest.get(Routes.channel(m.id));
    assert.equal(thread.parent_id, channel.id);
    const parentMessages = await rest.get(Routes.channelMessages(channel.id), {
      query: new URLSearchParams({ limit: '100' }),
    });
    assert.ok(
      !parentMessages.some((message) =>
        /Message queued|Acceptance: waiting|Acceptance: provider retry/.test(message.content),
      ),
    );
    return { inputId: m.id, threadId: thread.id, replyId: out.message.id, automaticReceipts: 0 };
  });
  await check('untrusted webhook and own replies are ignored', async () => {
    const bad = await stranger.send({
      content: 'echo:UNAUTHORIZED',
      allowedMentions: { parse: [] },
    });
    await discord.backfill();
    await delay(1000);
    assert.equal(store.get('SELECT id FROM inbound WHERE id=?', bad.id), undefined);
    assert.equal(
      store.get('SELECT id FROM inbound WHERE id IN (SELECT remote_id FROM outbox)'),
      undefined,
    );
    return { rejectedMessageId: bad.id };
  });
  await check(
    'escaped paragraphs render as newlines while inline code remains literal',
    async () => {
      const outputs = [];
      for (const route of ['paragraphs', 'paragraphs-auto']) {
        const nonce = `${route}-${runId}`;
        await send(`${route}:${nonce}`);
        const expected = `PARAGRAPHS:${nonce}\n\nSecond paragraph.\nLiteral: \`\\n\\n\`.`;
        const out = await delivered(expected);
        assert.equal(out.message.content, expected);
        outputs.push({
          route: route === 'paragraphs' ? 'MCP' : 'automatic',
          outputId: out.message.id,
        });
      }
      return outputs;
    },
  );
  await check('incoming attachment is downloaded byte-for-byte', async () => {
    const bytes = Buffer.from(`INCOMING:${runId}\n`);
    const m = await send(`attachment:${runId}`, {
      files: [{ attachment: bytes, name: 'acceptance-input.txt' }],
    });
    const hash = createHash('sha256').update(bytes).digest('hex');
    const out = await delivered(`ATTACHMENT:${hash}`);
    return { inputId: m.id, outputId: out.message.id, sha256: hash };
  });
  await check('MCP file delivery preserves bytes and suppresses automatic recap', async () => {
    await send(`file:${runId}`);
    const out = await delivered(`FILE:${runId}`);
    assert.equal(out.message.attachments.length, 1);
    const response = await fetch(out.message.attachments[0].url, {
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(await response.text(), `FILE:${runId}`);
    assert.equal(
      store.get("SELECT id FROM outbox WHERE content='This automatic recap must not be delivered'"),
      undefined,
    );
    return { outputId: out.message.id, attachmentId: out.message.attachments[0].id };
  });
  await check('long answers arrive as ordered messages without automatic attachments', async () => {
    await send(`long:${runId}`);
    const text = `LONG:${runId}\n${'Long response evidence. '.repeat(120)}`;
    const out = await delivered(text);
    const progress = JSON.parse(
      store.get('SELECT value FROM metadata WHERE key=?', `discord-delivery:${out.row.id}`).value,
    );
    assert.ok(progress.remoteIds.length > 1);
    const messages = await Promise.all(
      progress.remoteIds.map((id) => rest.get(Routes.channelMessage(channel.id, id))),
    );
    assert.equal(
      messages
        .map((m) => m.content)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      text.replace(/\s+/g, ' ').trim(),
    );
    assert.ok(messages.every((m) => m.attachments.length === 0 && m.content.length <= 1900));
    return { outputIds: progress.remoteIds, characters: text.length };
  });
  await check('thread input and reply stay in the child thread', async () => {
    const thread = await rest.post(Routes.threads(channel.id), {
      body: { name: 'acceptance-thread', type: 11, auto_archive_duration: 60 },
    });
    const m = await send(`echo:thread-${runId}`, { threadId: thread.id });
    const out = await delivered(`ECHO:thread-${runId}`, thread.id);
    return { threadId: thread.id, inputId: m.id, outputId: out.message.id };
  });
  await check('status command uses the real Discord control path', async () => {
    const out = await command('status');
    const m = await rest.get(Routes.channelMessage(channel.id, out.remote_id));
    assert.match(m.content, /Clawstrum notice/);
    assert.match(m.content, /Session:/);
    return { outputId: m.id };
  });
  await check('stop cancels active work without a late answer', async () => {
    const m = await send(`hold:${runId}`);
    await until(
      () => store.get("SELECT id FROM inbound WHERE id=? AND status='running'", m.id),
      'active held turn',
    );
    await command('stop');
    await until(
      () => store.get("SELECT id FROM inbound WHERE id=? AND status='cancelled'", m.id),
      'cancelled held turn',
    );
    assert.equal(
      store.get(
        'SELECT o.id FROM outbox o JOIN runs r ON r.id=o.run_id WHERE r.message_ids LIKE ?',
        `%"${m.id}"%`,
      ),
      undefined,
    );
    return { cancelledInputId: m.id };
  });
  await check('mid-turn account switch resumes from the saved checkpoint', async () => {
    await command('switch fixture-a');
    const m = await send(`switch:${runId}`);
    const session = store.ensureSession(channel.id);
    await until(
      () =>
        fs.existsSync(path.join(session.workspace, 'CHECKPOINT.md')) &&
        fs
          .readFileSync(path.join(session.workspace, 'CHECKPOINT.md'), 'utf8')
          .includes(`switch:${runId}`),
      'switch checkpoint',
    );
    await command('switch fixture-b');
    const out = await delivered(`SWITCHED:${runId}:fixture-b`);
    return { inputId: m.id, outputId: out.message.id };
  });
  await check('synthetic quota rejection falls back without duplicate delivery', async () => {
    await command('switch fixture-a');
    await send(`quota:${runId}`);
    const out = await delivered(`QUOTA_RECOVERED:${runId}:fixture-b`);
    assert.ok(
      store.get("SELECT cooldown_until FROM accounts WHERE id='fixture-a'").cooldown_until >
        Date.now(),
    );
    return { outputId: out.message.id, fault: 'scripted quota; no subscription exhausted' };
  });
  await check('one-shot scheduling wakes the agent and delivers once', async () => {
    await send(`schedule:${runId}`);
    await delivered(`SCHEDULED:${runId}`);
    const out = await delivered(`WAKE:${runId}`);
    assert.equal(store.get('SELECT count(*) n FROM task_runs').n, 1);
    return { outputId: out.message.id };
  });
  await check('quiet scheduled work completes without sending routine chatter', async () => {
    const nonce = `quiet-${runId}`;
    await send(`schedule-quiet:${nonce}`);
    await delivered(`SCHEDULED:${nonce}`);
    const task = await until(
      () =>
        store.get(
          "SELECT i.id FROM inbound i JOIN task_runs r ON r.message_id=i.id JOIN tasks t ON t.id=r.task_id WHERE t.prompt='quiet' AND i.status='done'",
        ),
      'quiet task completion',
    );
    await discord.tick();
    assert.equal(
      store.get(
        'SELECT o.id FROM outbox o JOIN runs r ON r.id=o.run_id WHERE r.message_ids LIKE ?',
        `%"${task.id}"%`,
      ),
      undefined,
    );
    return { taskInputId: task.id, outgoingMessages: 0 };
  });
  await check('lost send acknowledgement retries with Discord nonce deduplication', async () => {
    const target = await discord.client.channels.fetch(channel.id);
    const sendOriginal = target.send;
    let firstId;
    target.send = async (payload) => {
      const remote = await sendOriginal.call(target, payload);
      if (payload.content === `ECHO:retry-${runId}` && !firstId) {
        firstId = remote.id;
        throw new Error('Synthetic acknowledgement loss after real Discord send');
      }
      return remote;
    };
    try {
      await send(`echo:retry-${runId}`);
      const out = await delivered(`ECHO:retry-${runId}`);
      assert.equal(out.row.attempts, 1);
      assert.equal(out.message.id, firstId);
      const messages = await rest.get(Routes.channelMessages(channel.id), {
        query: new URLSearchParams({ limit: '100' }),
      });
      assert.equal(messages.filter((m) => m.content === `ECHO:retry-${runId}`).length, 1);
      return { outputId: firstId, attempts: out.row.attempts };
    } finally {
      target.send = sendOriginal;
    }
  });
  await check('offline input is recovered after closing and reopening state', async () => {
    await stop();
    const m = await send(`echo:offline-${runId}`);
    await start();
    const out = await delivered(`ECHO:offline-${runId}`);
    await discord.backfill();
    assert.equal(store.get('SELECT count(*) n FROM inbound WHERE id=?', m.id).n, 1);
    assert.equal(store.get('SELECT count(*) n FROM outbox WHERE content=?', out.row.content).n, 1);
    return { inputId: m.id, outputId: out.message.id };
  });
  if (withClaude) {
    store.exec(
      "UPDATE accounts SET disabled=1,reason='scripted phase complete' WHERE id IN ('fixture-a','fixture-b')",
    );
    await command('switch claude-live');
    await check(
      'authenticated Claude runs through Discord and the MCP checkpoint/send tools',
      async () => {
        const m = await send(
          `Automated acceptance test. Use the Clawstrum checkpoint tool to save exactly this line: HANDOFF_SECRET=${runId}. Then use send_message with final=true and key=acceptance-claude to send exactly CLAUDE_OK:${runId}. Do not perform any other work.`,
        );
        const out = await delivered(`CLAUDE_OK:${runId}`, channel.id, 180000);
        const session = store.ensureSession(channel.id);
        assert.match(
          fs.readFileSync(path.join(session.workspace, 'CHECKPOINT.md'), 'utf8'),
          new RegExp(runId),
        );
        assert.equal(out.row.origin, 'agent');
        assert.equal(
          store.get('SELECT account_id FROM runs WHERE id=?', out.row.run_id).account_id,
          'claude-live',
        );
        await until(
          () => store.get("SELECT id FROM inbound WHERE id=? AND status='done'", m.id),
          'Claude completion',
        );
        return {
          inputId: m.id,
          outputId: out.message.id,
          runId: out.row.run_id,
          provider: 'claude',
        };
      },
    );
    if (values.models) {
      await command('switch codex-live');
      await check(
        'authenticated Codex receives the Claude handoff and replies through Discord',
        async () => {
          const m = await send(
            'Automated acceptance continuation. Read CHECKPOINT.md. Extract the value of HANDOFF_SECRET and reply using Clawstrum send_message with final=true and key=acceptance-codex. The message must be exactly CODEX_OK: followed immediately by that value. Do not perform any other work.',
          );
          const out = await delivered(`CODEX_OK:${runId}`, channel.id, 180000);
          assert.equal(
            store.get('SELECT account_id FROM runs WHERE id=?', out.row.run_id).account_id,
            'codex-live',
          );
          await until(
            () => store.get("SELECT id FROM inbound WHERE id=? AND status='done'", m.id),
            'Codex completion',
          );
          return {
            inputId: m.id,
            outputId: out.message.id,
            runId: out.row.run_id,
            provider: 'codex',
            continuationFrom: 'claude',
          };
        },
      );
    }
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = safe(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  process.removeListener('SIGINT', requestStop);
  process.removeListener('SIGTERM', requestStop);
  if (store) {
    report.runs = store
      .all('SELECT id,status,account_id,error FROM runs ORDER BY started_at')
      .map((r) => ({ ...r, error: r.error ? safe(r.error) : null }));
    report.usage = store
      .all("SELECT content FROM events WHERE type='usage'")
      .map((e) => JSON.parse(e.content));
  }
  try {
    await stop();
    report.cleanup.runtimeStopped = true;
  } catch (error) {
    report.cleanup.runtimeError = safe(error);
    process.exitCode = 1;
  }
  input?.destroy();
  stranger?.destroy();
  if (!values['keep-channel']) {
    try {
      // Recover an ambiguous creation acknowledgement by our unique topic only.
      const targets = channel
        ? [channel]
        : (await rest.get(Routes.guildChannels(values.guild))).filter(
            (c) => c.topic === report.channelTopic && report.channelTopic,
          );
      for (const target of targets) {
        await rest.delete(Routes.channel(target.id));
        await assert.rejects(
          () => rest.get(Routes.channel(target.id)),
          (error) => error.status === 404 && error.code === 10003,
        );
      }
      report.cleanup.channelDeleted = true;
    } catch (error) {
      report.cleanup.channelError = safe(error);
      process.exitCode = 1;
    }
  } else report.cleanup.channelRetained = true;
  delete process.env.CLAWSTRUM_ACCEPTANCE_CLAUDE_TOKEN;
  // Temporary authentication is not retained alongside diagnostic artifacts.
  fs.rmSync(path.join(home, 'codex-live'), { recursive: true, force: true });
  fs.rmSync(path.join(home, 'claude-live'), { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.passed = report.cases.filter((c) => c.status === 'passed').length;
  report.failed = report.cases.filter((c) => c.status === 'failed').length;
  if (process.exitCode) report.status = 'failed';
  persist();
  console.log(
    JSON.stringify(
      {
        status: report.status,
        passed: report.passed,
        failed: report.failed,
        report: reportPath,
        cleanup: report.cleanup,
        error: report.error,
      },
      null,
      2,
    ),
  );
}
