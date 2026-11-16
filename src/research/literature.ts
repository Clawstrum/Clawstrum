import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store } from '../store.js';
import { writePrivate } from '../files.js';
import type { ResearchConfig } from './config.js';
import { ResearchHttp, ResearchHttpError, publicUrl, markupText, decodeEntities } from './http.js';

export interface CitationId {
  kind: 'doi' | 'arxiv' | 'pmcid' | 'pmid' | 'openreview' | 'osf';
  id: string;
  key: string;
}
const citationId = (kind: CitationId['kind'], id: string): CitationId => ({
  kind,
  id,
  key: `${kind}:${id}`,
});
/** A URL typed without its scheme (arxiv.org/abs/…). DOIs and old-style arXiv ids also look like host/path. */
function hostPath(value: string) {
  return (
    /^(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*$/i.test(value) &&
    !/^10\.\d{4,9}\//.test(value) &&
    !/^[a-z-]+\.[a-z]{2}\/\d{7}(?:v\d+)?$/i.test(value)
  );
}
export function parseCitation(raw: string): CitationId | undefined {
  let value = raw.trim();
  const prefixed = /^(pmid|pmcid|openreview):\s*(\S+)$/i.exec(value);
  if (prefixed) {
    const [, prefix, rest] = prefixed;
    if (/^pmid$/i.test(prefix!)) return /^\d+$/.test(rest!) ? citationId('pmid', rest!) : undefined;
    if (/^openreview$/i.test(prefix!))
      return /^[A-Za-z0-9_-]+$/.test(rest!) ? citationId('openreview', rest!) : undefined;
    value = rest!;
  }
  if (/^PMC\d+$/i.test(value)) return citationId('pmcid', value.toUpperCase());
  value = value.replace(/^(?:doi:|arxiv:)\s*/i, '');
  if (hostPath(value)) value = `https://${value}`;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    let m: RegExpExecArray | null;
    /* Checked before any DOI: a PMC page URL can carry another paper's DOI in its query string. */
    if (
      (host === 'pmc.ncbi.nlm.nih.gov' ||
        (/^(?:www\.)?ncbi\.nlm\.nih\.gov$/.test(host) && url.pathname.startsWith('/pmc/')) ||
        /^(?:www\.)?europepmc\.org$/.test(host) ||
        (/^(?:www\.)?ebi\.ac\.uk$/.test(host) && url.pathname.startsWith('/europepmc/'))) &&
      (m = /[/=](PMC\d+)(?:[/?#.&]|$)/i.exec(url.pathname + url.search))
    )
      return citationId('pmcid', m[1]!.toUpperCase());
    if (
      (m =
        /^(?:pubmed\.ncbi\.nlm\.nih\.gov\/|(?:www\.)?ncbi\.nlm\.nih\.gov\/pubmed\/|(?:www\.)?europepmc\.org\/(?:article|abstract)\/MED\/)(\d+)\/?$/i.exec(
          host + url.pathname,
        ))
    )
      return citationId('pmid', m[1]!);
    if (
      /^(?:www\.)?openreview\.net$/.test(host) &&
      /^\/(?:forum|pdf|attachment)$/.test(url.pathname)
    ) {
      const note = url.searchParams.get('id') ?? '';
      return /^[A-Za-z0-9_-]+$/.test(note) ? citationId('openreview', note) : undefined;
    }
    if (
      /^(?:www\.)?osf\.io$/.test(host) &&
      (m = /^\/(?:preprints\/[a-z0-9-]+\/)?([a-z0-9]{5}(?:_v\d+)?)\/?$/i.exec(url.pathname))
    )
      return citationId('osf', m[1]!.toLowerCase());
    if (/^(?:dx\.)?doi\.org$/i.test(url.hostname))
      value = decodeURIComponent(url.pathname.slice(1));
    else if (/^(?:www\.)?arxiv\.org$/i.test(url.hostname))
      value = url.pathname.replace(/^\/(abs|pdf|html)\//, '').replace(/\.pdf$/, '');
    else return;
  }
  value = value.replace(/^10\.48550\/arxiv\./i, '');
  const kind = /^10\.\d{4,9}\/\S+$/i.test(value)
    ? 'doi'
    : /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i.test(value)
      ? 'arxiv'
      : undefined;
  if (!kind) return;
  return citationId(kind, value.toLowerCase());
}
export interface CitationOccurrence extends CitationId {
  index: number;
  end: number;
}
/** DOIs stop at '<' so an HTML tag cannot be swallowed, except after the (SICI) marker, where the
 * angle brackets belong to the identifier. Bare arXiv numbers carry no prefix to key on, so the
 * YYMM half is constrained to a real arXiv month; that is what separates 2301.12345 from a decimal.
 */
const CITATION_PATTERN =
  /(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\/(?:\(SICI\)[^\s"`{}]+|[^\s<>"`{}]+)|(?:arxiv:\s*|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/)(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?|(?<![\w./-])(?:0[7-9]|[1-9]\d)(?:0[1-9]|1[0-2])\.\d{4,5}(?:v\d+)?(?!\.?\d)/gi;
export function citationOccurrences(text: string): CitationOccurrence[] {
  const matches = [...text.matchAll(CITATION_PATTERN)];
  return matches.flatMap((match) => {
    const raw = match[0];
    let clean = raw.replace(/[.,;!?'`*\]}]+$/, '');
    while (
      clean.endsWith('>') &&
      (clean.match(/>/g)?.length ?? 0) > (clean.match(/</g)?.length ?? 0)
    )
      clean = clean.slice(0, -1);
    while (
      clean.endsWith(')') &&
      (clean.match(/\)/g)?.length ?? 0) > (clean.match(/\(/g)?.length ?? 0)
    )
      clean = clean.slice(0, -1);
    const id = parseCitation(clean);
    return id ? [{ ...id, index: match.index, end: match.index + clean.length }] : [];
  });
}
export function citationRefs(text: string): CitationId[] {
  const refs = citationOccurrences(text).map(({ kind, id, key }) => ({ kind, id, key }));
  return [...new Map(refs.map((id) => [id.key, id])).values()];
}
export interface CitationRecord extends CitationId {
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  source: string;
  fetchedAt: number;
  responseHash: string;
  responsePath: string;
  correctionLinks: unknown[];
}
function meta(html: string, key: string): string[] {
  return [...html.matchAll(/<meta\b[^>]*>/gi)].flatMap(([tag]) => {
    const attrs = Object.fromEntries(
      [...tag.matchAll(/([\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map((m) => [
        m[1]!.toLowerCase(),
        decodeEntities(m[3]!),
      ]),
    );
    return attrs.name === key && attrs.content ? [attrs.content] : [];
  });
}
export async function verifyCitation(
  store: Store,
  config: ResearchConfig,
  raw: string,
  http = new ResearchHttp(config),
  signal?: AbortSignal,
): Promise<CitationRecord> {
  const id = parseCitation(raw);
  if (!id) throw new Error('Expected a DOI, arXiv ID or identifier URL');
  if (id.kind !== 'doi' && id.kind !== 'arxiv')
    throw new Error('Registry verification needs a DOI or arXiv ID');
  const url =
    id.kind === 'doi'
      ? `https://api.crossref.org/works/${encodeURIComponent(id.id)}${config.email ? `?mailto=${encodeURIComponent(config.email)}` : ''}`
      : `https://arxiv.org/abs/${id.id}`;
  let response;
  let dataCite = false;
  try {
    response = await http.get(url, 5000000, signal);
  } catch (error) {
    // A missing Crossref record can belong to another registration agency. Outages, throttling,
    // malformed records and cancelled requests are not evidence that a DOI belongs to DataCite.
    if (id.kind !== 'doi' || !(error instanceof ResearchHttpError) || error.status !== 404)
      throw error;
    signal?.throwIfAborted();
    response = await http.get(
      `https://api.datacite.org/dois/${encodeURIComponent(id.id)}`,
      5000000,
      signal,
    );
    dataCite = true;
  }
  const body = response.bytes.toString('utf8');
  let title: string;
  let authors: string[];
  let year: number | null;
  let venue: string | null;
  let correctionLinks: unknown[] = [];
  if (dataCite) {
    const data = JSON.parse(body).data;
    const m = data?.attributes;
    if (String(data?.id).toLowerCase() !== id.id || String(m?.doi).toLowerCase() !== id.id)
      throw new Error('Registry returned a different DOI');
    title = markupText(
      m.titles?.find((t: any) => !t.titleType)?.title ?? m.titles?.[0]?.title ?? '',
    );
    authors = (m.creators ?? []).map((a: any) =>
      a.givenName || a.familyName
        ? [a.givenName, a.familyName].filter(Boolean).join(' ')
        : (a.name ?? ''),
    );
    year = m.publicationYear ?? null;
    venue =
      m.container?.title ??
      (typeof m.publisher === 'string' ? m.publisher : m.publisher?.name) ??
      null;
    correctionLinks = (m.relatedIdentifiers ?? []).filter((r: any) =>
      [
        'IsNewVersionOf',
        'IsPreviousVersionOf',
        'IsVersionOf',
        'HasVersion',
        'Obsoletes',
        'IsObsoletedBy',
      ].includes(r.relationType),
    );
  } else if (id.kind === 'doi') {
    const m = JSON.parse(body).message;
    if (String(m?.DOI).toLowerCase() !== id.id)
      throw new Error('Registry returned a different DOI');
    title = markupText(m.title?.[0] ?? '');
    authors = (m.author ?? []).map((a: any) =>
      [a.given, a.family || a.name].filter(Boolean).join(' '),
    );
    year = m.issued?.['date-parts']?.[0]?.[0] ?? null;
    venue = m['container-title']?.[0] ?? null;
    correctionLinks = m['update-to'] ?? [];
  } else {
    title = meta(body, 'citation_title')[0] ?? '';
    authors = meta(body, 'citation_author');
    const date = meta(body, 'citation_date')[0] ?? meta(body, 'citation_publication_date')[0];
    year = date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
    venue = 'arXiv';
    const canonical = meta(body, 'citation_arxiv_id')[0];
    if (canonical && canonical.toLowerCase().replace(/v\d+$/, '') !== id.id.replace(/v\d+$/, ''))
      throw new Error('Registry returned a different arXiv ID');
  }
  title = title.trim();
  authors = authors.map((a) => a.trim()).filter(Boolean);
  year =
    typeof year === 'number' && Number.isInteger(year) && year >= 1000 && year <= 9999
      ? year
      : null;
  if (!title || !authors.length)
    throw new Error('Registry response lacks a title or authors; not recorded as verified');
  const hash = createHash('sha256').update(response.bytes).digest('hex');
  const responsePath = path.join(store.home, 'research', 'citations', `${hash}.txt`);
  writePrivate(responsePath, body);
  const record: CitationRecord = {
    ...id,
    title,
    authors,
    year,
    venue,
    source: publicUrl(response.url),
    fetchedAt: Date.now(),
    responseHash: hash,
    responsePath,
    correctionLinks,
  };
  store.exec(
    'INSERT INTO citations(key,metadata_json,verified_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET metadata_json=excluded.metadata_json,verified_at=excluded.verified_at',
    id.key,
    JSON.stringify(record),
    record.fetchedAt,
  );
  return record;
}
export function citationRecord(store: Store, raw: string): CitationRecord | undefined {
  const id = parseCitation(raw);
  const row =
    id &&
    store.get<{ metadata_json: string }>('SELECT metadata_json FROM citations WHERE key=?', id.key);
  return row ? JSON.parse(row.metadata_json) : undefined;
}
const normalize = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export function checkCitation(
  store: Store,
  claim: {
    id: string;
    title?: string;
    authors?: string[];
    year?: number;
    quote?: string;
    textPath?: string;
  },
) {
  const record = citationRecord(store, claim.id);
  const issues: string[] = [];
  if (!record) issues.push('Identifier has no verified registry record');
  else {
    if (claim.title && normalize(claim.title) !== normalize(record.title))
      issues.push('Title differs from registry');
    if (claim.year && (!record.year || Math.abs(claim.year - record.year) > 1))
      issues.push('Year differs from registry by more than one');
    for (const author of claim.authors ?? [])
      if (!record.authors.some((a) => ` ${normalize(a)} `.includes(` ${normalize(author)} `)))
        issues.push(`Author absent from registry: ${author}`);
  }
  if (claim.quote) {
    if (!claim.textPath) issues.push('Quote checking requires a retrieved textPath');
    else if (
      !normalize(claim.quote) ||
      !normalize(fs.readFileSync(claim.textPath, 'utf8')).includes(normalize(claim.quote))
    )
      issues.push('Quote does not occur in the supplied text');
  }
  return {
    ok: issues.length === 0,
    issues,
    record,
    scope:
      'Identifier metadata and supplied-text matching only; not scientific claim validation or a tamper-proof ledger.',
  };
}
interface Candidate {
  source: string;
  url: string;
  kind: 'pdf' | 'article' | 'landing';
  version?: string;
  /** Lift the article markup out of a JSON envelope; a rung setting this is an API, not a document. */
  unwrap?: (raw: string) => string | undefined;
  /** JATS without a <body> is a metadata-only deposit, which the character floor does not catch. */
  requireBody?: boolean;
  /** Read the version off the response, for rungs that cannot know it before fetching. */
  versionFrom?: (raw: string) => string;
  /** Request headers carrying a credential; never copied into attempts or the manifest. */
  headers?: Record<string, string>;
  /** Paid per download: held to the budget reserve, and a PDF must be complete. */
  metered?: boolean;
}
export interface PaperResult {
  status: 'ok' | 'no-fulltext';
  retrievedAt: number;
  input: string;
  textPath?: string;
  documentPath?: string;
  manifestPath: string;
  source?: string;
  url?: string;
  version?: string;
  chars?: number;
  textHash?: string;
  layoutTextPath?: string;
  layoutTextHash?: string;
  layoutNote?: string;
  pdfExtraction?: number;
  retrievalVersion?: number;
  attempts: Array<{ source: string; outcome: string }>;
  cached?: boolean;
}
/**
 * Bumped when PDF extraction changes such that older cached text is no longer safe to quote.
 * 2: prose is extracted in reading order. Text cached under the earlier -layout default interleaves
 * the columns of a two-column page, so it is refused rather than served.
 */
const PDF_EXTRACTION = 2;
const STRUCTURED_RETRIEVAL = 2;
const LAYOUT_NOTE =
  'Tables only. This copy preserves the physical page and can interleave columns. ' +
  'Quote from textPath, checking the source document for extraction errors.';
function stalePdfText(cached: PaperResult): boolean {
  return /\.pdf$/i.test(cached.documentPath ?? '') && (cached.pdfExtraction ?? 1) < PDF_EXTRACTION;
}
/** An accepted manuscript differs in wording and pagination from the published version of record. */
function pmcVersion(raw: string): string {
  const front = /<front\b[^>]*>([\s\S]*?)<\/front>/i.exec(raw)?.[1] ?? '';
  return /pub-id-type\s*=\s*["']manuscript["']|HHS Public Access|Author manuscript/i.test(front)
    ? 'acceptedVersion'
    : 'publishedVersion';
}
async function pdfToText(
  config: ResearchConfig,
  flags: string[],
  documentPath: string,
  out: string,
  signal?: AbortSignal,
): Promise<string> {
  fs.writeFileSync(out, '', { mode: 0o600, flag: 'wx' });
  await promisify(execFile)(config.pdftotext, [...flags, '-nopgbrk', documentPath, out], {
    timeout: config.requestTimeoutMs,
    signal,
    maxBuffer: 65536,
    killSignal: 'SIGKILL',
  });
  return fs.readFileSync(out, 'utf8');
}
export async function retrievePaper(
  store: Store,
  config: ResearchConfig,
  raw: string,
  http = new ResearchHttp(config),
  signal?: AbortSignal,
  refresh = false,
): Promise<PaperResult> {
  const id = parseCitation(raw);
  let rawUrl: URL | undefined;
  if (!id) {
    try {
      rawUrl = new URL(hostPath(raw.trim()) ? `https://${raw.trim()}` : raw.trim());
    } catch {
      throw new Error(
        `Not a DOI, arXiv id, PMID, PMCID, OpenReview/OSF id or URL: ${raw.slice(0, 200)}`,
      );
    }
  }
  const key = createHash('sha256')
    .update(id?.key ?? raw)
    .digest('hex');
  const dir = path.join(store.home, 'research', 'papers', key);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!refresh && fs.existsSync(manifestPath)) {
    try {
      const cached: PaperResult = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (
        cached.status === 'ok' &&
        (cached.chars ?? 0) >= config.minTextChars &&
        cached.textPath &&
        fs.existsSync(cached.textPath) &&
        createHash('sha256').update(fs.readFileSync(cached.textPath)).digest('hex') ===
          cached.textHash &&
        !stalePdfText(cached) &&
        (!['europe-pmc', 'ncbi-efetch', 'elife-reviewed-preprint'].includes(cached.source ?? '') ||
          cached.retrievalVersion === STRUCTURED_RETRIEVAL)
      ) {
        if (
          cached.layoutTextPath &&
          (!cached.layoutTextHash ||
            !fs.existsSync(cached.layoutTextPath) ||
            createHash('sha256').update(fs.readFileSync(cached.layoutTextPath)).digest('hex') !==
              cached.layoutTextHash)
        ) {
          delete cached.layoutTextPath;
          delete cached.layoutTextHash;
          delete cached.layoutNote;
          cached.attempts.push({
            source: 'pdf-layout',
            outcome: 'Cached table copy missing or changed; returning verified prose only',
          });
        }
        return { ...cached, cached: true };
      }
    } catch {
      /* A corrupt cache is a miss, not evidence of full text. */
    }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const result: PaperResult = {
    status: 'no-fulltext',
    retrievedAt: Date.now(),
    input: id?.key ?? publicUrl(rawUrl!.href),
    manifestPath,
    attempts: [],
  };
  const candidates: Candidate[] = [];
  const lookup = async <T>(source: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      signal?.throwIfAborted();
      result.attempts.push({ source, outcome: String(e).slice(0, 500) });
    }
  };
  const contact = config.email ? `&email=${encodeURIComponent(config.email)}` : '';
  /* The DOI structured text is checked against and the paid rung is keyed on: the first one the
   * input names or resolves to. */
  let ladderDoi: string | undefined;
  const arxivRungs = (arxiv: string): Candidate[] => [
    {
      source: 'arxiv-pdf',
      url: `https://arxiv.org/pdf/${arxiv}`,
      kind: 'pdf',
      version: 'preprint',
    },
    {
      source: 'arxiv-html',
      url: `https://arxiv.org/html/${arxiv}`,
      kind: 'article',
      version: 'preprint',
    },
    {
      source: 'ar5iv',
      url: `https://ar5iv.labs.arxiv.org/html/${arxiv}`,
      kind: 'article',
      version: 'preprint',
    },
  ];
  const pmcRungs = (pmcid: string, pmcOpenAccess: boolean): Candidate[] => [
    /* fullTextXML answers 500 outside the redistributable subset, so it is offered only there. */
    ...(pmcOpenAccess
      ? [
          {
            source: 'europe-pmc',
            url: `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`,
            kind: 'article' as const,
            versionFrom: pmcVersion,
            requireBody: true,
          },
        ]
      : []),
    /* isOpenAccess is a licence flag, not a readability one: author-manuscript deposits are marked
     * N and read in full. NCBI serves both, so this rung is offered whatever the flag says. */
    {
      source: 'ncbi-efetch',
      url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${encodeURIComponent(pmcid)}&retmode=xml&tool=clawstrum${contact}`,
      kind: 'article',
      requireBody: true,
      versionFrom: pmcVersion,
    },
  ];
  /* OSF preprint landing pages are a JavaScript app with no file link; the API is the only route. */
  const osfRungs = (osf: string) =>
    lookup('osf-api', async () => {
      const data = await http.json(
        `https://api.osf.io/v2/preprints/${encodeURIComponent(osf)}/`,
        signal,
      );
      const file = data?.data?.relationships?.primary_file?.links?.related?.href;
      if (typeof file !== 'string') throw new Error('OSF preprint has no primary file');
      const download = (await http.json(file, signal))?.data?.links?.download;
      if (typeof download !== 'string') throw new Error('OSF file record has no download link');
      candidates.push({ source: 'osf-pdf', url: download, kind: 'pdf', version: 'preprint' });
    });
  const doiRungs = async (doi: string, pmcKnown = false) => {
    ladderDoi ??= doi;
    if (!pmcKnown) {
      let pmcid: string | undefined;
      let pmcOpenAccess = false;
      await lookup('europe-pmc', async () => {
        const data = await http.json(
          `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`DOI:"${doi}"`)}&format=json&resultType=core`,
          signal,
        );
        const hit = data.resultList?.result?.find((r: any) => String(r.doi).toLowerCase() === doi);
        if (hit?.pmcid) {
          if (!/^PMC\d+$/.test(String(hit.pmcid)))
            throw new Error('Invalid PMCID in Europe PMC response');
          pmcid = String(hit.pmcid);
          pmcOpenAccess = hit.isOpenAccess === 'Y';
        }
      });
      /* Europe PMC's search index misses records the US archive holds; its ID converter is keyless. */
      if (!pmcid)
        await lookup('pmc-idconv', async () => {
          const data = await http.json(
            `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${encodeURIComponent(doi)}&format=json&tool=clawstrum${contact}`,
            signal,
          );
          const record = data.records?.[0];
          if (record?.pmcid) {
            if (String(record.doi).toLowerCase() !== doi || !/^PMC\d+$/.test(String(record.pmcid)))
              throw new Error('PMC converter returned a different DOI or invalid PMCID');
            pmcid = String(record.pmcid);
          }
        });
      if (pmcid) candidates.push(...pmcRungs(pmcid, pmcOpenAccess));
    }
    const springer = process.env[config.springerKeyEnv];
    if (springer)
      candidates.push({
        source: 'springer-oa',
        url: `https://api.springernature.com/openaccess/jats?q=${encodeURIComponent(`doi:${doi}`)}&api_key=${encodeURIComponent(springer)}`,
        kind: 'article',
        version: 'publishedVersion',
      });
    else
      result.attempts.push({
        source: 'springer-oa',
        outcome: 'Skipped: no configured optional OA key',
      });
    /* eLife publishes a Reviewed Preprint first, and that version is indexed nowhere the rungs above
     * reach, so a fully open paper otherwise returns no full text. */
    const elife = /^10\.7554\/elife\.(\d+)(?:\.(\d+))?$/i.exec(doi);
    if (elife)
      candidates.push({
        source: 'elife-reviewed-preprint',
        url: `https://api.elifesciences.org/reviewed-preprints/${elife[1]}`,
        kind: 'article',
        versionFrom: (body) => `reviewedPreprint-v${JSON.parse(body).version}`,
        unwrap: (body) => {
          const data = JSON.parse(body);
          if (String(data.id) !== elife[1]) throw new Error('eLife returned a different preprint');
          if (
            !Number.isInteger(data.version) ||
            data.version < 1 ||
            (elife[2] && data.version !== Number(elife[2]))
          )
            throw new Error('eLife latest endpoint does not supply the requested preprint version');
          const content = data.indexContent;
          if (typeof content !== 'string' || !content.trim()) return undefined;
          // indexContent is a search-index field, not a guarantee of a complete paper.
          const headings = [...content.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map((m) =>
            markupText(m[1]!),
          );
          if (
            !headings.some((h) =>
              /\b(introduction|results|methods|materials|discussion|conclusions?)\b/i.test(h),
            )
          )
            throw new Error(
              'eLife search payload has no identifiable article-body sections; metadata only',
            );
          return content;
        },
      });
    /* doi.org and Unpaywall send 10.1101 to www.biorxiv.org, which throttles this host; the details
     * API is another host, knows the latest version and hands out the JATS source. 10.64898 is
     * bioRxiv's newer prefix. */
    if (/^10\.(?:1101|64898)\//.test(doi))
      for (const server of ['biorxiv', 'medrxiv']) {
        const found = await lookup(`${server}-api`, async () => {
          const data = await http.json(`https://api.biorxiv.org/details/${server}/${doi}`, signal);
          const records = (data.collection ?? []).filter(
            (r: any) =>
              String(r.doi).toLowerCase() === doi &&
              Number.isInteger(Number(r.version)) &&
              Number(r.version) >= 1,
          );
          if (!records.length) throw new Error(`No ${server} record for this DOI`);
          const latest = records.reduce((a: any, b: any) =>
            Number(b.version) > Number(a.version) ? b : a,
          );
          if (typeof latest.jatsxml === 'string' && latest.jatsxml)
            candidates.push({
              source: `${server}-jats`,
              url: latest.jatsxml,
              kind: 'article',
              requireBody: true,
              version: 'preprint',
            });
          candidates.push({
            source: `${server}-pdf`,
            url: `https://www.${server}.org/content/${doi}v${Number(latest.version)}.full.pdf`,
            kind: 'pdf',
            version: 'preprint',
          });
          return true;
        });
        if (found) break;
      }
    const osf = /^10\.31234\/osf\.io\/([a-z0-9]{5}(?:_v\d+)?)$/.exec(doi);
    if (osf) await osfRungs(osf[1]!);
    if (config.email)
      await lookup('unpaywall', async () => {
        const data = await http.json(
          `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(config.email!)}`,
          signal,
        );
        if (String(data.doi).toLowerCase() !== doi)
          throw new Error('Unpaywall returned a different DOI');
        const locations = [...(data.oa_locations ?? [])].sort(
          (a, b) => Number(a.host_type !== 'repository') - Number(b.host_type !== 'repository'),
        );
        for (const loc of locations.slice(0, 8))
          if (loc.url_for_pdf || loc.url) {
            const url = loc.url_for_pdf || loc.url;
            const dspace = /^(https?:\/\/[^/]+)\/bitstreams\/([a-f0-9-]{36})\/download\b/i.exec(
              url,
            );
            if (dspace)
              candidates.push({
                source: 'repository-dspace',
                url: `${dspace[1]}/server/api/core/bitstreams/${dspace[2]}/content`,
                kind: 'pdf',
                version: loc.version,
              });
            candidates.push({
              source: `unpaywall-${loc.host_type ?? 'unknown'}`,
              url,
              kind: loc.url_for_pdf ? 'pdf' : 'landing',
              version: loc.version,
            });
          }
      });
    else
      result.attempts.push({
        source: 'unpaywall',
        outcome: 'Skipped: set research.email to identify requests',
      });
    candidates.push({ source: 'doi-landing', url: `https://doi.org/${doi}`, kind: 'landing' });
  };
  /* Strict: a loose title hit would return another paper's text under this one's name. A prefix
   * match is for slugs cut off mid-title, and a short prefix matches too many papers. */
  const titleKey = (s: string) => normalize(s).replace(/ /g, '');
  const titleMatches = (found: string, want: string, prefix: boolean) => {
    const f = titleKey(found);
    const w = titleKey(want);
    return !!f && !!w && (f === w || (prefix && w.length >= 25 && f.startsWith(w)));
  };
  const resolveTitle = async (title: string, prefix: boolean, arxivFirst: boolean) => {
    const words = title.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const arxiv = await lookup('title-arxiv', async () => {
      const response = await http.get(
        `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`ti:"${words}"`)}&max_results=10`,
        5000000,
        signal,
      );
      const hit = [...response.bytes.toString('utf8').matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
        .map(([, entry]) => ({
          id: /<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+?)(?:v\d+)?\s*<\/id>/.exec(entry!)?.[1],
          title: markupText(/<title>([\s\S]*?)<\/title>/.exec(entry!)?.[1] ?? ''),
        }))
        .find((e) => e.id && titleMatches(e.title, title, prefix));
      const parsed = hit && parseCitation(`arxiv:${hit.id}`);
      if (parsed?.kind !== 'arxiv') throw new Error('No exact title match on arXiv');
      result.attempts.push({
        source: 'title-arxiv',
        outcome: `Resolved by title to arXiv:${parsed.id}`,
      });
      return parsed.id;
    });
    const doi = await lookup('title-crossref', async () => {
      const data = await http.json(
        `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(words)}&rows=5&select=DOI,title${config.email ? `&mailto=${encodeURIComponent(config.email)}` : ''}`,
        signal,
      );
      const hit = (data.message?.items ?? []).find((item: any) =>
        titleMatches(String(item.title?.[0] ?? ''), title, prefix),
      );
      const parsed = hit && parseCitation(String(hit.DOI));
      if (parsed?.kind !== 'doi') throw new Error('No exact title match on Crossref');
      result.attempts.push({
        source: 'title-crossref',
        outcome: `Resolved by title to ${parsed.id}`,
      });
      return parsed.id;
    });
    if (arxiv && arxivFirst) candidates.push(...arxivRungs(arxiv));
    if (doi) await doiRungs(doi);
    if (arxiv && !arxivFirst) candidates.push(...arxivRungs(arxiv));
  };
  /* Paid per download, so offered only once every free location has failed, and never below the
   * reserve that keeps the day's budget for search. The key travels only in the header. */
  let openalexRemaining = Infinity;
  const noteRemaining = (headers: Headers) => {
    const value = headers.get('x-ratelimit-remaining-usd')?.trim();
    if (value && Number.isFinite(Number(value))) openalexRemaining = Number(value);
  };
  const belowReserve = () =>
    openalexRemaining < config.openalexReserveUsd
      ? `Skipped: $${openalexRemaining} of OpenAlex budget left, below the $${config.openalexReserveUsd} reserve`
      : undefined;
  const openalexRungs = async (doi: string) => {
    const key = process.env[config.openalexKeyEnv];
    if (!key) {
      result.attempts.push({
        source: 'openalex-content',
        outcome: 'Skipped: no configured OpenAlex key',
      });
      return;
    }
    const headers = { authorization: `Bearer ${key}` };
    await lookup('openalex-content', async () => {
      const response = await http.get(
        `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=id,doi,has_content`,
        5000000,
        signal,
        headers,
      );
      noteRemaining(response.headers);
      let data: any;
      try {
        data = JSON.parse(response.bytes.toString('utf8'));
      } catch {
        throw new Error('Invalid JSON response from api.openalex.org');
      }
      if (
        String(data.doi ?? '')
          .toLowerCase()
          .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '') !== doi
      )
        throw new Error('OpenAlex returned a different DOI');
      const work = String(data.id ?? '')
        .split('/')
        .pop()!;
      if (!/^W\d+$/.test(work)) throw new Error('OpenAlex lookup returned no work ID');
      const skip = belowReserve();
      if (skip) throw new Error(skip);
      const has = data.has_content;
      if (has && !has.grobid_xml && !has.pdf)
        throw new Error('OpenAlex holds no stored content for this work');
      if (!has || has.grobid_xml)
        candidates.push({
          source: 'openalex-grobid-xml',
          url: `https://content.openalex.org/works/${work}.grobid-xml`,
          kind: 'article',
          requireBody: true,
          headers,
          metered: true,
        });
      if (!has || has.pdf)
        candidates.push({
          source: 'openalex-pdf',
          url: `https://content.openalex.org/works/${work}.pdf`,
          kind: 'pdf',
          headers,
          metered: true,
        });
    });
  };
  if (id?.kind === 'arxiv') candidates.push(...arxivRungs(id.id));
  else if (id?.kind === 'doi') await doiRungs(id.id);
  else if (id?.kind === 'pmcid' || id?.kind === 'pmid') {
    let pmcid = id.kind === 'pmcid' ? id.id : undefined;
    let doi: string | undefined;
    if (id.kind === 'pmid') {
      const ids = await lookup('pmc-idconv', async () => {
        const data = await http.json(
          `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${id.id}&format=json&tool=clawstrum${contact}`,
          signal,
        );
        const record = data.records?.[0];
        if (!record || String(record.pmid) !== id.id)
          throw new Error('PMC converter has no record for this PMID');
        if (record.pmcid && !/^PMC\d+$/.test(String(record.pmcid)))
          throw new Error('Invalid PMCID in PMC converter response');
        const registered = record.doi ? parseCitation(String(record.doi)) : undefined;
        const found = {
          pmcid: record.pmcid ? String(record.pmcid) : undefined,
          doi: registered?.kind === 'doi' ? registered.id : undefined,
        };
        if (!found.pmcid && !found.doi) throw new Error('PMID maps to no PMCID or DOI');
        return found;
      });
      pmcid = ids?.pmcid;
      doi = ids?.doi;
    }
    if (pmcid) {
      const record = await lookup('europe-pmc', async () => {
        const data = await http.json(
          `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`PMCID:${pmcid}`)}&format=json&resultType=core`,
          signal,
        );
        const hit = data.resultList?.result?.find(
          (r: any) => String(r.pmcid).toUpperCase() === pmcid,
        );
        if (!hit) throw new Error(`No Europe PMC record for ${pmcid}`);
        const registered = hit.doi ? parseCitation(String(hit.doi)) : undefined;
        return {
          openAccess: hit.isOpenAccess === 'Y',
          doi: registered?.kind === 'doi' ? registered.id : undefined,
        };
      });
      doi ??= record?.doi;
      candidates.push(...pmcRungs(pmcid, record?.openAccess ?? false));
    }
    if (doi) await doiRungs(doi, !!pmcid);
  } else if (id?.kind === 'osf') await osfRungs(id.id);
  else if (id?.kind === 'openreview') {
    /* OpenReview PDFs answer this host with a challenge page, so the route is the arXiv twin. */
    let title: string | undefined;
    for (const host of ['api2.openreview.net', 'api.openreview.net']) {
      title = await lookup('openreview-api', async () => {
        const data = await http.json(
          `https://${host}/notes?id=${encodeURIComponent(id.id)}`,
          signal,
        );
        const note = data.notes?.[0];
        if (!note || note.id !== id.id) throw new Error(`${host} has no note ${id.id}`);
        // api2 wraps every content field as {value}; the v1 API does not.
        const value =
          note.content?.title && typeof note.content.title === 'object'
            ? note.content.title.value
            : note.content?.title;
        if (typeof value !== 'string' || !value.trim())
          throw new Error(`${host} note has no title`);
        return markupText(value);
      });
      if (title) break;
    }
    if (title) await resolveTitle(title, false, true);
    candidates.push({
      source: 'openreview-pdf',
      url: `https://openreview.net/pdf?id=${encodeURIComponent(id.id)}`,
      kind: 'pdf',
    });
  } else {
    const url = rawUrl!;
    /* ResearchGate refuses automated clients, but its URL slug is the title, cut off. */
    const researchgate =
      /^(?:www\.)?researchgate\.net$/i.test(url.hostname) &&
      /^\/(?:profile\/[^/]+\/)?publication\/\d+_([^/]+)/.exec(url.pathname);
    if (researchgate) {
      let slug = researchgate[1]!;
      try {
        slug = decodeURIComponent(slug);
      } catch {
        /* keep the raw slug */
      }
      await resolveTitle(slug.replace(/_+/g, ' ').trim(), true, false);
    } else
      candidates.push({
        source: 'given-url',
        url: url.href,
        kind: /\.pdf$/i.test(url.pathname) ? 'pdf' : 'landing',
      });
  }
  const seen = new Set<string>();
  let paidOffered = false;
  for (let index = 0; ; index++) {
    signal?.throwIfAborted();
    if (index >= candidates.length) {
      if (paidOffered || !ladderDoi) break;
      paidOffered = true;
      await openalexRungs(ladderDoi);
      if (index >= candidates.length) break;
    }
    const candidate = candidates[index]!;
    if (index >= 20 && !candidate.metered) {
      if (ladderDoi && !paidOffered)
        result.attempts.push({
          source: 'openalex-content',
          outcome: 'Skipped: candidate limit reached before every free location was tried',
        });
      break;
    }
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    let namedTitle: string | undefined;
    try {
      const skip = candidate.metered ? belowReserve() : undefined;
      if (skip) throw new Error(skip);
      const response = await http.get(
        candidate.url,
        config.maxDownloadBytes,
        signal,
        candidate.headers,
      );
      if (candidate.metered) noteRemaining(response.headers);
      const pdf = response.bytes.subarray(0, 5).toString() === '%PDF-';
      if (
        pdf &&
        candidate.metered &&
        !response.bytes.subarray(-2048).toString('latin1').includes('%%EOF')
      )
        throw new Error('PDF has no %%EOF trailer; truncated download');
      const body = pdf ? '' : response.bytes.toString('utf8');
      if (
        /Just a moment|Making sure you're not a bot|Enable JavaScript and cookies|cf-browser-verification/i.test(
          body,
        )
      )
        throw new Error('Challenge page, not article text');
      if (!pdf && candidate.kind === 'pdf')
        throw new Error('Expected PDF; server returned another format');
      if (!pdf && candidate.kind === 'landing') {
        const pdfMeta = meta(body, 'citation_pdf_url')[0];
        const link =
          pdfMeta ??
          [...body.matchAll(/href\s*=\s*["']([^"']+)["']/gi)]
            .map((m) => decodeEntities(m[1]!))
            .find((h) => /\.pdf(?:\?|$)|\/document$|\/bitstreams\//i.test(h));
        /* A page that names its paper can still be found open elsewhere under that title. */
        if (!link && candidate.source === 'given-url') namedTitle = meta(body, 'citation_title')[0];
        if (link)
          candidates.splice(index + 1, 0, {
            ...candidate,
            url: new URL(link, response.url).href,
            kind: 'pdf',
            source: `${candidate.source}-pdf`,
          });
        throw new Error(
          link
            ? 'Landing page; following its PDF link'
            : 'Landing page without a PDF link; not accepted as full text',
        );
      }
      let markup = body;
      if (!pdf && candidate.unwrap) {
        const inner = candidate.unwrap(body);
        if (!inner) throw new Error('API response carried no article payload');
        markup = inner;
      }
      const articleBody = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(markup)?.[1];
      if (!pdf && candidate.requireBody && articleBody === undefined)
        throw new Error('Structured record with no article body; metadata only, not full text');
      if (!pdf && candidate.requireBody && ladderDoi) {
        const front = /<front\b[^>]*>([\s\S]*?)<\/front>/i.exec(markup)?.[1] ?? '';
        const doi =
          /<article-id\b[^>]*pub-id-type\s*=\s*["']doi["'][^>]*>([\s\S]*?)<\/article-id>/i.exec(
            front,
          )?.[1];
        if (doi && markupText(doi).trim().toLowerCase() !== ladderDoi)
          throw new Error('PMC article returned a different DOI');
      }
      /* An unwrapped envelope has already identified its payload, and minTextChars stays the floor. */
      if (
        !pdf &&
        !candidate.unwrap &&
        !/<article\b|<TEI\b|class=["'][^"']*ltx_document/i.test(markup)
      )
        throw new Error('No article body in markup');
      const documentPath = path.join(
        dir,
        `${randomUUID()}.${pdf ? 'pdf' : candidate.unwrap ? 'json' : 'xml'}`,
      );
      fs.writeFileSync(documentPath, response.bytes, { mode: 0o600, flag: 'wx' });
      let text: string;
      let layoutTextPath: string | undefined;
      let layoutTextHash: string | undefined;
      if (pdf) {
        const tmp = documentPath + '.txt';
        try {
          // Poppler attempts reading order by default; extraction still requires source checking.
          text = await pdfToText(config, [], documentPath, tmp, signal);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
        // Keep a separate physical-layout copy for inspecting tables, without failing valid prose.
        const layout = path.join(dir, `${randomUUID()}.layout.txt`);
        try {
          const layoutText = await pdfToText(config, ['-layout'], documentPath, layout, signal);
          layoutTextPath = layout;
          layoutTextHash = createHash('sha256').update(layoutText).digest('hex');
        } catch {
          fs.rmSync(layout, { force: true });
          signal?.throwIfAborted();
        }
      } else text = markupText(articleBody ?? markup);
      if (text.trim().length < config.minTextChars)
        throw new Error(
          `Only ${text.trim().length} extracted characters; text may be a stub or scanned PDF`,
        );
      const textPath = path.join(dir, `${randomUUID()}.txt`);
      writePrivate(textPath, text);
      Object.assign(result, {
        status: 'ok',
        source: candidate.source,
        url: publicUrl(response.url),
        version: candidate.versionFrom?.(body) ?? candidate.version ?? 'unknown',
        retrievalVersion: STRUCTURED_RETRIEVAL,
        textPath,
        documentPath,
        chars: text.length,
        textHash: createHash('sha256').update(text).digest('hex'),
        ...(pdf ? { pdfExtraction: PDF_EXTRACTION } : {}),
        ...(layoutTextPath ? { layoutTextPath, layoutTextHash, layoutNote: LAYOUT_NOTE } : {}),
      });
      result.attempts.push({
        source: candidate.source,
        outcome: `Extracted ${text.length} characters`,
      });
      break;
    } catch (e) {
      signal?.throwIfAborted();
      result.attempts.push({ source: candidate.source, outcome: String(e).slice(0, 500) });
    }
    if (namedTitle) await resolveTitle(markupText(namedTitle), false, false);
  }
  writePrivate(manifestPath, JSON.stringify(result, null, 2));
  return result;
}
