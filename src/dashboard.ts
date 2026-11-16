import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type ForumChannel,
} from 'discord.js';
import { configSchema, dashboardViewerIds, readConfig, type Config } from './config.js';
import {
  credentialSource,
  redactAccountSecrets,
  registryPath,
  rulesPath,
} from './account-registry.js';
import type { Store } from './store.js';
import { readSkills, skillFiles, type SkillEntry } from './context.js';
import { DEFAULT_AGENTS } from './default-instructions.js';
import { BASE_PROMPT } from './base-prompt.js';
import { REFRESH_PROTOCOL, DELIVERY_PROTOCOL } from './instructions.js';
import { registerCoreTools, type RegisterFn } from './mcp.js';
import { registerResearchTools } from './research/tools.js';

/** Reads the same tables a real Store exposes; satisfied by a Store or a read-only raw reader
 * (see workflow-cli.ts), so --print never needs a writable database connection. */
export interface DashboardReader {
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined;
  all<T>(sql: string, ...params: SQLInputValue[]): T[];
}
export interface ToolDescriptor {
  name: string;
  description: string;
  params: string[];
}
/** Every tool name+description+parameter name a lead or a subagent is given, read from the same
 * registration code the real MCP server uses. Registration only evaluates static definitions;
 * no store, session or run is touched, so this never starts a server or opens a database.
 */
