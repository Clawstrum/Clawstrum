import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './store.js';
import type { Config } from './config.js';
import { lockStatus } from './lock.js';
import { listWatches } from './watches.js';
import { restartStatus } from './restart.js';
import { storagePolicy } from './storage.js';
import { lastFile } from './boot-guard.js';

type StatFs = (dir: string) => Pick<fs.StatsFs, 'bavail' | 'blocks' | 'bsize' | 'type'>;

export function healthChecks(
  store: Store,
  config: Config,
  now = Date.now(),
  statfs: StatFs = fs.statfsSync,
) {
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  const count = (sql: string, ...params: Array<string | number>) =>
    store.get<{ n: number }>(sql, ...params)!.n;
  const watches = listWatches(store).filter((watch) => watch.status === 'active');
  const backlog =
    count("SELECT count(*) n FROM inbound WHERE status IN ('queued','running')") +
    count("SELECT count(*) n FROM delegations WHERE status IN ('queued','running')") +
    count("SELECT count(*) n FROM cluster_jobs WHERE status IN ('watching','submitting')") +
    watches.length;
  // Only due tasks count: setup schedules the nightly review before the daemon has ever started.
  const dueTasks = count(
    "SELECT count(*) n FROM tasks WHERE status='active' AND next_run<?",
    now - 60000,
  );
  const heartbeat = Number(
    store.get<{ value: string }>("SELECT value FROM metadata WHERE key='heartbeat'")?.value ?? 0,
  );
  const lock = lockStatus(store.home);
  const restart = restartStatus(store);
  if (restart)
    checks.push({
      check: 'Planned restart',
      ok:
        restart.status !== 'timed_out' &&
        (!['requested', 'draining', 'restarting'].includes(restart.status) ||
          now < restart.deadline + 60000),
      detail: restart.status,
    });
  const overdue = watches.filter(
    (watch) => Math.min(watch.nextCheck, watch.deadline) < now - 60000,
  ).length;
  if (watches.length)
    checks.push({ check: 'Overdue condition watches', ok: overdue === 0, detail: String(overdue) });
  const newInstallation = !heartbeat && !backlog && !dueTasks;
  checks.push({
    check: 'Daemon',
    ok: lock.live ? heartbeat > now - 30000 : newInstallation,
    detail: `${lock.detail}; heartbeat ${heartbeat ? new Date(heartbeat).toISOString() : 'never'}${newInstallation ? ' (new installation)' : ''}`,
  });
  for (const [check, n] of [
    ['Overdue tasks', dueTasks],
    ['Failed schedules', count("SELECT count(*) n FROM tasks WHERE status='failed'")],
    [
      'Stalled queue',
      count(
        "SELECT count(*) n FROM inbound i WHERE status='queued' AND available_at<? AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.session_id=i.session_id AND r.status='running')",
        now - 300000,
      ),
    ],
    [
      'Stalled runs',
      count(
        "SELECT count(*) n FROM runs WHERE status='running' AND started_at<?",
        now - (config.runtime.turnTimeoutMs || 7200000),
      ),
    ],
    [
      'Unknown cluster submissions',
      count("SELECT count(*) n FROM cluster_jobs WHERE status='unknown'"),
    ],
    [
      'Overdue cluster watches',
      count(
        "SELECT count(*) n FROM cluster_jobs WHERE status='watching' AND next_check<?",
        now - 60000,
      ),
    ],
    [
      'Stalled research subagents',
      // With no time limit, a subagent is stalled when it has done nothing for 30 minutes.
      config.research.workers.timeoutMs
        ? count(
            "SELECT count(*) n FROM delegations WHERE status='running' AND started_at<?",
            now - config.research.workers.timeoutMs,
          )
        : count(
            "SELECT count(*) n FROM delegations d LEFT JOIN metadata m ON m.key='worker-profile:'||d.id WHERE d.status='running' AND COALESCE(json_extract(m.value,'$.lastActivityAt'),d.started_at)<?",
            now - 1800000,
          ),
    ],
    ['Failed deliveries', count("SELECT count(*) n FROM outbox WHERE status='failed'")],
  ] as const)
    checks.push({ check, ok: n === 0, detail: `${n}` });
  const disk = statfs(store.home);
  checks.push(diskCheck(disk.bavail * disk.bsize, disk.blocks * disk.bsize));
  // STORAGE.json can put the database on another disk; a full one stops SQLite writes just the same.
  let dbDir = store.home;
  try {
    dbDir = storagePolicy(store.home).directory;
  } catch {
    // The store is open, so the policy was valid when it opened; keep the home check alone.
  }
  if (path.resolve(dbDir) !== path.resolve(store.home)) {
    try {
      const db = statfs(dbDir);
      const same = db.type === disk.type && db.blocks === disk.blocks && db.bsize === disk.bsize;
      if (!same)
        checks.push({
          ...diskCheck(db.bavail * db.bsize, db.blocks * db.bsize),
          check: 'Database disk space',
        });
    } catch (error) {
      checks.push({
        check: 'Database disk space',
        ok: false,
        detail: `cannot read ${dbDir}: ${(error as Error).message}`,
      });
    }
  }
  let last: { rolledBackAt?: number; reason?: string } | undefined;
  try {
    last = JSON.parse(fs.readFileSync(lastFile(store.home), 'utf8'));
  } catch {
    // No apply has finished yet.
  }
  if (last?.rolledBackAt)
    checks.push({
      check: 'Last code change',
      ok: true,
      detail: `rolled back at ${new Date(last.rolledBackAt).toISOString()}: ${last.reason ?? 'unknown reason'}`,
    });
  for (const name of ['.env', 'config.json']) {
    const file = path.join(store.home, name);
    if (!fs.existsSync(file)) continue;
    const mode = fs.statSync(file).mode & 0o777;
    checks.push({
      check: `${name} permissions`,
      ok: process.platform === 'win32' || (mode & 0o077) === 0,
      detail: `${mode.toString(8)}${mode & 0o077 ? '; run chmod 600 on this file' : ''}`,
    });
  }
  return checks;
}

// A full disk stops SQLite writes and the heartbeat, and the daemon cannot write its own error.
export function diskCheck(free: number, total: number) {
  const gib = (n: number) => `${(n / 2 ** 30).toFixed(1)} GiB`;
  return {
    check: 'Disk space',
    ok: free >= Math.max(2 ** 30, total * 0.02),
    detail: `${gib(free)} free of ${gib(total)}`,
  };
}

/** Post failing checks once per distinct failing set, and once when they all pass again. */
export async function notifyHealth(
  store: Store,
  checks: Array<{ check: string; ok: boolean; detail: string }>,
  post: (content: string) => Promise<void>,
): Promise<boolean> {
  const failing = checks.filter((c) => !c.ok);
  const key = failing.map((c) => c.check).join('\n');
  const last = store.get<{ value: string }>(
    "SELECT value FROM metadata WHERE key='health_notified'",
  )?.value;
  if (key === (last ?? '')) return false;
  await post(
    failing.length
      ? `Clawstrum health check failing:\n${failing.map((c) => `- ${c.check}: ${c.detail}`).join('\n')}`
      : 'Clawstrum health checks pass again.',
  );
  try {
    store.exec(
      "INSERT INTO metadata(key,value) VALUES('health_notified',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
    );
  } catch {
    // Disk full or database locked: the next run posts again, which is the safer failure.
  }
  return true;
}
