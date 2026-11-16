import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, settle } from './helpers.js';
import { accountsReloader, readConfig, saveConfig, type Config } from '../src/config.js';
import {
  accountToken,
  loadAccountRegistry,
  readRegistry,
  registryPath,
  rulesPath,
  setAccountTokens,
  writeRegistry,
} from '../src/account-registry.js';
import { accountEnvironment } from '../src/providers.js';
import { accountsSection } from '../src/account-context.js';
import { applyAccountReload } from '../src/account-reload.js';
import { Engine } from '../src/engine.js';
import { AccountPool } from '../src/accounts.js';
import { main } from '../src/cli-main.js';
import { collectDashboardData, renderDashboardPosts } from '../src/dashboard.js';
import { sessionStatus, parseCommand } from '../src/discord.js';
import { loginRefusal } from '../src/account-test.js';
import type { Provider, ProviderRequest } from '../src/types.js';

const FAKE = 'sk-ant-oat01-FAKETOKENDONOTUSE0123456789';
const FAKE2 = 'sk-ant-oat01-SECONDFAKETOKEN9876543210';

type F = ReturnType<typeof fixture>;

/** A state directory with config.json (accounts a and b, as the fixture) and optional env. */
function state(t: any) {
  const f = fixture(t);
  f.config.accounts = [
    {
      id: 'a',
      provider: 'claude',
      home: path.join(f.home, 'a'),
      model: 'base',
      tokenEnv: 'TEST_REG_TOKEN_A',
      maxConcurrent: 4,
      quotaBuckets: [],
      modelFallbacks: [],
    },
    {
      id: 'b',
      provider: 'codex',
      home: path.join(f.home, 'b'),
      maxConcurrent: 4,
      quotaBuckets: [],
      modelFallbacks: [],
    },
  ] as Config['accounts'];
  saveConfig(f.home, JSON.parse(JSON.stringify(f.config)));
  const saved = process.env.CLAWSTRUM_HOME;
  process.env.CLAWSTRUM_HOME = f.home;
  process.env.TEST_REG_TOKEN_A = FAKE2;
  t.after(() => {
    if (saved === undefined) delete process.env.CLAWSTRUM_HOME;
    else process.env.CLAWSTRUM_HOME = saved;
    delete process.env.TEST_REG_TOKEN_A;
    setAccountTokens(new Map());
  });
  return f;
}
const registryAccounts = (f: F, extra: Record<string, unknown>[] = []) => [
  {
    id: 'a',
    owner: 'Alice',
    label: 'Primary Claude',
    notes: 'first choice',
    provider: 'claude',
    home: path.join(f.home, 'a'),
    priority: 100,
    model: 'base',
    token: FAKE,
  },
  { id: 'b', owner: 'Alice', provider: 'codex', home: path.join(f.home, 'b') },
  ...extra,
];
function writeRaw(f: F, accounts: unknown, mode = 0o600) {
  const file = registryPath(f.home);
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts }, null, 2), { mode });
  fs.chmodSync(file, mode);
  // A distinct modification time for each write, as a later edit would have.
  const at = new Date(Date.now() + ++touched * 1000);
  fs.utimesSync(file, at, at);
}
let touched = 0;
async function capture(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines.join('\n');
}

test('without accounts.json the accounts come from config.json, as before', (t) => {
  const f = state(t);
  const config = readConfig(f.home);
  assert.deepEqual(
    config.accounts.map((a) => a.id),
    ['a', 'b'],
  );
  assert.equal(config.accounts[0]!.tokenEnv, 'TEST_REG_TOKEN_A');
  assert.equal(accountToken('a'), undefined);
  const env = accountEnvironment(config.accounts[0]!, config.accounts, {
    TEST_REG_TOKEN_A: 'from-env',
  });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'from-env');
});

test('accounts.json replaces config.json accounts; its token never sits on the account objects', (t) => {
  const f = state(t);
  writeRaw(f, registryAccounts(f));
  const config = readConfig(f.home);
  assert.deepEqual(
    config.accounts.map((a) => [a.id, a.owner, a.label, a.priority]),
    [
      ['a', 'Alice', 'Primary Claude', 100],
      ['b', 'Alice', undefined, undefined],
    ],
  );
  assert.equal(config.accounts[0]!.tokenEnv, undefined, 'config.json tokenEnv is ignored');
  assert.equal(accountToken('a'), FAKE);
  assert.ok(!JSON.stringify(config).includes(FAKE), 'config object holds no token');
  assert.ok(!JSON.stringify(loadAccountRegistry(f.home)!.accounts).includes(FAKE));
});

