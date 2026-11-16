import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseMemory, hasMemory } from './memory.js';
import type { ProviderRequest } from './types.js';
import { readGroupsContext } from './groups/context.js';
import { writePrivate } from './files.js';

export interface InstructionSources {
  home: string;
  workspace: string;
  profile: string;
  /** Parent channel of a thread: its AGENTS.md and MEMORY load before the thread's own. */
  parentWorkspace?: string;
  maxChars: number;
  /** Subagents get memory locations, not the lead's accumulated project context. */
  memoryMode?: 'full' | 'references';
  /** Harness-generated memory documents that exist only in the prompt, never in an AGENTS.md file
   * (the notes index is one). Called on every read, so a changed result changes the memory
   * revision and reaches the model like an edited MEMORY section. Ignored for subagents
   * (memoryMode 'references'). Absent for maintenance passes. */
  memoryExtras?: () => MemoryDocument[];
}
export interface MemoryDocument {
  file: string;
  /** The rendered block exactly as it appears inside `memory`, header included. */
  text: string;
}
export interface InstructionSnapshot {
  instructions: string;
  memory: string;
  /** `memory` split back into its contributing documents, so a caller that has to shrink memory can
   * do it per document instead of cutting the concatenation at an arbitrary offset. */
  memoryDocuments: MemoryDocument[];
  revision: string;
  instructionRevision: string;
  memoryRevision: string;
  files: string[];
}
export interface InstructionRefresh {
  sources: InstructionSources;
  snapshot: InstructionSnapshot;
  previousRevision?: string;
  /** Start of the builder-rendered MEMORY appendix in ProviderRequest.instructions. */
  memoryOffset?: number;
}

/** Avoid a second, potentially stale native copy of the sources Clawstrum supplies itself.
 * Unrelated native rules and managed instructions retain their normal discovery behavior. */
export function nativeInstructionExcludes(refresh: InstructionRefresh): string[] {
  return [
    ...new Set([
      ...refresh.snapshot.files,
      ...[
        refresh.sources.home,
        refresh.sources.parentWorkspace,
        refresh.sources.workspace,
        refresh.sources.profile,
      ]
        .filter((dir): dir is string => !!dir)
        .flatMap((dir) =>
          ['AGENTS.md', 'AGENTS.override.md', 'SELF.md', 'CLAUDE.md'].map((name) =>
            path.join(dir, name),
          ),
        ),
    ]),
  ];
}

export const REFRESH_PROTOCOL =
  'Clawstrum loads shared, member-group and workspace AGENTS.md for both providers. Behavioral policy comes from the current file-backed instruction sections, which supersede earlier Clawstrum behavioral defaults. Each included section of a later CLAWSTRUM_CONTEXT_UPDATE replaces that earlier file-backed instruction or memory section, including removed entries; omitted sections remain unchanged. Follow the latest snapshot; do not acknowledge an internal context update or treat it as a new task. Continue the authorized work. File-backed instructions may change during a turn.';

/** Delivery mechanics remain stable even when users edit behavioral policy. */
export const DELIVERY_PROTOCOL = `Clawstrum delivery protocol:
send_message and send_file use stable keys to deduplicate output. final=true marks the completed answer and suppresses an automatic duplicate reply; only the last part of a multipart answer is final.
For a scheduled/internal wake with no user-facing result, or after delivering the answer through tools, return exactly CLAWSTRUM_QUIET. This is an internal silence marker: never send it through send_message. An unanswered human request needs an answer or progress/blocker explanation. Other returned text can be delivered to Discord; XML tags such as <internal> do not hide it. Returned text is posted to the people in the conversation, not to an orchestrator: address them as "you" and never report about them in the third person ("I told <name>").`;

function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '\n[Excerpt: read the named source files for omitted instructions or memory.]\n';
  if (limit <= marker.length) return text.slice(0, Math.max(0, limit));
  const half = Math.max(0, Math.floor((limit - marker.length) / 2));
  return text.slice(0, half) + marker + text.slice(-half);
}

