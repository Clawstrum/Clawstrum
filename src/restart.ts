import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { lockStatus } from './lock.js';

export interface DaemonInstance {
  id: string;
  pid: number;
  startedAt: number;
  supervised: boolean;
}
export interface RestartRequest {
  id: string;
  instance: string;
  requestedAt: number;
  deadline: number;
  /** After the grace period, checkpoint and requeue active turns before exiting. */
  checkpointAt?: number;
  status: 'requested' | 'draining' | 'restarting' | 'ready' | 'cancelled' | 'timed_out';
  readyAt?: number;
  readyPid?: number;
  readyInstance?: string;
}
function read<T>(store: Store, key: string): T | undefined {
  const row = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    'operations:' + key,
  );
  return row ? JSON.parse(row.value) : undefined;
}
function write(store: Store, key: string, value: unknown): void {
  store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    'operations:' + key,
    JSON.stringify(value),
  );
}
export function restartStatus(store: Store): RestartRequest | undefined {
  return read(store, 'restart');
}
export function daemonReady(store: Store, supervised: boolean, now = Date.now()): DaemonInstance {
  const instance: DaemonInstance = {
    id: randomUUID(),
    pid: process.pid,
    startedAt: now,
    supervised,
  };
  store.transaction(() => {
    write(store, 'daemon', instance);
    store.exec(
      "INSERT INTO metadata(key,value) VALUES('heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      String(now),
    );
    const request = restartStatus(store);
    if (
      request &&
      ['requested', 'draining', 'restarting'].includes(request.status) &&
      request.instance !== instance.id
    ) {
      request.status = 'ready';
      request.readyAt = now;
      request.readyPid = instance.pid;
      request.readyInstance = instance.id;
      write(store, 'restart', request);
    }
  });
  return instance;
}
export function requestRestart(
  store: Store,
  timeoutMs = 3600000,
  now = Date.now(),
  drainMs = 30000,
): RestartRequest {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86400000)
    throw new Error('Restart timeout must be between 1000 and 86400000 ms');
  if (!Number.isSafeInteger(drainMs) || drainMs < 0 || drainMs > 86400000)
    throw new Error('Restart drain must be between 0 and 86400000 ms; 0 waits for idle');
  return store.transaction(() => {
    const instance = read<DaemonInstance>(store, 'daemon');
    const owner = lockStatus(store.home);
    const heartbeat = Number(
      store.get<{ value: string }>("SELECT value FROM metadata WHERE key='heartbeat'")?.value ?? 0,
    );
    if (!instance || !owner.live || owner.pid !== instance.pid || now - heartbeat > 15000)
      throw new Error('No ready, responsive daemon supports coordinated restart');
    if (!instance.supervised)
      throw new Error(
        'Coordinated restart needs supervision. Use the generated service, or set CLAWSTRUM_SUPERVISED=1 under a supervisor that restarts exit code 75.',
      );
    const previous = restartStatus(store);
    if (
      previous &&
      previous.instance === instance.id &&
      ['requested', 'draining', 'restarting'].includes(previous.status)
    )
      return previous;
    const request: RestartRequest = {
      id: randomUUID(),
      instance: instance.id,
      requestedAt: now,
      deadline: now + timeoutMs,
      ...(drainMs > 0 ? { checkpointAt: now + drainMs } : {}),
      status: 'requested',
    };
    write(store, 'restart', request);
    return request;
  });
}
export function cancelRestart(store: Store): boolean {
  return store.transaction(() => {
    const request = restartStatus(store);
    if (!request || !['requested', 'draining'].includes(request.status)) return false;
    request.status = 'cancelled';
    write(store, 'restart', request);
    return true;
  });
}
/** Refreshed before admission in the daemon's synchronous tick. */
export function drainingRestart(store: Store, instance: string, now = Date.now()): boolean {
  return store.transaction(() => {
    const request = restartStatus(store);
    if (
      !request ||
      request.instance !== instance ||
      !['requested', 'draining'].includes(request.status)
    )
      return false;
    request.status = now >= request.deadline ? 'timed_out' : 'draining';
    write(store, 'restart', request);
    return request.status === 'draining';
  });
}
export function commitRestart(
  store: Store,
  instance: string,
  now = Date.now(),
  idle = true,
): boolean {
  return store.transaction(() => {
    const request = restartStatus(store);
    if (
      !request ||
      request.instance !== instance ||
      request.status !== 'draining' ||
      now >= request.deadline
    )
      return false;
    const busy = store.get<{ n: number }>(`SELECT
      (SELECT count(*) FROM runs WHERE status='running') +
      (SELECT count(*) FROM delegations WHERE status IN ('queued','running')) +
      (SELECT count(*) FROM outbox WHERE status='pending') n`)!.n;
    if ((busy || !idle) && !(request.checkpointAt !== undefined && now >= request.checkpointAt))
      return false;
    request.status = 'restarting';
    write(store, 'restart', request);
    return true;
  });
}
export async function waitForRestart(
  store: Store,
  id: string,
  waitMs: number,
): Promise<RestartRequest> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const request = restartStatus(store);
    if (!request || request.id !== id) throw new Error('Restart request was replaced');
    if (request.status === 'ready' && request.readyInstance !== request.instance) return request;
    if (['cancelled', 'timed_out'].includes(request.status))
      throw new Error('Restart ' + request.status);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    'Timed out waiting for a ready daemon. Inspect restart status and supervisor logs; this does not cancel a pending request.',
  );
}
