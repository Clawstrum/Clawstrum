import {
  CHECKER_BLOCK_CHARS,
  EVIDENCE,
  checkQuote,
  cited,
  clean,
  clip,
  evidenceReader,
  objectionStatus,
  type CheckerEvidence,
  type QuoteCheck,
} from './checker.js';

export const REVIEWER_VERDICTS = [
  'main',
  'fix',
  'develop',
  'supporting',
  'dead_end',
  'cut',
  'stop',
] as const;
export type ReviewerVerdict = (typeof REVIEWER_VERDICTS)[number] | 'unknown';
export type ReviewerStage = 'direction' | 'final';
export type ReviewerKind = 'result' | 'plan';
const STORY_KEYS = ['now', 'best', 'gap', 'lead'] as const;
export type ReviewerStory = Partial<Record<(typeof STORY_KEYS)[number], string>>;

export interface ReviewerItem {
  n: number;
  verdict: ReviewerVerdict;
  /** The verdict as written, kept for an unknown one. */
  raw: string;
  /** Undefined when the item line names no kind or an unrecognised one. */
  kind?: ReviewerKind;
  item: string;
  why: string;
  fix?: string;
  develop?: string;
  kill?: string;
  evidence: CheckerEvidence[];
}
export interface ReviewerParse {
  /** Undefined when no STAGE line names direction or final. */
  stage?: ReviewerStage;
  slots?: number;
  planSlots?: number;
  story: ReviewerStory;
  items: ReviewerItem[];
  missing: string[];
  overall?: string;
  topCut?: string;
}

const ITEM =
  /^[*_]*ITEM\s*#?\s*(\d+)\s*\[\s*([a-z_ -]+?)\s*(?:[,;/]\s*([a-z]+)\s*)?\][*_]*\s*[:.-]?[*_]*\s*(.*)$/i;
const LABEL =
  /^[*_]*(STAGE|PLAN[\s_-]+SLOTS|SLOTS|STORY[\s_-]+NOW|STORY[\s_-]+BEST|STORY[\s_-]+GAP|LEAD|FIX|DEVELOP|KILL|MISSING|OVERALL|TOP[\s_-]+CUT)[*_]*\s*:[*_]*\s*(.*)$/i;
const unbold = (s: string): string => s.replace(/\*\*/g, '').trim();

/** Split "<item> — <why>" at the first dash separator, preferring the em dash the prompt asks for. */
function splitWhy(text: string): [string, string] {
  for (const sep of [' — ', '—', ' – ', ' -- ', ' - ']) {
    const i = text.indexOf(sep);
    if (i > 0) return [text.slice(0, i).trim(), text.slice(i + sep.length).trim()];
  }
  return [text.trim(), ''];
}

export function parseReviewer(text: string): ReviewerParse {
  const out: ReviewerParse = { story: {}, items: [], missing: [] };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = clean(raw);
    if (!line) continue;
    let m = ITEM.exec(line);
    if (m) {
      const written = m[2]!.toLowerCase().replace(/[\s-]+/g, '_');
      const kind = m[3]?.toLowerCase();
      const [item, why] = splitWhy(unbold(m[4]!));
      out.items.push({
        n: Number(m[1]),
        verdict: (REVIEWER_VERDICTS as readonly string[]).includes(written)
          ? (written as ReviewerVerdict)
          : 'unknown',
        raw: written,
        ...(kind === 'result' || kind === 'plan' ? { kind: kind as ReviewerKind } : {}),
        item,
        why,
        evidence: [],
      });
      continue;
    }
    m = EVIDENCE.exec(line);
    if (m) {
      out.items.at(-1)?.evidence.push({ path: m[1]!.trim(), line: Number(m[2]), quote: m[3]! });
      continue;
    }
    m = LABEL.exec(line);
    if (!m) continue;
    const label = m[1]!.toUpperCase().replace(/[\s_-]+/g, ' ');
    const value = unbold(m[2]!);
    const last = out.items.at(-1);
    if (label === 'STAGE') {
      const stage = /\b(direction|final)\b/i.exec(value)?.[1]?.toLowerCase();
      if (stage && out.stage === undefined) out.stage = stage as ReviewerStage;
    } else if (label === 'SLOTS' || label === 'PLAN SLOTS') {
      const n = /\d+/.exec(value);
      const key = label === 'SLOTS' ? 'slots' : 'planSlots';
      if (n && Number(n[0]) >= 1 && out[key] === undefined) out[key] = Number(n[0]);
    } else if (label.startsWith('STORY ') || label === 'LEAD') {
      const key =
        label === 'LEAD' ? 'lead' : (label.slice(6).toLowerCase() as 'now' | 'best' | 'gap');
      if (value) out.story[key] ??= value;
    } else if (label === 'FIX') {
      if (last && last.fix === undefined) last.fix = value;
    } else if (label === 'DEVELOP') {
      if (last && last.develop === undefined && value) last.develop = value;
    } else if (label === 'KILL') {
      if (last && last.kill === undefined) last.kill = value;
    } else if (label === 'MISSING') {
      if (value) out.missing.push(value);
    } else if (label === 'OVERALL') out.overall ??= value;
    else if (label === 'TOP CUT') out.topCut ??= value;
  }
  return out;
}

