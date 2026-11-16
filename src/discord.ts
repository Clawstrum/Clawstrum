import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ChannelType,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
  type Message,
  type ChatInputCommandInteraction,
  type TextBasedChannel,
} from 'discord.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Config } from './config.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { listTasks } from './scheduler.js';
import type { Outbound, Session } from './types.js';
import { formatSwitchArgument, getModelOverride, parseSwitchArgument } from './account-routing.js';
import { normalizeMessageText, stripQuietMarker } from './message-text.js';
import { recordGroupChannel } from './groups/store.js';
import { clearHeldInputs, heldInputsPreamble, holdInput } from './held-inputs.js';
import { recordUserDecision } from './user-decisions.js';

interface GroupRoute {
  issue: string;
  channel: string;
  thread?: string;
}
export function groupReviewThread(store: Store, thread: string): GroupRoute | undefined {
  const route = store.get<{ issue_id: string; channel_id: string }>(
    "SELECT r.issue_id,r.channel_id FROM group_review_routes r JOIN group_issues i ON i.id=r.issue_id WHERE r.thread_id=? ORDER BY (i.status='open') DESC,i.updated_at DESC LIMIT 1",
    thread,
  );
  return route ? { issue: route.issue_id, channel: route.channel_id, thread } : undefined;
}
const groupThreadFlights = new Map<string, Promise<string>>();
const groupNoticeFlights = new Map<string, Promise<string | undefined>>();

/** Mentions cannot identify DMs, and may be unreadable across guilds. Resolve the source
 * separately from the delivery destination; sendDelivery freezes the resulting payload. */
async function describeNoticeSource(
  client: Client,
  store: Store,
  row: Outbound,
): Promise<Outbound> {
  if (
    row.origin !== 'notice' ||
    store.get('SELECT value FROM metadata WHERE key=?', `discord-delivery:${row.id}`)
  )
    return row;
  const source = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    `notice-source:${row.id}`,
  );
  if (!source) return row;
  const { channelId } = JSON.parse(source.value) as { channelId: string };
  const known = store.get<{ name: string }>(
    'SELECT name FROM group_channels WHERE channel_id=?',
    channelId,
  )?.name;
  const name = (value: string) => value.replace(/[\r\n`]/g, ' ').slice(0, 100);
  let label = known && known !== channelId ? `Conversation: #${name(known)}` : 'Conversation';
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.type === ChannelType.DM) label = 'Conversation: direct message';
    else if (channel?.type === ChannelType.GroupDM) label = 'Conversation: group direct message';
    else if (channel && 'name' in channel && channel.name)
      label = `${channel.isThread() ? 'Thread' : 'Channel'}: #${name(channel.name)}`;
  } catch (error) {
    store.event(row.session_id, row.run_id, 'notice_source_unavailable', {
      outboxId: row.id,
      channelId,
      code: (error as { code?: number }).code,
    });
  }
  return { ...row, content: `${row.content} ${label} (ID ${channelId}).` };
}

/** A slow Discord route must not hold every other conversation's recovery behind it. */
async function recoverTogether<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

/** Centralize maintenance output without moving its source workspace or internal task.
 * Several source sessions can investigate one issue; its operator notice is delivered once.
 * Persist both destination and chunk receipts so retries never fall back into a research channel.
 */
async function sendGroupOperatorDelivery(
  client: Client,
  store: Store,
  row: Outbound,
  group: GroupRoute,
  channelId: string,
  plainDashes: boolean,
): Promise<string | undefined> {
  const delivery = store.transaction(() => {
    const issueKey = `group-operator-route:${group.issue}`;
    store.exec(
      'INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)',
      issueKey,
      JSON.stringify({ channelId }),
    );
    const target = JSON.parse(
      store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', issueKey)!.value,
    ).channelId as string;
    store.exec(
      'INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)',
      `discord-route:${row.id}`,
      JSON.stringify({ channelId: target, operatorGroup: true }),
    );
    const phase = row.dedupe_key?.match(/^group-(issue|resolved):([^:]+):.+:(\d+)$/);
    let canonical = row;
    if (row.origin === 'notice' && phase?.[2] === group.issue) {
      const key = `group-operator-notice:${group.issue}:${phase[1]}:${phase[3]}`;
      store.exec('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)', key, row.id);
      const id = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key)!.value;
      canonical = store.get<Outbound>('SELECT * FROM outbox WHERE id=?', id)!;
    }
    const issue = store.get<{ channels_json: string }>(
      'SELECT channels_json FROM group_issues WHERE id=?',
      group.issue,
    );
    const sources =
      canonical.origin === 'notice' && issue
        ? (JSON.parse(issue.channels_json) as string[]).map((id) => store.session(id).channel_id)
        : [group.channel];
    return {
      channelId: target,
      row: {
        ...canonical,
        content: `${canonical.content}\n\nGroup review ${group.issue}; source channels: ${[...new Set(sources)].map((id) => `<#${id}>`).join(', ')}.`,
      },
    };
  });
  const key = `${store.home}:${delivery.row.id}`;
  const running = groupNoticeFlights.get(key);
  if (running) return running;
  const send = async () => {
    const target = await client.channels.fetch(delivery.channelId);
    if (!target?.isSendable()) throw new Error('Group review operator channel is unavailable');
    return sendDelivery(store, delivery.row, (payload) => target.send(payload), plainDashes);
  };
  const flight = send();
  groupNoticeFlights.set(key, flight);
  try {
    return await flight;
  } finally {
    groupNoticeFlights.delete(key);
  }
}

