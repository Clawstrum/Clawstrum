import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { writePrivate } from '../files.js';
import type { DecisionInput, DecisionResult, Question } from '../decisions/client.js';
import type { ResearchConfig } from './config.js';

/*
 * Literature search the lead runs itself.
 *
 * search   OpenAlex keyword search (one call per kw, 100 hits), OpenAlex semantic search (q and each para,
 *          once unfiltered and once for the last two years, 50 hits each, 1 request/s; the year-filtered
 *          call 504s on ~1/3 of queries and a keyword search stands in) and arXiv (first 3 kw, last 18
 *          months). Missing abstracts are filled from Crossref where it has one.
 * grade    jev   P(yes) "does this address the question, for this researcher", ctx as b_project_context.
 *                nDCG@20 .875 with 3-4 context lines, .81 without. Only the best gradeFrac (default half) by
                pre-rank is graded; the rest rank after the graded papers.
 *          bm25  fallback: word overlap with question + context + keywords, fused with search rank.
 *          A breaker (12 failed calls before any success, 8 papers in a row, or >25 % of 20+) moves the
 *          whole run to bm25. Scores from different graders are never mixed in one ranking.
 * expand   references + 25 most-cited + 25 newest citers of the best-graded papers (P >= .5, at most 5
 *          per hop, plus every seed in hop 1). Hop 2 only if hop 1 put >= 2 new papers into the top k.
 *          bm25 does one hop from its top 3 (raw search rank alone gave junk seeds).
 */

export const searchInputSchema = z
  .object({
    q: z.string().trim().min(1).max(2000),
    ctx: z.string().max(3000).optional(),
    kw: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
    para: z.array(z.string().trim().min(1).max(2000)).max(6).default([]),
    seeds: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    exclude: z.array(z.string().trim().min(1).max(500)).max(500).default([]),
    from: z.number().int().min(1800).max(2100).optional(),
    to: z.number().int().min(1800).max(2100).optional(),
    k: z.number().int().min(1).max(200).default(30),
    hops: z.number().int().min(0).max(2).default(2),
    grader: z.enum(['auto', 'jev', 'bm25']).default('auto'),
    gradeFrac: z.number().gt(0).max(1).default(0.5),
  })
  .strict();
export type SearchInput = z.input<typeof searchInputSchema>;

export interface SearchDecisions {
  decide(input: DecisionInput): Promise<DecisionResult>;
}
export interface SearchDeps {
  config: Pick<ResearchConfig, 'email' | 'openalexKeyEnv' | 'springerKeyEnv'>;
  artifactDir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Absent or null: bm25 from the start. */
  decisions?: SearchDecisions | null;
  decisionScope?: { scope: string; sessionId?: string | null; runId?: string; workerId?: string };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Wall-clock budget for the whole run, seconds. */
  budgetS?: number;
  /** Jev calls in flight; the decisions client refuses more than decisions.maxConcurrent. */
  jevConcurrency?: number;
  jevUsdPerMillion?: number;
  /** Further strings never to appear in output, warnings or errors. */
  secrets?: string[];
}

export interface SearchRow {
  rank: number;
  score: number | null;
  title: string;
  year: number | null;
  author: string | null;
  id: string;
}
export interface SearchResult {
  grader: 'jev' | 'bm25';
  fallback: string | null;
  warnings: string[];
  counts: {
    candidates: number;
    search: number;
    graded: number;
    skipped_by_word_match: number;
    no_abstract: number;
    crossref_abstracts: number;
    by_source: Record<string, number>;
    hops: Array<{ hop: number; seeds: number; new: number; entered_top: number }>;
  };
  cost: {
    openalex_usd: number;
    openalex_calls: number;
    openalex_remaining_today_usd: number | null;
    jev_ok: number;
    jev_failed: number;
    jev_calls: number;
    jev_usd: number;
  };
  seconds: number;
  artifact: string;
  top: SearchRow[];
}

const JEV_CONC = 24;
const JEV_TIMEOUT_MS = 20000;
const OA_CAP_USD = 0.1;
const RECENT_MONTHS = 18;
const OA_SELECT = [
  'id',
  'doi',
  'title',
  'publication_year',
  'cited_by_count',
  'primary_location',
  'locations',
  'authorships',
  'abstract_inverted_index',
  'referenced_works',
  'type',
].join(',');
const SKIP_TYPES = new Set([
  'paratext',
  'erratum',
  'retraction',
  'peer-review',
  'grant',
  'supplementary-materials',
]);
const STOP = new Set(
  (
    'a an and are as at be by for from has have how in into is it its of on or that the their this to was ' +
    'were what when where which while who why with we our can do does using use based via between within under over ' +
    'about than then these those such not no they them also more most other some any each both only paper study ' +
    'research question project searching want need find papers work works'
  ).split(' '),
);
/*
 * The decisions client sends state with its keys sorted (canonical()), and Jev reads them in that order. The
 * prefixes make the sorted order question, context, title, abstract. With the plain names Jev read the abstract
 * first, and on 10 test questions the right papers in the top 30 fell from 35 to 25; with these names, 33.
 */
const JEV_CTX_NONE =
  '`a_research_question` is what a researcher is searching the literature for. `c_paper_title` and `d_paper_abstract` describe one candidate paper. ';
const JEV_CTX =
  '`a_research_question` is what a researcher is searching the literature for. `b_project_context` describes their project and why they are searching; use it to judge what they need. `c_paper_title` and `d_paper_abstract` describe one candidate paper. ';
