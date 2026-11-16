import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderFailure } from '../src/accounts.js';
import {
  AcpRpcError,
  GEMINI_STEER_NOTE,
  acpFailure,
  acpMcpServers,
  backgroundNote,
  geminiAcpProvider,
  geminiLoginProbe,
  nonSubscriptionAuth,
  permissionOutcome,
  pickModel,
  pickThoughtLevel,
} from '../src/gemini-acp.js';
import { accountEnvironment, providers } from '../src/providers.js';
import { geminiCommand, runtimeCommand } from '../src/runtime.js';
import { accountSchema, registryAccountSchema, validateAccounts } from '../src/account-schema.js';
import { geminiTurnUsage } from '../src/usage.js';
import { testAccount } from '../src/account-test.js';
import { addAccount } from '../src/account-cli.js';
import { saveConfig } from '../src/config.js';
import { researchSchema } from '../src/research/config.js';
import { fixture } from './helpers.js';
import { BASE_PROMPT, mainBasePrompt } from '../src/base-prompt.js';
import type { Account, ProviderEvent, ProviderRequest } from '../src/types.js';

const agent = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/** `settings` is written to agy's settings file, <home>/.gemini/antigravity-cli/settings.json. */
function setup(t: test.TestContext, settings?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-acp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  if (settings) {
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), settings);
  }
  const executable = path.join(dir, 'agy');
  fs.writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${agent}" "$@"\n`, {
    mode: 0o755,
  });
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  const log = path.join(dir, 'agent.log');
  const account: Account = {
    id: 'g',
    provider: 'gemini',
    home,
    executable,
    model: 'gemini-4-argon',
  };
  const events: ProviderEvent[] = [];
  const controller = new AbortController();
  const request = (
    scenario: string,
    extra: Partial<ProviderRequest> = {},
    env: Record<string, string> = {},
  ): ProviderRequest => ({
    account,
    prompt: 'USER PROMPT',
    instructions: 'INSTRUCTIONS BLOCK',
    cwd,
    controller,
    env: { PATH: process.env.PATH ?? '', FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: log, ...env },
    mcp: { command: 'node', args: ['mcp.js'], env: { CLAWSTRUM_SESSION: 's1' } },
    onEvent: (e) => events.push(e),
    ...extra,
  });
  const entries = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  const received = (method: string) =>
    entries()
      .filter((e) => e.received?.method === method)
      .map((e) => e.received);
  return { dir, cwd, home, account, events, controller, request, entries, received, log };
}

test('text streaming: chunks become the final text, with session, ready and usage events', async (t) => {
  const s = setup(t);
  const final = await geminiAcpProvider.run(s.request('text'));
  assert.equal(final, 'Hello world');
  assert.equal(s.events.find((e) => e.type === 'session')?.sessionId, 'sess-new-1');
  assert.ok(s.events.some((e) => e.type === 'ready'));
  const usage = s.events.find((e) => e.type === 'usage')?.usage;
  assert.equal(usage?.source, 'gemini-acp-turn');
  assert.equal(usage?.final, true);
  // 100 prompt tokens include 40 cached; 20 output plus 5 thought tokens.
  assert.deepEqual(usage?.totals, {
    inputTokens: 60,
    outputTokens: 25,
    cacheReadTokens: 40,
    cacheWriteTokens: null,
    totalTokens: 120,
    estimatedCostUsd: null,
  });
  // The agent history records the message.
  assert.ok(
    s.events.some((e) => e.type === 'history' && (e.detail as any).content?.text === 'Hello world'),
  );
});

test('agy is started with acp, the account home as its state dir, and no API key or cloud variable', async (t) => {
  const s = setup(t);
  // Even a variable that reaches the request unfiltered is removed at launch.
  await geminiAcpProvider.run(
    s.request(
      'text',
      {},
      {
        ...accountEnvironment(s.account, [s.account], { GEMINI_API_KEY: 'ambient' }),
        GEMINI_API_KEY: 'late-key',
        GOOGLE_CLOUD_PROJECT: 'some-project',
      },
    ),
  );
  const start = s.entries()[0];
  assert.deepEqual(start.argv.slice(0, 4), [
    'acp',
    '--gemini-dir',
    path.join(s.home, '.gemini'),
    '--disable-telemetry',
  ]);
  assert.ok(start.argv.includes('--dangerously-skip-permissions'));
  assert.ok(!start.argv.includes('--model'));
  assert.equal(start.env.xdg, path.join(s.home, '.config'));
  assert.equal(start.env.key, null);
  assert.equal(start.env.cloud, null);
  const init = s.received('initialize')[0];
  assert.equal(init.params.protocolVersion, 1);
  // The Google sign-in is the only auth method ever requested, and never with an API key.
  const auth = s.received('authenticate');
  assert.deepEqual(
    auth.map((m) => m.params),
    [{ methodId: 'oauth-personal' }],
  );
});

