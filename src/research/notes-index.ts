import type { Store } from '../store.js';

/** SQL that leaves out a note a later note or a memory review has replaced. These are the same
 * `note-superseded:` metadata keys claims.ts and consolidation.ts use for "current notes". */
const CURRENT_NOTE =
  "NOT EXISTS (SELECT 1 FROM metadata m WHERE m.key='note-superseded:'||research_notes.session_id||':'||research_notes.id)";

function likePattern(word: string): string {
  return '%' + word.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/** Extra WHERE conditions for research_status collection=notes. Every word of `query` must appear
 * in the title or the body (case-insensitive for ASCII, because the store turns on case_sensitive_like; % and _ in the words match themselves).
 * The caller adds the session_id condition; this never widens a search beyond it. */
export function noteFilterSql(
  query: string | undefined,
  current: boolean,
): { sql: string; params: string[] } | undefined {
  const parts: string[] = [];
  const params: string[] = [];
  for (const word of (query ?? '').split(/\s+/).filter(Boolean)) {
    parts.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(body) LIKE ? ESCAPE '\\')");
    const pattern = likePattern(word.toLowerCase());
    params.push(pattern, pattern);
  }
  if (current) parts.push(CURRENT_NOTE);
  return parts.length ? { sql: parts.join(' AND '), params } : undefined;
}

export interface NotesIndexLimits {
  enabled: boolean;
  maxItems: number;
  maxChars: number;
}

function day(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The list of a channel's current notes that goes into the lead's prompt: date, title and id,
 * newest first, no bodies. Empty string when disabled or when the channel has no current note.
 * It is derived from the database on every read and is never written into AGENTS.md, so a note
 * saved, replaced or retired changes the next snapshot without any file edit. */
export function notesIndexBlock(store: Store, sessionId: string, limits: NotesIndexLimits): string {
  if (!limits.enabled) return '';
  const total =
    store.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM research_notes WHERE session_id=? AND ${CURRENT_NOTE}`,
      sessionId,
    )?.n ?? 0;
  if (!total) return '';
  const rows = store.all<{ id: string; title: string; created_at: number }>(
    `SELECT id,title,created_at FROM research_notes WHERE session_id=? AND ${CURRENT_NOTE} ORDER BY created_at DESC,id DESC LIMIT ?`,
    sessionId,
    limits.maxItems,
  );
  const header =
    '#### Research notes in this channel (titles only; read one with research_status collection=notes id=<id>, search with query=<words>)\n';
  const more = (shown: number) =>
    `- ${total - shown} more current note${total - shown === 1 ? '' : 's'}. List them with research_status collection=notes current=true offset=${shown} limit=100.`;
  const lines: string[] = [];
  let size = header.length;
  for (const row of rows) {
    const title = row.title.replace(/\s+/g, ' ').trim().slice(0, 160);
    const line = `- ${day(row.created_at)} ${title} (id ${row.id})`;
    // Keep room for the closing "N more" line, which is needed whenever a note is left out.
    const needsMore = lines.length + 1 < total;
    const reserve = needsMore ? more(lines.length + 1).length + 1 : 0;
    if (size + line.length + 1 + reserve > limits.maxChars && lines.length) break;
    lines.push(line);
    size += line.length + 1;
  }
  if (lines.length < total) lines.push(more(lines.length));
  return header + lines.join('\n');
}
