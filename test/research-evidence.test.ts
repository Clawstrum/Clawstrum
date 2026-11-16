import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, settle } from './helpers.js';
import { saveNote, noteRevisions } from '../src/research/records.js';
import { refreshClaimEvidence, noteClaim, claimIndex } from '../src/research/claims.js';
import { fingerprint } from '../src/research/evidence.js';
import { researchTool } from '../src/research/tools.js';
import { researchManifest } from '../src/research/manifests.js';
import { archiveRecord, historyPage } from '../src/history.js';
import { ensureMemory, observeMemory } from '../src/memory.js';
import { consolidateMemory } from '../src/consolidation.js';
import { Engine } from '../src/engine.js';
import { buildContext } from '../src/context.js';

const spec = (file: string, run = 'run-B') => ({
  subject: 'project membership method',
  scope: { project: 'study', run, version: 'v2', surface: 'execution' as const },
  basis: 'observation' as const,
  sources: [{ file }],
});
function setup(t: any) {
  const f = fixture(t);
  ensureMemory(f.store, null);
  ensureMemory(f.store, f.session.id);
  const file = path.join(f.session.workspace, 'method.json');
  fs.writeFileSync(file, '{"method":"Louvain"}');
  return { ...f, file };
}
test('registered evidence changes are detected by content, queued once, and retain raw provenance', async (t) => {
  const f = setup(t);
  const note = saveNote(f.store, f.session.id, 'method', {
    kind: 'method',
    title: 'B method',
    body: 'B uses Louvain.',
    claim: spec(f.file),
  });
  await refreshClaimEvidence(f.store, f.session.id);
  const baseline = noteClaim(f.store, f.session.id, note.id)!;
  assert.equal(baseline.status, 'unchanged');
  const before = fs.statSync(f.file);
  fs.writeFileSync(f.file, '{"method":"Judging"}'); // same byte length, restored timestamp
  fs.utimesSync(f.file, before.atime, before.mtime);
  await refreshClaimEvidence(f.store, f.session.id);
  assert.equal(noteClaim(f.store, f.session.id, note.id)!.status, 'changed');
  const requests = () =>
    f.store.all("SELECT id FROM history_records WHERE kind='memory_review_request'").length;
  assert.equal(requests(), 1);
  await refreshClaimEvidence(f.store, f.session.id);
  assert.equal(requests(), 1);
  assert.equal(noteRevisions(f.store, f.session.id, note.id).supersededBy, null);
  assert.match(observeMemory(f.store, f.session.id).memory, /"evidenceStatus": "changed"/);
  assert.deepEqual(noteClaim(f.store, f.session.id, note.id)!.baseline, baseline.baseline);
  assert.match(
    (historyPage(f.store, f.session.id, { action: 'read', id: `note:${note.id}` }) as any).content,
    /B uses Louvain/,
  );
});

test('user decisions require scoped user evidence and assistant repetition cannot become that evidence', async (t) => {
  const f = setup(t);
  archiveRecord(f.store, {
    id: 'assistant-guess',
    sessionId: f.session.id,
    kind: 'assistant',
    content: 'We chose A.',
  });
  const claim = {
    ...spec(f.file),
    basis: 'user_decision' as const,
    sources: [{ historyId: 'assistant-guess' }],
  };
  assert.throws(
    () =>
      saveNote(f.store, f.session.id, 'bad', { kind: 'decision', title: 'bad', body: 'A', claim }),
    /actual user history/,
  );
  archiveRecord(f.store, {
    id: 'user-choice',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Use B.',
  });
  const good = saveNote(f.store, f.session.id, 'good', {
    kind: 'decision',
    title: 'choice',
    body: 'B',
    claim: { ...claim, sources: [{ historyId: 'user-choice' }] },
  });
  await refreshClaimEvidence(f.store, f.session.id);
  assert.equal(noteClaim(f.store, f.session.id, good.id)!.observations[0]!.kind, 'user');
  assert.throws(
    () =>
      saveNote(f.store, f.session.id, 'missing', {
        kind: 'finding',
        title: 'bad',
        body: 'B',
        claim: { ...claim, sources: [{ historyId: 'missing' }] },
      }),
    /must exist/,
  );
  const other = f.store.ensureSession('another-channel');
  archiveRecord(f.store, {
    id: 'private-other',
    sessionId: other.id,
    kind: 'user',
    content: 'private',
  });
  assert.throws(
    () =>
      saveNote(f.store, f.session.id, 'foreign', {
        kind: 'decision',
        title: 'bad',
        body: 'B',
        claim: { ...claim, sources: [{ historyId: 'private-other' }] },
      }),
    /this conversation/,
  );
});

