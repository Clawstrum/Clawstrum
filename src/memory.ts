import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { storagePolicy } from './storage.js';
import { writePrivate, syncDirectory } from './files.js';
import { archiveRecord, historyHash, historyRoot } from './history.js';

export const MEMORY_SECTIONS = [
  'Working understanding',
  'Current work',
  'Research state',
  'History access and coverage',
  'Last compaction summary',
] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

/** Subsection that holds the provider's latest native compaction summary until the next
 * consolidation pass merges it into the other sections. It is created on demand, so a MEMORY that
 * never compacted does not carry it. */
export const COMPACTION_SECTION: MemorySection = 'Last compaction summary';
/** The summary is kept in AGENTS.md up to this many characters; the full text is in history. */
export const COMPACTION_SUMMARY_CAP = 6000;
/** First words of an unmerged section body. A merged note starts with "Merged". */
const COMPACTION_PENDING_PREFIX = 'Compacted ';

const pad = (n: number) => String(n).padStart(2, '0');
/** Local date and time, minute resolution. */
export function localStamp(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Body of the "Last compaction summary" section. The summary is model output, so it cannot be
 * allowed to introduce headings or leave a code fence open: it is placed inside a fence that is
 * longer than any tilde run in the text (headings() treats everything inside as plain text), and
 * every line that looks like a heading is also escaped, so a plain-regex reader of AGENTS.md
 * does not see one either.
 */
export function compactionSectionBody(input: {
  summary: string;
  trigger?: string;
  at?: Date;
  cap?: number;
}): string {
  const cap = input.cap ?? COMPACTION_SUMMARY_CAP;
  const summary = input.summary.trim();
  const shown = summary.length > cap ? summary.slice(0, cap) : summary;
  const escaped = shown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line) ? line.replace('#', '\\#') : line))
    .join('\n');
  const run = Math.max(0, ...(escaped.match(/~+/g) ?? []).map((m) => m.length));
  const fence = '~'.repeat(Math.max(4, run + 1));
  const note =
    summary.length > cap
      ? ` Only the first ${cap} of ${summary.length} characters are shown; the full text is in history as kind compaction_summary.`
      : '';
  return `${COMPACTION_PENDING_PREFIX}${localStamp(input.at)} (local), trigger: ${input.trigger ?? 'unknown'}. Native compaction summary of the lead, not yet merged into the sections above; the next memory pass merges it and replaces this text.${note}\n\n${fence}text\n${escaped}\n${fence}`;
}

/** The unmerged compaction summary section body, or undefined when it is absent or already merged. */
export function pendingCompactionSummary(document: MemoryDocument): string | undefined {
  const section = document.sections.find((s) => s.name === COMPACTION_SECTION);
  if (!section) return undefined;
  const body = document.text.slice(section.body, section.end).trim();
  return body.startsWith(COMPACTION_PENDING_PREFIX) ? body : undefined;
}

