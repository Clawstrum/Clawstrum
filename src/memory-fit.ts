import { headings } from './memory.js';

/** Sections of a MEMORY body in the order they are kept when the body does not fit. The newest
 * state comes first: a native session that starts fresh must see the last compaction summary, the
 * open work and the people's own decisions before any older background. Everything else is kept
 * after these, later parts of the file before earlier parts. */
const INTRODUCTION = 'MEMORY introduction';
const DECISIONS_HEADING = 'Decisions the people here stated';
const PRIORITY: Array<(label: string) => boolean> = [
  (l) => l === 'Last compaction summary',
  (l) => l === 'Current work',
  (l) => l === DECISIONS_HEADING,
  (l) => l === 'Working understanding',
  (l) => l.startsWith('Research state'),
];

interface Segment {
  start: number;
  end: number;
  priority: number;
  label: string;
  /** The segment begins with its own heading line, which is always kept. */
  headed: boolean;
}

/** One-line note left where text was cut. A section is cut from its start and keeps its end: lines
 * are added at the end of a section (the decisions block says "Newest last"; notes and findings
 * are appended), so the end is the newest text. */
function cutNote(label: string, cut: number, total: number, file: string, side = 'oldest'): string {
  const what = cut > 0 ? `the ${side} ${cut} of ${total} characters` : `all ${total} characters`;
  return `[Cut to fit the memory budget: ${what} of "${label}" are omitted. Read the full text in ${file}.]\n`;
}

function segments(body: string): Segment[] {
  const marks = headings(body);
  const level3 = marks.filter((h) => h.level === 3);
  const result: Segment[] = [];
  const add = (start: number, end: number, label: string, headed: boolean) => {
    if (end <= start) return;
    const priority = PRIORITY.findIndex((match) => match(label));
    result.push({ start, end, priority: priority < 0 ? PRIORITY.length : priority, label, headed });
  };
  add(0, level3[0]?.start ?? body.length, INTRODUCTION, false);
  level3.forEach((h, i) => {
    const end = level3[i + 1]?.start ?? body.length;
    // The harness-saved decisions block sits inside Research state but must outrank it.
    const decisions = marks.find(
      (m) =>
        m.level === 4 && m.start > h.start && m.start < end && m.name.startsWith(DECISIONS_HEADING),
    );
    if (!decisions) return add(h.start, end, h.name, true);
    const after = marks.find((m) => m.start > decisions.start && m.start < end && m.level <= 4);
    const decisionsEnd = after?.start ?? end;
    add(h.start, decisions.start, h.name, true);
    add(decisions.start, decisionsEnd, DECISIONS_HEADING, true);
    add(decisionsEnd, end, `${h.name} (after the decisions block)`, false);
  });
  return result;
}

/**
 * Fit one memory document into `limit` characters. A document that already fits is returned
 * unchanged, byte for byte. Otherwise its sections are kept whole in priority order (last
 * compaction summary, Current work, the harness decisions block, Working understanding, Research
 * state, the rest); the first section that does not fit keeps its newest part, and every section
 * that is cut or dropped leaves a one-line note with the file to read.
 */
export function fitMemoryDocument(text: string, limit: number, file: string): string {
  if (text.length <= limit) return text;
  const prefix = /^Current memory \([^\n]*\n/.exec(text)?.[0] ?? '';
  const body = text.slice(prefix.length);
  const parts = segments(body);
  const fallback = () => {
    const marker = `\n[Excerpt truncated; read ${file} for the full text.]\n`;
    return limit > marker.length
      ? text.slice(0, limit - marker.length) + marker
      : text.slice(0, limit);
  };
  if (!parts.length) return fallback();
  const headline = (s: Segment) => {
    if (!s.headed) return '';
    const nl = body.indexOf('\n', s.start);
    const line = body.slice(s.start, nl < 0 || nl >= s.end ? s.end : nl + 1).slice(0, 160);
    return line.endsWith('\n') ? line : line + '\n';
  };
  const noteOnly = (s: Segment) =>
    headline(s) + cutNote(s.label.slice(0, 60), 0, s.end - s.start, file);
  const floor = (s: Segment) => noteOnly(s).length;
  let remaining = limit - prefix.length;
  if (remaining < parts.reduce((sum, s) => sum + floor(s), 0)) return fallback();
  const order = parts
    .map((s, index) => ({ s, index }))
    .sort((a, b) => a.s.priority - b.s.priority || b.index - a.index);
  const rendered = new Map<number, string>();
  let reserve = parts.reduce((sum, s) => sum + floor(s), 0);
  for (const { s, index } of order) {
    reserve -= floor(s);
    const size = s.end - s.start;
    const room = remaining - reserve;
    let piece: string;
    if (size <= room) piece = body.slice(s.start, s.end);
    else {
      const head = headline(s);
      const label = s.label.slice(0, 60);
      // The note length is fixed by the label and file; the number of cut characters has at most
      // as many digits as the section size, so measure with the size as an upper bound.
      const overhead = head.length + cutNote(label, size, size, file).length;
      const keep = room - overhead;
      if (keep < 200) piece = noteOnly(s);
      else {
        const contentStart = s.start + head.length;
        if (s.label === INTRODUCTION) {
          // Text before the first section (or a MEMORY with no sections) is free-form: its meaning
          // is at the start, so it keeps its start and loses its end.
          let to = s.start + keep;
          const lineEnd = body.lastIndexOf('\n', to);
          if (lineEnd > s.start + keep * 0.8) to = lineEnd + 1;
          piece = body.slice(s.start, to) + cutNote(label, s.end - to, size, file, 'last');
        } else {
          let from = Math.max(contentStart, s.end - keep);
          // Start on a line boundary; prefer a heading inside the first fifth of what is kept so a
          // block is not left without its title.
          const lineStart = body.indexOf('\n', from - 1) + 1;
          if (lineStart > 0 && lineStart < s.end && lineStart - from <= keep * 0.2)
            from = lineStart;
          const snap = /^#{1,6} /m.exec(body.slice(from, s.end));
          if (snap && snap.index <= keep / 5) from += snap.index;
          piece =
            head +
            cutNote(label, from - contentStart, size - head.length, file) +
            body.slice(from, s.end);
        }
      }
    }
    remaining -= piece.length;
    rendered.set(index, piece);
  }
  const result = prefix + parts.map((_, i) => rendered.get(i)!).join('');
  // Bytes outside any segment (none today, segments are contiguous) must not be silently lost.
  return result.length <= limit ? result : fallback();
}

/** Split `room` between documents: a document smaller than its equal share keeps all of it and the
 * unused space goes to the larger ones. */
export function allocateMemoryShares(sizes: number[], room: number): number[] {
  const shares = sizes.map(() => 0);
  let left = Math.max(0, room);
  const order = sizes.map((size, i) => ({ size, i })).sort((a, b) => a.size - b.size);
  order.forEach(({ size, i }, n) => {
    const share = Math.min(size, Math.floor(left / (order.length - n)));
    shares[i] = share;
    left -= share;
  });
  return shares;
}
