import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { flags, init, login, doctor, type DoctorCheck, type InitIO } from './cli-main.js';
import { loadEnv, readConfig, saveConfig, type Config } from './config.js';
import { Store } from './store.js';
import { writePrivate } from './files.js';
import { ensureMainChannelGuide, ensureReviewChannelGuide } from './memory.js';
import { ensureReviewTask, reviewTaskId } from './review.js';
import { hostTimeZone } from './context.js';
import { storagePolicy } from './storage.js';
import { runtimeCommand } from './runtime.js';
import { accountEnvironment } from './providers.js';
import { geminiLoginProbe } from './gemini-acp.js';
import type { Account } from './types.js';

export interface SetupIO extends InitIO {
  askSecret?: (prompt: string) => Promise<string>;
  print?: (line: string) => void;
  /** Runs the `clawstrum doctor` checks; tests replace it to avoid probing provider runtimes. */
  doctor?: (home: string) => Promise<DoctorCheck[]>;
  /** Used for the Discord check in step 8; tests replace it. */
  fetch?: typeof fetch;
}

export const SETUP_USAGE = `Usage: clawstrum setup [options]

Guided first-time setup in 8 steps. Run it again to resume; finished steps are skipped.

  --name NAME              Agent name (1 to 40 characters)
  --provider PROVIDER      Model provider: claude, codex or gemini
  --application-id ID      Discord Application ID; setup prints the invite link from it
  --token-file FILE        Read the Discord bot token from FILE
  --owner ID               Your Discord user ID
  --guild ID               Discord server ID (Discord's API calls a server a "guild")
  --channel ID             Discord channel ID
  --no-login               Do not log in to the provider
  --yes                    Ask nothing: take the values above from flags and do not log in
  --reconfigure            Ask again for agent name, provider and Discord IDs and change only
                           those in an existing config.json
  --status                 Print where setup stands as JSON (implies --json), with the next
                           step and a hint; asks nothing and writes nothing
  --main-channel NAME      Use the text channel NAME in the bot's server as the main channel,
                           creating it if the bot may; writes or updates config.json without
                           asking, and schedules the nightly self-review there unless
                           config.json has another review channel. The owner is config.json's,
                           else --owner, else the server owner. With --guild, --owner,
                           --provider, --name and --json
  --add-channel NAME       Find or create the project channel NAME in config.json's server and
                           add it to the end of discord.channelIds; the running agent picks it
                           up within seconds. Needs a config.json
  --json                   With --status, --main-channel or --add-channel: print JSON
  -h, --help               Show this help`;

const STEPS = 8;
const DEFAULT_NAME = 'Clawstrum';
const TOKEN_KEY = 'DISCORD_BOT_TOKEN';
const PROGRESS_FILE = '.setup-progress.json';
const NFS_MAGIC = 0x6969;
const NETWORK_FS =
  /^(nfs4?|lustre|gpfs|cifs|smb3?|smbfs|ceph|beegfs|9p|afs|panfs|wekafs|fuse\.(sshfs|glusterfs))$/;

const MANAGE_CHANNELS = 1n << 4n;
const VIEW_CHANNELS = 1n << 10n;
const ADD_REACTIONS = 1n << 6n;
const SEND_MESSAGES = 1n << 11n;
const ATTACH_FILES = 1n << 15n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const CREATE_PUBLIC_THREADS = 1n << 35n;
const SEND_MESSAGES_IN_THREADS = 1n << 38n;
export const INVITE_PERMISSIONS =
  MANAGE_CHANNELS |
  VIEW_CHANNELS |
  ADD_REACTIONS |
  SEND_MESSAGES |
  ATTACH_FILES |
  READ_MESSAGE_HISTORY |
  CREATE_PUBLIC_THREADS |
  SEND_MESSAGES_IN_THREADS;

export function inviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}`;
}

const isDiscordId = (value: string) => /^\d{17,20}$/.test(value);
const isTokenShape = (value: string) =>
  value.length >= 50 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);

async function defaultAsk(prompt: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await input.question(prompt)).trim();
  } finally {
    input.close();
  }
}

async function defaultAskSecret(prompt: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const input = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
  try {
    const answer = input.question(prompt);
    muted = true;
    return (await answer).trim();
  } finally {
    input.close();
    process.stdout.write('\n');
  }
}

function onPath(executable: string): boolean {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      fs.accessSync(path.join(directory, executable), fs.constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

export function readEnvToken(file: string): string {
  if (!fs.existsSync(file)) return '';
  // The last assignment wins, as in Node's process.loadEnvFile, which the daemon uses.
  let token = '';
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = new RegExp(`^\\s*(?:export\\s+)?${TOKEN_KEY}\\s*=\\s*(.*)$`).exec(line);
    if (match) token = match[1]!.trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return token;
}

function writeEnvToken(file: string, token: string): void {
  const lines = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')
    : ['# Discord bot token; do not commit this file.'];
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${TOKEN_KEY}\\s*=`);
  const last = lines.findLastIndex((line) => pattern.test(line));
  if (last >= 0) lines[last] = `${TOKEN_KEY}=${token}`;
  else lines.push(`${TOKEN_KEY}=${token}`);
  // Exactly one token line, so no reader can pick up a stale one.
  const kept = lines.filter((line, index) => index >= last || !pattern.test(line));
  writePrivate(file, kept.join('\n') + '\n');
  fs.chmodSync(file, 0o600);
}

