import path from 'node:path';

/**
 * Refuse a manuscript write until the installation's own writing rules are in context.
 *
 * A rules file sitting in the workspace is not enough: sessions wrote manuscripts against rules they
 * had never read, and followed them once they were read. An advisory reminder is followed far less
 * often than a refused tool call, so the write itself is gated.
 *
 * The scope is deliberately narrow, because a gate that fires on ordinary work spends its refusals
 * on noise:
 *   - LaTeX sources only. Prose in Markdown is most of what a session writes all day.
 *   - Substantial payloads only. A \label fix is not prose.
 *   - Only where a rules file exists. No file, no opinion, and no configuration to set.
 *
 * It cannot wedge a run. The satisfying action is a Read the provider can always perform, and there
 * is a hard ceiling on refusals regardless of whether that Read ever happens.
 */

/** Workspace-relative name of the rules file. An installation that wants the gate writes it. */
export const WRITING_RULES_FILE = 'WRITING.md';
/**
 * Payload size below which a write is treated as mechanical. The real failure mode of a gate with a
 * refusal ceiling is spending one on a figure path and then letting the prose through, so the
 * threshold errs high: under it the write passes and the gate stays armed.
 */
export const MIN_PROSE_CHARS = 300;
/**
 * Hard ceiling on refusals per run. If three refusals have not produced one Read, something is
 * wrong with the escape and blocking the run is the worse outcome.
 */
export const MAX_WRITING_BLOCKS = 3;

const MANUSCRIPT_EXTS = new Set(['.tex', '.sty', '.cls']);

export function isManuscriptPath(filePath: string): boolean {
  return MANUSCRIPT_EXTS.has(path.extname(filePath).toLowerCase());
}
/**
 * Did this tool call put the rules into context? Reading the rules file counts, and so does reading
 * the SKILL.md of a skill whose directory names writing, because a session that has already read
 * either one has the rules and refusing it would be a refusal over bookkeeping.
 */
export function loadsWritingRules(
  toolName: string,
  toolInput: Record<string, unknown>,
  rulesPaths: string[],
  cwd: string,
): boolean {
  if (toolName === 'Skill')
    return typeof toolInput.skill === 'string' && toolInput.skill.toLowerCase().includes('writing');
  if (toolName !== 'Read') return false;
  const raw = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  if (!raw) return false;
  const resolved = path.resolve(cwd, raw);
  if (rulesPaths.some((rules) => path.resolve(rules) === resolved)) return true;
  return (
    path.basename(resolved).toLowerCase() === 'skill.md' &&
    path.basename(path.dirname(resolved)).toLowerCase().includes('writing')
  );
}

export interface WritingGateInput {
  toolName: string;
  /** Resolved absolute path being written, or null when the call is not a file write. */
  target: string | null;
  /** Write.content or Edit.new_string. */
  payload: string | undefined;
  /** Rules files that exist on disk, nearest first. Empty means the gate has no opinion. */
  rulesPaths: string[];
  /** Rules already loaded during this run. */
  satisfied: boolean;
  /** Refusals already issued during this run. */
  blocksSoFar: number;
  /** False when the caller lets the write through (advisory validation). Default true. */
  enforced?: boolean;
}

/** Refusal text, or null when the write should proceed. */
export function writingGateRefusal(input: WritingGateInput): string | null {
  if (input.satisfied || !input.rulesPaths.length) return null;
  if (input.blocksSoFar >= MAX_WRITING_BLOCKS) return null;
  if (input.toolName !== 'Write' && input.toolName !== 'Edit') return null;
  if (!input.target || !isManuscriptPath(input.target)) return null;
  if (typeof input.payload !== 'string' || input.payload.length < MIN_PROSE_CHARS) return null;
  // Worded as a refusal ("re-issue the write"), the note invites a repeat of a write that went through.
  if (input.enforced === false)
    return (
      `This ${input.toolName} on ${input.target} goes ahead, no need to repeat it. This ` +
      `installation keeps writing rules at ${input.rulesPaths.join(' and ')}, and nothing has ` +
      `read them during this run: read the file before the next manuscript write. Writes under ` +
      `${MIN_PROSE_CHARS} characters are not checked.`
    );
  return (
    `Refusing ${input.toolName} on ${input.target}: this installation keeps writing rules at ` +
    `${input.rulesPaths.join(' and ')}, and nothing has read them during this run. Read the file, ` +
    `then re-issue the write. Writes under ${MIN_PROSE_CHARS} ` +
    `characters are treated as mechanical and are not gated.`
  );
}
