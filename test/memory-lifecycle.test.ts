import { migrateMemory } from '../src/migration/memory-run.js';
import { spawnSync } from 'node:child_process';
import { saveConfig } from '../src/config.js';
import { StreamHistory } from '../src/provider-history.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { configSchema } from '../src/config.js';
import {
  ensureMemory,
  observeMemory,
  updateMemory,
  parseMemory,
  memoryTemplate,
  memoryFile,
  replaceSections,
  nestMemoryContent,
} from '../src/memory.js';
import {
  archiveRecord,
  historyPage,
  historyBytes,
  historyPosition,
  repairHistory,
  historyFile,
  historyHash,
  archiveProviderRecord,
} from '../src/history.js';
import { consolidateMemory, consolidationCoverage } from '../src/consolidation.js';
import {
  prepareMemoryMigration,
  finishMemoryMigration,
  moveChannelWorkspaces,
} from '../src/migration/memory.js';
import { readInstructionSnapshot } from '../src/instructions.js';
import { saveNote } from '../src/research/records.js';

test('memory section updates preserve instructions and fenced headings; stale revisions refuse replacement', (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const file = memoryFile(f.store, f.session.id);
  fs.writeFileSync(
    file,
    memoryTemplate(
      '# Agent\r\n\n```md\n## MEMORY\n```\n\n## Instructions\nKeep THIS exactly.',
      path.join(f.session.workspace, 'history'),
    ) + '\n## Other\nPreserve after memory.\n',
  );
  const before = observeMemory(f.store, f.session.id);
  const after = updateMemory(
    f.store,
    f.session.id,
    { 'Current work': 'New work; active job 7721' },
    before.revision,
  );
  assert.equal(after.instructions, before.instructions);
  assert.match(after.memory, /7721/);
  assert.throws(
    () => updateMemory(f.store, f.session.id, { 'Current work': 'STALE' }, before.revision),
    /conflict/,
  );
  assert.throws(
    () => updateMemory(f.store, f.session.id, { 'Current work': '## Instructions\nOVERWRITE' }),
    /instructions/,
  );
  assert.throws(() => parseMemory('## MEMORY\n## MEMORY\n'), /exactly one/);
  const archived = historyPage(f.store, f.session.id, {
    action: 'search',
    query: 'New work',
  }) as any;
  assert.ok(archived.records.length);
});

test('complete history is deduplicated, searchable, paginated, and repairs missing archive files', (t) => {
  const f = fixture(t);
  const content = 'a'.repeat(22000) + 'MIDDLE_NEEDLE' + 'z'.repeat(22000);
  const input = {
    id: 'large',
    sessionId: f.session.id,
    kind: 'tool_result',
    content,
    counted: true,
  };
  const row = archiveRecord(f.store, input);
  archiveRecord(f.store, input);
  assert.equal(historyBytes(f.store, f.session.id, 0), Buffer.byteLength(content));
  assert.equal(
    (historyPage(f.store, f.session.id, { action: 'search', query: 'MIDDLE_NEEDLE' }) as any)
      .records.length,
    1,
  );
  let read = '',
    offset = 0;
  for (;;) {
    const result = historyPage(f.store, f.session.id, {
      action: 'read',
      id: 'large',
      offset,
      chars: 2000,
    }) as any;
    read += result.content;
    if (result.nextOffset === null) break;
    offset = result.nextOffset;
  }
  assert.equal(read, content);
  fs.unlinkSync(historyFile(f.store, row));
  repairHistory(f.store);
  assert.ok(fs.existsSync(historyFile(f.store, row)));
});

test('shared and channel memory refresh as facts, never standing instructions', (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null, 'SHARED_POLICY');
  updateMemory(f.store, null, { 'Working understanding': 'CURRENT_SHARED_FACT' });
  updateMemory(f.store, f.session.id, { 'Current work': 'CHANNEL_FACT' });
  const sources = {
    home: f.home,
    workspace: f.session.workspace,
    profile: f.config.accounts[0]!.home,
    maxChars: 100000,
  };
  const before = readInstructionSnapshot(sources);
  assert.match(before.instructions, /SHARED_POLICY/);
  assert.doesNotMatch(before.instructions, /CURRENT_SHARED_FACT|CHANNEL_FACT/);
  assert.match(before.memory, /CURRENT_SHARED_FACT/);
  assert.match(before.memory, /CHANNEL_FACT/);
  updateMemory(f.store, null, { 'Working understanding': 'REPLACEMENT_FACT' });
  const after = readInstructionSnapshot(sources);
  assert.equal(after.instructionRevision, before.instructionRevision);
  assert.notEqual(after.memoryRevision, before.memoryRevision);
  assert.doesNotMatch(after.memory, /CURRENT_SHARED_FACT/);
});

test('consolidation processes middle content across resumable chunks and rotates only after commit', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'native-before', f.session.id);
  const raw = 'A'.repeat(2700) + 'DECISION_CHANGED_TO_B' + 'Z'.repeat(2700);
  archiveRecord(f.store, {
    id: 'source',
    sessionId: f.session.id,
    kind: 'user',
    content: raw,
    counted: true,
  });
  const observed: string[] = [];
  const call = async ({ prompt }: any) => {
    const p = JSON.parse(prompt);
    for (const part of p.sourceParts) observed.push(part.text);
    return JSON.stringify({
      chunk: p.chunk,
      sections: {
        'Working understanding':
          'Current B (observed 2026-09-21; supersedes history:old; source history:source).',
        'Current work': 'Keep job 901',
        'Research state': '',
      },
      sources: p.sourceParts.map((p: any) => p.id),
    });
  };
  const config = {
    ...f.config.runtime.consolidation,
    thresholdBytes: 1,
    chunkChars: 2000,
    maxChunksPerPass: 1,
  };
  const first = await consolidateMemory({ store: f.store, sessionId: f.session.id, config, call });
  assert.equal(first, 'pending');
  assert.equal(f.store.session(f.session.id).remote_id, 'native-before');
  assert.equal(consolidationCoverage(f.store, f.session.id), 0);
  let status = first;
  for (let i = 0; i < 10 && status === 'pending'; i++)
    status = (await consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config,
      call,
    })) as any;
  assert.equal(status, 'committed');
  assert.equal(observed.join(''), raw);
  assert.equal(f.store.session(f.session.id).remote_id, null);
  assert.match(observeMemory(f.store, f.session.id).memory, /Current B/);
  assert.ok(consolidationCoverage(f.store, f.session.id) > 0);
});