const FATAL_JEV: Record<string, string> = {
  disabled: 'decisions disabled in configuration',
  missing_key: 'no Jev API key configured',
  budget: 'Jev daily budget exhausted',
  http_401: 'Jev HTTP 401: key rejected',
  http_402: 'Jev HTTP 402: out of credit',
  http_403: 'Jev HTTP 403: key rejected',
};

export type ParsedId =
  | { kind: 'openalex'; id: string }
  | { kind: 'arxiv'; id: string }
  | { kind: 'doi'; doi: string };
export function parseId(raw: string): ParsedId | null {
  const s = raw.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i)))
    return { kind: 'openalex', id: m[1]!.toUpperCase() };
  const a = s.replace(/^arxiv:/i, '');
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(a)) return { kind: 'arxiv', id: a.replace(/v\d+$/, '') };
  if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(a))
    return { kind: 'arxiv', id: a.replace(/v\d+$/, '') };
  const d = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
  // arXiv DOIs are not indexed under the DOI in OpenAlex, so route by title.
  if ((m = d.match(/^10\.48550\/arxiv\.(.+)$/i)))
    return { kind: 'arxiv', id: m[1]!.replace(/v\d+$/, '') };
  if (/^10\.\d{4,9}\/\S+$/.test(d)) return { kind: 'doi', doi: d.toLowerCase() };
  return null;
}

export const normTitle = (t: unknown) =>
  String(t || '')
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
const cleanTitle = (t: unknown) =>
  String(t || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
export const cleanDoi = (d: unknown) =>
  d
    ? String(d)
        .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
        .replace(/[).,;:]+$/, '')
        .toLowerCase()
    : null;
const shortId = (id: unknown) =>
  id ? String(id).replace(/^https?:\/\/openalex\.org\//i, '') : null;
function decodeXml(s: string) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}
export function abstractOf(inv: Record<string, number[]> | null | undefined): string | null {
  if (!inv) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) words[p] = word;
  const text = words
    .filter((w) => w !== undefined)
    .join(' ')
    .trim();
  return text || null;
}
function arxivOf(w: any): string | null {
  const doi = String(w.doi || '').toLowerCase();
  let m = doi.match(/10\.48550\/arxiv\.(.+)$/);
  if (m) return m[1]!.replace(/v\d+$/, '');
  for (const loc of [w.primary_location, ...(w.locations || [])]) {
    for (const u of [loc?.landing_page_url, loc?.pdf_url]) {
      if (!u) continue;
      m = String(u).match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+)/i);
      if (m) return m[1]!.replace(/\.pdf$/i, '').replace(/v\d+$/, '');
    }
  }
  return null;
}
function authorsOf(names: unknown[]): string[] {
  const a = names.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 3);
  if (names.length > 3) a.push('et al.');
  return a;
}
interface Paper {
  oa: string | null;
  doi: string | null;
  arxiv: string | null;
  title: string;
  year: number | null;
  venue: string | null;
  cited_by: number;
  authors: string[];
  abstract: string | null;
  refs: string[];
  type: string | null;
}
export function fromOA(w: any): Paper {
  return {
    oa: shortId(w.id),
    doi: cleanDoi(w.doi),
    arxiv: arxivOf(w),
    title: cleanTitle(w.title),
    year: w.publication_year ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    cited_by: w.cited_by_count ?? 0,
    authors: authorsOf((w.authorships || []).map((x: any) => x?.author?.display_name)),
    abstract: abstractOf(w.abstract_inverted_index),
    refs: (w.referenced_works || []).map(shortId).filter(Boolean),
    type: w.type || null,
  };
}
export function stemTokens(text: unknown): string[] {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.length > 5 ? w.replace(/(ings|ing|edly|ed|es|s)$/, '') : w));
}
/** Same questions and wording as the evaluation of litfind (09-28 e); ranking uses `addresses`. */
/*
 * Final order under Jev: +0.05 per extra route a paper was found by (each search query, each ref/citer link), capped
 * +0.2. On 7 review articles (reference list as answer key) the right papers in the top 30 went 67 → 93; on the 10
 * test questions it tied (35 vs 35). bm25 already fuses the search routes, so it gets no bonus.
 */
export function withRoutes(p: number, routes: number) {
  return p + Math.min(0.2, 0.05 * Math.max(0, routes - 1));
}

export function jevRequest(
  it: { title: string; abstract: string | null },
  question: string,
  context: string,
): { state: Record<string, string>; questions: Record<string, Question> } {
  const ctx = context ? JEV_CTX : JEV_CTX_NONE;
  const ask = context
    ? 'Does this paper directly address the research question, so that this researcher, given their project, would want to read it?'
    : 'Does this paper directly address the research question, so that a researcher working on exactly that question would want to read it?';
  const state: Record<string, string> = {
    a_research_question: question,
    c_paper_title: it.title,
    d_paper_abstract: (it.abstract || '(no abstract)').slice(0, 1500),
  };
  if (context) state.b_project_context = context;
  return {
    state,
    questions: {
      addresses: { type: 'noul', instructions: ctx + ask },
    },
  };
}

interface Src {
  s: string;
  stage: number;
  rank?: number;
  of?: number;
  sort?: string;
}
interface Cand extends Paper {
  n: number;
  src: Src[];
  stage: number;
  jev?: { p: number } | null;
  bm25?: number;
  pre: number;
  expanded?: number;
  crossrefTried?: boolean;
  abstractFrom?: string;
}
type Params = Record<string, string | number | undefined>;

async function runPool(jobs: Array<() => Promise<void>>, n: number) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (next < jobs.length) await jobs[next++]!();
    }),
  );
}
function slugOf(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'search'
  );
}
const idOf = (it: Cand) => it.doi || (it.arxiv ? `arXiv:${it.arxiv}` : it.oa || '');