test('a new session passes the clawstrum MCP server, auto mode, Gemini 4 Argon and the instructions in the prompt', async (t) => {
  const s = setup(t);
  await geminiAcpProvider.run(s.request('text'));
  const created = s.received('session/new')[0];
  assert.equal(created.params.cwd, s.cwd);
  assert.deepEqual(created.params.mcpServers, [
    {
      name: 'clawstrum',
      command: 'node',
      args: ['mcp.js'],
      env: [{ name: 'CLAWSTRUM_SESSION', value: 's1' }],
    },
  ]);
  assert.equal(s.received('session/set_mode')[0].params.modeId, 'auto');
  assert.deepEqual(s.received('session/set_config_option')[0].params, {
    sessionId: 'sess-new-1',
    configId: 'model',
    value: 'gemini-4-argon',
  });
  const prompt = s.received('session/prompt')[0].params;
  assert.equal(prompt.sessionId, 'sess-new-1');
  assert.equal(prompt.prompt[0].text, `${BASE_PROMPT}\n\nINSTRUCTIONS BLOCK\n\nUSER PROMPT`);
});

test('a tool call is reported and its permission request is auto-approved with allow-once', async (t) => {
  const s = setup(t);
  const final = await geminiAcpProvider.run(s.request('tool'));
  // The result is the text after the last tool call, not the text before it.
  assert.equal(final, 'Done: outcome=selected:proceed_once');
  const tools = s.events.filter((e) => e.type === 'activity' && e.tool);
  assert.deepEqual(
    tools.map((e) => [e.tool!.id, e.tool!.state, e.tool!.name]),
    [
      ['t1', 'started', 'execute'],
      ['t1', 'completed', 'execute'],
    ],
  );
  assert.ok(
    s.events.some((e) => e.type === 'history' && (e.detail as any).id === 'gemini:sess-new-1:t1'),
  );
});

test('a text-only call: plan mode, no MCP server, no auto-approve flag, permission rejected', async (t) => {
  const s = setup(t);
  const final = await geminiAcpProvider.run(s.request('tool', { toolless: true }));
  assert.equal(final, 'Done: outcome=selected:cancel');
  assert.deepEqual(s.received('session/new')[0].params.mcpServers, []);
  assert.equal(s.received('session/set_mode')[0].params.modeId, 'plan');
  assert.ok(!s.entries()[0].argv.includes('--dangerously-skip-permissions'));
});

test('client file methods read and write text files when the agent calls them', async (t) => {
  const s = setup(t);
  const file = path.join(s.dir, 'agent-file.txt');
  const final = await geminiAcpProvider.run(s.request('fs', {}, { FAKE_ACP_FILE: file }));
  assert.equal(final, 'fs ok');
  assert.equal(fs.readFileSync(file, 'utf8'), 'from agent\nline2\nline3');
  const entry = s.entries().find((e) => e.fsRead);
  assert.deepEqual(entry.fsRead, { content: 'line2' });
  // Not offered by default: the agent uses its own file access.
  assert.deepEqual(s.received('initialize')[0].params.clientCapabilities.fs, {
    readTextFile: false,
    writeTextFile: false,
  });
});

test('abort sends session/cancel and rejects with the abort reason', async (t) => {
  const s = setup(t);
  const reason = new ProviderFailure('fatal', 'stopped by test');
  const run = geminiAcpProvider.run(
    s.request('cancel', {
      onEvent: (e) => {
        s.events.push(e);
        if (e.type === 'partial') s.controller.abort(reason);
      },
    }),
  );
  await assert.rejects(run, (error) => error === reason);
  assert.equal(s.received('session/cancel')[0].params.sessionId, 'sess-new-1');
});