test('failed or conflicting consolidation never rotates or advances coverage', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'keep-native', f.session.id);
  archiveRecord(f.store, {
    id: 'source',
    sessionId: f.session.id,
    kind: 'user',
    content: 'important middle fact',
    counted: true,
  });
  const config = { ...f.config.runtime.consolidation, thresholdBytes: 1 };
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config,
      call: async () => '{bad json',
    }),
  );
  assert.equal(f.store.session(f.session.id).remote_id, 'keep-native');
  assert.equal(consolidationCoverage(f.store, f.session.id), 0);
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config,
      call: async ({ prompt }) => {
        const p = JSON.parse(prompt);
        updateMemory(f.store, f.session.id, { 'Current work': 'newer edit survives' });
        return JSON.stringify({
          chunk: p.chunk,
          sections: {
            'Working understanding': 'stale',
            'Current work': 'stale',
            'Research state': '',
          },
          sources: [],
        });
      },
    }),
    /conflicts/,
  );
  assert.match(observeMemory(f.store, f.session.id).memory, /newer edit survives/);
  assert.equal(f.store.session(f.session.id).remote_id, 'keep-native');
});

test('superseded research decisions stay in raw history and disappear from active AGENTS', (t) => {
  const f = fixture(t);
  const old = saveNote(f.store, f.session.id, 'a', {
    kind: 'decision',
    title: 'Protocol',
    body: 'STALE_PROTOCOL_A',
  });
  saveNote(f.store, f.session.id, 'b', {
    kind: 'decision',
    title: 'Protocol',
    body: 'CURRENT_PROTOCOL_B',
    supersedes: [old.id],
  });
  const text = fs.readFileSync(memoryFile(f.store, f.session.id), 'utf8');
  assert.match(text, /CURRENT_PROTOCOL_B/);
  assert.doesNotMatch(text, /STALE_PROTOCOL_A/);
  assert.match(text, new RegExp(old.id));
  const archived = historyPage(f.store, f.session.id, {
    action: 'read',
    id: `note:${old.id}`,
  }) as any;
  assert.match(archived.content, /STALE_PROTOCOL_A/);
  assert.ok(archived.supersededBy);
  assert.ok(!fs.existsSync(path.join(f.session.workspace, 'research', 'RECORDS.md')));
});

test('migration archives old documents before retirement and moves channels with compatibility links', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const legacy = path.join(f.session.workspace, 'MEMORY.md');
  fs.writeFileSync(legacy, 'Old A; later corrected to B');
  const before = historyPosition(f.store, f.session.id);
  const plan = prepareMemoryMigration(f.store);
  assert.ok(plan.some((p) => p.sessionId === f.session.id && p.pending));
  assert.ok(fs.existsSync(legacy));
  assert.ok(historyPosition(f.store, f.session.id) > before);
  assert.throws(() => finishMemoryMigration(f.store, f.session.id), /Complete migration/);
  await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: f.config.runtime.consolidation,
    force: true,
    call: async ({ prompt }) => {
      const p = JSON.parse(prompt);
      return JSON.stringify({
        chunk: p.chunk,
        sections: {
          'Working understanding': 'Current B',
          'Current work': '',
          'Research state': '',
        },
        sources: p.sourceParts.map((p: any) => p.id),
      });
    },
  });
  finishMemoryMigration(f.store, f.session.id);
  assert.ok(!fs.existsSync(legacy));
  const root = path.join(f.home, 'relocated-channels');
  moveChannelWorkspaces(f.store, root);
  const current = f.store.session(f.session.id);
  assert.equal(current.workspace, path.join(root, f.session.channel_id));
  assert.equal(fs.realpathSync(f.session.workspace), current.workspace);
  assert.equal(f.store.ensureSession('111111').workspace, path.join(root, '111111'));
  assert.equal(configSchema.parse(f.config).runtime.consolidation.enabled, true);
});

test('migration archives memory directories and working documents no instruction file imports', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const sharedDirectory = path.join(f.home, 'memory');
  fs.mkdirSync(sharedDirectory, { recursive: true });
  fs.writeFileSync(path.join(sharedDirectory, 'cluster.md'), 'SHARED_CLUSTER_FACT');
  const channelDirectory = path.join(f.session.workspace, 'memory');
  fs.mkdirSync(path.join(channelDirectory, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(channelDirectory, 'topic.md'), 'CHANNEL_TOPIC_FACT');
  fs.writeFileSync(path.join(channelDirectory, 'aside.txt'), 'NOT_MARKDOWN');
  fs.writeFileSync(path.join(channelDirectory, 'knowledge', 'deep.md'), 'NESTED_NOT_MEMORY');
  const working = path.join(f.session.workspace, '.working-memory.md');
  fs.writeFileSync(working, 'CHANNEL_WORKING_STATE');
  const conversation = path.join(f.session.workspace, '.conversation-state.md');
  fs.writeFileSync(conversation, 'CHANNEL_CONVERSATION_STATE');
  prepareMemoryMigration(f.store);
  const archived = f.store.all<{ session_id: string | null; source: string; content: string }>(
    "SELECT session_id,source,content FROM history_records WHERE kind='legacy_memory'",
  );
  const contents = archived.map((record) => record.content).join('\n');
  assert.match(contents, /SHARED_CLUSTER_FACT/);
  assert.match(contents, /CHANNEL_TOPIC_FACT/);
  assert.match(contents, /CHANNEL_WORKING_STATE/);
  assert.match(contents, /CHANNEL_CONVERSATION_STATE/);
  assert.doesNotMatch(contents, /NOT_MARKDOWN/);
  assert.doesNotMatch(contents, /NESTED_NOT_MEMORY/);
  assert.equal(archived.find((record) => /cluster\.md$/.test(record.source))!.session_id, null);
  assert.equal(
    archived.find((record) => /topic\.md$/.test(record.source))!.session_id,
    f.session.id,
  );
  const consolidate = (sessionId: string | null) =>
    consolidateMemory({
      store: f.store,
      sessionId,
      config: f.config.runtime.consolidation,
      force: true,
      call: async ({ prompt }) => {
        const p = JSON.parse(prompt);
        return JSON.stringify({
          chunk: p.chunk,
          sections: {
            'Working understanding': 'Merged',
            'Current work': '',
            'Research state': '',
          },
          sources: p.sourceParts.map((part: any) => part.id),
        });
      },
    });
  await consolidate(null);
  finishMemoryMigration(f.store, null);
  await consolidate(f.session.id);
  finishMemoryMigration(f.store, f.session.id);
  assert.ok(!fs.existsSync(path.join(sharedDirectory, 'cluster.md')));
  assert.ok(!fs.existsSync(path.join(channelDirectory, 'topic.md')));
  assert.ok(!fs.existsSync(working));
  assert.ok(!fs.existsSync(conversation));
  assert.ok(fs.existsSync(path.join(channelDirectory, 'aside.txt')));
  assert.ok(fs.existsSync(path.join(channelDirectory, 'knowledge', 'deep.md')));
});

