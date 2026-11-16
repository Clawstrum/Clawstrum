import type { Store } from './store.js';

/** A provider safety refusal of the request content, not a transport or account failure. */
export function isSafetyRefusal(message: string): boolean {
  return /safeguards flagged|model_refusal/i.test(message);
}

const key = (sessionId: string) => `refused-history:${sessionId}`;
interface Refusal {
  start: number;
  ids: string[];
}

function refusals(store: Store, sessionId: string): Refusal[] {
  const value = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    key(sessionId),
  )?.value;
  return value ? (JSON.parse(value) as Refusal[]) : [];
}

/**
 * Keep a refused request out of later continuations. Otherwise every new native session
 * reloads the refused text and the provider refuses unrelated follow-ups too. The records
 * stay in the archive; only the bounded continuation skips them.
 */
export function excludeRefusedInput(store: Store, sessionId: string, messageIds: string[]): void {
  const ids = messageIds.map((id) => `inbound:${id}`);
  if (!ids.length) return;
  const start = store.get<{ seq: number | null }>(
    `SELECT MIN(seq) seq FROM history_records WHERE session_id=? AND id IN (${ids.map(() => '?').join(',')})`,
    sessionId,
    ...ids,
  )?.seq;
  if (start == null) return;
  const list = refusals(store, sessionId).concat({ start, ids }).slice(-50);
  store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key(sessionId),
    JSON.stringify(list),
  );
  // A resumed native session would still contain the refused turn.
  store.exec('UPDATE sessions SET remote_id=NULL WHERE id=?', sessionId);
}

/** Sequence ranges to skip: from the refused input up to the next unrelated inbound record. */
export function refusedRanges(store: Store, sessionId: string): [number, number][] {
  const list = refusals(store, sessionId);
  const refused = new Set(list.flatMap((r) => r.ids));
  return list.map((r) => {
    const next = store
      .all<{
        id: string;
        seq: number;
      }>(
        "SELECT id,seq FROM history_records WHERE session_id=? AND seq>? AND id LIKE 'inbound:%' ORDER BY seq LIMIT 200",
        sessionId,
        r.start,
      )
      .find((row) => !refused.has(row.id));
    return [r.start, next ? next.seq - 1 : Number.MAX_SAFE_INTEGER];
  });
}

/**
 * Name the refused inputs a continuation leaves out, without their text. Without this the next
 * session does not know a request was made, and a refused 'could you fix?' turns into 'What do
 * you need?'. It also tells the model not to read the text back: printing the refused request
 * from its own history files draws follow-up refusals.
 */
export function refusedNote(store: Store, sessionId: string, after: number): string {
  const ids = refusals(store, sessionId)
    .filter((r) => r.start > after)
    .flatMap((r) => r.ids)
    .slice(-10);
  if (!ids.length) return '';
  return `Left out above: ${ids.length} input record${ids.length === 1 ? '' : 's'} the provider's safety filter refused (${ids.join(', ')}). Their text is not shown. Printing it back from the history archive, run errors or failure notices can get this turn refused as well, so refer to them by id. If someone is still waiting on one of them, say it was blocked and ask them to restate it in other words.`;
}
