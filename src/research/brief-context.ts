import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../store.js';
import { bounded, hostTimeZone } from '../context.js';
import { hasMemory, parseMemory } from '../memory.js';
import { localTimestamp, userDecisionsBlock } from '../user-decisions.js';

export interface BriefContextOptions {
  enabled: boolean;
  recentMessages: number;
  messageChars: number;
  maxChars: number;
}

/**
 * The channel's MEMORY has no fixed "Goal" subsection (MEMORY_SECTIONS in memory.ts names only
 * "Working understanding", "Current work", "Research state", "History access and coverage"), so a
 * heading or bold line naming the goal is a convention, not a guarantee. Look for one; when none
 * is found, fall back to the harness-saved decisions block, which always exists.
 */
function goalEntry(store: Store, sessionId: string, workspace: string, timeZone: string): string {
  let text: string;
  try {
    text = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8');
  } catch {
    return userDecisionsBlock(store, sessionId, undefined, timeZone);
  }
  if (!hasMemory(text)) return userDecisionsBlock(store, sessionId, undefined, timeZone);
  let memory: string;
  try {
    memory = parseMemory(text).memory;
  } catch {
    return userDecisionsBlock(store, sessionId, undefined, timeZone);
  }
  const heading = /^ {0,3}#{2,6}[ \t]+.*\bgoals?\b.*$/im.exec(memory);
  if (heading) {
    const start = heading.index!;
    const bodyStart = start + heading[0].length;
    const rest = memory.slice(bodyStart);
    const next = /\n {0,3}#{1,6}[ \t]/.exec(rest);
    const end = next ? bodyStart + next.index! : memory.length;
    return memory.slice(start, end).trim();
  }
  const bold =
    /^[ \t]*\*{0,2}goals?\*{0,2}[:.\s][^\n]*(?:\n(?! {0,3}#{1,6}[ \t])(?!\s*\n)[^\n]*)*/im.exec(
      memory,
    );
  if (bold) return bold[0].trim();
  return userDecisionsBlock(store, sessionId, undefined, timeZone);
}

interface ConversationRow {
  author: string;
  content: string;
  at: number;
}

/**
 * Both sides of the parent conversation, merged in time order: the person's inbound messages
 * (kind='user', so a scheduled-task wake never appears here) and the lead's delivered replies
 * (origin='agent', status='sent', so a harness notice or an undelivered CLAWSTRUM_QUIET never do).
 */
function recentConversation(
  store: Store,
  sessionId: string,
  limit: number,
  messageChars: number,
  agentName: string,
  timeZone: string,
): string[] {
  if (limit <= 0) return [];
  const inbound = store.all<{ author: string; content: string; created_at: number }>(
    "SELECT author,content,created_at FROM inbound WHERE session_id=? AND kind='user' ORDER BY created_at DESC,id DESC LIMIT ?",
    sessionId,
    limit,
  );
  const outbox = store.all<{ content: string; created_at: number }>(
    "SELECT content,created_at FROM outbox WHERE session_id=? AND origin='agent' AND status='sent' ORDER BY created_at DESC,id DESC LIMIT ?",
    sessionId,
    limit,
  );
  const rows: ConversationRow[] = [
    ...inbound.map((r) => ({ author: r.author, content: r.content, at: r.created_at })),
    ...outbox
      .filter((r) => r.content.trim() !== 'CLAWSTRUM_QUIET')
      .map((r) => ({ author: agentName, content: r.content, at: r.created_at })),
  ]
    .sort((a, b) => a.at - b.at)
    .slice(-limit);
  return rows.map(
    (row) =>
      `[${localTimestamp(row.at, timeZone)}] ${row.author}: ${bounded(row.content, messageChars)}`,
  );
}

/**
 * Appended to a subagent's BRIEF.md so a constraint the person stated, and the lead's own summary
 * in `context` dropped, still reaches the subagent. Returns '' when there is nothing to add.
 */
export function briefContextSection(
  store: Store,
  sessionId: string,
  workspace: string,
  options: BriefContextOptions,
  agentName = 'Clawstrum',
  timeZone: string = hostTimeZone(),
): string {
  if (!options.enabled) return '';
  const goal = goalEntry(store, sessionId, workspace, timeZone).trim();
  const lines = recentConversation(
    store,
    sessionId,
    options.recentMessages,
    options.messageChars,
    agentName,
    timeZone,
  );
  if (!goal && !lines.length) return '';
  const header = 'Conversation context (added by Clawstrum, verbatim)\n';
  const goalBlock = goal ? `${goal}\n` : '';
  let budget = Math.max(0, options.maxChars - header.length - goalBlock.length);
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i]!.length + 1;
    if (cost > budget) break;
    kept.unshift(lines[i]!);
    budget -= cost;
  }
  const body = kept.length
    ? `Last ${kept.length} message${kept.length === 1 ? '' : 's'} of the parent conversation (both the person and the lead), oldest first, verbatim:\n${kept.join('\n')}`
    : '';
  const combined = [goalBlock.trim(), body].filter(Boolean).join('\n\n');
  if (!combined) return '';
  return `\n\n${header}${combined}\n`;
}
