import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { Store } from '../src/store.js';
import { acquireLock } from '../src/lock.js';
import { archiveRecord, historyPage, historyFile } from '../src/history.js';
import {
  createGroup,
  recordGroupChannel,
  setGroupMembership,
  groupBoard,
  groupEntries,
  groupIssues,
  groupEvent,
  groupDirectory,
  memberGroups,
  syncGroups,
  expireGroupEntries,
  getGroup,
  exportGroups,
  openGroupIssue,
  resolveGroupIssue,
  GROUP_ENTRY_STATUS,
  entryView,
} from '../src/groups/store.js';
import {
  GroupReviews,
  partitionSources,
  reviewGroup,
  GROUP_REVIEW_INSTRUCTIONS,
} from '../src/groups/review.js';
import { readInstructionSnapshot } from '../src/instructions.js';
import { buildContext } from '../src/context.js';
import { parseMemory } from '../src/memory.js';
import { sendDiscordDelivery, groupReviewThread } from '../src/discord.js';
import { ChannelType } from 'discord.js';
import type { Outbound } from '../src/types.js';

function setup(t: any) {
  const f = fixture(t);
  createGroup(f.store, 'science', 'Science', 'Shared experiments');
  recordGroupChannel(f.store, f.session, 'analysis');
  setGroupMembership(f.store, 'science', f.session.id, true, 'Analysis');
  const other = f.store.ensureSession('987655');
  recordGroupChannel(f.store, other, 'replication');
  setGroupMembership(f.store, 'science', other.id, true);
  const outsider = f.store.ensureSession('111111');
  const publish = (
    subject: string,
    extra: any = {},
    session = f.session.id,
    groups = ['science'],
  ) =>
    groupBoard(f.store, session, {
      action: 'publish',
      groups,
      key: subject,
      entry: { kind: 'finding', subject, summary: subject, evidence: [], ...extra },
    }) as any;
  const snapshot = (session = f.session) =>
    readInstructionSnapshot({
      home: f.home,
      workspace: session.workspace,
      profile: f.config.accounts[0]!.home,
      maxChars: 200000,
    });
  return { ...f, other, outsider, publish, snapshot };
}
const accept = (prompt: string, operations: any[] = []) => {
  const p = JSON.parse(prompt);
  return JSON.stringify({ chunk: p.chunk, notes: 'Reviewed supplied complete chunk.', operations });
};
function reviewer(
  f: ReturnType<typeof setup>,
  call: (request: any) => Promise<string>,
  overrides: any = {},
) {
  return reviewGroup({
    store: f.store,
    groupId: 'science',
    config: { ...f.config.groups.reviewer, ...overrides },
    signal: new AbortController().signal,
    call,
  });
}

test('groups default on independently of research; economical routing never inherits a flagship model', (t) => {
  const f = setup(t);
  f.config.research.enabled = false;
  const reviews = new GroupReviews(
    f.store,
    f.config,
    async () => '',
    () => 0,
    () => 1,
  );
  assert.equal(f.config.groups.enabled, true);
  assert.equal(f.config.groups.reviewer.enabled, true);
  assert.deepEqual(
    reviews.accounts.map((a) => [a.provider, a.model, a.modelFallbacks]),
    [['claude', 'haiku', []]],
  );
  f.config.groups.reviewer.models = { codex: 'explicit-economical-test-model' };
  assert.deepEqual(
    new GroupReviews(
      f.store,
      f.config,
      async () => '',
      () => 0,
      () => 1,
    ).accounts.map((a) => [a.provider, a.model]),
    [['codex', 'explicit-economical-test-model']],
  );
});

test('publication is immediate, scoped, idempotent, and independent of native sessions', (t) => {
  const f = setup(t);
  const c = buildContext(f.store, f.session, f.config.accounts[0]!, [], 200000);
  f.store.exec(
    'UPDATE sessions SET remote_id=?,active_account=?,fingerprint=? WHERE id=?',
    'native-a',
    'a',
    c.fingerprint,
    f.session.id,
  );
  const before = f.snapshot();
  const entry = f.publish('Calibrated result');
  assert.equal(f.publish('Calibrated result').id, entry.id);
  assert.throws(() => f.publish('Calibrated result', { summary: 'changed' }), /different content/);
  assert.equal(groupEntries(f.store, 'science').length, 1);
  assert.notEqual(f.snapshot().revision, before.revision);
  assert.match(f.snapshot(f.other).memory, /Calibrated result/);
  assert.doesNotMatch(f.snapshot(f.outsider).memory, /Calibrated result/);
  assert.equal(
    buildContext(f.store, f.store.session(f.session.id), f.config.accounts[0]!, [], 200000)
      .resumeId,
    'native-a',
  );
  assert.throws(
    () => groupBoard(f.store, f.outsider.id, { action: 'read', groups: ['science'] }),
    /not a member/,
  );
  assert.equal(
    f.store.all('SELECT * FROM inbound').length,
    0,
    'ordinary publication does not wake other channels',
  );
});

