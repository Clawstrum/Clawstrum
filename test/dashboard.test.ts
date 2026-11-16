import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import {
  collectDashboardData,
  renderDashboardPosts,
  redactSecret,
  ensureDashboardChannel,
  syncDashboardPosts,
  resolveChannelDisplayNames,
  dashboardWatchedFiles,
  statDashboardFiles,
  dashboardStampsChanged,
  writeDashboardSyncRequest,
  readDashboardSyncRequest,
  readDashboardSyncResult,
  fulfillDashboardSyncRequest,
  type DashboardPost,
  type DashboardData,
} from '../src/dashboard.js';
import { accepts } from '../src/discord.js';
import { saveConfig } from '../src/config.js';
import { fixture } from './helpers.js';

test('schema walk renders current value, default and type for a config section', (t) => {
  const f = fixture(t);
  const data = collectDashboardData(f.home, f.config);
  const posts = renderDashboardPosts(data);
  const discordPost = posts.find((p) => p.key === 'config:discord')!;
  assert.match(discordPost.body, /discord\.ownerIds: current=\["123456"\], type=list of string/);
  assert.match(discordPost.body, /discord\.allowDMs: current=false, default=true, type=boolean/);
  assert.match(
    discordPost.body,
    /discord\.dashboard\.syncIntervalMs: current=600000, default=600000, type=integer \(min 60000, max 86400000\)/,
  );
  const runtimePost = posts.find((p) => p.key === 'config:runtime')!;
  assert.match(
    runtimePost.body,
    /runtime\.maintenance\.maxCallsPerDay: current=24, default=24, type=integer/,
  );
  // Overview, every config section, two tool posts, skills, roles, channels and the built-in
  // system prompt post are always present, even with nothing synced yet.
  for (const key of [
    'overview',
    'config:discord',
    'config:runtime',
    'config:accounts',
    'config:research',
    'config:groups',
    'config:decisions',
    'config:review',
    'tools:lead',
    'tools:subagent',
    'skills',
    'subagent-roles',
    'channels',
    'agents-shared',
    'system-prompt',
  ])
    assert.ok(
      posts.some((p) => p.key === key),
      `missing post ${key}`,
    );
  for (const post of posts) {
    assert.ok(post.title.length <= 100, `title too long: ${post.title}`);
    assert.ok(post.summary.length <= 1800, `summary too long for ${post.key}`);
  }
});

test('secret-named keys are redacted unless they just name an environment variable', () => {
  assert.equal(redactSecret('tokenEnv', 'DISCORD_BOT_TOKEN'), 'DISCORD_BOT_TOKEN');
  assert.equal(redactSecret('apiKeyEnv', 'JEV_API_KEY'), 'JEV_API_KEY');
  assert.equal(redactSecret('apiKey', 'sk-real-secret-value'), '[redacted]');
  assert.equal(redactSecret('password', 'hunter2'), '[redacted]');
  assert.equal(redactSecret('credential', 'abc'), '[redacted]');
  assert.deepEqual(redactSecret('ownerIds', ['123456']), ['123456']);
});

function fakeForum() {
  const threads = new Map<string, any>();
  const messages = new Map<string, any>();
  const calls = { create: 0, fetch: 0, edit: 0, rename: 0 };
  const forum: any = {
    threads: {
      async create({ name, message }: any) {
        calls.create++;
        const id = `thread-${calls.create}`;
        const msg = {
          id,
          content: message.content,
          files: message.files,
          async edit(opts: any) {
            calls.edit++;
            this.content = opts.content;
            this.files = opts.files;
          },
        };
        messages.set(id, msg);
        const thread = {
          id,
          name,
          archived: false,
          async setArchived(value: boolean) {
            this.archived = value;
          },
          async setName(newName: string) {
            calls.rename++;
            this.name = newName;
          },
          messages: {
            async fetch(mid: string) {
              return messages.get(mid);
            },
          },
        };
        threads.set(id, thread);
        return thread;
      },
      async fetch(id: string) {
        calls.fetch++;
        return threads.get(id) ?? null;
      },
    },
  };
  return { forum, calls, threads, messages };
}

test('an unchanged post makes zero Discord API calls on the next sync', async (t) => {
  const f = fixture(t);
  const { forum, calls } = fakeForum();
  const posts: DashboardPost[] = [{ key: 'p1', title: 'Post 1', summary: 'Summary', body: 'Body' }];
  await syncDashboardPosts(forum, f.store, posts);
  assert.equal(calls.create, 1);
  assert.equal(calls.edit, 0);
  // Second sync with byte-identical content: no create, no fetch, no edit.
  await syncDashboardPosts(forum, f.store, posts);
  assert.equal(calls.create, 1);
  assert.equal(calls.fetch, 0);
  assert.equal(calls.edit, 0);
  // Changed content edits the existing thread's starter message instead of creating another one.
  await syncDashboardPosts(forum, f.store, [{ ...posts[0]!, body: 'Body v2' }]);
  assert.equal(calls.create, 1);
  assert.equal(calls.edit, 1);
});