function readRawConfig(home: string): Record<string, any> | undefined {
  const file = path.join(home, 'config.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
}

/** Save the name (also what Discord mentions are matched against) and put it into AGENTS.md where the shipped template still says Clawstrum. */
function applyName(home: string, name: string): void {
  const raw = readRawConfig(home)!;
  const old: string = raw.name || DEFAULT_NAME;
  raw.name = name;
  saveConfig(home, raw);
  const file = path.join(home, 'AGENTS.md');
  if (name === old || !fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const escaped = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Function replacements, so a "$" in the name is not read as a replacement pattern.
  const renamed = text
    .replace(new RegExp(`^# ${escaped}$`, 'm'), () => `# ${name}`)
    .replace(`You are ${old}`, () => `You are ${name}`);
  if (renamed !== text) fs.writeFileSync(file, renamed);
}

function nearestExisting(file: string): string {
  let directory = path.resolve(file);
  while (!fs.existsSync(directory) && path.dirname(directory) !== directory)
    directory = path.dirname(directory);
  return directory;
}

/** File system type of the mount holding `directory`, from the Linux mount table; undefined elsewhere. */
export function mountType(directory: string, mounts?: string): string | undefined {
  let table: string;
  try {
    table = mounts ?? fs.readFileSync('/proc/self/mounts', 'utf8');
  } catch {
    return undefined;
  }
  const real = mounts === undefined ? fs.realpathSync(directory) : directory;
  let best: { point: string; type: string } | undefined;
  for (const line of table.split('\n')) {
    const [, rawPoint, type] = line.split(' ');
    if (!rawPoint || !type || type === 'autofs') continue;
    const point = rawPoint.replace(/\\([0-7]{3})/g, (_, octal) =>
      String.fromCharCode(parseInt(octal, 8)),
    );
    const inside = point === '/' || real === point || real.startsWith(point + '/');
    // Later lines with the same mount point are mounted on top, so >= keeps the last one.
    if (inside && (!best || point.length >= best.point.length)) best = { point, type };
  }
  return best?.type;
}

/** Fail with a plain message instead of a raw EACCES, and warn once when the home is on a network file system. */
function prepareHome(home: string, print: (line: string) => void): void {
  const existing = nearestExisting(home);
  const cannotWrite = () =>
    new Error(
      `Cannot create or write the Clawstrum home folder ${home}. Set CLAWSTRUM_HOME to a folder you can write to and run clawstrum setup again.`,
    );
  try {
    fs.accessSync(existing, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw cannotWrite();
  }
  try {
    const type = mountType(existing) ?? (fs.statfsSync(existing).type === NFS_MAGIC ? 'nfs' : '');
    if (NETWORK_FS.test(type))
      print(
        `Warning: ${home} is on ${type}, a network file system. The SQLite database there can lock up or become corrupt. Set CLAWSTRUM_HOME to a folder on a local disk.`,
      );
  } catch {
    // The mount table and statfs are not available everywhere; the check is only advice.
  }
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  } catch {
    throw cannotWrite();
  }
}

function patchConfig(home: string, change: (raw: Record<string, any>) => void): void {
  const raw = readRawConfig(home)!;
  change(raw);
  saveConfig(home, raw);
}

/** Node 22.13 runs Clawstrum; live database backups and the nightly self-review need 22.16. */
export function nodeSupport(version = process.versions.node): {
  ok: boolean;
  nightlyReviewOk: boolean;
} {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  const atLeast = (wanted: number) => major > 22 || (major === 22 && minor >= wanted);
  return { ok: atLeast(13), nightlyReviewOk: atLeast(16) };
}

const NODE_REVIEW_WARNING = `The nightly self-review and live database backups need Node.js 22.16 or newer; this is ${process.version}.`;

function findSbatch(raw: Record<string, any> | undefined): boolean {
  const configured: string = raw?.research?.slurm?.commands?.sbatch ?? 'sbatch';
  if (!path.isAbsolute(configured)) return onPath(configured);
  try {
    fs.accessSync(configured, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Write a new config.json, AGENTS.md, .env and skills/ with init, then the name, Application ID and Slurm choice. */
async function createConfig(
  home: string,
  options: {
    owner: string;
    guild?: string;
    channel?: string;
    provider: string;
    name: string;
    applicationId?: string;
    hasSlurm: boolean;
    print: (line: string) => void;
  },
): Promise<void> {
  const { owner, guild, channel, provider, name, applicationId, hasSlurm, print } = options;
  await init(
    home,
    [
      '--owner',
      owner,
      ...(guild ? ['--guild', guild] : []),
      ...(channel ? ['--channel', channel] : []),
      '--provider',
      provider,
    ],
    { isInteractive: false, print: () => {} },
  );
  applyName(home, name);
  if (applicationId)
    patchConfig(home, (r) => {
      r.discord.applicationId = applicationId;
    });
  // Only for a config.json created here; an existing one keeps the user's Slurm choice.
  if (!hasSlurm) {
    patchConfig(home, (r) => {
      r.research ??= {};
      r.research.slurm ??= {};
      r.research.slurm.enabled = false;
    });
    print('Slurm helpers are turned off in config.json (research.slurm.enabled: false).');
    print(
      'If sbatch only appears after a module load, set research.slurm.enabled to true, or research.slurm.commands.sbatch to its full path.',
    );
  }
  fs.rmSync(path.join(home, PROGRESS_FILE), { force: true });
  print(`Created ${home}`);
}

function doctorLine(c: DoctorCheck): string {
  return `${c.ok ? 'ok  ' : c.warn ? 'WARN' : 'FAIL'} ${c.check}${c.ok ? '' : `: ${c.detail}`}`;
}

/** Ask Discord whether the token works and the bot can see the configured server and channels. Never prints the token. */
async function discordLines(
  token: string,
  config: Config,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const get = (route: string) =>
    fetchImpl(`https://discord.com/api/v10${route}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10000),
    });
  const lines: string[] = [];
  try {
    const guilds = await get('/users/@me/guilds');
    if (guilds.status === 401)
      return [
        'FAIL Discord bot token: Discord rejected the bot token. Copy a new one with Reset Token and run clawstrum setup again',
      ];
    if (!guilds.ok) return [`WARN Discord: Discord answered ${guilds.status}, skipped`];
    lines.push('ok   Discord bot token');
    const ids = ((await guilds.json()) as { id: string }[]).map((g) => g.id);
    const guildId = config.discord.guildId;
    if (guildId && ids.includes(guildId)) lines.push(`ok   Discord server ${guildId}`);
    else if (guildId) {
      lines.push(
        `WARN Discord server ${guildId}: the bot is not in server ${guildId} yet: open the invite link`,
      );
      if (config.discord.applicationId)
        lines.push(`     ${inviteUrl(config.discord.applicationId)}`);
    }
    for (const channel of config.discord.channelIds) {
      const response = await get(`/channels/${channel}`);
      if (response.ok) lines.push(`ok   Discord channel ${channel}`);
      else if (response.status === 403 || response.status === 404)
        lines.push(`WARN Discord channel ${channel}: the bot cannot see channel ${channel}`);
      else lines.push(`WARN Discord channel ${channel}: Discord answered ${response.status}`);
    }
    return lines;
  } catch {
    return [...lines, 'WARN Discord: could not reach Discord, skipped'];
  }
}

/**
 * The environment the daemon has after loadEnv(home), without changing process.env: a Claude token
 * kept in .env (tokenEnv) counts, and a variable already set wins as in process.loadEnvFile.
 */
function homeEnvironment(home: string): NodeJS.ProcessEnv {
  try {
    return { ...parseEnv(fs.readFileSync(path.join(home, '.env'), 'utf8')), ...process.env };
  } catch {
    return process.env;
  }
}

async function signedIn(account: Account, config: Config, home: string): Promise<boolean> {
  try {
    const env = accountEnvironment(account, config.accounts, homeEnvironment(home));
    if (account.provider === 'gemini') return (await geminiLoginProbe(account, env)).ok;
    const runtime = runtimeCommand(account);
    const args = account.provider === 'codex' ? ['login', 'status'] : ['auth', 'status'];
    const result = spawnSync(runtime.command, [...runtime.args, ...args], {
      env,
      encoding: 'utf8',
      timeout: 20000,
    });
    return (
      result.status === 0 &&
      (account.provider !== 'codex' || !/api key/i.test(result.stdout + result.stderr))
    );
  } catch {
    return false;
  }
}

async function defaultDoctor(home: string): Promise<DoctorCheck[]> {
  loadEnv(home);
  const config = readConfig(home);
  const store = new Store(home);
  let result: DoctorCheck[] = [];
  try {
    await doctor(config, store, false, (checks) => {
      result = checks;
    });
  } finally {
    store.close();
  }
  return result;
}

const ADMINISTRATOR = 1n << 3n;
const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);

function canManageChannels(permissions: string | undefined): boolean {
  try {
    return (BigInt(permissions ?? '0') & (MANAGE_CHANNELS | ADMINISTRATOR)) !== 0n;
  } catch {
    return false;
  }
}

function discordApi(token: string, fetchImpl: typeof fetch) {
  return (route: string, body?: unknown) =>
    fetchImpl(`https://discord.com/api/v10${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
}

function readProgress(home: string): { name?: string; provider?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, PROGRESS_FILE), 'utf8'));
  } catch {
    return {};
  }
}

interface GuildStatus {
  id: string;
  name: string;
  ownerId?: string;
  ownerName?: string;
  canManageChannels: boolean;
  textChannels: { id: string; name: string }[];
}

interface DiscordStatus {
  reachable: boolean;
  tokenAccepted: boolean;
  bot?: { id: string; username: string };
  applicationId?: string;
  messageContentIntent?: boolean;
  inviteUrl?: string;
  guilds?: GuildStatus[];
}

/** What the bot token shows about the bot, its application and its servers. Never includes the token. */
async function discordStatus(token: string, fetchImpl: typeof fetch): Promise<DiscordStatus> {
  const call = discordApi(token, fetchImpl);
  const json = async (route: string): Promise<any> => {
    try {
      const response = await call(route);
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  };
  let me: Response;
  try {
    me = await call('/users/@me');
  } catch {
    return { reachable: false, tokenAccepted: false };
  }
  if (me.status === 401) return { reachable: true, tokenAccepted: false };
  if (!me.ok) return { reachable: false, tokenAccepted: false };
  const user = (await me.json()) as { id: string; username: string };
  const result: DiscordStatus = {
    reachable: true,
    tokenAccepted: true,
    bot: { id: user.id, username: user.username },
  };
  const application = await json('/oauth2/applications/@me');
  if (application?.id) result.applicationId = String(application.id);
  if (typeof application?.flags === 'number')
    result.messageContentIntent = (application.flags & MESSAGE_CONTENT_FLAGS) !== 0;
  // A bot user has the same ID as its application.
  result.inviteUrl = inviteUrl(result.applicationId ?? user.id);
  const guilds = await json('/users/@me/guilds');
  if (Array.isArray(guilds)) {
    result.guilds = [];
    for (const g of guilds as { id: string; name: string; permissions?: string }[]) {
      const guild = await json(`/guilds/${g.id}`);
      const channels = await json(`/guilds/${g.id}/channels`);
      const owner = guild?.owner_id ? await json(`/users/${guild.owner_id}`) : undefined;
      const ownerName = owner?.global_name || owner?.username;
      result.guilds.push({
        id: g.id,
        name: g.name,
        ...(guild?.owner_id ? { ownerId: String(guild.owner_id) } : {}),
        ...(ownerName ? { ownerName: String(ownerName) } : {}),
        canManageChannels: canManageChannels(g.permissions),
        textChannels: Array.isArray(channels)
          ? channels
              .filter((c: { type: number }) => c.type === 0)
              .map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }))
          : [],
      });
    }
  }
  return result;
}