const HEADER = "Reviewer verdicts (harness-read evidence, not the reviewer's words):";

export type ReviewerCounts = Record<(typeof REVIEWER_VERDICTS)[number] | 'unknown', number>;
function countVerdicts(items: ReviewerItem[]): ReviewerCounts {
  const counts: ReviewerCounts = {
    main: 0,
    fix: 0,
    develop: 0,
    supporting: 0,
    dead_end: 0,
    cut: 0,
    stop: 0,
    unknown: 0,
  };
  for (const item of items) counts[item.verdict]++;
  return counts;
}

/** Main and fix results against slots (final stage only; a review without a STAGE line is held to
 * its slots too), and main plan items against plan slots. An item with no kind counts as a result. */
function budget(parsed: ReviewerParse): { results: number; plans: number; over: string[] } {
  let results = 0;
  let plans = 0;
  for (const item of parsed.items) {
    if (item.kind === 'plan') {
      if (item.verdict === 'main') plans++;
    } else if (item.verdict === 'main' || item.verdict === 'fix') results++;
  }
  const over: string[] = [];
  if (parsed.stage !== 'direction' && parsed.slots !== undefined && results > parsed.slots)
    over.push(`OVER BUDGET: main+fix results = ${results} > slots ${parsed.slots}`);
  if (parsed.planSlots !== undefined && plans > parsed.planSlots)
    over.push(`OVER PLAN BUDGET: main plan items = ${plans} > plan slots ${parsed.planSlots}`);
  return { results, plans, over };
}

/** The format and stage rules a review must keep, one flag line each. */
function ruleFlags(parsed: ReviewerParse): string[] {
  const flags: string[] = [];
  if (!parsed.stage) flags.push('STAGE MISSING: no STAGE line naming direction or final');
  if (parsed.stage === 'final' && parsed.slots === undefined)
    flags.push('SLOTS MISSING: the final stage needs SLOTS');
  const noStory = STORY_KEYS.filter((k) => !parsed.story[k]);
  if (noStory.length) flags.push(`STORY MISSING: ${noStory.join(', ')}`);
  flags.push(...budget(parsed).over);
  for (const item of parsed.items) {
    const n = item.n;
    if (item.kind === undefined) flags.push(`KIND MISSING: item ${n}`);
    if (item.verdict === 'fix' && item.fix === undefined) flags.push(`FIX MISSING: item ${n}`);
    if (item.verdict === 'develop' && item.develop === undefined)
      flags.push(`DEVELOP MISSING: item ${n} does not say what it needs`);
    if (item.verdict === 'dead_end' && !item.evidence.length)
      flags.push(`DEAD END UNCITED: item ${n} cites no result that killed it`);
    if (item.verdict === 'cut' && parsed.stage === 'direction')
      flags.push(`CUT IN DIRECTION: item ${n}`);
    if (item.verdict === 'stop' && item.kind !== 'plan') flags.push(`STOP NOT PLAN: item ${n}`);
    if (item.verdict === 'unknown') flags.push(`UNKNOWN VERDICT: item ${n}`);
  }
  return flags;
}

