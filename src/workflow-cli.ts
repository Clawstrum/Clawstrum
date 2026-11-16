import { usageProfile, usageMarkdown } from './usage-profile.js';
import { readConfig, saveConfig } from './config.js';
import { hostTimeZone } from './context.js';
import fs from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { workerReport } from './research/worker-profile.js';
import { decisionProfile } from './decisions/profile.js';
import { performanceReport } from './performance.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { storagePolicy } from './storage.js';
import { writePrivate } from './files.js';
import { liveBackup, verifySnapshot } from './backups.js';
import { lintDecisionFile } from './decisions.js';
import { lintFigureFile } from './figures.js';
import { lintProseFile } from './prose.js';
import { addWatch, cancelWatch, listWatches } from './watches.js';
import { requestRestart, restartStatus, cancelRestart, waitForRestart } from './restart.js';
import { backupUnits, healthUnits } from './service.js';
import {
  collectReview,
  completeReview,
  pendingReviewDays,
  localDay,
  dayWindow,
  shiftDay,
  reviewOptionsSchema,
  validateDay,
  ensureReviewTask,
} from './review.js';
import { ensureReviewChannelGuide } from './memory.js';

function options(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++)
    if (args[i]!.startsWith('--')) {
      const key = args[i]!.slice(2);
      result[key] = args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i]! : 'true';
    }
  return result;
}
function need(value: string | undefined, usage: string): string {
  if (!value || value.startsWith('--')) throw new Error(usage);
  return value;
}
function json(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
/** Operator/workflow commands do not load model credentials or send Discord messages. */
export async function workflowCommand(args: string[], home: string): Promise<boolean> {
  const [command, action, ...rest] = args;
  const opts = options(rest);
  if (command === 'usage') {
    if (action !== 'profile')
      throw Error(
        'usage profile [SESSION] [--day YYYY-MM-DD|today|yesterday] [--timezone ZONE] [--since ISO --until ISO] [--format json|markdown]',
      );
    if (opts.day && (opts.since || opts.until))
      throw Error('Use --day or --since/--until, not both');
    if (opts.format && !['json', 'markdown'].includes(opts.format))
      throw Error('Use --format json or markdown');
    const config = readConfig(home),
      now = Date.now();
    const timezone =
      opts.timezone ?? config.runtime.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    let since = opts.since === undefined ? now - 86400000 : Date.parse(opts.since),
      until = opts.until === undefined ? now : Date.parse(opts.until);
    if (opts.day) {
      const day =
        opts.day === 'today'
          ? localDay(now, timezone)
          : opts.day === 'yesterday'
            ? shiftDay(localDay(now, timezone), -1)
            : opts.day;
      const window = dayWindow(day, timezone);
      since = window.start;
      until = window.end;
    }
    const db = new DatabaseSync(path.join(storagePolicy(home).directory, 'clawstrum.db'), {
      readOnly: true,
    });
    try {
      db.exec('PRAGMA busy_timeout=2000');
      const report = usageProfile(
        {
          get<T>(sql: string, ...params: SQLInputValue[]) {
            return db.prepare(sql).get(...params) as T | undefined;
          },
          all<T>(sql: string, ...params: SQLInputValue[]) {
            return db.prepare(sql).all(...params) as T[];
          },
        },
        {
          since,
          until,
          now,
          sessionId: rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined,
          roles: Object.keys(config.research.workers.roles),
        },
      );
      if (opts.format === 'markdown') console.log(usageMarkdown(report));
      else print(report);
    } finally {
      db.close();
    }
    return true;
  }
  if (command === 'performance') {
    const flags = options(args.slice(1));
    const db = new DatabaseSync(path.join(storagePolicy(home).directory, 'clawstrum.db'), {
      readOnly: true,
    });
    try {
      db.exec('PRAGMA busy_timeout=5000');
      // Deliberately no long read transaction: reports must not pin NFS rollback-journal writers.
      print(
        performanceReport(
          {
            get<T>(sql: string, ...params: SQLInputValue[]) {
              return db.prepare(sql).get(...params) as T | undefined;
            },
            all<T>(sql: string, ...params: SQLInputValue[]) {
              return db.prepare(sql).all(...params) as T[];
            },
          },
          {
            sessionId: action && !action.startsWith('--') ? action : undefined,
            since: flags.since === undefined ? undefined : Date.parse(flags.since),
            limit: Number(flags.limit ?? 20),
          },
        ),
      );
    } finally {
      db.close();
    }
    return true;
  }
  if (command === 'workers' || command === 'subagents' || command === 'jev') {
    if (action !== 'profile')
      throw new Error(`${command} profile [SESSION] [--since ISO_DATE] [--limit 100] [--offset 0]`);
    const policy = storagePolicy(home);
    const db = new DatabaseSync(path.join(policy.directory, 'clawstrum.db'), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=10000; BEGIN');
      const reader = {
        get<T>(sql: string, ...params: SQLInputValue[]) {
          return db.prepare(sql).get(...params) as T | undefined;
        },
        all<T>(sql: string, ...params: SQLInputValue[]) {
          return db.prepare(sql).all(...params) as T[];
        },
      };
      print(
        (command === 'jev' ? decisionProfile : workerReport)(reader, {
          sessionId: rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined,
          since: opts.since === undefined ? 0 : Date.parse(opts.since),
          limit: Number(opts.limit ?? 100),
          offset: Number(opts.offset ?? 0),
        }),
      );
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    return true;
  }
  if (command === 'decisions') {
    if (action !== 'lint') throw new Error('decisions lint FILE [--shared-target FILE]');
    const findings = lintDecisionFile(need(rest[0], 'decisions lint FILE'), opts['shared-target']);
    print({ advisory: true, findings });
    if (findings.length) process.exitCode = 1;
    return true;
  }
  if (command === 'figures') {
    if (action !== 'lint') throw new Error('figures lint FILE');
    const findings = lintFigureFile(need(rest[0], 'figures lint FILE'));
    print({ advisory: true, findings });
    if (findings.length) process.exitCode = 1;
    return true;
  }
  if (command === 'prose') {
    if (action !== 'lint') throw new Error('prose lint FILE');
    const findings = lintProseFile(need(rest[0], 'prose lint FILE'));
    print({ advisory: true, findings });
    if (findings.length) process.exitCode = 1;
    return true;
  }
  if (command === 'backup' && (action === 'live' || action === 'verify')) {
    const directory = need(rest[0], `backup ${action} DIRECTORY`);
    print(
      action === 'verify'
        ? verifySnapshot(directory)
        : await liveBackup(home, directory, {
            keepLast: opts['keep-last'] === undefined ? undefined : Number(opts['keep-last']),
            keepDays: opts['keep-days'] === undefined ? undefined : Number(opts['keep-days']),
          }),
    );
    return true;
  }
  if (command === 'service' && (action === 'backup' || action === 'health')) {
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
    const interval = Number(opts['interval-seconds'] ?? 300);
    const units =
      action === 'health'
        ? healthUnits(home, process.execPath, cli, interval)
        : backupUnits(
            home,
            process.execPath,
            cli,
            path.resolve(
              need(
                opts.directory,
                'service backup --directory DIRECTORY [--output UNIT_DIRECTORY]',
              ),
            ),
            interval,
            Number(opts['keep-last'] ?? 12),
            Number(opts['keep-days'] ?? 7),
          );
    if (opts.output) {
      const unit = path.join(path.resolve(opts.output), `clawstrum-${action}`);
      writePrivate(`${unit}.service`, units.service);
      writePrivate(`${unit}.timer`, units.timer);
      print({
        directory: path.resolve(opts.output),
        enable: `systemctl --user daemon-reload && systemctl --user enable --now clawstrum-${action}.timer`,
      });
    } else print(units);
    return true;
  }
  if (command === 'review') {
    if (action === 'schedule') {
      const channelId = need(
        opts.channel,
        'review schedule --channel ID [--at HH:MM] [--timezone ZONE]',
      );
      if (!/^\d{5,25}$/.test(channelId)) throw new Error('Channel id must be a Discord snowflake');
      const config = readConfig(home);
      const at = opts.at ?? config.review.at;
      const timezone = opts.timezone ?? config.runtime.timezone ?? hostTimeZone();
      if (config.review.channelId !== channelId || config.review.at !== at) {
        const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
        if (!raw.discord.channelIds.includes(channelId)) raw.discord.channelIds.push(channelId);
        raw.review = { channelId, at };
        saveConfig(home, raw);
      }
      const store = new Store(home);
      try {
        const session = store.ensureSession(channelId);
        ensureReviewChannelGuide(store, session.id);
        print({
          channel: channelId,
          task: ensureReviewTask(store, channelId, at, timezone),
          at,
          timezone,
        });
      } finally {
        store.close();
      }
      return true;
    }
    const settings = reviewOptionsSchema.parse(opts.config ? json(opts.config) : {});
    const directory = path.resolve(opts.output ?? path.join(home, 'reviews'));
    if (action === 'complete') {
      completeReview(
        directory,
        need(opts.date, 'review complete --date DAY --report FILE'),
        need(opts.report, 'review complete --date DAY --report FILE'),
      );
      print({ day: opts.date, reviewed: true });
    } else if (action === 'collect' || action === 'pending') {
      const through = opts.through ?? shiftDay(localDay(Date.now(), settings.timezone), -1);
      const days = opts.date
        ? [validateDay(opts.date)]
        : pendingReviewDays(directory, opts.from ?? shiftDay(through, -6), through, settings);
      if (action === 'pending') print(days);
      else print(days.length ? await collectReview(home, directory, days, settings) : []);
    } else
      throw new Error(
        'review collect|pending [--date DAY | --from DAY --through DAY] [--config JSON] [--output DIRECTORY] | review complete --date DAY --report FILE | review schedule --channel ID [--at HH:MM] [--timezone ZONE]',
      );
    return true;
  }
  if (command !== 'watch' && command !== 'restart') return false;
  if (!fs.existsSync(path.join(storagePolicy(home).directory, 'clawstrum.db')))
    throw new Error('Clawstrum state database is missing');
  const store = new Store(home);
  try {
    if (command === 'watch') {
      if (action === 'list') print(listWatches(store, rest[0]));
      else if (action === 'cancel')
        print({ cancelled: cancelWatch(store, need(rest[0], 'watch cancel ID')) });
      else if (action === 'add')
        print(
          addWatch(
            store,
            need(rest[0], 'watch add SESSION --key KEY --input JSON'),
            need(opts.key, 'Watch needs --key KEY'),
            json(need(opts.input, 'Watch needs --input JSON')),
          ),
        );
      else
        throw new Error(
          'watch add SESSION --key KEY --input JSON | watch list [SESSION] | watch cancel ID',
        );
    } else {
      if (action === 'status') print(restartStatus(store) ?? null);
      else if (action === 'cancel') print({ cancelled: cancelRestart(store) });
      else if (action === 'request') {
        const timeout = Number(opts['timeout-ms'] ?? 3600000);
        const request = requestRestart(
          store,
          timeout,
          Date.now(),
          Number(opts['drain-ms'] ?? 30000),
        );
        print(opts.wait ? await waitForRestart(store, request.id, timeout + 60000) : request);
      } else
        throw new Error(
          'restart request [--timeout-ms N] [--drain-ms N] [--wait] | restart status | restart cancel',
        );
    }
  } finally {
    store.close();
  }
  return true;
}