test('external identifiers in a migrated working document reach consolidation work protection', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  fs.writeFileSync(
    path.join(f.session.workspace, '.working-memory.md'),
    'Job 8814422 is running; results land in /tmp/sweep.csv.',
  );
  prepareMemoryMigration(f.store);
  const required = new Set<string>();
  await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: f.config.runtime.consolidation,
    force: true,
    call: async ({ prompt }) => {
      const p = JSON.parse(prompt);
      for (const reference of Object.keys(p.requiredWorkReferences ?? {})) required.add(reference);
      return JSON.stringify({
        chunk: p.chunk,
        sections: {
          'Working understanding': '',
          'Current work': 'Job 8814422 is running; /tmp/sweep.csv',
          'Research state': '',
        },
        sources: p.sourceParts.map((part: any) => part.id),
      });
    },
  });
  assert.deepEqual([...required].sort(), ['/tmp/sweep.csv', '8814422']);
});

test('prepared consolidation recovers before or after document replacement without a second model call', async (t) => {
  for (const replaced of [false, true]) {
    const f = fixture(t);
    ensureMemory(f.store, null);
    f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'old-native', f.session.id);
    archiveRecord(f.store, {
      id: 'prepared-source',
      sessionId: f.session.id,
      kind: 'user',
      content: 'Current decision B',
      counted: true,
    });
    const current = observeMemory(f.store, f.session.id),
      shared = observeMemory(f.store, null),
      cutoff = historyPosition(f.store, f.session.id);
    const sections = {
      'Working understanding': 'Current B',
      'Current work': 'job 1122',
      'Research state': '',
    };
    const target = replaceSections(current, sections);
    const progress = {
      id: 'recovery',
      after: 0,
      cutoff,
      cursor: cutoff + 1,
      offset: 0,
      baseRevision: current.revision,
      sharedRevision: shared.revision,
      sections,
      processed: 1,
      phase: 'prepared',
      targetRevision: historyHash(target),
    };
    f.store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?)',
      `consolidation:${f.session.id}`,
      JSON.stringify(progress),
    );
    if (replaced) updateMemory(f.store, f.session.id, sections, current.revision);
    assert.equal(
      await consolidateMemory({
        store: f.store,
        sessionId: f.session.id,
        config: f.config.runtime.consolidation,
        call: async () => {
          throw new Error('Unexpected new model call');
        },
      }),
      'committed',
    );
    assert.equal(consolidationCoverage(f.store, f.session.id), cutoff);
    assert.equal(f.store.session(f.session.id).remote_id, null);
    assert.match(observeMemory(f.store, f.session.id).memory, /Current B/);
  }
});

test('new same-size provider revisions extend in-flight consolidation even without threshold growth', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  archiveProviderRecord(f.store, f.session.id, {
    id: 'item',
    kind: 'provider_item',
    content: 'value A',
    counted: true,
  });
  let calls = 0;
  const result = await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: { ...f.config.runtime.consolidation, thresholdBytes: 1 },
    call: async ({ prompt }) => {
      const p = JSON.parse(prompt);
      calls++;
      if (calls === 1)
        archiveProviderRecord(f.store, f.session.id, {
          id: 'item',
          kind: 'provider_item',
          content: 'value B',
          counted: true,
        });
      return JSON.stringify({
        chunk: p.chunk,
        sections: {
          'Working understanding': calls === 1 ? 'A' : 'B',
          'Current work': '',
          'Research state': '',
        },
        sources: p.sourceParts.map((part: any) => part.id),
      });
    },
  });
  assert.equal(result, 'committed');
  assert.equal(calls, 2);
  assert.equal(historyBytes(f.store, f.session.id, 0), 7);
  assert.match(observeMemory(f.store, f.session.id).memory, /\nB\n/);
});

test('research writes never resurrect notes removed or condensed by current memory', (t) => {
  const f = fixture(t);
  saveNote(f.store, f.session.id, 'old', {
    kind: 'finding',
    title: 'old',
    body: 'DETAILED_OLD_RESULT',
  });
  updateMemory(f.store, f.session.id, { 'Research state': 'Current concise result only.' });
  saveNote(f.store, f.session.id, 'new', { kind: 'finding', title: 'new', body: 'NEW_RESULT' });
  const memory = observeMemory(f.store, f.session.id).memory;
  assert.match(memory, /Current concise result only/);
  assert.match(memory, /NEW_RESULT/);
  assert.doesNotMatch(memory, /DETAILED_OLD_RESULT/);
});