/** `checks[i][j]` is the check of `parsed.items[i].evidence[j]`. */
export function reviewerBlock(
  parsed: ReviewerParse,
  checks: QuoteCheck[][],
  read: (file: string) => string = evidenceReader(),
  maxChars = CHECKER_BLOCK_CHARS,
): string {
  const story = [
    ...(parsed.story.now !== undefined ? [`story now: ${clip(parsed.story.now, 300)}`] : []),
    ...(parsed.story.best !== undefined ? [`story best: ${clip(parsed.story.best, 300)}`] : []),
    ...(parsed.story.gap !== undefined ? [`story gap: ${clip(parsed.story.gap, 300)}`] : []),
    ...(parsed.story.lead !== undefined ? [`lead: ${clip(parsed.story.lead, 300)}`] : []),
  ];
  const tail = [
    ...parsed.missing.map((m) => `missing: ${clip(m, 300)}`),
    ...(parsed.overall !== undefined ? [`overall: ${clip(parsed.overall, 300)}`] : []),
    ...(parsed.topCut !== undefined ? [`top cut: ${clip(parsed.topCut, 300)}`] : []),
  ];
  if (!parsed.items.length)
    return [HEADER, ...story, 'no ITEM lines in the expected format', ...tail].join('\n');
  const c = countVerdicts(parsed.items);
  const slots =
    parsed.slots !== undefined
      ? `slots ${parsed.slots}`
      : parsed.stage === 'direction'
        ? 'no slot cap'
        : 'slots ?';
  const planSlots = parsed.planSlots !== undefined ? `, plan slots ${parsed.planSlots}` : '';
  const lines = [
    HEADER,
    `stage ${parsed.stage ?? '?'}: main ${c.main} / fix ${c.fix} / develop ${c.develop} / supporting ${c.supporting} / dead_end ${c.dead_end} / cut ${c.cut} / stop ${c.stop}, ${slots}${planSlots}`,
    ...story,
    ...ruleFlags(parsed),
  ];
  let used = lines.join('\n').length + tail.join('\n').length + 1;
  let omitted = 0;
  parsed.items.forEach((item, i) => {
    const ic = checks[i] ?? [];
    const label =
      (item.verdict === 'unknown' ? `unknown: ${item.raw}` : item.verdict) +
      (item.kind === 'plan' ? ', plan' : '');
    const part = [
      `ITEM ${item.n} [${label}]: ${clip(item.why ? `${item.item} — ${item.why}` : item.item, 300)}`,
    ];
    if (item.fix !== undefined) part.push(`  fix: ${clip(item.fix, 300)}`);
    if (item.develop !== undefined) part.push(`  needs: ${clip(item.develop, 300)}`);
    if (item.kill !== undefined) part.push(`  kill: ${clip(item.kill, 300)}`);
    item.evidence.forEach((e, j) => {
      const q = ic[j] ?? { status: 'nofile' as const };
      const where = q.status === 'moved' ? `moved (found at line ${q.line})` : q.status;
      part.push(`  ${e.path}:${e.line} ${where}`);
      if ((q.status === 'verified' || q.status === 'moved') && q.file)
        part.push(...cited(q.file, q.line ?? e.line, q.lines ?? 1, read));
    });
    const textPart = part.join('\n');
    if (omitted || used + textPart.length + 1 > maxChars) {
      omitted++;
      return;
    }
    lines.push(textPart);
    used += textPart.length + 1;
  });
  if (omitted) lines.push(`(${omitted} item(s) omitted at the ${maxChars}-character cap)`);
  return [...lines, ...tail].join('\n');
}

export interface ReviewerSummary {
  block: string;
  record: {
    stage: ReviewerStage | null;
    slots: number | null;
    planSlots: number | null;
    counts: ReviewerCounts;
    overBudget: boolean;
    items: number;
    verified: number;
    unverified: number;
    unbacked: number;
    missing: number;
  };
}

/** Parse, check and summarise a reviewer result. `verified`/`unverified`/`unbacked` count items. */
export function summarizeReviewer(
  text: string,
  bases: string[],
  read: (file: string) => string = evidenceReader(),
): ReviewerSummary {
  const parsed = parseReviewer(text);
  const checks = parsed.items.map((o) => o.evidence.map((e) => checkQuote(e, bases, read)));
  const statuses = parsed.items.map((o, i) => objectionStatus(o, checks[i]!));
  const counts = countVerdicts(parsed.items);
  return {
    block: reviewerBlock(parsed, checks, read),
    record: {
      stage: parsed.stage ?? null,
      slots: parsed.slots ?? null,
      planSlots: parsed.planSlots ?? null,
      counts,
      overBudget: budget(parsed).over.length > 0,
      items: parsed.items.length,
      verified: statuses.filter((s) => s === 'verified').length,
      unverified: statuses.filter((s) => s === 'unverified').length,
      unbacked: statuses.filter((s) => s === 'unbacked').length,
      missing: parsed.missing.length,
    },
  };
}