test('an agent that ignores session/cancel is dropped after a short grace period', async (t) => {
  const s = setup(t);
  const reason = new Error('stopped by test');
  const run = geminiAcpProvider.run(
    s.request('hang', {
      onEvent: (e) => {
        if (e.type === 'ready') setTimeout(() => s.controller.abort(reason), 100);
      },
    }),
  );
  await assert.rejects(run, (error) => error === reason);
  assert.equal(s.received('session/cancel').length, 1);
});

test('errors map to the failure kinds the engine routes on', async (t) => {
  const kinds: Array<[string, string]> = [
    ['quota', 'quota'],
    ['overloaded', 'transient'],
    ['refusal', 'fatal'],
    ['max_tokens', 'context'],
    ['max_turn_requests', 'budget'],
    ['authfail', 'auth'],
    ['crash', 'transient'],
  ];
  for (const [scenario, kind] of kinds) {
    const s = setup(t);
    await assert.rejects(geminiAcpProvider.run(s.request(scenario)), (error) => {
      assert.ok(error instanceof ProviderFailure, scenario);
      assert.equal((error as ProviderFailure).kind, kind, scenario);
      return true;
    });
  }
});

test('the refusal message names the stop reason', async (t) => {
  const s = setup(t);
  await assert.rejects(geminiAcpProvider.run(s.request('refusal')), /stopReason refusal/);
});

test('without a Google login the run fails as an auth error that names the login command', async (t) => {
  const s = setup(t);
  await assert.rejects(geminiAcpProvider.run(s.request('nologin')), (error) => {
    assert.equal((error as ProviderFailure).kind, 'auth');
    assert.match((error as Error).message, /agy acp --login/);
    return true;
  });
});

test('an account that names an API key is refused before agy starts', async (t) => {
  const s = setup(t);
  const keyed = { ...s.account, tokenEnv: 'GEM_KEY' };
  assert.throws(
    () => accountEnvironment(keyed, [keyed], { GEM_KEY: 'k-123', PATH: process.env.PATH }),
    /never used/,
  );
  await assert.rejects(geminiAcpProvider.run(s.request('text', { account: keyed })), (error) => {
    assert.equal((error as ProviderFailure).kind, 'auth');
    return true;
  });
  assert.deepEqual(s.entries(), []);
});

test('state that selects an API key, cloud or enterprise auth is refused before agy starts', async (t) => {
  for (const mode of ['gemini-api-key', 'agent-platform', 'oauth-business']) {
    const s = setup(t, JSON.stringify({ security: { auth: { selectedType: mode } } }));
    await assert.rejects(geminiAcpProvider.run(s.request('text')), (error) => {
      assert.equal((error as ProviderFailure).kind, 'auth', mode);
      assert.match((error as Error).message, new RegExp(mode));
      return true;
    });
    assert.deepEqual(s.entries(), [], mode);
  }
  // The old Gemini CLI's settings file in the same home is not agy's and is ignored.
  const old = setup(t);
  fs.writeFileSync(
    path.join(old.home, '.gemini', 'settings.json'),
    JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }),
  );
  await geminiAcpProvider.run(old.request('text'));
  // The Google sign-in is accepted.
  assert.equal(nonSubscriptionAuth('{"selectedType":"oauth-personal"}'), undefined);
});

test("an auth mode other than the Google login in agy's own log stops the run before the prompt", async (t) => {
  const s = setup(t);
  await assert.rejects(geminiAcpProvider.run(s.request('apikeymode')), (error) => {
    assert.equal((error as ProviderFailure).kind, 'auth');
    assert.match((error as Error).message, /AUTH_MODE_GEMINI_API_KEY/);
    return true;
  });
  assert.equal(s.received('session/prompt').length, 0);
  assert.equal(nonSubscriptionAuth('Auth mode is AUTH_MODE_PERSONAL_CONSUMER'), undefined);
  assert.equal(nonSubscriptionAuth('Auth mode is unspecified'), undefined);
});

test('a model agy does not offer fails loudly instead of running on another model', async (t) => {
  const s = setup(t);
  await assert.rejects(geminiAcpProvider.run(s.request('nomodel')), (error) => {
    assert.equal((error as ProviderFailure).kind, 'fatal');
    assert.match((error as Error).message, /gemini-4-argon.*gemini-3\.5-flash/);
    return true;
  });
  assert.equal(s.received('session/prompt').length, 0);
});

