import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Store } from '../store.js';
import type { Session } from '../types.js';
import { archiveRecord, historyRoot, historyPage } from '../history.js';
import { parseMemory, withMemoryLock } from '../memory.js';
import { writePrivate } from '../files.js';
import { boardInput, entrySpec, groupId, type EntrySpec, type BoardInput } from './config.js';

export interface Group {
  id: string;
  name: string;
  purpose: string;
  revision: number;
  reviewed_revision: number;
  dirty_since: number | null;
  next_review: number;
  error: string | null;
  rendered_memory: string | null;
  rendered_revision: number;
  created_at: number;
  updated_at: number;
}
export interface Entry {
  id: string;
  source_session: string | null;
  source_message: string | null;
  origin_id: string;
  revision: number;
  spec_json: string;
  created_at: number;
  updated_at: number;
  status: string;
  replacement: string | null;
}
export interface Issue {
  id: string;
  group_id: string;
  revision: number;
  status: string;
  message: string;
  entries_json: string;
  evidence_json: string;
  channels_json: string;
  resolution: string | null;
}
export const hash = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export const groupDirectory = (home: string, id: string) =>
  path.join(home, 'groups', groupId.parse(id));
export function getGroup(store: Store, id: string): Group {
  const row = store.get<Group>('SELECT * FROM groups WHERE id=?', groupId.parse(id));
  if (!row) throw new Error(`Unknown group: ${id}`);
  return row;
}
export function groups(store: Store): Group[] {
  return store.all('SELECT * FROM groups ORDER BY id');
}
export function groupEvent(
  store: Store,
  id: string,
  kind: string,
  content: unknown,
  key: string = randomUUID(),
): string {
  const record = `group:${id}:${kind}:${key}`;
  archiveRecord(store, {
    id: record,
    sessionId: null,
    groupId: id,
    kind: `group_${kind}`,
    source: `group:${id}`,
    content,
  });
  return record;
}
export function touchGroup(store: Store, id: string, now = Date.now()): void {
  store.exec(
    'UPDATE groups SET revision=revision+1,dirty_since=COALESCE(dirty_since,?),updated_at=?,next_review=0,error=NULL WHERE id=?',
    now,
    now,
    id,
  );
}
export function groupView(group: Group) {
  const { rendered_memory: _memory, rendered_revision: _rendered, ...view } = group;
  return view;
}
export const GROUP_ENTRY_STATUS = {
  active:
    'Retained on the current information board; not a claim of active work, a running job, a current blocker, or authorization to resume historical requests.',
  superseded: 'Replaced by another board entry; retained in raw history.',
  resolved:
    'Retired with evidence of completion, cancellation, or resolution; retained in raw history.',
  retracted: 'Withdrawn by its source; retained in raw history.',
  expired: 'Removed after its explicitly specified expiry; retained in raw history.',
} as const;
export function groupEntries(store: Store, id: string, active = true): Entry[] {
  return store.all(
    `SELECT e.*,a.status,a.replacement FROM group_entries e JOIN group_audiences a ON a.entry_id=e.id WHERE a.group_id=? ${active ? "AND a.status='active'" : ''} ORDER BY e.created_at,e.id`,
    id,
  );
}
export function groupIssues(store: Store, id: string): Issue[] {
  return store.all(
    "SELECT * FROM group_issues WHERE group_id=? AND status='open' ORDER BY created_at,id",
    id,
  );
}
export function memberGroups(store: Store, channel: string, seen = new Set<string>()): string[] {
  if (seen.has(channel) || seen.size > 20) throw new Error('Cyclic channel parent membership');
  seen.add(channel);
  const parent = store.get<{ parent_id: string | null }>(
    'SELECT parent_id FROM group_channels WHERE channel_id=?',
    channel,
  )?.parent_id;
  const result = new Set(parent ? memberGroups(store, parent, seen) : []);
  for (const row of store.all<{ group_id: string; enabled: number }>(
    'SELECT group_id,enabled FROM group_memberships WHERE channel_id=?',
    channel,
  ))
    if (row.enabled) result.add(row.group_id);
    else result.delete(row.group_id);
  return [...result].sort();
}
export function assertGroupMember(store: Store, session: string, id: string): void {
  getGroup(store, id);
  if (!memberGroups(store, store.session(session).channel_id).includes(id))
    throw new Error(`This channel is not a member of group ${id}`);
}
export function recordGroupChannel(
  store: Store,
  session: Session,
  name: string,
  parent: string | null = null,
): void {
  const old = store.get<{ name: string; parent_id: string | null }>(
    'SELECT name,parent_id FROM group_channels WHERE channel_id=?',
    session.channel_id,
  );
  if (old?.name === name && old.parent_id === parent) return;
  withMemoryLock(store, () => {
    const prior = memberGroups(store, session.channel_id);
    store.transaction(() => {
      store.exec(
        'INSERT INTO group_channels(channel_id,session_id,name,parent_id) VALUES(?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id',
        session.channel_id,
        session.id,
        name,
        parent,
      );
      for (const id of new Set([...prior, ...memberGroups(store, session.channel_id)])) {
        groupEvent(store, id, 'channel', { channel: session.channel_id, name, parent });
        touchGroup(store, id);
      }
    });
    renderGroupsUnlocked(store);
  });
}
export function createGroup(store: Store, id: string, name: string, purpose = ''): Group {
  groupId.parse(id);
  if (!name.trim()) throw new Error('Group name is required');
  withMemoryLock(store, () => {
    store.transaction(() => {
      const existing = store.get<Group>('SELECT * FROM groups WHERE id=?', id);
      if (existing) {
        if (existing.name !== name || existing.purpose !== purpose)
          throw new Error('Group already exists with different metadata');
        return;
      }
      const now = Date.now();
      store.exec(
        'INSERT INTO groups(id,name,purpose,dirty_since,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        id,
        name,
        purpose,
        now,
        now,
        now,
      );
      groupEvent(store, id, 'created', { id, name, purpose });
    });
    renderGroupsUnlocked(store);
  });
  return getGroup(store, id);
}
export function setGroupMembership(
  store: Store,
  id: string,
  sessionId: string,
  enabled: boolean,
  role = '',
): void {
  getGroup(store, id);
  const session = store.session(sessionId);
  withMemoryLock(store, () => {
    store.transaction(() => {
      const prior = store.get<{ enabled: number; role: string }>(
        'SELECT enabled,role FROM group_memberships WHERE group_id=? AND channel_id=?',
        id,
        session.channel_id,
      );
      if (prior?.enabled === Number(enabled) && prior.role === role) return;
      store.exec(
        'INSERT INTO group_channels(channel_id,session_id,name) VALUES(?,?,?) ON CONFLICT(channel_id) DO NOTHING',
        session.channel_id,
        session.id,
        session.channel_id,
      );
      store.exec(
        'INSERT INTO group_memberships(group_id,channel_id,role,enabled) VALUES(?,?,?,?) ON CONFLICT(group_id,channel_id) DO UPDATE SET role=excluded.role,enabled=excluded.enabled',
        id,
        session.channel_id,
        role,
        Number(enabled),
      );
      groupEvent(store, id, 'membership', {
        channel: session.channel_id,
        session: session.id,
        enabled,
        role,
      });
      touchGroup(store, id);
    });
    renderGroupsUnlocked(store);
  });
}
export function entryView(row: Entry) {
  const spec = JSON.parse(row.spec_json) as EntrySpec;
  return {
    ...row,
    spec,
    spec_json: undefined,
    scopeStatus: spec.scope ? 'declared_not_independently_verified' : 'unspecified',
  };
}
function validateReferences(store: Store, ids: string[], refs: string[]): void {
  for (const ref of refs)
    if (
      !ids.every((id) =>
        store.get('SELECT entry_id FROM group_audiences WHERE group_id=? AND entry_id=?', id, ref),
      )
    )
      throw new Error(`Entry reference is not present in every target group: ${ref}`);
}
/** Transactional domain operation; caller owns the document mutex and outer transaction. */
export function publishEntry(
  store: Store,
  ids: string[],
  spec: EntrySpec,
  source: { session: string | null; message?: string },
  origin: string = randomUUID(),
): string {
  validateReferences(store, ids, [...spec.dependsOn, ...spec.supersedes]);
  const id = randomUUID(),
    now = Date.now();
  store.exec(
    'INSERT INTO group_entries(id,source_session,source_message,origin_id,spec_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    id,
    source.session,
    source.message ?? null,
    origin,
    JSON.stringify(spec),
    now,
    now,
  );
  for (const group of ids) {
    store.exec('INSERT INTO group_audiences(group_id,entry_id) VALUES(?,?)', group, id);
    for (const old of spec.supersedes) {
      const sourceRow = store.get<{ source_session: string | null }>(
        'SELECT source_session FROM group_entries WHERE id=?',
        old,
      )!;
      if (sourceRow.source_session === source.session && source.session !== null)
        retireEntry(
          store,
          group,
          old,
          'superseded',
          'Explicit correction by source channel',
          spec.evidence,
          id,
        );
      else
        openGroupIssue(
          store,
          group,
          `replacement:${old}:${id}`,
          'A publication proposes replacing another source’s entry. Check whether the evidence establishes the correction.',
          [old, id],
          spec.evidence,
        );
    }
    groupEvent(store, group, 'published', {
      ...entryView(store.get<Entry>('SELECT * FROM group_entries WHERE id=?', id)!),
      audiences: ids,
    });
    touchGroup(store, group);
  }
  return id;
}
export function retireEntry(
  store: Store,
  group: string,
  id: string,
  status: string,
  reason: string,
  evidence: string[],
  replacement?: string,
): void {
  const row = store.get<Entry>(
    'SELECT e.*,a.status FROM group_entries e JOIN group_audiences a ON a.entry_id=e.id WHERE e.id=? AND a.group_id=?',
    id,
    group,
  );
  if (!row) throw new Error('Entry not in group');
  if (replacement) {
    if (
      replacement === id ||
      !store.get(
        "SELECT entry_id FROM group_audiences WHERE entry_id=? AND group_id=? AND status='active'",
        replacement,
        group,
      )
    )
      throw new Error('Replacement must be another active entry in this group');
  }
  if (row.status !== 'active') return;
  store.exec(
    'UPDATE group_audiences SET status=?,replacement=? WHERE group_id=? AND entry_id=?',
    status,
    replacement ?? null,
    group,
    id,
  );
  groupEvent(store, group, 'retired', {
    id,
    revision: row.revision,
    status,
    reason,
    evidence,
    replacement: replacement ?? null,
  });
  touchGroup(store, group);
  notifyDependents(store, group, id, row.revision, reason, evidence, status);
}
function notifyDependents(
  store: Store,
  group: string,
  id: string,
  revision: number,
  reason: string,
  evidence: string[],
  status = 'revised',
): void {
  const dependents = groupEntries(store, group).filter((e) =>
    (JSON.parse(e.spec_json) as EntrySpec).dependsOn.includes(id),
  );
  if (dependents.length)
    openGroupIssue(
      store,
      group,
      `dependency:${id}:${revision}:${status}`,
      `Shared entry ${id} changed (${reason}). Check work that depends on it.`,
      [id, ...dependents.map((e) => e.id)],
      evidence,
    );
}
export function openGroupIssue(
  store: Store,
  group: string,
  key: string,
  message: string,
  entries: string[],
  evidence: string[],
  extraSessions: string[] = [],
): string {
  const dedupe = `${group}:${key}`;
  const existing = store.get<{ id: string }>(
    'SELECT id FROM group_issues WHERE dedupe_key=?',
    dedupe,
  );
  if (existing) return existing.id;
  validateReferences(store, [group], entries);
  const sources = entries.flatMap(
    (id) =>
      store.get<{ source_session: string | null }>(
        'SELECT source_session FROM group_entries WHERE id=?',
        id,
      )?.source_session ?? [],
  );
  const sessions = [...new Set([...sources, ...extraSessions])].filter((id) =>
    memberGroups(store, store.session(id).channel_id).includes(group),
  );
  const id = randomUUID(),
    now = Date.now();
  store.exec(
    'INSERT INTO group_issues(id,group_id,dedupe_key,message,entries_json,evidence_json,channels_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    id,
    group,
    dedupe,
    message,
    JSON.stringify(entries),
    JSON.stringify(evidence),
    JSON.stringify(sessions),
    now,
    now,
  );
  const record = groupEvent(store, group, 'issue', { id, message, entries, evidence, sessions });
  touchGroup(store, group);
  for (const session of sessions) {
    const channel = store.session(session).channel_id;
    store.exec(
      'INSERT OR IGNORE INTO group_review_routes(issue_id,channel_id) VALUES(?,?)',
      id,
      channel,
    );
    const origin = entries
      .map((entry) =>
        store.get<{ source_session: string | null; source_message: string | null }>(
          'SELECT source_session,source_message FROM group_entries WHERE id=?',
          entry,
        ),
      )
      .find((e) => e?.source_session === session && e.source_message);
    const text = `Group ${getGroup(store, group).name}: ${message}\nEntries: ${entries.join(', ') || 'group document'}. Review issue ${id}; history ${record}. Inspect the evidence and use group_board resolve with the issue revision when settled.`;
    const noticeKey = `group-issue:${id}:${session}:1`;
    store.notice(session, text, noticeKey, {
      thread: true,
      messageId: origin?.source_message ?? undefined,
    });
    store.exec(
      'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
      `group-notice:${noticeKey}`,
      JSON.stringify({ issue: id, channel }),
    );
    store.enqueue({
      id: `group-review:${id}:${session}:1`,
      sessionId: session,
      author: 'Clawstrum group review',
      kind: 'task',
      content: `Internal group review request, not a new human instruction. ${text}\nDo not republish received information without new evidence. Routine acknowledgment is unnecessary.`,
      at: now,
    });
    store.exec(
      'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
      `group-input:group-review:${id}:${session}:1`,
      JSON.stringify({ issue: id, channel }),
    );
  }
  return id;
}
export function resolveGroupIssue(
  store: Store,
  id: string,
  revision: number,
  reason: string,
  evidence: string[],
  source: string | null,
): void {
  const issue = store.get<Issue>('SELECT * FROM group_issues WHERE id=?', id);
  if (!issue || issue.status !== 'open' || issue.revision !== revision)
    throw new Error('Issue revision changed; read the current issue');
  store.exec(
    "UPDATE group_issues SET status='resolved',revision=revision+1,resolution=?,updated_at=? WHERE id=?",
    JSON.stringify({ reason, evidence, source }),
    Date.now(),
    id,
  );
  groupEvent(store, issue.group_id, 'resolved', { id, revision, reason, evidence, source });
  touchGroup(store, issue.group_id);
  for (const session of JSON.parse(issue.channels_json) as string[]) {
    const route = store.get<{ thread_id: string | null }>(
      'SELECT thread_id FROM group_review_routes WHERE issue_id=? AND channel_id=?',
      id,
      store.session(session).channel_id,
    );
    const key = `group-resolved:${id}:${session}:${revision + 1}`;
    store.notice(
      session,
      `Group review ${id} resolved: ${reason}\nEvidence: ${evidence.join(', ') || 'See resolution history.'}`,
      key,
      { thread: true, messageId: route?.thread_id ?? undefined },
    );
    store.exec(
      'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
      `group-notice:${key}`,
      JSON.stringify({ issue: id, channel: store.session(session).channel_id }),
    );
  }
}
export function groupBoard(
  store: Store,
  sessionId: string,
  raw: unknown,
  message?: string,
): unknown {
  const input = boardInput.parse(raw);
  const available = memberGroups(store, store.session(sessionId).channel_id);
  const ids = [
    ...new Set(
      input.groups ??
        (input.action === 'list' ? available : available.length === 1 ? available : []),
    ),
  ].sort();
  if (input.action !== 'list' && !ids.length)
    throw new Error('Specify target groups; use group_board list for memberships');
  for (const id of ids) assertGroupMember(store, sessionId, id);
  if (input.action === 'list' || input.action === 'read')
    return ids.map((id) => ({
      group: groupView(getGroup(store, id)),
      entryStatusMeaning: GROUP_ENTRY_STATUS,
      entries: (input.id
        ? groupEntries(store, id, false).filter((e) => e.id === input.id)
        : groupEntries(store, id)
      )
        .slice(input.after ?? 0, (input.after ?? 0) + input.limit)
        .map(entryView),
      issues: groupIssues(store, id),
      nextAfter:
        !input.id && groupEntries(store, id).length > (input.after ?? 0) + input.limit
          ? (input.after ?? 0) + input.limit
          : null,
      history: historyRoot(store, { groupId: id }),
    }));
  if (!input.key) throw new Error('Mutation requires a stable key');
  const receipt = `${sessionId}:group:${input.key}`,
    fingerprint = hash({ ...input, groups: ids });
  let result: unknown;
  withMemoryLock(store, () => {
    store.transaction(() => {
      const old = store.get<{ hash: string; result_json: string }>(
        'SELECT hash,result_json FROM group_receipts WHERE key=?',
        receipt,
      );
      if (old) {
        if (old.hash !== fingerprint) throw new Error('Key already names different content');
        result = JSON.parse(old.result_json);
        return;
      }
      result = mutateBoard(store, ids, sessionId, input, message);
      store.exec(
        'INSERT INTO group_receipts(key,hash,result_json) VALUES(?,?,?)',
        receipt,
        fingerprint,
        JSON.stringify(result),
      );
    });
    renderGroupsUnlocked(store);
  });
  return result;
}
function mutateBoard(
  store: Store,
  ids: string[],
  session: string,
  input: BoardInput,
  message?: string,
): unknown {
  if (input.action === 'publish') {
    if (!input.entry) throw new Error('publish requires entry');
    return {
      id: publishEntry(store, ids, input.entry, { session, message }),
      revision: 1,
      groups: ids,
      review: 'pending',
    };
  }
  if (!input.id || !input.revision) throw new Error('Mutation requires id and expected revision');
  if (input.action === 'resolve') {
    const issue = store.get<Issue>('SELECT * FROM group_issues WHERE id=?', input.id);
    if (!issue || !ids.includes(issue.group_id) || !input.reason)
      throw new Error('Resolve needs the issue group and reason');
    resolveGroupIssue(store, input.id, input.revision, input.reason, input.evidence ?? [], session);
    return { id: input.id, revision: input.revision + 1, status: 'resolved' };
  }
  validateReferences(store, ids, [input.id]);
  const current = store.get<Entry>('SELECT * FROM group_entries WHERE id=?', input.id)!;
  if (current.revision !== input.revision)
    throw new Error('Entry revision changed; read current entry');
  if (input.action === 'retract') {
    if (!input.reason) throw new Error('Retraction requires a reason');
    for (const group of ids)
      retireEntry(store, group, input.id, 'retracted', input.reason, input.evidence ?? []);
    return { id: input.id, status: 'retracted', groups: ids };
  }
  if (input.action !== 'revise' || !input.entry) throw new Error('revise requires entry');
  const audiences = store
    .all<{
      group_id: string;
    }>("SELECT group_id FROM group_audiences WHERE entry_id=? AND status='active'", input.id)
    .map((r) => r.group_id);
  if (ids.some((id) => !audiences.includes(id)))
    throw new Error('Only active board entries can be revised');
  if (audiences.some((id) => !ids.includes(id)))
    throw new Error('A revision updates all current audiences; include every audience group');
  validateReferences(store, ids, [...input.entry.dependsOn, ...input.entry.supersedes]);
  store.exec(
    'UPDATE group_entries SET spec_json=?,revision=revision+1,updated_at=? WHERE id=?',
    JSON.stringify(input.entry),
    Date.now(),
    input.id,
  );
  for (const group of ids) {
    groupEvent(store, group, 'revised', {
      id: input.id,
      before: entryView(current),
      entry: input.entry,
      source: session,
    });
    touchGroup(store, group);
    notifyDependents(
      store,
      group,
      input.id,
      input.revision + 1,
      input.reason ?? 'Source revised its claim',
      input.entry.evidence,
    );
  }
  return { id: input.id, revision: input.revision + 1, groups: ids, review: 'pending' };
}