test('shared findings retain declared experiment scope and distinguish observation time from board edits', (t) => {
  const f = setup(t);
  const first = f.publish('Experiment A observed result', {
    scope: { experiment: 'A', run: 'a1', version: 'v1' },
    observedAt: Date.UTC(2025, 0, 2),
  });
  const second = f.publish('Experiment B observed result', {
    scope: { experiment: 'B', run: 'b2' },
  });
  const legacy = f.publish('Legacy result has no recorded scope');
  const view = groupEntries(f.store, 'science').map(entryView);
  assert.equal(
    view.find((e) => e.id === first.id).scopeStatus,
    'declared_not_independently_verified',
  );
  assert.equal(view.find((e) => e.id === legacy.id).scopeStatus, 'unspecified');
  const memory = f.snapshot().memory;
  assert.match(memory, /board updated/);
  assert.match(memory, /observation.*2025-01-02/);
  assert.match(memory, /scope.*unspecified/);
  assert.match(memory, /Experiment A observed result/);
  assert.match(memory, /Experiment B observed result/);
  assert.ok(second.id);
});

test('membership refresh rereads the manifest, threads inherit, and instructions order H/G/W', (t) => {
  const f = setup(t),
    thread = f.store.ensureSession('222222');
  recordGroupChannel(f.store, thread, 'experiment thread', f.session.channel_id);
  assert.deepEqual(memberGroups(f.store, thread.channel_id), ['science']);
  fs.writeFileSync(path.join(f.home, 'AGENTS.md'), 'HOME_POLICY');
  const file = path.join(groupDirectory(f.home, 'science'), 'AGENTS.md');
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, 'utf8')
      .replace('## Shared instructions', 'GROUP_POLICY\n\n## Shared instructions'),
  );
  fs.writeFileSync(path.join(f.session.workspace, 'AGENTS.md'), 'CHANNEL_POLICY');
  const snapshot = f.snapshot();
  assert.ok(
    snapshot.instructions.indexOf('HOME_POLICY') < snapshot.instructions.indexOf('GROUP_POLICY'),
  );
  assert.ok(
    snapshot.instructions.indexOf('GROUP_POLICY') < snapshot.instructions.indexOf('CHANNEL_POLICY'),
  );
  const entry = f.publish('Shared fact');
  assert.match(f.snapshot(thread).memory, /Shared fact/);
  setGroupMembership(f.store, 'science', f.session.id, false);
  assert.deepEqual(memberGroups(f.store, thread.channel_id), []);
  assert.doesNotMatch(f.snapshot(thread).memory, /Shared fact/);
  assert.match(f.snapshot(f.other).memory, /Shared fact/);
  setGroupMembership(f.store, 'science', thread.id, true);
  assert.match(f.snapshot(thread).memory, /Shared fact/);
  syncGroups(f.store, false);
  assert.doesNotMatch(f.snapshot(thread).memory, /Shared fact/);
  syncGroups(f.store, true);
  assert.match(f.snapshot(thread).memory, new RegExp(entry.id));
});

test('a thread reads its parent channel instructions and MEMORY before its own', (t) => {
  const f = setup(t),
    thread = f.store.ensureSession('333333'),
    account = f.config.accounts[0]!;
  fs.writeFileSync(
    path.join(f.session.workspace, 'AGENTS.md'),
    'PARENT_POLICY\n\n## MEMORY\n\n### Working understanding\n\n- PARENT_FACT\n',
  );
  fs.writeFileSync(path.join(thread.workspace, 'AGENTS.md'), 'THREAD_POLICY');
  assert.doesNotMatch(buildContext(f.store, thread, account, [], 200000).instructions, /PARENT_/);
  recordGroupChannel(f.store, thread, 'thread', f.session.channel_id);
  assert.equal(f.store.parentWorkspace(thread), f.session.workspace);
  const c = buildContext(f.store, thread, account, [], 200000);
  assert.ok(c.instructions.indexOf('PARENT_POLICY') < c.instructions.indexOf('THREAD_POLICY'));
  assert.match(c.contextRefresh.snapshot.memory, /PARENT_FACT/);
  assert.match(c.instructions, new RegExp(`Parent channel workspace: ${f.session.workspace}`));
  assert.equal(c.contextRefresh.sources.parentWorkspace, f.session.workspace);
  assert.equal(f.store.parentWorkspace(f.session), undefined);
  assert.doesNotMatch(
    buildContext(f.store, f.session, account, [], 200000).instructions,
    /Parent channel/,
  );
});