test('pickModel matches a value or name, then a unique prefix, and skips the current model', () => {
  const created = {
    configOptions: [
      {
        id: 'model',
        category: 'model',
        currentValue: 'gemini-4-argon-high',
        options: [
          { value: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
          { value: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
        ],
      },
    ],
  };
  assert.deepEqual(pickModel(created, 'gemini-4-argon').select, {});
  assert.deepEqual(pickModel(created, 'Gemini 3.5 Flash').select?.params, {
    configId: 'model',
    value: 'gemini-3.5-flash',
  });
  assert.equal(pickModel(created, 'gemini-5').select, undefined);
  const old = pickModel(
    { models: { currentModelId: 'a', availableModels: [{ modelId: 'b' }] } },
    'b',
  );
  assert.deepEqual(old.select, { method: 'session/set_model', params: { modelId: 'b' } });
});

test('login probe: a session request tells logged in from not logged in, with no model call', async (t) => {
  const s = setup(t);
  const env = { PATH: process.env.PATH ?? '', FAKE_ACP_LOG: s.log };
  assert.deepEqual(await geminiLoginProbe(s.account, { ...env, FAKE_ACP_SCENARIO: 'text' }), {
    ok: true,
    detail: 'Google sign-in available',
  });
  assert.equal(
    (await geminiLoginProbe(s.account, { ...env, FAKE_ACP_SCENARIO: 'authfail' })).detail,
    'not logged in',
  );
  assert.equal(
    (await geminiLoginProbe(s.account, { ...env, FAKE_ACP_SCENARIO: 'apikeymode' })).ok,
    false,
  );
  assert.equal(s.received('session/prompt').length, 0);
});

test('resume uses session/resume when agy offers it: no replay, no instructions again', async (t) => {
  const s = setup(t);
  const final = await geminiAcpProvider.run(s.request('resume', { sessionId: 'old-session' }));
  assert.equal(final, 'Hello world');
  assert.equal(s.received('session/resume')[0].params.sessionId, 'old-session');
  assert.equal(s.received('session/load').length, 0);
  assert.equal(s.received('session/new').length, 0);
  assert.equal(s.received('session/prompt')[0].params.prompt[0].text, 'USER PROMPT');
});

test('without session/resume, session/load is used, its replayed history is dropped, and no instructions are sent again', async (t) => {
  const s = setup(t);
  const final = await geminiAcpProvider.run(s.request('load', { sessionId: 'old-session' }));
  assert.equal(final, 'Hello world');
  assert.equal(s.received('session/load')[0].params.sessionId, 'old-session');
  assert.equal(s.received('session/new').length, 0);
  assert.equal(s.received('session/prompt')[0].params.prompt[0].text, 'USER PROMPT');
  assert.equal(s.events.find((e) => e.type === 'session')?.sessionId, 'old-session');
});

test('a session the CLI no longer has is reported as a session failure so a fresh one is started', async (t) => {
  const s = setup(t);
  await assert.rejects(
    geminiAcpProvider.run(s.request('loadfail', { sessionId: 'gone' })),
    (error) => {
      assert.equal((error as ProviderFailure).kind, 'session');
      return true;
    },
  );
});

test('an agent without loadSession or resume starts a fresh session with the instructions', async (t) => {
  const s = setup(t);
  await geminiAcpProvider.run(s.request('noload', { sessionId: 'old-session' }));
  assert.equal(s.received('session/load').length, 0);
  assert.equal(s.received('session/new').length, 1);
  assert.equal(
    s.received('session/prompt')[0].params.prompt[0].text,
    `${BASE_PROMPT}\n\nINSTRUCTIONS BLOCK\n\nUSER PROMPT`,
  );
});

test('the base prompt leads only a fresh lead session: not a subagent, not a resumed session', async (t) => {
  const lead = setup(t);
  await geminiAcpProvider.run(lead.request('text'));
  const first = lead.received('session/prompt')[0].params.prompt[0].text;
  assert.ok(first.startsWith(`${BASE_PROMPT}\n\nINSTRUCTIONS BLOCK`));
  const subagent = setup(t);
  await geminiAcpProvider.run(subagent.request('text', { subagent: true }));
  const delegated = subagent.received('session/prompt')[0].params.prompt[0].text;
  assert.ok(delegated.startsWith('INSTRUCTIONS BLOCK'));
  assert.equal(delegated.includes(BASE_PROMPT), false);
  const resumed = setup(t);
  await geminiAcpProvider.run(resumed.request('resume', { sessionId: 'old-session' }));
  const next = resumed.received('session/prompt')[0].params.prompt[0].text;
  assert.equal(next.includes(BASE_PROMPT), false);
});

test('a main-channel lead session leads with the main base prompt; a subagent gets none', async (t) => {
  const lead = setup(t);
  await geminiAcpProvider.run(lead.request('text', { mainChannel: true }));
  assert.equal(
    lead.received('session/prompt')[0].params.prompt[0].text,
    `${mainBasePrompt()}\n\nINSTRUCTIONS BLOCK\n\nUSER PROMPT`,
  );
  const subagent = setup(t);
  await geminiAcpProvider.run(subagent.request('text', { subagent: true, mainChannel: true }));
  const delegated = subagent.received('session/prompt')[0].params.prompt[0].text;
  assert.ok(delegated.startsWith('INSTRUCTIONS BLOCK'));
  assert.equal(delegated.includes('You look after this Clawstrum installation'), false);
});

test('the completed-tool budget cancels the turn and fails as budget', async (t) => {
  const s = setup(t);
  await assert.rejects(geminiAcpProvider.run(s.request('toolbudget', { maxTurns: 2 })), (error) => {
    assert.equal((error as ProviderFailure).kind, 'budget');
    return true;
  });
  assert.equal(s.received('session/cancel').length, 1);
});

test('acpFailure maps status codes and messages', () => {
  const kind = (code: number, message: string) => acpFailure(new AcpRpcError(code, message)).kind;
  assert.equal(kind(429, 'x'), 'quota');
  assert.equal(kind(401, 'x'), 'auth');
  assert.equal(kind(403, 'x'), 'auth');
  assert.equal(kind(500, 'x'), 'transient');
  assert.equal(kind(-32000, 'Gemini API key is missing or not configured.'), 'auth');
  assert.equal(kind(-32000, 'Authentication required.'), 'auth');
  assert.equal(kind(-32602, 'Session not found: abc'), 'session');
  assert.equal(kind(400, 'Invalid request'), 'fatal');
});

test('permissionOutcome picks allow-once, falls back, and cancels an unusable list', () => {
  const opts = [
    { optionId: 'a', kind: 'allow_always' },
    { optionId: 'b', kind: 'allow_once' },
    { optionId: 'c', kind: 'reject_once' },
  ];
  assert.deepEqual(permissionOutcome(opts, true), {
    outcome: { outcome: 'selected', optionId: 'b' },
  });
  assert.deepEqual(permissionOutcome([opts[0]!, opts[2]!], true), {
    outcome: { outcome: 'selected', optionId: 'a' },
  });
  assert.deepEqual(permissionOutcome(opts, false), {
    outcome: { outcome: 'selected', optionId: 'c' },
  });
  assert.deepEqual(permissionOutcome([opts[1]!], false), { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(permissionOutcome(undefined, true), { outcome: { outcome: 'cancelled' } });
});

test('geminiTurnUsage counts cached tokens once and adds thought tokens to output', () => {
  const snapshot = geminiTurnUsage({
    usage: { inputTokens: 10, outputTokens: 4, thoughtTokens: 1 },
  });
  assert.equal(snapshot.totals.inputTokens, 10);
  assert.equal(snapshot.totals.outputTokens, 5);
  assert.equal(snapshot.totals.totalTokens, 15);
  assert.equal(geminiTurnUsage({}).totals.totalTokens, null);
});

test('account schema accepts provider gemini; a stored token and an API key (tokenEnv) are refused', () => {
  const base = { id: 'g', provider: 'gemini', home: 'accounts/g/gemini', model: 'gemini-x' };
  assert.equal(accountSchema.parse(base).provider, 'gemini');
  const issues: string[] = [];
  const check = (a: any) => validateAccounts([a], { addIssue: (i) => issues.push(i.message) }, []);
  check({ ...accountSchema.parse(base), token: 'abc' });
  assert.match(issues.join('\n'), /Google sign-in\) login with a dedicated home/);
  issues.length = 0;
  check(accountSchema.parse({ ...base, tokenEnv: 'GEM_KEY' }));
  assert.match(issues.join('\n'), /Google sign-in only; an API key is never used/);
  issues.length = 0;
  // Codex still refuses tokenEnv.
  check(accountSchema.parse({ id: 'c', provider: 'codex', home: 'h', tokenEnv: 'X' }));
  assert.match(issues.join('\n'), /Codex login/);
  assert.equal(registryAccountSchema.safeParse({ ...base, token: 'abc' }).success, true);
});

test('accountEnvironment strips ambient Gemini, Google cloud and gateway variables for a Gemini account', () => {
  const account: Account = { id: 'g', provider: 'gemini', home: '/h/g' };
  const env = accountEnvironment(account, [account], {
    PATH: '/bin',
    GEMINI_API_KEY: 'ambient',
    GOOGLE_API_KEY: 'ambient2',
    GOOGLE_CLOUD_PROJECT: 'proj',
    GOOGLE_APPLICATION_CREDENTIALS: '/adc.json',
    AGY_LLM_GATEWAY_URL: 'https://gateway',
    GEMINI_MODEL: 'ambient-model',
    CODEX_HOME: '/codex',
  });
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GOOGLE_CLOUD_PROJECT, undefined);
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(env.AGY_LLM_GATEWAY_URL, undefined);
  assert.equal(env.GOOGLE_API_KEY, undefined);
  assert.equal(env.GEMINI_MODEL, undefined);
  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.PATH, '/bin');
  assert.throws(
    () => accountEnvironment({ ...account, tokenEnv: 'NOPE' }, [account], {}),
    /never used/,
  );
});

test('the gemini provider is registered, and agy is found under tools/ (highest version) or by override', () => {
  assert.equal(providers.gemini, geminiAcpProvider);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-root-'));
  try {
    assert.equal(geminiCommand(root), 'agy');
    for (const version of ['1.5.9', '1.5.10']) {
      const dir = path.join(root, 'tools', `antigravity-cli-${version}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'agy'), '');
    }
    assert.equal(geminiCommand(root), path.join(root, 'tools', 'antigravity-cli-1.5.10', 'agy'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(
    runtimeCommand({ id: 'g', provider: 'gemini', home: 'h', executable: '/x/agy' }),
    {
      command: '/x/agy',
      args: [],
    },
  );
});

test('account test runs a Gemini account through the ACP provider on the chosen model and reports the CLI version', async (t) => {
  const f = fixture(t);
  const s = setup(t);
  const result = await testAccount(f.config, s.account, {
    model: 'gemini-3.5-flash',
    providers: { claude: providers.claude, codex: providers.codex, gemini: geminiAcpProvider },
    source: { PATH: process.env.PATH, FAKE_ACP_SCENARIO: 'text', FAKE_ACP_LOG: s.log },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.reply, 'Hello world');
  assert.equal(result.cliVersion, '0.0.1');
  assert.equal(result.model, 'gemini-3.5-flash');
  // Already the current model in the fake agent, so nothing is switched.
  assert.equal(s.received('session/set_config_option').length, 0);
  assert.equal(s.received('authenticate')[0].params.methodId, 'oauth-personal');
});

test('account add accepts gemini and points to the login command', (t) => {
  const f = fixture(t);
  saveConfig(f.home, JSON.parse(JSON.stringify({ ...f.config })));
  const message = addAccount(f.home, 'gem', 'gemini', { model: 'gemini-x' });
  assert.match(message, /clawstrum account login gem/);
  const saved = JSON.parse(fs.readFileSync(path.join(f.home, 'config.json'), 'utf8'));
  assert.deepEqual(
    saved.accounts.find((a: any) => a.id === 'gem'),
    {
      id: 'gem',
      provider: 'gemini',
      home: 'accounts/gem/gemini',
      model: 'gemini-x',
      quotaBuckets: [],
      modelFallbacks: [],
      maxConcurrent: 4,
    },
  );
});

test('pickThoughtLevel maps effort onto the thinking levels agy offers', () => {
  const offered = (values: string[], currentValue = 'medium') => [
    { id: 'model', category: 'model', currentValue: 'm', options: [{ value: 'm' }] },
    {
      id: 'thought_level',
      category: 'thought_level',
      currentValue,
      options: values.map((value) => ({ value, name: value })),
    },
  ];
  const standard = offered(['low', 'medium', 'high']);
  assert.equal(pickThoughtLevel(standard, undefined), undefined);
  assert.equal(pickThoughtLevel(undefined, 'high'), undefined);
  assert.equal(pickThoughtLevel([standard[0]], 'high'), undefined);
  assert.equal(pickThoughtLevel(standard, 'medium'), undefined);
  assert.deepEqual(pickThoughtLevel(standard, 'low'), { configId: 'thought_level', value: 'low' });
  assert.deepEqual(pickThoughtLevel(standard, 'high'), {
    configId: 'thought_level',
    value: 'high',
  });
  assert.deepEqual(pickThoughtLevel(standard, 'xhigh'), {
    configId: 'thought_level',
    value: 'high',
  });
  assert.deepEqual(pickThoughtLevel(standard, 'max'), { configId: 'thought_level', value: 'high' });
  assert.deepEqual(pickThoughtLevel(offered(['low', 'medium', 'ultra']), 'max'), {
    configId: 'thought_level',
    value: 'ultra',
  });
  assert.equal(pickThoughtLevel(offered(['medium', 'high'], 'high'), 'low'), undefined);
  const grouped = [
    {
      id: 'thought_level',
      category: 'thought_level',
      currentValue: 'medium',
      options: [
        { options: [{ value: 'low' }, { value: 'medium' }] },
        { options: [{ value: 'high' }] },
      ],
    },
  ];
  assert.deepEqual(pickThoughtLevel(grouped, 'max'), { configId: 'thought_level', value: 'high' });
});

test("acpMcpServers lists the owner's servers before clawstrum, with env as name/value pairs", () => {
  const mcp = { command: 'node', args: ['mcp.js'], env: { CLAWSTRUM_SESSION: 's1' } };
  const extra = {
    notes: { command: 'notes-mcp', args: ['--stdio'], env: { NOTES_DIR: '/n', MODE: 'ro' } },
  };
  assert.deepEqual(acpMcpServers(mcp, false, extra), [
    {
      name: 'notes',
      command: 'notes-mcp',
      args: ['--stdio'],
      env: [
        { name: 'NOTES_DIR', value: '/n' },
        { name: 'MODE', value: 'ro' },
      ],
    },
    {
      name: 'clawstrum',
      command: 'node',
      args: ['mcp.js'],
      env: [{ name: 'CLAWSTRUM_SESSION', value: 's1' }],
    },
  ]);
  assert.deepEqual(acpMcpServers(mcp, true, extra), []);
});

test('with the system-prompt append capability, the base prompt and instructions go to session/new, not the prompt', async (t) => {
  const append = { FAKE_ACP_APPEND: '1' };
  const lead = setup(t);
  await geminiAcpProvider.run(lead.request('text', {}, append));
  assert.deepEqual(lead.received('session/new')[0].params._meta, {
    antigravity: { systemPrompt: { append: `${BASE_PROMPT}\n\nINSTRUCTIONS BLOCK` } },
  });
  assert.equal(lead.received('session/prompt')[0].params.prompt[0].text, 'USER PROMPT');
  const subagent = setup(t);
  await geminiAcpProvider.run(subagent.request('text', { subagent: true }, append));
  assert.equal(
    subagent.received('session/new')[0].params._meta.antigravity.systemPrompt.append,
    'INSTRUCTIONS BLOCK',
  );
  assert.equal(subagent.received('session/prompt')[0].params.prompt[0].text, 'USER PROMPT');
  const plain = setup(t);
  await geminiAcpProvider.run(plain.request('text'));
  assert.equal(plain.received('session/new')[0].params._meta, undefined);
});

test('account effort high sets the thinking level; medium or no effort leaves it', async (t) => {
  const thought = (s: ReturnType<typeof setup>) =>
    s
      .received('session/set_config_option')
      .filter((m) => m.params.configId === 'thought_level')
      .map((m) => m.params);
  const high = setup(t);
  await geminiAcpProvider.run(
    high.request('text', { account: { ...high.account, effort: 'high' } }),
  );
  assert.deepEqual(thought(high), [
    { sessionId: 'sess-new-1', configId: 'thought_level', value: 'high' },
  ]);
  const medium = setup(t);
  await geminiAcpProvider.run(
    medium.request('text', { account: { ...medium.account, effort: 'medium' } }),
  );
  assert.deepEqual(thought(medium), []);
  const none = setup(t);
  await geminiAcpProvider.run(none.request('text'));
  assert.deepEqual(thought(none), []);
});

/** Runs a steer scenario, injecting ['m1'] once the first turn's tool call has started. */
async function steer(s: ReturnType<typeof setup>, scenario: string) {
  let inject: ((ids: string[], text: string) => boolean) | undefined;
  let accepted: boolean | undefined;
  const final = await geminiAcpProvider.run(
    s.request(scenario, {
      attachInjector: (i) => {
        inject = i;
      },
      onEvent: (e) => {
        s.events.push(e);
        if (accepted === undefined && e.type === 'activity' && e.tool?.state === 'started')
          accepted = inject!(['m1'], 'new message');
      },
    }),
  );
  return { final, accepted };
}

test('live input sends a second prompt; the answer comes from the new turn', async (t) => {
  const s = setup(t);
  const { final, accepted } = await steer(s, 'steer');
  assert.equal(accepted, true);
  assert.equal(final, 'Steered answer');
  assert.ok(!final.includes('tail of the cut turn'));
  assert.ok(
    s.events.some(
      (e) =>
        e.type === 'injected' &&
        JSON.stringify(e.detail) === JSON.stringify({ ids: ['m1'], ok: true }),
    ),
  );
  assert.ok(s.events.some((e) => e.type === 'input_started'));
  const prompts = s.received('session/prompt');
  assert.equal(prompts.length, 2);
  const second = prompts[1].params.prompt[0].text;
  assert.ok(second.includes(GEMINI_STEER_NOTE));
  assert.ok(second.includes('new message'));
  // Both prompts returned the fixture's usage, so each field is doubled.
  assert.deepEqual(s.events.find((e) => e.type === 'usage')?.detail, {
    inputTokens: 200,
    outputTokens: 40,
    cachedReadTokens: 80,
    thoughtTokens: 10,
    totalTokens: 240,
  });
});

test('live input agy refuses is reported as not taken, and the running turn gives the answer', async (t) => {
  const s = setup(t);
  const { final, accepted } = await steer(s, 'steer_refused');
  assert.equal(accepted, true);
  assert.equal(final, 'First answer');
  assert.ok(
    s.events.some(
      (e) =>
        e.type === 'injected' &&
        JSON.stringify(e.detail) === JSON.stringify({ ids: ['m1'], ok: false }),
    ),
  );
  assert.ok(!s.events.some((e) => e.type === 'input_started'));
});

test('a turn that ends with a shell command still running gets one follow-up prompt', async (t) => {
  const research = researchSchema.parse({ enabled: true, holdBackgroundTasks: true });
  const s = setup(t);
  const final = await geminiAcpProvider.run(s.request('background', { research }));
  assert.equal(final, 'It printed done.');
  const prompts = s.received('session/prompt');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].params.prompt[0].text, backgroundNote(['sleep 99; echo done']));
  const early = s.events.findIndex(
    (e) =>
      e.type === 'result_text' &&
      JSON.stringify(e.detail) ===
        JSON.stringify({
          text: 'It runs in the background, I will report when it finishes.',
          final: false,
        }),
  );
  assert.ok(early >= 0);
  assert.ok(early < s.events.findIndex((e) => e.type === 'partial' && e.detail === final));
  assert.deepEqual(s.events.find((e) => e.type === 'usage')?.detail, {
    inputTokens: 200,
    outputTokens: 40,
    cachedReadTokens: 80,
    thoughtTokens: 10,
    totalTokens: 240,
  });

  const silent = setup(t);
  const quiet = await geminiAcpProvider.run(
    silent.request('background', { research }, { FAKE_ACP_SILENT: '1' }),
  );
  assert.equal(quiet, 'It runs in the background, I will report when it finishes.');
  assert.ok(!silent.events.some((e) => e.type === 'result_text'));
});

test('no follow-up prompt without holdBackgroundTasks, with research disabled, or toolless', async (t) => {
  const cases: Array<[string, Partial<ProviderRequest>]> = [
    ['hold off', { research: researchSchema.parse({ enabled: true, holdBackgroundTasks: false }) }],
    [
      'research disabled',
      { research: researchSchema.parse({ enabled: false, holdBackgroundTasks: true }) },
    ],
    [
      'toolless',
      {
        research: researchSchema.parse({ enabled: true, holdBackgroundTasks: true }),
        toolless: true,
      },
    ],
  ];
  for (const [label, extra] of cases) {
    const s = setup(t);
    await geminiAcpProvider.run(s.request('background', extra));
    assert.equal(s.received('session/prompt').length, 1, label);
  }
});
