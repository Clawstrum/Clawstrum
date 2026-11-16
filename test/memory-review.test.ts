import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, settle } from './helpers.js';
import {
  ensureMemory,
  observeMemory,
  updateMemory,
  memoryFile,
  memoryTemplate,
  replaceInstructions,
} from '../src/memory.js';
import { archiveRecord, historyPage, historyBytes } from '../src/history.js';
import { consolidateMemory, consolidationCoverage } from '../src/consolidation.js';
import {
  requestMemoryReview,
  reviewCoverage,
  memoryReviewDue,
  memoryReviewKey,
} from '../src/memory-review.js';
import { saveNote, noteRevisions, renderNotes } from '../src/research/records.js';
import { Engine } from '../src/engine.js';

const sections = {
  'Working understanding': 'Use the measured setup for the current experiment.',
  'Current work': '',
  'Research state': '',
};
function result(p: any, extra: any = {}) {
  return JSON.stringify({
    chunk: p.chunk,
    sections,
    sources: p.sourceParts.map((s: any) => s.ref),
    ...extra,
  });
}
function settings(f: ReturnType<typeof fixture>) {
  return { ...f.config.runtime.consolidation, chunkChars: 2000, maxChunksPerPass: 1 };
}

test('semantic review retires an older note and misplaced instruction, preserves history and native session, and leaves rotation accounting intact', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  fs.writeFileSync(
    memoryFile(f.store, f.session.id),
    memoryTemplate(
      '## Instructions\nAlways assume the old setup for every experiment.\nKeep user autonomy.',
      'history',
    ),
  );
  const note = saveNote(f.store, f.session.id, 'old', {
    kind: 'method',
    title: 'old-tag',
    body: 'Use the old setup in every new study.',
  });
  const valid = saveNote(f.store, f.session.id, 'historical', {
    kind: 'finding',
    title: 'Experiment A result',
    body: 'Experiment A used the old setup successfully.',
  });
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'native-kept', f.session.id);
  archiveRecord(f.store, {
    id: 'correction',
    sessionId: f.session.id,
    kind: 'user',
    content:
      'For new studies use the measured setup. The prior universal assumption was wrong; the result in experiment A remains valid.',
    counted: true,
  });
  requestMemoryReview(f.store, f.session.id, 'Reconcile correction');
  const bytes = historyBytes(f.store, f.session.id, 0);
  let output = '';
  for (let n = 0; n < 30; n++) {
    const status = await consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: settings(f),
      review: true,
      force: true,
      call: async ({ prompt }) => {
        const p = JSON.parse(prompt);
        const seen = p.sourceParts.find((s: any) => s.id === 'correction');
        const actions = seen
          ? {
              instructionEdits: [
                {
                  before: 'Always assume the old setup for every experiment.',
                  after: '',
                  reason: 'Later user correction',
                  sources: [seen.ref],
                },
              ],
              retireNotes: [
                { id: note.id, reason: 'Universal assumption corrected', sources: [seen.ref] },
              ],
              sharedConcerns: [],
              groupConcerns: [],
            }
          : p.provisionalReviewActions;
        return result(p, {
          sections: {
            ...sections,
            'Research state':
              'Experiment A used the old setup successfully. Historical scope only.',
          },
          reviewActions: actions,
        });
      },
    });
    if (status === 'committed') {
      output = status;
      break;
    }
  }
  assert.equal(output, 'committed');
  const current = observeMemory(f.store, f.session.id);
  assert.doesNotMatch(current.instructions, /Always assume/);
  assert.match(current.instructions, /Keep user autonomy/);
  assert.match(current.memory, /Historical scope/);
  assert.match(noteRevisions(f.store, f.session.id, note.id).supersededBy!, /^memory-review:/);
  assert.equal(noteRevisions(f.store, f.session.id, valid.id).supersededBy, null);
  renderNotes(f.store, f.session.id);
  assert.doesNotMatch(
    observeMemory(f.store, f.session.id).memory,
    /Use the old setup in every new study/,
  );
  assert.equal(f.store.session(f.session.id).remote_id, 'native-kept');
  assert.equal(consolidationCoverage(f.store, f.session.id), 0);
  assert.ok(reviewCoverage(f.store, f.session.id) > 0);
  assert.equal(historyBytes(f.store, f.session.id, 0), bytes);
  assert.match(
    (historyPage(f.store, f.session.id, { action: 'read', id: `note:${note.id}` }) as any).content,
    /old setup/,
  );
  assert.equal(
    memoryReviewDue(
      f.store,
      f.session.id,
      { ...f.config.runtime.memoryReview, minIntervalMs: 0 },
      Date.now() + 31000,
    ),
    false,
    'own memory write does not schedule another review',
  );
});

