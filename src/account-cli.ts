import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { accountSchema, type RegistryAccount } from './account-schema.js';
import { availabilityText } from './account-context.js';
import {
  RegistryError,
  credentialSource,
  hasAccountToken,
  readRegistry,
  registryPath,
  rulesPath,
  writeRegistry,
} from './account-registry.js';
import { normalizeConfig, saveConfig, type Config } from './config.js';
import type { AccountPool } from './accounts.js';
import type { Store } from './store.js';

/** What `clawstrum account list` prints for one account. Never a token value. */
export function listAccounts(config: Config, store: Store, pool: AccountPool, home: string) {
  const fromRegistry = fs.existsSync(registryPath(home));
  return config.accounts.map((a) => {
    const state = store.get<{
      cooldown_until: number;
      disabled: number;
      reason: string | null;
      usage_json: string | null;
    }>('SELECT cooldown_until,disabled,reason,usage_json FROM accounts WHERE id=?', a.id);
    return {
      id: a.id,
      owner: a.owner,
      label: a.label,
      provider: a.provider,
      home: a.home,
      priority: a.priority ?? 0,
      model: a.model,
      modelFallbacks: a.modelFallbacks,
      credential: credentialSource(a),
      source: fromRegistry ? 'accounts.json' : 'config.json',
      available: pool.available(a.id, Date.now()),
      now: availabilityText(state),
      state,
    };
  });
}

/** Fail with the schema's message if config.json with these accounts would not load. */
function assertAccepted(home: string, accounts: RegistryAccount[]): void {
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  raw.accounts = accounts.map(({ token: _token, ...account }) => account);
  normalizeConfig(home, raw);
}
function requireRegistry(home: string): RegistryAccount[] {
  const accounts = readRegistry(home);
  if (!accounts)
    throw new RegistryError(
      `No ${registryPath(home)} yet. Create it from the current accounts with: clawstrum account import [--move-tokens]`,
    );
  return accounts;
}
function save(home: string, accounts: RegistryAccount[]): void {
  assertAccepted(home, accounts);
  writeRegistry(home, accounts);
}
function find(accounts: RegistryAccount[], id: string | undefined): RegistryAccount {
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new Error('Specify an account: ' + accounts.map((a) => a.id).join(', '));
  return account;
}

export const RULES_TEMPLATE = (ids: string[]) => `# Account rules

Write here, in plain words, which account to use and when to switch. Clawstrum puts this text into
every lead agent's system prompt (cut at about 700 characters; the agent can read the whole file).
Keep each rule short and exact. Never put a token or password here. Accounts: ${ids.join(', ')}.

- Replace this line, for example: "Use ${ids[0] ?? 'ACCOUNT_A'} whenever it has quota left; otherwise ${ids[1] ?? 'ACCOUNT_B'}."
`;

/** Read a secret from stdin: piped input as is, or a hidden prompt on a terminal. */
export async function readSecretFromStdin(): Promise<string> {
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8').trim();
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  process.stderr.write('Token (input hidden): ');
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    return (await rl.question('')).trim();
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}

export function importRegistry(
  home: string,
  env: NodeJS.ProcessEnv,
  options: { moveTokens: boolean; force: boolean },
): { written: string; accounts: Array<{ id: string; credential: string }>; notes: string[] } {
  const file = registryPath(home);
  if (fs.existsSync(file) && !options.force)
    throw new RegistryError(
      `${file} already exists. Use account edit, or --force to overwrite it.`,
    );
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  const accounts: RegistryAccount[] = (raw.accounts ?? []).map((a: unknown) =>
    accountSchema.parse(a),
  );
  const notes: string[] = [];
  for (const account of accounts) {
    if (!account.tokenEnv) continue;
    if (!options.moveTokens) continue;
    const value = env[account.tokenEnv];
    if (!value) {
      notes.push(`${account.id}: ${account.tokenEnv} is not set here, kept as an env reference`);
      continue;
    }
    const name = account.tokenEnv;
    account.token = value.trim();
    delete account.tokenEnv;
    notes.push(
      `${account.id}: token moved into accounts.json; the ${name} line in .env is no longer used and can be removed by hand`,
    );
  }
  writeRegistry(home, accounts);
  const rules = rulesPath(home);
  if (!fs.existsSync(rules))
    fs.writeFileSync(rules, RULES_TEMPLATE(accounts.map((a) => a.id)), { flag: 'wx', mode: 0o600 });
  return {
    written: file,
    accounts: accounts.map((a) => ({
      id: a.id,
      credential: a.token
        ? 'token in accounts.json'
        : a.tokenEnv
          ? `env ${a.tokenEnv} (${env[a.tokenEnv] ? 'set' : 'missing'})`
          : `profile login at ${a.home}`,
    })),
    notes,
  };
}

