import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { buildContext } from '../src/context.js';
import { ContextRefresh, readInstructionSnapshot } from '../src/instructions.js';
import { saveNote } from '../src/research/records.js';
import { notesIndexBlock } from '../src/research/notes-index.js';
import { researchTool } from '../src/research/tools.js';
import { researchSchema } from '../src/research/config.js';
import { fixture } from './helpers.js';
import type { ProviderRequest } from '../src/types.js';

const DAY = 24 * 3600 * 1000;
const NOON = new Date(2026, 10, 10, 12).getTime();

function note(f: ReturnType<typeof fixture>, key: string, title: string, body = 'body ' + key) {
  const { id } = saveNote(f.store, f.session.id, key, {
    kind: 'finding',
    title,
    body,
    evidence: ['x'],
  });
  return id;
}
/** Give each note a distinct, known creation time so newest-first order is not a race. */
function stamp(f: ReturnType<typeof fixture>, id: string, daysAgo: number) {
  f.store.exec('UPDATE research_notes SET created_at=? WHERE id=?', NOON - daysAgo * DAY, id);
}
function ctx(f: ReturnType<typeof fixture>) {
  return { store: f.store, config: f.config, sessionId: f.session.id, scope: 'test' };
}
const limits = { enabled: true, maxItems: 40, maxChars: 4000 };

test('config defaults: notesIndex is on with 40 items and 4000 characters', () => {
  assert.deepEqual(researchSchema.parse({}).notesIndex, limits);
});

test('index lists current notes newest first, with date, title and id, and leaves out replaced ones', (t) => {
  const f = fixture(t);
  const a = note(f, 'a', 'Old setup');
  const b = note(f, 'b', 'Width sweep result');
  const c = note(f, 'c', 'Judge version decision');
  const d = saveNote(f.store, f.session.id, 'd', {
    kind: 'decision',
    title: 'New setup',
    body: 'replaces a',
    evidence: ['x'],
    supersedes: [a],
  }).id;
  // Stamp after every save: saving re-archives all notes, and a changed created_at conflicts.
  stamp(f, a, 3);
  stamp(f, b, 2);
  stamp(f, c, 1);
  stamp(f, d, 0);
  const block = notesIndexBlock(f.store, f.session.id, limits);
  const lines = block.split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(lines, [
    `- 2026-11-10 New setup (id ${d})`,
    `- 2026-11-09 Judge version decision (id ${c})`,
    `- 2026-11-08 Width sweep result (id ${b})`,
  ]);
  assert.doesNotMatch(block, /Old setup/);
  assert.match(
    block,
    /^#### Research notes in this channel \(titles only; read one with research_status/,
  );
  // A note retired by a review (same metadata key) also drops out.
  f.store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    `note-superseded:${f.session.id}:${b}`,
    JSON.stringify('review'),
  );
  assert.doesNotMatch(notesIndexBlock(f.store, f.session.id, limits), /Width sweep/);
  console.log('EXAMPLE INDEX BLOCK:\n' + block);
});

test('no block when the channel has no current note or the index is disabled', (t) => {
  const f = fixture(t);
  assert.equal(notesIndexBlock(f.store, f.session.id, limits), '');
  note(f, 'a', 'One');
  assert.equal(notesIndexBlock(f.store, f.session.id, { ...limits, enabled: false }), '');
});