test('unavailable evidence and symlink retargeting are visible without retiring claims', async (t) => {
  const f = setup(t);
  const target = path.join(f.session.workspace, 'other.json');
  fs.writeFileSync(target, 'other');
  const link = path.join(f.session.workspace, 'latest.json');
  fs.symlinkSync(f.file, link);
  const note = saveNote(f.store, f.session.id, 'link', {
    kind: 'finding',
    title: 'latest',
    body: 'B',
    claim: spec(link),
  });
  await refreshClaimEvidence(f.store, f.session.id);
  fs.unlinkSync(link);
  fs.symlinkSync(target, link);
  await refreshClaimEvidence(f.store, f.session.id);
  assert.equal(noteClaim(f.store, f.session.id, note.id)!.status, 'changed');
  fs.unlinkSync(target);
  await refreshClaimEvidence(f.store, f.session.id);
  assert.equal(noteClaim(f.store, f.session.id, note.id)!.status, 'unavailable');
  await assert.rejects(fingerprint(f.session.workspace), /regular file/);
  await assert.rejects(fingerprint(f.file, 1), /observation budget/);
});

test('revisions are idempotent and scoped; superseding B preserves A across store reopening', async (t) => {
  const f = setup(t);
  const a = saveNote(f.store, f.session.id, 'A', {
    kind: 'finding',
    title: 'A',
    body: 'Historical A result',
    claim: spec(f.file, 'run-A'),
  });
  const b = saveNote(f.store, f.session.id, 'B', {
    kind: 'method',
    title: 'B',
    body: 'B old method',
    claim: spec(f.file),
  });
  await refreshClaimEvidence(f.store, f.session.id);
  const input = {
    kind: 'method' as const,
    title: 'B new',
    body: 'B current method',
    supersedes: [b.id],
    claim: { ...spec(f.file), scope: { ...spec(f.file).scope, version: 'v3' } },
  };
  const newer = saveNote(f.store, f.session.id, 'B-new', input);
  assert.equal(saveNote(f.store, f.session.id, 'B-new', input).id, newer.id);
  assert.throws(
    () => saveNote(f.store, f.session.id, 'B-new', { ...input, claim: spec(f.file) }),
    /different content/,
  );
  await refreshClaimEvidence(f.store, f.session.id);
  assert.deepEqual(
    new Set(claimIndex(f.store, f.session.id).map((c) => c.noteId)),
    new Set([a.id, newer.id]),
  );
  assert.doesNotMatch(observeMemory(f.store, f.session.id).memory, /B old method/);
  assert.match(observeMemory(f.store, f.session.id).memory, /Historical A result/);
  // A separate process/Store sees the same durable metadata (no process-local provenance).
  const { Store } = await import('../src/store.js');
  const reopened = new Store(f.home);
  try {
    assert.equal(noteClaim(reopened, f.session.id, newer.id)!.spec.scope.version, 'v3');
  } finally {
    reopened.close();
  }
});

test('manifests detect partial deployments and changed same-size files, preserve immutable identity, and support copied deployment files', async (t) => {
  const f = setup(t);
  const view = path.join(f.session.workspace, 'view.json');
  fs.writeFileSync(view, 'old');
  const input = {
    action: 'record',
    key: 'release',
    identity: {
      project: 'study',
      run: 'B',
      version: 'fix27',
      method: 'Louvain + judge labels',
      surface: 'deployment',
    },
    files: [
      { id: 'graph', role: 'output', file: f.file },
      { id: 'view', role: 'view', file: view },
    ],
  };
  const manifest = (await researchManifest(f.store, f.session.id, 'test', input)) as any;
  const verify = (locations: any[] = []) =>
    researchManifest(f.store, f.session.id, 'test', {
      action: 'verify',
      manifest: manifest.file,
      locations,
    }) as Promise<any>;
  assert.equal((await verify()).matches, true);
  const copy = path.join(f.session.workspace, 'downloaded-view.json');
  fs.copyFileSync(view, copy);
  assert.equal((await verify([{ id: 'view', file: copy }])).matches, true);
  fs.writeFileSync(view, 'new');
  const result = await verify();
  assert.equal(result.matches, false);
  assert.deepEqual(
    result.files.map((f: any) => f.status),
    ['match', 'changed'],
  );
  assert.equal(
    ((await researchManifest(f.store, f.session.id, 'test', input)) as any).file,
    manifest.file,
  );
  await assert.rejects(
    researchManifest(f.store, f.session.id, 'test', {
      ...input,
      identity: { ...input.identity, version: 'fix28' },
    }),
    /different specification/,
  );
  await assert.rejects(verify([{ id: 'unknown', file: copy }]), /distinct IDs/);
  assert.equal((await fingerprint(manifest.file)).sha256, manifest.sha256);
  fs.unlinkSync(view);
  assert.equal((await verify()).files[1].status, 'unavailable');
});