test('multi-group publication has one identity and one contextual body; revisions require every audience', (t) => {
  const f = setup(t);
  createGroup(f.store, 'models', 'Models');
  setGroupMembership(f.store, 'models', f.session.id, true);
  const entry = f.publish('MULTI_SCOPE_NEEDLE', {}, f.session.id, ['science', 'models']);
  const rows = ['science', 'models'].map((id) => groupEntries(f.store, id)[0]!);
  assert.equal(rows[0].id, rows[1].id);
  assert.equal(rows[0].origin_id, rows[1].origin_id);
  assert.equal(f.snapshot().memory.match(/"summary": "MULTI_SCOPE_NEEDLE"/g)?.length, 1);
  assert.throws(
    () =>
      groupBoard(f.store, f.session.id, {
        action: 'revise',
        groups: ['science'],
        key: 'revision',
        id: entry.id,
        revision: 1,
        entry: { kind: 'finding', subject: 'Updated', summary: 'Updated' },
      }),
    /every audience/,
  );
  groupBoard(f.store, f.session.id, {
    action: 'revise',
    groups: ['science', 'models'],
    key: 'revision',
    id: entry.id,
    revision: 1,
    entry: { kind: 'finding', subject: 'Updated', summary: 'Updated' },
  });
  assert.ok(['science', 'models'].every((id) => groupEntries(f.store, id)[0]!.revision === 2));
});

test('group history is isolated from shared history, complete and materialized only after commit', (t) => {
  const f = setup(t);
  const value = 'A'.repeat(10000) + 'MIDDLE_NEEDLE' + 'B'.repeat(10000);
  const ref = groupEvent(f.store, 'science', 'evidence', { value });
  assert.equal(
    (historyPage(f.store, null, { action: 'search', query: 'MIDDLE_NEEDLE' }) as any).records
      .length,
    0,
  );
  assert.equal(
    (
      historyPage(
        f.store,
        { groupId: 'science' },
        { action: 'search', query: 'MIDDLE_NEEDLE' },
      ) as any
    ).records.length,
    1,
  );
  assert.match(
    (
      historyPage(
        f.store,
        { groupId: 'science' },
        { action: 'read', id: ref, offset: 0, chars: 30000 },
      ) as any
    ).content,
    /MIDDLE_NEEDLE/,
  );
  let file = '';
  assert.throws(
    () =>
      f.store.transaction(() => {
        const r = archiveRecord(f.store, {
          id: 'will-rollback',
          sessionId: null,
          groupId: 'science',
          kind: 'group_test',
          content: 'not committed',
        });
        const row = f.store.get<any>("SELECT * FROM history_records WHERE id='will-rollback'")!;
        file = historyFile(f.store, row);
        assert.equal(fs.existsSync(file), false);
        throw new Error('rollback');
      }),
    /rollback/,
  );
  assert.equal(fs.existsSync(file), false);
  assert.equal(f.store.get("SELECT id FROM history_records WHERE id='will-rollback'"), undefined);
  const exported = exportGroups(f.store, f.session.id)[0]!;
  assert.ok(exported.history.some((r: any) => r.id === ref));
  assert.match(exported.document, /Science/);
});

test('source corrections retire earlier entries and dependency issues are durable, deduplicated and scoped', (t) => {
  const f = setup(t),
    a = f.publish('Old result'),
    b = f.publish('Dependent analysis', { dependsOn: [a.id] }, f.other.id);
  f.publish('Corrected result', { supersedes: [a.id], evidence: ['artifact:test'] });
  assert.equal(
    groupEntries(f.store, 'science', false).find((e) => e.id === a.id)?.status,
    'superseded',
  );
  assert.ok(groupEntries(f.store, 'science').some((e) => e.id === b.id));
  assert.equal(groupIssues(f.store, 'science').length, 1);
  assert.equal(f.store.all('SELECT * FROM inbound').length, 2);
  expireGroupEntries(f.store);
  assert.equal(f.store.all('SELECT * FROM inbound').length, 2);
  const issue = groupIssues(f.store, 'science')[0]!;
  groupBoard(f.store, f.session.id, {
    action: 'resolve',
    id: issue.id,
    revision: issue.revision,
    key: 'resolve',
    reason: 'Recomputed dependent analysis',
    evidence: ['artifact:new'],
  });
  assert.equal(groupIssues(f.store, 'science').length, 0);
  assert.equal(
    f.store.get<any>('SELECT revision FROM group_issues WHERE id=?', issue.id).revision,
    2,
  );
});

test('explicit expiration removes ephemeral state; age alone never retires unresolved work; revisions notify dependents', (t) => {
  const f = setup(t);
  const old = f.publish('Unfinished job', { kind: 'progress', observedAt: 1, reviewAfter: 2 });
  f.publish('Old durable decision', { kind: 'decision', observedAt: 1 });
  f.publish('Temporary status', { expiresAt: 2 });
  expireGroupEntries(f.store, 3);
  expireGroupEntries(f.store, 4);
  assert.equal(groupEntries(f.store, 'science').length, 2);
  assert.equal(groupIssues(f.store, 'science').length, 1);
  f.publish('Dependent', { dependsOn: [old.id] }, f.other.id);
  groupBoard(f.store, f.session.id, {
    action: 'revise',
    key: 'correct',
    id: old.id,
    revision: 1,
    entry: { kind: 'progress', subject: 'Unfinished job', summary: 'New checkpoint' },
  });
  assert.equal(groupIssues(f.store, 'science').length, 2);
});

