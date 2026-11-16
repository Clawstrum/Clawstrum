import type { Store } from './store.js';
import { archiveRecord } from './history.js';

/** Messages kept for context in a channel shared with another bot, newest last. */
const HELD_LIMIT = 30;
const HELD_TEXT_LIMIT = 1500;

interface Held {
  author: string;
  text: string;
  at: number;
}

const key = (sessionId: string) => `held-inputs:${sessionId}`;

function read(store: Store, sessionId: string): Held[] {
  const row = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    key(sessionId),
  );
  return row ? (JSON.parse(row.value) as Held[]) : [];
}

/** Archive a message that did not name this bot and keep it for the next turn it does start. */
export function holdInput(
  store: Store,
  sessionId: string,
  input: { id: string; author: string; text: string; attachments: unknown[]; at: number },
): void {
  store.transaction(() => {
    if (store.get('SELECT 1 FROM history_records WHERE id=?', `inbound:${input.id}`)) return;
    archiveRecord(store, {
      id: `inbound:${input.id}`,
      sessionId,
      kind: 'user',
      content: {
        author: input.author,
        text: input.text,
        attachments: input.attachments,
        held: true,
      },
      at: input.at,
    });
    const held = [
      ...read(store, sessionId),
      { author: input.author, text: input.text, at: input.at },
    ];
    store.exec(
      'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
      key(sessionId),
      JSON.stringify(held.slice(-HELD_LIMIT)),
    );
  });
}

/**
 * The held messages as a preamble for the message that names this bot. Read only: clear them with
 * clearHeldInputs in the same transaction as the insert they preface, and only if it inserted, so a
 * second delivery of the naming message (gateway, then catch-up) cannot take them for nothing.
 */
export function heldInputsPreamble(store: Store, sessionId: string): string {
  const held = read(store, sessionId);
  if (!held.length) return '';
  const lines = held.map(
    (h) =>
      `[${new Date(h.at).toISOString()}] ${h.author}: ${
        h.text.length > HELD_TEXT_LIMIT ? h.text.slice(0, HELD_TEXT_LIMIT) + ' [cut]' : h.text
      }`,
  );
  return `Earlier messages in this channel that did not name you (not answered):\n${lines.join('\n')}\n\nMessage that names you:\n`;
}

export function clearHeldInputs(store: Store, sessionId: string): void {
  store.exec('DELETE FROM metadata WHERE key=?', key(sessionId));
}