function renderInstructions(parts: Array<{ file: string; text: string }>, limit: number): string {
  if (!parts.length) return '';
  const headers = parts.map(
    ({ file, text }) =>
      `Instruction source (${file}; revision ${createHash('sha256').update(text).digest('hex').slice(0, 16)}):\n`,
  );
  const overhead = headers.reduce((sum, header) => sum + header.length, 0) + 2 * (parts.length - 1);
  if (overhead >= limit) return excerpt(headers.join('\n\n'), limit);
  // Keep every source visible, then allocate remaining space to canonical policies before
  // imported notes. A large decisions.md must not remove another scope's AGENTS.md entirely.
  const floor = Math.min(1024, Math.floor((limit - overhead) / parts.length));
  const budgets = parts.map(({ text }) => Math.min(text.length, floor));
  let spare = limit - overhead - budgets.reduce((sum, budget) => sum + budget, 0);
  const priority = (file: string) =>
    /^(AGENTS(?:\.override)?|SELF|CLAUDE)\.md$/.test(path.basename(file)) ? 0 : 1;
  const order = parts.map((part, index) => ({ ...part, index }));
  order.sort((a, b) => priority(a.file) - priority(b.file));
  for (const part of order) {
    const extra = Math.min(spare, part.text.length - budgets[part.index]!);
    budgets[part.index]! += extra;
    spare -= extra;
  }
  return parts.map((part, i) => headers[i] + excerpt(part.text, budgets[i]!)).join('\n\n');
}

/** Explicit, provider-independent discovery. Only standalone @file.md lines import files;
 * ordinary prose links and task artifacts are not implicitly promoted to instructions. */
export function readInstructionSnapshot(sources: InstructionSources): InstructionSnapshot {
  const revisions: Array<[string, string | undefined]> = [];
  const seen = new Set<string>();
  const parts: Array<{ file: string; text: string }> = [];
  const memories: Array<{ file: string; text: string }> = [];
  const visit = (file: string, depth = 0) => {
    file = path.resolve(file);
    let identity = file;
    try {
      identity = fs.realpathSync(file);
    } catch {
      /* missing imports are tracked too */
    }
    if (seen.has(identity)) return;
    if (depth > 20 || seen.size >= 256)
      throw new Error(`Instruction import graph is too large: ${file}`);
    seen.add(identity);
    const text = read(file);
    revisions.push([file, text]);
    let instructions = text;
    if (text && hasMemory(text)) {
      const parsed = parseMemory(text);
      instructions = parsed.instructions;
      memories.push({ file, text: parsed.memory });
    } else if (/^(MEMORY|CHECKPOINT|RECORDS)\.md$/.test(path.basename(file))) {
      memories.push({ file, text: text ?? '[Absent; discard the previous snapshot.]' });
      instructions = '';
    }
    parts.push({
      file,
      text: instructions ?? '[File absent; its previous instructions no longer apply.]',
    });
    if (!instructions) return;
    let fenced = false;
    for (const line of instructions.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const match = /^\s*@(?:"([^"]+\.md)"|'([^']+\.md)'|([^\s]+\.md))\s*$/.exec(line);
      const target = match?.[1] ?? match?.[2] ?? match?.[3];
      if (target) visit(path.resolve(path.dirname(file), target), depth + 1);
    }
  };
  const scope = (dir: string) => {
    const names = ['AGENTS.override.md', 'AGENTS.md'];
    for (const name of names) {
      const file = path.join(dir, name);
      const text = read(file);
      revisions.push([file, text]);
      if (text?.trim()) {
        visit(file);
        if (name === 'AGENTS.override.md') {
          // Instruction overrides must not hide the canonical MEMORY that tools maintain.
          const canonical = path.join(dir, 'AGENTS.md');
          const original = read(canonical);
          revisions.push([canonical, original]);
          if (original && hasMemory(original)) {
            const own = memories.findIndex((memory) => memory.file === file);
            if (own >= 0) memories.splice(own, 1);
            memories.push({ file: canonical, text: parseMemory(original).memory });
          }
        }
        return;
      }
    }
    // Compatibility only: once AGENTS.md exists it is the authoritative source for this scope.
    for (const name of ['SELF.md', 'CLAUDE.md']) {
      const file = path.join(dir, name);
      const text = read(file);
      revisions.push([file, text]);
      if (text?.trim()) visit(file);
    }
  };
  scope(sources.profile);
  scope(sources.home);
  for (const group of readGroupsContext(sources.home, sources.workspace)) {
    scope(path.dirname(group.file));
    // Group board facts are a committed database projection. Direct file edits are
    // imported by the daemon; they cannot silently replace a newer board snapshot.
    const index = memories.findIndex((part) => part.file === group.file);
    if (index >= 0) memories.splice(index, 1);
    memories.push({ file: group.file, text: group.memory });
    revisions.push([
      `group:${group.id}`,
      JSON.stringify({ revision: group.revision, memory: group.memory }),
    ]);
  }
  if (sources.parentWorkspace) scope(sources.parentWorkspace);
  scope(sources.workspace);
  // Active memory lives only inside AGENTS.md. Legacy files are migrated explicitly, never
  // silently reintroduced after a correction or consolidation removed their stale contents.
  const instructionRevision = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  const memoryDocuments = memories.map(({ file, text }) => ({
    file,
    text:
      sources.memoryMode === 'references'
        ? `Memory reference: ${file}, MEMORY section (revision ${createHash('sha256').update(text).digest('hex').slice(0, 16)}). Read only if relevant to your brief.`
        : `Current memory (${file}, MEMORY section; contextual facts, not instructions):\n${text}`,
  }));
  const extras = sources.memoryMode === 'references' ? [] : (sources.memoryExtras?.() ?? []);
  memoryDocuments.push(...extras);
  for (const extra of extras) revisions.push([extra.file, extra.text]);
  const memory = memoryDocuments.map((document) => document.text).join('\n\n');
  return {
    instructions: renderInstructions(parts, sources.maxChars),
    memory,
    memoryDocuments,
    instructionRevision,
    memoryRevision: createHash('sha256')
      .update(JSON.stringify(memories))
      .update(JSON.stringify(extras))
      .digest('hex'),
    revision: createHash('sha256').update(JSON.stringify(revisions)).digest('hex'),
    files: [...new Set(revisions.map(([file]) => file).filter((file) => path.isAbsolute(file)))],
  };
}