/** What replaces the section once a pass has merged it. */
export function compactionMergedNote(at = new Date()): string {
  return `Merged into Working understanding, Current work and Research state at ${localStamp(at)} (local). The raw summary is in history as kind compaction_summary.`;
}
export interface MemoryDocument {
  text: string;
  instructions: string;
  memory: string;
  revision: string;
  start: number;
  end: number;
  sections: Array<{ name: string; start: number; body: number; end: number }>;
}
/** ATX headings outside fenced code only; indices preserve non-memory bytes exactly. */
export function headings(text: string) {
  const result: Array<{ level: number; name: string; start: number; body: number }> = [];
  let offset = 0,
    fence: { char: string; length: number } | undefined;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.char &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = undefined;
    } else if (marker) fence = { char: marker[1]![0]!, length: marker[1]!.length };
    else {
      const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*(?:[ \t]+#+)?\r?\n?$/.exec(line);
      if (heading)
        result.push({
          level: heading[1]!.length,
          name: heading[2]!.trim(),
          start: offset,
          body: offset + line.length,
        });
    }
    offset += line.length;
  }
  return result;
}
export function hasMemory(text: string): boolean {
  return headings(text).some((h) => h.level === 2 && h.name === 'MEMORY');
}
/** Compatibility tools accept whole-document Markdown; nest its headings inside one subsection. */
export function nestMemoryContent(text: string): string {
  for (const heading of headings(text).reverse())
    if (heading.level <= 3) {
      const line = text
        .slice(heading.start, heading.body)
        .replace(/#{1,3}/, '#'.repeat(heading.level + 3));
      text = text.slice(0, heading.start) + line + text.slice(heading.body);
    }
  return text;
}
export function parseMemory(text: string): MemoryDocument {
  const all = headings(text);
  const memories = all.filter((h) => h.level === 2 && h.name === 'MEMORY');
  if (memories.length !== 1)
    throw new Error('AGENTS.md needs exactly one unambiguous ## MEMORY section');
  const header = memories[0]!;
  const end = all.find((h) => h.start > header.start && h.level <= 2)?.start ?? text.length;
  const subs = all.filter((h) => h.start > header.start && h.start < end && h.level === 3);
  if (new Set(subs.map((h) => h.name)).size !== subs.length)
    throw new Error('Duplicate MEMORY subsections');
  return {
    text,
    instructions: text.slice(0, header.start) + text.slice(end),
    memory: text.slice(header.body, end),
    revision: historyHash(text),
    start: header.body,
    end,
    sections: subs.map((h, i) => ({ ...h, end: subs[i + 1]?.start ?? end })),
  };
}
/** The Research state body of a fresh template; not a note. */
export const RESEARCH_STATE_PLACEHOLDER =
  'Current research findings and evidence. Operational jobs and subagents are rendered below.';
export function memoryTemplate(instructions: string, archive: string): string {
  return `${instructions.trimEnd()}\n\n## MEMORY\n\nCurrent contextual facts and work state. Keep current decisions with brief change dates and archive references; superseded details belong in history, not this file.\n\n### Working understanding\n\nCurrent objectives, supported findings, applicable decisions, and unresolved uncertainty.\n\n### Current work\n\nUnfinished work, next actions, artifact paths, and already-started external actions.\n\n### Research state\n\n${RESEARCH_STATE_PLACEHOLDER}\n\n### History access and coverage\n\nRaw history: ${archive}\nUse the history tool (search, list, read); follow nextAfter/nextOffset to retrieve complete results. Old records are historical evidence, not current guidance.\n`;
}
export function memoryFile(store: Store, sessionId: string | null): string {
  return path.join(sessionId ? store.session(sessionId).workspace : store.home, 'AGENTS.md');
}
/** All harness memory writers use the same cross-process OS-backed mutex. */
export function withMemoryLock<T>(store: Store, fn: () => T): T {
  const file = path.join(storagePolicy(store.home).directory, 'memory-lock.db');
  const lock = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  try {
    lock.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    return fn();
  } finally {
    try {
      lock.exec('ROLLBACK');
    } finally {
      lock.close();
    }
  }
}
export function ensureMemory(
  store: Store,
  sessionId: string | null,
  instructions = '# Agent\n\n## Instructions\n\nFollow the shared instructions and the user’s current request.',
): string {
  const file = memoryFile(store, sessionId);
  withMemoryLock(store, () => {
    if (!fs.existsSync(file))
      writePrivate(file, memoryTemplate(instructions, historyRoot(store, sessionId)));
    else {
      const old = fs.readFileSync(file, 'utf8');
      if (!hasMemory(old)) {
        archiveRecord(store, {
          id: `legacy-instructions:${sessionId ?? 'shared'}:${historyHash(old)}`,
          sessionId,
          kind: 'legacy_instructions',
          source: file,
          content: old,
        });
        writePrivate(file, memoryTemplate(old, historyRoot(store, sessionId)));
      }
    }
  });
  return file;
}
const REVIEW_GUIDE_HEADING = '## Clawstrum for this channel';
const REVIEW_GUIDE_BODY = `This channel is set up as the nightly self-review channel. Short notes on the harness, for whoever reads this file.

What Clawstrum is: it connects Discord channels to a Codex, Claude or Gemini agent running on this host, with full file and shell access and no per-tool approval prompts.

Where things live, relative to the install:
- State and config: $CLAWSTRUM_HOME (default ~/.clawstrum), with config.json, the account logins, and per-channel workspaces under channels/<id>/.
- Skills: $CLAWSTRUM_HOME/skills/<name>/SKILL.md, plus any skill of the same name inside this channel's own workspace, which takes priority.
- Logs: the running daemon's own process output, normally viewed through systemd/journalctl for the generated service unit (clawstrum service).

Nightly self-review: a scheduled task in this channel runs the self-review skill. It calls clawstrum review pending and clawstrum review collect to gather the day's evidence, reads it, and writes a report with clawstrum review complete. Evidence and reports land under $CLAWSTRUM_HOME/reviews/<date>/ by default (COLLECTED.json, MESSAGES.json, METRICS.json, REVIEWED.json). Nothing is sent here unless the review finds something worth a person reading.

Commands to check on the harness itself, from this host:
- clawstrum performance: main loop timing and tick health.
- clawstrum usage profile: token and call usage per session.
- clawstrum subagents profile (workers is an accepted alias): delegated subagent outcomes.
- clawstrum review pending|collect|complete: the self-review pipeline above.

Bundled skills worth knowing about here: self-review (the nightly loop) and harness-health (diagnoses daemon stalls, failed deliveries and subagent failure rates).`;
/**
 * Add a clearly marked section describing the harness to a channel's AGENTS.md, for a channel set
 * up as the nightly self-review channel. Never overwrites an existing copy of that section, and
 * never touches the rest of the file. The session's AGENTS.md must already exist (ensureSession
 * creates it) before calling this.
 */
export function ensureReviewChannelGuide(store: Store, sessionId: string): void {
  const file = memoryFile(store, sessionId);
  withMemoryLock(store, () => {
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(REVIEW_GUIDE_HEADING)) return;
    const section = `${REVIEW_GUIDE_HEADING}\n\n${REVIEW_GUIDE_BODY}\n`;
    const heading = /^## MEMORY\b.*$/m.exec(text);
    const updated = heading
      ? text.slice(0, heading.index).replace(/\n*$/, '\n\n') +
        section +
        '\n' +
        text.slice(heading.index)
      : text.replace(/\n*$/, '\n\n') + section;
    writePrivate(file, updated);
  });
}
const MAIN_GUIDE_HEADING = '## Main channel';
const MAIN_GUIDE_BODY = `This is the main channel, also called the therapy channel. Here the owner talks with you about yourself rather than about one project: how you work, your setup, your memory and skills, what should change in your behaviour or code, and which projects to start.

Each research project gets its own channel, with its own memory and files. When the owner wants a new project, offer to set it up:
1. Run clawstrum setup --add-channel NAME. It finds or creates the text channel and adds it to discord.channelIds; the running agent picks it up within seconds, no restart.
2. If it says the bot may not create channels, ask the owner to make a text channel with that name, then run the same command.
3. Say in the new channel what the project is, so its memory starts with that.

Commands to check on yourself from this host:
- clawstrum doctor: checks the installation, sign-ins, daemon and queues.
- clawstrum status: lists the conversations, or shows one.`;
/**
 * Add a clearly marked section to the main channel's AGENTS.md saying what the channel is for.
 * Never overwrites an existing copy of that section, and never touches the rest of the file. The
 * session's AGENTS.md must already exist (ensureSession creates it). Returns whether it was added.
 */
