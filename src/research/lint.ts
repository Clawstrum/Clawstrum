import fs from 'node:fs';
import path from 'node:path';
import { lintProse, type ProseFinding } from '../prose.js';
import { lintFigures, type FigureFinding } from '../figures.js';
import { previewEdit } from './edits.js';
import { isManuscriptPath } from './writing.js';

/**
 * Run the prose and figure linters on the payload of a write, so that what they measure reaches the
 * agent at the moment it is actionable.
 *
 * Both linters existed only behind `clawstrum prose lint FILE` and `clawstrum figures lint FILE`,
 * which fire when somebody types them. In the predecessor deployment, over a 30-day census of one
 * hook that emits a denial on one branch and advisory context on the next statement, the denial
 * branch was obeyed 55 times and the advisory branch 0. A checker reachable only by an instruction
 * to invoke it is on the wrong side of that split. Content returned by the gate is not: it arrives
 * whether or not the agent chose to ask.
 *
 * The findings stay advisory in every validation mode. `src/research/writing.ts` already denies a
 * manuscript write until the rules are loaded, and that refusal is what the strict budget is for;
 * three line-level style observations are not grounds to spend it, and a linter that can block is a
 * linter whose false positives stop work.
 */

/** Payload size above which the preview is skipped rather than read into memory. Same value as the citation scan. */
export const lintDocumentLimit = 2_000_000;

export const figureSourcePath = (file: string) => path.extname(file).toLowerCase() === '.py';

interface Finding {
  line: number;
  code: string;
  message: string;
}

function readSource(file: string): string {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Write lint requires a regular file');
  if (stat.size > lintDocumentLimit) throw new Error('Write lint skipped: file over size limit');
  return fs.readFileSync(file, 'utf8');
}

/**
 * The text this write would leave on disk, plus the text it replaces when there is one. Mirrors
 * `scanCitationWrite`: Write states its own full result, Edit has to be previewed against the file.
 */
function writtenText(
  tool: string,
  input: Record<string, any>,
): { text: string; original?: string } | undefined {
  if (tool === 'Write')
    return typeof input.content === 'string' && input.content.length <= lintDocumentLimit
      ? { text: input.content }
      : undefined;
  if (
    tool !== 'Edit' ||
    typeof input.old_string !== 'string' ||
    typeof input.new_string !== 'string'
  )
    return;
  let original: string;
  try {
    original = readSource(String(input.file_path ?? ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const edited = previewEdit(original, input);
  return edited === undefined || edited.length > lintDocumentLimit
    ? undefined
    : { text: edited, original };
}

/**
 * Findings this write introduces. Line numbers move when text above them changes, so an occurrence
 * is matched by code and message: an edit that adds one em dash to a file holding four reports one.
 * Without this, any edit to an old manuscript reports its whole backlog, which is the fastest way to
 * make a gate ignorable.
 */
function introduced<T extends Finding>(after: T[], before: T[]): T[] {
  const prior = new Map<string, number>();
  for (const finding of before) {
    const key = `${finding.code}:${finding.message}`;
    prior.set(key, (prior.get(key) ?? 0) + 1);
  }
  return after.filter((finding) => {
    const key = `${finding.code}:${finding.message}`;
    const remaining = prior.get(key) ?? 0;
    if (remaining) prior.set(key, remaining - 1);
    return remaining === 0;
  });
}

function scan<T extends Finding>(
  tool: string,
  input: Record<string, any>,
  lint: (text: string) => T[],
): T[] {
  const written = writtenText(tool, input);
  if (!written) return [];
  const findings = lint(written.text);
  return written.original === undefined ? findings : introduced(findings, lint(written.original));
}

/**
 * Prose findings for a manuscript write, or none.
 *
 * Scope is `writing.ts`'s: LaTeX sources, and only where the installation keeps a rules file. The
 * three checks are the three that refusal text names, so an installation that has not written the
 * rules has not asked for the opinion, and Markdown is most of what a session writes all day.
 */
export function scanProseWrite(
  tool: string,
  input: Record<string, any>,
  rulesPaths: string[],
): ProseFinding[] {
  if (!rulesPaths.length || !isManuscriptPath(String(input.file_path ?? ''))) return [];
  return scan(tool, input, lintProse);
}

/**
 * Figure findings for a Python write, or none.
 *
 * No rules file is required. These are plotting-syntax heuristics, not Python execution: font
 * settings can also appear in configuration-only files, and findings remain advisory.
 */
export function scanFigureWrite(tool: string, input: Record<string, any>): FigureFinding[] {
  if (!figureSourcePath(String(input.file_path ?? ''))) return [];
  return scan(tool, input, lintFigures);
}