export function accepts(
  config: Config,
  userId: string,
  guildId: string | null,
  channelId: string,
  parentId: string | null = null,
): boolean {
  if (!config.discord.allowAllSenders && !config.discord.ownerIds.includes(userId)) return false;
  if (!guildId) return config.discord.allowDMs;
  if (config.discord.guildId && guildId !== config.discord.guildId) return false;
  return (
    config.discord.channelIds.includes(channelId) ||
    (!!parentId && config.discord.channelIds.includes(parentId))
  );
}
/** Split chat prose without dropping source whitespace or cutting a UTF-16 surrogate pair.
 * Recognize fenced lines, not inline backticks, and preserve the language on continuation parts.
 */
export function splitMessage(text: string, limit = 1900): string[] {
  if (!Number.isInteger(limit) || limit < 32) throw new Error('Message limit must be at least 32');
  if (text.length <= limit) return [text];
  type Fence = { marker: string; header: string };
  const boundaries: Array<{ start: number; end: number; after?: Fence }> = [];
  let fence: Fence | undefined;
  for (const line of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?(?:\n|$)/gm)) {
    const marker = line[1]!;
    const info = line[2]!;
    // Extremely long delimiter/header lines cannot be kept intact in a bounded message.
    // Preserve their text through ordinary splitting instead of getting stuck on the boundary.
    if (line[0].length > limit / 3) continue;
    if (fence) {
      if (marker[0] !== fence.marker[0] || marker.length < fence.marker.length || info.trim())
        continue;
      fence = undefined;
    } else {
      if (marker[0] === '`' && info.includes('`')) continue;
      fence = { marker, header: marker + info + '\n' };
    }
    boundaries.push({ start: line.index, end: line.index + line[0].length, after: fence });
  }
  const reserve = boundaries.reduce(
    (max, b) => Math.max(max, (b.after?.marker.length ?? 0) + 1),
    4,
  );
  const parts: string[] = [];
  let offset = 0;
  let next = 0;
  let active: Fence | undefined;
  while (offset < text.length) {
    const prefix = active?.header ?? '';
    const room = limit - prefix.length - reserve;
    let end = Math.min(text.length, offset + room);
    if (end < text.length) {
      const cut = text.slice(offset, end);
      const hasCode =
        active || boundaries.some((b) => b.after && b.start >= offset && b.start < end);
      const stop = hasCode
        ? cut.lastIndexOf('\n')
        : Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '), cut.lastIndexOf(' '));
      if (stop > room / 3) end = offset + stop + 1;
      const boundary = boundaries.find((b) => b.start < end && b.end > end);
      if (boundary) end = boundary.start > offset ? boundary.start : boundary.end;
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
    }
    while (next < boundaries.length && boundaries[next]!.end <= end)
      active = boundaries[next++]!.after;
    let head = prefix + text.slice(offset, end);
    if (active) head += '\n' + active.marker;
    parts.push(head);
    offset = end;
  }
  return parts;
}
export type DeliveryPayload = {
  content: string;
  files: Array<{ attachment: string | Buffer; name: string }>;
  nonce: string;
  enforceNonce: true;
  allowedMentions: { parse: never[] };
};
/** One payload per Discord message. Only the first carries the origin label and only the last
 * carries an explicitly attached file, so a caption still reads before what it describes.
 */
export function deliveryPayloads(row: Outbound, plainDashes = false): DeliveryPayload[] {
  const labels = {
    notice: 'Clawstrum notice',
    worker: 'Research subagent',
    provider: 'Provider notice',
  };
  const prefix = row.origin && row.origin !== 'agent' ? `-# ${labels[row.origin]}\n` : '';
  const parts = splitMessage(normalizeMessageText(row.content, plainDashes), 1900 - prefix.length);
  const attachment = row.file_path
    ? [
        {
          attachment: row.file_path,
          name: path.basename(row.file_path).replace(/^[0-9a-f-]{36}-/, ''),
        },
      ]
    : [];
  return parts.map((part, i) => ({
    content: (i ? '' : prefix) + part,
    files: i === parts.length - 1 ? attachment : [],
    nonce: createHash('sha256')
      .update(i ? `${row.id}#${i}` : row.id)
      .digest('hex')
      .slice(0, 24),
    enforceNonce: true as const,
    allowedMentions: { parse: [] as never[] },
  }));
}
/** Freeze chunk boundaries before delivery and retain each acknowledged message ID. A retry
 * resumes the first unacknowledged chunk even after restart or a splitter upgrade. Discord's
 * nonce still covers the finite window where a send succeeds but its acknowledgment is lost.
 */
