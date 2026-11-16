import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { AccountPool } from '../src/accounts.js';
import { configSchema } from '../src/config.js';
import { ensureMemory, updateMemory } from '../src/memory.js';
import { delegate, ResearchWorkers } from '../src/research/workers.js';
import { researchTool } from '../src/research/tools.js';
import {
  checkQuote,
  evidenceReader,
  MAX_EVIDENCE_BYTES,
  checkerEvidenceBlock,
  parseChecker,
  summarizeChecker,
} from '../src/research/checker.js';
import type { Provider, ProviderRequest } from '../src/types.js';

const HEADER = "Checker evidence check (harness-read, not the checker's words):";

function source(dir: string, name: string, lines: string[]) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
function numbered(n: number) {
  return Array.from({ length: n }, (_, i) => `line ${i + 1} filler text`);
}

test('parseChecker tolerates markdown bullets, bold, extra spaces and CRLF', () => {
  const text = [
    'Here is my review.',
    '',
    '1. **OBJECTION 1 [Overclaim]:**   The speedup rests on one seed.',
    '   - EVIDENCE:  `results/summary.md:42`  "mean speedup 2.3x (seed 0)"',
    '   * **EVIDENCE:** notes.md:7 "a **bold** quote"',
    '- OBJECTION 2 [missed_prior]: Contradicts the March run.',
    '> OBJECTION 3 [stale]: Section 4 uses the old run.',
    'EVIDENCE: draft.tex:10 “curly quoted text”',
  ].join('\r\n');
  const parsed = parseChecker(text);
  assert.equal(parsed.noObjection, undefined);
  assert.deepEqual(
    parsed.objections.map((o) => [o.n, o.kind, o.claim, o.evidence.length]),
    [
      [1, 'overclaim', 'The speedup rests on one seed.', 2],
      [2, 'missed_prior', 'Contradicts the March run.', 0],
      [3, 'stale', 'Section 4 uses the old run.', 1],
    ],
  );
  assert.deepEqual(parsed.objections[0]!.evidence, [
    { path: 'results/summary.md', line: 42, quote: 'mean speedup 2.3x (seed 0)' },
    { path: 'notes.md', line: 7, quote: 'a **bold** quote' },
  ]);
  assert.equal(parsed.objections[2]!.evidence[0]!.quote, 'curly quoted text');
});

test('parseChecker recognises NO OBJECTION and leaves unparseable text empty', () => {
  assert.deepEqual(parseChecker('**NO OBJECTION:** the result matches its logs\r\n'), {
    objections: [],
    noObjection: 'the result matches its logs',
  });
  const none = parseChecker('I think this is broadly fine but the second figure is odd.');
  assert.deepEqual(none, { objections: [] });
  const block = checkerEvidenceBlock(none, []);
  assert.equal(block.split('\n').length, 1);
  assert.ok(block.startsWith(HEADER));
  assert.match(block, /no checkable evidence was found/);
});

test('checkQuote: verified, moved, short quote not moved, unverified, nofile, 2-line span', (t) => {
  const f = fixture(t);
  const lines = numbered(40);
  lines[9] = 'The   measured accuracy was 0.73';
  lines[10] = 'across all five seeds.';
  lines[29] = 'a distinctive sentence that only appears here once';
  lines[34] = 'short 0.91';
  source(f.home, 'doc.md', lines);
  const bases = [path.join(f.home, 'nowhere'), f.home];
  assert.deepEqual(
    checkQuote({ path: 'doc.md', line: 10, quote: 'measured accuracy was 0.73' }, bases),
    {
      status: 'verified',
      file: path.join(f.home, 'doc.md'),
      line: 10,
      lines: 1,
    },
  );
  // Cited within three lines of where it is: the line reported is where the quote starts.
  assert.deepEqual(
    checkQuote({ path: 'doc.md', line: 13, quote: 'measured accuracy was 0.73' }, bases),
    { status: 'verified', file: path.join(f.home, 'doc.md'), line: 10, lines: 1 },
  );
  assert.deepEqual(
    checkQuote(
      { path: 'doc.md', line: 12, quote: 'accuracy was 0.73 across all five seeds.' },
      bases,
    ),
    { status: 'verified', file: path.join(f.home, 'doc.md'), line: 10, lines: 2 },
  );
  assert.deepEqual(
    checkQuote(
      {
        path: path.join(f.home, 'doc.md'),
        line: 3,
        quote: 'a distinctive sentence that only appears',
      },
      [],
    ),
    { status: 'moved', file: path.join(f.home, 'doc.md'), line: 30, lines: 1 },
  );
  assert.equal(
    checkQuote({ path: 'doc.md', line: 3, quote: 'short 0.91' }, bases).status,
    'unverified',
  );
  assert.equal(
    checkQuote({ path: 'doc.md', line: 10, quote: 'a sentence nobody ever wrote down' }, bases)
      .status,
    'unverified',
  );
  assert.equal(checkQuote({ path: 'missing.md', line: 1, quote: 'x' }, bases).status, 'nofile');
  // A moved quote spanning two lines reports the first line of the match.
  assert.deepEqual(
    checkQuote({ path: 'doc.md', line: 30, quote: 'was 0.73 across all five seeds' }, bases),
    { status: 'moved', file: path.join(f.home, 'doc.md'), line: 10, lines: 2 },
  );
});

