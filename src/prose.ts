import fs from 'node:fs';

export interface ProseFinding {
  line: number;
  code: string;
  message: string;
}
/**
 * `src/research/writing.ts` refuses a manuscript write citing em dashes, bold used as emphasis,
 * and headings that argue instead of naming — but nothing measures those three. This does. It is
 * advisory and imposes no gate. These three checks and no others: no opinions of this module's own
 * about adverbs, passive voice, sentence length or word choice. Preferences belong in the
 * operator's rules file, not here.
 */
const HEADING_KEYWORDS =
  /\b(is|are|was|were|be|been|can|could|should|must|may|might|does|do|did|has|have|had|shows|show|showed|why|how|we|our|i)\b/i;
const RULE_OR_SEPARATOR = /^[\s|:-]+$/;
const BOLD = /\*\*[^\s*](?:[^*]*?[^\s*])?\*\*|\\textbf\{[^}]*\}|\{\\bf\s+[^}]*\}/;
export function lintProse(text: string): ProseFinding[] {
  const findings: ProseFinding[] = [];
  let fence = '';
  let latexEnv = '';
  let frontMatter = text.startsWith('---');
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const number = index + 1;
    if (frontMatter) {
      if (number > 1 && line.trim() === '---') frontMatter = false;
      continue;
    }
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      continue;
    }
    if (fence) continue;
    if (latexEnv) {
      if (new RegExp(`\\\\end\\{${latexEnv}\\}`).test(line)) latexEnv = '';
      continue;
    }
    const envStart = /\\begin\{(verbatim|lstlisting|minted|Verbatim)\}/.exec(line);
    if (envStart) {
      latexEnv = envStart[1]!;
      continue;
    }
    if (/^\s*%/.test(line)) continue;
    const emDashCount = (line.match(/—/g) ?? []).length;
    const hyphenConnective = /-{3,}/.test(line) && !RULE_OR_SEPARATOR.test(line);
    if (emDashCount || hyphenConnective) {
      const count = emDashCount || 1;
      findings.push({
        line: number,
        code: 'em-dash',
        message:
          count > 1
            ? `Em dash used as a connective (${count} on this line); recast the sentence or use a comma, colon, or parentheses.`
            : 'Em dash used as a connective; recast the sentence or use a comma, colon, or parentheses.',
      });
    }
    const boldMatch = BOLD.exec(line);
    if (boldMatch && line.slice(0, boldMatch.index).trim() !== '')
      findings.push({
        line: number,
        code: 'bold-emphasis',
        message:
          'Bold used as emphasis inside a sentence; carry the emphasis in the sentence structure.',
      });
    const headingMatch =
      /^#{1,6}\s+(.+)/.exec(line) ??
      /\\(?:sub){0,2}section\*?\{([^}]*)\}/.exec(line) ??
      /\\(?:chapter|paragraph)\*?\{([^}]*)\}/.exec(line);
    if (headingMatch) {
      const heading = headingMatch[1]!.trim();
      // Closed keyword list, deliberately crude: it catches verb-led argumentative headings, not
      // every possible claim. Advisory for exactly that reason.
      if (HEADING_KEYWORDS.test(heading) || /[.?]$/.test(heading))
        findings.push({
          line: number,
          code: 'heading-claim',
          message: 'Heading argues rather than names; use a noun phrase.',
        });
    }
  }
  return findings;
}
export function lintProseFile(file: string): ProseFinding[] {
  return lintProse(fs.readFileSync(file, 'utf8'));
}