/** Whether the nightly self-review task for the channel is active; opens the database read-only, never creates it. */
function reviewTaskActive(home: string, channelId: string): boolean {
  try {
    const file = path.join(storagePolicy(home).directory, 'clawstrum.db');
    if (!fs.existsSync(file)) return false;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare('SELECT status FROM tasks WHERE id=?').get(reviewTaskId(channelId)) as
        | { status: string }
        | undefined;
      return row?.status === 'active';
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** `clawstrum setup --status`: where setup stands, as JSON. Asks nothing and writes nothing. */
export async function setupStatus(
  home: string,
  io: SetupIO = {},
): Promise<Record<string, unknown>> {
  const raw = readRawConfig(home);
  const envFile = path.join(home, '.env');
  const token = readEnvToken(envFile);
  const looksValid = !!token && isTokenShape(token);
  const discord = token ? await discordStatus(token, io.fetch ?? fetch) : null;
  const channelId: string | undefined = raw?.discord?.channelIds?.[0];
  let mainChannel: { id: string; name?: string; guildId?: string } | null = null;
  if (channelId) {
    const guild = discord?.guilds?.find((g) => g.textChannels.some((c) => c.id === channelId));
    const name = guild?.textChannels.find((c) => c.id === channelId)?.name;
    const guildId: string | undefined = guild?.id ?? raw?.discord?.guildId;
    mainChannel = { id: channelId, ...(name ? { name } : {}), ...(guildId ? { guildId } : {}) };
  }
  const reviewChannel: string | null = raw?.review?.channelId ?? null;
  const review = {
    channelId: reviewChannel,
    scheduled: !!reviewChannel && reviewTaskActive(home, reviewChannel),
  };
  let login: { account: string; provider: string; signedIn: boolean } | null = null;
  if (raw)
    try {
      const config = readConfig(home);
      const account = config.accounts.find((a) => a.id === 'main') ?? config.accounts[0];
      if (account)
        login = {
          account: account.id,
          provider: account.provider,
          signedIn: await signedIn(account, config, home),
        };
    } catch {
      // An invalid config.json leaves login unknown; clawstrum doctor names the problem.
    }

  const paste = `paste it into ${envFile} after ${TOKEN_KEY}= (create the file if it is missing)`;
  const portal = 'https://discord.com/developers/applications';
  let next: string;
  let hint: string;
  if (!token) {
    next = 'save-token';
    hint = `No bot token saved. On the Bot page of your application at ${portal}, click Reset Token, copy the token and ${paste}.`;
  } else if (!looksValid) {
    next = 'save-token';
    hint = `The saved token does not look like a bot token (three parts separated by dots). On the Bot page of your application at ${portal}, click Reset Token, copy the token and ${paste}.`;
  } else if (discord?.reachable && !discord.tokenAccepted) {
    next = 'save-token';
    hint = `Discord rejected the saved token. On the Bot page of your application at ${portal}, click Reset Token, copy the new token and ${paste}.`;
  } else if (discord?.messageContentIntent === false) {
    next = 'message-content-intent';
    hint = `On the Bot page at ${portal}/${discord.applicationId}/bot, turn on Message Content Intent under Privileged Gateway Intents and click Save Changes.`;
  } else if (discord?.guilds && discord.guilds.length === 0) {
    next = 'invite-bot';
    hint = `The bot is in no server yet. Open this link, choose your server and click Authorize: ${discord.inviteUrl}`;
  } else if (!raw || !channelId) {
    next = 'main-channel';
    const guildFlag = (discord?.guilds?.length ?? 0) > 1 ? ' --guild ID' : '';
    const providerFlag =
      !raw && !readProgress(home).provider ? ' --provider claude|codex|gemini' : '';
    hint = `Run clawstrum setup --main-channel NAME${guildFlag}${providerFlag}. It uses the text channel NAME in your server, or creates it when the bot may manage channels, and ${raw ? 'makes it the main channel in config.json' : 'writes config.json'}.${guildFlag ? ' The bot is in several servers; pick one from discord.guilds.' : ''}`;
  } else if (login && !login.signedIn) {
    next = 'login';
    hint =
      login.provider === 'gemini'
        ? `Log in to gemini: run clawstrum account login ${login.account}. It runs agy acp --login, which prints a link: open it in any browser, sign in with the Google account that has the Gemini subscription, and paste the code back.`
        : `Log in to ${login.provider}: run clawstrum account login ${login.account}${login.provider === 'codex' ? ' --device' : ''} and follow its instructions.`;
  } else {
    next = 'start';
    hint =
      'Run clawstrum start. On a new installation your agent then writes first in the main channel; otherwise send it a message there.';
  }
  if (discord && !discord.reachable)
    hint = `Could not reach Discord, so the Discord checks were skipped. ${hint}`;
  return {
    home,
    node: { version: process.version, ...nodeSupport() },
    config: {
      exists: !!raw,
      ...(raw
        ? {
            name: raw.name,
            provider: raw.accounts?.[0]?.provider,
            ownerIds: raw.discord?.ownerIds,
            guildId: raw.discord?.guildId,
            channelIds: raw.discord?.channelIds,
          }
        : {}),
    },
    token: { saved: !!token, looksValid },
    discord,
    mainChannel,
    review,
    login,
    next,
    hint,
  };
}

interface MainChannelReview {
  channelId: string;
  at: string;
  timezone: string;
  scheduled: boolean;
  reason?: string;
}

/**
 * Make `mainId` the first of discord.channelIds (and the server `guildId`, when given), put the
 * nightly self-review there unless config.json already has it in another channel, and write the
 * main channel and review sections into the channel's AGENTS.md. Safe to run again.
 */
function finishMainChannel(
  home: string,
  mainId: string,
  options: { guildId?: string; restartNote: boolean; say: (line: string) => void },
): MainChannelReview {
  const { guildId, restartNote, say } = options;
  const configFile = path.join(home, 'config.json');
  const current = readRawConfig(home)!;
  const currentIds: string[] = current.discord.channelIds ?? [];
  const channelIds = [mainId, ...currentIds.filter((id) => id !== mainId)];
  const otherReview: string | undefined =
    current.review?.channelId && current.review.channelId !== mainId
      ? current.review.channelId
      : undefined;
  const changes: string[] = [];
  if (guildId && current.discord.guildId !== guildId) changes.push(`server ${guildId}`);
  if (channelIds.join() !== currentIds.join())
    changes.push(`main channel ${mainId} first in discord.channelIds`);
  if (!otherReview && current.review?.channelId !== mainId)
    changes.push(`review.channelId ${mainId}`);
  if (changes.length) {
    if (guildId) current.discord.guildId = guildId;
    current.discord.channelIds = channelIds;
    if (!otherReview) current.review = { ...(current.review ?? {}), channelId: mainId };
    saveConfig(home, current);
    say(`Updated ${configFile}: ${changes.join(', ')}.`);
    if (restartNote) say('A running agent reads the change after: clawstrum restart request');
  }

  const config = readConfig(home);
  const review: MainChannelReview = {
    channelId: config.review.channelId!,
    at: config.review.at,
    timezone: config.runtime.timezone ?? hostTimeZone(),
    scheduled: !otherReview,
    ...(otherReview
      ? {
          reason: `review.channelId in config.json is ${otherReview}; the nightly self-review stays in that channel`,
        }
      : {}),
  };
  const store = new Store(home);
  try {
    const session = store.ensureSession(mainId);
    // The main channel section goes first, then the review guide.
    if (ensureMainChannelGuide(store, session.id))
      say(`Added the main channel guide to ${path.join(session.workspace, 'AGENTS.md')}.`);
    if (!otherReview) {
      ensureReviewChannelGuide(store, session.id);
      ensureReviewTask(store, mainId, review.at, review.timezone);
    }
  } finally {
    store.close();
  }
  say(
    otherReview
      ? `Nightly self-review: left in channel ${otherReview} (review.channelId in config.json).`
      : `Nightly self-review scheduled in this channel at ${review.at} (${review.timezone}).`,
  );
  return review;
}

interface GuildEntry {
  id: string;
  name: string;
  permissions?: string;
}

/** The channel name given to `--FLAG`, normalized the way Discord stores text channel names. */
function channelNameOption(options: Record<string, string>, flag: string): string {
  const given = options[flag];
  if (!given || given === 'true')
    throw new Error(`--${flag} needs a channel name, for example --${flag} main`);
  // Discord stores text channel names this way, so the lookup and the new channel agree.
  const channelName = given.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9_-]{1,100}$/.test(channelName))
    throw new Error('Channel name: use lowercase letters, digits, - or _ (for example main)');
  return channelName;
}

