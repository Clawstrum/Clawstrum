import fs from 'node:fs';

export interface FigureFinding {
  line: number;
  code: string;
  message: string;
}
/**
 * Python figure code carries the same class of mistake as a batch script: accepted at authoring
 * time, only revealed once the figure is looked at, or, on a headless cluster node, never produced
 * at all. Same posture as `scriptIssues` in `src/research/cluster.ts`: advisory, no gate.
 */
const AXES_CREATE = /\b(?:plt\.subplots\(|add_subplot\(|plt\.gca\(|plt\.figure\()/;
const PLOT_CALL = /\.(?:plot|scatter|imshow|bar|hist|errorbar|pcolormesh|contourf)\(/;
const LABEL_CALL =
  /\b(?:set_xlabel\(|set_ylabel\(|plt\.xlabel\(|plt\.ylabel\(|set\([^)]*\b[xy]label\s*=)/;
const RAINBOW_NAMES = ['jet', 'rainbow', 'gist_rainbow', 'hsv', 'nipy_spectral', 'Spectral'];
const RAINBOW = new RegExp(
  `(?:cmap\\s*=|set_cmap\\(|colormap\\s*=)\\s*(['"])(?:${RAINBOW_NAMES.join('|')})(?:_r)?\\1`,
);
const LOOP_HEADER = /^(\s*)(?:for|while)\b.*:\s*$/;
const FIGURE_OPEN = /\b(?:plt\.figure\(|plt\.subplots\()/;
const TINY_FONT_KWARG = /set_\w+\([^()]*\b(fontsize|labelsize|size)\s*=\s*(\d+(?:\.\d+)?)/g;
const TINY_FONT_KEY =
  /['"](font\.size|axes\.labelsize|xtick\.labelsize|ytick\.labelsize|legend\.fontsize|axes\.titlesize)['"]\s*(?:\]\s*=|:)\s*(\d+(?:\.\d+)?)/g;

/** Naive comment strip; does not track triple-quoted strings across lines, which is acceptable here. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}
export function lintFigures(source: string): FigureFinding[] {
  const findings: FigureFinding[] = [];
  const rawLines = source.split(/\r?\n/);
  const lines = rawLines.map(stripComment);
  const whole = lines.join('\n');

  if (AXES_CREATE.test(whole) && PLOT_CALL.test(whole) && !LABEL_CALL.test(whole))
    findings.push({
      line: 0,
      code: 'unlabeled-axes',
      message: 'No axis labels anywhere in this file; a reader cannot tell what is plotted.',
    });

  if (/\bplt\.show\(/.test(whole) && !/\bsavefig\(/.test(whole))
    findings.push({
      line: 0,
      code: 'show-without-save',
      message: 'plt.show() with no savefig; on a headless node this produces no artifact at all.',
    });

  const closesFigures = /\.close\(/.test(whole);

  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const rainbow = RAINBOW.exec(line);
    if (rainbow)
      findings.push({
        line: number,
        code: 'rainbow-colormap',
        message:
          'Rainbow colormap for sequential data misorders perceived magnitude; use viridis or a single-hue gradient.',
      });

    const header = LOOP_HEADER.exec(line);
    if (header && !closesFigures) {
      const headerIndent = header[1]!.length;
      let opensFigure = false;
      for (let j = index + 1; j < lines.length; j++) {
        if (lines[j]!.trim() === '') continue;
        const bodyIndent = rawLines[j]!.length - rawLines[j]!.trimStart().length;
        if (bodyIndent <= headerIndent) break;
        if (FIGURE_OPEN.test(lines[j]!)) {
          opensFigure = true;
          break;
        }
      }
      if (opensFigure)
        findings.push({
          line: number,
          code: 'unclosed-figure-in-loop',
          message:
            'Figure opened inside a loop and never closed; matplotlib keeps every one of them alive.',
        });
    }

    for (const match of line.matchAll(TINY_FONT_KWARG)) {
      const value = Number(match[2]);
      if (value < 8)
        findings.push({
          line: number,
          code: 'tiny-font',
          message: `Font size ${match[2]} is below 8pt and will not be legible at print size.`,
        });
    }
    for (const match of line.matchAll(TINY_FONT_KEY)) {
      const value = Number(match[2]);
      if (value < 8)
        findings.push({
          line: number,
          code: 'tiny-font',
          message: `Font size ${match[2]} is below 8pt and will not be legible at print size.`,
        });
    }
  }
  return findings;
}
export function lintFigureFile(file: string): FigureFinding[] {
  return lintFigures(fs.readFileSync(file, 'utf8'));
}
