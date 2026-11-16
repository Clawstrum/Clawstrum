import fs from 'node:fs';
import path from 'node:path';

/** Bound synchronous verification work; unreadable/oversized evidence remains unverified. */
export const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
export function evidenceReader(excludedDir?: string): (file: string) => string {
  const cache = new Map<string, string>();
  const excluded = excludedDir ? fs.realpathSync(excludedDir) : undefined;
  let remaining = MAX_EVIDENCE_BYTES;
  return (file) => {
    const real = fs.realpathSync(file);
    if (excluded) {
      const rel = path.relative(excluded, real);
      if (rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)))
        throw new Error('subagent cited its own subagent directory');
    }
    if (cache.has(real)) return cache.get(real)!;
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > remaining)
      throw new Error('Evidence read budget or file type');
    // A file can grow between stat and read. Never allocate beyond the remaining byte budget.
    const fd = fs.openSync(real, 'r');
    try {
      const bytes = Buffer.alloc(remaining + 1);
      let used = 0;
      while (used < bytes.length) {
        const n = fs.readSync(fd, bytes, used, bytes.length - used, null);
        if (!n) break;
        used += n;
      }
      if (used > remaining) throw new Error('Evidence exceeds read budget');
      remaining -= used;
      const text = bytes.subarray(0, used).toString('utf8');
      cache.set(real, text);
      return text;
    } finally {
      fs.closeSync(fd);
    }
  };
}

export const CHECKER_KINDS = [
  'wrong',
  'stale',
  'unsupported',
  'overclaim',
  'missed_prior',
] as const;

export interface CheckerEvidence {
  path: string;
  line: number;
  quote: string;
}
export interface CheckerObjection {
  n: number;
  kind: string;
  claim: string;
  evidence: CheckerEvidence[];
}
export interface CheckerParse {
  objections: CheckerObjection[];
  noObjection?: string;
}
export type QuoteStatus = 'verified' | 'moved' | 'unverified' | 'nofile';
export interface QuoteCheck {
  status: QuoteStatus;
  file?: string;
  /** The line the quote was found at; for `moved` this differs from the cited line. */
  line?: number;
  /** Lines in the matching span starting at `line`, 1 to 3. */
  lines?: number;
}

/** Strip the list and quote markers a model puts in front of a line. Bold and backticks are
 * tolerated by the patterns instead of removed, since a verbatim quote may contain them. */
export function clean(line: string): string {
  return line.replace(/^\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?/, '').trim();
}

const OBJECTION =
  /^[*_]*OBJECTION\s*#?\s*(\d+)\s*\[\s*([a-z_ -]+?)\s*\][*_]*\s*[:.-]?[*_]*\s*(.*)$/i;