test('a stored token is passed as CLAUDE_CODE_OAUTH_TOKEN, like tokenEnv, and replaces ambient values', (t) => {
  const f = state(t);
  writeRaw(f, registryAccounts(f));
  const config = readConfig(f.home);
  const env = accountEnvironment(config.accounts[0]!, config.accounts, {
    CLAUDE_CODE_OAUTH_TOKEN: 'ambient',
    ANTHROPIC_API_KEY: 'ambient-key',
    HOME: '/h',
  });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, FAKE);
  assert.equal(env.CLAUDE_CONFIG_DIR, config.accounts[0]!.home);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  const codex = accountEnvironment(config.accounts[1]!, config.accounts, {});
  assert.equal(codex.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('the registry is refused when group or others can read it, without echoing its content', (t) => {
  const f = state(t);
  writeRaw(f, registryAccounts(f), 0o640);
  assert.throws(
    () => readConfig(f.home),
    (error: Error) => /chmod 600/.test(error.message) && !error.message.includes(FAKE),
  );
  fs.chmodSync(registryPath(f.home), 0o604);
  assert.throws(() => readRegistry(f.home), /group or others/);
  fs.chmodSync(registryPath(f.home), 0o600);
  assert.equal(readRegistry(f.home)!.length, 2);
});

test('invalid registries fail with a clear error that never quotes the token', (t) => {
  const f = state(t);
  const file = registryPath(f.home);
  const fail = (write: () => void, pattern: RegExp) => {
    write();
    fs.chmodSync(file, 0o600);
    assert.throws(
      () => readRegistry(f.home),
      (error: Error) => pattern.test(error.message) && !error.message.includes('FAKETOKEN'),
    );
  };
  fail(
    () => fs.writeFileSync(file, `{"version":1,"accounts":[{"token":"${FAKE}",,]}`),
    /not valid JSON/,
  );
  fail(
    () => writeRaw(f, [{ ...registryAccounts(f)[0]!, id: 'b' }, registryAccounts(f)[1]!]),
    /unique/,
  );
  fail(
    () =>
      writeRaw(f, [{ ...registryAccounts(f)[0]!, tokenEnv: 'X_TOKEN' }, registryAccounts(f)[1]!]),
    /either token or tokenEnv/,
  );
  fail(
    () => writeRaw(f, [registryAccounts(f)[0]!, { ...registryAccounts(f)[1]!, token: FAKE }]),
    /only for Claude/,
  );
  fail(
    () =>
      writeRaw(f, [
        {
          ...registryAccounts(f)[0]!,
          home: path.join(f.home, 'b'),
          provider: 'codex',
          token: undefined,
        },
        registryAccounts(f)[1]!,
      ]),
    /distinct provider home/,
  );
  fail(() => writeRaw(f, [{ ...registryAccounts(f)[0]!, bogus: 1 }]), /bogus|Unrecognized/);
});

test('the token appears in no output the harness produces: list, status, dashboard, context, errors, login refusal', async (t) => {
  const f = state(t);
  writeRaw(f, registryAccounts(f));
  fs.writeFileSync(
    rulesPath(f.home),
    `Use a first, then b.\nOops pasted ${FAKE} and ${FAKE2} here.\n`,
    { mode: 0o600 },
  );
  const config = readConfig(f.home);
  const seen: string[] = [];
  seen.push(await capture(() => main(['account', 'list'])));
  seen.push(await capture(() => main(['status'])));
  seen.push(sessionStatus(f.store, f.session.id));
  const section = accountsSection(f.home, config.accounts, () => undefined, {
    TEST_REG_TOKEN_A: FAKE2,
  });
  seen.push(section);
  const posts = renderDashboardPosts(collectDashboardData(f.home, config));
  seen.push(...posts.map((p) => `${p.title}\n${p.summary}\n${p.body}`));
  seen.push(JSON.stringify(config), JSON.stringify(process.env.CLAWSTRUM_HOME));
  seen.push(loginRefusal(config.accounts[0]!, false) ?? '');
  const text = seen.join('\n');
  for (const secret of [FAKE, FAKE2, 'FAKETOKEN', 'SECONDFAKE'])
    assert.ok(!text.includes(secret), `output contains ${secret}`);
  assert.match(text, /token in accounts\.json/);
  assert.match(section, /Use a first, then b\./);
  assert.match(section, /\[redacted\]/);
  const accounts = posts.find((p) => p.key === 'accounts')!;
  assert.match(accounts.body, /Account list source: accounts\.json/);
  assert.match(accounts.body, /a: owner=Alice; label=Primary Claude/);
  assert.match(loginRefusal(config.accounts[0]!, false)!, /token stored in accounts\.json/);
});

test('account list says how each account is authenticated, never the value', async (t) => {
  const f = state(t);
  // No registry: tokenEnv set in the environment, and a profile-login account.
  let rows = JSON.parse(await capture(() => main(['account', 'list'])));
  assert.deepEqual(
    rows.map((r: any) => [r.id, r.credential, r.source]),
    [
      ['a', 'env TEST_REG_TOKEN_A (set)', 'config.json'],
      ['b', `profile login at ${path.join(f.home, 'b')}`, 'config.json'],
    ],
  );
  delete process.env.TEST_REG_TOKEN_A;
  rows = JSON.parse(await capture(() => main(['account', 'list'])));
  assert.equal(rows[0].credential, 'env TEST_REG_TOKEN_A (missing)');
  writeRaw(f, registryAccounts(f));
  rows = JSON.parse(await capture(() => main(['account', 'list'])));
  assert.deepEqual(
    rows.map((r: any) => [r.id, r.credential, r.source, r.owner]),
    [
      ['a', 'token in accounts.json', 'accounts.json', 'Alice'],
      ['b', `profile login at ${path.join(f.home, 'b')}`, 'accounts.json', 'Alice'],
    ],
  );
});

test('account import keeps tokenEnv references by default and seeds ACCOUNTS.md', async (t) => {
  const f = state(t);
  const out = await capture(() => main(['account', 'import']));
  const stored = readRegistry(f.home)!;
  assert.equal(stored[0]!.tokenEnv, 'TEST_REG_TOKEN_A');
  assert.equal(stored[0]!.token, undefined);
  assert.equal(fs.statSync(registryPath(f.home)).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(rulesPath(f.home)));
  assert.match(fs.readFileSync(rulesPath(f.home), 'utf8'), /Account rules/);
  assert.ok(!out.includes(FAKE2));
  assert.match(out, /env TEST_REG_TOKEN_A \(set\)/);
  await assert.rejects(main(['account', 'import']), /already exists/);
  // With the registry in place the daemon reads the same accounts.
  assert.deepEqual(
    readConfig(f.home).accounts.map((a) => a.tokenEnv),
    ['TEST_REG_TOKEN_A', undefined],
  );
});

test('account import --move-tokens copies the environment value into the registry and drops tokenEnv', async (t) => {
  const f = state(t);
  const out = await capture(() => main(['account', 'import', '--move-tokens']));
  const stored = readRegistry(f.home)!;
  assert.equal(stored[0]!.token, FAKE2);
  assert.equal(stored[0]!.tokenEnv, undefined);
  assert.ok(!out.includes(FAKE2), 'the import report never prints the token');
  assert.match(out, /token in accounts\.json/);
  assert.equal(fs.statSync(registryPath(f.home)).mode & 0o777, 0o600);
  // A variable that is not set here stays a reference.
  fs.rmSync(registryPath(f.home));
  delete process.env.TEST_REG_TOKEN_A;
  const out2 = await capture(() => main(['account', 'import', '--move-tokens']));
  assert.equal(readRegistry(f.home)![0]!.tokenEnv, 'TEST_REG_TOKEN_A');
  assert.match(out2, /not set here, kept as an env reference/);
  // config.json is left untouched.
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.home, 'config.json'), 'utf8')).accounts[0].tokenEnv,
    'TEST_REG_TOKEN_A',
  );
});

