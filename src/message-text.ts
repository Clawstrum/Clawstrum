/** Repair model-generated escaped paragraph separators in prose, without applying
 * a general escape decoder to code, quoted strings, paths or literal examples.
 * Single escaped newlines remain ambiguous and are deliberately left alone.
 * Optional plain dashes use the same protected-literal scan and never consume newlines.
 */
export function normalizeMessageText(text: string, plainDashes = false): string {
  const tokens =
    /`+|~{3,}|^ {4}[^\n]*|^\t[^\n]*|"(?:\\.|[^"\\\n])*"|(?<![\p{L}\p{N}])'(?:\\.|[^'\\\n])*'|(?:\b[A-Za-z]:\\|(?<!\S)\\\\|[a-z][a-z0-9+.-]*:\/\/|(?<!\S)(?:\/|\.{1,2}\/))[^\s<>"`]+|(?:\\{1,2}(?:r\\{1,2})?n){2,}|[ \t]*[–—―][ \t]*/gmu;
  let result = '';
  let copied = 0;
  for (let match; (match = tokens.exec(text)); ) {
    const value = match[0];
    const start = match.index;
    if (/^[`~]+$/.test(value)) {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const fence = value.length >= 3 && /^ {0,3}$/.test(text.slice(lineStart, start));
      const closing = fence
        ? new RegExp(`^ {0,3}${value[0]}{${value.length},}[ \\t]*\\r?$`, 'gm')
        : new RegExp(`${value[0]}+`, 'g');
      closing.lastIndex = tokens.lastIndex;
      let end = text.length;
      for (let candidate; (candidate = closing.exec(text)); ) {
        if (fence || candidate[0].length === value.length) {
          end = closing.lastIndex;
          break;
        }
      }
      tokens.lastIndex = end;
      continue;
    }
    if (/^[ \t]*[–—―][ \t]*$/.test(value)) {
      if (plainDashes) {
        const range =
          value.includes('–') &&
          /\d/.test(text[start - 1] ?? '') &&
          /\d/.test(text[tokens.lastIndex] ?? '');
        result += text.slice(copied, start) + (range ? '-' : ' - ');
        copied = tokens.lastIndex;
      }
      continue;
    }
    if (!/^(?:\\{1,2}(?:r\\{1,2})?n){2,}$/.test(value)) continue;
    // A standalone spelling such as "prints \\n\\n literally" is an example.
    if (
      (start === 0 || /\s/.test(text[start - 1]!)) &&
      (tokens.lastIndex === text.length || /\s/.test(text[tokens.lastIndex]!))
    )
      continue;
    result += text.slice(copied, start) + value.replace(/\\{1,2}(?:r\\{1,2})?n/g, '\n');
    copied = tokens.lastIndex;
  }
  return result + text.slice(copied);
}
/** The bare silence marker is a control line, never a chat message. Preserve quoted/code
 * examples and inline discussion, so users can still ask what the protocol means. */
export function stripQuietMarker(text: string): string {
  let fence: { marker: string; length: number } | undefined;
  return text
    .split('\n')
    .filter((line) => {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (match) {
        if (!fence) fence = { marker: match[1]![0]!, length: match[1]!.length };
        else if (
          match[1]![0] === fence.marker &&
          match[1]!.length >= fence.length &&
          !match[2]!.trim()
        )
          fence = undefined;
        return true;
      }
      return !!fence || line.trim() !== 'CLAWSTRUM_QUIET';
    })
    .join('\n');
}