function savedToken(home: string): string {
  const envFile = path.join(home, '.env');
  const token = readEnvToken(envFile);
  if (!token)
    throw new Error(
      `No bot token saved. Paste it into ${envFile} after ${TOKEN_KEY}= and run this again.`,
    );
  if (!isTokenShape(token))
    throw new Error(
      `The token in ${envFile} does not look like a Discord bot token. Copy it again (Reset Token on the Bot page), paste it after ${TOKEN_KEY}= and run this again.`,
    );
  return token;
}

interface DiscordReader {
  request: (route: string, body?: unknown) => Promise<Response>;
  read: <T>(route: string) => Promise<T>;
}

/** Discord calls that fail with a plain message; never includes the token. */
function discordReader(home: string, token: string, io: SetupIO): DiscordReader {
  const envFile = path.join(home, '.env');
  const call = discordApi(token, io.fetch ?? fetch);
  const request = async (route: string, body?: unknown) => {
    try {
      return await call(route, body);
    } catch {
      throw new Error('Could not reach Discord. Check the network and run this again.');
    }
  };
  const read = async <T>(route: string): Promise<T> => {
    const response = await request(route);
    if (response.status === 401)
      throw new Error(
        `Discord rejected the bot token in ${envFile}. Click Reset Token on the Bot page, paste the new token after ${TOKEN_KEY}= and run this again.`,
      );
    if (!response.ok) throw new Error(`Discord answered ${response.status} to GET ${route}`);
    return (await response.json()) as T;
  };
  return { request, read };
}