test('a title change renames the existing thread instead of creating a new one', async (t) => {
  const f = fixture(t);
  const { forum, calls, threads } = fakeForum();
  const posts: DashboardPost[] = [
    { key: 'agents-channel:111', title: 'AGENTS.md: 111', summary: 'Summary', body: 'Body' },
  ];
  await syncDashboardPosts(forum, f.store, posts);
  assert.equal(calls.create, 1);
  assert.equal(calls.rename, 0);
  // Discord now reports a real channel name for 111; content is unchanged.
  const renamed: DashboardPost[] = [{ ...posts[0]!, title: 'AGENTS.md: mega (111)' }];
  await syncDashboardPosts(forum, f.store, renamed);
  assert.equal(calls.create, 1, 'no second thread created for a title-only change');
  assert.equal(calls.rename, 1);
  assert.equal(calls.edit, 0, 'content unchanged, so the starter message is not re-sent');
  const thread = [...threads.values()][0];
  assert.equal(thread.name, 'AGENTS.md: mega (111)');
  // Doing it again with the same title is a no-op (zero API calls), same as unchanged content.
  await syncDashboardPosts(forum, f.store, renamed);
  assert.equal(calls.fetch, 1);
  assert.equal(calls.rename, 1);
});

test('a channel name shared by more than one channel, or unresolvable, is disambiguated with its id', async () => {
  const data = {
    channels: [
      {
        channelId: '111',
        name: '111',
        workspace: null,
        preferredAccount: null,
        activeAccount: null,
        activeModel: null,
      },
      {
        channelId: '222',
        name: '222',
        workspace: null,
        preferredAccount: null,
        activeAccount: null,
        activeModel: null,
      },
      {
        channelId: '333',
        name: '333',
        workspace: null,
        preferredAccount: null,
        activeAccount: null,
        activeModel: null,
      },
      {
        channelId: '444',
        name: '444',
        workspace: null,
        preferredAccount: null,
        activeAccount: null,
        activeModel: null,
      },
    ],
    channelAgentsMd: [
      { channelId: '111', title: 'AGENTS.md: 111', content: 'a' },
      { channelId: '222', title: 'AGENTS.md: 222', content: 'b' },
    ],
  } as unknown as DashboardData;
  const liveNames: Record<string, string> = { '111': 'mega', '222': 'mega', '333': 'solo' };
  const client: any = {
    channels: {
      fetch: async (id: string) =>
        liveNames[id] ? { name: liveNames[id] } : Promise.reject(new Error('unknown channel')),
    },
  };
  await resolveChannelDisplayNames(client, data);
  // Two different channels share the live Discord name "mega": both get the id appended.
  assert.equal(data.channels.find((c) => c.channelId === '111')!.name, 'mega (111)');
  assert.equal(data.channels.find((c) => c.channelId === '222')!.name, 'mega (222)');
  assert.equal(data.channels.find((c) => c.channelId === '333')!.name, 'solo');
  // 444 cannot be resolved at all: falls back to the stored name, still disambiguated with the id.
  assert.equal(data.channels.find((c) => c.channelId === '444')!.name, '444 (444)');
  assert.equal(
    data.channelAgentsMd.find((a) => a.channelId === '111')!.title,
    'AGENTS.md: mega (111)',
  );
  assert.equal(
    data.channelAgentsMd.find((a) => a.channelId === '222')!.title,
    'AGENTS.md: mega (222)',
  );
});

test('an explicit dashboard channelId is used as-is and never has permissions or category changed', async (t) => {
  const f = fixture(t);
  let fetchedId: string | undefined;
  const client: any = {
    channels: {
      fetch: async (id: string) => {
        fetchedId = id;
        // A minimal fake channel: if the implementation tried to edit permissions or move it
        // between categories, calling an undefined method here would throw and fail the test.
        return { type: ChannelType.GuildForum, id, name: 'dashboard' };
      },
    },
  };
  const config = {
    ...f.config,
    discord: {
      ...f.config.discord,
      dashboard: { ...f.config.discord.dashboard, channelId: '1234567890123456789' },
    },
  };
  const channel = await ensureDashboardChannel(client, f.store, config);
  assert.equal(fetchedId, '1234567890123456789');
  assert.equal(channel?.id, '1234567890123456789');
});