test('maintenance patches cannot cross MEMORY, match ambiguously, or modify a concurrent revision', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const before = observeMemory(f.store, f.session.id);
  assert.throws(
    () => replaceInstructions(before, [{ before: '## MEMORY', after: '## Other' }]),
    /outside MEMORY|boundaries/,
  );
  assert.throws(() => replaceInstructions(before, [{ before: '', after: 'Oops' }]), /exactly once/);
  requestMemoryReview(f.store, f.session.id, 'review');
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: { ...settings(f), maxChunksPerPass: 20 },
      review: true,
      force: true,
      call: async ({ prompt }) => {
        updateMemory(f.store, f.session.id, { 'Current work': 'New user work' });
        return result(JSON.parse(prompt));
      },
    }),
    /conflict/,
  );
  assert.match(observeMemory(f.store, f.session.id).memory, /New user work/);
  assert.equal(
    f.store.get(
      'SELECT key FROM metadata WHERE key=?',
      `${memoryReviewKey(f.session.id)}:coverage`,
    ),
    undefined,
  );
});

test('review consumes the complete middle of long evidence, resumes, and rejects invented retirement provenance', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const text = 'X'.repeat(2700) + 'CORRECTION_IN_MIDDLE' + 'Y'.repeat(2700);
  archiveRecord(f.store, {
    id: 'long-evidence',
    sessionId: f.session.id,
    kind: 'user',
    content: text,
    counted: true,
  });
  let observed = '';
  let status = '';
  for (let i = 0; i < 10; i++) {
    status = await consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: settings(f),
      review: true,
      force: true,
      call: async ({ prompt }) => {
        const p = JSON.parse(prompt);
        observed += p.sourceParts.map((p: any) => p.text).join('');
        return result(p);
      },
    });
    if (status === 'committed') break;
  }
  assert.equal(status, 'committed');
  assert.equal(observed, text);
  requestMemoryReview(f.store, f.session.id, 'second');
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: settings(f),
      review: true,
      force: true,
      call: async ({ prompt }) =>
        result(JSON.parse(prompt), {
          reviewActions: {
            instructionEdits: [
              { before: 'nonexistent', after: '', reason: 'guess', sources: ['invented-source'] },
            ],
          },
        }),
    }),
    /verified source/,
  );
});

test('idle review is enabled by default, uses economical subscription capacity, and does not run a lead or reset it', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  f.config.runtime.memoryReview.debounceMs = 0;
  // Immediate re-ticks must still see the scan each time, not wait for scanIntervalMs.
  f.config.runtime.maintenance.scanIntervalMs = 0;
  const requests: any[] = [];
  const provider = {
    async run(r: any) {
      requests.push(r);
      return r.toolless ? result(JSON.parse(r.prompt)) : 'done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  try {
    f.enqueue('Use current evidence');
    engine.tick();
    await settle(engine);
    const leadCount = requests.length;
    engine.tick();
    await Promise.all([...engine.consolidations]);
    assert.equal(requests.length, leadCount + 1);
    assert.equal(requests.at(-1).account.model, 'sonnet');
    assert.deepEqual(requests.at(-1).account.modelFallbacks, []);
    assert.deepEqual(requests.at(-1).account.quotaBuckets, []);
    assert.equal(requests.at(-1).toolless, true);
    assert.ok(reviewCoverage(f.store, f.session.id) > 0);
    assert.equal(consolidationCoverage(f.store, f.session.id), 0);
    assert.equal(
      f.store.all("SELECT * FROM events WHERE type='memory_review_completed'").length,
      1,
    );
    engine.tick();
    await Promise.all([...engine.consolidations]);
    assert.equal(requests.length, leadCount + 1);
  } finally {
    await engine.stop();
  }
});