class SearchRun {
  readonly fetcher: typeof fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly env: NodeJS.ProcessEnv;
  readonly oaKey: string;
  readonly email?: string;
  readonly secrets: string[];
  readonly t0: number;
  readonly year: number;
  readonly warnings: string[] = [];
  readonly C: Cand[] = [];
  readonly index = new Map<string, Cand>();
  readonly drop = new Set<string>();
  readonly srcCounts: Record<string, number> = {};
  mode: 'jev' | 'bm25' = 'jev';
  fallback: string | null = null;
  question = '';
  context = '';
  queryWords: string[] = [];
  yearFrom?: number;
  yearTo?: number;
  crossrefFilled = 0;
  gradeFrac = 0.5;
  skipped = 0;
  semanticNext = 0;
  arxivNext = 0;
  jevDeadline = 0;
  readonly oaStat = { calls: 0, usd: 0, remaining: null as number | null, errors: 0 };
  readonly jev = {
    down: false,
    ok: 0,
    fail: 0,
    consec: 0,
    calls: 0,
    attemptFails: 0,
    tokens: 0,
    lastErr: '',
    ctrl: new AbortController(),
  };

  constructor(readonly deps: SearchDeps) {
    this.fetcher = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => delay(ms, undefined, { signal: deps.signal }));
    this.env = deps.env ?? process.env;
    this.oaKey = this.env[deps.config.openalexKeyEnv] ?? '';
    this.email = deps.config.email;
    this.secrets = [
      this.oaKey,
      this.env[deps.config.springerKeyEnv] ?? '',
      ...(deps.secrets ?? []),
    ].filter((s) => s.length > 8);
    this.t0 = this.now();
    this.year = new Date(this.t0).getFullYear();
  }

  redact(s: unknown): string {
    return this.secrets.reduce((acc, k) => acc.split(k).join('<key>'), String(s));
  }
  warn(m: string) {
    const s = this.redact(m);
    if (!this.warnings.includes(s)) this.warnings.push(s);
  }
  elapsed() {
    return (this.now() - this.t0) / 1000;
  }
  userAgent() {
    return `Clawstrum-research/0.1${this.email ? ` (mailto:${this.email})` : ''}`;
  }
  async fetchT(url: string | URL, init: RequestInit, ms: number) {
    const timeout = AbortSignal.timeout(ms);
    const signal = this.deps.signal ? AbortSignal.any([this.deps.signal, timeout]) : timeout;
    return this.fetcher(url, { ...init, signal });
  }
  errText(e: any) {
    this.deps.signal?.throwIfAborted();
    return e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? 'timeout'
      : String(e?.message || e);
  }

  // --- OpenAlex ---
  async oaGet(
    params: Params,
    opts: { path?: string; semantic?: boolean; label: string; quiet?: boolean },
  ): Promise<any | null> {
    if (this.oaStat.usd >= OA_CAP_USD) {
      this.warn(`OpenAlex per-run cap $${OA_CAP_USD} reached, further calls skipped`);
      return null;
    }
    if (this.oaStat.remaining !== null && this.oaStat.remaining < 0.003) {
      this.warn('OpenAlex daily budget exhausted, further calls skipped');
      return null;
    }
    const u = new URL('https://api.openalex.org' + (opts.path ?? '/works'));
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    if (this.email) u.searchParams.set('mailto', this.email);
    const headers: Record<string, string> = { 'User-Agent': this.userAgent() };
    if (this.oaKey) headers.Authorization = `Bearer ${this.oaKey}`;
    let lastErr = '';
    for (let a = 0; a < 3; a++) {
      if (opts.semantic) {
        const now = this.now();
        const slot = Math.max(now, this.semanticNext);
        this.semanticNext = slot + 1100; // semantic search: 1 request/s, 429 otherwise
        if (slot > now) await this.sleep(slot - now);
      }
      let r: Response;
      try {
        r = await this.fetchT(u, { headers }, opts.semantic ? 20000 : 30000);
      } catch (e) {
        lastErr = this.errText(e);
        if (a < 1) {
          await this.sleep(1500);
          continue;
        }
        break;
      }
      this.oaStat.calls++;
      const c = Number(r.headers.get('x-ratelimit-cost-usd'));
      if (r.headers.has('x-ratelimit-cost-usd') && Number.isFinite(c)) this.oaStat.usd += c;
      const rem = r.headers.get('x-ratelimit-remaining-usd');
      if (rem !== null && Number.isFinite(Number(rem))) this.oaStat.remaining = Number(rem);
      if (r.status === 404) {
        await r.body?.cancel();
        return null;
      }
      const body = await r.text().catch(() => '');
      if (r.ok) {
        try {
          return JSON.parse(body);
        } catch {
          lastErr = 'non-JSON response';
          break;
        }
      }
      lastErr = `HTTP ${r.status} ${body.slice(0, 140).replace(/\s+/g, ' ')}`;
      if (r.status === 429 && !/budget|credit|daily/i.test(body)) {
        const ra = Number(r.headers.get('retry-after'));
        await this.sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra : 2, 10) * 1000 + 250);
        continue;
      }
      // Filtered semantic queries over wide year ranges answer 504 after ~9 s; a retry does not help.
      if (r.status >= 500 && r.status !== 504 && a < 1) {
        await this.sleep(1500);
        continue;
      }
      break;
    }
    this.oaStat.errors++;
    if (!opts.quiet) this.warn(`OpenAlex ${opts.label} failed: ${lastErr}`);
    return null;
  }

  // --- arXiv ---
  async arxivSearch(kw: string): Promise<Paper[]> {
    const terms = [
      ...new Set(
        kw
          .toLowerCase()
          .split(/[^a-z0-9-]+/)
          .filter((w) => w.length > 2 && !STOP.has(w)),
      ),
    ].slice(0, 4);
    if (!terms.length) return [];
    const since = new Date(this.now() - RECENT_MONTHS * 30.44 * 864e5)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, '');
    const q = `(${terms.map((t) => `all:${t}`).join(' AND ')}) AND submittedDate:[${since}0000 TO 209912312359]`;
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&sortBy=relevance&max_results=50`;
    const now = this.now();
    const slot = Math.max(now, this.arxivNext);
    this.arxivNext = slot + 3100; // arXiv API terms: one request every 3 s
    if (slot > now) await this.sleep(slot - now);
    let body: string;
    try {
      const r = await this.fetchT(url, { headers: { 'User-Agent': this.userAgent() } }, 25000);
      if (!r.ok) {
        await r.body?.cancel();
        this.warn(`arXiv search failed: HTTP ${r.status}`);
        return [];
      }
      body = await r.text();
    } catch (e) {
      this.warn(`arXiv search failed: ${this.errText(e)}`);
      return [];
    }
    const out: Paper[] = [];
    for (const m of body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const e = m[1]!;
      const id = e.match(/<id>[^<]*arxiv\.org\/abs\/([^<]+)<\/id>/)?.[1];
      const title = e.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1];
      if (!id || !title) continue;
      const summary = e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1];
      const pub = e.match(/<published>(\d{4})/)?.[1];
      const names = [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((x) => decodeXml(x[1]!).trim());
      const doi = e.match(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/)?.[1];
      out.push({
        oa: null,
        doi: cleanDoi(doi),
        arxiv: id.replace(/v\d+$/, ''),
        title: cleanTitle(decodeXml(title)),
        year: pub ? Number(pub) : null,
        venue: 'arXiv',
        cited_by: 0,
        authors: authorsOf(names),
        abstract: summary ? decodeXml(summary).replace(/\s+/g, ' ').trim() : null,
        refs: [],
        type: 'preprint',
      });
    }
    return out;
  }

  // --- candidate store ---
  keysOf(r: Paper) {
    const k: string[] = [];
    if (r.oa) k.push('W:' + r.oa);
    if (r.doi) k.push('d:' + r.doi);
    if (r.arxiv) k.push('a:' + r.arxiv);
    const t = normTitle(r.title);
    if (t.length >= 30) k.push('t:' + t);
    return k;
  }
  addCandidate(r: Paper | null, src: Src, bypassYear = false) {
    if (!r || !r.title) return null;
    if (r.type && SKIP_TYPES.has(r.type)) return null;
    if (
      this.drop.size &&
      [
        r.oa && 'W:' + r.oa,
        r.doi && 'd:' + r.doi,
        r.arxiv && 'a:' + r.arxiv,
        't:' + normTitle(r.title),
      ].some((k) => k && this.drop.has(k))
    )
      return null;
    if (!bypassYear && r.year) {
      if (this.yearFrom && r.year < this.yearFrom) return null;
      if (this.yearTo && r.year > this.yearTo) return null;
    }
    let rec: Cand | undefined;
    for (const k of this.keysOf(r)) if ((rec = this.index.get(k))) break;
    let isNew = false;
    if (rec) {
      for (const f of ['oa', 'doi', 'arxiv', 'venue', 'year', 'type'] as const)
        if (rec[f] == null && r[f] != null) (rec as any)[f] = r[f];
      if (r.abstract && (!rec.abstract || r.abstract.length > rec.abstract.length))
        rec.abstract = r.abstract;
      if (r.refs?.length && !rec.refs?.length) rec.refs = r.refs;
      if ((r.cited_by ?? 0) > (rec.cited_by ?? 0)) rec.cited_by = r.cited_by;
      if (!rec.authors?.length && r.authors?.length) rec.authors = r.authors;
      rec.src.push(src);
    } else {
      rec = { n: this.C.length, ...r, src: [src], stage: src.stage, pre: 0 };
      this.C.push(rec);
      isNew = true;
    }
    for (const k of this.keysOf(rec)) if (!this.index.has(k)) this.index.set(k, rec);
    return { rec, isNew };
  }

  async fillAbstracts(items: Cand[]) {
    const todo = items.filter((it) => !it.abstract && it.doi && !it.crossrefTried);
    await runPool(
      todo.map((it) => async () => {
        it.crossrefTried = true;
        try {
          const r = await this.fetchT(
            `https://api.crossref.org/works/${encodeURIComponent(it.doi!)}${this.email ? `?mailto=${encodeURIComponent(this.email)}` : ''}`,
            { headers: { 'User-Agent': this.userAgent() } },
            8000,
          );
          if (!r.ok) {
            await r.body?.cancel();
            return;
          }
          const a = ((await r.json()) as any)?.message?.abstract;
          if (typeof a === 'string' && a.length > 100) {
            it.abstract = decodeXml(a.replace(/<[^>]+>/g, ' '))
              .replace(/\s+/g, ' ')
              .replace(/^abstract\s*/i, '')
              .trim();
            it.abstractFrom = 'crossref';
            this.crossrefFilled++;
          }
        } catch {
          this.deps.signal?.throwIfAborted();
        }
      }),
      8,
    );
  }

  // --- graders ---
  switchToBm25(reason: string) {
    if (this.mode !== 'jev') return;
    this.mode = 'bm25';
    this.fallback = `jev: ${reason}`;
    this.warn(`jev unavailable (${reason}), whole run re-ranked by bm25`);
  }
  jevTrip(reason: string) {
    if (this.jev.down) return;
    this.jev.down = true;
    this.jev.ctrl.abort();
    this.switchToBm25(reason);
  }

  /** One paper, up to `attempts` calls. `count` = charge a final failure to the breaker. */
  async jevOne(it: Cand, attempts: number, count = true) {
    const decisions = this.deps.decisions!;
    for (let a = 0; a < attempts; a++) {
      if (this.jev.down) return null;
      const timeout = AbortSignal.timeout(JEV_TIMEOUT_MS);
      const { state, questions } = jevRequest(it, this.question, this.context);
      this.jev.calls++;
      let res: DecisionResult;
      try {
        res = await decisions.decide({
          feature: 'literature-search',
          version: '1',
          scope: this.deps.decisionScope?.scope ?? 'shared',
          sessionId: this.deps.decisionScope?.sessionId,
          runId: this.deps.decisionScope?.runId,
          workerId: this.deps.decisionScope?.workerId,
          state,
          questions,
          background: true,
          signal: AbortSignal.any([
            this.jev.ctrl.signal,
            timeout,
            ...(this.deps.signal ? [this.deps.signal] : []),
          ]),
        });
      } catch (e) {
        res = { status: 'unavailable', reason: this.redact((e as Error)?.message ?? e) };
      }
      if (this.jev.down) return null;
      this.deps.signal?.throwIfAborted();
      let err: string;
      if (res.status === 'decision') {
        const ans = res.response.answers.addresses;
        if (ans?.type === 'noul') {
          this.jev.ok++;
          this.jev.consec = 0;
          if (!res.cached) this.jev.tokens += res.response.usage?.input_tokens ?? 0;
          return { p: ans.noul };
        }
        err = 'response without an answer';
      } else {
        const fatal = FATAL_JEV[res.reason];
        if (fatal) {
          this.jevTrip(fatal);
          return null;
        }
        if (res.reason === 'capacity') {
          // The client's concurrency lease is full (possibly another process): wait, not a failure.
          this.jev.calls--;
          if (this.now() >= this.jevDeadline) return null;
          await this.sleep(100);
          a--;
          continue;
        }
        err =
          timeout.aborted && ['cancelled', 'timeout'].includes(res.reason)
            ? `no answer within ${JEV_TIMEOUT_MS / 1000} s`
            : res.reason;
      }
      this.jev.lastErr = err.slice(0, 120);
      // A dead or hanging service shows up in the first wave of calls; don't wait for three retries each.
      if (++this.jev.attemptFails >= 12 && this.jev.ok === 0) {
        this.jevTrip(
          `first ${this.jev.attemptFails} Jev calls all failed, last: ${this.jev.lastErr}`,
        );
        return null;
      }
      if (a < attempts - 1) await this.sleep(a === 0 ? 1000 : 3000);
    }
    if (!count) return null;
    this.jev.fail++;
    this.jev.consec++;
    const n = this.jev.ok + this.jev.fail;
    if (this.jev.consec >= 8)
      this.jevTrip(`8 Jev calls in a row failed, last: ${this.jev.lastErr}`);
    else if (n >= 20 && this.jev.fail / n > 0.25)
      this.jevTrip(`${this.jev.fail} of ${n} Jev calls failed, last: ${this.jev.lastErr}`);
    return null;
  }

  async jevGrade(items: Cand[], deadline: number) {
    if (!this.deps.decisions) {
      this.jevTrip('no decisions client');
      return;
    }
    this.jevDeadline = deadline;
    this.computePrerank();
    // Best pre-rank first: if a slow Jev runs into the deadline, what stays ungraded is the tail.
    // Only the top gradeFrac by pre-rank is graded at all. At 0.5 the Jev bill halves and, in real
    // full-vs-half runs, the top 30 stayed inside the spread between two full runs on all three
    // answer keys (blind-judged relevant 32 vs 40/30, worker-cited 37 vs 35/36, review refs 90 vs 89/90).
    const all = items.filter((it) => it.jev === undefined).sort((a, b) => b.pre - a.pre);
    const todo = all.slice(0, Math.ceil(this.gradeFrac * all.length));
    for (const it of all.slice(todo.length)) {
      it.jev = null; // ranked after the graded papers, by pre-rank
      this.skipped++;
    }
    const failed: Cand[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: this.deps.jevConcurrency ?? JEV_CONC }, async () => {
        while (next < todo.length && !this.jev.down && this.now() < deadline) {
          const it = todo[next++]!;
          const res = await this.jevOne(it, 3);
          if (res) it.jev = res;
          else if (!this.jev.down) failed.push(it);
        }
      }),
    );
    if (this.jev.down) return;
    // One slow sweep over the papers that failed three times.
    if (failed.length && this.now() < deadline)
      await runPool(
        failed.map((it) => async () => {
          if (this.jev.down || this.now() > deadline) return;
          const res = await this.jevOne(it, 1, false);
          if (res) {
            it.jev = res;
            this.jev.fail--;
          }
        }),
        4,
      );
    if (this.jev.down) return;
    const tried = this.jev.ok + this.jev.fail;
    // More than 5 % unanswered would leave a hole in the ranking; a different grader for them would mix scales.
    if (tried >= 20 && this.jev.fail / tried > 0.05) {
      this.jevTrip(`${this.jev.fail} of ${tried} papers got no Jev answer after retries`);
      return;
    }
    const lost = failed.filter((it) => it.jev === undefined);
    for (const it of lost) it.jev = null; // ranked after the graded papers, by pre-rank
    if (lost.length)
      this.warn(
        `${lost.length} papers got no Jev answer after retries (ranked after the graded ones)`,
      );
    const late = todo.filter((it) => it.jev === undefined).length;
    if (late) this.warn(`time budget: ${late} papers not graded (ranked after the graded ones)`);
  }

  // --- pre-rank: search-rank fusion + BM25 ---
  computePrerank() {
    const qt = [...new Set(stemTokens(this.queryWords.join(' ')))];
    const docs = this.C.map((it) => stemTokens(`${it.title} ${it.title} ${it.abstract || ''}`));
    const N = docs.length || 1;
    const avg = docs.reduce((s, d) => s + d.length, 0) / N || 1;
    const df = new Map<string, number>();
    for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
    const bm = docs.map((d) => {
      const tf = new Map<string, number>();
      for (const w of d) tf.set(w, (tf.get(w) || 0) + 1);
      let s = 0;
      for (const w of qt) {
        const f = tf.get(w);
        if (!f) continue;
        const n = df.get(w)!;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += (idf * (f * 2.2)) / (f + 1.2 * (0.25 + (0.75 * d.length) / avg));
      }
      return s;
    });
    const rrf = this.C.map((it) =>
      it.src.reduce((s, x) => {
        if (x.s === 'seed') return s + 1 / 60;
        const r = x.rank || 50;
        return s + (x.s === 'ref' || x.s === 'cite' ? 1 / (100 + r) : 1 / (60 + r));
      }, 0),
    );
    const mb = Math.max(...bm, 1e-9);
    const mr = Math.max(...rrf, 1e-9);
    this.C.forEach((it, i) => {
      it.bm25 = bm[i]! / mb;
      it.pre = 0.5 * it.bm25 + (0.5 * rrf[i]!) / mr;
    });
  }
  scoreOf(it: Cand): number | null {
    if (this.mode === 'jev') return typeof it.jev?.p === 'number' ? it.jev.p : null;
    return it.pre;
  }
  finalScore(it: Cand): number | null {
    const s = this.scoreOf(it);
    return s === null || this.mode !== 'jev' ? s : withRoutes(s, it.src.length);
  }
  ranked(list: Cand[] = this.C, score = (it: Cand) => this.scoreOf(it)) {
    this.computePrerank();
    return [...list].sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      if (sa === null && sb !== null) return 1;
      if (sb === null && sa !== null) return -1;
      if (sa !== null && sb !== null && sb !== sa) return sb - sa;
      return b.pre - a.pre;
    });
  }
  async grade(items: Cand[], deadline: number) {
    await this.fillAbstracts(items);
    if (this.mode === 'jev') await this.jevGrade(items, deadline);
    // A switch to bm25 needs no regrade: bm25 scores the whole list from the pre-rank.
  }

  // --- seeds and expansion ---
  async resolveOA(it: Cand) {
    if (it.oa) return it.oa;
    if (it.doi) {
      const w = await this.oaGet(
        { select: 'id' },
        {
          path: '/works/doi:' + encodeURIComponent(it.doi).replace(/%2F/gi, '/'),
          label: 'doi lookup',
        },
      );
      if (w?.id) return shortId(w.id);
    }
    const q = it.title
      .replace(/[,|:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const res = await this.oaGet(
      { filter: `title.search:${q}`, per_page: 5, select: 'id,title' },
      { label: 'title lookup' },
    );
    const want = normTitle(it.title);
    const hit = (res?.results || []).find((w: any) => normTitle(w.title) === want);
    return hit ? shortId(hit.id) : null;
  }
  async expand(seeds: Cand[], stage: number) {
    const fresh: Cand[] = [];
    const push = (x: { rec: Cand; isNew: boolean } | null) => {
      if (x?.isNew) fresh.push(x.rec);
    };
    await runPool(
      seeds.map((s) => async () => {
        s.expanded = stage;
        const oa = await this.resolveOA(s);
        if (!oa) {
          this.warn(`seed not in OpenAlex, not expanded: ${s.title.slice(0, 70)}`);
          return;
        }
        s.oa = oa;
        let refs = s.refs || [];
        if (!refs.length) {
          const w = await this.oaGet(
            { select: 'id,referenced_works' },
            { path: `/works/${oa}`, label: 'refs lookup' },
          );
          refs = (w?.referenced_works || []).map(shortId).filter(Boolean);
          s.refs = refs;
        }
        for (let i = 0; i < Math.min(refs.length, 200); i += 100) {
          const j = await this.oaGet(
            {
              filter: `openalex_id:${refs.slice(i, i + 100).join('|')}`,
              per_page: 100,
              select: OA_SELECT,
            },
            { label: 'refs' },
          );
          (j?.results || []).forEach((w: any, r: number) =>
            push(this.addCandidate(fromOA(w), { s: 'ref', of: s.n, rank: i + r + 1, stage })),
          );
        }
        for (const [sort, tag] of [
          ['cited_by_count:desc', 'top'],
          ['publication_date:desc', 'new'],
        ] as const) {
          const j = await this.oaGet(
            { filter: `cites:${oa}`, per_page: 25, sort, select: OA_SELECT },
            { label: 'citers' },
          );
          (j?.results || []).forEach((w: any, r: number) =>
            push(
              this.addCandidate(fromOA(w), { s: 'cite', of: s.n, sort: tag, rank: r + 1, stage }),
            ),
          );
        }
      }),
      3,
    );
    return fresh;
  }

  async resolveSeed(raw: string) {
    const p = parseId(raw);
    if (!p) {
      this.warn(`seed not understood: ${raw}`);
      return null;
    }
    let w: any = null;
    if (p.kind === 'openalex')
      w = await this.oaGet({ select: OA_SELECT }, { path: `/works/${p.id}`, label: 'seed' });
    else if (p.kind === 'doi')
      w = await this.oaGet(
        { select: OA_SELECT },
        { path: '/works/doi:' + encodeURIComponent(p.doi).replace(/%2F/gi, '/'), label: 'seed' },
      );
    else {
      const r = await this.fetchT(
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(p.id)}`,
        { headers: { 'User-Agent': this.userAgent() } },
        20000,
      )
        .then((x) => x.text())
        .catch(() => '');
      const t = r.match(/<entry>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/)?.[1];
      if (t) {
        const title = cleanTitle(decodeXml(t));
        const q = title
          .replace(/[,|:]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const res = await this.oaGet(
          { filter: `title.search:${q}`, per_page: 5, select: OA_SELECT },
          { label: 'seed' },
        );
        w = (res?.results || []).find((x: any) => normTitle(x.title) === normTitle(title)) || null;
      }
    }
    if (!w) {
      this.warn(`seed not found in OpenAlex: ${raw}`);
      return null;
    }
    const x = this.addCandidate(fromOA(w), { s: 'seed', stage: 0 }, true);
    if (!x) this.warn(`seed dropped by exclude: ${raw}`);
    return x?.rec ?? null;
  }

  async run(raw: SearchInput): Promise<SearchResult> {
    const A = searchInputSchema.parse(raw);
    this.question = A.q.trim();
    this.context = (A.ctx || '').trim().slice(0, 3000);
    this.queryWords = [this.question, this.context, ...A.kw, ...A.para];
    this.yearFrom = A.from;
    this.yearTo = A.to;
    this.gradeFrac = A.gradeFrac;
    const K = A.k;
    const budgetMs = (this.deps.budgetS ?? 240) * 1000;
    const deadline = this.t0 + budgetMs;
    if (A.grader === 'bm25') {
      this.mode = 'bm25';
      this.fallback = null;
    }
    if (!this.oaKey)
      this.warn(
        `no OpenAlex API key in $${this.deps.config.openalexKeyEnv}: OpenAlex calls run unauthenticated and may be refused or rate-limited`,
      );
    if (!this.context)
      this.warn(
        'no ctx given: Jev ranks noticeably worse without 3-4 lines of project context (.81 vs .875 nDCG@20)',
      );

    for (const d of A.exclude) {
      const p = parseId(d);
      if (p?.kind === 'openalex') this.drop.add('W:' + p.id);
      else if (p?.kind === 'doi') this.drop.add('d:' + p.doi);
      else if (p?.kind === 'arxiv') this.drop.add('a:' + p.id);
      else this.drop.add('t:' + normTitle(d));
    }

    const userSeeds: Cand[] = [];
    for (const raw of A.seeds) {
      const s = await this.resolveSeed(raw);
      if (s) userSeeds.push(s);
    }

    // Search.
    const kws = A.kw;
    const yf =
      A.from && A.to
        ? `publication_year:${A.from}-${A.to}`
        : A.from
          ? `publication_year:>${A.from - 1}`
          : A.to
            ? `publication_year:<${A.to + 1}`
            : undefined;
    const kwJobs = kws.map((kw, i) => async () => {
      const j = await this.oaGet(
        { search: kw, per_page: 100, filter: yf, select: OA_SELECT },
        { label: `keyword search ${i + 1}` },
      );
      const res = j?.results || [];
      this.srcCounts[`kw${i + 1}`] = res.length;
      res.forEach((w: any, r: number) =>
        this.addCandidate(fromOA(w), { s: `kw${i + 1}`, rank: r + 1, stage: 0 }),
      );
    });
    const semJob = async () => {
      const texts = [this.question, ...A.para].map((t) => t.slice(0, 600));
      for (const [i, t] of texts.entries()) {
        for (const recent of [false, true]) {
          if (recent && A.to && A.to < this.year - 1) continue;
          const rf = `publication_year:>${this.year - 2}`;
          let tag = `sem${i + 1}${recent ? 'r' : ''}`;
          const j = await this.oaGet(
            {
              'search.semantic': t,
              per_page: 50,
              filter: recent ? rf : undefined,
              select: OA_SELECT,
            },
            {
              semantic: true,
              quiet: recent,
              label: `semantic search ${i + 1}${recent ? ' (recent)' : ''}`,
            },
          );
          let res = j?.results || [];
          if (recent && !j) {
            // The year-filtered semantic call 504s on about a third of queries; keyword search with the same filter stands in.
            tag = `kw${i + 1}r`;
            const k = await this.oaGet(
              { search: kws[i] || kws[0], per_page: 50, filter: rf, select: OA_SELECT },
              { label: `recent keyword search ${i + 1}` },
            );
            res = k?.results || [];
          }
          this.srcCounts[tag] = res.length;
          res.forEach((w: any, r: number) =>
            this.addCandidate(fromOA(w), { s: tag, rank: r + 1, stage: 0 }),
          );
        }
      }
    };
    const arxJob = async () => {
      if (A.to && A.to < this.year - 1) return;
      for (const [i, kw] of kws.slice(0, 3).entries()) {
        const res = await this.arxivSearch(kw);
        this.srcCounts[`arxiv${i + 1}`] = res.length;
        res.forEach((r, k) => this.addCandidate(r, { s: 'arxiv', rank: k + 1, stage: 0 }));
      }
    };
    await Promise.all([runPool(kwJobs, 4), semJob(), arxJob()]);
    this.deps.signal?.throwIfAborted();
    if (!this.C.length)
      throw new Error(`nothing retrieved. warnings: ${this.warnings.join('; ') || 'none'}`);
    const nSearch = this.C.length;

    await this.grade(this.C.slice(), deadline - 20000);

    // Expansion.
    const hopLog: SearchResult['counts']['hops'] = [];
    const seedLog: Array<{
      hop: number;
      seeds: Array<{ n: number; title: string; score: number | null }>;
    }> = [];
    let frontier = this.C.slice();
    for (let h = 1; h <= A.hops; h++) {
      this.deps.signal?.throwIfAborted();
      if (this.now() > deadline - 45000) {
        this.warn(`time budget: stopped before hop ${h}`);
        break;
      }
      if (this.mode !== 'jev' && h > 1) break; // bm25 can't tell whether a hop helped
      const thr = this.mode === 'jev' ? 0.5 : Infinity;
      let seeds = this.ranked(frontier)
        .filter((it) => {
          const s = this.scoreOf(it);
          return it.expanded === undefined && s !== null && s >= thr;
        })
        .slice(0, 5);
      if (h === 1) {
        if (this.mode === 'bm25') seeds = this.ranked(frontier).slice(0, 3); // word-match top 3 are the best guess
        if (this.mode === 'jev' && seeds.length < 3) {
          this.warn(
            `weak seeds: only ${seeds.length} search hits reached P >= .5, the question or keywords may be off, check the list by eye`,
          );
          if (!seeds.length)
            seeds = this.ranked(frontier)
              .filter((it) => this.scoreOf(it) !== null)
              .slice(0, 2);
        }
        seeds = [
          ...userSeeds.filter((s) => s.expanded === undefined),
          ...seeds.filter((s) => !userSeeds.includes(s)),
        ];
      }
      if (!seeds.length) break;
      const topBefore = new Set(
        this.ranked()
          .slice(0, K)
          .map((it) => it.n),
      );
      const fresh = await this.expand(seeds, h);
      await this.grade(fresh, deadline - 15000);
      const enteredTop = this.ranked()
        .slice(0, K)
        .filter((it) => !topBefore.has(it.n) && it.stage === h).length;
      hopLog.push({ hop: h, seeds: seeds.length, new: fresh.length, entered_top: enteredTop });
      seedLog.push({
        hop: h,
        seeds: seeds.map((s) => ({ n: s.n, title: s.title, score: this.scoreOf(s) })),
      });
      frontier = fresh;
      if (enteredTop < 2) break; // converged
    }

    // Rank and report.
    const all = this.ranked(this.C, (it) => this.finalScore(it));
    const graded = all.filter((it) => this.scoreOf(it) !== null).length;
    const pack = (it: Cand, rank: number) => ({
      rank,
      score: this.finalScore(it),
      grader: this.mode,
      jev_p: it.jev?.p ?? null,
      pre: Number((it.pre ?? 0).toFixed(4)),
      title: it.title,
      year: it.year,
      venue: it.venue,
      authors: it.authors,
      cited_by: it.cited_by,
      doi: it.doi,
      arxiv: it.arxiv,
      openalex: it.oa,
      abstract: it.abstract,
      abstract_from: it.abstractFrom || (it.abstract ? 'openalex/arxiv' : null),
      stage: it.stage,
      via: it.src.map((x) =>
        x.of !== undefined
          ? `${x.s}${x.sort ? ':' + x.sort : ''}<${x.of}`
          : `${x.s}#${x.rank ?? ''}`,
      ),
      n: it.n,
    });
    const jevUsd = (this.jev.tokens * (this.deps.jevUsdPerMillion ?? 0.042)) / 1e6;
    const fallback = this.mode === 'jev' ? null : (this.fallback ?? 'grader=bm25 requested');
    const artifact = path.join(
      this.deps.artifactDir,
      `${new Date(this.t0).toISOString().slice(0, 10)}-${slugOf(this.question)}-${randomUUID().slice(0, 8)}.json`,
    );
    const result: SearchResult = {
      grader: this.mode,
      fallback,
      warnings: this.warnings,
      counts: {
        candidates: this.C.length,
        search: nSearch,
        graded,
        skipped_by_word_match: this.skipped,
        no_abstract: this.C.filter((it) => !it.abstract).length,
        crossref_abstracts: this.crossrefFilled,
        by_source: this.srcCounts,
        hops: hopLog,
      },
      cost: {
        openalex_usd: Number(this.oaStat.usd.toFixed(4)),
        openalex_calls: this.oaStat.calls,
        openalex_remaining_today_usd: this.oaStat.remaining,
        jev_ok: this.jev.ok,
        jev_failed: this.jev.fail,
        jev_calls: this.jev.calls,
        jev_usd: Number(jevUsd.toFixed(4)),
      },
      seconds: Number(this.elapsed().toFixed(1)),
      artifact,
      top: all.slice(0, K).map((it, i) => {
        const s = this.finalScore(it);
        return {
          rank: i + 1,
          score: s === null ? null : Number(s.toFixed(3)),
          title: it.title,
          year: it.year,
          author: it.authors[0] ?? null,
          id: idOf(it),
        };
      }),
    };
    writePrivate(
      artifact,
      this.redact(
        JSON.stringify(
          {
            version: 1,
            query: A,
            ...result,
            top: undefined,
            seeds: seedLog,
            ranked: all.map((it, i) => pack(it, i + 1)),
          },
          null,
          1,
        ),
      ),
    );
    return JSON.parse(this.redact(JSON.stringify(result)));
  }
}

/** Run one literature search. Throws (with secrets redacted) when nothing was retrieved. */
export async function searchLiterature(
  input: SearchInput,
  deps: SearchDeps,
): Promise<SearchResult> {
  const run = new SearchRun(deps);
  try {
    return await run.run(input);
  } catch (e) {
    if (deps.signal?.aborted) throw e;
    const err = new Error(run.redact((e as Error)?.message ?? e));
    err.name = (e as Error)?.name ?? 'Error';
    throw err;
  }
}