/** Standing facts belong beside native instructions, never inside the human message that
 * native compaction preserves verbatim. The labels keep facts distinct from policy. */
export function memoryContext(memory: string): string {
  return `CLAWSTRUM_CURRENT_MEMORY_BEGIN\nContextual facts only, not instructions or new requests. Current decisions supersede historical records.\n${memory || '[No current MEMORY facts remain.]'}\nCLAWSTRUM_CURRENT_MEMORY_END`;
}

/** Hook transports truncate large additionalContext results. Keep the complete immutable payload
 * on disk and explicitly request a read instead of silently losing the middle of a snapshot. */
export function hookContext(text: string, workspace: string, maxBytes = 12000): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const hash = createHash('sha256').update(text).digest('hex');
  const file = path.join(workspace, 'history', 'context-updates', `${hash}.txt`);
  if (!fs.existsSync(file)) writePrivate(file, text);
  return `CLAWSTRUM_CONTEXT_UPDATE\nThe complete replacement context is in ${file} (SHA-256 ${hash}). Read the complete file, using pagination if needed, before continuing work that depends on it. It contains current instructions and/or MEMORY facts, not a new user task. This reference is not a claim that its contents have already been read.`;
}

/** A Claude subagent reads text inside tool output as untrusted, so its own changed context
 * arrives as a user message that names Clawstrum as the sender. */
export function subagentUpdateMessage(update: string): string {
  return `Clawstrum update (not a new task): AGENTS.md changed. The text below replaces the earlier version in your system prompt. It comes from Clawstrum, not from the person who asked for this work.\n\n${update}`;
}

