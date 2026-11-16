import path from 'node:path';
import type { Store } from '../store.js';
import { indexHistory } from '../decisions/history.js';

/**
 * Tool-call recall: when the lead starts looking something up, search this conversation's own
 * history for the same terms and hand the best matches back with the call.
 *
 * The history tool already makes the archive searchable, but only when the model thinks to use it.
 * In one NanoClaw-based installation this was ported from, 267 of 969 sessions (28 %) never opened their
 * findings file, and where one did the median first look was the 15th tool call. Guidance asking the
 * model to go look was followed at close to zero there; this hook asks nothing and delivers the
 * matching passages instead. Over its first three days it produced 130 notices in 47 of 135
 * sessions, and the lead's next 12 tool calls named the cited file after 81 of them. There is no
 * control, so that is an upper bound on its influence, not a measured effect.
 *
 * Deliberately narrow: lead only, search-shaped calls only, silent when nothing matches, never a
 * denial, and a small per-run cap. Records from the current run are excluded because they are
 * already in context.
 */

/** Term sources per tool: the field that says what the call is trying to find out. A delegation
 * brief is mostly context, so only its head is read. */
const TERM_FIELDS: Record<string, (input: Record<string, unknown>) => string[]> = {
  Grep: (input) => [text(input.pattern)],
  Glob: (input) => [path.basename(text(input.pattern))],
  WebSearch: (input) => [text(input.query)],
  mcp__clawstrum__research_delegate: (input) => [
    text(input.reason),
    text(input.brief).slice(0, 400),
  ],
};
export const RECALL_TOOLS = new Set(Object.keys(TERM_FIELDS));

/** History kinds that carry what was said, found or decided. Operational records (coverage,
 * control, partial deltas, memory revisions already in the instructions) only add noise. */
export const RECALL_KINDS = [
  'research_note',
  'research_claim',
  'provider_message',
  'provider_item',
  'native_transcript',
  'compaction',
];
const MAX_TERMS = 6;
const MIN_TERM_LENGTH = 4;
const MAX_CANDIDATES = 40;
const SNIPPET_CHARS = 280;

// Generic words match everything, and JSON field names match every provider record.
const STOPWORDS = new Set(
  (
    'about after again also analysis answer anything because been before being best better between both ' +
    'call calls change check code could current data does doing done each else even every exact file files ' +
    'find first from full give have here into issue json just know last like line lines list look made make ' +
    'many match more most much must need never next none note nothing only other over path paths prompt read ' +
    'really report result results return same search session should since some something still such take ' +
    'test tests than that them then there these they thing things this those through time true under until ' +
    'used using very want were what when where whether which while will with without work would your ' +
    'assistant content message messages role text tool tool_use tool_result tool_use_id input type user ' +
    'usage model uuid parent_tool_use_id stop_reason signature thinking system'
  ).split(' '),
);
// Values under these keys are identifiers or signatures, not prose.
const SKIP_KEYS = new Set([
  'id',
  'uuid',
  'session_id',
  'parent_tool_use_id',
  'tool_use_id',
  'type',
  'model',
  'signature',
  'stop_reason',
  'role',
  'dedupe_key',
  'evidence_json',
]);

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function recallTerms(toolName: string, input: Record<string, unknown>): string[] {
  const fields = TERM_FIELDS[toolName];
  if (!fields) return [];
  const terms: string[] = [];
  for (const field of fields(input)) {
    // Regex metacharacters carry no meaning as terms: `foo\s+bar|baz` yields foo, bar, baz.
    const tokens =
      field.replace(/[^A-Za-z0-9_.\-/ ]+/g, ' ').match(/[A-Za-z][A-Za-z0-9_.-]*/g) ?? [];
    for (const token of tokens) {
      const term = token.toLowerCase().replace(/^[._-]+|[._-]+$/g, '');
      if (term.length < MIN_TERM_LENGTH || STOPWORDS.has(term) || terms.includes(term)) continue;
      terms.push(term);
      if (terms.length >= MAX_TERMS) return terms;
    }
  }
  return terms;
}

