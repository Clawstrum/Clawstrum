import type { Store } from './store.js';
import type { Account } from './types.js';

/**
 * A per-conversation model request, set by `clawstrum switch SESSION ACCOUNT --model M` (or the
 * Discord switch command) and stored as metadata `model-override:<session id>`. It names the
 * account too, so it only applies while that account is still the conversation's preferred one.
 */
export interface ModelOverride {
  account: string;
  model: string;
}
const key = (sessionId: string) => `model-override:${sessionId}`;

export function getModelOverride(store: Store, sessionId: string): ModelOverride | undefined {
  const row = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    key(sessionId),
  );
  if (!row) return undefined;
  try {
    const value = JSON.parse(row.value) as Partial<ModelOverride>;
    return typeof value.account === 'string' && typeof value.model === 'string'
      ? { account: value.account, model: value.model }
      : undefined;
  } catch {
    return undefined;
  }
}
/** model null clears the override. */
export function setModelOverride(
  store: Store,
  sessionId: string,
  account: string,
  model: string | null,
): void {
  if (model === null) store.exec('DELETE FROM metadata WHERE key=?', key(sessionId));
  else
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key(sessionId),
      JSON.stringify({ account, model }),
    );
}
/** The word that clears an override in `switch ... --model`. */
export const DEFAULT_MODEL_WORD = 'default';

/** Split a switch control argument, "ACCOUNT" or "ACCOUNT MODEL", written by the CLI and Discord. */
export function parseSwitchArgument(argument: string | null): {
  account: string | null;
  model: string | null;
} {
  const [account, model] = (argument ?? '').trim().split(/\s+/);
  return { account: account || null, model: model && model !== DEFAULT_MODEL_WORD ? model : null };
}
export function formatSwitchArgument(account: string, model: string | undefined): string {
  return model ? `${account} ${model}` : account;
}

/**
 * The account with the requested model first. The account's own primary model and fallbacks follow
 * in order, so a refusal or an exhausted model-specific limit falls back with the usual notice
 * instead of failing the conversation. Account-wide limits still apply to every model.
 */
export function withModelOverride(account: Account, model: string): Account {
  if (account.model === model) return account;
  const own = [
    ...(account.model ? [{ model: account.model, quotaBuckets: account.quotaBuckets ?? [] }] : []),
    ...(account.modelFallbacks ?? []),
  ];
  const requested = own.find((m) => m.model === model);
  return {
    ...account,
    model,
    quotaBuckets: requested?.quotaBuckets ?? [],
    modelFallbacks: own.filter((m) => m.model !== model),
  };
}