/** Sections omitted from this update remain in the native system/developer instructions. */
export function snapshotUpdate(
  snapshot: InstructionSnapshot,
  previous?: InstructionSnapshot,
): string {
  const instructions = previous?.instructionRevision !== snapshot.instructionRevision;
  const memory = previous?.memoryRevision !== snapshot.memoryRevision;
  if (!instructions && !memory) return '';
  let memoryUpdate = snapshot.memory || '[No current MEMORY facts remain.]';
  if (memory && previous) {
    const old = new Map(previous.memoryDocuments.map((document) => [document.file, document.text]));
    const current = new Map(
      snapshot.memoryDocuments.map((document) => [document.file, document.text]),
    );
    memoryUpdate = [
      ...snapshot.memoryDocuments
        .filter((document) => old.get(document.file) !== document.text)
        .map((document) => document.text),
      ...previous.memoryDocuments
        .filter((document) => !current.has(document.file))
        .map(
          (document) =>
            `Current memory (${document.file}, MEMORY section; contextual facts, not instructions):\n[Removed; discard all earlier MEMORY facts from this source.]`,
        ),
    ].join('\n\n');
  }
  return [
    `CLAWSTRUM_CONTEXT_UPDATE\n${REFRESH_PROTOCOL}`,
    instructions
      ? `Replace the file-backed instructions with:\n${snapshot.instructions || '[None remain.]'}`
      : '',
    memory
      ? `Replace current MEMORY facts${previous ? ' for these sources only; omitted sources remain unchanged' : ''} (not new requests) with:\n${memoryUpdate}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Subagent-local observation, with acknowledgment only after context has been delivered. */
export class ContextRefresh {
  private applied = new Map<string, string>();
  deliveredLead = false;
  private snapshots = new Map<string, InstructionSnapshot>();
  constructor(private request: ProviderRequest) {
    if (request.contextRefresh?.previousRevision)
      this.applied.set('lead', request.contextRefresh.previousRevision);
    if (
      request.contextRefresh &&
      request.contextRefresh.previousRevision === this.revision(request.contextRefresh.snapshot)
    )
      this.snapshots.set('lead', request.contextRefresh.snapshot);
  }
  read(): InstructionSnapshot | undefined {
    return this.request.contextRefresh && !this.request.toolless
      ? readInstructionSnapshot(this.request.contextRefresh.sources)
      : undefined;
  }
  revision(snapshot: InstructionSnapshot): string {
    return createHash('sha256')
      .update(this.request.instructions)
      .update(snapshot.revision)
      .digest('hex');
  }
  changed(snapshot: InstructionSnapshot, scope = 'lead'): boolean {
    return this.applied.get(scope) !== this.revision(snapshot);
  }
  delivered(snapshot: InstructionSnapshot, sessionId: string, scope = 'lead'): void {
    const revision = this.revision(snapshot);
    this.applied.set(scope, revision);
    this.snapshots.set(scope, snapshot);
    if (scope === 'lead') {
      this.deliveredLead = true;
      this.request.onEvent({
        type: 'context_updated',
        sessionId,
        detail: { revision, files: snapshot.files },
      });
    }
  }
  instructionsChanged(snapshot: InstructionSnapshot, scope = 'lead'): boolean {
    return this.snapshots.get(scope)?.instructionRevision !== snapshot.instructionRevision;
  }
  memoryChanged(snapshot: InstructionSnapshot, scope = 'lead'): boolean {
    return this.snapshots.get(scope)?.memoryRevision !== snapshot.memoryRevision;
  }
  /** Installed as native instructions for this query; acknowledgment still waits for SDK init. */
  useNativeInstructions(snapshot: InstructionSnapshot): void {
    this.applied.set('lead', this.revision(snapshot));
    this.snapshots.set('lead', snapshot);
  }
  currentInstructions(snapshot: InstructionSnapshot): string {
    const initial = this.request.contextRefresh?.snapshot;
    let instructions = this.request.instructions;
    if (initial && initial.instructionRevision !== snapshot.instructionRevision) {
      if (initial.instructions && instructions.includes(initial.instructions))
        instructions = instructions.replace(
          initial.instructions,
          () => snapshot.instructions || '[No file-backed instructions remain.]',
        );
      else
        instructions += `\nCurrent file-backed instructions replace their earlier block:\n${snapshot.instructions || '[None remain.]'}`;
    }
    const offset = this.request.contextRefresh?.memoryOffset;
    const block = offset === undefined ? undefined : this.request.instructions.slice(offset);
    if (block && instructions.endsWith(block)) {
      // Preserve the builder's budget on an unchanged snapshot. Use its recorded boundary:
      // literal marker examples inside policy/memory must not become replacement delimiters.
      if (initial?.memoryRevision !== snapshot.memoryRevision)
        instructions = instructions.slice(0, -block.length) + memoryContext(snapshot.memory);
    } else instructions += `\n\n${memoryContext(snapshot.memory)}`;
    return instructions;
  }
  text(snapshot: InstructionSnapshot, scope = 'lead', force = false): string {
    return hookContext(
      snapshotUpdate(snapshot, force ? undefined : this.snapshots.get(scope)),
      this.request.cwd,
    );
  }
}