/** The text channel `channelName` in `guild`, created with `topic` when missing and the bot may manage channels. */
async function findOrCreateTextChannel(
  api: DiscordReader,
  guild: GuildEntry,
  channelName: string,
  topic: string,
  say: (line: string) => void,
): Promise<{ channel: { id: string; name: string }; created: boolean }> {
  const channels = await api.read<{ id: string; name: string; type: number }[]>(
    `/guilds/${guild.id}/channels`,
  );
  const found = channels.find((c) => c.type === 0 && c.name.toLowerCase() === channelName);
  if (found) {
    say(`Found #${found.name} (${found.id}) in ${guild.name}.`);
    return { channel: found, created: false };
  }
  const cannot = new Error(
    `There is no text channel named ${channelName} in ${guild.name}, and the bot may not create channels there. Create a text channel named ${channelName} (click + next to Text Channels), then run this again.`,
  );
  if (!canManageChannels(guild.permissions)) throw cannot;
  const response = await api.request(`/guilds/${guild.id}/channels`, {
    name: channelName,
    type: 0,
    topic,
  });
  if (response.status === 403) throw cannot;
  if (!response.ok)
    throw new Error(`Discord answered ${response.status} when creating #${channelName}`);
  const channel = (await response.json()) as { id: string; name: string };
  say(`Created #${channel.name} (${channel.id}) in ${guild.name}.`);
  return { channel, created: true };
}

/** `clawstrum setup --add-channel NAME`: find or create a project channel and append it to discord.channelIds. */
async function setupAddChannel(
  home: string,
  options: Record<string, string>,
  io: SetupIO,
  print: (line: string) => void,
): Promise<void> {
  const json = options.json === 'true';
  const say = json ? () => {} : print;
  const channelName = channelNameOption(options, 'add-channel');
  const token = savedToken(home);
  const raw = readRawConfig(home);
  if (!raw)
    throw new Error(
      'There is no config.json yet. Set up the main channel first: clawstrum setup --main-channel NAME',
    );
  const guildId: string | undefined = raw.discord?.guildId;
  if (!guildId)
    throw new Error(
      'config.json has no server (discord.guildId). Set it with clawstrum setup --main-channel NAME --guild ID or clawstrum setup --reconfigure.',
    );
  const api = discordReader(home, token, io);
  const guild = (await api.read<GuildEntry[]>('/users/@me/guilds')).find((g) => g.id === guildId);
  if (!guild) {
    const applicationId: string | undefined = raw.discord?.applicationId;
    throw new Error(
      `The bot is not in server ${guildId} from config.json.${applicationId ? ` Open this link and add the bot to your server: ${inviteUrl(applicationId)}` : ''}`,
    );
  }
  const { channel, created } = await findOrCreateTextChannel(
    api,
    guild,
    channelName,
    `Project channel for ${raw.name || DEFAULT_NAME}.`,
    say,
  );
  const channelIds: string[] = raw.discord.channelIds ?? [];
  const added = !channelIds.includes(channel.id);
  if (added) {
    raw.discord.channelIds = [...channelIds, channel.id];
    saveConfig(home, raw);
  }
  const store = new Store(home);
  try {
    store.ensureSession(channel.id);
  } finally {
    store.close();
  }
  if (json)
    print(
      JSON.stringify(
        { channel: { id: channel.id, name: channel.name, guildId: guild.id }, created, added },
        null,
        2,
      ),
    );
  else
    print(
      added
        ? `Added #${channel.name} (${channel.id}) to discord.channelIds; the running agent picks it up within seconds.`
        : `Already configured: #${channel.name} (${channel.id}).`,
    );
}

/** `clawstrum setup --main-channel NAME`: find or create the main channel and make it the first channel in config.json. */
async function setupMainChannel(
  home: string,
  options: Record<string, string>,
  io: SetupIO,
  print: (line: string) => void,
): Promise<void> {
  const json = options.json === 'true';
  const say = json ? () => {} : print;
  const warnings: string[] = [];
  if (!nodeSupport().nightlyReviewOk) {
    warnings.push(NODE_REVIEW_WARNING);
    say(`WARN ${NODE_REVIEW_WARNING}`);
  }
  const channelName = channelNameOption(options, 'main-channel');
  const flagId = (flag: string): string | undefined => {
    const value = options[flag];
    if (value !== undefined && !isDiscordId(value))
      throw new Error(`--${flag} must be a Discord ID of 17 to 20 digits`);
    return value;
  };
  const guildFlag = flagId('guild');
  const ownerFlag = flagId('owner');
  if (options.provider && !['claude', 'codex', 'gemini'].includes(options.provider))
    throw new Error('--provider must be claude, codex or gemini');
  if (options.name !== undefined && (options.name.length > 40 || !options.name.trim()))
    throw new Error('--name must be 1 to 40 characters');

  const token = savedToken(home);
  const raw = readRawConfig(home);
  if (raw) {
    const differs = (flag: string, field: string) =>
      new Error(
        `--${flag} differs from ${field} in config.json. To change it, run clawstrum setup --reconfigure.`,
      );
    if (ownerFlag && !(raw.discord?.ownerIds ?? []).includes(ownerFlag))
      throw differs('owner', 'discord.ownerIds');
    if (options.provider && options.provider !== raw.accounts?.[0]?.provider)
      throw differs('provider', 'the provider of accounts[0]');
    if (options.name !== undefined && options.name !== (raw.name || DEFAULT_NAME))
      throw differs('name', 'name');
  }
  const progress = raw ? {} : readProgress(home);
  const provider: string | undefined = raw
    ? raw.accounts?.[0]?.provider
    : (options.provider ?? progress.provider);
  if (!raw && !provider)
    throw new Error(
      'There is no config.json yet: pass --provider claude, --provider codex or --provider gemini.',
    );
  const name: string = raw
    ? raw.name || DEFAULT_NAME
    : (options.name ?? progress.name ?? DEFAULT_NAME);

  const api = discordReader(home, token, io);
  const { read } = api;
  const guilds = await read<GuildEntry[]>('/users/@me/guilds');
  let applicationId: string | undefined;
  try {
    applicationId = String((await read<{ id: string }>('/oauth2/applications/@me')).id);
  } catch {
    applicationId = raw?.discord?.applicationId;
  }
  const invite = applicationId
    ? ` Open this link and add the bot to your server: ${inviteUrl(applicationId)}`
    : '';
  let guild: GuildEntry | undefined;
  if (guildFlag) {
    guild = guilds.find((g) => g.id === guildFlag);
    if (!guild) throw new Error(`The bot is not in server ${guildFlag}.${invite}`);
  } else if (guilds.length === 0) {
    throw new Error(`The bot is in no server yet.${invite} Then run this again.`);
  } else if (guilds.length > 1) {
    throw new Error(
      `The bot is in several servers; pass --guild ID with one of: ${guilds.map((g) => `${g.id} (${g.name})`).join(', ')}`,
    );
  } else guild = guilds[0]!;
  const configuredGuild: string | undefined = raw?.discord?.guildId;
  if (configuredGuild && configuredGuild !== guild.id && !guildFlag)
    throw new Error(
      `config.json has server ${configuredGuild}, but the bot's server is ${guild.id} (${guild.name}). Pass --guild ${guild.id} to switch config.json to it.`,
    );

  const { channel, created } = await findOrCreateTextChannel(
    api,
    guild,
    channelName,
    `Main channel: talk to ${name} about itself, its setup and your projects.`,
    say,
  );
  const mainId = channel.id;

  let ownerId: string;
  let ownerSource: 'config' | 'flag' | 'server-owner';
  let ownerName: string | undefined;
  if (raw?.discord?.ownerIds?.[0]) {
    ownerId = raw.discord.ownerIds[0];
    ownerSource = 'config';
  } else if (ownerFlag) {
    ownerId = ownerFlag;
    ownerSource = 'flag';
  } else {
    ownerId = (await read<{ owner_id: string }>(`/guilds/${guild.id}`)).owner_id;
    ownerSource = 'server-owner';
    try {
      const user = await read<{ username?: string; global_name?: string | null }>(
        `/users/${ownerId}`,
      );
      ownerName = user.global_name || user.username || undefined;
    } catch {
      // The name only helps the person recognise the account; the ID is what counts.
    }
    say(
      `Owner: ${ownerId}${ownerName ? ` (${ownerName})` : ''}, the owner of server ${guild.name}. Only this Discord user can talk to the agent; if that is not you, set your own ID in discord.ownerIds in config.json.`,
    );
  }

  const configFile = path.join(home, 'config.json');
  let configCreated = false;
  if (!raw) {
    prepareHome(home, say);
    await createConfig(home, {
      owner: ownerId,
      guild: guild.id,
      channel: mainId,
      provider: provider!,
      name,
      applicationId,
      hasSlurm: findSbatch(undefined),
      print: say,
    });
    configCreated = true;
    say(`Created ${configFile} with owner ${ownerId} and main channel ${mainId}.`);
  }
  const review = finishMainChannel(home, mainId, {
    guildId: guild.id,
    restartNote: !configCreated,
    say,
  });
  if (json)
    print(
      JSON.stringify(
        {
          channel: { id: mainId, name: channel.name, guildId: guild.id },
          created,
          configCreated,
          ownerId,
          ownerSource,
          ...(ownerName ? { ownerName } : {}),
          review,
          warnings,
        },
        null,
        2,
      ),
    );
  else
    print(
      `Main channel: #${channel.name} (${mainId}). Start your agent with clawstrum start; on a new installation it writes there first.`,
    );
}

