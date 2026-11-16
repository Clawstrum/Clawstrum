import { CronExpressionParser } from 'cron-parser';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';

export interface Task {
  id: string;
  session_id: string;
  prompt: string;
  kind: 'once' | 'cron';
  schedule: string;
  timezone: string;
  next_run: number | null;
  status: string;
}
export function nextOccurrence(
  kind: Task['kind'],
  schedule: string,
  timezone: string,
  after = Date.now(),
): number {
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  if (kind === 'once') {
    if (!/(Z|[+-]\d\d:\d\d)$/.test(schedule))
      throw new Error('One-shot times need an explicit UTC offset or Z');
    const at = Date.parse(schedule);
    if (!Number.isFinite(at) || at <= after) throw new Error('One-shot time must be in the future');
    return at;
  }
  const expression = CronExpressionParser.parse(schedule, {
    tz: timezone,
    currentDate: new Date(after),
  });
  if (expression.fields.second.values.length !== 1)
    throw new Error('Scheduled agent work supports at most one occurrence per minute');
  return expression.next().getTime();
}
export function addTask(
  store: Store,
  sessionId: string,
  prompt: string,
  kind: Task['kind'],
  schedule: string,
  timezone = 'UTC',
  now = Date.now(),
  stableId?: string,
): string {
  const existing = stableId
    ? store.get<Task>('SELECT * FROM tasks WHERE id=?', stableId)
    : undefined;
  if (existing) {
    if (
      existing.session_id !== sessionId ||
      existing.prompt !== prompt ||
      existing.kind !== kind ||
      existing.schedule !== schedule ||
      existing.timezone !== timezone
    )
      throw new Error('Schedule key conflict: use a new key for a different follow-up');
    return existing.id;
  }
  if (!prompt.trim()) throw new Error('Task prompt cannot be empty');
  store.session(sessionId);
  const at = nextOccurrence(kind, schedule, timezone, now);
  const id = stableId ?? randomUUID();
  store.exec(
    'INSERT INTO tasks(id,session_id,prompt,kind,schedule,timezone,next_run,created_at) VALUES(?,?,?,?,?,?,?,?)',
    id,
    sessionId,
    prompt,
    kind,
    schedule,
    timezone,
    at,
    now,
  );
  return id;
}
export function listTasks(store: Store, sessionId?: string) {
  return store.all(
    `SELECT t.*,r.scheduled_at last_scheduled_at,i.status last_status,
    (SELECT error FROM runs WHERE message_ids LIKE '%"' || r.message_id || '"%' ORDER BY started_at DESC LIMIT 1) last_error
    FROM tasks t LEFT JOIN task_runs r ON r.task_id=t.id AND r.scheduled_at=(SELECT MAX(x.scheduled_at) FROM task_runs x WHERE x.task_id=t.id)
    LEFT JOIN inbound i ON i.id=r.message_id ${sessionId ? 'WHERE t.session_id=?' : ''} ORDER BY t.created_at DESC LIMIT 100`,
    ...(sessionId ? [sessionId] : []),
  );
}
export function taskHistory(store: Store, taskId: string) {
  return store.all(
    `SELECT r.*,i.status,i.content,
    (SELECT error FROM runs WHERE message_ids LIKE '%"' || r.message_id || '"%' ORDER BY started_at DESC LIMIT 1) error
    FROM task_runs r LEFT JOIN inbound i ON i.id=r.message_id WHERE r.task_id=? ORDER BY r.scheduled_at DESC LIMIT 100`,
    taskId,
  );
}
export function tickScheduler(store: Store, now = Date.now()): number {
  const tasks = store.all<Task>(
    "SELECT * FROM tasks WHERE status='active' AND next_run<=? ORDER BY next_run LIMIT 100",
    now,
  );
  let count = 0;
  for (const due of tasks) {
    try {
      const changed = store.transaction(() => {
        const task = store.get<Task>(
          "SELECT * FROM tasks WHERE id=? AND status='active' AND next_run<=?",
          due.id,
          now,
        );
        if (!task) return false;
        // Validate the next occurrence before writing any part of this occurrence.
        const next =
          task.kind === 'cron' ? nextOccurrence('cron', task.schedule, task.timezone, now) : null;
        // One outstanding occurrence per recurring task. Missed wakes coalesce until it finishes.
        const outstanding =
          task.kind === 'cron' &&
          store.get(
            "SELECT 1 FROM task_runs r JOIN inbound i ON i.id=r.message_id WHERE r.task_id=? AND i.status IN ('queued','running') LIMIT 1",
            task.id,
          );
        if (outstanding) {
          store.exec('UPDATE tasks SET next_run=? WHERE id=?', next, task.id);
          return false;
        }
        const messageId = `task:${task.id}:${task.next_run}`;
        store.exec(
          'INSERT INTO task_runs(task_id,scheduled_at,message_id) VALUES(?,?,?)',
          task.id,
          task.next_run!,
          messageId,
        );
        store.enqueue({
          id: messageId,
          sessionId: task.session_id,
          author: 'Clawstrum scheduler',
          kind: 'task',
          content: `Scheduled follow-up. Report only meaningful findings, completion or failure. If nothing needs reporting, reply with only the word CLAWSTRUM_QUIET and no other text.\n${task.prompt}`,
          at: now,
        });
        store.exec(
          'UPDATE tasks SET next_run=?,status=? WHERE id=?',
          next,
          next === null ? 'completed' : 'active',
          task.id,
        );
        return true;
      });
      if (changed) count++;
    } catch (error) {
      store.transaction(() => {
        store.exec("UPDATE tasks SET status='failed' WHERE id=?", due.id);
        store.event(due.session_id, null, 'scheduler_error', {
          task: due.id,
          error: String(error),
        });
        store.outbox(
          due.session_id,
          `Scheduled task ${due.id} could not be queued: ${String(error)}`,
          { key: `scheduler-error:${due.id}:${due.next_run}` },
        );
      });
    }
  }
  return count;
}
