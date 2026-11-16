import type { Config } from './config.js';

type Reloader = () => { accounts: Config['accounts']; added: string[]; removed: string[] } | null;
interface Target {
  reloadAccounts(accounts: Config['accounts']): void;
}
/**
 * One daemon-tick step: apply a changed account list to the running engine. A valid change is
 * logged as `accounts_reloaded` with account ids only. A file that fails to load keeps the old list
 * and is logged as `accounts_reload_failed`; the error text names the problem, never file content.
 */
export function applyAccountReload(
  reload: Reloader,
  engine: Target,
  log: Pick<Console, 'log' | 'error'> = console,
): void {
  try {
    const change = reload();
    if (!change) return;
    engine.reloadAccounts(change.accounts);
    log.log(
      JSON.stringify({
        event: 'accounts_reloaded',
        at: new Date().toISOString(),
        ids: change.accounts.map((a) => a.id),
        added: change.added,
        removed: change.removed,
      }),
    );
  } catch (error) {
    log.error(
      JSON.stringify({
        event: 'accounts_reload_failed',
        at: new Date().toISOString(),
        error: String(error),
      }),
    );
  }
}