test('direct current board edits import safely; stale edits preserve evidence and never overwrite newer facts', (t) => {
  const f = setup(t),
    a = f.publish('ORIGINAL');
  const file = path.join(groupDirectory(f.home, 'science'), 'AGENTS.md');
  const old = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, old.replace('"summary": "ORIGINAL"', '"summary": "EDITED"'));
  syncGroups(f.store);
  assert.equal(JSON.parse(groupEntries(f.store, 'science')[0]!.spec_json).summary, 'EDITED');
  const edited = fs.readFileSync(file, 'utf8');
  f.publish('NEW_PUBLICATION');
  fs.writeFileSync(file, edited.replace('"summary": "EDITED"', '"summary": "STALE_EDIT"'));
  syncGroups(f.store);
  assert.equal(
    JSON.parse(groupEntries(f.store, 'science').find((e) => e.id === a.id)!.spec_json).summary,
    'EDITED',
  );
  assert.equal(groupIssues(f.store, 'science').length, 1);
  assert.ok(
    (historyPage(f.store, { groupId: 'science' }, { action: 'search', query: 'STALE_EDIT' }) as any)
      .records.length,
  );
  const savedPolicy = parseMemory(fs.readFileSync(file, 'utf8')).instructions;
  syncGroups(f.store);
  assert.equal(parseMemory(fs.readFileSync(file, 'utf8')).instructions, savedPolicy);
});

test('complete source partitioning covers middle content and resumes persisted chunks across pass budgets', async (t) => {
  const f = setup(t);
  f.publish('Long record', { summary: 'x'.repeat(8000) + 'MIDDLE_NEEDLE' + 'y'.repeat(8000) });
  const parts = partitionSources([{ id: 'source', text: 'abcdef' }], 2);
  assert.equal(
    parts
      .flat()
      .map((p) => p.text)
      .join(''),
    'abcdef',
  );
  const seen: string[] = [];
  let passes = 0,
    status = '';
  do {
    status = await reviewer(
      f,
      async (r) => {
        const p = JSON.parse(r.prompt);
        seen.push(...p.sourceParts.map((v: any) => v.text));
        return accept(r.prompt);
      },
      { maxCallsPerPass: 1, chunkChars: 2000 },
    );
    assert.ok(++passes < 40);
  } while (status === 'paused');
  assert.equal(status, 'complete');
  assert.match(seen.join(''), /MIDDLE_NEEDLE/);
  assert.ok(passes > 2);
  assert.equal(
    getGroup(f.store, 'science').reviewed_revision,
    getGroup(f.store, 'science').revision,
  );
  assert.equal(f.store.get('SELECT * FROM group_review_jobs'), undefined);
});

test('review evidence lookup survives budget pauses and cancellation; unsupported retirement never commits', async (t) => {
  const f = setup(t),
    a = f.publish('Result');
  let requested = false;
  let status = await reviewer(
    f,
    async (r) => {
      requested = true;
      return JSON.stringify({ lookup: { entry: 'e1' } });
    },
    { maxCallsPerPass: 1 },
  );
  assert.equal(status, 'paused');
  assert.ok(requested);
  status = await reviewer(
    f,
    async (r) => {
      const p = JSON.parse(r.prompt);
      assert.ok(p.retrievedEvidence.length);
      return accept(r.prompt);
    },
    { maxCallsPerPass: 1 },
  );
  assert.equal(status, 'complete');
  f.publish('Second result');
  await assert.rejects(
    reviewer(
      f,
      async (r) =>
        accept(r.prompt, [
          {
            action: 'retire',
            entry: a.id,
            revision: 1,
            status: 'resolved',
            reason: 'guess',
            evidence: ['invented'],
          },
        ]),
      { maxCallsPerPass: 4 },
    ),
    /Unknown evidence/,
  );
  assert.ok(groupEntries(f.store, 'science').some((e) => e.id === a.id));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reviewGroup({
      store: f.store,
      groupId: 'science',
      config: f.config.groups.reviewer,
      signal: controller.signal,
      call: async () => '',
    }),
  );
});

