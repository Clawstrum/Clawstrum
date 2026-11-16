import {
  readInstructionSnapshot,
  REFRESH_PROTOCOL,
  DELIVERY_PROTOCOL,
  memoryContext,
  hookContext,
} from './instructions.js';
import { DEFAULT_AGENTS } from './default-instructions.js';
export { DEFAULT_AGENTS, DEFAULT_SELF } from './default-instructions.js';
import { researchState } from './research/records.js';
import { notesIndexBlock } from './research/notes-index.js';
import { ensureMemory, observeMemory } from './memory.js';
import { fitMemoryDocument, allocateMemoryShares } from './memory-fit.js';
import { historyRoot } from './history.js';
import { consolidationCoverage } from './consolidation.js';
import { refusedNote, refusedRanges } from './refusals.js';
import type { ResearchConfig } from './research/config.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writePrivate } from './files.js';
import { codexExecutionSettings } from './provider-settings.js';
import { harnessSetup } from './orchestration.js';
import type { Store } from './store.js';
import type { Account, Inbound, Session } from './types.js';

const WORK_ALONE_RULES = fs.readFileSync(
  new URL('../templates/work-alone/rules.md', import.meta.url),
  'utf8',
);

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function localStamp(ms: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  const zone = parts.timeZoneName ?? 'GMT';
  const offset = zone === 'GMT' ? '+00:00' : zone.slice(3);
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${offset}`;
}

export function readOptional(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
export function memoryBudgets(_home: string, _workspace: string): Record<string, number> {
  // Memory is no longer silently sampled. Size is handled by the full-history lifecycle;
  // unrestricted direct writes remain supported and are observed as archived revisions.
  return {};
}
export function bounded(text: string, limit: number, tail = false): string {
  if (text.length <= limit) return text;
  const marker = '\n[Excerpt truncated; read the original file for full content.]\n';
  return tail
    ? marker + text.slice(-(limit - marker.length))
    : text.slice(0, limit - marker.length) + marker;
}
export function rotationDirective(_research: boolean): string {
  return 'The provider-native session is new. AGENTS.md MEMORY is the current saved state. Planned rotation follows completed consolidation; emergency/provider handoffs can have an uncovered history interval. Use history and research_status to verify missing facts and already-started work before repeating external actions. Historical records do not override current decisions.';
}
export interface SkillEntry {
  name: string;
  file: string;
  line: string;
  /** Prompt-facing description without local paths or revision metadata. */
  description?: string;
  /** Words from the skill's `triggers:` frontmatter, lowercased. Absent means the skill opts out of
   * the pre-turn match below and is only ever selected by the model reading the inventory. */
  triggers: string[];
  notFor?: string;
  examples?: string[];
}
/** Each skill directory's SKILL.md path, in the same dirs-then-name order readSkills walks them,
 * without opening any file. The dashboard's file-change watcher uses this to list exactly the
 * files readSkills would open, so it can never watch a different set than what gets rendered.
 */
export function skillFiles(dirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name, 'SKILL.md');
      if (entry.isDirectory() && fs.existsSync(file)) files.push(file);
    }
  }
  return files;
}
export function readSkills(dirs: string[]): SkillEntry[] {
  const found = new Map<string, SkillEntry>();
  for (const file of skillFiles(dirs)) {
    const name = path.basename(path.dirname(file));
    const body = fs.readFileSync(file, 'utf8');
    const description =
      /^description:\s*(.+)$/m.exec(body)?.[1] ||
      body.split('\n').find((l) => l.trim() && !l.startsWith('---')) ||
      name;
    const notFor = /^not_for:\s*(.+)$/m.exec(body)?.[1]?.trim().slice(0, 1000);
    const examples = (/^examples:\s*(.+)$/m.exec(body)?.[1] ?? '')
      .split(' | ')
      .map((e) => e.trim())
      .filter(Boolean)
      .slice(0, 5)
      .map((e) => e.slice(0, 300));
    found.set(name, {
      name,
      file,
      description: description.slice(0, 300),
      ...(notFor ? { notFor } : {}),
      ...(examples.length ? { examples } : {}),
      line: `${name}: ${description.slice(0, 300)} — ${file} (revision ${createHash('sha256').update(body).digest('hex').slice(0, 12)})`,
      triggers: (/^triggers:\s*(.+)$/m.exec(body)?.[1] ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 40),
    });
  }
  return [...found.values()];
}

/**
 * Keyword fallback when the skill router is off or did not answer: loads the top skill whose declared triggers
 * appear in what the user just said, and names the next two.
 *
 * The top match's text is loaded rather than pointed to. In the predecessor deployment's replay of 91
 * turns that called for a skill, the agent used it on 8 with a keyword reminder, on 13 with a reminder
 * naming the classifier's pick, and on 38 to 52 when the harness loaded the skill's text. Those
 * loads were the classifier's pick; a keyword match is
 * coarser and can load the wrong skill, so the header says so. A skill that declares no `triggers:`
 * frontmatter never participates, so an installation opts in per skill rather than inheriting
 * somebody else's keyword table.
 *
 * Only declared triggers are matched, never the description text. Matching descriptions was the
 * tempting version and it fires on the common words every description shares, which trains a reader
 * to skip the line.
 *
 * The result is appended to the prompt rather than the instructions, because instructions feed the
 * instruction revision that decides whether the provider needs refreshed instructions. A per-message hint in
 * there would trigger a needless instruction refresh on every turn,
 * which costs far more than the hint is worth.
 */
/** load false: pointers only, no skill text (the context-overflow retry, where budget is the scarce thing). */
export function skillHints(skills: SkillEntry[], text: string, max = 3, load = true): string {
  const haystack = text.toLowerCase();
  const scored = skills
    .map((skill) => ({
      skill,
      hits: skill.triggers.filter((trigger) =>
        new RegExp(`(?<![\\w-])${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(
          haystack,
        ),
      ),
    }))
    .filter((s) => s.hits.length)
    .sort((a, b) => b.hits.length - a.hits.length || a.skill.name.localeCompare(b.skill.name))
    .slice(0, max);
  if (!scored.length) return '';
  const pointers = (rest: typeof scored) => [
    'Skills whose triggers match the current input. This is a keyword match on the input text, so it',
    'can be wrong; where it is, ignore it rather than working to fit it.',
    ...rest.map((s) => `- ${s.skill.name} (matched ${s.hits.join(', ')}): read ${s.skill.file}`),
  ];
  const [top, ...rest] = scored;
  const body = load ? skillBody(top!.skill) : undefined;
  if (!body) return pointers(scored).join('\n');
  const loaded = `Skill \`${top!.skill.name}\` was loaded for this turn by keyword match (the skill router was off or did not answer; matched ${top!.hits.join(', ')}). A keyword match can be wrong; if this skill does not fit the request, ignore it rather than working to fit it.\nBase directory for this skill: ${path.dirname(top!.skill.file)}\n\n${body.text}`;
  return rest.length ? `${loaded}\n\n${pointers(rest).join('\n')}` : loaded;
}