test('checkerEvidenceBlock reports statuses, matched lines from disk, and stays under the cap', (t) => {
  const f = fixture(t);
  const lines = numbered(20);
  lines[4] = 'the claimed effect size is 0.8';
  lines[14] = 'this sentence was moved further down the file';
  source(f.home, 'a.md', lines);
  const text = [
    'OBJECTION 1 [overclaim]: Effect size overstated.',
    'EVIDENCE: a.md:7 "the claimed effect size is 0.8"',
    'OBJECTION 2 [stale]: Superseded.',
    'EVIDENCE: a.md:2 "this sentence was moved further down"',
    'OBJECTION 3 [wrong]: Invented quote.',
    'EVIDENCE: a.md:5 "nothing like this is in the file"',
    'OBJECTION 4 [unsupported]: No baseline.',
  ].join('\n');
  const { block, record } = summarizeChecker(text, [f.home]);
  assert.ok(block.startsWith(HEADER));
  assert.match(block, /OBJECTION 1 \[overclaim\] verified/);
  assert.match(block, / {4}5│ the claimed effect size is 0\.8/);
  // Only the matching span is printed, not the lines around the cited one.
  assert.doesNotMatch(block, /[4678]│ line [4678] filler text/);
  assert.match(block, /OBJECTION 2 \[stale\] verified/);
  assert.match(block, /a\.md:2 found at line 15, not 2/);
  assert.match(block, / {4}15│ this sentence was moved/);
  assert.match(block, /OBJECTION 3 \[wrong\] unverified/);
  assert.match(block, /OBJECTION 4 \[unsupported\] unbacked/);
  assert.deepEqual(record, {
    objections: 4,
    verified: 2,
    moved: 1,
    unverified: 1,
    unbacked: 1,
    noObjection: false,
  });

  const long = 'x'.repeat(190);
  const many = Array.from({ length: 5 }, (_, i) => i + 1)
    .map((n) => `OBJECTION ${n} [wrong]: ${long}\nEVIDENCE: big.md:${n * 3} "${long.slice(0, 30)}"`)
    .join('\n');
  source(
    f.home,
    'big.md',
    Array.from({ length: 20 }, () => long),
  );
  const capped = summarizeChecker(many, [f.home]).block;
  assert.ok(capped.length <= 4000, `block length ${capped.length}`);
  const small = checkerEvidenceBlock(
    parseChecker(many),
    parseChecker(many).objections.map((o) => o.evidence.map((e) => checkQuote(e, [f.home]))),
    undefined,
    1200,
  );
  assert.ok(small.length <= 1200 + 80);
  assert.match(small, /omitted at the 1200-character cap/);
});