test('account set-token reads the token from stdin (never argv) and --clear removes it', async (t) => {
  const f = state(t);
  await main(['account', 'import']);
  const root = path.resolve(import.meta.dirname, '..');
  const run = (args: string[], input?: string) =>
    spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), path.join(root, 'src/cli.ts'), ...args],
      { input, encoding: 'utf8', env: { ...process.env, CLAWSTRUM_HOME: f.home } },
    );
  const set = run(['account', 'set-token', 'a'], `${FAKE}\n`);
  assert.equal(set.status, 0, set.stderr);
  assert.ok(!(set.stdout + set.stderr).includes(FAKE));
  const stored = readRegistry(f.home)!;
  assert.equal(stored[0]!.token, FAKE);
  assert.equal(stored[0]!.tokenEnv, undefined, 'tokenEnv is dropped so only one source remains');
  const codex = run(['account', 'set-token', 'b'], FAKE);
  assert.notEqual(codex.status, 0);
  assert.ok(!(codex.stdout + codex.stderr).includes(FAKE));
  assert.match(codex.stderr, /only Claude/);
  const empty = run(['account', 'set-token', 'a'], '');
  assert.notEqual(empty.status, 0);
  assert.equal(readRegistry(f.home)![0]!.token, FAKE, 'an empty stdin does not clear the token');
  assert.equal(run(['account', 'set-token', 'a', '--clear']).status, 0);
  assert.equal(readRegistry(f.home)![0]!.token, undefined);
});