export function listToolDescriptors(config: Config, worker: boolean): ToolDescriptor[] {
  const items: ToolDescriptor[] = [];
  const collect: RegisterFn = (name, definition) =>
    items.push({
      name,
      description: definition.description,
      params: definition.inputSchema ? Object.keys(definition.inputSchema) : [],
    });
  registerCoreTools(collect, {
    store: undefined as unknown as Store,
    config,
    sessionId: 'dashboard',
    session: { workspace: '' },
    owner: { id: 'dashboard' },
    worker: worker ? ({ id: 'dashboard' } as any) : undefined,
    deliveryScope: () => 'dashboard',
  });
  registerResearchTools(collect, {
    store: undefined as unknown as Store,
    config,
    sessionId: 'dashboard',
    scope: 'dashboard',
    worker,
  });
  return items.sort((a, b) => a.name.localeCompare(b.name));
}
export interface ChannelRow {
  channelId: string;
  name: string;
  workspace: string | null;
  preferredAccount: string | null;
  activeAccount: string | null;
  activeModel: string | null;
  /** Per-conversation model request set by `clawstrum switch ... --model`, e.g. "claude-fable-5-2 on HOME". */
  modelOverride: string | null;
  /** Ids of groups this channel is an enabled member of, direct membership only (no parent
   * inheritance; see memberGroups in groups/store.ts for the full recursive rule). */
  groups: string[];
}
export interface GroupRow {
  id: string;
  name: string;
  purpose: string;
  revision: number;
  /** Same text rendered into the group's AGENTS.md MEMORY section and given to its member
   * channels' agents; null only if a group has never gone through a render pass yet. */
  renderedMemory: string | null;
}
export interface GroupMembershipRow {
  groupId: string;
  channelId: string;
  role: string;
  enabled: boolean;
}
export interface DashboardData {
  name: string;
  version: string;
  buildCommit?: string;
  serviceStartedAt?: number;
  config: Config;
  /** config.json re-read fresh at collection time, for flagging values the daemon has not picked
   * up yet; undefined if the file is missing or fails to parse right now. */
  configFile?: Config;
  /** Where the account list comes from, and the owner's rules text (ACCOUNTS.md). No secrets. */
  accountSource: 'accounts.json' | 'config.json';
  accountRules: string;
  accountCredentials: Record<string, string>;
  skills: SkillEntry[];
  channels: ChannelRow[];
  groups: GroupRow[];
  groupMemberships: GroupMembershipRow[];
  sharedAgentsMd: string;
  channelAgentsMd: Array<{ channelId: string; title: string; content: string }>;
  builtinSystemPrompt: string;
}
function packageVersion(): string {
  try {
    const file = fileURLToPath(new URL('../package.json', import.meta.url));
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
/** Present once a build has run scripts/write-build-info.mjs (the normal `npm run build` path); a
 * dev/test run under tsx has no dist/BUILD.json at this path. */
function buildInfoFile(): string {
  return fileURLToPath(new URL('./BUILD.json', import.meta.url));
}
function buildCommit(): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(buildInfoFile(), 'utf8')) as { commit: string }).commit;
  } catch {
    return undefined;
  }
}
function readOptional(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
/** Union of every channel id the configuration names, in the order a reader would expect to see
 * them: the conversations the bot answers in, then the notice/review channels it also writes to.
 */
export function registeredChannelIds(config: Config): string[] {
  return [
    ...new Set(
      [
        ...config.discord.channelIds,
        config.discord.noticeChannelId,
        config.review.channelId,
      ].filter((id): id is string => !!id),
    ),
  ];
}
function channelRow(
  reader: DashboardReader | undefined,
  channelId: string,
  groups: string[],
): ChannelRow {
  const row = reader?.get<{
    session_id: string;
    name: string | null;
    workspace: string | null;
    preferred_account: string | null;
    active_account: string | null;
    active_model: string | null;
  }>(
    `SELECT s.id AS session_id,c.name,s.workspace,s.preferred_account,s.active_account,s.active_model
     FROM group_channels c JOIN sessions s ON s.id=c.session_id WHERE c.channel_id=?
     UNION ALL
     SELECT s.id AS session_id,NULL,s.workspace,s.preferred_account,s.active_account,s.active_model
     FROM sessions s WHERE s.channel_id=? AND NOT EXISTS(SELECT 1 FROM group_channels WHERE channel_id=?)
     LIMIT 1`,
    channelId,
    channelId,
    channelId,
  );
  let modelOverride: string | null = null;
  try {
    const stored = row
      ? reader?.get<{ value: string }>(
          'SELECT value FROM metadata WHERE key=?',
          `model-override:${row.session_id}`,
        )
      : undefined;
    if (stored) {
      const value = JSON.parse(stored.value) as { account?: string; model?: string };
      modelOverride = value.model ? `${value.model} on ${value.account ?? 'unknown'}` : null;
    }
  } catch {
    modelOverride = null;
  }
  return {
    channelId,
    name: row?.name ?? channelId,
    workspace: row?.workspace ?? null,
    preferredAccount: row?.preferred_account ?? null,
    activeAccount: row?.active_account ?? null,
    activeModel: row?.active_model ?? null,
    modelOverride,
    groups,
  };
}
/** Reads the same two tables renderedMemory (groups/store.ts) reads for its member list, plus
 * every membership row including disabled ones, so the Groups post can show enabled=no instead
 * of omitting a disabled member. groups/store.ts's own helpers take a full Store (session(),
 * transaction(), ...), which a read-only DashboardReader does not implement, so this stays raw
 * SQL rather than reusing them; the SELECT shapes mirror renderGroupsUnlocked's own queries.
 */
function collectGroups(reader: DashboardReader | undefined): {
  groups: GroupRow[];
  memberships: GroupMembershipRow[];
} {
  try {
    const groups = (
      reader?.all<{
        id: string;
        name: string;
        purpose: string;
        revision: number;
        rendered_memory: string | null;
      }>('SELECT id,name,purpose,revision,rendered_memory FROM groups ORDER BY id') ?? []
    ).map((g) => ({
      id: g.id,
      name: g.name,
      purpose: g.purpose,
      revision: g.revision,
      renderedMemory: g.rendered_memory,
    }));
    const memberships = (
      reader?.all<{ group_id: string; channel_id: string; role: string; enabled: number }>(
        'SELECT group_id,channel_id,role,enabled FROM group_memberships ORDER BY group_id,channel_id',
      ) ?? []
    ).map((m) => ({
      groupId: m.group_id,
      channelId: m.channel_id,
      role: m.role,
      enabled: !!m.enabled,
    }));
    return { groups, memberships };
  } catch {
    // No groups tables yet (schema_version<5, dev/test db); same as no groups configured.
    return { groups: [], memberships: [] };
  }
}
export function collectDashboardData(
  home: string,
  config: Config,
  reader?: DashboardReader,
): DashboardData {
  const { groups, memberships } = collectGroups(reader);
  const channelIds = [
    ...new Set([...registeredChannelIds(config), ...memberships.map((m) => m.channelId)]),
  ];
  const channels: ChannelRow[] = channelIds.map((channelId) =>
    channelRow(
      reader,
      channelId,
      memberships
        .filter((m) => m.channelId === channelId && m.enabled)
        .map((m) => m.groupId)
        .sort(),
    ),
  );
  const serviceStartedAt = reader?.get<{ value: string }>(
    "SELECT value FROM metadata WHERE key='operations:daemon'",
  );
  let configFile: Config | undefined;
  try {
    configFile = readConfig(home, { applyTokens: false });
  } catch {
    configFile = undefined;
  }
  return {
    name: config.name,
    version: packageVersion(),
    buildCommit: buildCommit(),
    serviceStartedAt: serviceStartedAt
      ? (JSON.parse(serviceStartedAt.value).startedAt as number)
      : undefined,
    config,
    configFile,
    accountSource: fs.existsSync(registryPath(home)) ? 'accounts.json' : 'config.json',
    accountRules: redactAccountSecrets(readOptional(rulesPath(home))),
    accountCredentials: Object.fromEntries(config.accounts.map((a) => [a.id, credentialSource(a)])),
    skills: readSkills([path.join(home, 'skills')]),
    channels,
    groups,
    groupMemberships: memberships,
    sharedAgentsMd: readOptional(path.join(home, 'AGENTS.md')),
    channelAgentsMd: channels
      .filter((c) => c.workspace)
      .map((c) => ({
        channelId: c.channelId,
        title: `AGENTS.md: ${c.name}`,
        content: readOptional(path.join(c.workspace!, 'AGENTS.md')),
      })),
    builtinSystemPrompt: [BASE_PROMPT, DEFAULT_AGENTS, REFRESH_PROTOCOL, DELIVERY_PROTOCOL].join(
      '\n\n---\n\n',
    ),
  };
}

// --- Change-triggered sync (stat only, never reads file content) ---------------------------

/** Every file a sync reads to build DashboardData: the runtime config, the shared AGENTS.md, each
 * registered channel's workspace AGENTS.md, every skill's SKILL.md, and the build info a dev/test
 * run never has. Channel workspaces come from channelRow and skill paths from skillFiles, the same
 * lookups collectDashboardData itself uses, so this list can never list a different file than a
 * sync actually opens. A brand-new channel or skill is first picked up by the periodic full sync
 * (it also catches other DB-derived content, like a channel's active account); once picked up, it
 * is watched here too.
 */
export function dashboardWatchedFiles(
  home: string,
  config: Config,
  reader?: DashboardReader,
): string[] {
  const files = new Set<string>([
    path.join(home, 'config.json'),
    path.join(home, 'AGENTS.md'),
    registryPath(home),
    rulesPath(home),
  ]);
  files.add(buildInfoFile());
  for (const channelId of registeredChannelIds(config)) {
    const workspace = channelRow(reader, channelId, []).workspace;
    if (workspace) files.add(path.join(workspace, 'AGENTS.md'));
  }
  for (const file of skillFiles([path.join(home, 'skills')])) files.add(file);
  return [...files];
}
interface FileStamp {
  mtimeMs: number;
  size: number;
}
/** undefined means the file does not exist right now; that is itself a stamp worth comparing
 * (a file being created or deleted is a change), so callers never treat it as an error. */
function statStamp(file: string): FileStamp | undefined {
  try {
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}
export type DashboardStamps = Record<string, FileStamp | undefined>;
/** Not a real path; a group board edit touches no file on disk, so its only cheap signal is this
 * single `SELECT max(revision)` folded into the same stamp record the file paths use. */
const GROUPS_REVISION_STAMP_KEY = '\0groups-revision';
export function statDashboardFiles(files: string[], reader?: DashboardReader): DashboardStamps {
  const stamps: DashboardStamps = {};
  for (const file of files) stamps[file] = statStamp(file);
  try {
    const row = reader?.get<{ r: number | null }>('SELECT max(revision) AS r FROM groups');
    if (row) stamps[GROUPS_REVISION_STAMP_KEY] = { mtimeMs: 0, size: row.r ?? 0 };
  } catch {
    // No groups table yet (schema_version<5, dev/test db); nothing to watch.
  }
  return stamps;
}
/** True if any watched file was added, removed, or had its size or modified time change since the
 * previous stat round. Comparing mtime+size, never content, is what keeps a watch tick cheap. */
export function dashboardStampsChanged(previous: DashboardStamps, next: DashboardStamps): boolean {
  for (const file of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const before = previous[file];
    const after = next[file];
    if (!before !== !after) return true;
    if (before && after && (before.mtimeMs !== after.mtimeMs || before.size !== after.size))
      return true;
  }
  return false;
}

export interface DashboardPost {
  /** Stable identity across renames, independent of `title`; used for the Discord thread/metadata
   * key so a renamed channel or a resection does not create a duplicate thread. */
  key: string;
  title: string;
  /** <=1800 chars; goes in the starter message body. */
  summary: string;
  /** Full text, always sent as an attached .md file. */
  body: string;
}
const SECRET_KEY = /token|secret|key|password|credential/i;
/** Never print an actual secret value. A field name ending in "Env" names an environment
 * variable, not a secret itself, so those are left visible (discord.tokenEnv etc).
 */
export function redactSecret(leafKey: string, value: unknown): unknown {
  if (!SECRET_KEY.test(leafKey) || /Env$/.test(leafKey)) return value;
  return typeof value === 'string' || typeof value === 'number' ? '[redacted]' : value;
}
function formatValue(value: unknown): string {
  if (value === undefined) return 'unset';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
interface JsonSchemaNode {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: JsonSchemaNode | boolean;
}
function typeLabel(node: JsonSchemaNode): string {
  if (node.const !== undefined) return `fixed value ${JSON.stringify(node.const)}`;
  if (node.enum) return `one of ${node.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  if (node.type === 'array') {
    const bounds = [
      node.minItems !== undefined ? `min ${node.minItems} item(s)` : '',
      node.maxItems !== undefined ? `max ${node.maxItems} item(s)` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `list of ${node.items ? typeLabel(node.items) : 'any'}${bounds ? ` (${bounds})` : ''}`;
  }
  const bounds: string[] = [];
  if (node.minimum !== undefined) bounds.push(`min ${node.minimum}`);
  if (node.exclusiveMinimum !== undefined) bounds.push(`min >${node.exclusiveMinimum}`);
  if (node.maximum !== undefined) bounds.push(`max ${node.maximum}`);
  if (node.exclusiveMaximum !== undefined) bounds.push(`max <${node.exclusiveMaximum}`);
  if (node.minLength !== undefined) bounds.push(`minLength ${node.minLength}`);
  if (node.maxLength !== undefined) bounds.push(`maxLength ${node.maxLength}`);
  if (node.pattern) bounds.push(`matches ${node.pattern}`);
  if (node.format) bounds.push(`format ${node.format}`);
  const base = Array.isArray(node.type) ? node.type.join(' or ') : (node.type ?? 'any');
  return bounds.length ? `${base} (${bounds.join(', ')})` : base;
}
/** Walk a zod-derived JSON schema node alongside the live config value at the same path,
 * emitting one line per leaf: current value, default and allowed values/type. Records with
 * dynamic keys (z.record, e.g. research.workers.roles) use `additionalProperties` as the
 * per-entry schema; arrays of objects (e.g. accounts) recurse with a `[i]` path segment.
 *
 * `fromFile` is the same path read fresh out of config.json at render time. The daemon only
 * live-reloads discord.channelIds; every other key keeps running on whatever was loaded at
 * startup, so a leaf where `fromFile` differs from the running value gets a note saying the file
 * already has a different value than what is in effect, never a bare value that looks live but
 * is not.
 */
function walkSchema(
  prefix: string[],
  node: JsonSchemaNode | undefined,
  value: unknown,
  fromFile: unknown,
  lines: string[],
): void {
  if (!node) return;
  if (node.properties) {
    const record = (value ?? {}) as Record<string, unknown>;
    const fileRecord = (fromFile ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(node.properties))
      walkSchema([...prefix, key], node.properties[key], record[key], fileRecord[key], lines);
    return;
  }
  if (
    node.additionalProperties &&
    typeof node.additionalProperties === 'object' &&
    value &&
    typeof value === 'object'
  ) {
    const keys = Object.keys(value as Record<string, unknown>);
    if (!keys.length) {
      lines.push(`${prefix.join('.')}: current={} (no entries)`);
      return;
    }
    const fileRecord = (fromFile ?? {}) as Record<string, unknown>;
    for (const key of keys)
      walkSchema(
        [...prefix, key],
        node.additionalProperties,
        (value as Record<string, unknown>)[key],
        fileRecord[key],
        lines,
      );
    return;
  }
  if (node.type === 'array' && node.items?.type === 'object' && Array.isArray(value)) {
    if (!value.length) {
      lines.push(`${prefix.join('.')}: current=[] (no entries)`);
      return;
    }
    const fileArray = Array.isArray(fromFile) ? fromFile : [];
    value.forEach((entry, i) =>
      walkSchema([...prefix, `[${i}]`], node.items, entry, fileArray[i], lines),
    );
    return;
  }
  const leaf = prefix[prefix.length - 1] ?? '';
  const leafPath = prefix.join('.');
  const current = redactSecret(leaf, value);
  const parts = [`${leafPath}: current=${formatValue(current)}`];
  if (node.default !== undefined) parts.push(`default=${formatValue(node.default)}`);
  parts.push(`type=${typeLabel(node)}`);
  // discord.channelIds applies without a restart (channelReloader), so it is never stale.
  if (fromFile !== undefined && leafPath !== 'discord.channelIds') {
    const inFile = redactSecret(leaf, fromFile);
    if (formatValue(inFile) !== formatValue(current))
      parts.push(`in file=${formatValue(inFile)} (applies after restart)`);
  }
  lines.push(parts.join(', '));
}
/** Discord thread titles are capped at 100 characters. */
function title(text: string): string {
  return text.length <= 100 ? text : text.slice(0, 97) + '...';
}
/** Starter messages are capped well under Discord's 2000-character limit; the full text always
 * also goes out as an attached .md file, so trimming the summary never loses content. Discord
 * already shows the post's title as the thread title, so the summary holds only the body lines,
 * never the title repeated as a first line.
 */
function summarize(lines: string[], limit = 1800): string {
  const text = lines.join('\n');
  if (text.length <= limit) return text;
  const marker = '\n[Full text attached as .md file.]';
  return text.slice(0, limit - marker.length) + marker;
}
/** Every group with its member channels (name, id, enabled, role), plus every channel that is a
 * member of no group at all. A channel's name here is the same resolved/disambiguated name shown
 * in the Channels post, since both read it off the same data.channels entry. */
function groupsOverviewPost(data: DashboardData): DashboardPost {
  const channelName = (channelId: string) =>
    data.channels.find((c) => c.channelId === channelId)?.name ?? channelId;
  const lines: string[] = [];
  for (const group of data.groups) {
    lines.push(`${group.name} (id=${group.id}, revision=${group.revision}): ${group.purpose}`);
    const members = data.groupMemberships.filter((m) => m.groupId === group.id);
    if (!members.length) lines.push('  No member channels.');
    for (const m of members)
      lines.push(
        `  ${channelName(m.channelId)} (${m.channelId}): enabled=${m.enabled ? 'yes' : 'no'}, role=${m.role || 'none'}`,
      );
  }
  const memberChannelIds = new Set(data.groupMemberships.map((m) => m.channelId));
  const ungrouped = data.channels.filter((c) => !memberChannelIds.has(c.channelId));
  lines.push('Channels in no group:');
  if (!ungrouped.length) lines.push('  None.');
  for (const c of ungrouped) lines.push(`  ${c.name} (${c.channelId})`);
  return {
    key: 'groups',
    title: title('Groups'),
    summary: summarize(lines),
    body: lines.join('\n'),
  };
}
/** Deterministic: same data produces the same titles, summaries and bodies, so an unchanged
 * config/skill-set/AGENTS.md never has to touch Discord on the next sync.
 */
export function renderDashboardPosts(data: DashboardData): DashboardPost[] {
  const posts: DashboardPost[] = [];
  const schemaJson = z.toJSONSchema(configSchema) as JsonSchemaNode;
  const sections = Object.keys(schemaJson.properties ?? {}).filter(
    (key) => !['name', 'version'].includes(key),
  );
  const accounts = [...data.config.accounts].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const sectionTitle = (key: string) => `Config: ${key}`;
  for (const key of sections) {
    const lines: string[] = [];
    walkSchema(
      [key],
      schemaJson.properties?.[key],
      (data.config as Record<string, unknown>)[key],
      (data.configFile as Record<string, unknown> | undefined)?.[key],
      lines,
    );
    posts.push({
      key: `config:${key}`,
      title: title(sectionTitle(key)),
      summary: summarize(lines),
      body: lines.join('\n'),
    });
    if (key === 'groups') posts.push(groupsOverviewPost(data));
  }
  for (const scope of ['lead', 'subagent'] as const) {
    const tools = listToolDescriptors(data.config, scope === 'subagent');
    const lines = tools.map((t) => `${t.name}(${t.params.join(', ')}): ${t.description}`);
    const heading = `Tools: ${scope === 'lead' ? 'lead' : 'subagent'}`;
    posts.push({
      key: `tools:${scope}`,
      title: title(heading),
      summary: summarize(tools.map((t) => `${t.name}(${t.params.join(', ')})`)),
      body: lines.join('\n\n'),
    });
  }
  const skillLines = data.skills.map((s) => `${s.name}: ${s.description ?? ''}`.trim());
  posts.push({
    key: 'skills',
    title: title('Skills'),
    summary: summarize(skillLines),
    body: skillLines.join('\n'),
  });
  const roleLines = Object.entries(data.config.research.workers.roles).map(
    ([roleName, role]) =>
      `${roleName}: ${role.description}; claude=${role.models.claude ?? 'unset'}, codex=${role.models.codex ?? 'unset'}, gemini=${role.models.gemini ?? 'unset'}; effort=${role.effort}; maxTurns=${role.maxTurns || 'unlimited'}`,
  );
  posts.push({
    key: 'subagent-roles',
    title: title('Subagent roles'),
    summary: summarize(roleLines),
    body: roleLines.join('\n'),
  });
  const accountLines = [
    `Account list source: ${data.accountSource}${data.accountSource === 'accounts.json' ? ' (config.json accounts are ignored while it exists)' : ''}. Credentials are shown by source only, never by value.`,
    ...accounts.map(
      (a) =>
        `${a.id}: owner=${a.owner ?? '-'}; label=${a.label ?? '-'}; ${a.provider}; model=${a.model ?? 'provider default'}${a.modelFallbacks.length ? ` (fallbacks ${a.modelFallbacks.map((m) => m.model).join(', ')})` : ''}; priority=${a.priority ?? 0}; credential=${data.accountCredentials[a.id] ?? 'unknown'}; maxConcurrent=${a.maxConcurrent ?? 'default'}${a.notes ? `; notes=${a.notes}` : ''}`,
    ),
    '',
    `Rules (ACCOUNTS.md):`,
    data.accountRules.trim() || '(none written yet)',
    '',
    'Conversations with an account or model override:',
    ...(data.channels.filter((c) => c.preferredAccount || c.modelOverride).length
      ? data.channels
          .filter((c) => c.preferredAccount || c.modelOverride)
          .map(
            (c) =>
              `${c.channelId} (${c.name}): account=${c.preferredAccount ?? 'automatic'}; model request=${c.modelOverride ?? 'none'}`,
          )
      : ['none']),
  ];
  posts.push({
    key: 'accounts',
    title: title('Accounts'),
    summary: summarize(accountLines),
    body: accountLines.join('\n'),
  });
  const channelLines = data.channels.map(
    (c) =>
      `${c.channelId} (${c.name}): workspace=${c.workspace ?? 'unknown'}; account override=${c.preferredAccount ?? 'automatic'}; model request=${c.modelOverride ?? 'none'}; active account=${c.activeAccount ?? 'none yet'}; active model=${c.activeModel ?? 'unset'}; groups=${c.groups.length ? c.groups.join(', ') : 'none'}`,
  );
  posts.push({
    key: 'channels',
    title: title('Channels'),
    summary: summarize(channelLines),
    body: channelLines.join('\n'),
  });
  posts.push({
    key: 'agents-shared',
    title: title('Global AGENTS.md'),
    summary: summarize([data.sharedAgentsMd]),
    body: data.sharedAgentsMd,
  });
  for (const channel of data.channelAgentsMd)
    posts.push({
      key: `agents-channel:${channel.channelId}`,
      title: title(channel.title),
      summary: summarize([channel.content]),
      body: channel.content,
    });
  for (const group of data.groups) {
    const body = group.renderedMemory ?? 'Not yet rendered.';
    posts.push({
      key: `group-board:${group.id}`,
      title: title(`Group board: ${group.name}`),
      summary: summarize([body]),
      body,
    });
  }
  posts.push({
    key: 'system-prompt',
    title: title('System prompt (built-in)'),
    summary: summarize([data.builtinSystemPrompt]),
    body: data.builtinSystemPrompt,
  });
  // Built last so the "other posts" list can name every post actually in this sync; inserted at
  // the front afterward so Overview still renders first.
  const overviewLines = [
    `Name: ${data.name}`,
    `Version: ${data.version}`,
    `Build commit: ${data.buildCommit ?? 'unknown (no dist/BUILD.json; this is a dev/test build)'}`,
    `Service started: ${data.serviceStartedAt ? new Date(data.serviceStartedAt).toISOString() : 'unknown (daemon not running, or this is a dry run)'}`,
    'Accounts in priority order:',
    ...accounts.map(
      (a) =>
        `- ${a.id} (${a.provider}${a.model ? `, ${a.model}` : ''}) priority=${a.priority ?? 0}`,
    ),
    'Other posts in this dashboard:',
    ...posts.map((p) => `- ${p.title}`),
  ];
  posts.unshift({
    key: 'overview',
    title: title('Overview'),
    summary: summarize(overviewLines),
    body: overviewLines.join('\n'),
  });
  return posts;
}
/** Resolve each channel's live Discord name through the bot client, catching fetch errors, and
 * disambiguate any name shared by more than one channel (or that could not be resolved at all)
 * by appending the channel id. Only called on the live daemon sync path; --print has no client
 * and keeps showing the stored database name. Mutates channels[].name and the matching
 * AGENTS.md post titles in place so renderDashboardPosts needs no client awareness.
 */
export async function resolveChannelDisplayNames(
  client: Client,
  data: DashboardData,
): Promise<void> {
  const resolved = await Promise.all(
    data.channels.map(async (c) => {
      const channel = await client.channels.fetch(c.channelId).catch(() => null);
      const live = channel ? ((channel as { name?: string | null }).name ?? null) : null;
      return { channelId: c.channelId, fallback: c.name, live };
    }),
  );
  const counts = new Map<string, number>();
  for (const r of resolved) {
    const candidate = r.live ?? r.fallback;
    counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  }
  const display = new Map<string, string>();
  for (const r of resolved) {
    const candidate = r.live ?? r.fallback;
    const ambiguous = !r.live || (counts.get(candidate) ?? 0) > 1;
    display.set(r.channelId, ambiguous ? `${candidate} (${r.channelId})` : candidate);
  }
  for (const c of data.channels) c.name = display.get(c.channelId) ?? c.name;
  for (const a of data.channelAgentsMd) {
    const name = display.get(a.channelId);
    if (name) a.title = title(`AGENTS.md: ${name}`);
  }
}

// --- Discord-facing sync (daemon-only; never invoked by --print) ---------------------------

interface DashboardChannelState {
  threadId: string;
  messageId: string;
  hash: string;
  title: string;
  archived?: boolean;
}
function stateKey(postKey: string): string {
  return `dashboard-post:${postKey}`;
}
function hashPost(post: DashboardPost): string {
  return createHash('sha256').update(post.summary).update('\0').update(post.body).digest('hex');
}
function readState(store: Store, postKey: string): DashboardChannelState | undefined {
  const row = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    stateKey(postKey),
  );
  return row ? (JSON.parse(row.value) as DashboardChannelState) : undefined;
}
function writeState(store: Store, postKey: string, state: DashboardChannelState): void {
  store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    stateKey(postKey),
    JSON.stringify(state),
  );
}
function postFile(post: DashboardPost): { attachment: Buffer; name: string } {
  return {
    attachment: Buffer.from(post.body, 'utf8'),
    name: `${post.key.replace(/[^a-z0-9-]+/gi, '-')}.md`,
  };
}
/** True once this guild/channel resolution has already logged the missing-permission line, so a
 * tick every syncIntervalMs does not spam the log while the operator fixes the role.
 */
function warnOnce(store: Store, key: string, message: Record<string, unknown>): void {
  const flag = `dashboard-warned:${key}`;
  if (store.get('SELECT 1 FROM metadata WHERE key=?', flag)) return;
  store.exec('INSERT INTO metadata(key,value) VALUES(?,?)', flag, '1');
  console.error(JSON.stringify({ level: 'error', at: new Date().toISOString(), ...message }));
}
function clearWarning(store: Store, key: string): void {
  store.exec('DELETE FROM metadata WHERE key=?', `dashboard-warned:${key}`);
}
async function resolveGuild(client: Client, config: Config): Promise<Guild | undefined> {
  if (config.discord.guildId) return client.guilds.fetch(config.discord.guildId);
  if (!config.discord.noticeChannelId) return undefined;
  const notice = await client.channels.fetch(config.discord.noticeChannelId).catch(() => null);
  return notice && 'guild' in notice
    ? ((notice as { guild: Guild }).guild ?? undefined)
    : undefined;
}
const DASHBOARD_PERMISSION_OVERWRITES = (guild: Guild, botId: string, viewerIds: string[]) => [
  { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
  ...viewerIds.map((id) => ({
    id,
    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
  })),
  {
    id: botId,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.ManageThreads,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
    ],
  },
];
function isPrivateForum(channel: ForumChannel, guild: Guild): boolean {
  const everyone = channel.permissionOverwrites.cache.get(guild.id);
  return !!everyone?.deny.has(PermissionFlagsBits.ViewChannel);
}
/** Find the configured forum by id, else by name in the resolved guild, else create it private.
 * Never throws: a missing Manage Channels permission logs one line and returns undefined so the
 * daemon's tick simply tries again next interval, instead of crashing or retrying in a loop.
 */
export async function ensureDashboardChannel(
  client: Client,
  store: Store,
  config: Config,
): Promise<ForumChannel | undefined> {
  if (config.discord.dashboard.channelId) {
    const channel = await client.channels
      .fetch(config.discord.dashboard.channelId)
      .catch(() => null);
    if (channel?.type !== ChannelType.GuildForum) {
      warnOnce(store, 'explicit-channel', {
        event: 'dashboard_channel_unavailable',
        channelId: config.discord.dashboard.channelId,
      });
      return undefined;
    }
    clearWarning(store, 'explicit-channel');
    return channel;
  }
  const stored = store.get<{ value: string }>(
    "SELECT value FROM metadata WHERE key='dashboard-channel'",
  );
  if (stored) {
    const channel = await client.channels
      .fetch((JSON.parse(stored.value) as { channelId: string }).channelId)
      .catch(() => null);
    if (channel?.type === ChannelType.GuildForum) return channel;
  }
  const guild = await resolveGuild(client, config);
  if (!guild) {
    warnOnce(store, 'guild', { event: 'dashboard_guild_unresolved' });
    return undefined;
  }
  const byName = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildForum && c.name === config.discord.dashboard.channelName,
  ) as ForumChannel | undefined;
  if (byName) {
    if (!isPrivateForum(byName, guild))
      warnOnce(store, 'not-private', {
        event: 'dashboard_channel_not_private',
        channelId: byName.id,
      });
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      'dashboard-channel',
      JSON.stringify({ channelId: byName.id }),
    );
    clearWarning(store, 'guild');
    return byName;
  }
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    warnOnce(store, 'permission', { event: 'dashboard_missing_permission', guildId: guild.id });
    return undefined;
  }
  const created = await guild.channels.create({
    name: config.discord.dashboard.channelName,
    type: ChannelType.GuildForum,
    parent: config.discord.dashboard.categoryId,
    permissionOverwrites: DASHBOARD_PERMISSION_OVERWRITES(
      guild,
      client.user!.id,
      dashboardViewerIds(config),
    ),
  });
  store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    'dashboard-channel',
    JSON.stringify({ channelId: created.id }),
  );
  clearWarning(store, 'permission');
  clearWarning(store, 'guild');
  return created;
}
export interface DashboardSyncCounts {
  created: number;
  edited: number;
  unchanged: number;
  archived: number;
}
/** Create/update one thread per post, skip unchanged ones (zero API calls), rename a thread
 * whose title changed instead of recreating it, and archive threads whose post no longer
 * exists. Never deletes a thread or posts a duplicate after a restart: the per-post hash and
 * ids are durable in `metadata`, keyed by the post's stable `key`, which never changes even
 * when a resolved channel name (and so the post's title) does.
 */
export async function syncDashboardPosts(
  forum: ForumChannel,
  store: Store,
  posts: DashboardPost[],
): Promise<DashboardSyncCounts> {
  const counts: DashboardSyncCounts = { created: 0, edited: 0, unchanged: 0, archived: 0 };
  const live = new Set(posts.map((p) => p.key));
  for (const post of posts) {
    const hash = hashPost(post);
    const state = readState(store, post.key);
    if (!state) {
      const thread = await forum.threads.create({
        name: post.title,
        message: { content: post.summary, files: [postFile(post)] },
      });
      writeState(store, post.key, {
        threadId: thread.id,
        messageId: thread.id,
        hash,
        title: post.title,
      });
      counts.created++;
      continue;
    }
    const titleChanged = state.title !== post.title;
    if (state.hash === hash && !titleChanged) {
      counts.unchanged++;
      continue;
    }
    const thread = await forum.threads.fetch(state.threadId).catch(() => null);
    if (!thread) {
      writeState(store, post.key, { ...state, hash, title: post.title });
      counts.edited++;
      continue;
    }
    if (thread.archived) await thread.setArchived(false);
    if (titleChanged) await thread.setName(post.title);
    if (state.hash !== hash) {
      const message = await thread.messages.fetch(state.messageId);
      await message.edit({ content: post.summary, attachments: [], files: [postFile(post)] });
    }
    writeState(store, post.key, { ...state, hash, title: post.title });
    counts.edited++;
  }
  const prefix = 'dashboard-post:';
  for (const row of store.all<{ key: string; value: string }>(
    'SELECT key,value FROM metadata WHERE key LIKE ?',
    `${prefix}%`,
  )) {
    const postKey = row.key.slice(prefix.length);
    if (live.has(postKey)) continue;
    const state = JSON.parse(row.value) as DashboardChannelState;
    if (state.archived) continue;
    const thread = await forum.threads.fetch(state.threadId).catch(() => null);
    if (thread && !thread.archived) await thread.setArchived(true);
    writeState(store, postKey, { ...state, archived: true });
    counts.archived++;
  }
  return counts;
}
/** The full daemon-side sync: resolve/create the channel, then create/update/archive its posts.
 * Returns undefined, quietly, when there is nothing to sync (dashboard disabled or its channel
 * unavailable); a missing-permission or unresolved-guild condition is logged once, not on every
 * tick, so the daemon's tick loop and its syncIntervalMs timer keep running either way.
 */
export async function syncDashboard(
  client: Client,
  store: Store,
  config: Config,
  home: string,
): Promise<DashboardSyncCounts | undefined> {
  if (!config.discord.dashboard.enabled) return undefined;
  const forum = await ensureDashboardChannel(client, store, config);
  if (!forum) return undefined;
  const data = collectDashboardData(home, config, store);
  await resolveChannelDisplayNames(client, data);
  return syncDashboardPosts(forum, store, renderDashboardPosts(data));
}

// --- dashboard_sync tool contract: a request/result handoff over `metadata`, since the MCP tool
// runs in a separate process from the daemon that owns the Discord client. ---------------------

const DASHBOARD_SYNC_REQUEST_KEY = 'dashboard-sync-request';
function dashboardSyncResultKey(id: string): string {
  return `dashboard-sync-result:${id}`;
}
export interface DashboardSyncRequest {
  id: string;
  requestedAt: number;
}
/** Written by the dashboard_sync tool (mcp.ts); read and cleared by the daemon's tick loop. */
export function writeDashboardSyncRequest(store: Store, request: DashboardSyncRequest): void {
  store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    DASHBOARD_SYNC_REQUEST_KEY,
    JSON.stringify(request),
  );
}
export function readDashboardSyncRequest(store: Store): DashboardSyncRequest | undefined {
  const row = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    DASHBOARD_SYNC_REQUEST_KEY,
  );
  return row ? (JSON.parse(row.value) as DashboardSyncRequest) : undefined;
}
/** Read once by the dashboard_sync tool's poll loop, which deletes it on the same read so a
 * retried or duplicate poll never replays a stale result for a reused id. */
export function readDashboardSyncResult(store: Store, id: string): unknown | undefined {
  const key = dashboardSyncResultKey(id);
  const row = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key);
  if (!row) return undefined;
  store.exec('DELETE FROM metadata WHERE key=?', key);
  return JSON.parse(row.value);
}
/** Run one sync for whichever dashboard_sync request is currently pending, and write its result
 * (counts, "skipped", or error) for that request's id. False if there was no pending request.
 * A fake Discord client lets this, and the dashboard_sync tool's contract with it, be tested
 * without a live connection.
 */
export async function fulfillDashboardSyncRequest(
  client: Client,
  store: Store,
  config: Config,
  home: string,
): Promise<boolean> {
  const request = readDashboardSyncRequest(store);
  if (!request) return false;
  store.exec('DELETE FROM metadata WHERE key=?', DASHBOARD_SYNC_REQUEST_KEY);
  try {
    const counts = await syncDashboard(client, store, config, home);
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      dashboardSyncResultKey(request.id),
      JSON.stringify(
        counts ?? {
          skipped: true,
          reason: 'Dashboard disabled or its forum channel is unavailable right now.',
        },
      ),
    );
  } catch (error) {
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      dashboardSyncResultKey(request.id),
      JSON.stringify({ error: String(error) }),
    );
  }
  return true;
}