test('config defaults: checker and reviewer roles, build-only thinker and workers.review settings', (t) => {
  const f = fixture(t);
  const roles = f.config.research.workers.roles;
  assert.equal(
    roles.checker?.description,
    'Check one artifact against its sources: is it true; proposes nothing',
  );
  assert.equal(roles.checker?.models.claude, 'opus');
  assert.equal(roles.checker?.models.codex, roles.thinker?.models.codex);
  assert.equal(roles.checker?.effort, 'high');
  assert.equal(roles.checker?.maxTurns, 0);
  assert.deepEqual(roles.checker?.skills, []);
  assert.match(roles.checker!.prompt, /OBJECTION <n> \[<kind>\]/);
  assert.match(roles.checker!.prompt, /NO OBJECTION/);
  assert.match(roles.checker!.prompt, /at most 3 objections/);
  assert.match(roles.checker!.prompt, /wrong, stale, unsupported, overclaim, missed_prior\./);
  assert.match(roles.checker!.prompt, /that is the reviewer role/);
  assert.equal(
    roles.reviewer?.description,
    'Judge whether work is promising (direction) or passes a referee (final); reads the story first, one verdict per item',
  );
  assert.deepEqual(roles.reviewer?.models, { claude: 'opus', codex: 'gpt-5.6-sol' });
  assert.equal(roles.reviewer?.effort, 'high');
  assert.equal(roles.reviewer?.maxTurns, 0);
  assert.deepEqual(roles.reviewer?.skills, []);
  assert.match(roles.reviewer!.prompt, /ITEM <n> \[<verdict>, <kind>\]/);
  assert.match(roles.reviewer!.prompt, /as much a failed review as keeping everything in main/);
  assert.match(roles.reviewer!.prompt, /^STAGE: <direction or final/m);
  for (const label of ['STORY NOW', 'STORY BEST', 'STORY GAP', 'LEAD', 'DEVELOP', 'PLAN SLOTS'])
    assert.match(roles.reviewer!.prompt, new RegExp(`^${label}: `, 'm'));
  assert.match(roles.reviewer!.prompt, /cut \(final stage only\)/);
  assert.match(roles.reviewer!.prompt, /stop \(plan items only\)/);
  assert.equal(roles.thinker?.description, 'Develop a proposed direction in detail');
  assert.match(roles.thinker!.prompt, /reviewer role/);
  assert.deepEqual(f.config.research.workers.review, {
    artifact: 'advise',
    hold: 'off',
    paperPush: 'off',
    notesChars: 20000,
  });
  assert.throws(() =>
    configSchema.parse({
      ...JSON.parse(JSON.stringify(f.config)),
      research: { workers: { review: { artifact: 'maybe' } } },
    }),
  );
});

test('workers.critic is accepted as a deprecated alias of workers.review; review wins', (t) => {
  const f = fixture(t);
  const base = JSON.parse(JSON.stringify(f.config));
  const parse = (workers: Record<string, unknown>) =>
    configSchema.parse({ ...base, research: { ...base.research, workers } }).research.workers;
  const legacy = { ...base.research.workers };
  delete legacy.review;
  const aliased = parse({ ...legacy, critic: { hold: 'once', notesChars: 5 } });
  assert.deepEqual(aliased.review, {
    artifact: 'advise',
    hold: 'once',
    paperPush: 'off',
    notesChars: 5,
  });
  assert.equal('critic' in aliased, false);
  const both = parse({
    ...legacy,
    critic: { hold: 'once', paperPush: 'deny' },
    review: { artifact: 'deny' },
  });
  assert.deepEqual(both.review, {
    artifact: 'deny',
    hold: 'off',
    paperPush: 'off',
    notesChars: 20000,
  });
  assert.throws(() => parse({ ...legacy, critic: { artifact: 'maybe' } }));
});

function withArtifact(config: ReturnType<typeof fixture>['config'], artifact: string) {
  return {
    ...config,
    research: {
      ...config.research,
      workers: {
        ...config.research.workers,
        review: { ...config.research.workers.review, artifact: artifact as 'deny' },
      },
    },
  };
}

test('checker artifact setting: deny refuses, advise warns, off is silent, existing file passes', async (t) => {
  const f = fixture(t);
  source(f.session.workspace, 'plan.md', ['the plan']);
  const deny = withArtifact(f.config, 'deny');
  assert.throws(
    () => delegate(f.store, f.session.id, deny, 'd1', { role: 'checker', brief: 'Attack' }),
    /names no artifact/,
  );
  assert.throws(
    () =>
      delegate(f.store, f.session.id, deny, 'd2', {
        role: 'checker',
        brief: 'Attack',
        artifact: 'absent.md',
      }),
    /does not exist/,
  );
  const allowed = delegate(f.store, f.session.id, deny, 'd3', {
    role: 'checker',
    brief: 'Attack',
    artifact: 'plan.md',
  });
  assert.equal(allowed.advisory, undefined);
  assert.equal(JSON.parse(allowed.spec_json).artifact, path.join(f.session.workspace, 'plan.md'));

  const advised = (await researchTool(
    'research_delegate',
    { key: 'a1', role: 'checker', brief: 'Attack' },
    {
      store: f.store,
      config: f.config,
      sessionId: f.session.id,
      scope: 'test',
      worker: false,
    },
  )) as { advisory?: string };
  assert.match(advised.advisory ?? '', /^Advisory: this checker delegation names no artifact/);

  const off = delegate(f.store, f.session.id, withArtifact(f.config, 'off'), 'o1', {
    role: 'checker',
    brief: 'Attack',
  });
  assert.equal(off.advisory, undefined);
  // Other roles are never checked.
  assert.equal(
    delegate(f.store, f.session.id, deny, 'n1', { role: 'analyst', brief: 'x' }).advisory,
    undefined,
  );
});

