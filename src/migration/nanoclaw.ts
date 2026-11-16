import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nextOccurrence } from '../scheduler.js';
import type { Store } from '../store.js';
import { storagePolicy } from '../storage.js';

function timestamp(value: string | null): number {
  if (!value) return 0;
  const iso = value.replace(' ', 'T');
  // NanoClaw's zone-less SQLite timestamps are UTC, not the importing host's local zone.
  const normalized = /(Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : iso + 'Z';
  const result = Date.parse(normalized);
  if (!Number.isFinite(result)) throw new Error(`Invalid legacy timestamp: ${value}`);
  return result;
}

function destinationEmpty(destination: Store | string): boolean {
  if (typeof destination !== 'string')
    return !destination.get<{ n: number }>('SELECT count(*) n FROM sessions')!.n;
  const file = path.join(storagePolicy(destination).directory, 'clawstrum.db');
  if (!fs.existsSync(file)) return true;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return !(db.prepare('SELECT count(*) n FROM sessions').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Match whole path roots, longest first, in one pass so a replacement is never rewritten again. */
function rewritePaths(text: string, roots: string[], replacement: string): string {
  if (!roots.length) return text;
  const alternatives = [...roots]
    .sort((a, b) => b.length - a.length)
    .map((root) => root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return text.replace(
    new RegExp(`(?<![\\w./~-])(?:${alternatives})(?=$|[/\\s"'\x60),;:\\]\\}])`, 'g'),
    () => replacement,
  );
}

/** Import a consistent OFFLINE backup, never a live NanoClaw database.
 * Historical deliveries are inserted as sent and cannot be replayed.
 * Native provider session ids remain provenance, never resumable Clawstrum ids.
 * planNanoClaw reads the same rows and writes nothing, so the conversation ids, workspace
 * paths and schedules an import would create are reviewable before the transaction opens.
 */
export interface NanoClawImportOptions {
  /** Prefix for imported conversation ids. Empty unless the operator asks for one. */
  prefix?: string;
  /** Absolute source-installation roots rewritten to the new installation root in copied text. */
  sourceRoots?: string[];
  /** Timezone for imported schedules; legacy rows carry a wall clock with no zone. */
  timezone?: string;
  /** What to do with an active schedule whose next run has already passed. */
  dueTasks?: 'reschedule' | 'cancel' | 'fire';
  /** Clock deciding which schedules are already due. */
  now?: number;
}

/** Legacy columns each destination table consumes. Anything else survives only in the
 * migration_source and migration_task provenance events, and the plan says which. */
const CONSUMED: Record<string, string[]> = {
  registered_groups: ['jid', 'folder', 'name', 'added_at'],
  messages: [
    'id',
    'chat_jid',
    'sender',
    'sender_name',
    'content',
    'timestamp',
    'is_from_me',
    'is_bot_message',
  ],
  scheduled_tasks: [
    'id',
    'group_folder',
    'chat_jid',
    'prompt',
    'schedule_type',
    'schedule_value',
    'next_run',
    'status',
    'created_at',
  ],
  task_run_logs: ['id', 'task_id', 'run_at', 'duration_ms', 'status', 'result', 'error'],
};

export interface PlannedSession {
  id: string;
  folder: string;
  channel: string;
  name: string;
  workspace: string;
  workspaceExists: boolean;
  queued: number;
}
export interface PlannedTask {
  id: string;
  session: string;
  kind: 'cron' | 'once';
  schedule: string;
  status: string;
  nextRun: string | null;
  /** import keeps the legacy next run; reschedule moves it forward; cancel parks an
   * overdue one-shot that can never be moved forward. */
  action: 'import' | 'reschedule' | 'cancel';
}
export interface NanoClawPlan {
  backup: string;
  prefix: string;
  sourceRoots: string[];
  newRoot: string;
  timezone: string;
  destinationEmpty: boolean;
  counts: {
    groups: number;
    messages: number;
    incoming: number;
    outgoing: number;
    pending: number;
    tasks: number;
    taskRuns: number;
    /** Historical deliveries with no Discord snowflake, imported without a remote id. */
    outgoingWithoutRemoteId: number;
  };
  sessions: PlannedSession[];
  tasks: PlannedTask[];
  rewrites: { root: string; prompts: number }[];
  /** Prompts still naming a NanoClaw installation the rewrite did not cover. */
  residualPaths: { task: string; sample: string }[];
  provenanceOnlyColumns: Record<string, string[]>;
  ignoredChannels: string[];
  warnings: string[];
  /** Conditions that make importNanoClaw throw. An empty list means the import can run. */
  blockers: string[];
}

interface Source {
  groups: any[];
  messages: any[];
  tasks: any[];
  logs: any[];
  lastHandled: Record<string, string>;
  native: Record<string, string>;
  columns: Record<string, string[]>;
}

function readSource(backup: string): Source {
  const source = new DatabaseSync(backup, { readOnly: true });
  try {
    source.exec('BEGIN');
    const integrity = source.prepare('PRAGMA integrity_check').get() as any;
    if (Object.values(integrity)[0] !== 'ok')
      throw new Error('Legacy backup failed integrity check');
    const rows = (table: string): any[] => source.prepare(`SELECT * FROM ${table}`).all();
    const messages = rows('messages').sort(
      (a, b) => timestamp(a.timestamp) - timestamp(b.timestamp),
    );
    const routing = Object.fromEntries(rows('router_state').map((r) => [r.key, r.value]));
    const columns = Object.fromEntries(
      Object.keys(CONSUMED).map((table) => [
        table,
        (source.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => String(c.name)),
      ]),
    );
    return {
      groups: rows('registered_groups'),
      messages,
      tasks: rows('scheduled_tasks'),
      logs: rows('task_run_logs'),
      lastHandled: JSON.parse(routing.last_agent_timestamp || '{}'),
      native: Object.fromEntries(rows('sessions').map((r) => [r.group_folder, r.session_id])),
      columns,
    };
  } finally {
    source.close();
  }
}

function buildPlan(
  empty: boolean,
  source: Source,
  backup: string,
  groupsRoot: string,
  opts: NanoClawImportOptions,
): NanoClawPlan {
  const prefix = opts.prefix ?? '';
  groupsRoot = path.resolve(groupsRoot);
  const sourceRoots = [
    ...new Set(
      (opts.sourceRoots ?? [])
        .filter((root) => path.isAbsolute(root) && path.resolve(root) !== path.parse(root).root)
        .map((root) => path.resolve(root)),
    ),
  ];
  const timezone = opts.timezone ?? 'UTC';
  const dueTasks = opts.dueTasks ?? 'reschedule';
  const now = opts.now ?? Date.now();
  const newRoot = path.dirname(groupsRoot);
  const warnings: string[] = [];
  const blockers: string[] = [];
  if (!empty) blockers.push('Import requires an empty destination database');
  if (!['reschedule', 'cancel', 'fire'].includes(dueTasks))
    blockers.push('Unknown due-task policy');
  if (!Number.isFinite(now)) blockers.push('Invalid import clock');
  for (const root of opts.sourceRoots ?? [])
    if (!path.isAbsolute(root) || path.resolve(root) === path.parse(root).root)
      blockers.push(
        `Source roots must be absolute installation directories, not filesystem roots: ${root}`,
      );
  const supported = (g: any) =>
    typeof g.jid === 'string' &&
    /^dc:\d+$/.test(g.jid) &&
    typeof g.folder === 'string' &&
    /^[\w-]+$/.test(g.folder);
  const bad = source.groups.filter((g) => !supported(g));
  const groups = source.groups.filter(supported);
  for (const g of bad) blockers.push(`Unsupported legacy channel or workspace name: ${g.folder}`);
  if (new Set(groups.map((g) => g.jid)).size !== groups.length)
    blockers.push('Duplicate legacy channel');
  if (new Set(groups.map((g) => g.folder)).size !== groups.length)
    blockers.push('Duplicate legacy workspace folder');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    blockers.push(`Unknown timezone: ${timezone}`);
  }

  const byChannel = new Map(groups.map((g) => [g.jid, `${prefix}${g.folder}`]));
  const byFolder = new Map(groups.map((g) => [g.folder, `${prefix}${g.folder}`]));

  let incoming = 0,
    outgoing = 0,
    pending = 0,
    outgoingWithoutRemoteId = 0;
  const ignoredChannels = new Set<string>();
  const queuedPerSession = new Map<string, number>();
  for (const message of source.messages) {
    const session = byChannel.get(message.chat_jid);
    if (!session) {
      ignoredChannels.add(message.chat_jid);
      continue;
    }
    if (message.is_bot_message) {
      outgoing++;
      if (!/^\d{5,25}$/.test(message.id)) outgoingWithoutRemoteId++;
      continue;
    }
    incoming++;
    if (
      message.content &&
      timestamp(message.timestamp) > timestamp(source.lastHandled[message.chat_jid] ?? null)
    ) {
      pending++;
      queuedPerSession.set(session, (queuedPerSession.get(session) ?? 0) + 1);
    }
  }
  if (ignoredChannels.size)
    warnings.push(
      `${ignoredChannels.size} legacy channel(s) have messages but no registered group; their history is skipped`,
    );

  const sessions: PlannedSession[] = groups.map((g) => {
    const workspace = path.join(groupsRoot, g.folder);
    if (fs.existsSync(workspace) && !fs.statSync(workspace).isDirectory())
      blockers.push(`Workspace is not a directory: ${workspace}`);
    return {
      id: byChannel.get(g.jid)!,
      folder: g.folder,
      channel: g.jid.slice(3),
      name: g.name,
      workspace,
      workspaceExists: fs.existsSync(workspace),
      queued: queuedPerSession.get(byChannel.get(g.jid)!) ?? 0,
    };
  });
  const missing = sessions.filter((s) => !s.workspaceExists);
  if (missing.length)
    warnings.push(
      `${missing.length} workspace director(ies) do not exist yet and will be created empty`,
    );
  if (prefix && sessions.some((s) => path.basename(s.workspace) !== s.id))
    warnings.push(
      `Conversation ids carry the prefix "${prefix}" but workspace directories keep the legacy folder name`,
    );

  const rewrites = sourceRoots.map((root) => ({
    root,
    prompts: source.tasks.filter(
      (t) => rewritePaths(String(t.prompt ?? ''), [root], newRoot) !== String(t.prompt ?? ''),
    ).length,
  }));
  for (const { root, prompts } of rewrites)
    if (!prompts)
      warnings.push(`Source root never appears in the backup and rewrites nothing: ${root}`);
  const rewrite = (text: string) => rewritePaths(text, sourceRoots, newRoot);
  // Absolute paths only. A relative "logs/nanoclaw.log" still resolves after the move.
  const residual = /\/(?:[\w.-]+\/)+[\w.-]*nanoclaw[\w.-]*(?:\/[\w.-]+)*/;
  const residualPaths: { task: string; sample: string }[] = [];
  for (const task of source.tasks) {
    const match = residual.exec(rewrite(String(task.prompt ?? '')));
    if (match && !match[0].startsWith(newRoot))
      residualPaths.push({ task: task.id, sample: match[0] });
  }
  if (residualPaths.length)
    warnings.push(
      `${residualPaths.length} task prompt(s) still name a NanoClaw installation no source root covers`,
    );

  const tasks: PlannedTask[] = [];
  for (const task of source.tasks) {
    const session = byChannel.get(task.chat_jid) ?? byFolder.get(task.group_folder);
    if (!session) {
      blockers.push(`Task has no migrated conversation: ${task.id}`);
      continue;
    }
    const kind = task.schedule_type === 'cron' ? 'cron' : 'once';
    if (task.status === 'active' && !['cron', 'once'].includes(task.schedule_type)) {
      blockers.push(`Active schedule needs explicit conversion: ${task.id}`);
      continue;
    }
    const legacyNext = task.next_run ? timestamp(task.next_run) : null;
    let action: PlannedTask['action'] = 'import';
    let nextRun = legacyNext;
    if (task.status === 'active') {
      if (kind === 'cron')
        try {
          const forward = nextOccurrence('cron', task.schedule_value, timezone, now);
          if (legacyNext === null || legacyNext <= now) {
            if (dueTasks === 'reschedule') {
              action = 'reschedule';
              nextRun = forward;
            } else if (dueTasks === 'cancel') action = 'cancel';
          }
        } catch (error) {
          blockers.push(`Legacy cron is not a Clawstrum schedule: ${task.id}: ${String(error)}`);
        }
      else {
        // The scheduler never re-parses a one-shot, so this fires, but any later edit of it fails.
        if (!/(Z|[+-]\d\d:\d\d)$/.test(String(task.schedule_value)))
          warnings.push(`One-shot time carries no UTC offset and cannot be re-derived: ${task.id}`);
        if (legacyNext !== null && legacyNext <= now && dueTasks !== 'fire') action = 'cancel';
      }
    }
    tasks.push({
      id: task.id,
      session,
      kind,
      schedule: task.schedule_value,
      status: action === 'cancel' ? 'cancelled' : task.status,
      nextRun: action === 'cancel' || nextRun === null ? null : new Date(nextRun).toISOString(),
      action,
    });
    if (task.status === 'active' && action === 'import' && nextRun === null)
      warnings.push(`Active schedule has no next run and will never fire: ${task.id}`);
  }
  const firing = tasks.filter((t) => t.action === 'import' && t.status === 'active' && t.nextRun);
  const due = firing.filter((t) => Date.parse(t.nextRun!) <= now);
  if (due.length)
    warnings.push(`${due.length} imported schedule(s) are already due and fire on the first tick`);

  const provenanceOnlyColumns: Record<string, string[]> = {};
  for (const [table, columns] of Object.entries(source.columns)) {
    const dropped = columns.filter((c) => !CONSUMED[table]!.includes(c));
    if (dropped.length) provenanceOnlyColumns[table] = dropped;
  }

  return {
    backup,
    prefix,
    sourceRoots,
    newRoot,
    timezone,
    destinationEmpty: empty,
    counts: {
      groups: source.groups.length,
      messages: source.messages.length,
      incoming,
      outgoing,
      pending,
      tasks: source.tasks.length,
      taskRuns: source.logs.filter((l) => source.tasks.some((t) => t.id === l.task_id)).length,
      outgoingWithoutRemoteId,
    },
    sessions,
    tasks,
    rewrites,
    residualPaths,
    provenanceOnlyColumns,
    ignoredChannels: [...ignoredChannels],
    warnings,
    blockers,
  };
}

/** Read-only rehearsal of importNanoClaw against the same backup. Writes nothing. */
export function planNanoClaw(
  destination: Store | string,
  backup: string,
  groupsRoot: string,
  opts: NanoClawImportOptions = {},
): NanoClawPlan {
  return buildPlan(destinationEmpty(destination), readSource(backup), backup, groupsRoot, opts);
}

export function importNanoClaw(
  store: Store,
  backup: string,
  groupsRoot: string,
  opts: NanoClawImportOptions = {},
) {
  groupsRoot = path.resolve(groupsRoot);
  const source = readSource(backup);
  const plan = buildPlan(destinationEmpty(store), source, backup, groupsRoot, opts);
  if (plan.blockers.length) throw new Error(plan.blockers.join('; '));
  const byChannel = new Map(plan.sessions.map((s) => [`dc:${s.channel}`, s.id]));
  const plannedTasks = new Map(plan.tasks.map((t) => [t.id, t]));
  const rewrite = (text: string) => rewritePaths(text, plan.sourceRoots, plan.newRoot);
  const idCounts = new Map<string, number>();
  for (const m of source.messages) idCounts.set(m.id, (idCounts.get(m.id) ?? 0) + 1);
  // Outside the transaction on purpose: a directory left behind by a rolled back import is
  // inert, while a session row pointing at a missing workspace fails every run.
  for (const session of plan.sessions)
    fs.mkdirSync(session.workspace, { recursive: true, mode: 0o700 });
  let incoming = 0,
    outgoing = 0,
    pending = 0,
    taskRuns = 0;
  store.transaction(() => {
    if (!destinationEmpty(store)) throw new Error('Import requires an empty destination database');
    for (const group of source.groups) {
      const id = byChannel.get(group.jid)!;
      store.exec(
        'INSERT INTO sessions(id,channel_id,workspace,created_at) VALUES(?,?,?,?)',
        id,
        group.jid.slice(3),
        path.join(groupsRoot, group.folder),
        timestamp(group.added_at),
      );
      store.event(id, null, 'migration_source', {
        harness: 'nanoclaw',
        backup,
        group,
        nativeSessionId: source.native[group.folder] ?? null,
        continuity: 'Imported messages and files; fresh provider session on Clawstrum',
      });
      const channelMessages = source.messages.filter((m) => m.chat_jid === group.jid);
      const ids = channelMessages.map((m) => m.id).filter((id) => /^\d{5,25}$/.test(id));
      if (ids.length) {
        const newest = ids.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
        store.exec(
          'INSERT INTO discord_cursors(channel_id,message_id) VALUES(?,?)',
          group.jid.slice(3),
          newest,
        );
      }
    }
    for (const message of source.messages) {
      const session = byChannel.get(message.chat_jid);
      if (!session) continue;
      const key = `nanoclaw:${message.chat_jid}:${message.id}`;
      const at = timestamp(message.timestamp);
      if (message.is_bot_message) {
        store.exec(
          "INSERT INTO outbox(id,dedupe_key,session_id,content,status,remote_id,available_at,created_at,origin) VALUES(?,?,?,?,'sent',?,?,?,'agent')",
          key,
          key,
          session,
          message.content ?? '',
          /^\d{5,25}$/.test(message.id) ? message.id : null,
          at,
          at,
        );
        store.exec(
          'INSERT INTO events(session_id,type,content,created_at) VALUES(?,?,?,?)',
          session,
          'assistant',
          JSON.stringify(message.content ?? ''),
          at,
        );
        outgoing++;
      } else {
        const status =
          message.content && at > timestamp(source.lastHandled[message.chat_jid] ?? null)
            ? 'queued'
            : 'done';
        const id =
          /^\d{5,25}$/.test(message.id) && idCounts.get(message.id) === 1 ? message.id : key;
        store.exec(
          'INSERT INTO inbound(id,session_id,author,content,kind,status,available_at,created_at) VALUES(?,?,?,?,?,?,?,?)',
          id,
          session,
          message.sender_name || message.sender,
          message.content ?? '',
          message.is_from_me ? 'task' : 'user',
          status,
          at,
          at,
        );
        incoming++;
        if (status === 'queued') pending++;
      }
    }
    for (const task of source.tasks) {
      const planned = plannedTasks.get(task.id)!;
      store.exec(
        'INSERT INTO tasks(id,session_id,prompt,kind,schedule,timezone,next_run,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        task.id,
        planned.session,
        rewrite(task.prompt),
        planned.kind,
        task.schedule_value,
        plan.timezone,
        planned.nextRun === null ? null : Date.parse(planned.nextRun),
        planned.status,
        timestamp(task.created_at),
      );
      store.event(planned.session, null, 'migration_task', { ...task, plan: planned });
    }
    for (const log of source.logs) {
      const task = source.tasks.find((t) => t.id === log.task_id);
      if (!task) continue;
      const session = plannedTasks.get(task.id)!.session;
      const at = timestamp(log.run_at);
      const input = `nanoclaw-task:${log.id}`;
      const run = `nanoclaw-run:${log.id}`;
      const state = log.status === 'success' ? 'done' : 'failed';
      store.exec(
        "INSERT INTO inbound(id,session_id,author,content,kind,status,available_at,created_at) VALUES(?,?,?,?,'task',?,?,?)",
        input,
        session,
        'NanoClaw scheduler (history)',
        rewrite(task.prompt),
        state,
        at,
        at,
      );
      store.exec(
        'INSERT OR IGNORE INTO task_runs(task_id,scheduled_at,message_id) VALUES(?,?,?)',
        task.id,
        at,
        input,
      );
      store.exec(
        'INSERT INTO runs(id,session_id,message_ids,status,error,started_at,ended_at,logical_id) VALUES(?,?,?,?,?,?,?,?)',
        run,
        session,
        JSON.stringify([input]),
        state,
        log.error,
        at - (log.duration_ms || 0),
        at,
        `${session}:${input}`,
      );
      store.event(session, run, 'migration_task_result', log);
      taskRuns++;
    }
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?)',
      'nanoclaw_import',
      JSON.stringify({
        backup,
        prefix: plan.prefix,
        sourceRoots: plan.sourceRoots,
        timezone: plan.timezone,
        groups: source.groups.length,
        incoming,
        outgoing,
        pending,
        tasks: source.tasks.length,
        taskRuns,
        rescheduled: plan.tasks.filter((t) => t.action !== 'import').map((t) => t.id),
        sourceMessageDigest: createHash('sha256')
          .update(JSON.stringify(source.messages))
          .digest('hex'),
      }),
    );
  });
  return {
    groups: source.groups.length,
    messages: source.messages.length,
    incoming,
    outgoing,
    pending,
    tasks: source.tasks.length,
    taskRuns,
    ignoredChannels: plan.ignoredChannels,
    sessions: plan.sessions,
    plan,
  };
}