test('a concurrent correction invalidates a model proposal; cyclic retirement plans are rejected', async (t) => {
  const f = setup(t),
    a = f.publish('First'),
    b = f.publish('Second');
  const status = await reviewer(f, async (r) => {
    f.publish('Concurrent finding');
    return accept(r.prompt, [
      {
        action: 'retire',
        entry: a.id,
        revision: 1,
        status: 'superseded',
        replacement: b.id,
        reason: 'replacement',
        evidence: ['e2'],
      },
    ]);
  });
  assert.equal(status, 'stale');
  assert.ok(groupEntries(f.store, 'science').some((e) => e.id === a.id));
  await assert.rejects(
    reviewer(
      f,
      async (r) =>
        accept(r.prompt, [
          {
            action: 'retire',
            entry: a.id,
            revision: 1,
            status: 'superseded',
            replacement: b.id,
            reason: 'replacement',
            evidence: ['e2'],
          },
          {
            action: 'retire',
            entry: b.id,
            revision: 1,
            status: 'superseded',
            replacement: a.id,
            reason: 'replacement',
            evidence: ['e1'],
          },
        ]),
      { maxCallsPerPass: 4 },
    ),
    /Replacement must remain active/,
  );
  assert.equal(groupEntries(f.store, 'science').length, 3);
});

test('review repair identifies unsupported citations and invented issues without changing the board', async (t) => {
  const f = setup(t);
  f.publish('Current finding');
  let calls = 0;
  const status = await reviewer(f, async (r) => {
    const prompt = JSON.parse(r.prompt);
    assert.deepEqual(prompt.allowedIssueIds, []);
    assert.ok(prompt.allowedEvidenceRefs.includes('e1'));
    calls++;
    if (calls === 2) assert.match(prompt.validationError, /history:missing/);
    if (calls === 3) {
      assert.match(prompt.validationError, /invented-issue/);
      assert.match(prompt.validationError, /Existing open issues: \[\]/);
      return accept(r.prompt);
    }
    return accept(r.prompt, [
      {
        action: 'resolve',
        issue: 'invented-issue',
        revision: 1,
        reason: 'A revised entry already contains the correction',
        evidence: calls === 1 ? ['history:missing'] : ['e1'],
      },
    ]);
  });
  assert.equal(status, 'complete');
  assert.equal(calls, 3);
  assert.equal(groupEntries(f.store, 'science').length, 1);
  assert.deepEqual(groupIssues(f.store, 'science'), []);
});

test('schema 4 upgrade refuses a live daemon, then preserves sessions and native IDs offline', (t) => {
  const f = setup(t);
  const home = path.join(f.home, 'upgrade');
  fs.mkdirSync(home);
  const db = new DatabaseSync(path.join(home, 'clawstrum.db'));
  // A real schema-4 database, derived from this schema with only the new additive group tables removed.
  f.store.db.exec(`VACUUM INTO '${path.join(home, 'copy.db').replaceAll("'", "''")}'`);
  db.close();
  fs.renameSync(path.join(home, 'copy.db'), path.join(home, 'clawstrum.db'));
  const previous = new DatabaseSync(path.join(home, 'clawstrum.db'));
  previous.exec(
    'PRAGMA foreign_keys=OFF; DROP INDEX history_group; DROP INDEX history_maintenance; ALTER TABLE history_records DROP COLUMN group_id; DROP TABLE group_review_routes; DROP TABLE group_receipts; DROP TABLE group_review_jobs; DROP TABLE group_issues; DROP TABLE group_audiences; DROP TABLE group_entries; DROP TABLE group_memberships; DROP TABLE group_channels; DROP TABLE groups; ALTER TABLE sessions DROP COLUMN active_model; UPDATE schema_version SET version=4;',
  );
  previous.close();
  const release = acquireLock(home);
  try {
    assert.throws(() => new Store(home), /already|lock|running/i);
  } finally {
    release();
  }
  const upgraded = new Store(home);
  try {
    assert.equal(upgraded.get<any>('SELECT version FROM schema_version').version, 6);
    assert.equal(upgraded.session(f.session.id).channel_id, f.session.channel_id);
    assert.equal(upgraded.all('SELECT * FROM groups').length, 0);
  } finally {
    upgraded.close();
  }
});