test('a completed checker wakes the lead with the evidence block and records research_checker_result', async (t) => {
  const f = fixture(t);
  source(f.session.workspace, 'drafts/result.md', [
    'Summary',
    'We observe a 40% improvement on all tasks.',
    'Only task A was run.',
  ]);
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    async run(r) {
      requests.push(r);
      return [
        '**OBJECTION 1 [overclaim]:** "all tasks" is not what was run.',
        '- EVIDENCE: result.md:2 "a 40% improvement on all tasks"',
        'OBJECTION 2 [unsupported]: No baseline is named.',
      ].join('\n');
    },
  };
  const m = new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
  );
  try {
    const row = delegate(f.store, f.session.id, f.config, 'crit', {
      role: 'checker',
      brief: 'Check the result against its runs.',
      artifact: 'drafts/result.md',
    });
    m.tick();
    await Promise.all([...m.active.values()].map((r) => r.promise));
    assert.ok(
      requests[0]!.prompt.startsWith(
        `Artifact under review: ${path.join(f.session.workspace, 'drafts/result.md')}\nRole: checker`,
      ),
    );
    const wake = f.store.get<{ content: string }>(
      'SELECT content FROM inbound WHERE id=?',
      `research:worker:${row.id}`,
    )!.content;
    assert.ok(wake.includes(HEADER));
    assert.match(wake, /OBJECTION 1 \[overclaim\] verified/);
    assert.match(wake, /2│ We observe a 40% improvement on all tasks\./);
    assert.match(wake, /OBJECTION 2 \[unsupported\] unbacked/);
    const event = f.store.get<{ content: string }>(
      "SELECT content FROM events WHERE type='research_checker_result'",
    )!;
    assert.deepEqual(JSON.parse(event.content), {
      id: row.id,
      artifact: path.join(f.session.workspace, 'drafts/result.md'),
      repo: null,
      tree: null,
      base: null,
      objections: 2,
      verified: 1,
      moved: 0,
      unverified: 0,
      unbacked: 1,
      noObjection: false,
    });
    assert.ok(f.store.get("SELECT 1 FROM events WHERE type='research_worker_result'"));
  } finally {
    await m.stop();
  }
});

test('a checker gets the Research state notes inline; a thinker and notesChars 0 do not', async (t) => {
  const f = fixture(t);
  source(f.session.workspace, 'drafts/result.md', ['Summary', 'Only task A was run.']);
  ensureMemory(f.store, f.session.id);
  const marker = 'MARKER-2026-09 seed 3 diverged, rerun pending';
  updateMemory(f.store, f.session.id, { 'Research state': `- ${marker}` });
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    async run(r) {
      requests.push(r);
      return 'NO OBJECTION: fine';
    },
  };
  const noNotes = {
    ...f.config,
    research: {
      ...f.config.research,
      workers: {
        ...f.config.research.workers,
        review: { ...f.config.research.workers.review, notesChars: 0 },
      },
    },
  };
  const cases: [string, typeof f.config, string][] = [
    ['c1', f.config, 'checker'],
    ['t1', f.config, 'thinker'],
    ['c0', noNotes, 'checker'],
  ];
  for (const [key, config, role] of cases) {
    const m = new ResearchWorkers(
      f.store,
      config,
      new AccountPool(config.accounts, f.store, 100),
      { claude: provider, codex: provider },
      () => 0,
    );
    try {
      delegate(f.store, f.session.id, config, key, {
        role,
        brief: 'Attack the result.',
        artifact: role === 'checker' ? 'drafts/result.md' : undefined,
      });
      m.tick();
      await Promise.all([...m.active.values()].map((r) => r.promise));
    } finally {
      await m.stop();
    }
  }
  const routes = f.store
    .all<{
      content: string;
    }>("SELECT content FROM events WHERE type='research_worker_route' ORDER BY rowid")
    .map((e) => JSON.parse(e.content) as { notesChars: number });
  assert.equal(requests.length, 3);
  assert.ok(requests[0]!.prompt.includes(marker));
  assert.ok(
    requests[0]!.prompt.includes(
      `Research notes (Research state section of ${path.join(f.session.workspace, 'AGENTS.md')}, as of this dispatch):`,
    ),
  );
  assert.ok(routes[0]!.notesChars > 0);
  assert.ok(!requests[1]!.prompt.includes(marker));
  assert.equal(routes[1]!.notesChars, 0);
  assert.ok(!requests[2]!.prompt.includes(marker));
  assert.equal(routes[2]!.notesChars, 0);
});