test('consolidation can retrieve paginated evidence while refusing fabricated source IDs', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  archiveRecord(f.store, {
    id: 'earlier-evidence',
    sessionId: f.session.id,
    kind: 'artifact',
    content: 'Verified result B',
  });
  archiveRecord(f.store, {
    id: 'request',
    sessionId: f.session.id,
    kind: 'user',
    content: 'See earlier-evidence',
    counted: true,
  });
  let calls = 0;
  await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: { ...f.config.runtime.consolidation, thresholdBytes: 1 },
    call: async ({ prompt }) => {
      const p = JSON.parse(prompt);
      calls++;
      if (!p.retrievedEvidence.length)
        return JSON.stringify({ lookup: { historyId: 'earlier-evidence', offset: 0 } });
      assert.equal(p.retrievedEvidence[0].content, 'Verified result B');
      return JSON.stringify({
        chunk: p.chunk,
        sections: { 'Working understanding': 'B', 'Current work': '', 'Research state': '' },
        sources: ['earlier-evidence'],
      });
    },
  });
  assert.equal(calls, 2);
  archiveRecord(f.store, {
    id: 'another',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Another input',
    counted: true,
  });
  const oldCoverage = consolidationCoverage(f.store, f.session.id);
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: { ...f.config.runtime.consolidation, thresholdBytes: 1 },
      call: async ({ prompt }) => {
        const p = JSON.parse(prompt);
        return JSON.stringify({
          chunk: p.chunk,
          sections: {
            'Working understanding': 'fiction',
            'Current work': '',
            'Research state': '',
          },
          sources: ['nonexistent'],
        });
      },
    }),
    /invalid chunk coverage/,
  );
  assert.equal(consolidationCoverage(f.store, f.session.id), oldCoverage);
});

test('stream fragments survive interruption and completed snapshots count one logical item', (t) => {
  const f = fixture(t),
    events: any[] = [];
  const stream = new StreamHistory(
    (event) => events.push(event.detail),
    () => 'native',
  );
  stream.delta('one', 'item/agentMessage/delta', '中'.repeat(10000));
  stream.flush();
  for (const event of events) archiveProviderRecord(f.store, f.session.id, event);
  const complete = { type: 'agentMessage', id: 'one', text: '中'.repeat(10000) };
  const record = {
    id: 'codex:native:one',
    kind: 'provider_item',
    source: 'native',
    content: complete,
    counted: true,
  };
  archiveProviderRecord(f.store, f.session.id, record);
  archiveProviderRecord(f.store, f.session.id, record);
  assert.equal(historyBytes(f.store, f.session.id, 0), Buffer.byteLength(JSON.stringify(complete)));
  assert.ok(
    (historyPage(f.store, f.session.id, { action: 'search', query: '中' }) as any).records
      .length === 2,
  );
});

test('migration flattens shared policy once and preserves external original instruction sources', (t) => {
  const f = fixture(t),
    shared = path.join(f.home, 'shared-policy.md');
  fs.writeFileSync(shared, 'SHARED_POLICY_ONLY_ONCE');
  fs.writeFileSync(path.join(f.home, 'AGENTS.md'), '# Identity\n@shared-policy.md\n');
  fs.writeFileSync(memoryFile(f.store, f.session.id), `# Channel\n@${shared}\nLOCAL_POLICY\n`);
  prepareMemoryMigration(f.store);
  assert.match(observeMemory(f.store, null).instructions, /SHARED_POLICY_ONLY_ONCE/);
  assert.doesNotMatch(observeMemory(f.store, f.session.id).instructions, /SHARED_POLICY_ONLY_ONCE/);
  assert.match(observeMemory(f.store, f.session.id).instructions, /LOCAL_POLICY/);
  assert.equal(fs.readFileSync(shared, 'utf8'), 'SHARED_POLICY_ONLY_ONCE');
});

test('a model that drops an unresolved job or artifact cannot commit or rotate', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  updateMemory(f.store, f.session.id, {
    'Current work':
      'Job 7712331 is submitted. Artifact /tmp/result-7712331.csv. Check it before resubmitting.',
  });
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'keep-native', f.session.id);
  archiveRecord(f.store, {
    id: 'later-message',
    sessionId: f.session.id,
    kind: 'user',
    content: 'An unrelated observation.',
    counted: true,
  });
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: { ...f.config.runtime.consolidation, thresholdBytes: 1 },
      call: async ({ prompt }) => {
        const p = JSON.parse(prompt);
        return JSON.stringify({
          chunk: p.chunk,
          sections: {
            'Working understanding': 'Observation',
            'Current work': '',
            'Research state': '',
          },
          sources: [],
        });
      },
    }),
    /dropped unresolved work/,
  );
  assert.equal(f.store.session(f.session.id).remote_id, 'keep-native');
  assert.equal(consolidationCoverage(f.store, f.session.id), 0);
  assert.match(observeMemory(f.store, f.session.id).memory, /7712331/);
});

test('work protection distinguishes artifact paths from ratios, including saved old progress', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  updateMemory(f.store, f.session.id, {
    'Current work':
      'Job 7712331 is pending. Results at /tmp/result.csv and ./data/result.csv. Tests 194/270; value 0.4/0.32; authors Sam/Lee.',
  });
  archiveRecord(f.store, {
    id: 'work-evidence',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Await the job result.',
    counted: true,
  });
  const call = async ({ prompt }: { prompt: string }) => {
    const p = JSON.parse(prompt);
    assert.deepEqual(Object.keys(p.requiredWorkReferences).sort(), [
      './data/result.csv',
      '/tmp/result.csv',
      '7712331',
    ]);
    return JSON.stringify({
      chunk: p.chunk,
      sections: {
        'Working understanding': '',
        'Current work': 'Job 7712331 is pending. /tmp/result.csv ./data/result.csv',
        'Research state': '',
      },
      sources: [],
    });
  };
  const config = {
    ...f.config.runtime.consolidation,
    thresholdBytes: 1,
    chunkChars: 10,
    maxChunksPerPass: 1,
  };
  assert.equal(
    await consolidateMemory({ store: f.store, sessionId: f.session.id, config, call }),
    'pending',
  );
  const name = 'consolidation:' + f.session.id;
  const saved = JSON.parse(f.store.get<any>('SELECT value FROM metadata WHERE key=?', name).value);
  delete saved.referenceParser;
  const source = saved.protectedWork['7712331'];
  delete saved.protectedWork['./data/result.csv'];
  saved.protectedWork['/data/result.csv'] = source;
  for (const falsePath of ['/270', '/0.32', '/Lee']) saved.protectedWork[falsePath] = source;
  f.store.exec('UPDATE metadata SET value=? WHERE key=?', JSON.stringify(saved), name);
  assert.equal(
    await consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: { ...config, chunkChars: 120000, maxChunksPerPass: 8 },
      call,
    }),
    'committed',
  );
  assert.match(observeMemory(f.store, f.session.id).memory, /7712331/);
});