test('group issue notices and agent replies share a real Discord thread, with stable run output routes', async (t) => {
  const f = setup(t),
    a = f.publish('Needs review', { reviewAfter: 1 });
  expireGroupEntries(f.store, 2);
  const issue = groupIssues(f.store, 'science')[0]!;
  const channels = new Map<string, any>();
  const sent: string[] = [];
  let creates = 0;
  const thread = (id: string) => ({
    id,
    name: 'Clawstrum science review',
    parentId: f.session.channel_id,
    isThread: () => true,
    isSendable: () => true,
    send: async () => {
      sent.push(id);
      return { id: 'sent-' + sent.length };
    },
  });
  channels.set(f.session.channel_id, {
    ...thread(f.session.channel_id),
    type: ChannelType.GuildText,
    isThread: () => false,
    threads: {
      fetchActive: async () => ({
        threads: new Map([...channels].filter(([, c]) => c.isThread())),
      }),
      create: async ({ startMessage }: any) => {
        creates++;
        const result = thread(startMessage ?? '333333');
        channels.set(result.id, result);
        return result;
      },
    },
  });
  const client: any = {
    channels: {
      fetch: async (id: string) => {
        if (!channels.has(id)) throw Object.assign(new Error('missing'), { code: 10003 });
        return channels.get(id);
      },
    },
  };
  const notice = f.store.get<Outbound>(
    "SELECT * FROM outbox WHERE dedupe_key LIKE 'group-issue:%'",
  )!;
  const claimed = f.store.claim(f.session.id)!;
  const output = f.store.outbox(f.session.id, 'Checking the reported discrepancy', {
    runId: claimed.run.id,
    origin: 'agent',
  });
  // A later input may change where later output goes; already-created delivery remains attached to its issue.
  f.store.exec(
    'UPDATE runs SET message_ids=? WHERE id=?',
    JSON.stringify(['later-human-input']),
    claimed.run.id,
  );
  await Promise.all([
    sendDiscordDelivery(client, f.store, f.session.channel_id, notice),
    sendDiscordDelivery(
      client,
      f.store,
      f.session.channel_id,
      f.store.get<Outbound>('SELECT * FROM outbox WHERE id=?', output)!,
    ),
  ]);
  assert.equal(creates, 1);
  assert.deepEqual(sent, ['333333', '333333']);
  assert.equal(groupReviewThread(f.store, '333333')?.issue, issue.id);
  assert.equal(groupReviewThread(f.store, '333333')?.channel, f.session.channel_id);
  assert.equal(
    f.store.all('SELECT * FROM sessions').length,
    3,
    'review routing does not create another workspace',
  );
});

test('operator routing deduplicates multi-source review notices and resolutions, including concurrent delivery and restart', async (t) => {
  const f = setup(t);
  const a = f.publish('First source'),
    b = f.publish('Second source', {}, f.other.id);
  const issue = openGroupIssue(
    f.store,
    'science',
    'conflict',
    'Compare measurements',
    [a.id, b.id],
    [a.id],
  );
  const notices = f.store.all<Outbound>(
    "SELECT * FROM outbox WHERE dedupe_key LIKE 'group-issue:%'",
  );
  const sent: Array<{ channel: string; payload: any }> = [];
  const client: any = {
    channels: {
      fetch: async (channel: string) => {
        assert.equal(
          channel,
          f.outsider.channel_id,
          'never fetch or create a thread in a source channel',
        );
        return {
          isSendable: () => true,
          send: async (payload: any) => {
            sent.push({ channel, payload });
            return { id: `sent-${sent.length}` };
          },
        };
      },
    },
  };
  const deliver = (row: Outbound, target = f.outsider.channel_id) =>
    sendDiscordDelivery(
      client,
      f.store,
      f.store.session(row.session_id).channel_id,
      row,
      false,
      target,
    );
  assert.equal(notices.length, 2);
  assert.deepEqual(await Promise.all(notices.map((row) => deliver(row))), ['sent-1', 'sent-1']);
  assert.equal(sent.length, 1);
  const content = JSON.stringify(sent[0]!.payload);
  assert.match(content, new RegExp(f.session.channel_id));
  assert.match(content, new RegExp(f.other.channel_id));
  // `notices` has no ORDER BY, so its row order is whatever SQLite's query plan
  // picks for this LIKE and is not guaranteed to match insertion order. Pick the
  // row for f.session explicitly instead of assuming index 0 is it.
  const ownNotice = notices.find(
    (row) => f.store.session(row.session_id).channel_id === f.session.channel_id,
  )!;
  const reopened = new Store(f.home);
  try {
    await sendDiscordDelivery(client, reopened, f.session.channel_id, ownNotice, false, '777777');
  } finally {
    reopened.close();
  }
  assert.equal(sent.length, 1, 'durable acknowledgment prevents a repeat');
  assert.equal(
    f.store.all("SELECT * FROM inbound WHERE kind='task'").length,
    2,
    'review stays in the owning workspaces',
  );
  assert.equal(
    f.store.all('SELECT * FROM group_review_routes WHERE thread_id IS NOT NULL').length,
    0,
  );
  const claimed = f.store.claim(f.session.id)!;
  const output = f.store.outbox(f.session.id, 'Evidence checked', {
    runId: claimed.run.id,
    origin: 'agent',
  });
  await deliver(f.store.get<Outbound>('SELECT * FROM outbox WHERE id=?', output)!);
  assert.equal(sent.length, 2, 'automatic review replies also reach the operator');
  resolveGroupIssue(
    f.store,
    issue,
    1,
    'Different datasets explain the measurements',
    [a.id, b.id],
    f.session.id,
  );
  const resolved = f.store.all<Outbound>(
    "SELECT * FROM outbox WHERE dedupe_key LIKE 'group-resolved:%'",
  );
  await Promise.all(resolved.map((row) => deliver(row, '777777')));
  assert.equal(
    sent.length,
    3,
    'one resolution follows the issue to its original operator destination',
  );
});

