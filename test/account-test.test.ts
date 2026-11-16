import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { ProviderFailure } from '../src/accounts.js';
import { testAccount, loginRefusal } from '../src/account-test.js';
import { saveConfig } from '../src/config.js';
import { main } from '../src/cli-main.js';
import type { Provider, ProviderRequest } from '../src/types.js';

// A stand-in for the Claude executable: reports a version, accepts `auth login`, writes a marker.
function fakeClaude(dir: string) {
  const file = path.join(dir, 'fake-claude.sh');
  fs.writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi\ntouch "${dir}/ran-$1"\nexit 0\n`,
    { mode: 0o755 },
  );
  return file;
}

function tokenAccount(f: ReturnType<typeof fixture>) {
  const executable = fakeClaude(f.home);
  f.config.accounts = [
    {
      id: 'p',
      provider: 'claude',
      home: path.join(f.home, 'p'),
      tokenEnv: 'TEST_TOKEN_P',
      executable,
      model: 'claude-opus-5-5',
    },
    { id: 'q', provider: 'claude', home: path.join(f.home, 'q'), executable },
  ] as typeof f.config.accounts;
  return f.config.accounts[0]!;
}

function recorder(reply: string | Error) {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    async run(r) {
      requests.push(r);
      if (reply instanceof Error) throw reply;
      return `${reply}\n`;
    },
  };
  return { requests, providers: { claude: provider, codex: provider, gemini: provider } };
}

test('account test sends one short prompt with the daemon environment: saved token, account home, requested model', async (t) => {
  const f = fixture(t);
  const account = tokenAccount(f);
  const { requests, providers } = recorder('ok');
  const result = await testAccount(f.config, account, {
    model: 'claude-fable-5-2',
    providers,
    source: { TEST_TOKEN_P: 'saved-token-value', ANTHROPIC_API_KEY: 'ambient-key' },
  });
  assert.equal(requests.length, 1);
  const r = requests[0]!;
  assert.equal(r.prompt, 'Reply with the word ok');
  assert.equal(r.toolless, true);
  assert.equal(r.account.model, 'claude-fable-5-2');
  assert.equal(r.account.executable, account.executable);
  // Same environment filtering as the daemon: the token variable maps to the OAuth token, the
  // profile home is the config dir, and ambient provider keys are removed.
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, 'saved-token-value');
  assert.equal(r.env.CLAUDE_CONFIG_DIR, account.home);
  assert.equal(r.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(r.env.TEST_TOKEN_P, undefined);
  assert.deepEqual(result, {
    account: 'p',
    model: 'claude-fable-5-2',
    ok: true,
    reply: 'ok',
    executable: account.executable,
    cliVersion: '9.9.9',
  });
  // The account itself is not modified by the override.
  assert.equal(account.model, 'claude-opus-5-5');
});

test('account test uses the account model by default, and reports a refused model as an error', async (t) => {
  const f = fixture(t);
  const account = tokenAccount(f);
  const { requests, providers } = recorder(
    new ProviderFailure('fatal', 'model may not exist or you may not have access'),
  );
  const result = await testAccount(f.config, account, {
    providers,
    source: { TEST_TOKEN_P: 'x' },
  });
  assert.equal(requests[0]!.account.model, 'claude-opus-5-5');
  assert.equal(result.ok, false);
  assert.equal(result.model, 'claude-opus-5-5');
  assert.match(result.error!, /model may not exist/);
  assert.equal(result.reply, undefined);
});

test('account test names the missing token variable instead of calling the provider', async (t) => {
  const f = fixture(t);
  const account = tokenAccount(f);
  const { requests, providers } = recorder('ok');
  const result = await testAccount(f.config, account, { providers, source: {} });
  assert.equal(requests.length, 0);
  assert.equal(result.ok, false);
  assert.match(result.error!, /Missing environment variable TEST_TOKEN_P/);
});

test('loginRefusal applies to accounts that use a token and is lifted by --force', (t) => {
  const f = fixture(t);
  const account = tokenAccount(f);
  const message = loginRefusal(account, false)!;
  assert.match(message, /saved token named by TEST_TOKEN_P/);
  assert.match(message, /clawstrum account test p/);
  assert.match(message, /--force/);
  assert.equal(loginRefusal(account, true), undefined);
  assert.equal(loginRefusal(f.config.accounts[1]!, false), undefined);
});

test('clawstrum account login refuses a tokenEnv account, runs with --force, and still logs in an account without tokenEnv', async (t) => {
  const f = fixture(t);
  tokenAccount(f);
  saveConfig(f.home, JSON.parse(JSON.stringify(f.config)));
  const saved = process.env.CLAWSTRUM_HOME;
  process.env.CLAWSTRUM_HOME = f.home;
  t.after(() => {
    if (saved === undefined) delete process.env.CLAWSTRUM_HOME;
    else process.env.CLAWSTRUM_HOME = saved;
  });
  process.env.TEST_TOKEN_P = 'x';
  t.after(() => delete process.env.TEST_TOKEN_P);

  await assert.rejects(
    main(['account', 'login', 'p']),
    /saved token named by TEST_TOKEN_P.*clawstrum account test p/s,
  );
  assert.equal(fs.existsSync(path.join(f.home, 'ran-auth')), false);

  await main(['account', 'login', 'p', '--force']);
  assert.equal(fs.existsSync(path.join(f.home, 'ran-auth')), true);
  fs.rmSync(path.join(f.home, 'ran-auth'));

  await main(['account', 'login', 'q']);
  assert.equal(fs.existsSync(path.join(f.home, 'ran-auth')), true);

  await assert.rejects(main(['account', 'nope']), /test ID \[--model M\]/);
});