test('instruction overrides cannot hide canonical current memory from either provider', (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null, 'ORDINARY_POLICY');
  updateMemory(f.store, null, { 'Working understanding': 'CANONICAL_MEMORY' });
  fs.writeFileSync(path.join(f.home, 'AGENTS.override.md'), 'OVERRIDE_POLICY');
  const snapshot = readInstructionSnapshot({
    home: f.home,
    workspace: f.session.workspace,
    profile: f.config.accounts[0]!.home,
    maxChars: 10000,
  });
  assert.match(snapshot.instructions, /OVERRIDE_POLICY/);
  assert.doesNotMatch(snapshot.instructions, /ORDINARY_POLICY/);
  assert.match(snapshot.memory, /CANONICAL_MEMORY/);
});

test('CLI export includes raw history, current documents and consolidation coverage', (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  saveConfig(f.home, f.config);
  updateMemory(f.store, f.session.id, { 'Working understanding': 'CURRENT_EXPORT_FACT' });
  archiveRecord(f.store, {
    id: 'export-record',
    sessionId: f.session.id,
    kind: 'user',
    content: 'COMPLETE_EXPORT_HISTORY',
    counted: true,
  });
  const file = path.join(f.home, 'export.json');
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.resolve('src/cli.ts'), 'export', f.session.id, file],
    { env: { ...process.env, CLAWSTRUM_HOME: f.home }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(exported.memory.channel, /CURRENT_EXPORT_FACT/);
  assert.ok(
    exported.history.some(
      (r: any) => r.id === 'export-record' && r.content === 'COMPLETE_EXPORT_HISTORY',
    ),
  );
  assert.ok(Array.isArray(exported.memoryLifecycle));
});

test('compatibility heading nesting preserves fenced content and memory symlink targets', (t) => {
  const f = fixture(t),
    file = memoryFile(f.store, f.session.id),
    target = path.join(f.home, 'channel-document.md');
  fs.renameSync(file, target);
  fs.symlinkSync(target, file);
  const markdown = '# Objective\nJob 7123\n\n```md\n## A code example\n```';
  const body = nestMemoryContent(markdown);
  assert.match(body, /#### Objective/);
  assert.match(body, /```md\n## A code example\n```/);
  updateMemory(f.store, f.session.id, { 'Current work': body });
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  assert.match(fs.readFileSync(target, 'utf8'), /Job 7123/);
});

test('parallel migration respects credential capacity and a deferred scope prevents relocation', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const other = f.store.ensureSession('222222');
  for (const session of [f.session, other])
    fs.writeFileSync(
      path.join(session.workspace, 'MEMORY.md'),
      'Legacy current fact for migration',
    );
  f.config.accounts = f.config.accounts.slice(0, 1);
  f.config.accounts[0]!.maxConcurrent = 1;
  let active = 0,
    peak = 0;
  const adapter = {
    async run(r: any) {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (r.cwd === f.session.workspace) throw new Error('Deferred fixture');
        const p = JSON.parse(r.prompt);
        return JSON.stringify({
          chunk: p.chunk,
          sections: {
            'Working understanding': 'Verified current fact',
            'Current work': '',
            'Research state': '',
          },
          sources: p.sourceParts.map((s: any) => s.id),
        });
      } finally {
        active--;
      }
    },
  };
  const root = path.join(f.home, 'proposed-channels');
  await assert.rejects(
    migrateMemory(f.store, f.config, {
      channelsRoot: root,
      adapters: { claude: adapter, codex: adapter },
    }),
    /progress is saved/,
  );
  assert.equal(peak, 1);
  assert.equal(f.store.session(other.id).workspace, other.workspace);
  assert.ok(!fs.existsSync(root));
  assert.ok(f.store.get("SELECT key FROM metadata WHERE key='memory-layout-required'"));
  assert.ok(fs.existsSync(path.join(f.session.workspace, 'MEMORY.md')));
  assert.ok(!fs.existsSync(path.join(other.workspace, 'MEMORY.md')));
});

test('maintenance reads referenced external artifacts in UTF-8 byte pages and archives evidence', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const file = path.join(f.home, 'external-result.csv'),
    content = '中'.repeat(41000) + 'MIDDLE_ARTIFACT_FACT' + 'Z'.repeat(40000);
  fs.writeFileSync(file, content);
  archiveRecord(f.store, {
    id: 'artifact-request',
    sessionId: f.session.id,
    kind: 'user',
    content: `Inspect ${file}`,
    counted: true,
  });
  const ids = new Set<string>();
  let reconstructed = '';
  await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: { ...f.config.runtime.consolidation, thresholdBytes: 1 },
    call: async (request) => {
      assert.ok(!ids.has(request.id));
      ids.add(request.id);
      const p = JSON.parse(request.prompt),
        last = p.retrievedEvidence.at(-1);
      if (!last || last.nextOffset !== null)
        return JSON.stringify({ lookup: { file, offset: last?.nextOffset ?? 0 } });
      reconstructed = p.retrievedEvidence.map((part: any) => part.content).join('');
      return JSON.stringify({
        chunk: p.chunk,
        sections: {
          'Working understanding': 'MIDDLE_ARTIFACT_FACT',
          'Current work': '',
          'Research state': '',
        },
        sources: p.retrievedEvidence.map((part: any) => part.id),
      });
    },
  });
  assert.equal(reconstructed, content);
  assert.ok(ids.size > 2);
  assert.ok(
    f.store.get<any>("SELECT count(*) n FROM history_records WHERE kind='consolidation_evidence'")
      .n > 1,
  );
});