test('a missing Manage Channels permission logs once and never throws', async (t) => {
  const f = fixture(t);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    const guild = {
      id: 'guild1',
      channels: { cache: { find: () => undefined } },
      members: { me: { permissions: { has: () => false } } },
    };
    const client = {
      channels: { fetch: async () => ({ guild }) },
    } as any;
    const config = {
      ...f.config,
      discord: { ...f.config.discord, guildId: undefined, noticeChannelId: '555555' },
    };
    const first = await ensureDashboardChannel(client, f.store, config);
    assert.equal(first, undefined);
    const second = await ensureDashboardChannel(client, f.store, config);
    assert.equal(second, undefined);
  } finally {
    console.error = originalError;
  }
  const missing = errors.filter((line) => line.includes('dashboard_missing_permission'));
  assert.equal(missing.length, 1, 'logged exactly once despite two resolution attempts');
});

test('accepts() ignores the dashboard forum and its threads even when the bot has posted there', () => {
  const config = {
    discord: {
      ownerIds: ['123456'],
      allowAllSenders: false,
      allowDMs: false,
      guildId: '555555',
      channelIds: ['987654'],
      dashboard: { channelId: '111222333444555666' },
    },
  } as any;
  // The forum channel itself.
  assert.equal(accepts(config, '123456', '555555', '111222333444555666'), false);
  // A thread inside the forum.
  assert.equal(
    accepts(config, '123456', '555555', '999888777666555444', '111222333444555666'),
    false,
  );
  // An ordinary configured conversation still works.
  assert.equal(accepts(config, '123456', '555555', '987654'), true);
});

test('dashboardWatchedFiles lists config.json, the shared AGENTS.md, a registered channel workspace AGENTS.md, and every skill file', (t) => {
  const f = fixture(t);
  const skillDir = path.join(f.home, 'skills', 'demo-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\ndescription: demo\n---\nBody');
  const session = f.store.ensureSession('987654');
  fs.writeFileSync(path.join(session.workspace, 'AGENTS.md'), '# channel notes');
  const files = dashboardWatchedFiles(f.home, f.config, f.store);
  assert.ok(files.includes(path.join(f.home, 'config.json')));
  assert.ok(files.includes(path.join(f.home, 'AGENTS.md')));
  assert.ok(files.includes(path.join(session.workspace, 'AGENTS.md')));
  assert.ok(files.includes(path.join(skillDir, 'SKILL.md')));
});

test('a stat change triggers exactly one sync; no change triggers none', (t) => {
  const f = fixture(t);
  const agentsFile = path.join(f.home, 'AGENTS.md');
  fs.writeFileSync(agentsFile, 'first version');
  let syncs = 0;
  let stamps = statDashboardFiles(dashboardWatchedFiles(f.home, f.config, f.store));
  const tick = () => {
    const next = statDashboardFiles(dashboardWatchedFiles(f.home, f.config, f.store));
    if (dashboardStampsChanged(stamps, next)) syncs++;
    stamps = next;
  };
  tick();
  tick();
  assert.equal(syncs, 0, 'no edit yet: no sync');
  fs.writeFileSync(agentsFile, 'second version, a different length');
  tick();
  tick();
  tick();
  assert.equal(syncs, 1, 'one edit: exactly one sync, not one per tick');
});

test('dashboard_sync returns counts from a fake client', async (t) => {
  const f = fixture(t);
  const channelId = '1234567890123456789';
  const { forum, calls } = fakeForum();
  const fakeChannel = { ...forum, type: ChannelType.GuildForum, id: channelId };
  const client: any = {
    channels: {
      fetch: async (id: string) =>
        id === channelId ? fakeChannel : Promise.reject(new Error('unknown channel')),
    },
  };
  const config = {
    ...f.config,
    discord: {
      ...f.config.discord,
      dashboard: { ...f.config.discord.dashboard, enabled: true, channelId },
    },
  };
  writeDashboardSyncRequest(f.store, { id: 'req-1', requestedAt: Date.now() });
  const handled = await fulfillDashboardSyncRequest(client, f.store, config, f.home);
  assert.equal(handled, true);
  assert.equal(readDashboardSyncRequest(f.store), undefined, 'request consumed');
  const outcome = readDashboardSyncResult(f.store, 'req-1') as Record<string, number>;
  assert.ok(outcome, 'result written for the request id');
  assert.ok(outcome.created > 0, 'a fresh dashboard creates posts');
  assert.equal(outcome.unchanged, 0);
  assert.equal(outcome.archived, 0);
  assert.ok(calls.create > 0);
  // The result is read once; a retried poll never replays a stale answer.
  assert.equal(readDashboardSyncResult(f.store, 'req-1'), undefined);
});

test('dashboard_sync says plainly when there is no pending request', async (t) => {
  const f = fixture(t);
  const handled = await fulfillDashboardSyncRequest({} as any, f.store, f.config, f.home);
  assert.equal(handled, false);
});