export async function setup(home: string, args: string[], io: SetupIO = {}): Promise<void> {
  const print = io.print ?? ((line: string) => console.log(line));
  if (args.includes('--help') || args.includes('-h')) {
    print(SETUP_USAGE);
    return;
  }
  const options = flags(args);
  if (args.includes('--status')) {
    print(JSON.stringify(await setupStatus(home, io), null, 2));
    return;
  }
  if (options['main-channel'] !== undefined && options['add-channel'] !== undefined)
    throw new Error('Use --main-channel or --add-channel, not both');
  if (options['main-channel'] !== undefined) {
    await setupMainChannel(home, options, io, print);
    return;
  }
  if (options['add-channel'] !== undefined) {
    await setupAddChannel(home, options, io, print);
    return;
  }
  const isInteractive = io.isInteractive ?? !!process.stdin.isTTY;
  const prompting = isInteractive && options.yes !== 'true';
  const ask = io.ask ?? defaultAsk;
  const askSecret = io.askSecret ?? defaultAskSecret;
  const step = (n: number, title: string) => print(`\nStep ${n} of ${STEPS}: ${title}`);
  const missing = (flag: string, what: string) =>
    new Error(`Missing ${flag}: ${what} is required when setup is not interactive`);
  const yesNo = async (prompt: string): Promise<boolean> => {
    if (!prompting) return true;
    for (;;) {
      const answer = (await ask(`${prompt} [Y/n] `)).toLowerCase();
      if (!answer || answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
    }
  };
  const askId = async (prompt: string, optional: boolean): Promise<string | undefined> => {
    for (;;) {
      const answer = await ask(prompt);
      if (!answer && optional) return undefined;
      if (isDiscordId(answer)) return answer;
      print('That does not look like a Discord ID (17 to 20 digits). Try again.');
    }
  };
  /** Enter keeps `current`; "none" clears it when there is one. */
  const askKeepId = async (prompt: string, current?: string): Promise<string | undefined> => {
    for (;;) {
      const answer = await ask(prompt);
      if (!answer) return current;
      if (current && /^none$/i.test(answer)) return undefined;
      if (isDiscordId(answer)) return answer;
      print('That does not look like a Discord ID (17 to 20 digits). Try again.');
    }
  };
  const flagId = (flag: string): string | undefined => {
    const value = options[flag];
    if (value !== undefined && !isDiscordId(value))
      throw new Error(`--${flag} must be a Discord ID of 17 to 20 digits`);
    return value;
  };
  const isApplicationId = (id: string | undefined) => !!id && id === applicationId;
  const applicationIdIsNotOwner =
    'That is the Application ID. Your user ID is a different number: right-click your name in the member list or on one of your messages (on a phone, long-press) and choose Copy User ID.';
  const askOwner = async (prompt: string, keep?: string): Promise<string> => {
    for (;;) {
      const answer = keep ? (await ask(prompt)) || keep : await ask(prompt);
      if (!isDiscordId(answer))
        print('That does not look like a Discord ID (17 to 20 digits). Try again.');
      else if (isApplicationId(answer)) print(applicationIdIsNotOwner);
      else return answer;
    }
  };
  prepareHome(home, print);
  const envFile = path.join(home, '.env');
  let raw = readRawConfig(home);
  const reconfigure = options.reconfigure === 'true' && !!raw;
  // Answers of a first run that stopped before config.json existed; deleted once it exists.
  const progressFile = path.join(home, PROGRESS_FILE);
  let progress: { name?: string; provider?: string; applicationId?: string } = {};
  try {
    if (!raw && fs.existsSync(progressFile))
      progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  } catch {
    // A damaged progress file only costs the defaults.
  }
  const remember = (patch: typeof progress) => {
    if (raw) return;
    Object.assign(progress, patch);
    fs.writeFileSync(progressFile, JSON.stringify(progress) + '\n');
  };

  step(1, 'Checks');
  const node = nodeSupport();
  if (!node.ok)
    throw new Error(
      `Clawstrum needs Node.js 22.13 or newer; this is ${process.version}. Install a newer Node and run clawstrum setup again.`,
    );
  print(`Node.js ${process.version}: ok`);
  if (!node.nightlyReviewOk) print(`WARN ${NODE_REVIEW_WARNING}`);
  try {
    await import('node:sqlite');
    print('node:sqlite: ok');
  } catch {
    throw new Error('node:sqlite cannot be loaded. Clawstrum needs it for its database.');
  }
  print(
    onPath('pdftotext')
      ? 'pdftotext: found (used to read PDF papers)'
      : 'pdftotext: not found (optional; used to read PDF papers, usually in the poppler-utils package)',
  );
  const hasSlurm = findSbatch(raw);
  print(
    hasSlurm
      ? 'sbatch: found (Slurm; lets the agent submit and watch cluster jobs)'
      : 'sbatch: not found (optional; only needed to submit and watch Slurm cluster jobs)',
  );
  if (raw && !hasSlurm && raw.research?.slurm?.enabled !== false)
    print(
      'config.json has Slurm helpers on, but sbatch is not found. If this machine has no Slurm, set research.slurm.enabled to false.',
    );
  if (raw && hasSlurm && raw.research?.slurm?.enabled === false)
    print('Slurm helpers are off in config.json. To use them, set research.slurm.enabled to true.');

  step(2, 'Agent name');
  let name: string;
  if (raw?.name && !reconfigure) {
    name = raw.name;
    print(`Already set: ${name}`);
  } else {
    const earlier: string | undefined = reconfigure ? raw!.name : progress.name;
    const fallback = earlier || DEFAULT_NAME;
    name = options.name ?? '';
    if (name && (name.length > 40 || !name.trim()))
      throw new Error('--name must be 1 to 40 characters');
    if (!name && !prompting) name = fallback;
    while (!name) {
      const answer =
        (await ask(
          `What should your agent be called? [${fallback}]${earlier ? ' (Enter keeps it)' : ''} `,
        )) || fallback;
      if (answer.length <= 40) name = answer;
      else print('Please use at most 40 characters.');
    }
    print(`Using ${name}`);
    if (raw) {
      applyName(home, name);
      raw = readRawConfig(home);
    } else remember({ name });
  }

  step(3, 'Model provider');
  let provider: string;
  const currentProvider: string | undefined = raw?.accounts?.[0]?.provider;
  const earlierProvider = reconfigure ? currentProvider : progress.provider;
  if (raw && !reconfigure) {
    provider = currentProvider!;
    print(`Already set: ${provider} (from config.json)`);
  } else {
    if (options.provider) {
      if (!['claude', 'codex', 'gemini'].includes(options.provider))
        throw new Error('--provider must be claude, codex or gemini');
      provider = options.provider;
    } else if (earlierProvider && !prompting) {
      provider = earlierProvider;
    } else {
      if (!prompting) throw missing('--provider', 'the model provider (claude, codex or gemini)');
      for (;;) {
        const answer =
          (
            await ask(
              `Which model provider do you use? claude (Claude Code subscription), codex (ChatGPT/Codex subscription) or gemini (Google subscription with Gemini)${earlierProvider ? ` [${earlierProvider}] (Enter keeps it)` : ''}: `,
            )
          ).toLowerCase() ||
          earlierProvider ||
          '';
        if (answer === 'claude' || answer === 'codex' || answer === 'gemini') {
          provider = answer;
          break;
        }
        print('Please type claude, codex or gemini.');
      }
    }
    print(`Using ${provider}`);
    remember({ provider });
    if (reconfigure && provider !== currentProvider) {
      patchConfig(home, (r) => {
        const main = r.accounts[0];
        if (main.home === `accounts/${main.id}/${main.provider}`)
          main.home = `accounts/${main.id}/${provider}`;
        main.provider = provider;
      });
      raw = readRawConfig(home);
    }
  }

  step(4, 'Discord application');
  const existingToken = readEnvToken(envFile);
  let applicationId: string | undefined = options['application-id'];
  if (applicationId !== undefined && !isDiscordId(applicationId))
    throw new Error('--application-id must be 17 to 20 digits');
  if (existingToken && !applicationId) {
    print('Already done: a bot token is saved, so the Discord application exists.');
    const known: string | undefined = raw?.discord?.applicationId ?? progress.applicationId;
    applicationId =
      prompting && (reconfigure || (!raw && !known))
        ? await askKeepId(
            known
              ? `Application ID [${known}] (Enter keeps it): `
              : 'Application ID, from General Information (Enter skips it; setup uses it for the invite link and to tell it apart from your user ID): ',
          )
        : known;
    applicationId ??= known;
    if (applicationId) {
      print('If the bot is not in your server yet, open this link and add it:');
      print(inviteUrl(applicationId));
    }
  } else {
    print('1. Open https://discord.com/developers/applications');
    print(`2. Click New Application and name it ${name}.`);
    print(
      '3. On the Bot page, under Privileged Gateway Intents, turn on Message Content Intent and save. Without it, clawstrum start fails with "disallowed intents".',
    );
    print(
      '4. On General Information, copy the Application ID. It is the same number as the OAuth2 "Client ID", not the Public Key.',
    );
    if (!applicationId && prompting) applicationId = await askId('Application ID: ', false);
    if (applicationId) {
      print('Open this link and add the bot to your server:');
      print(inviteUrl(applicationId));
    } else {
      print('No --application-id given, so no invite link. Pass it to print the link.');
    }
  }
  if (applicationId && !raw) remember({ applicationId });
  if (applicationId && raw && raw.discord?.applicationId !== applicationId) {
    patchConfig(home, (r) => {
      r.discord.applicationId = applicationId;
    });
    raw = readRawConfig(home);
  }

  step(5, 'Bot token');
  if (options['token-file']) {
    const token = fs.readFileSync(options['token-file'], 'utf8').trim();
    if (!isTokenShape(token))
      throw new Error(
        `The token in ${options['token-file']} does not look like a Discord bot token`,
      );
    writeEnvToken(envFile, token);
    print(`Saved the token from ${options['token-file']} to ${envFile}`);
  } else if (existingToken && (await yesNo('Keep the existing token?'))) {
    print(`Keeping the token already in ${envFile}`);
  } else {
    if (!prompting) throw missing('--token-file', 'the Discord bot token');
    print('On the Bot page of your application, click Reset Token and copy the new token.');
    print('Reset Token stops any bot already running on the old token.');
    print('It is not shown while you type or paste it.');
    for (;;) {
      const token = await askSecret('Bot token: ');
      if (isTokenShape(token)) {
        writeEnvToken(envFile, token);
        print(`Saved the token to ${envFile}`);
        break;
      }
      print('That does not look like a bot token (three parts separated by dots). Try again.');
    }
  }

  step(6, 'Discord IDs');
  const configFile = path.join(home, 'config.json');
  if (raw && !reconfigure) {
    print(`Already done: ${configFile} exists; not running init again.`);
    print('To change the name, provider or Discord IDs: clawstrum setup --reconfigure');
  } else {
    let owner = flagId('owner');
    let guild = flagId('guild');
    let channel = flagId('channel');
    if (isApplicationId(owner)) throw new Error(`--owner: ${applicationIdIsNotOwner}`);
    const currentOwner: string | undefined = raw?.discord?.ownerIds?.[0];
    const currentChannels: string[] = raw?.discord?.channelIds ?? [];
    // The main channel is first; a separate review channel, if any, is listed after it.
    const currentChannel: string | undefined = currentChannels[0];
    if (!owner && !prompting && !reconfigure) throw missing('--owner', 'your Discord user ID');
    if (prompting && (!owner || options.guild === undefined || options.channel === undefined)) {
      print(
        'Turn on Developer Mode: User Settings (gear icon) > Advanced (under App Settings) > Developer Mode.',
      );
      print(
        'To copy your user ID, right-click your name in the member list or on one of your messages (on a phone, long-press) and choose Copy User ID.',
      );
      print('Right-click a server icon or a channel name the same way to copy its ID.');
    }
    // On --reconfigure every question shows the current value as [X], Enter keeps it, "none" clears a server or channel.
    const currentGuild: string | undefined = raw?.discord?.guildId;
    if (!owner && prompting)
      owner = await askOwner(
        `Your Discord user ID${reconfigure && currentOwner ? ` [${currentOwner}] (Enter keeps it)` : ''}: `,
        reconfigure ? currentOwner : undefined,
      );
    const askGuild = prompting && options.guild === undefined;
    const askChannel = prompting && options.channel === undefined;
    if (askGuild)
      guild =
        reconfigure && currentGuild
          ? await askKeepId(
              `Server ID [${currentGuild}] (Enter keeps it; none = direct messages only): `,
              currentGuild,
            )
          : await askId(
              'Server ID (blank = direct messages only; the bot still has to be in a server you are in): ',
              true,
            );
    if (askChannel)
      channel =
        reconfigure && currentChannel
          ? await askKeepId(
              `Channel ID [${currentChannel}] (Enter keeps it; none = no channel): `,
              currentChannel,
            )
          : await askId('Channel ID (blank for DMs only): ', true);
    if (reconfigure) {
      let reviewMoved = false;
      patchConfig(home, (r) => {
        if (owner)
          r.discord.ownerIds = [
            owner,
            ...(r.discord.ownerIds ?? []).slice(1).filter((id: string) => id !== owner),
          ];
        if (guild) r.discord.guildId = guild;
        else if (askGuild) delete r.discord.guildId;
        if ((channel || askChannel) && channel !== currentChannel) {
          const rest = currentChannels.filter((c) => c !== currentChannel && c !== channel);
          r.discord.channelIds = channel ? [channel, ...rest] : rest;
          // A review in the old main channel moves with it; config.json requires it to be listed.
          if (currentChannel && r.review?.channelId === currentChannel) {
            if (channel) r.review.channelId = channel;
            else delete r.review.channelId;
            reviewMoved = true;
          }
        }
      });
      // Otherwise the old channel's review task stays active and keeps running there every night.
      if (reviewMoved && currentChannel) {
        const store = new Store(home);
        try {
          store.exec(
            "UPDATE tasks SET status='cancelled' WHERE id=?",
            reviewTaskId(currentChannel),
          );
        } finally {
          store.close();
        }
      }
      print(`Updated ${configFile}; everything else in it is unchanged.`);
      print('Restart the agent if it is running, so it reads the new settings.');
      if (channel && channel !== currentChannel)
        finishMainChannel(home, channel, { restartNote: false, say: print });
    } else {
      await createConfig(home, {
        owner: owner!,
        guild,
        channel,
        provider: provider!,
        name,
        applicationId,
        hasSlurm,
        print,
      });
      if (channel) finishMainChannel(home, channel, { restartNote: false, say: print });
    }
  }

  step(7, 'Log in');
  const config = readConfig(home);
  const account = config.accounts.find((a) => a.id === 'main');
  const later = (device: boolean) => `clawstrum account login main${device ? ' --device' : ''}`;
  let loginSkipped = false;
  if (!account) {
    print('No account called main in config.json; log in with clawstrum account login ID.');
  } else if (options['no-login'] === 'true') {
    print(`Skipped (--no-login). Later: ${later(false)}`);
    loginSkipped = true;
  } else if (options.yes === 'true') {
    print(`Skipped (--yes). Later: ${later(false)}`);
    loginSkipped = true;
  } else if (!isInteractive) {
    print(`Skipped (not interactive). Later: ${later(false)}`);
    loginSkipped = true;
  } else if (await signedIn(account, config, home)) {
    print(`Already logged in to ${account.provider}.`);
  } else if (await yesNo(`Log in to ${account.provider} now?`)) {
    const device =
      account.provider === 'codex' && !(await yesNo('Is there a web browser on this machine?'));
    try {
      await login(account, config, device);
      print('Logged in.');
    } catch (error) {
      print(`Login did not finish: ${error instanceof Error ? error.message : String(error)}`);
      print(`Run it later: ${later(device)}`);
    }
  } else {
    print(`Later: ${later(false)}`);
    loginSkipped = true;
  }

  step(8, 'Finish');
  const exitCode = process.exitCode;
  let checks: DoctorCheck[];
  try {
    checks = await (io.doctor ?? defaultDoctor)(home);
  } finally {
    process.exitCode = exitCode;
  }
  let failed = false;
  for (const c of checks) {
    if (!c.ok && loginSkipped && account && c.check === `${account.id} sign-in`) {
      print(
        `SKIP ${c.check}: you chose not to log in. Later: clawstrum account login ${account.id}`,
      );
      continue;
    }
    print(doctorLine(c));
    if (!c.ok && !c.warn) failed = true;
  }
  const token = readEnvToken(envFile);
  if (token)
    for (const line of await discordLines(token, config, io.fetch ?? fetch)) {
      if (line.startsWith('FAIL')) failed = true;
      print(line);
    }
  if (failed) print('Some checks above failed; fix them and run clawstrum doctor again.');
  print('Start your agent in the foreground:');
  print('  clawstrum start');
  print('Or, on Linux (systemd) only, run it as a user service:');
  print('  mkdir -p ~/.config/systemd/user');
  print('  clawstrum service > ~/.config/systemd/user/clawstrum.service');
  print('  systemctl --user daemon-reload');
  print('  systemctl --user enable --now clawstrum');
  print('  loginctl enable-linger $USER  # keeps the service running after you log out');
  print(
    'Then open your main channel: your agent writes there first, with a few ideas to make it yours. Answer it.',
  );
}