test('account add, edit and remove work on the registry and validate the whole configuration', async (t) => {
  const f = state(t);
  await assert.rejects(main(['account', 'remove', 'b']), /account import/);
  await main(['account', 'import']);
  await main([
    'account',
    'add',
    'c',
    'claude',
    '--owner',
    'Alice',
    '--model',
    'fable',
    '--priority',
    '5',
  ]);
  let stored = readRegistry(f.home)!;
  assert.deepEqual(
    stored.map((a) => a.id),
    ['a', 'b', 'c'],
  );
  assert.equal(stored[2]!.owner, 'Alice');
  assert.equal(stored[2]!.priority, 5);
  assert.equal(stored[2]!.home, 'accounts/c/claude');
  await main(['account', 'edit', 'c', '--label', 'Fable', '--priority', '7']);
  await main(['account', 'edit', 'c', '--owner', 'none']);
  stored = readRegistry(f.home)!;
  assert.equal(stored[2]!.label, 'Fable');
  assert.equal(stored[2]!.priority, 7);
  assert.equal(stored[2]!.owner, undefined);
  await assert.rejects(main(['account', 'edit', 'c', '--priority', '5000']), /priority/);
  await assert.rejects(main(['account', 'edit', 'c']), /account edit ID --FIELD VALUE/);
  await assert.rejects(main(['account', 'add', 'c', 'claude']), /unique/);
  assert.equal(readRegistry(f.home)!.length, 3, 'a rejected change leaves the file alone');
  await main(['account', 'remove', 'c']);
  assert.deepEqual(
    readRegistry(f.home)!.map((a) => a.id),
    ['a', 'b'],
  );
  await main(['account', 'remove', 'b']);
  await assert.rejects(main(['account', 'remove', 'a']), /last account/);
  // Without a registry, add still edits config.json as before.
  fs.rmSync(registryPath(f.home));
  await main(['account', 'add', 'z', 'codex']);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.home, 'config.json'), 'utf8')).accounts.at(-1).id,
    'z',
  );
});