function renderedMemory(store: Store, group: Group): string {
  const members = store.all<{ channel_id: string; name: string; role: string }>(
    `SELECT m.channel_id,COALESCE(c.name,m.channel_id) name,m.role FROM group_memberships m LEFT JOIN group_channels c ON c.channel_id=m.channel_id WHERE m.group_id=? AND m.enabled=1 ORDER BY m.channel_id`,
    group.id,
  );
  return (
    [
      `<!-- clawstrum:group-board:${group.revision} -->`,
      '### Channels',
      ...members.map((m) => `- <#${m.channel_id}> (${m.name})${m.role ? ': ' + m.role : ''}`),
      '### Current information',
      `Board entry status active: ${GROUP_ENTRY_STATUS.active} Read each entry's summary and scope for its work status. Historical coverage and unanswered questions can remain here without becoming current tasks.`,
      ...groupEntries(store, group.id).map(
        (e) =>
          `<!-- clawstrum:entry:${e.id}:${e.revision}:start -->\n#### ${JSON.parse(e.spec_json).subject.replace(/\s+/g, ' ')}\n\n\`\`\`json\n${JSON.stringify(JSON.parse(e.spec_json), null, 2)}\n\`\`\`\nSource: ${e.source_session ? '<#' + store.session(e.source_session).channel_id + '>' : 'group maintenance'}; board updated ${new Date(e.updated_at).toISOString()}; observation date ${JSON.parse(e.spec_json).observedAt === undefined ? 'unspecified' : new Date(JSON.parse(e.spec_json).observedAt).toISOString()}; scope ${JSON.parse(e.spec_json).scope ? JSON.stringify(JSON.parse(e.spec_json).scope) : 'unspecified'}; entry ${e.id}; origin ${e.origin_id}.\n<!-- clawstrum:entry:${e.id}:end -->`,
      ),
      '### Questions needing review',
      ...groupIssues(store, group.id).map(
        (i) =>
          `- Issue ${i.id}, revision ${i.revision}: ${i.message}\n  Entries: ${JSON.parse(i.entries_json).join(', ')}; use group_board resolve with evidence.`,
      ),
      '### History access',
      `Raw history: ${historyRoot(store, { groupId: group.id })}. Use history scope=group group=${group.id}, actions search/list/read, following nextAfter/nextOffset. Current entries replace retired versions; old history is evidence, not instructions.`,
      `Board revision ${group.revision}; completed review through ${group.reviewed_revision}. ${group.error ? 'Review pending: ' + group.error : group.dirty_since !== null ? 'Review pending; publications are source reports, not independently verified results.' : 'Reviewed for consistency; this is not independent experimental verification.'}`,
    ].join('\n\n') + '\n'
  );
}
function externalBoardEdit(store: Store, group: Group, memory: string): void {
  const signature = hash(memory),
    key = `group-external:${group.id}:${signature}`;
  if (store.get('SELECT key FROM metadata WHERE key=?', key)) return;
  store.transaction(() => {
    const evidence = groupEvent(
      store,
      group.id,
      'document_edit',
      { memory, baseRevision: group.rendered_revision },
      signature,
    );
    const revision = Number(/<!-- clawstrum:group-board:(\d+) -->/.exec(memory)?.[1]);
    const blocks = [
      ...memory.matchAll(
        /<!-- clawstrum:entry:([a-f0-9-]+):(\d+):start -->\n[\s\S]*?```json\n([\s\S]*?)\n```[\s\S]*?<!-- clawstrum:entry:\1:end -->/g,
      ),
    ];
    let applied = 0;
    if (revision === group.revision && (blocks.length || !memory.includes('clawstrum:entry:'))) {
      const changes = blocks.map((b) => ({
        id: b[1]!,
        revision: Number(b[2]),
        spec: entrySpec.parse(JSON.parse(b[3]!)),
      }));
      for (const change of changes) {
        const current = groupEntries(store, group.id).find((e) => e.id === change.id);
        if (!current || current.revision !== change.revision)
          throw new Error('External board entry revision mismatch');
        if (hash(JSON.parse(current.spec_json)) !== hash(change.spec)) {
          const audience = store
            .all<{
              group_id: string;
            }>('SELECT group_id FROM group_audiences WHERE entry_id=?', change.id)
            .map((r) => r.group_id);
          validateReferences(store, audience, [
            ...change.spec.dependsOn,
            ...change.spec.supersedes,
          ]);
          store.exec(
            'UPDATE group_entries SET spec_json=?,revision=revision+1,updated_at=? WHERE id=?',
            JSON.stringify(change.spec),
            Date.now(),
            change.id,
          );
          for (const target of audience) {
            groupEvent(store, target, 'external_revision', {
              id: change.id,
              entry: change.spec,
              evidence,
            });
            touchGroup(store, target);
            notifyDependents(
              store,
              target,
              change.id,
              change.revision + 1,
              'Direct group document revision',
              [evidence],
            );
          }
          applied++;
        }
      }
      const priorIds = [
        ...(group.rendered_memory ?? '').matchAll(
          /<!-- clawstrum:entry:([a-f0-9-]+):\d+:start -->/g,
        ),
      ].map((m) => m[1]!);
      for (const id of priorIds.filter((id) => !changes.some((c) => c.id === id))) {
        retireEntry(store, group.id, id, 'retracted', 'Direct group document edit', [evidence]);
        applied++;
      }
    }
    const withoutCards = (text: string) =>
      text
        .replace(
          /<!-- clawstrum:entry:[a-f0-9-]+:\d+:start -->[\s\S]*?<!-- clawstrum:entry:[a-f0-9-]+:end -->/g,
          '',
        )
        .replace(/\s+/g, ' ')
        .trim();
    if (!applied || withoutCards(memory) !== withoutCards(group.rendered_memory ?? '')) {
      const members = store
        .all<{
          session_id: string;
        }>(
          'SELECT c.session_id FROM group_channels c JOIN group_memberships m ON m.channel_id=c.channel_id WHERE m.group_id=? AND m.enabled=1',
          group.id,
        )
        .map((r) => r.session_id);
      openGroupIssue(
        store,
        group.id,
        `external:${signature}`,
        'A direct group board edit needs reconciliation. The complete edited text is archived; compare it with current entries before applying it.',
        [],
        [evidence],
        members.slice(0, 1),
      );
    }
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?)',
      key,
      JSON.stringify({ applied, evidence }),
    );
  });
}
/** Call only under the shared document mutex. SQLite is authority; these files are repairable. */
export function renderGroupsUnlocked(store: Store, enabled = true): void {
  const registry: {
    version: 1;
    enabled: boolean;
    groups: Record<string, { file: string; revision: number; snapshot: string }>;
    channels: Record<string, string[]>;
  } = { version: 1, enabled, groups: {}, channels: {} };
  for (let group of groups(store)) {
    const file = path.join(groupDirectory(store.home, group.id), 'AGENTS.md');
    let instructions: string;
    let old: string | undefined;
    try {
      old = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let memory = renderedMemory(store, group);
    if (old !== undefined) {
      const parsed = parseMemory(old);
      instructions = parsed.instructions;
      if (
        group.rendered_memory !== null &&
        parsed.memory.trim() !== group.rendered_memory.trim() &&
        parsed.memory.trim() !== memory.trim()
      ) {
        try {
          externalBoardEdit(store, group, parsed.memory);
        } catch (error) {
          const key = hash(parsed.memory);
          store.transaction(() => {
            const evidence = groupEvent(
              store,
              group.id,
              'invalid_document_edit',
              { text: old, error: String(error) },
              key,
            );
            openGroupIssue(
              store,
              group.id,
              `invalid-document:${key}`,
              'A group board edit could not be parsed. Its complete text is archived for repair.',
              [],
              [evidence],
              store
                .all<{
                  session_id: string;
                }>(
                  'SELECT c.session_id FROM group_channels c JOIN group_memberships m ON m.channel_id=c.channel_id WHERE m.group_id=? AND m.enabled=1 LIMIT 1',
                  group.id,
                )
                .map((r) => r.session_id),
            );
            store.exec(
              'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
              `group-external:${group.id}:${key}`,
              '{}',
            );
          });
        }
        group = getGroup(store, group.id);
        memory = renderedMemory(store, group);
      }
    } else
      instructions = fs
        .readFileSync(new URL('../../templates/group-AGENTS.md', import.meta.url), 'utf8')
        .replaceAll('<GROUP_NAME>', group.name)
        .replaceAll('<GROUP_PURPOSE>', group.purpose);
    const policyKey = `group-policy:${group.id}`,
      policyHash = hash(instructions);
    const priorPolicy = store.get<{ value: string }>(
      'SELECT value FROM metadata WHERE key=?',
      policyKey,
    )?.value;
    if (priorPolicy !== policyHash) {
      store.transaction(() => {
        store.exec(
          'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          policyKey,
          policyHash,
        );
        if (priorPolicy) {
          groupEvent(store, group.id, 'policy', { instructions });
          touchGroup(store, group.id);
        }
      });
      group = getGroup(store, group.id);
      memory = renderedMemory(store, group);
    }
    const rendered = instructions.trimEnd() + '\n\n## MEMORY\n\n' + memory;
    if (old !== rendered) {
      if (old) groupEvent(store, group.id, 'document_observed', { text: old }, hash(old));
      writePrivate(file, rendered);
      groupEvent(store, group.id, 'document_rendered', { text: rendered }, hash(rendered));
    }
    if (group.rendered_memory !== memory || group.rendered_revision !== group.revision)
      store.exec(
        'UPDATE groups SET rendered_memory=?,rendered_revision=? WHERE id=?',
        memory,
        group.revision,
        group.id,
      );
    const snapshot = path.join(
      groupDirectory(store.home, group.id),
      'snapshots',
      hash(memory) + '.json',
    );
    if (!fs.existsSync(snapshot))
      writePrivate(snapshot, JSON.stringify({ id: group.id, revision: group.revision, memory }));
    registry.groups[group.id] = { file, revision: group.revision, snapshot };
  }
  for (const session of store.all<Session>('SELECT * FROM sessions'))
    registry.channels[session.workspace] = memberGroups(store, session.channel_id);
  const file = path.join(store.home, 'groups', 'index.json'),
    text = JSON.stringify(registry);
  let old = '';
  try {
    old = fs.readFileSync(file, 'utf8');
  } catch {}
  if (old !== text) writePrivate(file, text);
}
export function syncGroups(store: Store, enabled = true): void {
  if (!groups(store).length && !fs.existsSync(path.join(store.home, 'groups', 'index.json')))
    return;
  withMemoryLock(store, () => renderGroupsUnlocked(store, enabled));
}
export function expireGroupEntries(store: Store, now = Date.now()): void {
  if (!groups(store).length) return;
  withMemoryLock(store, () => {
    store.transaction(() => {
      for (const group of groups(store))
        for (const row of groupEntries(store, group.id)) {
          const spec = JSON.parse(row.spec_json) as EntrySpec;
          if (spec.expiresAt != null && spec.expiresAt <= now)
            retireEntry(
              store,
              group.id,
              row.id,
              'expired',
              'Explicit publication expiration',
              spec.evidence,
            );
          else if (spec.reviewAfter != null && spec.reviewAfter <= now)
            openGroupIssue(
              store,
              group.id,
              `review-due:${row.id}:${row.revision}`,
              'A shared update reached its review deadline. Verify its current status; age alone is not proof of completion.',
              [row.id],
              spec.evidence,
            );
        }
    });
    renderGroupsUnlocked(store);
  });
}
export function exportGroups(store: Store, sessionId: string) {
  return memberGroups(store, store.session(sessionId).channel_id).map((id) => ({
    group: getGroup(store, id),
    document: fs.readFileSync(path.join(groupDirectory(store.home, id), 'AGENTS.md'), 'utf8'),
    memberships: store.all('SELECT * FROM group_memberships WHERE group_id=?', id),
    entries: groupEntries(store, id, false).map(entryView),
    issues: store.all('SELECT * FROM group_issues WHERE group_id=?', id),
    history: store.all('SELECT * FROM history_records WHERE group_id=? ORDER BY seq', id),
    review: store.get('SELECT * FROM group_review_jobs WHERE group_id=?', id),
  }));
}
export function groupHistory(
  store: Store,
  sessionId: string,
  id: string,
  input: Parameters<typeof historyPage>[2],
) {
  assertGroupMember(store, sessionId, id);
  return historyPage(store, { groupId: id }, input);
}