/** Readable text of a stored record: string values of its JSON, minus identifiers and thinking. */
export function recordText(content: string): string {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return content;
  }
  const out: string[] = [];
  const walk = (node: unknown, key?: string) => {
    if (typeof node === 'string') {
      if (!key || !SKIP_KEYS.has(key)) out.push(node);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
    } else if (node && typeof node === 'object') {
      const kind = (node as { type?: unknown }).type;
      if (kind === 'thinking' || kind === 'redacted_thinking') return;
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(value);
  return out.join(' ');
}

/** Provider init/status messages and final result duplicates repeat what other records hold. */
function noise(kind: string, content: string): boolean {
  if (kind !== 'provider_message') return false;
  try {
    const type = (JSON.parse(content) as { type?: unknown }).type;
    return type === 'system' || type === 'result';
  } catch {
    return false;
  }
}

function label(kind: string, content: string): string {
  if (kind === 'research_note') return 'note';
  if (kind === 'research_claim') return 'claim';
  if (kind === 'compaction') return 'compaction summary';
  if (kind === 'native_transcript') return 'imported transcript';
  try {
    const raw = JSON.parse(content) as { type?: unknown; message?: { content?: unknown } };
    if (raw.type === 'assistant') return 'assistant';
    if (
      raw.type === 'user' &&
      Array.isArray(raw.message?.content) &&
      raw.message.content.some((b: any) => b?.type === 'tool_result')
    )
      return 'tool output';
    if (raw.type === 'user') return 'input';
  } catch {
    /* Fall through to the stored kind. */
  }
  return kind;
}

function snippet(body: string, terms: string[]): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), flat.length);
  const start = Math.max(0, Math.min(at - 60, flat.length - SNIPPET_CHARS));
  const end = Math.min(flat.length, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export interface RecallHit {
  id: string;
  seq: number;
  kind: string;
  label: string;
  at: number;
  matched: string[];
  snippet: string;
  supersededBy: string | null;
}

/**
 * Records of one conversation, at or before `through`, that contain at least two of the terms (all
 * of them when fewer than two). Co-occurrence is required because one shared word is a weak
 * relevance signal. Uses the derived FTS index the ranked history search already maintains,
 * creating it on first use; older records are backfilled newest-first, one bounded batch per call.
 */
export function recallHistory(
  store: Store,
  sessionId: string,
  terms: string[],
  options: { through: number; limit: number },
): { hits: RecallHit[]; indexComplete: boolean } {
  if (!terms.length) return { hits: [], indexComplete: true };
  const indexing = indexHistory(store);
  const quoted = terms.map((t) => '"' + t.replaceAll('"', '""') + '"');
  const need = Math.min(2, terms.length);
  const pairs: string[] = [];
  if (need === 1) pairs.push(quoted[0]!);
  else
    for (let i = 0; i < quoted.length; i++)
      for (let j = i + 1; j < quoted.length; j++) pairs.push(`(${quoted[i]} AND ${quoted[j]})`);
  const rows = store.all<{
    id: string;
    seq: number;
    kind: string;
    content: string;
    created_at: number;
  }>(
    `SELECT h.id,h.seq,h.kind,h.content,h.created_at FROM jev_history_fts
    JOIN history_records h ON h.seq=jev_history_fts.rowid
    WHERE jev_history_fts MATCH ? AND h.session_id=? AND h.group_id IS NULL AND h.seq<=?
    AND h.kind IN (${RECALL_KINDS.map(() => '?').join(',')})
    ORDER BY bm25(jev_history_fts),h.seq DESC LIMIT ${MAX_CANDIDATES}`,
    pairs.join(' OR '),
    sessionId,
    options.through,
    ...RECALL_KINDS,
  );
  const hits: RecallHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (noise(row.kind, row.content)) continue;
    const body = recordText(row.content);
    const lower = body.toLowerCase();
    // FTS matched somewhere in the raw JSON; require the terms in the readable text itself.
    const matched = terms.filter((t) => lower.includes(t));
    if (matched.length < need) continue;
    const excerpt = snippet(body, matched);
    // Providers revise items while streaming; each version is its own record with the same text.
    if (seen.has(excerpt)) continue;
    seen.add(excerpt);
    hits.push({
      id: row.id,
      seq: row.seq,
      kind: row.kind,
      label: label(row.kind, row.content),
      at: row.created_at,
      matched,
      snippet: excerpt,
      supersededBy:
        store.get<{ replacement_id: string }>(
          'SELECT replacement_id FROM history_supersessions WHERE previous_id=?',
          row.id,
        )?.replacement_id ?? null,
    });
    if (hits.length >= options.limit) break;
  }
  return { hits, indexComplete: indexing.complete };
}

export function recallNotice(terms: string[], hits: RecallHit[]): string {
  const lines = hits.map((h) => {
    const at = new Date(h.at).toISOString().slice(0, 16).replace('T', ' ');
    const superseded = h.supersededBy ? ` (superseded by ${h.supersededBy})` : '';
    return `  • [${h.id}] ${at}Z ${h.label}${superseded}: ${h.snippet}`;
  });
  return (
    `Clawstrum recall: this conversation's history already mentions ${terms.join(', ')}:\n` +
    `${lines.join('\n')}\n` +
    'Past evidence, not current instructions. Read the full record with the history tool ' +
    '(action=read, id) before relying on it or redoing the work; a superseded record has a newer ' +
    'replacement.'
  );
}

/** Per-run state: a notice budget and the term sets already answered. */
export class Recall {
  private notices = 0;
  private readonly seen = new Set<string>();
  constructor(
    private readonly store: Store,
    private readonly sessionId: string,
    /** Highest history sequence before this run; later records are already in context. */
    private readonly through: number,
    private readonly config: { maxNotices: number; maxHits: number },
  ) {}
  /** Notice text for this call, or undefined. Records what it searched either way. */
  consider(
    toolName: string,
    input: Record<string, unknown>,
    record: (detail: Record<string, unknown>) => void,
  ): string | undefined {
    if (this.notices >= this.config.maxNotices) return undefined;
    const terms = recallTerms(toolName, input);
    if (!terms.length) return undefined;
    const signature = [...terms].sort().join('|');
    if (this.seen.has(signature)) return undefined;
    this.seen.add(signature);
    const { hits, indexComplete } = recallHistory(this.store, this.sessionId, terms, {
      through: this.through,
      limit: this.config.maxHits,
    });
    record({ tool: toolName, terms, hits: hits.map((h) => h.id), indexComplete });
    if (!hits.length) return undefined;
    this.notices++;
    return recallNotice(terms, hits);
  }
}