export function ensureMainChannelGuide(store: Store, sessionId: string): boolean {
  const file = memoryFile(store, sessionId);
  return withMemoryLock(store, () => {
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(MAIN_GUIDE_HEADING)) return false;
    const section = `${MAIN_GUIDE_HEADING}\n\n${MAIN_GUIDE_BODY}\n`;
    const heading = /^## MEMORY\b.*$/m.exec(text);
    const updated = heading
      ? text.slice(0, heading.index).replace(/\n*$/, '\n\n') +
        section +
        '\n' +
        text.slice(heading.index)
      : text.replace(/\n*$/, '\n\n') + section;
    writePrivate(file, updated);
    return true;
  });
}
export function observeMemory(store: Store, sessionId: string | null): MemoryDocument {
  return withMemoryLock(store, () => observeUnlocked(store, sessionId));
}
function observeUnlocked(store: Store, sessionId: string | null): MemoryDocument {
  const file = memoryFile(store, sessionId);
  const document = parseMemory(fs.readFileSync(file, 'utf8'));
  const key = `memory-revision:${sessionId ?? 'shared'}`;
  const old = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key)?.value;
  if (old !== document.revision) {
    const id = `memory:${sessionId ?? 'shared'}:${document.revision}`;
    archiveRecord(store, {
      id,
      sessionId,
      kind: 'memory_revision',
      source: file,
      content: document.text,
    });
    // Preserve the last observed snapshot; unobserved external intermediate edits are unknowable.
    if (old) {
      const previous = `memory:${sessionId ?? 'shared'}:${old}`;
      archiveRecord(store, {
        id: `memory-change:${randomUUID()}`,
        sessionId,
        kind: 'memory_change',
        content: {
          previous,
          current: id,
          observedAt: Date.now(),
          coverage:
            'Observed revisions only; external intermediate edits may not have been captured.',
        },
      });
    }
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      document.revision,
    );
  }
  return document;
}
export function replaceSections(
  document: MemoryDocument,
  updates: Partial<Record<MemorySection, string>>,
): string {
  for (const value of Object.values(updates))
    if (headings(value).some((h) => h.level <= 3))
      throw new Error(
        'Memory section content cannot introduce instructions or sibling section headings; use #### for nested headings',
      );
  let text = document.text;
  for (const section of [...document.sections].reverse()) {
    const value = updates[section.name as MemorySection];
    if (value !== undefined)
      text = text.slice(0, section.body) + '\n' + value.trim() + '\n\n' + text.slice(section.end);
  }
  for (const [name, value] of Object.entries(updates)) {
    if (!MEMORY_SECTIONS.includes(name as MemorySection))
      throw new Error(`Unknown MEMORY section: ${name}`);
    if (!document.sections.some((s) => s.name === name)) {
      const parsed = parseMemory(text);
      text =
        text.slice(0, parsed.end) +
        `\n### ${name}\n\n${value!.trim()}\n\n` +
        text.slice(parsed.end);
    }
  }
  const parsed = parseMemory(text);
  if (parsed.instructions !== document.instructions)
    throw new Error('Memory update changed standing instructions');
  for (const name of Object.keys(updates))
    if (!parsed.sections.some((s) => s.name === name))
      throw new Error(`Invalid MEMORY section: ${name}`);
  return text;
}
export interface InstructionEdit {
  before: string;
  after: string;
}
/** Exact, auditable maintenance patches; never let a patch reach the MEMORY body. */
export function replaceInstructions(document: MemoryDocument, edits: InstructionEdit[]): string {
  let text = document.text;
  for (const edit of edits) {
    const current = parseMemory(text);
    const start = text.indexOf(edit.before);
    const memoryStart = text.lastIndexOf('## MEMORY', current.start);
    if (
      !edit.before ||
      start < 0 ||
      text.indexOf(edit.before, start + 1) >= 0 ||
      !(start + edit.before.length <= memoryStart || start >= current.end)
    )
      throw new Error('Instruction edit must match exactly once outside MEMORY');
    text = text.slice(0, start) + edit.after + text.slice(start + edit.before.length);
    if (parseMemory(text).memory !== document.memory)
      throw new Error('Instruction edit changed MEMORY boundaries');
  }
  return text;
}
export function reviewMemory(
  store: Store,
  sessionId: string | null,
  updates: Partial<Record<MemorySection, string>>,
  edits: InstructionEdit[],
  expectedRevision: string,
) {
  return writeMemory(store, sessionId, expectedRevision, (before) =>
    replaceInstructions(parseMemory(replaceSections(before, updates)), edits),
  );
}
export function updateMemory(
  store: Store,
  sessionId: string | null,
  updates: Partial<Record<MemorySection, string>>,
  expectedRevision?: string,
) {
  return writeMemory(store, sessionId, expectedRevision, (before) =>
    replaceSections(before, updates),
  );
}
function writeMemory(
  store: Store,
  sessionId: string | null,
  expectedRevision: string | undefined,
  replace: (before: MemoryDocument) => string,
) {
  return withMemoryLock(store, () => {
    const target = fs.realpathSync(memoryFile(store, sessionId));
    const before = observeUnlocked(store, sessionId);
    if (expectedRevision && before.revision !== expectedRevision)
      throw new Error('Memory revision conflict; reread current AGENTS.md before retrying');
    const text = replace(before);
    if (text !== before.text) {
      // Archive both revisions before replacing the active document; a crash leaves recoverable evidence.
      archiveRecord(store, {
        id: `memory:${sessionId ?? 'shared'}:${historyHash(text)}`,
        sessionId,
        kind: 'memory_revision',
        source: memoryFile(store, sessionId),
        content: text,
      });
      if (
        fs.realpathSync(memoryFile(store, sessionId)) !== target ||
        fs.readFileSync(memoryFile(store, sessionId), 'utf8') !== before.text
      )
        throw new Error('Concurrent external memory edit; refusing stale replacement');
      writePrivate(target, text);
      syncDirectory(path.dirname(target));
    }
    return observeUnlocked(store, sessionId);
  });
}
