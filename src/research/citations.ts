import fs from 'node:fs';
import { previewEdit } from './edits.js';
import type { Store } from '../store.js';
import { citationOccurrences, citationRecord, checkCitation, parseCitation } from './literature.js';

export const citationDocumentLimit = 2_000_000;
export const citationDocumentPath = (file: string) => /\.(?:md|markdown|tex|bib|rst)$/i.test(file);
export function readCitationDocument(file: string): string {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Citation scan requires a regular file');
  if (stat.size > citationDocumentLimit)
    throw new Error(
      `Citation scan accepts documents up to ${citationDocumentLimit} bytes; scan a relevant excerpt with text instead`,
    );
  const bytes = fs.readFileSync(file);
  if (bytes.length > citationDocumentLimit)
    throw new Error('Document grew beyond citation scan limit');
  return bytes.toString('utf8');
}
export interface CitationFinding {
  key: string;
  line: number;
  kind: 'unresolved' | 'attribution';
  message: string;
}
export interface CitationScan {
  ok: boolean;
  identifiers: number;
  attributionsChecked: number;
  ambiguous: number;
  findings: CitationFinding[];
  scope: string;
}
interface Claim {
  start: number;
  end: number;
  authors: string[];
  year: number;
}
// Deliberately limited to explicit author–year forms. Do not infer an author
// from arbitrary nearby capitalized words or independently borrow a nearby year.
function proseClaims(text: string): Claim[] {
  const name =
    "(?:(?:van|von|de|del|da|di|der|den|la|le)\\s+){0,4}[\\p{Lu}][\\p{L}\\p{M}'’-]{1,80}";
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{M}])(${name})(?:\\s+(?:&|and)\\s+(${name})|\\s+et\\s+al\\.?)?(?:,\\s*(?:\\p{Lu}\\.\\s*){1,4})?\\s*(?:\\(\\s*|,\\s*)((?:18|19|20)\\d{2})[a-z]?\\s*\\)`,
    'gu',
  );
  return [...text.matchAll(pattern)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    authors: [m[1]!, ...(m[2] ? [m[2]] : [])],
    year: Number(m[3]),
  }));
}
function mask(text: string) {
  return text.replace(/[^\n]/g, ' ');
}
function maskExamples(text: string): string {
  let fence: string | undefined;
  return text
    .split('\n')
    .map((line) => {
      const marker = line.match(/^[ \t]*(`{3,}|~{3,})/);
      if (fence) {
        if (
          marker &&
          marker[1]![0] === fence[0] &&
          marker[1]!.length >= fence.length &&
          !line.slice(marker[0].length).trim()
        )
          fence = undefined;
        return mask(line);
      }
      if (marker) {
        fence = marker[1]!;
        return mask(line);
      }
      return line;
    })
    .join('\n');
}
// Read a balanced BibTeX value/entry, retaining nested title braces and quoted commas.
function balanced(text: string, start: number, entry = false): number {
  const close = text[start] === '{' ? '}' : ')';
  let depth = 1;
  let quoted = false;
  let braces = 0;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (entry && depth === 1 && braces === 0 && text[i] === '"') quoted = !quoted;
    if (quoted) continue;
    if (close === ')') {
      if (text[i] === '{') braces++;
      if (text[i] === '}') braces--;
      if (braces || text[i] === '}') continue;
    }
    if (text[i] === text[start]) depth++;
    if (text[i] === close && --depth === 0) return i + 1;
  }
  return text.length;
}
function bibFields(entry: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /(?:^|,)\s*([a-z]+)\s*=\s*/gi;
  for (let m; (m = pattern.exec(entry)); ) {
    const start = pattern.lastIndex;
    let end = start;
    if (entry[start] === '{') end = balanced(entry, start);
    else if (entry[start] === '"') {
      for (end = start + 1; end < entry.length; end++) {
        if (entry[end] === '\\') end++;
        else if (entry[end] === '"') {
          end++;
          break;
        }
      }
    } else {
      while (end < entry.length && !/[,})\n]/.test(entry[end]!)) end++;
    }
    let value = entry.slice(start, end).trim();
    if (value.startsWith('{') || value.startsWith('"')) value = value.slice(1, -1);
    // Bare macros and concatenated values need a BibTeX evaluator; do not
    // compare their literal spelling with resolved publication metadata.
    if ((/[{"]/.test(entry[start] ?? '') || /^\d+$/.test(value)) && !/^\s*#/.test(entry.slice(end)))
      fields[m[1]!.toLowerCase()] = value;
    pattern.lastIndex = end;
  }
  return fields;
}
/** Local metadata consistency only; an ambiguous or unrecognized attribution is not verified. */
export function scanCitations(store: Store, text: string): CitationScan {
  if (Buffer.byteLength(text) > citationDocumentLimit)
    throw new Error('Citation text exceeds the 2 MB scan limit');
  // Fenced examples/logs are not publication claims. Keep offsets/line numbers stable.
  const visible = maskExamples(text);
  const refs = citationOccurrences(visible);
  const findings: CitationFinding[] = [];
  let attributionsChecked = 0;
  let ambiguous = 0;
  const lines = [0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)];
  const line = (index: number) => {
    let low = 0,
      high = lines.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lines[middle]! <= index) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  function check(
    key: string,
    index: number,
    claim: { authors?: string[]; year?: number; title?: string },
    proseClaim = false,
  ) {
    const record = citationRecord(store, key);
    if (!record || (!claim.authors?.length && !claim.year && !claim.title)) return;
    attributionsChecked++;
    const result = checkCitation(store, {
      id: key,
      ...claim,
      authors: proseClaim ? undefined : claim.authors,
    });
    if (proseClaim) {
      const normalizeName = (s: string) =>
        s
          .normalize('NFKD')
          .replace(/\p{M}/gu, '')
          .toLowerCase()
          .replace(/ß/g, 'ss')
          .replace(/ø/g, 'o')
          .replace(/ł/g, 'l')
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .trim();
      for (const name of claim.authors ?? []) {
        if (
          !record.authors.some((a) =>
            ` ${normalizeName(a.includes(',') ? a.split(',').reverse().join(' ') : a)}`.endsWith(
              ` ${normalizeName(name)}`,
            ),
          )
        )
          result.issues.push(`Author surname absent from registry: ${name}`);
      }
    }
    if (result.issues.length)
      findings.push({
        key,
        line: line(index),
        kind: 'attribution',
        message: `${key}: ${result.issues.join('; ')}. Registry metadata: ${record.authors.join(', ')} (${record.year ?? 'year unavailable'}), ${record.title}. Compare the saved source response; registry/preprint metadata can differ.`,
      });
  }
  let prose = visible;
  const entryPattern =
    /@(?:article|book|inproceedings|incollection|proceedings|misc|techreport|phdthesis|mastersthesis|unpublished|online|report)\s*[{(]/gi;
  for (let m; (m = entryPattern.exec(visible)); ) {
    const end = balanced(visible, entryPattern.lastIndex - 1, true);
    const entry = visible.slice(m.index, end);
    const fields = bibFields(entry);
    const ids = [...new Set(citationOccurrences(entry).map((r) => r.key))];
    if (/^arxiv$/i.test(fields.archiveprefix ?? fields.eprinttype ?? '')) {
      const eprint = parseCitation(fields.eprint ?? '');
      if (eprint?.kind === 'arxiv' && !ids.includes(eprint.key)) {
        ids.push(eprint.key);
        refs.push({ ...eprint, index: m.index, end });
      }
    }
    if (ids.length === 1) {
      const plain = (value: string | undefined) =>
        value && !value.includes('\\') ? value.replace(/[{}]/g, '') : undefined;
      const authors = plain(fields.author)
        ?.split(/\s+and\s+/i)
        .filter((a) => a.trim() !== 'others')
        .map((a) => (a.includes(',') ? a.split(',')[0]!.trim() : a.trim().split(/\s+/).at(-1)!));
      check(
        ids[0]!,
        m.index,
        {
          authors,
          year: /^\d{4}$/.test(fields.year ?? '') ? Number(fields.year) : undefined,
          title: plain(fields.title),
        },
        true,
      );
    } else if (ids.length > 1) ambiguous++;
    prose = prose.slice(0, m.index) + mask(entry) + prose.slice(end);
    entryPattern.lastIndex = end;
  }
  // Associate within one line/semicolon-delimited unit. Prefer the identifier
  // following the claim; a preceding identifier is accepted only for a sole pair.
  // Never choose a different nearby paper to make an attribution pass.
  for (const unit of prose.matchAll(/[^\n;]+/g)) {
    const unitRefs = citationOccurrences(unit[0]);
    const claims = proseClaims(unit[0]);
    const pairs = new Map<number, Claim[]>();
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i]!;
      const candidates = unitRefs.filter(
        (r) =>
          r.index >= claim.end &&
          r.index - claim.end <= 240 &&
          r.index < (claims[i + 1]?.start ?? Infinity),
      );
      if (new Set(candidates.map((r) => r.key)).size > 1) {
        ambiguous++;
        continue;
      }
      let ref = candidates[0];
      if (
        !ref &&
        claims.length === 1 &&
        unitRefs.length === 1 &&
        claim.start >= unitRefs[0]!.end &&
        claim.start - unitRefs[0]!.end <= 240
      )
        ref = unitRefs[0];
      if (ref) pairs.set(ref.index, [...(pairs.get(ref.index) ?? []), claim]);
      else if (unitRefs.length) ambiguous++;
    }
    for (const ref of unitRefs) {
      const associated = pairs.get(ref.index) ?? [];
      if (associated.length > 1) {
        ambiguous++;
        continue;
      }
      if (associated.length === 1)
        check(ref.key, unit.index + associated[0]!.start, associated[0]!, true);
    }
  }
  for (const ref of refs)
    if (!citationRecord(store, ref.key))
      findings.push({
        key: ref.key,
        line: line(ref.index),
        kind: 'unresolved',
        message: `${ref.key} has no verified registry record. Use research_citation action=verify; metadata verification alone does not validate the scientific claim.`,
      });
  return {
    ok: findings.length === 0,
    identifiers: refs.length,
    attributionsChecked,
    ambiguous,
    findings,
    scope:
      'Local registry metadata consistency for recognized author–year forms and plain BibTeX fields. Years allow ±1. Fenced examples, ambiguous associations and unrecognized/TeX-encoded claims are not verified. No scientific-claim, retraction or quotation validation.',
  };
}

/** Preview Edit's full result so changing a year beside an unchanged DOI is checked. */
export function scanCitationWrite(
  store: Store,
  tool: string,
  input: Record<string, any>,
): CitationScan | undefined {
  const file = String(input.file_path ?? '');
  if (!citationDocumentPath(file)) return;
  let text: string;
  if (tool === 'Write' && typeof input.content === 'string') text = input.content;
  else if (
    tool === 'Edit' &&
    typeof input.old_string === 'string' &&
    typeof input.new_string === 'string'
  ) {
    try {
      text = readCitationDocument(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const original = text;
    const edited = previewEdit(text, input);
    if (edited === undefined) return;
    text = edited;
    // Do not turn an unrelated edit into a backfill of all legacy references.
    const previous = scanCitations(store, original);
    const scan = scanCitations(store, text);
    const prior = new Map<string, number>();
    for (const f of previous.findings) {
      const key = `${f.key}:${f.message}`;
      prior.set(key, (prior.get(key) ?? 0) + 1);
    }
    scan.findings = scan.findings.filter((f) => {
      const key = `${f.key}:${f.message}`;
      const remaining = prior.get(key) ?? 0;
      if (remaining) prior.set(key, remaining - 1);
      return remaining === 0;
    });
    scan.ok = !scan.findings.length;
    return scan;
  } else return;
  return scanCitations(store, text);
}
