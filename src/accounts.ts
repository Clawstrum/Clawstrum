import type { Account, ProviderEvent } from './types.js';
import type { Store } from './store.js';
import { isDatabaseBusy } from './storage.js';

export type FailureKind =
  | 'quota'
  | 'auth'
  | 'context'
  | 'session'
  | 'transient'
  | 'budget'
  | 'fatal';
export class ProviderFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly retryAt?: number,
    readonly bucket?: string,
  ) {
    super(message);
  }
}
export function classifyError(error: unknown): ProviderFailure {
  if (error instanceof ProviderFailure) return error;
  // Local SQLite contention is temporary; retrying keeps the saved input instead of dropping the request.
  if (isDatabaseBusy(error)) return new ProviderFailure('transient', 'database is locked');
  const message = error instanceof Error ? error.message : String(error);
  const sdkErrors: Record<string, FailureKind> = {
    authentication_failed: 'auth',
    oauth_org_not_allowed: 'auth',
    account_on_hold: 'auth',
    verification_required: 'auth',
    cloud_credential_error: 'auth',
    billing_error: 'auth',
    rate_limit: 'quota',
    overloaded: 'transient',
    server_error: 'transient',
    invalid_request: 'fatal',
    model_not_found: 'fatal',
    unknown: 'fatal',
    max_output_tokens: 'fatal',
  };
  if (sdkErrors[message]) return new ProviderFailure(sdkErrors[message], message);
  if (
    /usage[_ ]limit|rate[_ -]?limit|hit your (session )?limit|quota.{0,30}(exceed|exhaust)|\b429\b/i.test(
      message,
    )
  )
    return new ProviderFailure('quota', message);
  if (
    /authentication|unauthorized|invalid.{0,12}(token|credential)|token.{0,12}expired|\b401\b|not logged in/i.test(
      message,
    )
  )
    return new ProviderFailure('auth', message);
  if (/prompt.{0,10}too long|context.{0,20}(exceed|length)|maximum context/i.test(message))
    return new ProviderFailure('context', message);
  if (
    /(session|thread).{0,40}(not found|missing|does not exist)|no conversation found/i.test(message)
  )
    return new ProviderFailure('session', message);
  if (
    /\b(500|502|503|504|529)\b|overloaded|ECONNRESET|ETIMEDOUT|fetch failed|startup timeout|TimeoutError|timed out/i.test(
      message,
    )
  )
    return new ProviderFailure('transient', message);
  return new ProviderFailure('fatal', message);
}
/** The provider said this account has no such model or no access to it, as opposed to a bad request. */
export function isModelRefusal(failure: ProviderFailure): boolean {
  return (
    failure.kind === 'fatal' &&
    /model_not_found|model[^.\n]{0,40}(may not exist|does not exist|not found)|(may not|do not|don't) have access to (the |this )?model|you may not have access/i.test(
      failure.message,
    )
  );
}
/** A model route shares its account's credentials and concurrency cap. */
export function accountRoute(account: Account): string {
  return JSON.stringify([account.id, account.model ?? null]);
}
export interface AccountState {
  id: string;
  cooldown_until: number;
  disabled: number;
  reason: string | null;
  usage_json: string | null;
}
export class AccountPool {
  constructor(
    public accounts: Account[],
    readonly store: Store,
    readonly cooldownMs: number,
    readonly strainThreshold = 1,
    public quotaScopes: Account[] = accounts,
  ) {
    this.register();
  }
  private register(): void {
    for (const a of this.accounts)
      this.store.exec(
        'INSERT OR IGNORE INTO accounts(id,updated_at) VALUES(?,?)',
        a.id,
        Date.now(),
      );
  }
  /**
   * Swap the account list while the daemon runs (the registry or config.json changed). Nothing
   * already running is touched; the next routing decision sees the new list, priorities and models.
   * Cooldown and quota rows are keyed by account id, so an account that stays keeps its state.
   */
  replaceAccounts(accounts: Account[], quotaScopes: Account[] = accounts): void {
    this.accounts = accounts;
    this.quotaScopes = quotaScopes;
    this.register();
  }
  private variants(account: Account): Account[] {
    return [account, ...(account.modelFallbacks ?? []).map((model) => ({ ...account, ...model }))];
  }
  private scoped(account: Account, bucket?: string): boolean {
    return (
      !!bucket &&
      this.variants(this.quotaScopes.find((a) => a.id === account.id) ?? account).some((a) =>
        a.quotaBuckets?.includes(bucket),
      )
    );
  }
  private readyAt(account: Account): number {
    const state = this.store.get<AccountState>('SELECT * FROM accounts WHERE id=?', account.id);
    if (!state || state.disabled) return Infinity;
    const buckets = this.store.all<{ bucket: string; cooldown_until: number }>(
      'SELECT bucket,cooldown_until FROM account_quotas WHERE account_id=?',
      account.id,
    );
    return Math.max(
      state.cooldown_until,
      ...buckets
        .filter((b) => !this.scoped(account, b.bucket) || account.quotaBuckets?.includes(b.bucket))
        .map((b) => b.cooldown_until),
    );
  }
  /**
   * An account is strained when a quota bucket that has not reset yet already sits at or above the
   * warning threshold. Strained accounts still work, so they are a last resort rather than a block:
   * long windows (seven-day) would otherwise idle the whole fleet for days.
   */
  pressure(account: Account, now = Date.now()): number | undefined {
    const rows = this.store.all<{ bucket: string; usage_json: string | null; updated_at: number }>(
      'SELECT bucket,usage_json,updated_at FROM account_quotas WHERE account_id=?',
      account.id,
    );
    const observed = rows.flatMap((row) => {
      if (this.scoped(account, row.bucket) && !account.quotaBuckets?.includes(row.bucket))
        return [];
      try {
        const quota = JSON.parse(row.usage_json ?? '{}') as {
          utilization?: number;
          resetsAt?: number;
        };
        return typeof quota.utilization === 'number' &&
          Number.isFinite(quota.utilization) &&
          quota.utilization >= 0 &&
          (typeof quota.resetsAt === 'number' && Number.isFinite(quota.resetsAt)
            ? quota.resetsAt > now
            : row.updated_at + this.cooldownMs > now)
          ? [quota.utilization!]
          : [];
      } catch {
        return [];
      }
    });
    return observed.length ? Math.max(...observed) : undefined;
  }
  strained(account: Account, now = Date.now()): boolean {
    return this.strainThreshold < 1 && (this.pressure(account, now) ?? -1) >= this.strainThreshold;
  }
  available(id: string, now: number): boolean {
    const account = this.accounts.find((a) => a.id === id);
    return !!account && this.variants(account).some((a) => this.readyAt(a) <= now);
  }
  choose(
    preferred: string | null,
    active: string | null,
    attempted = new Set<string>(),
    now = Date.now(),
  ): Account | undefined {
    // A deliberate account order takes precedence over model tiers and soft
    // pressure. Availability checks still apply; channel overrides stay explicit.
    const priorities = preferred
      ? [undefined]
      : [...new Set(this.accounts.map((a) => a.priority ?? 0))].sort((a, b) => b - a);
    for (const priority of priorities) {
      const excluded = new Set(attempted);
      if (priority !== undefined)
        for (const account of this.accounts)
          if ((account.priority ?? 0) !== priority) excluded.add(account.id);
      const account = this.chooseAtPriority(preferred, active, excluded, now);
      if (account) return account;
    }
    return undefined;
  }
  private chooseAtPriority(
    preferred: string | null,
    active: string | null,
    attempted: Set<string>,
    now: number,
  ): Account | undefined {
    const ids = [
      ...new Set(
        [preferred, active, ...this.accounts.map((a) => a.id)].filter((id): id is string => !!id),
      ),
    ];
    // Automatic routing exhausts each configured model tier across accounts
    // before downgrading. A warning is not an exhausted entitlement. Explicit
    // account preferences retain their account-first fallback behavior.
    const tiers = preferred
      ? [undefined]
      : Array.from(
          { length: Math.max(...this.accounts.map((a) => this.variants(a).length)) },
          (_, i) => i,
        );
    for (const tier of tiers) {
      for (const strainedAllowed of [false, true]) {
        const candidates: Array<{ account: Account; tier: number; pressure: number | undefined }> =
          [];
        for (const id of ids) {
          const base = this.accounts.find((a) => a.id === id);
          if (!base || attempted.has(id)) continue;
          const route = this.variants(base).find(
            (a, index) =>
              (tier === undefined || index === tier) &&
              !attempted.has(accountRoute(a)) &&
              this.readyAt(a) <= now &&
              (strainedAllowed || !this.strained(a, now)),
          );
          if (route) {
            // An explicit channel preference retains ordered fallback behavior.
            if (preferred) return route;
            candidates.push({
              account: route,
              tier: this.variants(base).findIndex((a) => accountRoute(a) === accountRoute(route)),
              pressure: this.pressure(route, now),
            });
          }
        }
        if (!candidates.length) continue;
        // Keep the configured model tier before downgrading. Unknown quota is not
        // empty quota: favor measured headroom, retaining stable order on ties.
        candidates.sort(
          (a, b) => a.tier - b.tier || (a.pressure ?? Infinity) - (b.pressure ?? Infinity),
        );
        const best = candidates[0]!;
        const current = candidates.find((c) => c.account.id === active && c.tier === best.tier);
        // Avoid moving native conversations for insignificant meter fluctuations.
        if (
          current?.pressure !== undefined &&
          best.pressure !== undefined &&
          current.pressure <= best.pressure + 0.05
        )
          return current.account;
        return best.account;
      }
    }
    return undefined;
  }
  fail(account: Account, failure: ProviderFailure, now = Date.now()): void {
    if (failure.kind === 'auth') {
      this.store.exec(
        "UPDATE accounts SET disabled=1,reason='auth',updated_at=? WHERE id=?",
        now,
        account.id,
      );
    } else if (failure.kind === 'quota') {
      this.recordQuota(
        account,
        {
          rejected: true,
          resetsAt: failure.retryAt,
          bucket: failure.bucket,
        },
        true,
        now,
      );
    }
  }
  private recordQuota(
    account: Account,
    quota: NonNullable<ProviderEvent['quota']>,
    block: boolean,
    now: number,
  ): void {
    const until = block ? Math.max(now + 1000, quota.resetsAt ?? now + this.cooldownMs) : 0;
    this.store.transaction(() => {
      this.store.exec(
        `INSERT INTO account_quotas(account_id,bucket,cooldown_until,usage_json,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(account_id,bucket) DO UPDATE SET cooldown_until=MAX(account_quotas.cooldown_until,excluded.cooldown_until),usage_json=excluded.usage_json,updated_at=excluded.updated_at`,
        account.id,
        quota.bucket ?? 'unknown',
        until,
        JSON.stringify(quota),
        now,
      );
      const buckets = this.store.all(
        'SELECT bucket,cooldown_until,usage_json,updated_at FROM account_quotas WHERE account_id=?',
        account.id,
      );
      this.store.exec(
        'UPDATE accounts SET usage_json=?,updated_at=? WHERE id=?',
        JSON.stringify(buckets),
        now,
        account.id,
      );
      // Model-specific limits stay in the bucket table. Auth and unknown/general limits affect every model.
      if (block && !this.scoped(account, quota.bucket))
        this.store.exec(
          "UPDATE accounts SET cooldown_until=MAX(cooldown_until,?),reason=CASE WHEN disabled THEN reason ELSE 'quota' END,updated_at=? WHERE id=?",
          until,
          now,
          account.id,
        );
    });
  }
  quota(
    account: Account,
    quota: NonNullable<ProviderEvent['quota']>,
    threshold: number,
    now = Date.now(),
  ): boolean {
    const early =
      (quota.bucket === 'five_hour' ||
        quota.bucket === '5h' ||
        this.scoped(account, quota.bucket)) &&
      !!quota.resetsAt;
    const proactive =
      early &&
      quota.utilization !== undefined &&
      Number.isFinite(quota.utilization) &&
      quota.utilization >= threshold;
    this.recordQuota(account, quota, quota.rejected || proactive, now);
    return early;
  }
  nextAvailable(now = Date.now(), excluded: ReadonlySet<string> = new Set()): number | undefined {
    const times = this.accounts
      .filter((a) => !excluded.has(a.id))
      .flatMap((a) => this.variants(a).map((v) => this.readyAt(v)))
      .filter((at) => Number.isFinite(at) && at > now);
    return times.length ? Math.min(...times) : undefined;
  }
  reset(id: string): void {
    if (!this.accounts.some((a) => a.id === id)) throw new Error(`Unknown account: ${id}`);
    this.store.exec(
      'UPDATE accounts SET cooldown_until=0,disabled=0,reason=NULL,usage_json=NULL,updated_at=? WHERE id=?',
      Date.now(),
      id,
    );
    this.store.exec('DELETE FROM account_quotas WHERE account_id=?', id);
    this.store.exec(
      "UPDATE inbound SET available_at=MIN(available_at,?) WHERE status='queued'",
      Date.now(),
    );
  }
}