test('maxItems caps the list and the last line says how many more and how to list them', (t) => {
  const f = fixture(t);
  const ids = [0, 1, 2, 3, 4].map((i) => note(f, 'k' + i, 'Note ' + i));
  ids.forEach((id, i) => stamp(f, id, 5 - i));
  const block = notesIndexBlock(f.store, f.session.id, { ...limits, maxItems: 2 });
  const lines = block.split('\n');
  assert.equal(lines.filter((l) => /\(id /.test(l)).length, 2);
  assert.match(lines[1]!, /Note 4/);
  assert.match(lines[2]!, /Note 3/);
  assert.equal(
    lines.at(-1),
    '- 3 more current notes. List them with research_status collection=notes current=true offset=2 limit=100.',
  );
  // Nothing left out means no "more" line.
  assert.doesNotMatch(
    notesIndexBlock(f.store, f.session.id, { ...limits, maxItems: 5 }),
    /more current note/,
  );
});

test('maxChars caps the list including the "more" line', (t) => {
  const f = fixture(t);
  const ids = Array.from({ length: 10 }, (_, i) =>
    note(f, 'k' + i, 'A fairly long note title number ' + i),
  );
  ids.forEach((id, i) => stamp(f, id, 10 - i));
  const block = notesIndexBlock(f.store, f.session.id, { ...limits, maxChars: 600 });
  assert.ok(block.length <= 600, String(block.length));
  const shown = block.split('\n').filter((l) => /\(id /.test(l)).length;
  assert.ok(shown >= 1 && shown < 10);
  assert.match(block.split('\n').at(-1)!, new RegExp(`^- ${10 - shown} more current notes\\.`));
});

test('lead prompt carries the index; the index text is never written into AGENTS.md', (t) => {
  const f = fixture(t);
  const id = note(f, 'a', 'Lead visible note');
  const account = f.config.accounts[0]!;
  const context = buildContext(f.store, f.session, account, [], 4000, 100000, f.config.research);
  assert.match(context.instructions, /Research notes in this channel/);
  assert.match(context.instructions, new RegExp(`Lead visible note \\(id ${id}\\)`));
  const agents = fs.readFileSync(path.join(f.session.workspace, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agents, /Research notes in this channel/);
  const off = buildContext(f.store, f.session, account, [], 4000, 100000, {
    ...f.config.research,
    notesIndex: { ...limits, enabled: false },
  });
  assert.doesNotMatch(off.instructions, /Research notes in this channel/);
});

test('subagent and maintenance snapshots do not carry the index', (t) => {
  const f = fixture(t);
  note(f, 'a', 'Hidden from others');
  const account = f.config.accounts[0]!;
  const lead = buildContext(f.store, f.session, account, [], 4000, 100000, f.config.research);
  const sources = lead.contextRefresh.sources;
  assert.ok(sources.memoryExtras);
  assert.match(readInstructionSnapshot(sources).memory, /Hidden from others/);
  // Subagents read memory by reference only.
  const worker = readInstructionSnapshot({ ...sources, memoryMode: 'references' });
  assert.doesNotMatch(worker.memory, /Hidden from others|Research notes in this channel/);
  // Maintenance passes build their sources without the callback.
  const { memoryExtras: _drop, ...maintenance } = sources;
  const snapshot = readInstructionSnapshot(maintenance);
  assert.doesNotMatch(snapshot.memory, /Research notes in this channel/);
});

test('a new note changes the context revision so the lead receives an update', (t) => {
  const f = fixture(t);
  note(f, 'a', 'First note');
  const account = f.config.accounts[0]!;
  const initial = buildContext(f.store, f.session, account, [], 4000, 100000, f.config.research);
  const refresh = new ContextRefresh({
    instructions: initial.instructions,
    contextRefresh: initial.contextRefresh,
    onEvent() {},
  } as ProviderRequest);
  refresh.delivered(initial.contextRefresh.snapshot, 'native');
  assert.equal(refresh.read() && refresh.changed(refresh.read()!), false);
  note(f, 'b', 'Second note appears');
  const next = refresh.read()!;
  assert.notEqual(next.memoryRevision, initial.contextRefresh.snapshot.memoryRevision);
  assert.notEqual(next.revision, initial.contextRefresh.snapshot.revision);
  assert.equal(refresh.changed(next), true);
  assert.equal(refresh.memoryChanged(next), true);
  const update = refresh.text(next);
  assert.match(update, /^CLAWSTRUM_CONTEXT_UPDATE/);
  assert.match(update, /Second note appears/);
});

test('research_status notes: query needs every word in title or body, within this channel only', async (t) => {
  const f = fixture(t);
  const other = f.store.ensureSession('999999');
  const a = note(f, 'a', 'Width sweep', 'Seeds store the previous token');
  const b = note(f, 'b', 'Judge', 'width of the judge prompt, previous token not used');
  note(f, 'c', 'Unrelated', 'nothing here');
  saveNote(f.store, other.id, 'o', {
    kind: 'finding',
    title: 'Width sweep elsewhere',
    body: 'previous token',
    evidence: ['x'],
  });
  stamp(f, a, 2);
  stamp(f, b, 1);
  const run = (args: object) =>
    researchTool('research_status', { collection: 'notes', ...args }, ctx(f)) as Promise<any[]>;
  assert.deepEqual(
    (await run({ query: 'WIDTH previous' })).map((r) => r.id),
    [b, a],
  );
  assert.deepEqual(
    (await run({ query: 'width sweep' })).map((r) => r.id),
    [a],
  );
  assert.deepEqual(
    (await run({ query: 'width previous', limit: 1, offset: 1 })).map((r) => r.id),
    [a],
  );
  assert.deepEqual(await run({ query: 'elsewhere' }), []);
});

test('research_status notes: % and _ in a query match themselves', async (t) => {
  const f = fixture(t);
  const pct = note(f, 'p', 'Gain 50% result', 'done');
  note(f, 'q', 'Gain 500 result', 'done');
  const under = note(f, 'u', 'run_a1 summary', 'done');
  note(f, 'v', 'runXa1 summary', 'done');
  const run = (query: string) =>
    researchTool('research_status', { collection: 'notes', query }, ctx(f)) as Promise<any[]>;
  assert.deepEqual(
    (await run('50%')).map((r) => r.id),
    [pct],
  );
  assert.deepEqual(
    (await run('run_a1')).map((r) => r.id),
    [under],
  );
  assert.deepEqual((await run('\\')).length, 0);
});

test('research_status notes: current=true leaves out replaced notes', async (t) => {
  const f = fixture(t);
  const a = note(f, 'a', 'Old finding', 'shared words');
  const b = saveNote(f.store, f.session.id, 'b', {
    kind: 'finding',
    title: 'New finding',
    body: 'shared words',
    evidence: ['x'],
    supersedes: [a],
  }).id;
  stamp(f, a, 1);
  stamp(f, b, 0);
  const run = (args: object) =>
    researchTool('research_status', { collection: 'notes', ...args }, ctx(f)) as Promise<any[]>;
  assert.deepEqual(
    (await run({})).map((r) => r.id),
    [b, a],
  );
  assert.deepEqual(
    (await run({ current: true })).map((r) => r.id),
    [b],
  );
  assert.deepEqual(
    (await run({ current: true, query: 'shared' })).map((r) => r.id),
    [b],
  );
});

test('research_status: query on another collection is an error', async (t) => {
  const f = fixture(t);
  for (const collection of ['workers', 'jobs', 'citations', 'usage'])
    await assert.rejects(
      researchTool('research_status', { collection, query: 'x' }, ctx(f)),
      /query works only with collection=notes/,
    );
  await assert.rejects(
    researchTool('research_status', { collection: 'jobs', current: true }, ctx(f)),
    /current works only with collection=notes/,
  );
});
