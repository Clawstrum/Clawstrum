import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { copyDatabase } from './backups.js';
import { writePrivate } from './files.js';
import { addTask, nextOccurrence, type Task } from './scheduler.js';
import type { Store } from './store.js';

export const reviewOptionsSchema = z
  .object({
    timezone: z
      .string()
      .default('UTC')
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Use an IANA timezone'),
    sessions: z.array(z.string().min(1)).default([]),
    excludeAuthors: z.array(z.string()).default([]),
    replyWindowMinutes: z.number().int().min(1).max(1440).default(60),
    longReplyChars: z.number().int().min(1).max(1000000).default(1200),
  })
  .strict();
export type ReviewOptions = z.infer<typeof reviewOptionsSchema>;
export function validateDay(day: string): string {
  const value = Date.parse(day + 'T00:00:00Z');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(value) ||
    new Date(value).toISOString().slice(0, 10) !== day
  )
    throw new Error('Use a valid YYYY-MM-DD calendar date');
  return day;
}
export function localDay(at: number, timezone: string): string {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}
export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(validateDay(day) + 'T12:00:00Z') + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
function dayStart(day: string, timezone: string): number {
  const guess = Date.parse(validateDay(day) + 'T00:00:00Z');
  // Find the first instant of the local calendar date, including midnight DST changes.
  let low = guess - 36 * 3600000,
    high = guess + 36 * 3600000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (localDay(mid, timezone) < day) low = mid + 1;
    else high = mid;
  }
  return low;
}
export function dayWindow(day: string, timezone: string): { start: number; end: number } {
  const start = dayStart(day, timezone),
    end = dayStart(shiftDay(day, 1), timezone);
  if (start === end)
    throw new Error('This local calendar date does not exist in the selected timezone');
  return { start, end };
}
function optionsKey(options: ReviewOptions): string {
  return createHash('sha256').update(JSON.stringify(options)).digest('hex');
}
function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function lockOutput(directory: string): () => void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, '.review-lock.db');
  const mutex = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  try {
    mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch {
    mutex.close();
    throw new Error('Another review operation is using this output directory');
  }
  return () => {
    try {
      mutex.exec('ROLLBACK');
    } finally {
      mutex.close();
    }
  };
}
export function pendingReviewDays(
  directory: string,
  from: string,
  through: string,
  input: unknown = {},
): string[] {
  const options = reviewOptionsSchema.parse(input);
  validateDay(from);
  validateDay(through);
  if (from > through) throw new Error('Review start must not be after its end');
  const days: string[] = [];
  let count = 0;
  for (let day = from; day <= through; day = shiftDay(day, 1)) {
    if (++count > 366) throw new Error('Review ranges are limited to 366 calendar days');
    let completed = false;
    try {
      const receipt = readJson(path.join(directory, day, 'REVIEWED.json'));
      const collection = readJson(path.join(directory, day, 'COLLECTED.json'));
      completed =
        receipt.version === 1 &&
        receipt.day === day &&
        receipt.optionsKey === optionsKey(options) &&
        receipt.collectionId === collection.id &&
        receipt.reportSha256 ===
          createHash('sha256').update(fs.readFileSync(receipt.report)).digest('hex');
    } catch {
      /* Missing, malformed or stale receipts leave that date pending. */
    }
    if (!completed) days.push(day);
  }
  return days;
}
export function completeReview(
  directory: string,
  day: string,
  report: string,
  now = Date.now(),
): void {
  validateDay(day);
  const unlock = lockOutput(directory);
  try {
    const collection = readJson(path.join(directory, day, 'COLLECTED.json'));
    if (collection.day !== day || collection.version !== 1)
      throw new Error('Collect this date before marking it reviewed');
    if (collection.observedUntil < collection.end)
      throw new Error('Collect the completed calendar day before marking it reviewed');
    const text = fs.readFileSync(report, 'utf8');
    if (!text.trim()) throw new Error('A nonempty review report is required');
    writePrivate(
      path.join(directory, day, 'REVIEWED.json'),
      JSON.stringify(
        {
          version: 1,
          day,
          reviewedAt: new Date(now).toISOString(),
          optionsKey: collection.optionsKey,
          collectionId: collection.id,
          report: path.resolve(report),
          reportSha256: createHash('sha256').update(text).digest('hex'),
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    unlock();
  }
}
const atFormat = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function reviewTaskId(channelId: string): string {
  return `review:${channelId}`;
}
export function reviewCronSchedule(at: string): string {
  const match = atFormat.exec(at);
  if (!match) throw new Error('Use a 24-hour HH:MM time');
  return `${Number(match[2])} ${Number(match[1])} * * *`;
}
export function reviewTaskPrompt(): string {
  return (
    'Run the nightly self-review for this channel. Use the self-review skill. ' +
    'Run clawstrum review pending for the recent dates, then clawstrum review collect for any ' +
    'that are missing, read the collected evidence, and use clawstrum review complete to record ' +
    "a report once a date is done. Keep the ledger, reports and any notes inside this channel's " +
    'own workspace. If nothing needs the user, reply with exactly CLAWSTRUM_QUIET and nothing else.'
  );
}
/**
 * Create or bring up to date the nightly self-review task for one channel, keyed by channel id so
 * a restart or a repeated `review schedule` call never produces a second task. The channel must
 * already have a session (every configured Discord channel gets one on daemon connect, and
 * `review schedule` creates one directly without needing a live Discord connection).
 */
export function ensureReviewTask(
  store: Store,
  channelId: string,
  at: string,
  timezone: string,
  now = Date.now(),
): string {
  const session = store.get<{ id: string }>(
    'SELECT id FROM sessions WHERE channel_id=?',
    channelId,
  );
  if (!session)
    throw new Error(`No session for review channel ${channelId} yet; add it to discord.channelIds`);
  const id = reviewTaskId(channelId);
  const schedule = reviewCronSchedule(at);
  const prompt = reviewTaskPrompt();
  const existing = store.get<Task>('SELECT * FROM tasks WHERE id=?', id);
  if (
    existing &&
    existing.session_id === session.id &&
    existing.prompt === prompt &&
    existing.kind === 'cron' &&
    existing.schedule === schedule &&
    existing.timezone === timezone &&
    existing.status === 'active'
  )
    return id;
  if (existing) {
    const next = nextOccurrence('cron', schedule, timezone, now);
    store.exec(
      "UPDATE tasks SET session_id=?,prompt=?,kind='cron',schedule=?,timezone=?,next_run=?,status='active' WHERE id=?",
      session.id,
      prompt,
      schedule,
      timezone,
      next,
      id,
    );
    return id;
  }
  return addTask(store, session.id, prompt, 'cron', schedule, timezone, now, id);
}
interface Message {
  id: string;
  sessionId: string;
  author: string;
  kind: string;
  content: string;
  at: number;
  direction: 'input' | 'output';
  origin?: string;
}
export interface ReviewMetrics {
  sessionId: string;
  inputs: number;
  taskWakes: number;
  replies: number;
  notices: number;
  longReplies: number;
  inputsWithReplyWithinWindow: number;
  inputsWithoutReplyWithinWindow: number;
  inputsAwaitingObservation: number;
  medianReplyLatencySeconds: number | null;
}
export async function collectReview(
  home: string,
  directory: string,
  days: string[],
  input: unknown = {},
  now = Date.now(),
): Promise<string[]> {
  const options = reviewOptionsSchema.parse(input);
  if (!days.length || days.length > 31)
    throw new Error('Collect between 1 and 31 dates per invocation');
  for (const day of days) {
    validateDay(day);
    if (day > localDay(now, options.timezone)) throw new Error('Cannot collect a future date');
  }
  const unlock = lockOutput(directory);
  let temporary: string | undefined;
  let db: DatabaseSync | undefined;
  try {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-review-'));
    const file = path.join(temporary, 'snapshot.db');
    // No fallback to long reads on the live DB. A failed snapshot fails collection visibly.
    await copyDatabase(home, file);
    db = new DatabaseSync(file, { readOnly: true });
    db.exec(`CREATE TEMP TABLE delivery_times AS
      SELECT CASE WHEN json_valid(content) THEN json_extract(content,'$.outboxId') END id, MIN(created_at) at FROM events
      WHERE type='delivered' AND json_valid(content) GROUP BY CASE WHEN json_valid(content) THEN json_extract(content,'$.outboxId') END;
      CREATE INDEX delivery_times_id ON delivery_times(id);`);
    const sessions = db
      .prepare('SELECT id,channel_id FROM sessions ORDER BY id')
      .all() as unknown as Array<{ id: string; channel_id: string }>;
    for (const id of options.sessions)
      if (!sessions.some((session) => session.id === id))
        throw new Error(`Unknown review session: ${id}`);
    const result: string[] = [];
    for (const day of [...new Set(days)].sort()) {
      const { start, end } = dayWindow(day, options.timezone);
      const observedUntil = Math.min(now, end + options.replyWindowMinutes * 60000);
      const messages: Message[] = [];
      const metrics: ReviewMetrics[] = [];
      for (const session of sessions.filter(
        (s) => !options.sessions.length || options.sessions.includes(s.id),
      )) {
        const inputs = db
          .prepare(
            'SELECT id,author,kind,content,created_at at FROM inbound WHERE session_id=? AND created_at>=? AND created_at<? ORDER BY created_at,id',
          )
          .all(session.id, start, Math.min(end, now)) as unknown as Message[];
        const outputs = db
          .prepare(
            `SELECT o.id,o.content,o.origin,COALESCE(d.at,o.created_at) at FROM outbox o
          LEFT JOIN delivery_times d ON d.id=o.id WHERE o.session_id=? AND o.status='sent'
          AND COALESCE(d.at,o.created_at)>=? AND COALESCE(d.at,o.created_at)<=? ORDER BY at,o.id`,
          )
          .all(session.id, start, observedUntil) as unknown as Message[];
        const rows = outputs.filter((row) => row.at < end);
        const requests = inputs.filter(
          (row) => row.kind === 'user' && !options.excludeAuthors.includes(row.author),
        );
        const replies = outputs.filter((row) => row.origin === 'agent');
        const latencies: number[] = [];
        let nextReply = 0;
        let unanswered = 0,
          awaiting = 0;
        for (const request of requests) {
          const deadline = request.at + options.replyWindowMinutes * 60000;
          while (replies[nextReply] && replies[nextReply]!.at < request.at) nextReply++;
          const candidate = replies[nextReply];
          const reply = candidate && candidate.at <= deadline ? candidate : undefined;
          if (reply) latencies.push((reply.at - request.at) / 1000);
          else if (deadline <= observedUntil) unanswered++;
          else awaiting++;
        }
        latencies.sort((a, b) => a - b);
        const mid = Math.floor(latencies.length / 2);
        const median = latencies.length
          ? latencies.length % 2
            ? latencies[mid]!
            : (latencies[mid - 1]! + latencies[mid]!) / 2
          : null;
        metrics.push({
          sessionId: session.id,
          inputs: requests.length,
          taskWakes: inputs.filter((row) => row.kind === 'task').length,
          replies: rows.filter((row) => row.origin === 'agent').length,
          notices: rows.filter((row) => row.origin !== 'agent').length,
          longReplies: rows.filter(
            (row) => row.origin === 'agent' && row.content.length > options.longReplyChars,
          ).length,
          inputsWithReplyWithinWindow: latencies.length,
          inputsWithoutReplyWithinWindow: unanswered,
          inputsAwaitingObservation: awaiting,
          medianReplyLatencySeconds: median,
        });
        messages.push(
          ...inputs.map((row) => ({ ...row, sessionId: session.id, direction: 'input' as const })),
          ...rows.map((row) => ({
            ...row,
            sessionId: session.id,
            author: 'agent',
            kind: row.origin ?? 'agent',
            direction: 'output' as const,
          })),
        );
      }
      messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      const folder = path.join(path.resolve(directory), day);
      const notes =
        'Metrics are timing/length heuristics, not judgments of answer quality. A later reply can cover multiple inputs without answering them. Only sent outbox records count; provider notices do not count as replies. Historical records without delivery events use their recorded creation time. Author exclusions match stored labels; labels do not prove human/bot identity.';
      writePrivate(path.join(folder, 'MESSAGES.json'), JSON.stringify(messages, null, 2) + '\n');
      writePrivate(
        path.join(folder, 'METRICS.json'),
        JSON.stringify({ day, timezone: options.timezone, options, notes, metrics }, null, 2) +
          '\n',
      );
      writePrivate(
        path.join(folder, 'TRANSCRIPT.md'),
        `# Conversation evidence for ${day}\n\nTimezone: ${options.timezone}. ${notes}\n\n` +
          messages
            .map(
              (row) =>
                `## ${new Date(row.at).toISOString()} | ${row.sessionId} | ${row.direction} | ${row.author}\n\n${row.content}\n`,
            )
            .join('\n'),
      );
      // Receipt is last: partially written artifacts never mark a review complete.
      writePrivate(
        path.join(folder, 'COLLECTED.json'),
        JSON.stringify(
          {
            version: 1,
            id: randomUUID(),
            day,
            start,
            end,
            observedUntil,
            collectedAt: new Date(now).toISOString(),
            optionsKey: optionsKey(options),
            options,
            notes,
          },
          null,
          2,
        ) + '\n',
      );
      result.push(folder);
    }
    return result;
  } finally {
    db?.close();
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    unlock();
  }
}