test('a registry change reaches the running engine without a restart, and switch can use the new account', async (t) => {
  const f = state(t);
  writeRaw(f, registryAccounts(f));
  const config = readConfig(f.home);
  const ran: string[] = [];
  const p: Provider = {
    async run(r: ProviderRequest) {
      ran.push(`${r.account.id}:${r.account.model ?? '-'}`);
      return 'Done';
    },
  };
  const engine = new Engine(config, f.store, { claude: p, codex: p });
  const reload = accountsReloader(f.home, config, 0);
  const logs: string[] = [];
  const log = {
    log: (m: string) => void logs.push(m),
    error: (m: string) => void logs.push(m),
  } as unknown as Console;

  applyAccountReload(reload, engine, log);
  assert.deepEqual(logs, [], 'nothing changed yet');

  // An unknown account is refused before the file changes.
  const session = f.store.session(f.session.id);
  f.store.exec(
    'INSERT INTO controls(session_id,command,argument,created_at) VALUES(?,?,?,?)',
    session.id,
    'switch',
    'c',
    Date.now(),
  );
  engine.tick();
  assert.match(
    f.store.get<any>("SELECT content FROM outbox WHERE content LIKE 'Unknown account%'").content,
    /Unknown account: c/,
  );

  writeRaw(
    f,
    registryAccounts(f, [
      {
        id: 'c',
        owner: 'Alice',
        provider: 'claude',
        home: path.join(f.home, 'c'),
        model: 'fable-x',
        token: FAKE2,
        priority: -5,
      },
    ]),
  );
  applyAccountReload(reload, engine, log);
  const event = JSON.parse(logs.at(-1)!);
  assert.equal(event.event, 'accounts_reloaded');
  assert.deepEqual(event.ids, ['a', 'b', 'c']);
  assert.deepEqual(event.added, ['c']);
  assert.ok(!logs.join('\n').includes('FAKE'), 'the reload log carries ids only');
  assert.deepEqual(
    engine.config.accounts.map((a) => a.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    engine.pool.accounts.map((a) => a.id),
    ['a', 'b', 'c'],
  );
  assert.equal(accountToken('c'), FAKE2);
  assert.ok(
    f.store.get("SELECT id FROM accounts WHERE id='c'"),
    'cooldown state exists for the new account',
  );

  f.store.exec(
    'INSERT INTO controls(session_id,command,argument,created_at) VALUES(?,?,?,?)',
    session.id,
    'switch',
    'c',
    Date.now(),
  );
  f.enqueue('hello');
  engine.tick();
  await settle(engine);
  assert.equal(f.store.session(session.id).preferred_account, 'c');
  assert.deepEqual(ran, ['c:fable-x']);

  // Removing an account and changing a priority also apply live.
  writeRaw(f, [{ ...registryAccounts(f)[0]!, priority: 1 }, registryAccounts(f)[1]!]);
  applyAccountReload(reload, engine, log);
  assert.deepEqual(
    engine.pool.accounts.map((a) => [a.id, a.priority]),
    [
      ['a', 1],
      ['b', undefined],
    ],
  );
  assert.equal(JSON.parse(logs.at(-1)!).removed[0], 'c');
});

test('an invalid registry keeps the old account list and logs accounts_reload_failed once', async (t) => {
  const f = state(t);
  writeRaw(f, registryAccounts(f));
  const config = readConfig(f.home);
  const p: Provider = {
    async run() {
      return 'Done';
    },
  };
  const engine = new Engine(config, f.store, { claude: p, codex: p });
  const reload = accountsReloader(f.home, config, 0);
  const logs: string[] = [];
  const log = {
    log: (m: string) => void logs.push(m),
    error: (m: string) => void logs.push(m),
  } as unknown as Console;

  fs.writeFileSync(registryPath(f.home), `{"version":1,"accounts":[{"token":"${FAKE2}",,}`, {
    mode: 0o600,
  });
  applyAccountReload(reload, engine, log);
  assert.equal(JSON.parse(logs.at(-1)!).event, 'accounts_reload_failed');
  assert.ok(!logs.join('\n').includes('FAKE'));
  assert.deepEqual(
    engine.config.accounts.map((a) => a.id),
    ['a', 'b'],
  );
  assert.equal(accountToken('a'), FAKE, 'the stored token also stays in force');
  const count = logs.length;
  applyAccountReload(reload, engine, log);
  assert.equal(logs.length, count, 'the same broken file is not reported again');

  // A registry that group or others can read is also refused, and the old list stays.
  writeRaw(f, registryAccounts(f), 0o644);
  applyAccountReload(reload, engine, log);
  assert.match(logs.at(-1)!, /accounts_reload_failed.*chmod 600/);
  assert.deepEqual(
    engine.config.accounts.map((a) => a.id),
    ['a', 'b'],
  );

  // Fixing the file applies it.
  writeRaw(f, [
    ...registryAccounts(f),
    { id: 'c', provider: 'claude', home: path.join(f.home, 'c') },
  ]);
  applyAccountReload(reload, engine, log);
  assert.equal(JSON.parse(logs.at(-1)!).event, 'accounts_reloaded');
  assert.deepEqual(
    engine.config.accounts.map((a) => a.id),
    ['a', 'b', 'c'],
  );
});

test('without a registry a config.json account change is applied live too', (t) => {
  const f = state(t);
  const config = readConfig(f.home);
  const reload = accountsReloader(f.home, config, 0);
  const raw = JSON.parse(fs.readFileSync(path.join(f.home, 'config.json'), 'utf8'));
  raw.accounts.push({ id: 'n', provider: 'claude', home: path.join(f.home, 'n') });
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(raw));
  const at = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(f.home, 'config.json'), at, at);
  const change = reload()!;
  assert.deepEqual(change.added, ['n']);
  assert.equal(reload(), null);
});

