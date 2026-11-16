import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writePrivate } from './files.js';
import { registryAccountSchema, validateAccounts, type RegistryAccount } from './account-schema.js';

/**
 * The private account registry, runtime/accounts.json in the state directory. When it exists its
 * accounts are the account list and config.json `accounts` is ignored; without it nothing changes.
 * It may hold a Claude OAuth token per account. A token is kept only in the in-process map below,
 * never on the Account objects that are logged, stored with delegations, rendered or put in prompts.
 */
export const REGISTRY_FILE = 'accounts.json';
export const RULES_FILE = 'ACCOUNTS.md';

export function registryPath(home: string): string {
  return path.join(home, REGISTRY_FILE);
}
export function rulesPath(home: string): string {
  return path.join(home, RULES_FILE);
}

const registrySchema = z
  .object({ version: z.literal(1), accounts: z.array(registryAccountSchema).min(1) })
  .strict()
  .superRefine((r, ctx) => validateAccounts(r.accounts, ctx, ['accounts']));

const tokens = new Map<string, string>();
/** Replace every stored token. Called by readConfig after a registry loaded without error. */
export function setAccountTokens(next: ReadonlyMap<string, string>): void {
  tokens.clear();
  for (const [id, token] of next) tokens.set(id, token);
}
export function accountToken(id: string): string | undefined {
  return tokens.get(id);
}
export function hasAccountToken(id: string): boolean {
  return tokens.has(id);
}

export class RegistryError extends Error {}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || 'file'}: ${i.message}`)
    .join('; ');
}

/** Raw file text after the permission check. Never returns or reports content in errors. */
function readPrivateFile(file: string): string {
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077)
    throw new RegistryError(
      `${file} can be read by group or others (mode ${mode.toString(8).padStart(3, '0')}). It may hold account tokens. Run: chmod 600 ${file}`,
    );
  return fs.readFileSync(file, 'utf8');
}

/**
 * The registry's accounts exactly as stored, token included. Used by the editing commands. Returns
 * undefined when the file does not exist. Any other problem throws a RegistryError that does not
 * quote the file's content (a JSON syntax message can contain a slice of a token).
 */
export function readRegistry(home: string): RegistryAccount[] | undefined {
  const file = registryPath(home);
  if (!fs.existsSync(file)) return undefined;
  const text = readPrivateFile(file);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const at = /position (\d+)/.exec(String((error as Error).message))?.[1];
    throw new RegistryError(`${file} is not valid JSON${at ? ` (near character ${at})` : ''}`);
  }
  const parsed = registrySchema.safeParse(json);
  if (!parsed.success)
    throw new RegistryError(`${file} is invalid: ${describeIssues(parsed.error)}`);
  return parsed.data.accounts;
}

export interface LoadedRegistry {
  /** Account fields for config.accounts, token removed. */
  accounts: Array<Omit<RegistryAccount, 'token'>>;
  tokens: Map<string, string>;
}
export function loadAccountRegistry(home: string): LoadedRegistry | undefined {
  const stored = readRegistry(home);
  if (!stored) return undefined;
  const map = new Map<string, string>();
  const accounts = stored.map(({ token, ...account }) => {
    if (token) map.set(account.id, token);
    return account;
  });
  return { accounts, tokens: map };
}

/** Write the registry with mode 0600 (replace, never truncate). Validates first. */
export function writeRegistry(home: string, accounts: RegistryAccount[]): void {
  const checked = registrySchema.safeParse({ version: 1, accounts });
  if (!checked.success)
    throw new RegistryError(
      `Refusing to write an invalid registry: ${describeIssues(checked.error)}`,
    );
  writePrivate(
    registryPath(home),
    JSON.stringify({ version: 1, accounts: checked.data.accounts }, null, 2) + '\n',
  );
}

export interface CredentialAccount {
  id: string;
  provider: string;
  home: string;
  tokenEnv?: string | undefined;
}
/** How the daemon authenticates an account, in words. Never includes a value. */
export function credentialSource(
  account: CredentialAccount,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (account.provider === 'claude' && hasAccountToken(account.id)) return 'token in accounts.json';
  if (account.tokenEnv)
    return `env ${account.tokenEnv} (${env[account.tokenEnv] ? 'set' : 'missing'})`;
  return `profile login at ${account.home}`;
}

/**
 * Free text that goes into a prompt or the dashboard (ACCOUNTS.md) must never carry a token, even
 * if someone pasted one there: remove every stored token and anything shaped like a Claude token.
 */
export function redactAccountSecrets(text: string): string {
  let out = text;
  for (const token of tokens.values())
    if (token.length >= 8) out = out.split(token).join('[redacted]');
  return out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted]');
}