test('periodic shared review is independent of channel rotation and preserves global scope', async (t) => {
  const f = fixture(t);
  // Test both scopes without the production pacing delay between provider calls.
  f.config.runtime.maintenance.minIntervalMs = 0;
  // Immediate re-ticks must still see the scan each time, not wait for scanIntervalMs.
  f.config.runtime.maintenance.scanIntervalMs = 0;
  ensureMemory(f.store, null);
  f.config.runtime.consolidation.enabled = false;
  // The age-only run is off by default now; this test is about that opt-in run.
  f.config.runtime.memoryReview.intervalMs = 86400000;
  f.store.exec('UPDATE sessions SET created_at=?', Date.now() - 2 * 86400000);
  const requests: any[] = [];
  const provider = {
    async run(r: any) {
      const p = JSON.parse(r.prompt);
      requests.push(p);
      return result(p);
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  try {
    engine.tick();
    await Promise.all([...engine.consolidations]);
    // The default admits one background pass at a time; the other scope runs next.
    engine.tick();
    await Promise.all([...engine.consolidations]);
    assert.ok(requests.some((p) => p.scope === 'shared'));
    assert.ok(requests.some((p) => p.scope === 'channel'));
    assert.ok(reviewCoverage(f.store, null) > 0);
    assert.equal(consolidationCoverage(f.store, null), 0);
  } finally {
    await engine.stop();
  }
});

test('due rotation and its retry cooldown cannot starve a new corrective memory review', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  f.config.runtime.consolidation.thresholdBytes = 1;
  f.config.runtime.memoryReview.debounceMs = 0;
  f.config.runtime.memoryReview.minIntervalMs = 0;
  const requests: any[] = [];
  const provider = {
    async run(r: any) {
      const p = JSON.parse(r.prompt);
      requests.push(p);
      return result(p);
    },
  };
  archiveRecord(f.store, {
    id: 'user-correction',
    sessionId: f.session.id,
    kind: 'user',
    content:
      'Use measured artifacts for experiment B; the previous setup belonged to experiment A.',
    counted: true,
  });
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  // A failed rotation has its own backoff. The correction review is still eligible immediately.
  (engine as any).consolidationRetry.set(`${f.session.id}:rotation`, Date.now() + 60000);
  try {
    engine.tick();
    await Promise.all([...engine.consolidations]);
    assert.ok(requests.length > 0);
    assert.ok(reviewCoverage(f.store, f.session.id) > 0);
    assert.equal(consolidationCoverage(f.store, f.session.id), 0);
    assert.equal(
      f.store.all("SELECT * FROM events WHERE type='memory_review_completed'").length,
      1,
    );
  } finally {
    await engine.stop();
  }
});

test('a user request preempts review without committing, and partial coverage survives for retry', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  f.config.runtime.memoryReview.debounceMs = 0;
  f.config.runtime.maxConcurrent = 1;
  requestMemoryReview(f.store, f.session.id, 'review');
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const provider = {
    async run(r: any) {
      if (!r.toolless) return 'done';
      entered();
      return new Promise<string>((_, reject) =>
        r.controller.signal.addEventListener('abort', () => reject(r.controller.signal.reason), {
          once: true,
        }),
      );
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  try {
    engine.tick();
    await ready;
    f.enqueue('Correct the setup');
    engine.tick();
    await Promise.all([...engine.consolidations]);
    assert.equal(reviewCoverage(f.store, f.session.id), 0);
    assert.ok(f.store.get('SELECT key FROM metadata WHERE key=?', memoryReviewKey(f.session.id)));
    engine.tick();
    await settle(engine);
    assert.equal(
      f.store.get<any>("SELECT status FROM inbound WHERE id='Correct the setup'").status,
      'done',
    );
  } finally {
    await engine.stop();
  }
});

test('review side effects recover idempotently after atomic memory replacement and preserve a newer note replacement', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const old = saveNote(f.store, f.session.id, 'old', {
    kind: 'decision',
    title: 'old',
    body: 'Old assumption',
  });
  const replacement = saveNote(f.store, f.session.id, 'new', {
    kind: 'decision',
    title: 'new',
    body: 'Current correction',
    supersedes: [old.id],
  });
  const { finishMemoryReview, emptyReviewActions } = await import('../src/memory-review.js');
  archiveRecord(f.store, {
    id: 'memory-review:recovery',
    sessionId: f.session.id,
    kind: 'memory_review',
    content: 'Prepared intent',
  });
  const actions = {
    ...emptyReviewActions(),
    retireNotes: [
      {
        id: old.id,
        reason: 'Another retirement proposed earlier',
        sources: ['note:' + replacement.id],
      },
    ],
  };
  finishMemoryReview(f.store, f.session.id, 'recovery', actions);
  finishMemoryReview(f.store, f.session.id, 'recovery', actions);
  assert.equal(noteRevisions(f.store, f.session.id, old.id).supersededBy, replacement.id);
  assert.equal(
    f.store.get<any>(
      'SELECT replacement_id FROM history_supersessions WHERE previous_id=?',
      `note:${old.id}`,
    ).replacement_id,
    `note:${replacement.id}`,
  );
});

test('a local shared-policy concern queues owning review with evidence pointers rather than exporting the whole channel', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  archiveRecord(f.store, {
    id: 'correction',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Apply the new memory policy globally. Private unrelated detail.',
    counted: true,
  });
  await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: { ...settings(f), maxChunksPerPass: 20 },
    review: true,
    force: true,
    call: async ({ prompt }) => {
      const p = JSON.parse(prompt);
      return result(p, {
        reviewActions: {
          sharedConcerns: [
            {
              reason: 'Shared append-only instructions conflict with the current memory policy.',
              sources: ['correction'],
            },
          ],
        },
      });
    },
  });
  const rows = f.store.all<any>(
    "SELECT content FROM history_records WHERE session_id IS NULL AND kind='memory_review_request'",
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, /append-only/);
  assert.doesNotMatch(rows[0].content, /Private unrelated detail/);
  assert.match(rows[0].content, /records/);
});

