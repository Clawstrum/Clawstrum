import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseReviewer, reviewerBlock, summarizeReviewer } from '../src/research/reviewer.js';

const HEADER = "Reviewer verdicts (harness-read evidence, not the reviewer's words):";

function tmpDir(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const STORY = [
  'STORY NOW: a scaling law on one architecture',
  'STORY BEST: a scaling law that holds across architectures',
  'STORY GAP: a second architecture',
  'LEAD: the transformer run in item 5',
];

test('parseReviewer reads a well-formed review', () => {
  const text = [
    'STAGE: final',
    'SLOTS: 2',
    'PLAN SLOTS: 1',
    ...STORY,
    'ITEM 1 [main, result]: Figure 2 scaling law — the result the paper stands on',
    'ITEM 2 [fix, result]: Table 1 baselines — missing the strongest baseline',
    'FIX: add the tuned baseline from notes.md',
    'ITEM 3 [cut, result]: Appendix C — does not support any claim',
    'KILL: the appendix contradicts nothing if removed',
    'ITEM 4 [stop, plan]: the ablation sweep — no longer informative',
    'ITEM 5 [develop, plan]: transformer run — would make the law general',
    'DEVELOP: one 7B run at matched compute, about 200 GPU-hours',
    'MISSING: a comparison to the March run',
    'OVERALL: one strong result, one fixable one',
    'TOP CUT: Appendix C',
  ].join('\n');
  const p = parseReviewer(text);
  assert.equal(p.stage, 'final');
  assert.equal(p.slots, 2);
  assert.equal(p.planSlots, 1);
  assert.deepEqual(p.story, {
    now: 'a scaling law on one architecture',
    best: 'a scaling law that holds across architectures',
    gap: 'a second architecture',
    lead: 'the transformer run in item 5',
  });
  assert.deepEqual(
    p.items.map((i) => [i.n, i.verdict, i.kind, i.item, i.why]),
    [
      [1, 'main', 'result', 'Figure 2 scaling law', 'the result the paper stands on'],
      [2, 'fix', 'result', 'Table 1 baselines', 'missing the strongest baseline'],
      [3, 'cut', 'result', 'Appendix C', 'does not support any claim'],
      [4, 'stop', 'plan', 'the ablation sweep', 'no longer informative'],
      [5, 'develop', 'plan', 'transformer run', 'would make the law general'],
    ],
  );
  assert.equal(p.items[1]!.fix, 'add the tuned baseline from notes.md');
  assert.equal(p.items[4]!.develop, 'one 7B run at matched compute, about 200 GPU-hours');
  assert.equal(p.items[2]!.kill, 'the appendix contradicts nothing if removed');
  assert.deepEqual(p.missing, ['a comparison to the March run']);
  assert.equal(p.overall, 'one strong result, one fixable one');
  assert.equal(p.topCut, 'Appendix C');

  const block = reviewerBlock(p, [], () => '');
  const lines = block.split('\n');
  assert.equal(lines[0], HEADER);
  assert.equal(
    lines[1],
    'stage final: main 1 / fix 1 / develop 1 / supporting 0 / dead_end 0 / cut 1 / stop 1, slots 2, plan slots 1',
  );
  assert.deepEqual(lines.slice(2, 6), [
    'story now: a scaling law on one architecture',
    'story best: a scaling law that holds across architectures',
    'story gap: a second architecture',
    'lead: the transformer run in item 5',
  ]);
  assert.equal(lines[6], 'ITEM 1 [main]: Figure 2 scaling law — the result the paper stands on');
  assert.doesNotMatch(
    block,
    /[A-Z]{3,} (MISSING|BUDGET|VERDICT|UNCITED|IN DIRECTION|NOT PLAN)|omitted/,
  );
  assert.match(block, /^ITEM 5 \[develop, plan\]: transformer run — would make the law general$/m);
  assert.match(block, /^ {2}needs: one 7B run at matched compute, about 200 GPU-hours$/m);
  assert.match(block, /^ITEM 2 \[fix\]: Table 1 baselines — missing the strongest baseline$/m);
  assert.match(block, /^ {2}fix: add the tuned baseline from notes\.md$/m);
  assert.match(block, /^ {2}kill: the appendix contradicts nothing if removed$/m);
  assert.match(block, /^missing: a comparison to the March run$/m);
  assert.match(block, /^overall: one strong result, one fixable one$/m);
  assert.match(block, /^top cut: Appendix C$/m);
});

test('parseReviewer tolerates bullets, bold, lowercase keywords, other dashes and CRLF', () => {
  const text = [
    'Here is my review.',
    '**Stage:** Direction (work in progress)',
    '**Slots:** 3 (two figures and a table)',
    '**Story now:** one figure',
    '- **ITEM #1 [Main]:** Figure 2 – core result',
    '  * **Fix:** ignored, main has no fix but it is kept',
    '1. item 2 [ Supporting ] - an aside - with a dash inside',
    '> **item 3 [Stop; Plan]**: the sweep -- saturated',
    'ITEM 4 [Dead End, result]: the old fit — killed by the control',
    'top-cut: the sweep',
  ].join('\r\n');
  const p = parseReviewer(text);
  assert.equal(p.stage, 'direction');
  assert.equal(p.slots, 3);
  assert.deepEqual(p.story, { now: 'one figure' });
  assert.deepEqual(
    p.items.map((i) => [i.n, i.verdict, i.kind, i.item, i.why]),
    [
      [1, 'main', undefined, 'Figure 2', 'core result'],
      [2, 'supporting', undefined, 'an aside', 'with a dash inside'],
      [3, 'stop', 'plan', 'the sweep', 'saturated'],
      [4, 'dead_end', 'result', 'the old fit', 'killed by the control'],
    ],
  );
  assert.equal(p.items[0]!.fix, 'ignored, main has no fix but it is kept');
  assert.equal(p.topCut, 'the sweep');
});

test('reviewerBlock flags main+fix results over the slots in the final stage only', () => {
  const items = [
    'ITEM 1 [main, result]: A — a',
    'ITEM 2 [fix, result]: B — b',
    'FIX: do b',
    'ITEM 3 [main, plan]: C — c',
  ];
  const final = summarizeReviewer(['STAGE: final', 'SLOTS: 1', ...items].join('\n'), [], () => '');
  assert.match(final.block, /^OVER BUDGET: main\+fix results = 2 > slots 1$/m);
  assert.equal(final.record.overBudget, true);
  const within = reviewerBlock(
    parseReviewer(['STAGE: final', 'SLOTS: 2', ...items].join('\n')),
    [],
    () => '',
  );
  assert.doesNotMatch(within, /OVER BUDGET/, 'plan items never count against slots');
  const direction = summarizeReviewer(
    ['STAGE: direction', 'SLOTS: 1', ...items].join('\n'),
    [],
    () => '',
  );
  assert.doesNotMatch(direction.block, /OVER BUDGET/);
  assert.equal(direction.record.overBudget, false);
  const noStage = reviewerBlock(parseReviewer(['SLOTS: 1', ...items].join('\n')), [], () => '');
  assert.match(noStage, /^OVER BUDGET: main\+fix results = 2 > slots 1$/m);
  assert.match(noStage, /^STAGE MISSING: /m);
  const noSlots = reviewerBlock(
    parseReviewer('ITEM 1 [main, result]: A\nITEM 2 [main, result]: B'),
    [],
    () => '',
  );
  assert.match(noSlots, /, slots \?$/m);
  assert.doesNotMatch(noSlots, /OVER BUDGET/);
  const uncapped = reviewerBlock(
    parseReviewer('STAGE: direction\nITEM 1 [main, result]: A'),
    [],
    () => '',
  );
  assert.match(uncapped, /, no slot cap$/m);
  assert.doesNotMatch(uncapped, /SLOTS MISSING/);
});

test('reviewerBlock flags main plan items over the plan slots and a final stage without slots', () => {
  const text = [
    'STAGE: final',
    'PLAN SLOTS: 1',
    'ITEM 1 [main, plan]: run A — a',
    'ITEM 2 [main, plan]: run B — b',
    'ITEM 3 [main, result]: Figure 1 — c',
  ].join('\n');
  const s = summarizeReviewer(text, [], () => '');
  assert.match(s.block, /^OVER PLAN BUDGET: main plan items = 2 > plan slots 1$/m);
  assert.match(s.block, /^SLOTS MISSING: the final stage needs SLOTS$/m);
  assert.equal(s.record.overBudget, true);
  assert.equal(s.record.planSlots, 1);
});

test('reviewerBlock flags missing story lines', () => {
  const p = parseReviewer(
    ['STAGE: direction', 'STORY NOW: x', 'LEAD: y', 'ITEM 1 [main, result]: A — a'].join('\n'),
  );
  assert.match(
    reviewerBlock(p, [], () => ''),
    /^STORY MISSING: best, gap$/m,
  );
  const none = reviewerBlock(
    parseReviewer('STAGE: direction\nITEM 1 [main, result]: A'),
    [],
    () => '',
  );
  assert.match(none, /^STORY MISSING: now, best, gap, lead$/m);
});

test('reviewerBlock flags develop without its need, dead_end without evidence, cut in direction, stop on a result, no kind', () => {
  const text = [
    'STAGE: direction',
    ...STORY,
    'ITEM 1 [develop, result]: A — one seed',
    'ITEM 2 [develop, plan]: B — not designed',
    'DEVELOP: a design for the control, one day',
    'ITEM 3 [dead_end, result]: C — the control killed it',
    'ITEM 4 [dead_end, result]: D — the control killed it',
    'EVIDENCE: notes.md:3 "control: effect gone"',
    'ITEM 5 [cut, result]: E — off-story',
    'ITEM 6 [stop, result]: F — finished',
    'ITEM 7 [stop, plan]: G — cannot change the conclusion',
    'ITEM 8 [supporting]: H — goes to the supplement',
  ].join('\n');
  const p = parseReviewer(text);
  assert.equal(p.items[0]!.develop, undefined);
  assert.equal(p.items[1]!.develop, 'a design for the control, one day');
  const block = reviewerBlock(p, [], () => '');
  const flags = block.split('\n').filter((l) => /^[A-Z][A-Z ]+: /.test(l) && !l.startsWith('ITEM'));
  assert.deepEqual(flags, [
    'DEVELOP MISSING: item 1 does not say what it needs',
    'DEAD END UNCITED: item 3 cites no result that killed it',
    'CUT IN DIRECTION: item 5',
    'STOP NOT PLAN: item 6',
    'KIND MISSING: item 8',
  ]);
  assert.match(
    block,
    /^stage direction: main 0 \/ fix 0 \/ develop 2 \/ supporting 1 \/ dead_end 2 \/ cut 1 \/ stop 2, no slot cap$/m,
  );
  const final = reviewerBlock(
    parseReviewer(['STAGE: final', 'SLOTS: 1', ...STORY, 'ITEM 1 [cut, result]: E — x'].join('\n')),
    [],
    () => '',
  );
  assert.doesNotMatch(final, /CUT IN DIRECTION/);
});

test('reviewerBlock flags a fix item without FIX and an unknown verdict', () => {
  const p = parseReviewer(
    [
      'STAGE: final',
      'SLOTS: 3',
      'ITEM 1 [fix, result]: A — a',
      'ITEM 2 [maybe later, result]: B — b',
      'ITEM 3 [fix, result]: C',
    ].join('\n'),
  );
  assert.equal(p.items[1]!.verdict, 'unknown');
  assert.equal(p.items[1]!.raw, 'maybe_later');
  const block = reviewerBlock(p, [], () => '');
  assert.match(block, /^FIX MISSING: item 1$/m);
  assert.match(block, /^FIX MISSING: item 3$/m);
  assert.match(block, /^UNKNOWN VERDICT: item 2$/m);
  assert.match(block, /^ITEM 2 \[unknown: maybe_later\]: B — b$/m);
  assert.match(
    block,
    /^stage final: main 0 \/ fix 2 \/ develop 0 \/ supporting 0 \/ dead_end 0 \/ cut 0 \/ stop 0, slots 3$/m,
  );
});

test('summarizeReviewer checks evidence: verified, moved, unverified, unbacked', (t) => {
  const dir = tmpDir(t);
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1} filler text`);
  lines[2] = 'accuracy 0.91 on the held-out split';
  lines[29] = 'the scaling exponent is 0.52 across four seeds';
  fs.writeFileSync(path.join(dir, 'notes.md'), lines.join('\n') + '\n');
  const text = [
    'STAGE: final',
    'SLOTS: 2',
    'ITEM 1 [main]: A — a',
    'EVIDENCE: notes.md:3 "accuracy 0.91"',
    'ITEM 2 [supporting]: B — b',
    'EVIDENCE: notes.md:5 "the scaling exponent is 0.52 across four seeds"',
    'ITEM 3 [cut]: C — c',
    'EVIDENCE: notes.md:3 "accuracy 0.99"',
    'ITEM 4 [cut]: D — d',
    'MISSING: nothing on robustness',
  ].join('\n');
  const s = summarizeReviewer(text, [dir]);
  assert.deepEqual(s.record, {
    stage: 'final',
    slots: 2,
    planSlots: null,
    counts: {
      main: 1,
      fix: 0,
      develop: 0,
      supporting: 1,
      dead_end: 0,
      cut: 2,
      stop: 0,
      unknown: 0,
    },
    overBudget: false,
    items: 4,
    verified: 2,
    unverified: 1,
    unbacked: 1,
    missing: 1,
  });
  assert.match(s.block, /^ {2}notes\.md:3 verified$/m);
  assert.match(s.block, /^ {4}3│ accuracy 0\.91 on the held-out split$/m);
  assert.match(s.block, /^ {2}notes\.md:5 moved \(found at line 30\)$/m);
  assert.match(s.block, /^ {4}30│ the scaling exponent is 0\.52 across four seeds$/m);
  assert.match(s.block, /^ {2}notes\.md:3 unverified$/m);
  assert.match(s.block, /^missing: nothing on robustness$/m);
});

test('reviewerBlock caps its length, omitting trailing items and saying how many', () => {
  const why = 'x'.repeat(120);
  const text = Array.from(
    { length: 10 },
    (_, i) => `ITEM ${i + 1} [supporting, result]: I${i + 1} — ${why}`,
  )
    .concat('OVERALL: fine')
    .concat('STAGE: direction', ...STORY)
    .join('\n');
  const block = reviewerBlock(parseReviewer(text), [], () => '', 600);
  const shown = block.split('\n').filter((l) => l.startsWith('ITEM ')).length;
  const m = /^\((\d+) item\(s\) omitted at the 600-character cap\)$/m.exec(block);
  assert.ok(m, block);
  assert.ok(shown >= 1);
  assert.equal(shown + Number(m[1]), 10);
  assert.match(block, /^ITEM 1 \[supporting\]/m);
  assert.doesNotMatch(block, /^ITEM 10 /m);
  assert.match(block, /^overall: fine$/m);
  assert.ok(block.length <= 600 + 60, `block length ${block.length}`);
});

test('reviewerBlock says so when there are no ITEM lines', () => {
  const block = reviewerBlock(parseReviewer(''), [], () => '');
  assert.equal(block, `${HEADER}\nno ITEM lines in the expected format`);
  const s = summarizeReviewer('Looks fine to me.\nOVERALL: ship it', [], () => '');
  assert.equal(s.block, `${HEADER}\nno ITEM lines in the expected format\noverall: ship it`);
  assert.equal(s.record.items, 0);
  assert.equal(s.record.slots, null);
  assert.equal(s.record.stage, null);
  const story = reviewerBlock(parseReviewer('STORY NOW: x\nLEAD: y'), [], () => '');
  assert.equal(story, `${HEADER}\nstory now: x\nlead: y\nno ITEM lines in the expected format`);
});