test('a maintenance reviewer gets explicitly refreshed dependency evidence and can look up the changed source, retaining design/execution/deployment scope after rotation', async (t) => {
  const f = setup(t);
  const note = saveNote(f.store, f.session.id, 'method', {
    kind: 'method',
    title: 'execution',
    body: 'B uses Louvain',
    claim: spec(f.file),
  });
  await refreshClaimEvidence(f.store, f.session.id);
  fs.writeFileSync(
    f.file,
    'B execution: Louvain with judge labels. Deployed older view: judge memberships.',
  );
  await refreshClaimEvidence(f.store, f.session.id);
  let lookedUp = false;
  const preserved =
    'Run B executes Louvain with judge labels; its older deployed view still uses judge memberships. These are different surfaces. Run A remains valid.';
  for (let i = 0; i < 30; i++) {
    const status = await consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: { ...f.config.runtime.consolidation, chunkChars: 4000, maxChunksPerPass: 1 },
      force: true,
      review: true,
      call: async ({ prompt }) => {
        const p = JSON.parse(prompt);
        assert.equal(p.claimEvidence.find((c: any) => c.noteId === note.id).status, 'changed');
        if (!lookedUp && !p.retrievedEvidence.length)
          return JSON.stringify({ lookup: { file: f.file } });
        if (p.retrievedEvidence.length) {
          assert.match(p.retrievedEvidence[0].content, /older view/);
          lookedUp = true;
        }
        return JSON.stringify({
          chunk: p.chunk,
          sections: {
            'Working understanding': preserved,
            'Current work': 'Reconcile the viewer',
            'Research state': '',
          },
          sources: p.sourceParts.map((s: any) => s.ref),
        });
      },
    });
    if (status === 'committed') break;
  }
  assert.equal(lookedUp, true);
  const context = buildContext(
    f.store,
    f.store.session(f.session.id),
    f.config.accounts[0]!,
    [],
    64000,
    240000,
    f.config.research,
  );
  assert.match(context.instructions, /Run B executes Louvain/);
  assert.match(context.instructions, /Run A remains valid/);
  assert.equal(
    noteRevisions(f.store, f.session.id, note.id).supersededBy,
    null,
    'file changes alone do not retire findings',
  );
});

