import fs from 'node:fs';
import { credentialSource, redactAccountSecrets, rulesPath } from './account-registry.js';
import type { Account } from './types.js';

export interface AccountRow {
  cooldown_until: number;
  disabled: number;
  reason: string | null;
}
/** One short phrase for the state of an account right now. */
export function availabilityText(row: AccountRow | undefined, now = Date.now()): string {
  if (!row) return 'available';
  if (row.disabled) return `sign-in failed (${row.reason ?? 'auth'})`;
  if (row.cooldown_until > now)
    return `cooldown until ${new Date(row.cooldown_until).toISOString().slice(11, 16)}Z`;
  return 'available';
}

/** The primary model plus fallbacks, in plain words. */
export function modelText(account: Account): string {
  if (!account.model) return 'provider default';
  const fallbacks = (account.modelFallbacks ?? []).map((m) => m.model);
  return fallbacks.length ? `${account.model} (then ${fallbacks.join(', ')})` : account.model;
}

export const ACCOUNTS_SECTION_LIMIT = 1600;

/**
 * The "Accounts" section of every lead's system context: fixed rules, the owner's ACCOUNTS.md text
 * (cut with a pointer to the file when long), and a table of the accounts with how each one is
 * authenticated. It names credential sources, never values. Capped at ACCOUNTS_SECTION_LIMIT.
 */
export function accountsSection(
  home: string,
  accounts: Account[],
  state: (id: string) => AccountRow | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): string {
  const rulesFile = rulesPath(home);
  const fixed = [
    'Accounts (managed by Clawstrum; live list: `clawstrum account list`).',
    'Use only the accounts below. Clawstrum holds their credentials (accounts.json or the env variable named); do not look for, copy or print tokens.',
    'Test an account only with `clawstrum account test ID --model M`. Never test by setting CLAUDE_CONFIG_DIR or by a shell login.',
    "Change this conversation's account or model with `clawstrum switch SESSION ACCOUNT [--model M|default]` (SESSION is the Conversation id above); it applies without a restart. Edits to accounts.json apply within seconds.",
    'Do not ask the person to log in for an account whose credential is a token.',
  ].join('\n');
  const rows = accounts.map(
    (a) =>
      `${a.id} | ${a.owner ?? '-'} | ${a.provider} ${modelText(a)} | ${a.priority ?? 0} | ${credentialSource(a, env)} | ${availabilityText(state(a.id), now)}`,
  );
  const title = `Owner rules (${rulesFile}):\n`;
  const header = 'id | owner | provider, model (fallbacks) | priority | credential | now\n';
  // Keep at least 350 characters for the owner's rules; the table gives way first.
  const tableMax = Math.max(
    200,
    ACCOUNTS_SECTION_LIMIT - fixed.length - header.length - title.length - 350,
  );
  let table = '';
  for (const [i, row] of rows.entries()) {
    const next = `${table}${row}\n`;
    if (next.length > tableMax && i > 0) {
      table += `... ${rows.length - i} more accounts: clawstrum account list\n`;
      break;
    }
    table = next;
  }
  let rules = '';
  try {
    rules = redactAccountSecrets(fs.readFileSync(rulesFile, 'utf8')).trim();
  } catch {
    rules = '';
  }
  const head = `${fixed}\n${header}${table}`;
  const cut = '\n... cut; read the file for the rest.\n';
  const room = ACCOUNTS_SECTION_LIMIT - head.length - title.length;
  const body = !rules
    ? ''
    : rules.length + 1 <= room
      ? `${title}${rules}\n`
      : `${title}${rules.slice(0, Math.max(0, room - cut.length)).trimEnd()}${cut}`;
  return `${head}${body}`.trimEnd().slice(0, ACCOUNTS_SECTION_LIMIT);
}