test('unavailable optional evidence records uncertainty instead of preventing consolidation', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  archiveRecord(f.store, {
    id: 'missing-artifact',
    sessionId: f.session.id,
    kind: 'user',
    content: 'The result is unavailable.',
    counted: true,
  });
  const result = await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: { ...f.config.runtime.consolidation, thresholdBytes: 1 },
    call: async ({ prompt }) => {
      const p = JSON.parse(prompt);
      if (!p.retrievedEvidence.length)
        return JSON.stringify({
          lookup: { file: path.join(f.session.workspace, 'missing.txt'), offset: 0 },
        });
      assert.match(p.retrievedEvidence[0].error, /ENOENT/);
      return JSON.stringify({
        chunk: p.chunk,
        sections: {
          'Working understanding': 'Result unavailable; no contents inferred.',
          'Current work': '',
          'Research state': '',
        },
        sources: ['missing-artifact'],
      });
    },
  });
  assert.equal(result, 'committed');
});

test('migration consolidates retained conversations even without legacy memory or a native ID', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  f.enqueue('retain-this-history');
  let calls = 0;
  const adapter = {
    async run(r: any) {
      calls++;
      const p = JSON.parse(r.prompt);
      assert.ok(p.sourceParts.some((part: any) => part.text.includes('retain-this-history')));
      return JSON.stringify({
        chunk: p.chunk,
        sections: {
          'Working understanding': 'Retained conversation decision',
          'Current work': '',
          'Research state': '',
        },
        sources: p.sourceParts.map((part: any) => part.id),
      });
    },
  };
  await migrateMemory(f.store, f.config, {
    channelsRoot: path.join(f.home, 'new-channels'),
    adapters: { claude: adapter, codex: adapter },
  });
  assert.equal(calls, 1);
  assert.ok(consolidationCoverage(f.store, f.session.id) > 0);
  assert.match(observeMemory(f.store, f.session.id).memory, /Retained conversation decision/);
  assert.ok(!f.store.get("SELECT key FROM metadata WHERE key='memory-layout-required'"));
});

test('consolidation nests model headings and accepts citations from already processed chunks', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  ensureMemory(f.store, f.session.id, 'Standing policy stays unchanged.');
  const instructions = observeMemory(f.store, f.session.id).instructions;
  for (const id of ['earlier-source', 'later-source'])
    archiveRecord(f.store, {
      id,
      sessionId: f.session.id,
      kind: 'user',
      content: id[0]!.repeat(100),
      counted: true,
    });
  let citedPrevious = false;
  const status = await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: { ...f.config.runtime.consolidation, thresholdBytes: 1, chunkChars: 100 },
    call: async ({ prompt }) => {
      const p = JSON.parse(prompt);
      if (p.sourceParts.some((r: any) => r.id === 'later-source')) citedPrevious = true;
      return JSON.stringify({
        chunk: p.chunk,
        sections: {
          'Working understanding': '## Findings\nCurrent fact.\n```sh\n# keep code unchanged\n```',
          'Current work': '### Next step\nAwait the next user question.',
          'Research state': '',
        },
        sources: ['earlier-source'],
      });
    },
  });
  assert.equal(status, 'committed');
  assert.equal(citedPrevious, true);
  const doc = observeMemory(f.store, f.session.id);
  assert.equal(doc.instructions, instructions);
  assert.match(doc.memory, /##### Findings/);
  assert.match(doc.memory, /```sh\n# keep code unchanged\n```/);
});

test('rejected consolidation proposals are archived and corrected with bounded feedback', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  archiveRecord(f.store, {
    id: 'exact-source',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Current fact',
    counted: true,
  });
  let calls = 0;
  const status = await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: { ...f.config.runtime.consolidation, thresholdBytes: 1 },
    call: async ({ prompt }) => {
      const p = JSON.parse(prompt);
      calls++;
      if (calls === 2) {
        assert.match(p.validationError, /abbreviated-source/);
        assert.deepEqual(JSON.parse(p.previousResponse).sources, ['abbreviated-source']);
      }
      return JSON.stringify({
        chunk: p.chunk,
        sections: {
          'Working understanding': 'Current fact',
          'Current work': '',
          'Research state': '',
        },
        sources: [calls === 1 ? 'abbreviated-source' : 'exact-source'],
      });
    },
  });
  assert.equal(status, 'committed');
  assert.equal(calls, 2);
  const attempts = f.store.all<{ content: string }>(
    "SELECT content FROM history_records WHERE kind='consolidation_attempt'",
  );
  assert.equal(attempts.length, 2);
  assert.match(attempts[0]!.content, /abbreviated-source/);
});

test('persistent invalid or cross-channel citations exhaust repair without rotating', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const other = f.store.ensureSession('123456');
  archiveRecord(f.store, {
    id: 'foreign-source',
    sessionId: other.id,
    kind: 'user',
    content: 'Other channel',
    counted: true,
  });
  archiveRecord(f.store, {
    id: 'local-source',
    sessionId: f.session.id,
    kind: 'user',
    content: 'This channel',
    counted: true,
  });
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'keep-native', f.session.id);
  let calls = 0;
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: { ...f.config.runtime.consolidation, thresholdBytes: 1 },
      call: async ({ prompt }) => {
        calls++;
        return JSON.stringify({
          chunk: JSON.parse(prompt).chunk,
          sections: {
            'Working understanding': 'Unsupported',
            'Current work': '',
            'Research state': '',
          },
          sources: ['foreign-source'],
        });
      },
    }),
    /invalid chunk coverage/,
  );
  assert.equal(calls, 3);
  assert.equal(f.store.session(f.session.id).remote_id, 'keep-native');
  assert.equal(consolidationCoverage(f.store, f.session.id), 0);
});