test('a config.json value that differs from the running config is marked as applying after restart, except discord.channelIds', (t) => {
  const f = fixture(t);
  const fileConfig = JSON.parse(JSON.stringify(f.config));
  fileConfig.runtime.maintenance.maxCallsPerDay = 99;
  fileConfig.discord.channelIds = [...f.config.discord.channelIds, '555555'];
  saveConfig(f.home, fileConfig);
  const data = collectDashboardData(f.home, f.config);
  const posts = renderDashboardPosts(data);
  const runtimePost = posts.find((p) => p.key === 'config:runtime')!;
  assert.match(
    runtimePost.body,
    /runtime\.maintenance\.maxCallsPerDay: current=24, default=24, type=integer \(min 0, max 10000\), in file=99 \(applies after restart\)/,
  );
  const discordPost = posts.find((p) => p.key === 'config:discord')!;
  assert.doesNotMatch(
    discordPost.body,
    /discord\.channelIds:.*applies after restart/,
    'channelIds take effect without a restart, so they are never flagged as pending',
  );
});

test('no config.json on disk: nothing is marked as applying after restart', (t) => {
  const f = fixture(t);
  const data = collectDashboardData(f.home, f.config);
  const posts = renderDashboardPosts(data);
  for (const post of posts) assert.doesNotMatch(post.body, /applies after restart/);
});

function fakeGroupsReader(): import('../src/dashboard.js').DashboardReader {
  const channelNames: Record<string, string> = {
    '111111': 'chan-one',
    '222222': 'chan-two',
    '333333': 'chan-three',
  };
  return {
    get<T>(sql: string, ...params: unknown[]): T | undefined {
      if (sql.includes('FROM group_channels c JOIN sessions')) {
        const name = channelNames[params[0] as string];
        return name
          ? ({
              name,
              workspace: null,
              preferred_account: null,
              active_account: null,
              active_model: null,
            } as T)
          : undefined;
      }
      return undefined;
    },
    all<T>(sql: string): T[] {
      if (sql.includes('FROM groups ORDER BY id'))
        return [
          {
            id: 'alpha',
            name: 'Alpha Team',
            purpose: 'test purpose A',
            revision: 3,
            rendered_memory: 'Alpha board text',
          },
          {
            id: 'beta',
            name: 'Beta Team',
            purpose: 'test purpose B',
            revision: 1,
            rendered_memory: null,
          },
        ] as T[];
      if (sql.includes('FROM group_memberships ORDER BY group_id,channel_id'))
        return [
          { group_id: 'alpha', channel_id: '111111', role: 'lead', enabled: 1 },
          { group_id: 'alpha', channel_id: '222222', role: 'disabled member', enabled: 0 },
          { group_id: 'beta', channel_id: '333333', role: '', enabled: 1 },
        ] as T[];
      return [];
    },
  };
}

test('the Groups post lists each group, its members (enabled/disabled, role) and channels in no group', (t) => {
  const f = fixture(t);
  const data = collectDashboardData(f.home, f.config, fakeGroupsReader());
  const posts = renderDashboardPosts(data);
  const configGroupsIndex = posts.findIndex((p) => p.key === 'config:groups');
  const groupsIndex = posts.findIndex((p) => p.key === 'groups');
  assert.equal(groupsIndex, configGroupsIndex + 1, 'Groups post sits right after Config: groups');
  const groupsPost = posts[groupsIndex]!;
  assert.match(groupsPost.body, /Alpha Team \(id=alpha, revision=3\): test purpose A/);
  assert.match(groupsPost.body, /chan-one \(111111\): enabled=yes, role=lead/);
  assert.match(groupsPost.body, /chan-two \(222222\): enabled=no, role=disabled member/);
  assert.match(groupsPost.body, /Beta Team \(id=beta, revision=1\): test purpose B/);
  assert.match(groupsPost.body, /chan-three \(333333\): enabled=yes, role=none/);
  // The fixture's own registered channel (987654) is a member of nothing.
  assert.match(groupsPost.body, /Channels in no group:\n {2}987654 \(987654\)/);
  const alphaBoard = posts.find((p) => p.key === 'group-board:alpha')!;
  assert.equal(alphaBoard.title, 'Group board: Alpha Team');
  assert.equal(alphaBoard.body, 'Alpha board text');
  const betaBoard = posts.find((p) => p.key === 'group-board:beta')!;
  assert.equal(betaBoard.body, 'Not yet rendered.');
  const channelsPost = posts.find((p) => p.key === 'channels')!;
  assert.match(channelsPost.body, /111111 \(chan-one\):.*groups=alpha/);
  // A disabled membership never shows up in the channel's own "groups" field.
  assert.match(channelsPost.body, /222222 \(chan-two\):.*groups=none/);
  assert.match(channelsPost.body, /333333 \(chan-three\):.*groups=beta/);
  assert.match(channelsPost.body, /987654 \(987654\):.*groups=none/);
});