test('reloading drops cached subagent pools so a new account is used at the next routing decision', (t) => {
  const f = state(t);
  const p: Provider = {
    async run() {
      return 'Done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: p, codex: p });
  const pools = (engine.researchWorkers as any).rolePools as Map<string, AccountPool>;
  pools.set('x', new AccountPool([], f.store, 1000));
  engine.reloadAccounts([
    ...f.config.accounts,
    {
      id: 'n',
      provider: 'claude',
      home: path.join(f.home, 'n'),
      quotaBuckets: [],
      modelFallbacks: [],
      maxConcurrent: 4,
    } as any,
  ]);
  assert.equal(pools.size, 0);
  assert.equal(f.config.accounts.at(-1)!.id, 'n');
});

function modelRoutes(f: F, reply?: (r: ProviderRequest) => string | Error) {
  const ran: string[] = [];
  const instructions: string[] = [];
  const p: Provider = {
    async run(r: ProviderRequest) {
      ran.push(`${r.account.id}:${r.account.model ?? '-'}`);
      instructions.push(r.instructions);
      const answer = reply?.(r) ?? 'Done';
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { ran, instructions, engine: new Engine(f.config, f.store, { claude: p, codex: p }) };
}
const control = (f: F, command: string, argument: string | null) =>
  f.store.exec(
    'INSERT INTO controls(session_id,command,argument,created_at) VALUES(?,?,?,?)',
    f.session.id,
    command,
    argument,
    Date.now(),
  );

test('switch SESSION ACCOUNT --model M routes that model on that account, and --model default clears it', async (t) => {
  const f = state(t);
  f.config.accounts[0]!.model = 'base';
  const { ran, engine } = modelRoutes(f);

  // The CLI queues "ACCOUNT MODEL" and a plain switch queues "ACCOUNT".
  await main(['switch', f.session.id, 'a', '--model', 'claude-fable-x']);
  assert.equal(f.store.get<any>('SELECT argument FROM controls').argument, 'a claude-fable-x');
  f.store.exec('DELETE FROM controls');
  await assert.rejects(main(['switch', f.session.id, 'a', '--model']), /needs a model name/);
  await assert.rejects(
    main(['switch', f.session.id, 'nope', '--model', 'm']),
    /Specify an account/,
  );

  control(f, 'switch', 'a claude-fable-x');
  f.enqueue('one');
  engine.tick();
  await settle(engine);
  assert.deepEqual(ran, ['a:claude-fable-x']);
  assert.equal(f.store.session(f.session.id).active_model, 'claude-fable-x');
  assert.match(sessionStatus(f.store, f.session.id), /model override: claude-fable-x on a/);
  assert.match(sessionStatus(f.store, f.session.id), /Model: claude-fable-x/);

  // The account's own configuration is not changed by the request.
  assert.equal(engine.config.accounts[0]!.model, 'base');

  control(f, 'switch', 'a default');
  f.enqueue('two');
  engine.tick();
  await settle(engine);
  assert.equal(ran.at(-1), 'a:base');
  assert.match(sessionStatus(f.store, f.session.id), /model override: none/);

  control(f, 'switch', 'a claude-fable-x');
  f.enqueue('three');
  engine.tick();
  await settle(engine);
  assert.equal(ran.at(-1), 'a:claude-fable-x');
  control(f, 'switch', 'a');
  f.enqueue('four');
  engine.tick();
  await settle(engine);
  assert.equal(ran.at(-1), 'a:base', "a plain switch means the account's own model");
});

test("a refused requested model falls back to the account's own models with the usual notice", async (t) => {
  const f = state(t);
  f.config.accounts[0]!.model = 'base';
  const { ran, engine } = modelRoutes(f, (r) =>
    r.account.model === 'claude-fable-x'
      ? new Error(
          "There's an issue with the selected model (claude-fable-x). It may not exist or you may not have access to it.",
        )
      : 'Done',
  );
  control(f, 'switch', 'a claude-fable-x');
  f.enqueue('one');
  engine.tick();
  await settle(engine);
  assert.deepEqual(ran, ['a:claude-fable-x', 'a:base']);
  assert.equal(f.store.session(f.session.id).active_model, 'base');
  const notice = f.store.get<any>("SELECT content FROM outbox WHERE dedupe_key LIKE 'handoff:%'");
  assert.match(notice.content, /Fallback model in use; preferred model: claude-fable-x/);
});

test('a refused requested model on an account with no other model is reported, not hidden', async (t) => {
  const f = state(t);
  f.config.accounts[0]!.model = undefined;
  const { ran, engine } = modelRoutes(f, () => new Error('model_not_found'));
  control(f, 'switch', 'a claude-fable-x');
  f.enqueue('one');
  engine.tick();
  await settle(engine);
  assert.deepEqual(ran, ['a:claude-fable-x']);
  assert.ok(f.store.get("SELECT 1 FROM runs WHERE status='failed'"));
});

test('the model request is per conversation: another conversation keeps the account model', async (t) => {
  const f = state(t);
  f.config.accounts[0]!.model = 'base';
  const { ran, engine } = modelRoutes(f);
  const other = f.store.ensureSession('987655');
  control(f, 'switch', 'a claude-fable-x');
  engine.tick();
  f.store.enqueue({
    id: 'o1',
    sessionId: other.id,
    author: 'owner',
    content: 'o1',
    at: Date.now(),
  });
  f.store.exec('UPDATE sessions SET preferred_account=? WHERE id=?', 'a', other.id);
  engine.tick();
  await settle(engine);
  assert.deepEqual(ran, ['a:base']);
});

test('Discord: !clawstrum switch ACCOUNT [--model] MODEL is parsed', () => {
  assert.deepEqual(parseCommand('!clawstrum switch a'), { command: 'switch', argument: 'a' });
  assert.deepEqual(parseCommand('!clawstrum switch a claude-fable-5-2'), {
    command: 'switch',
    argument: 'a claude-fable-5-2',
  });
  assert.deepEqual(parseCommand('!clawstrum switch a --model default'), {
    command: 'switch',
    argument: 'a default',
  });
  assert.equal(parseCommand('!clawstrum switch a --bogus'), undefined);
  assert.deepEqual(parseCommand('!clawstrum status'), { command: 'status', argument: undefined });
});

test("every lead's instructions carry the Accounts section: rules, table, commands, and no secret", async (t) => {
  const f = state(t);
  writeRaw(f, registryAccounts(f));
  fs.writeFileSync(
    rulesPath(f.home),
    'Use WORK whenever it has quota left; otherwise HOME; CODEX last.\n',
    { mode: 0o600 },
  );
  const config = readConfig(f.home);
  const { ran, instructions, engine } = modelRoutes({ ...f, config } as F);
  const live = new Engine(config, f.store, {
    claude: {
      async run(r) {
        ran.push(r.account.id);
        instructions.push(r.instructions);
        return 'Done';
      },
    },
    codex: {
      async run(r) {
        ran.push(r.account.id);
        instructions.push(r.instructions);
        return 'Done';
      },
    },
  });
  void engine;
  f.enqueue('hello');
  live.tick();
  await settle(live);
  assert.equal(instructions.length, 1);
  const text = instructions[0]!;
  const section = text.slice(text.indexOf('Accounts (managed by Clawstrum'));
  assert.ok(section.length > 0, 'Accounts section present');
  const body = section.split('\n\n')[0]!;
  assert.ok(body.length <= 1600, `section is ${body.length} chars`);
  assert.match(body, /Use WORK whenever it has quota left/);
  assert.match(body, /clawstrum account test ID --model M/);
  assert.match(body, /Never test by setting CLAUDE_CONFIG_DIR/);
  assert.match(body, /clawstrum switch SESSION ACCOUNT \[--model M\|default\]/);
  assert.match(body, /Do not ask the person to log in for an account whose credential is a token/);
  assert.match(body, /a \| Alice \| claude base \| 100 \| token in accounts\.json \| available/);
  assert.ok(!text.includes(FAKE) && !text.includes(FAKE2));
});

test('a long rules file is cut with a pointer to the file and the section stays within its cap', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'accts-'));
  try {
    fs.writeFileSync(path.join(dir, 'ACCOUNTS.md'), 'Rule one. '.repeat(400));
    const accounts = Array.from({ length: 12 }, (_, i) => ({
      id: `acct${i}`,
      provider: 'claude' as const,
      home: `/h/${i}`,
      model: 'claude-opus-5-5',
      tokenEnv: `VAR_${i}`,
    }));
    const section = accountsSection(dir, accounts, () => undefined, {});
    assert.ok(section.length <= 1600, `section is ${section.length} chars`);
    assert.match(section, /cut; read the file for the rest/);
    assert.match(section, new RegExp(dir.replace(/[/.]/g, '\\$&') + '/ACCOUNTS.md'));
    assert.match(section, /more accounts: clawstrum account list/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the dashboard shows registry fields, credential source, rules and per-conversation overrides', (t) => {
  const f = state(t);
  writeRaw(f, registryAccounts(f));
  fs.writeFileSync(rulesPath(f.home), 'Use a first.\n', { mode: 0o600 });
  const config = readConfig(f.home);
  f.store.exec('UPDATE sessions SET preferred_account=? WHERE id=?', 'a', f.session.id);
  f.store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    `model-override:${f.session.id}`,
    JSON.stringify({ account: 'a', model: 'claude-fable-x' }),
  );
  const reader = {
    get: (sql: string, ...p: any[]) => f.store.get(sql, ...p),
    all: (sql: string, ...p: any[]) => f.store.all(sql, ...p),
  };
  const posts = renderDashboardPosts(collectDashboardData(f.home, config, reader as any));
  const accounts = posts.find((p) => p.key === 'accounts')!;
  assert.match(
    accounts.body,
    /owner=Alice; label=Primary Claude; claude; model=base; priority=100; credential=token in accounts\.json/,
  );
  assert.match(accounts.body, /notes=first choice/);
  assert.match(accounts.body, /Use a first\./);
  assert.match(accounts.body, /987654 .*account=a; model request=claude-fable-x on a/);
  const channels = posts.find((p) => p.key === 'channels')!;
  assert.match(channels.body, /model request=claude-fable-x on a/);
  for (const post of posts) assert.ok(!`${post.summary}${post.body}`.includes('FAKETOKEN'));
});

test('writeRegistry validates before writing and creates the file with mode 0600', (t) => {
  const f = state(t);
  assert.throws(() => writeRegistry(f.home, [{ id: 'x' } as any]), /invalid registry/);
  assert.equal(fs.existsSync(registryPath(f.home)), false);
  writeRegistry(f.home, registryAccounts(f) as any);
  assert.equal(fs.statSync(registryPath(f.home)).mode & 0o777, 0o600);
});

test('the bundled model-router skill loads and names the exact commands the CLI accepts', async (t) => {
  const { readSkills } = await import('../src/context.js');
  const skills = readSkills([path.resolve(import.meta.dirname, '../templates/skills')]);
  const skill = skills.find((s) => s.name === 'model-router')!;
  assert.ok(skill, 'model-router is bundled');
  const text = fs.readFileSync(
    path.resolve(import.meta.dirname, '../templates/skills/model-router/SKILL.md'),
    'utf8',
  );
  for (const command of [
    'clawstrum account test ACCOUNT --model MODEL',
    'clawstrum switch SESSION ACCOUNT --model MODEL',
    'clawstrum switch SESSION ACCOUNT --model default',
    'clawstrum account set-token ID',
  ])
    assert.ok(text.includes(command), command);
  assert.match(text, /Never test an account by setting `CLAUDE_CONFIG_DIR`/);
  assert.match(text, /Do not ask the person to log in for an account whose credential is a token/);
  const f = state(t);
  await assert.rejects(
    main(['account', 'nope']),
    /import .*add ID PROVIDER.*edit ID.*remove ID.*set-token ID.*login ID.*test ID/s,
  );
  void f;
});
