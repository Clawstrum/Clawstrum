import type { Store } from './store.js';
import { hostTimeZone } from './context.js';

/**
 * A person's message that sets a choice: a named route or setting ("use my X"), a standing order
 * ("from now on", "always", "never"), or a pick ("let's use", "switch to"). In one deployment most
 * matches were real decisions, including a "use my ... API key" that reached memory only a day
 * and a half later, after the lead had contradicted it.
 */
export const DECISION_PATTERN =
  /\b(use (my|our|the|only|\w+ on)\b|from now on|always\b|never\b|don'?t (use|do|ever)|stop (using|doing)|we should (use|always|never|not)|let'?s (use|keep|go with|remove|drop|switch)|switch to|instead of|go with|keep using|should be (on|using)|you should\b|you shouldn'?t|shouldn'?t (be|use|cancel|run|do)|I want (?!to (know|see|ask|check))(the|it|to|you|a|our|\w+:)|(we|you) need to (use|keep|run|have|make)|when .{0,40} (is|are) up, (run|use|start)|must\b)/i;

/**
 * A change the person proposes as a question ("Can we just remove the practical tool category?").
 * Such a question can be tested, the result accepted, and the change never written down, so a
 * later run uses the old version. Kept so the lead sees it and records how it settled.
 */
export const PROPOSAL_PATTERN =
  /\b(get rid of|can we (just )?(remove|drop|use|switch|skip|get rid|only)|why not (just )?(use|a |an |\d)|should we (use|remove|drop|switch)|no more\b)/i;

const key = (sessionId: string, id: string) => `user-decision:${sessionId}:${id}`;

/**
 * Save the person's own words, unedited, so a decision does not depend on the model choosing to
 * write it down. Left to the lead, most decisions do not reach memory the same day.
 */
export function recordUserDecision(
  store: Store,
  sessionId: string,
  id: string,
  author: string,
  text: string,
  at: number,
  recovered = false,
): boolean {
  const proposal = !DECISION_PATTERN.test(text);
  if (proposal && !PROPOSAL_PATTERN.test(text)) return false;
  return (
    store.exec(
      'INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)',
      key(sessionId, id),
      JSON.stringify({ at, author, text: text.slice(0, 2000), recovered, proposal }),
    ).changes > 0
  );
}

/** Local clock time, the same base the transcripts use, so a cited time is one a person can find. */
export function localTimestamp(ms: number, timeZone: string = hostTimeZone()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}
/** Newest last. Lines are flattened so a quoted heading cannot become a memory heading. */
export function userDecisionsBlock(
  store: Store,
  sessionId: string,
  limit = 40,
  timeZone: string = hostTimeZone(),
): string {
  const rows = store
    .all<{ key: string; value: string }>(
      "SELECT key,value FROM metadata WHERE key LIKE ? ESCAPE '\\'",
      `user-decision:${sessionId.replace(/[\\%_]/g, (c) => '\\' + c)}:%`,
    )
    .map((r) => ({ id: r.key.slice(key(sessionId, '').length), ...JSON.parse(r.value) }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(-limit);
  if (!rows.length) return '';
  const fmt = (ms: number) => localTimestamp(ms, timeZone);
  const lines = rows.map((r) => {
    const words = String(r.text)
      .replace(/\s*\n+\s*/g, ' / ')
      .replace(/^#+\s*/, '')
      .slice(0, 500);
    const tags = [
      r.recovered && 'recovered from history',
      r.proposal && 'proposal: find how it settled',
    ].filter(Boolean);
    return `- ${fmt(r.at)} ${r.author}${tags.length ? ` (${tags.join('; ')})` : ''}: "${words}" (inbound:${r.id})`;
  });
  return `#### Decisions the people here stated, saved by the harness word for word\n\nApply these before any older note, log or findings file. A later entry on the same topic replaces an earlier one. If you cannot follow one, say so and ask before doing anything else. A proposal that was tested and kept is a decision: record the outcome in the project's current-setup entry.\n\n${lines.join('\n')}`;
}