export function setToken(home: string, id: string | undefined, token: string | null): string {
  const accounts = requireRegistry(home);
  const account = find(accounts, id);
  if (account.provider !== 'claude')
    throw new Error(
      `Account ${account.id} is a ${account.provider} account; only Claude takes a token`,
    );
  const note: string[] = [];
  if (token === null) delete account.token;
  else {
    if (!token)
      throw new Error(
        'No token on stdin. Pipe it: printf %s "$TOKEN" | clawstrum account set-token ID',
      );
    account.token = token;
    if (account.tokenEnv) {
      delete account.tokenEnv;
      note.push('its tokenEnv reference was removed');
    }
  }
  save(home, accounts);
  return `${token === null ? 'Token removed from' : 'Token stored for'} ${account.id}${note.length ? ` (${note.join('; ')})` : ''}. The running daemon applies it within a few seconds.`;
}

const EDITABLE: Record<string, (value: string) => unknown> = {
  owner: (v) => v,
  label: (v) => v,
  notes: (v) => v,
  priority: (v) => Number(v),
  model: (v) => v,
  effort: (v) => v,
  home: (v) => v,
  executable: (v) => v,
  'token-env': (v) => v,
  'max-concurrent': (v) => Number(v),
};
const FIELD_KEY: Record<string, string> = {
  'token-env': 'tokenEnv',
  'max-concurrent': 'maxConcurrent',
};
export function editAccount(
  home: string,
  id: string | undefined,
  options: Record<string, string>,
): string {
  const accounts = requireRegistry(home);
  const account = find(accounts, id) as Record<string, unknown>;
  const changed: string[] = [];
  for (const [flag, convert] of Object.entries(EDITABLE)) {
    const value = options[flag];
    if (value === undefined) continue;
    if (value === 'true') throw new Error(`--${flag} needs a value (use "none" to clear it)`);
    const key = FIELD_KEY[flag] ?? flag;
    if (value === 'none') delete account[key];
    else account[key] = convert(value);
    changed.push(key);
  }
  if (!changed.length)
    throw new Error(
      `account edit ID --FIELD VALUE ... where FIELD is one of ${Object.keys(EDITABLE).join(', ')} ("none" clears a field)`,
    );
  save(home, accounts);
  return `Updated ${id}: ${changed.join(', ')}. The running daemon applies it within a few seconds.`;
}

export function addAccount(
  home: string,
  id: string | undefined,
  provider: string | undefined,
  options: Record<string, string>,
): string {
  if (!id || !provider)
    throw new Error(
      'account add ID codex|claude|gemini [--owner O --label L --model M --priority N --token-env VAR]',
    );
  const entry: Record<string, unknown> = {
    id,
    provider,
    home: options.home ?? `accounts/${id}/${provider}`,
  };
  for (const [flag, convert] of Object.entries(EDITABLE)) {
    if (flag === 'home' || options[flag] === undefined) continue;
    entry[FIELD_KEY[flag] ?? flag] = convert(options[flag]!);
  }
  if (fs.existsSync(registryPath(home))) {
    const accounts = requireRegistry(home);
    const parsed = accountSchema.parse(entry) as RegistryAccount;
    save(home, [...accounts, parsed]);
    return `Added ${id} to ${registryPath(home)}. The running daemon applies it within a few seconds; no restart. Credential: ${provider === 'codex' || provider === 'gemini' ? `clawstrum account login ${id}` : 'clawstrum account set-token ' + id + ' (or clawstrum account login ' + id + ')'}.`;
  }
  const rawConfig = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  rawConfig.accounts.push(accountSchema.parse(entry));
  saveConfig(home, rawConfig);
  return `Added ${id} to config.json. The running daemon applies it within a few seconds; no restart. Then run clawstrum account login ${id}.`;
}

export function removeAccount(home: string, id: string | undefined): string {
  const accounts = requireRegistry(home);
  find(accounts, id);
  if (accounts.length === 1) throw new Error('Cannot remove the last account');
  const had = hasAccountToken(id!);
  save(
    home,
    accounts.filter((a) => a.id !== id),
  );
  return `Removed ${id} from ${registryPath(home)}${had ? ' (its stored token went with it)' : ''}. Conversations preferring it route automatically until switched.`;
}
