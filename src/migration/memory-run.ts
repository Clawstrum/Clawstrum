import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../config.js';
import type { Store } from '../store.js';
import { AccountPool, classifyError, accountRoute } from '../accounts.js';
import { accountEnvironment } from '../providers.js';
import { supervisedProviders } from '../supervisor.js';
import { consolidateMemory, consolidationCoverage } from '../consolidation.js';
import { historyBytes } from '../history.js';
import { prepareMemoryMigration, finishMemoryMigration, moveChannelWorkspaces } from './memory.js';
import { recordUsage } from '../usage.js';
import { abortAfter } from '../async.js';
import { importNativeHistory } from './native-history.js';
import type { Provider, ProviderName } from '../types.js';

/** Caller owns the idle/daemon lock. No Discord client, user tools, or work dispatch is started. */
export async function migrateMemory(
  store: Store,
  config: Config,
  options: {
    channelsRoot?: string;
    progress?: (event: unknown) => void;
    adapters?: Record<ProviderName, Provider>;
  } = {},
): Promise<void> {
  store.exec(
    "INSERT INTO metadata(key,value) VALUES('memory-layout-required','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );
  const scopes = prepareMemoryMigration(store);
  importNativeHistory(store, config);
  const pool = new AccountPool(config.accounts, store, config.runtime.unknownQuotaCooldownMs);
  const used = new Map<string, number>();
  const migrateScope = async (scope: (typeof scopes)[number]) => {
    const sessionId = scope.sessionId;
    if (
      !scope.pending &&
      !(
        sessionId &&
        (store.session(sessionId).remote_id ||
          historyBytes(store, sessionId, consolidationCoverage(store, sessionId)) > 0)
      )
    )
      return;
    options.progress?.({
      event: 'memory_migration_scope',
      scope: sessionId ?? 'shared',
      sources: scope.sources,
    });
    const excluded = new Set<string>();
    for (;;) {
      const status = await consolidateMemory({
        store,
        sessionId,
        config: { ...config.runtime.consolidation, enabled: true },
        force: true,
        rotate: true,
        call: async (request) => {
          for (;;) {
            request.signal.throwIfAborted();
            const unavailable = new Set(excluded);
            for (const candidate of config.accounts)
              if ((used.get(candidate.id) ?? 0) >= candidate.maxConcurrent)
                unavailable.add(candidate.id);
            const account = pool.choose(null, null, unavailable);
            if (!account && pool.choose(null, null, excluded)) {
              await delay(100, undefined, { signal: request.signal });
              continue;
            }
            if (!account)
              throw new Error(
                'Migration is saved; no subscription account currently has capacity. Retry memory migrate when available.',
              );
            used.set(account.id, (used.get(account.id) ?? 0) + 1);
            const invocationId = `migration:${request.id}:${randomUUID()}`;
            const model = config.runtime.consolidation.models[account.provider] ?? account.model;
            const routed = { ...account, model, effort: config.runtime.consolidation.effort };
            if (routed.provider === 'codex' && routed.effort === 'max') routed.effort = 'xhigh';
            const controller = new AbortController();
            const abort = () => controller.abort(request.signal.reason);
            request.signal.addEventListener('abort', abort, { once: true });
            if (request.signal.aborted) abort();
            try {
              return await abortAfter(
                (options.adapters ?? supervisedProviders)[account.provider].run({
                  account: routed,
                  prompt: request.prompt,
                  instructions: request.instructions,
                  cwd: sessionId ? store.session(sessionId).workspace : store.home,
                  controller,
                  env: accountEnvironment(routed, config.accounts),
                  mcp: { command: process.execPath, args: [], env: {} },
                  toolless: true,
                  maxTurns: 1,
                  abortGraceMs: config.runtime.abortGraceMs,
                  onEvent: (event) => {
                    if (event.quota)
                      pool.quota(account, event.quota, config.runtime.proactiveThreshold);
                    if (event.usage && sessionId)
                      recordUsage(store, {
                        id: invocationId,
                        sessionId,
                        role: 'consolidator',
                        provider: account.provider,
                        account: account.id,
                        model,
                        snapshot: event.usage,
                      });
                  },
                }),
                controller.signal,
                config.runtime.abortGraceMs + 2500,
              );
            } catch (error) {
              const failure = classifyError(error);
              if (!['quota', 'auth'].includes(failure.kind) || controller.signal.aborted)
                throw error;
              pool.fail(account, failure);
              excluded.add(accountRoute(account));
            } finally {
              request.signal.removeEventListener('abort', abort);
              used.set(account.id, (used.get(account.id) ?? 1) - 1);
            }
          }
        },
      });
      options.progress?.({
        event: 'memory_migration_progress',
        scope: sessionId ?? 'shared',
        status,
      });
      if (status === 'committed') {
        finishMemoryMigration(store, sessionId);
        break;
      }
    }
  };
  // Shared memory is the baseline for all channels; independent channel passes can use spare
  // credential slots concurrently. Await every pass before attempting a workspace relocation.
  const shared = scopes.find((scope) => scope.sessionId === null);
  if (shared) await migrateScope(shared);
  // Start large backlogs early so one old, busy channel does not become the entire offline tail.
  const channels = scopes
    .filter((scope) => scope.sessionId !== null)
    .map((scope) => ({
      ...scope,
      backlog: historyBytes(store, scope.sessionId!, consolidationCoverage(store, scope.sessionId)),
    }))
    .sort((a, b) => b.backlog - a.backlog);
  let next = 0;
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(config.runtime.maxConcurrent, channels.length) }, async () => {
      while (next < channels.length) {
        const scope = channels[next++]!;
        try {
          await migrateScope(scope);
        } catch (error) {
          failures.push(error);
          options.progress?.({
            event: 'memory_migration_deferred',
            scope: scope.sessionId,
            error: String(error),
          });
        }
      }
    }),
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      'Migration progress is saved; resolve deferred scopes and retry before starting the daemon',
    );
  moveChannelWorkspaces(store, options.channelsRoot ?? path.join(store.home, 'channels'));
  store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    'memory-layout',
    '"agents-v1"',
  );
  store.exec("DELETE FROM metadata WHERE key='memory-layout-required'");
  options.progress?.({ event: 'memory_migration_complete' });
}