test('operator delivery failures retry there without leaking to a source channel or duplicating acknowledged chunks', async (t) => {
  const f = setup(t),
    a = f.publish('Long issue');
  openGroupIssue(f.store, 'science', 'long', 'Evidence to check. '.repeat(250), [a.id], [a.id]);
  const row = f.store.get<Outbound>("SELECT * FROM outbox WHERE dedupe_key LIKE 'group-issue:%'")!;
  let sends = 0,
    failed = false;
  const received: string[] = [];
  const client: any = {
    channels: {
      fetch: async (channel: string) => {
        assert.equal(channel, f.outsider.channel_id);
        return {
          isSendable: () => true,
          send: async (payload: any) => {
            if (++sends === 2 && !failed) {
              failed = true;
              throw Object.assign(new Error('No access'), { code: 50013 });
            }
            received.push(JSON.stringify(payload));
            return { id: `sent-${sends}` };
          },
        };
      },
    },
  };
  await assert.rejects(
    sendDiscordDelivery(client, f.store, f.session.channel_id, row, false, f.outsider.channel_id),
    /No access/,
  );
  const first = received[0];
  await sendDiscordDelivery(client, f.store, f.session.channel_id, row, false, '777777');
  assert.ok(received.length > 1);
  assert.equal(received.filter((p) => p === first).length, 1);
  assert.equal(
    f.store.all('SELECT * FROM group_review_routes WHERE thread_id IS NOT NULL').length,
    0,
  );
});

test('explicit human review-thread replies and ordinary channel answers keep their destinations', async (t) => {
  const f = setup(t),
    a = f.publish('Thread discussion');
  const issue = openGroupIssue(f.store, 'science', 'thread', 'Check', [a.id], [a.id]);
  f.store.exec('UPDATE group_review_routes SET thread_id=? WHERE issue_id=?', '333333', issue);
  const id = f.store.outbox(f.session.id, 'Reply to the human', { origin: 'agent' });
  f.store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?)',
    `group-output:${id}`,
    JSON.stringify({ issue, channel: f.session.channel_id, thread: '333333' }),
  );
  const sent: string[] = [];
  const client: any = {
    channels: {
      fetch: async (channel: string) => ({
        id: channel,
        parentId: f.session.channel_id,
        type: ChannelType.GuildText,
        isThread: () => channel === '333333',
        isSendable: () => true,
        send: async () => {
          sent.push(channel);
          return { id: `sent-${sent.length}` };
        },
      }),
    },
  };
  const reply = f.store.get<Outbound>('SELECT * FROM outbox WHERE id=?', id)!;
  await sendDiscordDelivery(
    client,
    f.store,
    f.session.channel_id,
    reply,
    false,
    f.outsider.channel_id,
  );
  const ordinary = f.store.outbox(f.session.id, 'Normal answer', { origin: 'agent' });
  await sendDiscordDelivery(
    client,
    f.store,
    f.session.channel_id,
    f.store.get<Outbound>('SELECT * FROM outbox WHERE id=?', ordinary)!,
    false,
    f.outsider.channel_id,
  );
  assert.deepEqual(sent, ['333333', f.session.channel_id]);
});

test('board retention semantics reach tools, context and every review request without retiring historical questions', async (t) => {
  const f = setup(t),
    a = f.publish('Historical request', {
      kind: 'question',
      summary:
        'No completed result or running job is established. Keep as historical context; do not resume automatically.',
    });
  const board: any = groupBoard(f.store, f.session.id, { action: 'read' });
  assert.equal(board[0].entries[0].status, 'active');
  assert.deepEqual(board[0].entryStatusMeaning, GROUP_ENTRY_STATUS);
  assert.match(
    fs.readFileSync(path.join(groupDirectory(f.home, 'science'), 'AGENTS.md'), 'utf8'),
    /not a claim of active work/,
  );
  await reviewer(f, async (request) => {
    const p = JSON.parse(request.prompt);
    assert.deepEqual(p.entryStatusMeaning, GROUP_ENTRY_STATUS);
    assert.equal(request.instructions, GROUP_REVIEW_INSTRUCTIONS);
    assert.match(
      request.instructions,
      /historical question can remain active without contradiction/,
    );
    return accept(request.prompt);
  });
  assert.equal(groupEntries(f.store, 'science')[0]!.id, a.id);
  assert.equal(groupIssues(f.store, 'science').length, 0);
});