test('channel correction reaches the existing group reviewer and cannot target unrelated groups', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const { createGroup, recordGroupChannel, setGroupMembership, getGroup } =
    await import('../src/groups/store.js');
  const { reviewGroup } = await import('../src/groups/review.js');
  createGroup(f.store, 'science', 'Science');
  recordGroupChannel(f.store, f.session, 'analysis');
  setGroupMembership(f.store, 'science', f.session.id, true);
  archiveRecord(f.store, {
    id: 'correction',
    sessionId: f.session.id,
    kind: 'user',
    content: 'The current experiment changed design; previous results describe experiment A only.',
    counted: true,
  });
  await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: { ...settings(f), maxChunksPerPass: 20 },
    review: true,
    force: true,
    call: async ({ prompt }) => {
      const p = JSON.parse(prompt);
      return result(p, {
        reviewActions: {
          groupConcerns: [
            {
              groupId: 'science',
              reason:
                'Check whether the old design is presented as the default rather than scoped to experiment A.',
              sources: ['correction'],
            },
          ],
        },
      });
    },
  });
  assert.equal(
    f.store.all(
      "SELECT id FROM history_records WHERE group_id='science' AND kind='group_memory_consistency'",
    ).length,
    1,
  );
  assert.ok(getGroup(f.store, 'science').dirty_since);
  let seen = '';
  await reviewGroup({
    store: f.store,
    groupId: 'science',
    config: f.config.groups.reviewer,
    signal: new AbortController().signal,
    call: async ({ prompt }) => {
      seen += prompt;
      const p = JSON.parse(prompt);
      return JSON.stringify({ chunk: p.chunk, notes: 'Scope checked', operations: [] });
    },
  });
  assert.match(seen, /previous results|old design/);
  requestMemoryReview(f.store, f.session.id, 'new');
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: settings(f),
      review: true,
      force: true,
      call: async ({ prompt }) =>
        result(JSON.parse(prompt), {
          reviewActions: {
            groupConcerns: [
              { groupId: 'unrelated', reason: 'Not allowed', sources: ['correction'] },
            ],
          },
        }),
    }),
    /outside channel groups|verified source/,
  );
});