test('an exhausted chunk is recorded and the next pass carries its rejection into the prompt', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  archiveRecord(f.store, {
    id: 'exact-source',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Current fact',
    counted: true,
  });
  const config = { ...f.config.runtime.consolidation, thresholdBytes: 1 };
  const propose = (prompt: string, source: string) =>
    JSON.stringify({
      chunk: JSON.parse(prompt).chunk,
      sections: {
        'Working understanding': 'Current fact',
        'Current work': '',
        'Research state': '',
      },
      sources: [source],
    });
  let calls = 0;
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config,
      call: async ({ prompt }) => {
        calls++;
        return propose(prompt, 'abbreviated-source');
      },
    }),
  );
  assert.equal(calls, 3);
  const name = `consolidation:${f.session.id}`;
  const stalled = JSON.parse(
    f.store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', name)!.value,
  );
  assert.equal(stalled.rejections, 1);
  assert.equal(stalled.rejectedCursor, stalled.cursor);
  assert.match(stalled.lastError, /abbreviated-source/);
  const rejected = f.store.all<{ content: string }>(
    "SELECT content FROM history_records WHERE kind='consolidation_rejected'",
  );
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.content, /abbreviated-source/);
  calls = 0;
  const status = await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config,
    call: async ({ prompt }) => {
      calls++;
      if (calls === 1) assert.match(JSON.parse(prompt).validationError, /abbreviated-source/);
      return propose(prompt, 'exact-source');
    },
  });
  assert.equal(status, 'committed');
  assert.equal(calls, 1);
  const remaining = f.store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', name);
  const cleared = remaining ? JSON.parse(remaining.value) : {};
  assert.equal(cleared.rejectedCursor, undefined);
  assert.equal(cleared.rejections, undefined);
  assert.equal(cleared.lastError, undefined);
});

test('rolling memory aliases retain verified old and shared citations and support evidence lookup', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  const oldId = 'old-source:' + 'a'.repeat(160);
  const sharedId = 'shared-source:' + 'b'.repeat(160);
  archiveRecord(f.store, {
    id: oldId,
    sessionId: f.session.id,
    kind: 'user',
    content: 'Current result is BETA.',
    counted: true,
  });
  archiveRecord(f.store, {
    id: sharedId,
    sessionId: null,
    kind: 'user',
    content: 'Shared preference is precise references.',
    counted: true,
  });
  updateMemory(f.store, f.session.id, {
    'Working understanding': `Current BETA result (history:${oldId}). Unknown history:missing-source.`,
    'Current work': 'Job 7712331 is pending.',
  });
  updateMemory(f.store, null, {
    'Working understanding': `Shared preference history:${sharedId}.`,
  });
  f.store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    'consolidation:' + f.session.id + ':coverage',
    String(historyPosition(f.store, f.session.id)),
  );
  archiveRecord(f.store, {
    id: 'new-message',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Continue the current work.',
    counted: true,
  });
  let calls = 0;
  const status = await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: { ...f.config.runtime.consolidation, thresholdBytes: 1 },
    call: async ({ prompt }) => {
      const p = JSON.parse(prompt);
      calls++;
      assert.equal(
        p.existingCurrentMemory['Working understanding'],
        'Current BETA result ([source:m1]). Unknown history:missing-source.',
      );
      assert.match(p.sharedContext, /Shared preference \[source:m2\]\./);
      assert.equal(p.memoryReferences.length, 3);
      assert.equal(p.requiredWorkReferences['7712331'], 'm3');
      if (calls === 1) {
        assert.ok(!prompt.includes(oldId));
        assert.ok(!prompt.includes(sharedId));
        return JSON.stringify({ lookup: { historyId: 'm1', offset: 0 } });
      }
      assert.equal(p.retrievedEvidence[0].id, oldId);
      return JSON.stringify({
        chunk: p.chunk,
        sections: {
          'Working understanding':
            'Current BETA result [source:m1]. Shared preference [source:m2].',
          'Current work': 'Job 7712331 is pending [source:m3].',
          'Research state': '',
        },
        sources: ['m1', 'm2', 'm3'],
      });
    },
  });
  assert.equal(status, 'committed');
  assert.equal(calls, 2);
  const memory = observeMemory(f.store, f.session.id).memory;
  assert.ok(memory.includes('history:' + oldId));
  assert.ok(memory.includes('history:' + sharedId));
  assert.doesNotMatch(memory, /\[source:m\d+\]/);
  const attempt = JSON.parse(
    f.store.get<any>(
      "SELECT content FROM history_records WHERE kind='consolidation_attempt' ORDER BY seq DESC LIMIT 1",
    ).content,
  );
  assert.equal(attempt.references.m1, oldId);
  assert.equal(attempt.references.m2, sharedId);
});

test('short source references resolve lookups, work evidence and permanent memory citations', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  updateMemory(f.store, f.session.id, { 'Current work': 'Job 7712331 is pending.' });
  const original = 'inbound:1234567890123456789012345678';
  archiveRecord(f.store, {
    id: original,
    sessionId: f.session.id,
    kind: 'user',
    content: 'Job 7712331 completed. No further work remains.',
    counted: true,
  });
  let calls = 0;
  const status = await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: { ...f.config.runtime.consolidation, thresholdBytes: 1 },
    call: async ({ prompt }) => {
      const p = JSON.parse(prompt);
      calls++;
      if (!p.retrievedEvidence.length) {
        const source = p.sourceParts.find((part: any) => part.id === original);
        assert.match(source.ref, /^s\d+$/);
        return JSON.stringify({ lookup: { historyId: source.ref } });
      }
      const ref = p.retrievedEvidence[0].ref;
      assert.equal(p.retrievedEvidence[0].id, original);
      assert.match(ref, /^e\d+$/);
      return JSON.stringify({
        chunk: p.chunk,
        sections: {
          'Working understanding': `Verified completion [source:${ref}]`,
          'Current work': '',
          'Research state': '',
        },
        sources: [ref],
        resolvedWork: [{ reference: '7712331', source: ref }],
      });
    },
  });
  assert.equal(status, 'committed');
  assert.equal(calls, 2);
  const doc = observeMemory(f.store, f.session.id);
  assert.ok(doc.memory.includes('history:' + original));
  assert.doesNotMatch(doc.memory, /\[source:[se]\d+\]/);
  const chunk = JSON.parse(
    f.store.get<{ content: string }>(
      "SELECT content FROM history_records WHERE kind='consolidation_chunk'",
    )!.content,
  );
  assert.deepEqual(chunk.result.sources, [original]);
  const attempts = f.store.all<{ content: string }>(
    "SELECT content FROM history_records WHERE kind='consolidation_attempt' ORDER BY seq",
  );
  assert.equal(JSON.parse(attempts[1]!.content).references.e1, original);
});