test('reviewer contract changes invalidate paused proposals even when group policy and board are unchanged', async (t) => {
  const f = setup(t),
    a = f.publish('Retained context', { summary: 'Historical context. '.repeat(50) });
  await reviewer(
    f,
    async (r) =>
      accept(r.prompt, [
        { action: 'issue', entries: [a.id], message: 'Obsolete interpretation', evidence: [a.id] },
      ]),
    { chunkChars: 500, maxCallsPerPass: 1 },
  );
  const state = JSON.parse(
    f.store.get<{ state_json: string }>(
      'SELECT state_json FROM group_review_jobs WHERE group_id=?',
      'science',
    )!.state_json,
  );
  assert.equal(state.operations.length, 1);
  state.policyHash = 'legacy-contract';
  f.store.exec(
    'UPDATE group_review_jobs SET state_json=? WHERE group_id=?',
    JSON.stringify(state),
    'science',
  );
  assert.equal(
    await reviewer(f, async (r) => {
      const p = JSON.parse(r.prompt);
      assert.equal(p.chunkIndex, 0);
      assert.deepEqual(p.previousOperations, []);
      return accept(r.prompt);
    }),
    'complete',
  );
  assert.equal(groupIssues(f.store, 'science').length, 0);
});

test(
  'compiled group review crosses provider IPC with economical routing and separate usage attribution',
  { timeout: 30000 },
  async (t) => {
    const f = setup(t);
    f.publish('Reproducible finding');
    f.config.groups.reviewer.debounceMs = 0;
    f.config.groups.reviewer.debounceMaxMs = 0;
    f.config.runtime.maxConcurrent = 1;
    f.config.accounts[0]!.maxConcurrent = 1;
    const executable = path.join(f.home, 'group-cli.mjs');
    fs.writeFileSync(
      executable,
      `#!${process.execPath}
import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('2.1.270');process.exit(0);}
if(!process.argv.includes('haiku'))throw new Error('Reviewer inherited the lead model');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],models:[],account:null}}});
 if(m.type==='user'){
  const p=JSON.parse(m.message.content);
  send({type:'system',subtype:'init',session_id:'maintenance-only',tools:[],mcp_servers:[],model:'haiku',permissionMode:'bypassPermissions',apiKeySource:'none',cwd:process.cwd(),uuid:'init'});
  send({type:'result',subtype:'success',result:JSON.stringify({chunk:p.chunk,notes:'Checked.',operations:[]}),is_error:false,session_id:'maintenance-only',uuid:'result',duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{},modelUsage:{fake:{inputTokens:10,outputTokens:1}},permission_denials:[]});
 }
}`,
      { mode: 0o700 },
    );
    f.config.accounts[0]!.executable = executable;
    fs.mkdirSync(f.config.accounts[0]!.home, { recursive: true });
    const { Engine } = await import('../dist/engine.js' as string);
    const engine = new Engine(f.config, f.store);
    try {
      engine.tick();
      await Promise.all([...engine.groupReviews.active.values()].map((work: any) => work.promise));
      assert.equal(getGroup(f.store, 'science').dirty_since, null);
      assert.equal(getGroup(f.store, 'science').error, null);
      const usage = f.store
        .all<{ value: string }>("SELECT value FROM metadata WHERE key LIKE 'usage:%'")
        .map((row) => JSON.parse(row.value))
        .filter((row) => row.role === 'group_reviewer');
      assert.equal(usage.length, 1);
      assert.equal(usage[0].snapshot.totals.totalTokens, 11);
      assert.equal(usage[0].model, 'haiku');
      assert.equal(
        f.store.session(f.session.id).remote_id,
        null,
        'maintenance session never replaces channel native state',
      );
      assert.equal(engine.maintenance.size, 0);
    } finally {
      await engine.stop();
    }
  },
);

test('later chunks can withdraw a provisional retirement before any board mutation', async (t) => {
  const f = setup(t);
  const a = f.publish('First', { summary: 'x'.repeat(6000) }),
    b = f.publish('Second');
  let calls = 0;
  await reviewer(
    f,
    async (r) => {
      calls++;
      return accept(
        r.prompt,
        calls === 1
          ? [
              {
                action: 'retire',
                entry: a.id,
                revision: 1,
                status: 'superseded',
                replacement: b.id,
                reason: 'Provisional duplicate',
                evidence: ['e1'],
              },
            ]
          : [],
      );
    },
    { chunkChars: 2000, maxCallsPerPass: 30 },
  );
  assert.ok(calls > 1);
  assert.equal(groupEntries(f.store, 'science').length, 2);
});

test('maintenance errors redact echoed credentials before entering the shared board', async (t) => {
  const f = setup(t);
  f.config.groups.reviewer.debounceMs = 0;
  f.config.groups.reviewer.debounceMaxMs = 0;
  const reviews = new GroupReviews(
    f.store,
    f.config,
    async () => {
      throw new Error('upstream failed; Bearer private-example-credential');
    },
    () => 0,
    () => 1,
  );
  reviews.tick();
  await Promise.all([...reviews.active.values()].map((w) => w.promise));
  syncGroups(f.store);
  assert.doesNotMatch(getGroup(f.store, 'science').error!, /private-example/);
  assert.match(getGroup(f.store, 'science').error!, /redacted/);
  assert.doesNotMatch(f.snapshot().memory, /private-example/);
});