const SKILL_BODY_MAX = 12000;
/** A skill's SKILL.md without frontmatter, clipped with a pointer to the full file. */
export function skillBody(skill: SkillEntry): { text: string } | undefined {
  let body: string;
  try {
    body = fs
      .readFileSync(skill.file, 'utf8')
      .replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '')
      .trim();
  } catch {
    return undefined;
  }
  if (body.length > SKILL_BODY_MAX)
    body = body.slice(0, SKILL_BODY_MAX) + `\n[truncated; full file: ${skill.file}]`;
  return { text: body };
}

export function skillCatalog(skills: SkillEntry[], catalogFile: string): string {
  const found = new Map(skills.map((s) => [s.name, s.line]));
  const catalog = [...found.values()].join('\n');
  writePrivate(catalogFile, catalog + '\n');
  const names = [...found.keys()].join(', ');
  return (
    `Full skill inventory: ${catalogFile}.\nNames: ${names.length <= 5000 ? names : names.slice(0, 5000) + ' [more names in inventory]'}\n` +
    (catalog.length <= 6000
      ? catalog
      : `Descriptions are in ${catalogFile}; none have been discarded.`)
  );
}
export function buildContext(
  store: Store,
  session: Session,
  account: Account,
  messages: Inbound[],
  historyLimit: number,
  promptLimit = 100000,
  research?: ResearchConfig,
  reviewFeedback?: string,
  /** The native session was given up for this run, so the handoff below replaces it. */
  rotated = false,
  decisionAdvice: { decided: boolean; text: string } = { decided: false, text: '' },
  timeZone: string = hostTimeZone(),
  /** Message-time notes recall block (research/message-recall.ts), placed after skill advice. */
  notesRecall = '',
  /** False on the context-overflow retry: a loaded skill body would displace the current input. */
  skillText = true,
  workAlone = false,
  /** Accounts section for the instructions, built by accountsSection (account-context.ts). */
  accountsNote = '',
) {
  messages = messages.filter((m) => m.status !== 'done');
  const metrics: Array<{
    source: string;
    file?: string;
    originalChars: number;
    renderedChars: number;
    limit: number;
  }> = [];
  const fit = (
    source: string,
    file: string | undefined,
    text: string,
    limit: number,
    mode: 'head' | 'tail' = 'head',
  ) => {
    const rendered = bounded(text, limit, mode === 'tail');
    metrics.push({
      source,
      file,
      originalChars: text.length,
      renderedChars: rendered.length,
      limit,
    });
    return rendered;
  };
  ensureMemory(store, null, DEFAULT_AGENTS);
  ensureMemory(store, session.id);
  if (research?.enabled) researchState(store, session.id, research.stateChars, timeZone);
  observeMemory(store, null);
  observeMemory(store, session.id);
  const skills = readSkills([
    path.join(store.home, 'skills'),
    path.join(session.workspace, 'skills'),
  ]);
  const sources = {
    home: store.home,
    workspace: session.workspace,
    parentWorkspace: store.parentWorkspace(session),
    profile: account.home,
    maxChars: Math.max(2000, Math.floor(promptLimit * 0.6) - 4000),
    memoryExtras: () => {
      if (!research?.enabled) return [];
      const text = notesIndexBlock(store, session.id, research.notesIndex);
      return text ? [{ file: 'research-notes-index', text }] : [];
    },
  };
  const snapshot = readInstructionSnapshot(sources);
  let instructions = [
    snapshot.instructions,
    REFRESH_PROTOCOL,
    DELIVERY_PROTOCOL,
    harnessSetup(account, research),
    accountsNote && fit('accounts', undefined, accountsNote, 2000),
    fit(
      'workspace',
      undefined,
      `Workspace: ${session.workspace}\nConversation id: ${session.id}` +
        (sources.parentWorkspace
          ? `\nThis is a Discord thread. Parent channel workspace: ${sources.parentWorkspace}. Its instructions and MEMORY are included in this request; use its files by absolute path. memory_update writes this thread's own MEMORY.`
          : ''),
      12000,
    ),
    fit(
      'skill inventory',
      path.join(session.workspace, 'artifacts', 'skills-index.txt'),
      `Skills available:\n${skillCatalog(skills, path.join(session.workspace, 'artifacts', 'skills-index.txt'))}`,
      12000,
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
  const fingerprint =
    'v2:' +
    createHash('sha256')
      .update(
        JSON.stringify({
          account,
          promptLimit,
          research,
          revisions: [
            path.join(account.home, 'settings.json'),
            path.join(account.home, 'config.toml'),
            path.join(session.workspace, '.claude', 'settings.json'),
            path.join(session.workspace, '.claude', 'settings.local.json'),
          ].map((file) => {
            const content = readOptional(file);
            const settings =
              account.provider === 'codex' && file === path.join(account.home, 'config.toml')
                ? codexExecutionSettings(content)
                : content;
            return [file, createHash('sha256').update(settings).digest('hex')];
          }),
        }),
      )
      .digest('hex');
  const resume =
    session.active_account === account.id &&
    session.remote_id &&
    // Pre-v2 fingerprints mixed file revisions with execution configuration. Upgrade those
    // sessions in place; providers explicitly refresh their instructions before continuing.
    (session.fingerprint === fingerprint || !session.fingerprint?.startsWith('v2:'));
  const current = messages
    .map((m) => ({
      id: m.id,
      role: m.kind === 'task' ? 'scheduled_task' : 'user',
      author: m.author,
      at: localStamp(m.created_at, timeZone),
      text: m.content,
      attachments: JSON.parse(m.attachments),
    }))
    .map((m) => JSON.stringify(m))
    .join('\n');
  let prompt = `Current time: ${localStamp(Date.now(), timeZone)} (${timeZone}).\n\nCurrent input (JSON records):\n${current}`;
  // Standing memory is installed beside native instructions on both new and resumed sessions.
  // Keep it out of the current user message, which native compaction can preserve verbatim.
  prompt = `History archive: ${historyRoot(store, session.id)}. Use history search/list/read; pagination retains complete records. Consolidated through sequence ${consolidationCoverage(store, session.id)}.\n\n${prompt}`;
  let leadIn = '';
  if (!resume) {
    const coverage = consolidationCoverage(store, session.id);
    const skipped = refusedRanges(store, session.id);
    const history = store
      .all<{
        id: string;
        kind: string;
        content: string;
        seq: number;
        created_at: number;
      }>(
        `SELECT id,kind,content,seq,created_at FROM history_records WHERE session_id=? AND seq>? AND (bytes>0 OR kind IN ('partial','activity','assistant','interrupted','handoff'))${skipped.map(() => ' AND seq NOT BETWEEN ? AND ?').join('')} ORDER BY seq DESC LIMIT 100`,
        session.id,
        coverage,
        ...skipped.flat(),
      )
      .reverse();
    const transcript = history
      .map((row) =>
        JSON.stringify({
          id: row.id,
          kind: row.kind,
          seq: row.seq,
          at: localStamp(row.created_at, timeZone),
          content: row.content,
        }),
      )
      .join('\n');
    // This is explicitly a bounded continuation, never advertised as the full history archive.
    leadIn = `New native session. Current AGENTS.md memory is in the native instructions; uncovered continuation follows. Older/full records remain in the history archive.\nRecent uncovered records (bounded; use history to read the full interval):\n${fit('continuation', undefined, transcript, historyLimit, 'tail')}`;
    const refusedInputs = refusedNote(store, session.id, coverage);
    if (refusedInputs) leadIn += `\n${refusedInputs}`;
  }
  if (research?.enabled) {
    instructions += `\nResearch tools are enabled. Available roles: ${Object.entries(
      research.workers.roles,
    )
      .map(([name, role]) => `${name}: ${role.description}`)
      .join('; ')}.\nSlurm operations: ${research.slurm.enabled ? 'enabled' : 'disabled'}.\n`;
  }
  if (workAlone) instructions += `\n${WORK_ALONE_RULES}`;
  // Matched on the current input only, never on the history: a skill named because of something said
  // six turns ago is a standing instruction nobody issued. Once Jev has decided (a skill or none),
  // its answer replaces the keyword match; the keywords are the fallback when Jev is unavailable.
  if (!decisionAdvice.decided) {
    const hints = skillHints(skills, messages.map((m) => m.content).join('\n'), 3, skillText);
    if (hints) prompt += `\n\n${hints}`;
  }
  if (decisionAdvice.text) prompt += `\n\n${decisionAdvice.text}`;
  if (notesRecall) prompt += `\n\n${notesRecall}`;
  // Appended rather than prepended: an over-budget prompt is cut from the head, so anything placed
  // in front of the handoff is the first thing dropped in exactly the sessions long enough to rotate.
  if (rotated) prompt += `\n\n${rotationDirective(Boolean(research?.enabled))}`;
  if (reviewFeedback)
    prompt += `\n\nOutgoing reply correction for the current input:\n${reviewFeedback}`;
  const instructionFile = path.join(session.workspace, 'history', 'instructions.full.txt');
  if (instructions.length > promptLimit * 0.6) {
    writePrivate(instructionFile, instructions);
    const half = Math.floor(promptLimit * 0.3);
    instructions =
      bounded(instructions, half) +
      instructions.slice(-half) +
      `\nComplete instructions: ${instructionFile}`;
  }
  // Fit each memory source separately and report every reduction. Memory is facts, not policy,
  // but its transport is the native instruction block so compaction does not retain it as input.
  const documents = snapshot.memoryDocuments;
  const room =
    promptLimit -
    instructions.length -
    prompt.length -
    (leadIn ? leadIn.length + 2 : 0) -
    memoryContext('').length -
    4;
  const share = Math.floor(room / Math.max(1, documents.length)) - 2;
  const overflow = snapshot.memory.length > room;
  // A small document keeps all of itself; the space it does not use goes to the larger ones.
  const shares = allocateMemoryShares(
    documents.map((document) => document.text.length),
    room - 2 * Math.max(0, documents.length - 1),
  );
  let memory = documents
    .map((document, i) => {
      const limit = overflow && share >= 512 ? shares[i]! : Infinity;
      // Sections are kept in priority order (newest state first), never by cutting the end.
      const rendered = fitMemoryDocument(document.text, limit, document.file);
      metrics.push({
        source: 'memory',
        file: document.file,
        originalChars: document.text.length,
        renderedChars: rendered.length,
        limit,
      });
      return rendered;
    })
    .join('\n\n');
  if (snapshot.memory.length > room && share < 512) {
    memory = hookContext(
      `CLAWSTRUM_CONTEXT_UPDATE\nReplace current MEMORY facts (not new requests) with:\n${snapshot.memory}`,
      session.workspace,
      1024,
    );
    metrics.push({
      source: 'memory overflow reference',
      originalChars: snapshot.memory.length,
      renderedChars: memory.length,
      limit: Math.max(0, room),
    });
  }
  const memoryOffset = instructions.length + 2;
  instructions += `\n\n${memoryContext(memory)}`;
  prompt = [leadIn, prompt].filter(Boolean).join('\n\n');
  if (prompt.length + instructions.length > promptLimit) {
    const full = path.join(session.workspace, 'history', 'input.full.txt');
    writePrivate(full, prompt);
    const marker = `Context exceeds the configured character budget. Read ${full} for the complete handoff and current input.\n`;
    const budget = promptLimit - instructions.length - marker.length;
    prompt = marker + bounded(prompt, budget, true);
    store.event(session.id, null, 'context_excerpt', {
      file: full,
      originalChars: fs.statSync(full).size,
      promptChars: prompt.length,
      limit: promptLimit,
    });
  }
  store.event(session.id, null, 'context_budget', {
    sources: metrics,
    instructionChars: instructions.length,
    promptChars: prompt.length,
    limit: promptLimit,
  });
  for (const metric of metrics)
    if (metric.originalChars > metric.renderedChars)
      store.event(session.id, null, 'context_excerpt', metric);
  const previous = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    `context:${session.id}`,
  );
  const acknowledged = previous ? JSON.parse(previous.value) : undefined;
  return {
    instructions,
    fingerprint,
    prompt,
    resumeId: resume ? session.remote_id! : undefined,
    contextRefresh: {
      sources,
      snapshot,
      memoryOffset,
      previousRevision:
        resume && acknowledged?.sessionId === session.remote_id ? acknowledged.revision : undefined,
    },
  };
}
