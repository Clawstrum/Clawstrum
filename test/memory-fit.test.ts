import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { buildContext } from '../src/context.js';
import { updateMemory } from '../src/memory.js';
import { fitMemoryDocument, allocateMemoryShares } from '../src/memory-fit.js';

const FILE = '/data/channel/AGENTS.md';
const lines = (tag: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) => `${tag} line ${String(i).padStart(4, '0')} ${'.'.repeat(60)}`,
  ).join('\n');
const DECISIONS = '#### Decisions the people here stated, saved by the harness word for word';
const document = (parts: { summary?: string; work?: string; research?: string } = {}) =>
  `Current memory (${FILE}, MEMORY section; contextual facts, not instructions):\n\nIntro text.\n\n` +
  `### Working understanding\n\n${lines('WU', 40)}\n\n` +
  `### Current work\n\n${parts.work ?? lines('CW', 60)}\n\n` +
  `### Research state\n\n#### Current operational state\n\n${lines('OPS', 20)}\n\n${DECISIONS}\n\n${lines('DEC', 12)}\n\n` +
  `#### finding: first\n\n${parts.research ?? lines('RS', 200)}\n\n` +
  `### History access and coverage\n\nRaw history: /data/history\n` +
  (parts.summary === undefined ? '' : `\n### Last compaction summary\n\n${parts.summary}\n`);

test('a MEMORY that fits is returned byte for byte', () => {
  const text = document({ summary: 'Compacted 2026-11-11 18:00. SUMMARY_MARK' });
  assert.equal(fitMemoryDocument(text, text.length, FILE), text);
  assert.equal(fitMemoryDocument(text, text.length + 5000, FILE), text);
  assert.equal(fitMemoryDocument(text, Infinity, FILE), text);
});

test('a big MEMORY keeps the compaction summary, Current work and the decisions before older sections', () => {
  const text = document({ summary: 'Compacted 2026-11-11 18:00. SUMMARY_MARK' });
  const cw = text.indexOf('### Current work');
  const limit = Math.floor(text.length * 0.4);
  const out = fitMemoryDocument(text, limit, FILE);
  assert.ok(out.length <= limit, `${out.length} > ${limit}`);
  // The summary is the last section of the file: the old head-cut dropped it first.
  assert.match(out, /SUMMARY_MARK/);
  assert.ok(out.includes(text.slice(cw, text.indexOf('### Research state'))), 'Current work whole');
  assert.ok(out.includes(`${DECISIONS}\n\n${lines('DEC', 12)}`), 'decisions block whole');
  assert.match(out, /### Working understanding/);
  // The lowest priority sections are cut and each says what was cut and where to read it.
  assert.doesNotMatch(out, /RS line 0000/);
  const notes = out.match(/\[Cut to fit the memory budget:[^\n]*\]/g) ?? [];
  assert.ok(notes.length > 0);
  for (const note of notes) assert.ok(note.includes(FILE), note);
  assert.ok(notes.some((n) => /"Research state/.test(n)));
});

test('a section that does not fit keeps its newest lines and drops its oldest', () => {
  const text = document({ summary: 'S', work: lines('CW', 400) });
  const out = fitMemoryDocument(text, 14000, FILE);
  assert.ok(out.length <= 14000);
  assert.match(out, /CW line 0399/);
  assert.doesNotMatch(out, /CW line 0000/);
  const note = /the oldest (\d+) of (\d+) characters of "Current work"/.exec(out);
  assert.ok(note, 'Current work cut note');
  assert.ok(Number(note[1]) > 0 && Number(note[1]) < Number(note[2]));
  // The heading stays above the note, and the kept text starts at a line boundary.
  assert.match(out, /### Current work\n\[Cut to fit[^\n]*\]\nCW line \d{4} /);
});

test('every section is announced when the limit leaves room for headings only', () => {
  const text = document({ summary: 'S' });
  const out = fitMemoryDocument(text, 2500, FILE);
  assert.ok(out.length <= 2500);
  assert.match(out, /### Last compaction summary/);
  assert.match(out, /### Current work/);
  assert.match(out, /"Working understanding" are omitted/);
  assert.match(out, /"Research state" are omitted/);
});

test('a MEMORY with no sections keeps its start and says what was cut', () => {
  const text = `Current memory (${FILE}, MEMORY section):\nFIRST_LINE\n${'m'.repeat(5000)}\n`;
  const out = fitMemoryDocument(text, 1500, FILE);
  assert.ok(out.length <= 1500);
  assert.match(out, /FIRST_LINE/);
  assert.match(out, /the last \d+ of \d+ characters of "MEMORY introduction" are omitted/);
});

test('shares: a small document keeps all of itself and the spare goes to the large one', () => {
  assert.deepEqual(allocateMemoryShares([14000, 120000], 100000), [14000, 86000]);
  assert.deepEqual(allocateMemoryShares([10, 20], 100), [10, 20]);
  assert.deepEqual(allocateMemoryShares([60000, 60000], 100000), [50000, 50000]);
});

test('buildContext keeps the summary and Current work of a big channel MEMORY; a small one is untouched', (t) => {
  const f = fixture(t);
  const account = f.config.accounts[0]!;
  const small = buildContext(f.store, f.session, account, [], 4000, 100000);
  const memoryOf = (c: ReturnType<typeof buildContext>) =>
    c.contextRefresh.snapshot.memoryDocuments.map((d) => d.text).join('\n\n');
  // Small MEMORY: the rendered block is exactly the snapshot text.
  assert.ok(small.instructions.includes(memoryOf(small)));
  assert.doesNotMatch(small.instructions, /Cut to fit the memory budget/);

  updateMemory(f.store, f.session.id, {
    'Working understanding': lines('WU', 300),
    'Current work': 'CURRENT_WORK_MARK\n' + lines('CW', 20),
    'Research state': `${DECISIONS}\n\n- DECISION_MARK\n\n#### finding: x\n\n${lines('RS', 1500)}`,
    'Last compaction summary': 'Compacted 2026-11-11 18:00. SUMMARY_MARK',
  });
  const baseline = buildContext(f.store, f.session, account, [], 4000, 1000000);
  assert.ok(baseline.instructions.includes('RS line 0000'));
  const memoryChars = memoryOf(baseline).length;
  // Leave room for about a third of the channel MEMORY.
  const limit = baseline.instructions.length - Math.floor(memoryChars * 0.7);
  const big = buildContext(f.store, f.session, account, [], 4000, limit);
  assert.match(big.instructions, /SUMMARY_MARK/);
  assert.match(big.instructions, /CURRENT_WORK_MARK/);
  assert.match(big.instructions, /DECISION_MARK/);
  assert.match(big.instructions, /Cut to fit the memory budget/);
  assert.doesNotMatch(big.instructions, /RS line 0000/);
  // The standing instructions (everything before the memory block) are the same as without the cut.
  const head = (text: string) => text.slice(0, text.indexOf('CLAWSTRUM_CURRENT_MEMORY_BEGIN'));
  assert.equal(head(big.instructions), head(baseline.instructions));
});