test('a fresh memory template gives a checker no notes', async (t) => {
  const f = fixture(t);
  source(f.session.workspace, 'drafts/result.md', ['Summary', 'Only task A was run.']);
  ensureMemory(f.store, f.session.id);
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    async run(r) {
      requests.push(r);
      return 'NO OBJECTION: fine';
    },
  };
  const m = new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
  );
  try {
    delegate(f.store, f.session.id, f.config, 'c1', {
      role: 'checker',
      brief: 'Attack the result.',
      artifact: 'drafts/result.md',
    });
    m.tick();
    await Promise.all([...m.active.values()].map((r) => r.promise));
  } finally {
    await m.stop();
  }
  const route = f.store.get<{ content: string }>(
    "SELECT content FROM events WHERE type='research_worker_route'",
  );
  assert.equal(requests.length, 1);
  assert.ok(!requests[0]!.prompt.includes('Research notes ('));
  assert.equal(JSON.parse(route!.content).notesChars, 0);
});

test('a checker cannot verify a quote from a file in its own artifact directory', async (t) => {
  const f = fixture(t);
  source(f.session.workspace, 'drafts/result.md', ['Summary', 'Only task A was run.']);
  let id = '';
  const provider: Provider = {
    async run() {
      source(path.join(f.session.workspace, 'research', 'workers', id), 'planted.md', [
        'a sentence the checker wrote itself',
      ]);
      return [
        'OBJECTION 1 [wrong]: The draft says otherwise.',
        'EVIDENCE: planted.md:1 "a sentence the checker wrote itself"',
        `EVIDENCE: research/workers/${id}/planted.md:1 "a sentence the checker wrote itself"`,
      ].join('\n');
    },
  };
  const m = new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
  );
  try {
    id = delegate(f.store, f.session.id, f.config, 'plant', {
      role: 'checker',
      brief: 'Attack the result.',
      artifact: 'drafts/result.md',
    }).id;
    m.tick();
    await Promise.all([...m.active.values()].map((r) => r.promise));
    assert.ok(
      fs.existsSync(path.join(f.session.workspace, 'research', 'workers', id, 'planted.md')),
    );
    const event = f.store.get<{ content: string }>(
      "SELECT content FROM events WHERE type='research_checker_result'",
    )!;
    assert.equal(JSON.parse(event.content).unverified, 1);
    assert.equal(JSON.parse(event.content).verified, 0);
  } finally {
    await m.stop();
  }
});

test('checker evidence reads are bounded, cached and reject non-files and own artifacts', (t) => {
  const f = fixture(t);
  const own = path.join(f.home, 'worker');
  fs.mkdirSync(own);
  const ownFile = source(own, 'made-up.md', ['invented evidence']);
  const real = source(f.home, 'evidence.md', ['A measured result from the experiment.']);
  const big = path.join(f.home, 'large.log');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, MAX_EVIDENCE_BYTES + 1);
  const read = evidenceReader(own);
  assert.throws(() => read(ownFile), /own subagent/);
  assert.throws(() => read(big), /budget/);
  assert.throws(() => read(f.home), /file type/);
  const text = read(real);
  fs.writeFileSync(real, 'Changed after the check');
  assert.equal(read(real), text, 'displayed evidence uses the same bytes as verification');
  assert.equal(
    summarizeChecker(`OBJECTION 1 [wrong]: claim\nEVIDENCE: ${big}:1 "quoted"`, [f.home]).record
      .verified,
    0,
  );
});