export const EVIDENCE =
  /^[*_]*EVIDENCE[*_]*\s*:[*_]*\s*`?([^`"“\s][^`"“]*?)`?\s*:\s*`?(\d+)`?\s*[-:–—]?\s*["“](.*)["”][*_]*\s*$/i;
const NONE = /^[*_]*NO\s+OBJECTIONS?[*_]*\s*[:.-]?[*_]*\s*(.*)$/i;

export function parseChecker(text: string): CheckerParse {
  const objections: CheckerObjection[] = [];
  let noObjection: string | undefined;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = clean(raw);
    if (!line) continue;
    let m = OBJECTION.exec(line);
    if (m) {
      objections.push({
        n: Number(m[1]),
        kind: m[2]!.toLowerCase().replace(/[\s-]+/g, '_'),
        claim: m[3]!.replace(/\*\*/g, '').trim(),
        evidence: [],
      });
      continue;
    }
    m = EVIDENCE.exec(line);
    if (m) {
      objections.at(-1)?.evidence.push({ path: m[1]!.trim(), line: Number(m[2]), quote: m[3]! });
      continue;
    }
    m = NONE.exec(line);
    if (m && noObjection === undefined) noObjection = m[1]!.trim() || 'no reason given';
  }
  return noObjection !== undefined && !objections.length
    ? { objections, noObjection }
    : { objections };
}

export function resolveEvidencePath(p: string, bases: string[]): string | null {
  if (!p) return null;
  if (path.isAbsolute(p)) return fs.existsSync(p) ? p : null;
  for (const base of bases) {
    const resolved = path.resolve(base, p);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Normalised join of lines[start..start+len-1], 1-based; null if it runs off the file. */
function span(lines: string[], start: number, len: number): string | null {
  if (start < 1 || start + len - 1 > lines.length) return null;
  return norm(lines.slice(start - 1, start - 1 + len).join(' '));
}

/** Length of the shortest span from `start` holding the quote, if `start` is its first line (the
 * span from the next line must not also hold it); 0 otherwise. */
function matchFrom(lines: string[], start: number, q: string): number {
  for (let len = 1; len <= 3; len++) {
    const s = span(lines, start, len);
    if (s === null || !s.includes(q)) continue;
    const rest = len > 1 ? span(lines, start + 1, len - 1) : null;
    return rest !== null && rest.includes(q) ? 0 : len;
  }
  return 0;
}

export const MIN_MOVED_QUOTE = 20;

export function checkQuote(
  evidence: CheckerEvidence,
  bases: string[],
  read: (file: string) => string = evidenceReader(),
): QuoteCheck {
  const file = resolveEvidencePath(evidence.path, bases);
  if (!file) return { status: 'nofile' };
  let text: string;
  try {
    text = read(file);
  } catch {
    return { status: 'nofile' };
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const q = norm(evidence.quote);
  const line = Number.isInteger(evidence.line) && evidence.line > 0 ? evidence.line : 1;
  if (!q) return { status: 'unverified', file };
  for (let start = line - 3; start <= line + 3; start++) {
    const len = matchFrom(lines, start, q);
    if (len) return { status: 'verified', file, line: start, lines: len };
  }
  // Anywhere else in the file only counts for a quote long enough to be specific.
  if (q.length < MIN_MOVED_QUOTE) return { status: 'unverified', file };
  for (let start = 1; start <= lines.length; start++) {
    const len = matchFrom(lines, start, q);
    if (len) return { status: 'moved', file, line: start, lines: len };
  }
  return { status: 'unverified', file };
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function cited(
  file: string,
  start: number,
  count: number,
  read: (file: string) => string,
): string[] {
  let lines: string[];
  try {
    lines = read(file).replace(/\r\n?/g, '\n').split('\n');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (let n = start; n < start + count; n++)
    if (n >= 1 && n <= lines.length) out.push(`    ${n}│ ${clip(lines[n - 1]!, 200)}`);
  return out;
}

export type ObjectionStatus = 'verified' | 'unverified' | 'unbacked';
export function objectionStatus(
  o: Pick<CheckerObjection, 'evidence'>,
  checks: QuoteCheck[],
): ObjectionStatus {
  if (!o.evidence.length) return 'unbacked';
  return checks.some((c) => c.status === 'verified' || c.status === 'moved')
    ? 'verified'
    : 'unverified';
}

export const CHECKER_BLOCK_CHARS = 4000;
const HEADER = "Checker evidence check (harness-read, not the checker's words):";

/** `checks[i][j]` is the check of `parsed.objections[i].evidence[j]`. */
export function checkerEvidenceBlock(
  parsed: CheckerParse,
  checks: QuoteCheck[][],
  read: (file: string) => string = evidenceReader(),
  maxChars = CHECKER_BLOCK_CHARS,
): string {
  if (!parsed.objections.length) {
    if (parsed.noObjection !== undefined)
      return `${HEADER}\nNO OBJECTION (checker's reason): ${clip(parsed.noObjection, 300)}`;
    return `${HEADER} no checkable evidence was found (no OBJECTION or NO OBJECTION lines in the expected format).`;
  }
  const lines = [HEADER];
  let used = HEADER.length;
  let omitted = 0;
  parsed.objections.forEach((o, i) => {
    const oc = checks[i] ?? [];
    const status = objectionStatus(o, oc);
    const part = [`OBJECTION ${o.n} [${o.kind}] ${status}: ${clip(o.claim, 300)}`];
    o.evidence.forEach((e, j) => {
      const c = oc[j] ?? { status: 'nofile' as const };
      const where = c.status === 'moved' ? `found at line ${c.line}, not ${e.line}` : c.status;
      part.push(`  ${e.path}:${e.line} ${where}`);
      if ((c.status === 'verified' || c.status === 'moved') && c.file)
        part.push(...cited(c.file, c.line ?? e.line, c.lines ?? 1, read));
    });
    const textPart = part.join('\n');
    if (used + textPart.length + 1 > maxChars) {
      omitted++;
      return;
    }
    lines.push(textPart);
    used += textPart.length + 1;
  });
  if (omitted) lines.push(`(${omitted} objection(s) omitted at the ${maxChars}-character cap)`);
  return lines.join('\n');
}

export interface CheckerSummary {
  block: string;
  record: {
    objections: number;
    verified: number;
    moved: number;
    unverified: number;
    unbacked: number;
    noObjection: boolean;
  };
}

/** Parse, check and summarise a checker result. `verified`/`unverified`/`unbacked` count objections;
 * `moved` counts evidence quotes found away from their cited line. */
export function summarizeChecker(
  text: string,
  bases: string[],
  read: (file: string) => string = evidenceReader(),
): CheckerSummary {
  const parsed = parseChecker(text);
  const checks = parsed.objections.map((o) => o.evidence.map((e) => checkQuote(e, bases, read)));
  const statuses = parsed.objections.map((o, i) => objectionStatus(o, checks[i]!));
  return {
    block: checkerEvidenceBlock(parsed, checks, read),
    record: {
      objections: parsed.objections.length,
      verified: statuses.filter((s) => s === 'verified').length,
      moved: checks.flat().filter((c) => c.status === 'moved').length,
      unverified: statuses.filter((s) => s === 'unverified').length,
      unbacked: statuses.filter((s) => s === 'unbacked').length,
      noObjection: parsed.noObjection !== undefined,
    },
  };
}