test('lead turns and status preserve observations; explicit refresh detects changed evidence', async (t) => {
  const f = setup(t);
  const ctx = { store: f.store, sessionId: f.session.id, config: f.config, scope: 'test' };
  const note = (await researchTool(
    'research_note',
    { key: 'tool', kind: 'method', title: 'method', body: 'B', claim: spec(f.file) },
    ctx,
  )) as any;
  assert.equal(note.claim.status, 'unverified');
  await researchTool('research_status', { collection: 'notes', refresh: true }, ctx);
  const checkedAt = noteClaim(f.store, f.session.id, note.id)!.checkedAt;
  fs.writeFileSync(f.file, 'changed');
  let inspected = false;
  const provider = {
    async run(request: any) {
      assert.match(request.instructions, /"evidenceStatus": "unchanged"/);
      assert.match(request.instructions, /last-observed/);
      inspected = true;
      return 'Checked';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  f.enqueue('explain current method');
  await engine.tick();
  await settle(engine);
  assert.equal(inspected, true);
  const rows = (await researchTool('research_status', { collection: 'notes' }, ctx)) as any[];
  assert.equal(rows[0].claim.status, 'unchanged');
  assert.equal(noteClaim(f.store, f.session.id, note.id)!.checkedAt, checkedAt);
  const refreshed = (await researchTool(
    'research_status',
    { collection: 'notes', refresh: true },
    ctx,
  )) as any[];
  assert.equal(refreshed[0].claim.status, 'changed');
  await engine.stop();
});

test('native compaction restores saved evidence without rehashing dependencies and keeps historical scopes', async (t) => {
  const f = setup(t);
  const note = saveNote(f.store, f.session.id, 'native', {
    kind: 'method',
    title: 'B',
    body: 'Run B uses Louvain; A is separately scoped.',
    claim: spec(f.file),
  });
  await refreshClaimEvidence(f.store, f.session.id);
  fs.writeFileSync(f.file, 'revised method');
  const { compactionHooks } = await import('../src/compaction.js');
  const controller = new AbortController();
  const hooks = compactionHooks({
    account: f.config.accounts[0]!,
    prompt: '',
    instructions: '',
    cwd: f.session.workspace,
    research: f.config.research,
    controller,
    env: {},
    mcp: {
      command: process.execPath,
      args: [],
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id },
    },
    onEvent() {},
  });
  try {
    const callback = hooks.hooks!.SessionStart![0]!.hooks[0]!;
    const result: any = await callback(
      {
        hook_event_name: 'SessionStart',
        session_id: 'native',
        cwd: f.session.workspace,
        transcript_path: '',
        source: 'compact',
        model: 'claude',
      } as any,
      undefined,
      { signal: controller.signal },
    );
    assert.match(result.hookSpecificOutput.additionalContext, /"evidenceStatus": "unchanged"/);
    assert.match(result.hookSpecificOutput.additionalContext, /last-observed/);
    assert.match(result.hookSpecificOutput.additionalContext, /A is separately scoped/);
    assert.equal(noteClaim(f.store, f.session.id, note.id)!.status, 'unchanged');
  } finally {
    hooks.close();
  }
});

test('an explicitly expected artifact hash is checked on first observation and a superseded history source becomes uncertain', async (t) => {
  const f = setup(t);
  const note = saveNote(f.store, f.session.id, 'expected', {
    kind: 'method',
    title: 'B',
    body: 'B',
    claim: { ...spec(f.file), sources: [{ file: f.file, sha256: '0'.repeat(64) }] },
  });
  await refreshClaimEvidence(f.store, f.session.id);
  assert.equal(noteClaim(f.store, f.session.id, note.id)!.status, 'changed');
  archiveRecord(f.store, {
    id: 'source-old',
    sessionId: f.session.id,
    kind: 'assistant',
    content: 'A guess',
  });
  archiveRecord(f.store, {
    id: 'source-new',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Corrected',
  });
  const derived = saveNote(f.store, f.session.id, 'history-dependent', {
    kind: 'finding',
    title: 'guess',
    body: 'guess',
    claim: { ...spec(f.file), basis: 'inference', sources: [{ historyId: 'source-old' }] },
  });
  await refreshClaimEvidence(f.store, f.session.id);
  const { supersedeHistory } = await import('../src/history.js');
  supersedeHistory(f.store, 'source-old', 'source-new');
  await refreshClaimEvidence(f.store, f.session.id);
  assert.equal(noteClaim(f.store, f.session.id, derived.id)!.status, 'changed');
  assert.equal(noteRevisions(f.store, f.session.id, derived.id).supersededBy, null);
});

test('portable export includes claim scope and observed fingerprints with the raw history', async (t) => {
  const f = setup(t);
  const note = saveNote(f.store, f.session.id, 'exported', {
    kind: 'method',
    title: 'B',
    body: 'B uses Louvain',
    claim: spec(f.file),
  });
  await refreshClaimEvidence(f.store, f.session.id);
  const { spawnSync } = await import('node:child_process');
  const { saveConfig } = await import('../src/config.js');
  saveConfig(f.home, f.config);
  const file = path.join(f.home, 'export.json');
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.resolve('src/cli.ts'), 'export', f.session.id, file],
    { env: { ...process.env, CLAWSTRUM_HOME: f.home }, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(
    exported.researchNotes.find((n: any) => n.id === note.id).claim.baseline[0].sha256,
    (await fingerprint(f.file)).sha256,
  );
  assert.ok(exported.history.some((r: any) => r.kind === 'research_claim'));
});