test('review condenses legacy reference inventories while mechanically retaining registered live jobs and script paths', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const before = updateMemory(f.store, f.session.id, {
    'Current work':
      '#### Retained references (unresolved or needed for retrieval)\n`task-1787104355286-i6y6a0`; `/tmp/obsolete-review.log`; `/New_York`; `/3/4/5`.',
  });
  f.store.exec(
    'INSERT INTO cluster_jobs(id,session_id,dedupe_key,spec_json,script_path,script_hash,config_json,preflight_json,status,job_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    'active-job',
    f.session.id,
    'active-job',
    '{}',
    '/work/active-job.sbatch',
    'hash',
    '{}',
    '{}',
    'running',
    '812345',
    Date.now(),
    Date.now(),
  );
  requestMemoryReview(f.store, f.session.id, 'Review stale reference lists');
  const status = await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: { ...settings(f), maxChunksPerPass: 20 },
    review: true,
    force: true,
    call: async ({ prompt }) => {
      const p = JSON.parse(prompt);
      assert.deepEqual(p.requiredWorkReferences, {});
      return result(p, {
        sections: {
          ...sections,
          'Current work': `Old retrieval inventory remains in history:memory:${f.session.id}:${before.revision}. Check registered active work before repeating external actions.`,
        },
      });
    },
  });
  assert.equal(status, 'committed');
  const memory = observeMemory(f.store, f.session.id).memory;
  assert.doesNotMatch(memory, /task-1787104355286|obsolete-review|New_York|\/3\/4\/5/);
  assert.match(memory, /active-job/);
  assert.match(memory, /812345/);
  assert.match(memory, /\/work\/active-job.sbatch/);
  assert.match(
    (
      historyPage(f.store, f.session.id, {
        action: 'read',
        id: `memory:${f.session.id}:${before.revision}`,
      }) as any
    ).content,
    /task-1787104355286/,
  );
});

test('combined short citations expand every verified reference and reject unknown members', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  for (const id of ['one', 'two'])
    archiveRecord(f.store, {
      id,
      sessionId: f.session.id,
      kind: 'user',
      content: id,
      counted: true,
    });
  await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: { ...settings(f), maxChunksPerPass: 20 },
    review: true,
    force: true,
    call: async ({ prompt }) =>
      result(JSON.parse(prompt), {
        sections: { ...sections, 'Working understanding': 'Supported conclusion [source:s1, s2].' },
      }),
  });
  const text = observeMemory(f.store, f.session.id).memory;
  assert.match(text, /history:one history:two/);
  assert.doesNotMatch(text, /\[source:/);
  requestMemoryReview(f.store, f.session.id, 'Validate next citation');
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: settings(f),
      review: true,
      force: true,
      call: async ({ prompt }) =>
        result(JSON.parse(prompt), {
          sections: { ...sections, 'Working understanding': 'Wrong [source:s1,s900].' },
        }),
    }),
    /Unknown source reference s900/,
  );
});