export async function sendDelivery(
  store: Store,
  row: Outbound,
  send: (payload: DeliveryPayload) => Promise<{ id: string }>,
  plainDashes = false,
): Promise<string | undefined> {
  const key = `discord-delivery:${row.id}`;
  type Progress = { payloads: DeliveryPayload[]; remoteIds: string[] };
  const progress = store.transaction(() => {
    const old = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key);
    if (old) return JSON.parse(old.value) as Progress;
    const initial: Progress = { payloads: deliveryPayloads(row, plainDashes), remoteIds: [] };
    store.exec('INSERT INTO metadata(key,value) VALUES(?,?)', key, JSON.stringify(initial));
    return initial;
  });
  for (let i = progress.remoteIds.length; i < progress.payloads.length; i++) {
    // Apply at the final boundary too: tools and already-spooled replies bypass provider-result
    // handling. Keep frozen chunk indexes/nonces intact when skipping a marker-only chunk.
    const payload = progress.payloads[i]!;
    const content = stripQuietMarker(payload.content);
    const sent =
      content.trim() || payload.files.length ? await send({ ...payload, content }) : undefined;
    // The receipt must describe the text actually sent, including for old spools.
    // Keep the original nonce/index and leave already-acknowledged chunks untouched.
    progress.payloads[i] = { ...payload, content };
    progress.remoteIds.push(sent?.id ?? '');
    store.exec('UPDATE metadata SET value=? WHERE key=?', JSON.stringify(progress), key);
  }
  return progress.remoteIds.find(Boolean);
}

function unavailableThread(error: unknown): boolean {
  const code = (error as { code?: number })?.code;
  return [10003, 10008, 50001, 50013, 50083].includes(code ?? 0);
}

/** Persist a real Discord destination before sending. Thread IDs equal their starter message
 * IDs, so a lost create response or a concurrent creator can be recovered without duplication.
 */