test('unknown short citations cannot become permanent memory', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  archiveRecord(f.store, {
    id: 'source',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Current fact',
    counted: true,
  });
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: { ...f.config.runtime.consolidation, thresholdBytes: 1 },
      call: async ({ prompt }) =>
        JSON.stringify({
          chunk: JSON.parse(prompt).chunk,
          sections: {
            'Working understanding': 'Invented citation [source:s9999]',
            'Current work': '',
            'Research state': '',
          },
          sources: [],
        }),
    }),
    /Unknown source reference s9999/,
  );
  assert.equal(consolidationCoverage(f.store, f.session.id), 0);
  assert.doesNotMatch(observeMemory(f.store, f.session.id).memory, /Invented citation/);
});

test('model continuation fields preserve their text but cannot assert history coverage', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  archiveRecord(f.store, {
    id: 'source',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Observed facts',
    counted: true,
  });
  const status = await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config: { ...f.config.runtime.consolidation, thresholdBytes: 1 },
    call: async ({ prompt }) =>
      JSON.stringify({
        chunk: JSON.parse(prompt).chunk,
        sections: {
          'Working understanding': 'Current fact',
          'Current work': '',
          'Research state': 'First finding',
          'Research state (continued)': 'Second finding',
          'History access and coverage': 'MODEL_INVENTED_COVERAGE',
        },
        sources: ['s1'],
      }),
  });
  assert.equal(status, 'committed');
  const doc = observeMemory(f.store, f.session.id);
  assert.match(doc.memory, /First finding\n\nSecond finding/);
  assert.doesNotMatch(doc.memory, /MODEL_INVENTED_COVERAGE/);
  assert.match(doc.memory, /Completed consolidation covers history sequences/);
});

test('a pass deadline yields saved chunks for automatic continuation without rotating early', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  for (const id of ['a', 'b'])
    archiveRecord(f.store, {
      id,
      sessionId: f.session.id,
      kind: 'user',
      content: id.repeat(4),
      counted: true,
    });
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'keep-native', f.session.id);
  const config = {
    ...f.config.runtime.consolidation,
    thresholdBytes: 1,
    chunkChars: 4,
    timeoutMs: 500,
  };
  const result = (prompt: string) => {
    const p = JSON.parse(prompt);
    return JSON.stringify({
      chunk: p.chunk,
      sections: { 'Working understanding': 'Current', 'Current work': '', 'Research state': '' },
      sources: p.sourceParts.map((part: any) => part.ref),
    });
  };
  let calls = 0;
  const status = await consolidateMemory({
    store: f.store,
    sessionId: f.session.id,
    config,
    call: async ({ prompt, signal }) => {
      if (++calls === 1) return result(prompt);
      return new Promise<string>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  });
  assert.equal(status, 'pending');
  assert.equal(calls, 2);
  assert.equal(consolidationCoverage(f.store, f.session.id), 0);
  assert.equal(f.store.session(f.session.id).remote_id, 'keep-native');
  assert.equal(
    await consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: { ...config, timeoutMs: 5000 },
      call: async ({ prompt }) => result(prompt),
    }),
    'committed',
  );
  assert.equal(f.store.session(f.session.id).remote_id, null);
});

test('a deadline without any completed chunk remains a failure', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  archiveRecord(f.store, {
    id: 'a',
    sessionId: f.session.id,
    kind: 'user',
    content: 'Important',
    counted: true,
  });
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: { ...f.config.runtime.consolidation, thresholdBytes: 1, timeoutMs: 50 },
      call: async ({ signal }) =>
        new Promise<string>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
    }),
    /time budget/,
  );
  assert.equal(consolidationCoverage(f.store, f.session.id), 0);
});

test(
  'offline migration starts large backlogs first and honors configured capacity above four',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    ensureMemory(f.store, null);
    f.config.runtime.maxConcurrent = 6;
    for (const account of f.config.accounts) account.maxConcurrent = 3;
    for (const [index, size] of [10, 60, 20, 50, 30, 40].entries()) {
      const session = f.store.ensureSession(String(700000 + index));
      ensureMemory(f.store, session.id);
      archiveRecord(f.store, {
        id: `source-${index}`,
        sessionId: session.id,
        kind: 'user',
        content: 'x'.repeat(size * 100),
        counted: true,
      });
    }
    const order: string[] = [];
    let release!: () => void;
    const started = new Promise<void>((resolve) => (release = resolve));
    const provider = {
      async run(request: any) {
        const p = JSON.parse(request.prompt);
        order.push(p.sourceParts.find((part: any) => part.kind === 'user').id);
        if (order.length === 6) release();
        await started;
        return JSON.stringify({
          chunk: p.chunk,
          sections: {
            'Working understanding': 'Verified',
            'Current work': '',
            'Research state': '',
          },
          sources: p.sourceParts.map((part: any) => part.ref),
        });
      },
    };
    await migrateMemory(f.store, f.config, { adapters: { claude: provider, codex: provider } });
    assert.deepEqual(order, [
      'source-1',
      'source-3',
      'source-5',
      'source-4',
      'source-2',
      'source-0',
    ]);
  },
);