export async function sendDiscordDelivery(
  client: Client,
  store: Store,
  channelId: string,
  row: Outbound,
  plainDashes = false,
  noticeChannelId?: string,
): Promise<string | undefined> {
  // Retire unsent boilerplate from older builds too; never create a thread just for a receipt.
  if (row.origin === 'notice' && row.dedupe_key?.startsWith('receipt:')) return undefined;
  row = await describeNoticeSource(client, store, row);
  const notice = store.noticeThread(row.id);
  const groupValue =
    store.get<{ value: string }>(
      'SELECT value FROM metadata WHERE key=?',
      `group-output:${row.id}`,
    ) ??
    (row.dedupe_key
      ? store.get<{ value: string }>(
          'SELECT value FROM metadata WHERE key=?',
          `group-notice:${row.dedupe_key}`,
        )
      : undefined);
  const group: GroupRoute | undefined = groupValue ? JSON.parse(groupValue.value) : undefined;
  if (group && group.channel !== channelId)
    throw new Error('Group delivery route belongs to another conversation');
  const routeKey = `discord-route:${row.id}`;
  const saved = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', routeKey);
  // Human replies have an explicit thread. Automatic notices and task replies do not.
  // Honor already-attempted routes, including across configuration changes and restarts.
  const prior = saved ? JSON.parse(saved.value) : undefined;
  const issueTarget = group
    ? store.get<{ value: string }>(
        'SELECT value FROM metadata WHERE key=?',
        `group-operator-route:${group.issue}`,
      )
    : undefined;
  const operatorChannel = saved
    ? prior.operatorGroup
      ? prior.channelId
      : undefined
    : issueTarget
      ? JSON.parse(issueTarget.value).channelId
      : noticeChannelId;
  if (group && !group.thread && operatorChannel)
    return sendGroupOperatorDelivery(client, store, row, group, operatorChannel, plainDashes);
  let destination: string | null = saved ? JSON.parse(saved.value).channelId : channelId;
  const remember = (id: string | null) => {
    destination = id;
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      routeKey,
      JSON.stringify({ channelId: id }),
    );
  };
  const fallback = (reason: string) => {
    remember(notice?.fallback === 'skip' ? null : channelId);
    store.event(row.session_id, row.run_id, 'notice_thread_unavailable', {
      outboxId: row.id,
      reason,
      destination,
    });
  };
  if ((notice || group) && !saved) {
    try {
      const parent = await client.channels.fetch(channelId);
      if (parent?.isThread()) {
        remember(channelId); // Discord has no nested threads.
        if (group)
          store.exec(
            'UPDATE group_review_routes SET thread_id=? WHERE issue_id=? AND channel_id=?',
            channelId,
            group.issue,
            channelId,
          );
      } else if (
        parent?.type === ChannelType.GuildText ||
        parent?.type === ChannelType.GuildAnnouncement
      ) {
        const groupId = group
          ? store.get<{ group_id: string }>(
              'SELECT group_id FROM group_issues WHERE id=?',
              group.issue,
            )?.group_id
          : undefined;
        const groupKey = groupId ? `group-thread:${groupId}:${channelId}` : undefined;
        const knownGroup = group
          ? store.get<{ thread_id: string | null }>(
              'SELECT thread_id FROM group_review_routes WHERE issue_id=? AND channel_id=?',
              group.issue,
              channelId,
            )?.thread_id
          : undefined;
        const cached = groupKey
          ? store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', groupKey)?.value
          : undefined;
        let anchor =
          group?.thread ??
          knownGroup ??
          (cached ? JSON.parse(cached) : undefined) ??
          notice?.messageId;
        const name = groupId ? `Clawstrum ${groupId} review`.slice(0, 100) : 'Clawstrum updates';
        const fetchThread = async () => {
          if (!anchor) {
            const active = await parent.threads.fetchActive();
            return [...active.threads.values()].find((thread) => thread.name === name) ?? null;
          }
          try {
            return await client.channels.fetch(anchor, { force: true });
          } catch (error) {
            if ((error as { code?: number }).code === RESTJSONErrorCodes.UnknownChannel)
              return null;
            throw error;
          }
        };
        const flightKey = `${channelId}:${anchor ?? groupKey}`;
        let thread = await fetchThread();
        // A deleted stand-alone review thread is not a starter message in the parent.
        if (!thread && group && (group.thread || knownGroup || cached)) {
          anchor = undefined;
          thread = await fetchThread();
        }
        if (!thread) {
          const running = groupThreadFlights.get(flightKey);
          if (running) thread = await client.channels.fetch(await running);
          else {
            const create = async () => {
              try {
                const created = await parent.threads.create({
                  ...(anchor ? { startMessage: anchor } : {}),
                  name,
                  autoArchiveDuration: 60,
                });
                return created.id;
              } catch (error) {
                // The POST may have succeeded before the connection failed; also handles a create race.
                const recovered = await fetchThread();
                if (!recovered) throw error;
                return recovered.id;
              }
            };
            const flight = create();
            groupThreadFlights.set(flightKey, flight);
            try {
              thread = await client.channels.fetch(await flight);
            } finally {
              groupThreadFlights.delete(flightKey);
            }
          }
        }
        if (!thread?.isThread() || thread.parentId !== channelId)
          throw new Error('Notice thread does not belong to the conversation');
        remember(thread.id);
        if (group) {
          store.exec(
            'UPDATE group_review_routes SET thread_id=? WHERE issue_id=? AND channel_id=?',
            thread.id,
            group.issue,
            channelId,
          );
          if (groupKey && !notice?.messageId)
            store.exec(
              'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
              groupKey,
              JSON.stringify(thread.id),
            );
        }
      } else fallback('This channel does not support message threads');
    } catch (error) {
      if (!unavailableThread(error)) throw error;
      fallback(`Discord error ${(error as { code: number }).code}`);
    }
  }
  const send = async () => {
    if (destination === null) return undefined;
    const channel = await client.channels.fetch(destination);
    if (!channel?.isSendable())
      throw new Error('Discord channel is unavailable or cannot receive messages');
    return sendDelivery(store, row, (payload) => channel.send(payload), plainDashes);
  };
  try {
    return await send();
  } catch (error) {
    // Never move a partially delivered notice to another channel, or retry ambiguous sends there.
    const progress = store.get<{ value: string }>(
      'SELECT value FROM metadata WHERE key=?',
      `discord-delivery:${row.id}`,
    );
    if (
      (!notice && !group) ||
      !unavailableThread(error) ||
      (destination === channelId && notice?.fallback !== 'skip') ||
      (progress && JSON.parse(progress.value).remoteIds.length)
    )
      throw error;
    fallback(`Discord error ${(error as { code: number }).code}`);
    return send();
  }
}
const DELIVERY_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Discord rejected the request itself (bad payload, missing channel or access); retrying cannot help. */
export function permanentDeliveryError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return (
    typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
}
export class Delivery {
  private readonly active = new Set<string>();
  constructor(
    readonly store: Store,
    readonly send: (channel: string, row: Outbound) => Promise<string | undefined>,
  ) {}
  async tick(now = Date.now()): Promise<void> {
    // A hung route must not hold unrelated channel replies behind a global busy flag.
    // pendingOutbox preserves ordering within each destination; active IDs prevent duplicate sends.
    const rows = this.store
      .pendingOutbox(now)
      .filter((row) => !this.active.has(row.id))
      .slice(0, Math.max(0, 16 - this.active.size));
    await Promise.all(
      rows.map(async (row) => {
        this.active.add(row.id);
        try {
          const remote = await this.send(this.store.session(row.session_id).channel_id, row);
          this.store.exec(
            "UPDATE outbox SET status='sent',remote_id=? WHERE id=?",
            remote ?? null,
            row.id,
          );
          this.store.event(row.session_id, row.run_id, remote ? 'delivered' : 'notice_suppressed', {
            outboxId: row.id,
            remoteId: remote,
          });
        } catch (error) {
          const attempts = row.attempts + 1;
          // A fixed attempt count gave up after about four minutes, which drops a reply during
          // a longer Discord or network outage. Only a rejected request or a day of retries fails.
          const giveUp =
            permanentDeliveryError(error) || now - row.created_at >= DELIVERY_RETRY_WINDOW_MS;
          this.store.exec(
            'UPDATE outbox SET attempts=?,available_at=?,status=? WHERE id=?',
            attempts,
            now + Math.min(300000, 1000 * 2 ** Math.min(attempts, 16)),
            giveUp ? 'failed' : 'pending',
            row.id,
          );
          this.store.event(row.session_id, row.run_id, 'delivery_error', String(error));
        } finally {
          this.active.delete(row.id);
        }
      }),
    );
  }
}
export function sessionStatus(store: Store, sessionId: string): string {
  const s = store.session(sessionId);
  const counts = store.all<{ status: string; n: number }>(
    'SELECT status,count(*) n FROM inbound WHERE session_id=? GROUP BY status',
    sessionId,
  );
  const last = store.get<{ status: string; error: string | null }>(
    'SELECT status,error FROM runs WHERE session_id=? ORDER BY started_at DESC LIMIT 1',
    sessionId,
  );
  const failedDelivery = store.get<{ n: number }>(
    "SELECT count(*) n FROM outbox WHERE session_id=? AND status='failed'",
    sessionId,
  )!.n;
  return [
    `Session: ${s.id}`,
    `Account: ${s.active_account ?? 'not started'}; preferred: ${s.preferred_account ?? 'automatic'}`,
    `Model: ${s.active_model ?? 'not started'}; model override: ${modelOverrideText(store, s)}`,
    counts.map((c) => `${c.status}: ${c.n}`).join(', '),
    last ? `Last run: ${last.status}${last.error ? ` — ${last.error.slice(0, 500)}` : ''}` : '',
    `Failed deliveries: ${failedDelivery}`,
    `Workspace: ${s.workspace}`,
  ]
    .filter(Boolean)
    .join('\n');
}
function modelOverrideText(store: Store, session: Session): string {
  const override = getModelOverride(store, session.id);
  if (!override) return 'none';
  return override.account === session.preferred_account
    ? `${override.model} on ${override.account}`
    : `${override.model} on ${override.account} (inactive: preferred account is ${session.preferred_account ?? 'automatic'})`;
}
export function parseCommand(content: string): { command: string; argument?: string } | undefined {
  const match =
    /^!clawstrum(?:\s+(status|accounts|tasks|stop|reset|resume)|\s+(switch)\s+([a-zA-Z0-9_-]{1,80})(?:\s+(?:--model\s+)?([^\s-][^\s]{0,119}))?)?\s*$/.exec(
      content,
    );
  return match
    ? {
        command: match[1] ?? match[2] ?? 'status',
        argument: match[3] ? formatSwitchArgument(match[3], match[4]) : undefined,
      }
    : undefined;
}
export interface DiscordOptions {
  /** Acceptance runners sharing a bot must not alter its application commands. */
  registerCommands?: boolean;
  /** Only the unattended acceptance runner supplies this; never read from user config/env.
   * A webhook is a real Discord sender, not an automated human account. Normal
   * instances reject bot/webhook messages by default. Owner/channel checks still apply.
   */
  testWebhook?: { id: string; channelId: string; guildId: string };
}
export class Discord {
  readonly client = new Client({
    rest: { timeout: 10000, retries: 1 },
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageTyping,
      GatewayIntentBits.DirectMessageTyping,
    ],
    partials: [Partials.Channel],
  });
  readonly delivery: Delivery;
  private lastTyping = 0;
  private typingBusy = false;
  private connected = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private recovering: Promise<void> | undefined;
  private lastRecovery = 0;
  private readonly pending = new Set<Promise<void>>();
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly engine: Engine,
    readonly options: DiscordOptions = {},
  ) {
    const test = options.testWebhook;
    if (
      test &&
      (options.registerCommands !== false ||
        config.discord.allowAllSenders ||
        config.discord.respondToBots ||
        config.discord.allowDMs ||
        config.discord.guildId !== test.guildId ||
        config.discord.channelIds.length !== 1 ||
        config.discord.channelIds[0] !== test.channelId ||
        config.discord.ownerIds.length !== 1 ||
        config.discord.ownerIds[0] !== test.id)
    )
      throw new Error(
        'Automated Discord ingress requires an isolated guild/channel/owner configuration and disabled command registration',
      );
    engine.refreshAttachment = async (messageId, attachment) => {
      const input = store.get<{ session_id: string }>(
        'SELECT session_id FROM inbound WHERE id=?',
        messageId,
      );
      if (!input) return;
      const channel = await this.client.channels.fetch(store.session(input.session_id).channel_id);
      if (!channel?.isTextBased() || !('messages' in channel)) return;
      const message = await channel.messages.fetch(messageId);
      return [...message.attachments.values()].find(
        (a) => a.name === attachment.name && a.size === attachment.size,
      )?.url;
    };
    const recover = () => {
      if (this.connected) void this.backfill().catch((e) => this.report(e));
    };
    this.client.on(Events.ShardReady, recover);
    this.client.on(Events.ShardResume, recover);
    this.delivery = new Delivery(store, (id, row) =>
      sendDiscordDelivery(
        this.client,
        store,
        id,
        row,
        this.config.discord.plainDashes,
        this.config.discord.noticeChannelId,
      ),
    );
    this.client.on(Events.MessageCreate, (message) => {
      if (this.closing) return;
      this.track(this.onMessage(message));
    });
    this.client.on(Events.InteractionCreate, (i) => {
      if (this.closing) return;
      if (i.isChatInputCommand() && i.commandName === 'clawstrum') this.track(this.onCommand(i));
    });
    this.client.on(Events.TypingStart, (typing) => {
      if (this.closing) return;
      if (typing.user.bot) return;
      if (
        !accepts(
          config,
          typing.user.id,
          typing.guild?.id ?? null,
          typing.channel.id,
          'parentId' in typing.channel ? typing.channel.parentId : null,
        )
      )
        return;
      const session = store.ensureSession(
        groupReviewThread(store, typing.channel.id)?.channel ?? typing.channel.id,
      );
      engine.typingUntil.set(session.id, Date.now() + 12000);
    });
    this.client.on(Events.Error, (e) => this.report(e));
    this.client.on(Events.ShardError, (e, shardId) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'discord_shard_error',
          at: new Date().toISOString(),
          shardId,
          message: String(e),
        }),
      );
    });
  }
  private track(work: Promise<void>): Promise<void> {
    const tracked = work
      .catch((error) => this.report(error))
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }
  private report(error: unknown): void {
    console.error(JSON.stringify({ level: 'error', event: 'discord', message: String(error) }));
  }
  /** True once any other bot has posted in this channel; recorded the first time one does. */
  private sharedWithBot(channelId: string, fromBot: boolean): boolean {
    const key = `bot-peer:${channelId}`;
    if (fromBot)
      this.store.exec(
        'INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)',
        key,
        String(Date.now()),
      );
    return !!this.store.get('SELECT 1 FROM metadata WHERE key=?', key);
  }
  /** An @-mention of this bot or its role, a reply that pings it, or its name as a word. */
  private addressesMe(message: Message): boolean {
    const me = this.client.user;
    if (!me) return true;
    if (message.mentions?.users?.has(me.id)) return true;
    const roles = message.guild?.members?.me?.roles?.cache;
    if (roles && message.mentions?.roles?.some((r) => roles.has(r.id))) return true;
    const names = [me.username, this.config.name, message.guild?.members?.me?.displayName]
      .filter((n): n is string => !!n && n.trim().length > 0)
      .map((n) => n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return names.some((n) =>
      new RegExp(`(^|[^\\p{L}\\p{N}_])${n}($|[^\\p{L}\\p{N}_])`, 'iu').test(message.content),
    );
  }
  private isAllowed(user: string, guild: string | null, channel: TextBasedChannel): boolean {
    return accepts(
      this.config,
      user,
      guild,
      channel.id,
      'parentId' in channel ? channel.parentId : null,
    );
  }
  private command(session: string, command: string, arg?: string, at = Date.now()): string {
    if (command === 'tasks') return JSON.stringify(listTasks(this.store, session));
    if (command === 'status') return sessionStatus(this.store, session);
    if (command === 'accounts')
      return this.config.accounts
        .map((a) => {
          const s = this.store.get<{ cooldown_until: number; disabled: number }>(
            'SELECT * FROM accounts WHERE id=?',
            a.id,
          )!;
          return `${a.id} (${a.provider}): ${s.disabled ? 'sign-in required' : s.cooldown_until > Date.now() ? `cooldown until ${new Date(s.cooldown_until).toISOString()}` : 'available'}`;
        })
        .join('\n');
    if (
      command === 'switch' &&
      !this.config.accounts.some((a) => a.id === parseSwitchArgument(arg ?? null).account)
    )
      return 'Specify one of: ' + this.config.accounts.map((a) => a.id).join(', ');
    const action = command === 'stop' ? 'cancel' : command;
    if (!['switch', 'cancel', 'reset', 'resume'].includes(action))
      return 'Commands: status, accounts, switch ACCOUNT [MODEL|default], stop, reset, resume';
    this.store.exec(
      'INSERT INTO controls(session_id,command,argument,created_at) VALUES(?,?,?,?)',
      session,
      action,
      arg ?? null,
      at,
    );
    const requested = command === 'switch' ? parseSwitchArgument(arg ?? null) : undefined;
    return requested
      ? `Switch requested: ${requested.account}${requested.model ? ` with model ${requested.model}` : ' with its own model'}. Active work will continue through a saved handoff.`
      : `${command} requested.`;
  }
  private async onMessage(message: Message, acknowledge = true): Promise<void> {
    const test = this.options.testWebhook;
    const automated =
      test &&
      message.webhookId === test.id &&
      message.author.id === test.id &&
      message.guildId === test.guildId &&
      (message.channelId === test.channelId ||
        ('parentId' in message.channel && message.channel.parentId === test.channelId));
    if (
      message.author.id === this.client.user?.id ||
      (message.author.bot && !automated && !this.config.discord.respondToBots) ||
      !this.isAllowed(message.author.id, message.guildId, message.channel)
    )
      return;
    const groupRoute = groupReviewThread(this.store, message.channelId);
    const session = this.store.ensureSession(groupRoute?.channel ?? message.channelId);
    if (!groupRoute)
      recordGroupChannel(
        this.store,
        session,
        'name' in message.channel ? String(message.channel.name) : session.channel_id,
        message.channel.isThread?.() ? message.channel.parentId : null,
      );
    const parsed = parseCommand(message.content);
    if (parsed) {
      if (
        (!automated && message.author.bot) ||
        !this.config.discord.ownerIds.includes(message.author.id)
      )
        return;
      this.store.transaction(() => {
        if (
          !this.store.exec(
            'INSERT OR IGNORE INTO command_receipts(message_id) VALUES(?)',
            message.id,
          ).changes
        )
          return;
        const output = this.store.outbox(
          session.id,
          this.command(session.id, parsed.command, parsed.argument, message.createdTimestamp),
          {
            key: `command:${message.id}`,
          },
        );
        if (groupRoute)
          this.store.exec(
            'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
            `group-output:${output}`,
            JSON.stringify(groupRoute),
          );
      });
      return;
    }
    const attachments = [...message.attachments.values()].map((a) => ({
      name: a.name,
      url: a.url,
      size: a.size,
      contentType: a.contentType ?? undefined,
    }));
    if (!message.content.trim() && !attachments.length) return;
    // In a channel another bot also answers in, a message that does not name this bot is kept
    // as context and not answered; otherwise both bots wake on every message.
    const shared =
      !groupRoute && !automated && this.config.discord.mentionOnlyWithBots
        ? this.sharedWithBot(session.channel_id, message.author.bot)
        : false;
    if (shared && !this.addressesMe(message)) {
      holdInput(this.store, session.id, {
        id: message.id,
        author: message.author.displayName,
        text: message.content,
        attachments,
        at: message.createdTimestamp,
      });
      return;
    }
    const inserted = this.store.transaction(() => {
      const held = shared ? heldInputsPreamble(this.store, session.id) : '';
      const inserted = this.store.enqueue({
        id: message.id,
        sessionId: session.id,
        author: message.author.displayName,
        content: groupRoute
          ? `Group review thread ${message.channelId}; issue ${groupRoute.issue}.\n${message.content}`
          : held + message.content,
        attachments,
        at: message.createdTimestamp,
      });
      if (inserted && held) clearHeldInputs(this.store, session.id);
      if (inserted)
        this.store.event(session.id, null, 'input_received', {
          id: message.id,
          sentAt: message.createdTimestamp,
          transport: acknowledge ? 'gateway' : 'recovery',
        });
      // A bot's message may be read and left unanswered; see the quiet check in engine.ts.
      if (inserted && message.author.bot)
        this.store.exec(
          'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
          `bot-input:${message.id}`,
          '1',
        );
      if (inserted && !message.author.bot && !groupRoute)
        recordUserDecision(
          this.store,
          session.id,
          message.id,
          message.author.displayName,
          message.content,
          message.createdTimestamp,
        );
      if (inserted && groupRoute)
        this.store.exec(
          'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
          `group-input:${message.id}`,
          JSON.stringify(groupRoute),
        );
      // Keep an anchor for useful operational notices without sending intake boilerplate.
      if (inserted && !groupRoute && (!message.author.bot || automated))
        this.store.discordRequest(session.id, message.id, message.createdTimestamp);
      return inserted;
    });
    if (inserted && acknowledge)
      await message.react(this.engine.active.has(session.id) ? '📨' : '👀').catch(() => undefined);
  }
  private async onCommand(i: ChatInputCommandInteraction): Promise<void> {
    if (
      !i.channel ||
      i.user.bot ||
      !this.config.discord.ownerIds.includes(i.user.id) ||
      !this.isAllowed(i.user.id, i.guildId, i.channel)
    ) {
      await i.reply({
        content: 'This conversation is not configured for your account.',
        ephemeral: true,
      });
      return;
    }
    const session = this.store.ensureSession(
      groupReviewThread(this.store, i.channelId)?.channel ?? i.channelId,
    );
    await i.reply({
      content: this.command(
        session.id,
        i.options.getString('action', true),
        (() => {
          const account = i.options.getString('account') ?? undefined;
          const model = i.options.getString('model') ?? undefined;
          return account && model && !/\s/.test(model)
            ? formatSwitchArgument(account, model)
            : account;
        })(),
      ),
      ephemeral: true,
    });
  }
  async connect(token: string): Promise<void> {
    let readyTimer: NodeJS.Timeout;
    let onReady: () => void;
    let onError: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyTimer = setTimeout(() => reject(new Error('Discord login timed out')), 45000);
      onReady = resolve;
      onError = reject;
      this.client.once(Events.ClientReady, onReady);
      this.client.once(Events.Error, onError);
    });
    try {
      // Observe both promises immediately, including a ready timeout while login hangs.
      await Promise.all([ready, Promise.resolve().then(() => this.client.login(token))]);
    } finally {
      clearTimeout(readyTimer!);
      this.client.off(Events.ClientReady, onReady!);
      this.client.off(Events.Error, onError!);
    }
    const command = new SlashCommandBuilder()
      .setName('clawstrum')
      .setDescription('Control this Clawstrum conversation')
      .addStringOption((o) =>
        o
          .setName('action')
          .setDescription('Action')
          .setRequired(true)
          .addChoices(
            ...['status', 'accounts', 'tasks', 'switch', 'stop', 'reset', 'resume'].map((name) => ({
              name,
              value: name,
            })),
          ),
      )
      .addStringOption((o) => o.setName('account').setDescription('Account id for switch'))
      .addStringOption((o) =>
        o.setName('model').setDescription('Model for switch, or "default" for the account\'s own'),
      );
    if (this.options.registerCommands === false) {
      this.connected = true;
      await this.backfill();
      return;
    }
    if (this.config.discord.guildId)
      await this.client.application!.commands.create(command.toJSON(), this.config.discord.guildId);
    else await this.client.application!.commands.create(command.toJSON());
    this.connected = true;
    await this.backfill();
  }
  backfill(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.recovering) return this.recovering;
    this.lastRecovery = Date.now();
    this.recovering = this.recoverHistory().finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }
  private recoverySessions() {
    return this.store.all<{ id: string; channel_id: string; created_at: number }>(
      `SELECT id,channel_id,created_at FROM sessions UNION SELECT s.id,r.thread_id,min(i.created_at) FROM group_review_routes r JOIN sessions s ON s.channel_id=r.channel_id JOIN group_issues i ON i.id=r.issue_id WHERE r.thread_id IS NOT NULL AND r.thread_id<>r.channel_id GROUP BY r.thread_id`,
    );
  }
  private async recoverHistory(): Promise<void> {
    const startedAt = Date.now();
    const known = this.recoverySessions();
    const phase = (stage: string, conversations: number) =>
      this.store.exec(
        'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        'discord-recovery',
        JSON.stringify({ stage, conversations, startedAt, updatedAt: Date.now() }),
      );
    // Drain known conversations first. Thread discovery is housekeeping, not an ingress gate.
    phase('messages', known.length);
    await recoverTogether(known, (session) => this.recoverChannel(session));
    if (this.closing) return;
    phase('discovery', this.config.discord.channelIds.length);
    // Include configured channels and their discoverable active/recent archived threads,
    // even when a conversation has never received a live gateway event.
    await recoverTogether(this.config.discord.channelIds, async (id) => {
      if (this.closing) return;
      try {
        const channel = await this.client.channels.fetch(id);
        if (!channel) return;
        if (channel.isTextBased())
          recordGroupChannel(
            this.store,
            this.store.ensureSession(id),
            'name' in channel ? String(channel.name) : id,
            channel.isThread?.() ? channel.parentId : null,
          );
        if ('threads' in channel) {
          const active = await channel.threads.fetchActive();
          for (const thread of active.threads.values())
            if (!groupReviewThread(this.store, thread.id))
              recordGroupChannel(
                this.store,
                this.store.ensureSession(thread.id),
                thread.name,
                thread.parentId,
              );
          const archived = await channel.threads.fetchArchived({ limit: 100 });
          for (const thread of archived.threads.values())
            if (!groupReviewThread(this.store, thread.id))
              recordGroupChannel(
                this.store,
                this.store.ensureSession(thread.id),
                thread.name,
                thread.parentId,
              );
        }
      } catch (error) {
        this.report(error);
      }
    });
    if (this.config.discord.allowDMs)
      await recoverTogether(this.config.discord.ownerIds, async (owner) => {
        try {
          this.store.ensureSession((await this.client.users.createDM(owner)).id);
        } catch (error) {
          this.report(error);
        }
      });
    if (this.closing) return;
    const seen = new Set(known.map((session) => session.channel_id));
    const fresh = this.recoverySessions().filter((session) => !seen.has(session.channel_id));
    phase('new-messages', fresh.length);
    await recoverTogether(fresh, (session) => this.recoverChannel(session));
    phase('completed', known.length + fresh.length);
  }
  private async recoverChannel(session: {
    id: string;
    channel_id: string;
    created_at: number;
  }): Promise<void> {
    if (this.closing) return;
    // Pin a newly registered conversation to its own lookback, even if no messages exist yet.
    // Existing cursors survive arbitrarily long downtime; a new channel never inherits an old global cutoff.
    this.store.exec(
      'INSERT OR IGNORE INTO discord_cursors(channel_id,message_id) VALUES(?,?)',
      session.channel_id,
      String(
        (BigInt(
          Math.max(
            1420070400000,
            session.created_at - this.config.discord.newConversationLookbackMs,
          ),
        ) -
          1420070400000n) <<
          22n,
      ),
    );
    const cursor = this.store.get<{ message_id: string }>(
      'SELECT message_id FROM discord_cursors WHERE channel_id=?',
      session.channel_id,
    )!.message_id;
    try {
      const channel = await this.client.channels.fetch(session.channel_id);
      if (!channel?.isTextBased() || !('messages' in channel)) return;
      const newer: Message[] = [];
      let before: string | undefined;
      let reached = false;
      for (let page = 0; page < 10; page++) {
        if (this.closing) return;
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!batch.size) {
          reached = true;
          break;
        }
        const sorted = [...batch.values()].sort((a, b) =>
          a.id === b.id ? 0 : BigInt(a.id) < BigInt(b.id) ? -1 : 1,
        );
        for (const message of sorted) {
          if (BigInt(message.id) <= BigInt(cursor)) reached = true;
          else newer.push(message);
        }
        if (reached || batch.size < 100) {
          reached = true;
          break;
        }
        before = sorted[0]!.id;
      }
      for (const message of newer.sort((a, b) => a.createdTimestamp - b.createdTimestamp))
        await this.onMessage(message, false);
      if (newer.length) {
        const latest = newer.reduce((a, b) => (BigInt(a.id) > BigInt(b.id) ? a : b)).id;
        this.store.exec(
          'INSERT INTO discord_cursors(channel_id,message_id) VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET message_id=excluded.message_id',
          session.channel_id,
          latest,
        );
      }
      if (!reached)
        this.store.outbox(
          session.id,
          'More than 1,000 Discord messages arrived during downtime. Clawstrum recovered the latest 1,000; earlier missed requests may need to be sent again.',
          { key: `backfill:${session.id}:${cursor}` },
        );
    } catch (error) {
      this.report(error);
    }
  }
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.track(this.doTick());
  }
  private async doTick(): Promise<void> {
    if (this.connected && !this.recovering && Date.now() - this.lastRecovery > 60000)
      void this.backfill().catch((e) => this.report(e));
    await this.delivery.tick();
    if (this.typingBusy || Date.now() - this.lastTyping < 8000) return;
    this.typingBusy = true;
    this.lastTyping = Date.now();
    try {
      await Promise.allSettled(
        [...this.engine.active.keys()].map(async (id) => {
          const channel = await this.client.channels.fetch(this.store.session(id).channel_id);
          if (channel?.isTextBased() && 'sendTyping' in channel) await channel.sendTyping();
        }),
      );
    } finally {
      this.typingBusy = false;
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.connected = false;
    // destroy() is asynchronous. Wait for it and already accepted handlers before
    // the caller closes SQLite, and never race multiple destroy calls.
    this.closePromise = Promise.allSettled([
      Promise.resolve().then(() => this.client.destroy()),
      ...this.pending,
      ...(this.recovering ? [this.recovering] : []),
    ]).then((results) => {
      const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
      if (errors.length) throw new AggregateError(errors, 'Discord cleanup failed');
    });
    return this.closePromise;
  }
}
