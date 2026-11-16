import { maintenanceBudget } from './maintenance-budget.js';
import { noteClaim } from './research/claims.js';
import { researchTool, type ResearchTool } from './research/tools.js';
import fs from 'node:fs';
import { RuntimeProfiler } from './performance.js';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import {
  accountsReloader,
  channelReloader,
  configSchema,
  readConfig,
  saveConfig,
  stateHome,
  loadEnv,
  takeDiscordToken,
  applyShellCpuCap,
  type Config,
} from './config.js';
import { Store } from './store.js';
import { isDatabaseBusy } from './storage.js';
import { Engine } from './engine.js';
import { withShutdownDeadline } from './daemon-shutdown.js';
import { Discord, sessionStatus } from './discord.js';
import { acquireLock } from './lock.js';
import { AccountPool } from './accounts.js';
import { accountEnvironment } from './providers.js';
import { runtimeCommand, runtimeIdentity } from './runtime.js';
import { geminiArgs, geminiLaunchEnv, geminiLoginProbe, geminiStateDir } from './gemini-acp.js';
import { DEFAULT_AGENTS, readOptional, hostTimeZone } from './context.js';
import { ensureReviewTask } from './review.js';
import { ensureWelcome } from './welcome.js';
import { ensureReviewChannelGuide } from './memory.js';
import { memoryTemplate } from './memory.js';
import { migrateMemory } from './migration/memory-run.js';
import { usageReport } from './usage.js';
import { historyPage } from './history.js';
import { rankedHistory, indexHistory } from './decisions/history.js';
import { DecisionService } from './decisions/client.js';
import { addTask, listTasks, taskHistory } from './scheduler.js';
import { writePrivate } from './files.js';
import { supervisedProviders } from './supervisor.js';
import { testAccount, loginRefusal } from './account-test.js';
import {
  addAccount,
  editAccount,
  importRegistry,
  listAccounts,
  readSecretFromStdin,
  removeAccount,
  setToken,
} from './account-cli.js';
import { formatSwitchArgument } from './account-routing.js';
import { credentialSource } from './account-registry.js';
import { applyAccountReload } from './account-reload.js';
import { serviceUnit } from './service.js';
import { backupState, collectFiles } from './maintenance.js';
import { healthChecks, notifyHealth } from './health.js';
import type { Account } from './types.js';
import { workflowCommand } from './workflow-cli.js';
import { daemonReady, commitRestart } from './restart.js';
import { apply, rollback } from './apply.js';
import { confirmApply } from './boot-guard.js';
import { planNanoClaw, importNanoClaw, type NanoClawImportOptions } from './migration/nanoclaw.js';
import {
  createGroup,
  setGroupMembership,
  groupBoard,
  exportGroups,
  groupHistory,
  groupView,
  groups,
  getGroup,
  groupEntries,
  groupIssues,
  entryView,
  syncGroups,
} from './groups/store.js';
import { isTransientNetworkError, NetworkErrorBudget } from './network-errors.js';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { storagePolicy } from './storage.js';
import { Client, GatewayIntentBits } from 'discord.js';
import {
  collectDashboardData,
  renderDashboardPosts,
  syncDashboard,
  dashboardWatchedFiles,
  statDashboardFiles,
  dashboardStampsChanged,
  readDashboardSyncRequest,
  fulfillDashboardSyncRequest,
  type DashboardData,
  type DashboardReader,
  type DashboardStamps,
} from './dashboard.js';

const HELP = `Clawstrum 0.1.0 — autonomous agents, at home in Discord

clawstrum setup                  Guided first-time setup: Discord bot, token, IDs, login
clawstrum --version              Print the version
clawstrum init [--provider codex|claude|gemini --owner ID --channel ID --guild ID]
    [--review-channel ID --review-at HH:MM]  Recommended: a quiet channel for a nightly self-review
clawstrum doctor [--notify]
clawstrum research enable [--email CONTACT] [--slurm]
clawstrum research paper|citation|note|delegate|steer|cluster|status SESSION --input JSON_FILE
clawstrum start
clawstrum maintenance status
clawstrum account list | import [--move-tokens] [--force] | add ID codex|claude|gemini [--owner O --label L --model M --priority N --token-env VAR]
    | edit ID --FIELD VALUE | remove ID | set-token ID [--clear] (token read from stdin) | login ID [--device|--force]
    | test ID [--model M] | reset ID
clawstrum status [SESSION]
clawstrum switch SESSION ACCOUNT [--model M|default]  Set the conversation's account and model, no restart
clawstrum stop|resume|reset SESSION
clawstrum tasks list | history ID | add SESSION once|cron SCHEDULE PROMPT [--timezone ZONE] | cancel ID
clawstrum export SESSION [FILE]
clawstrum backup DIRECTORY       Snapshot state with the daemon stopped
clawstrum backup live DIRECTORY [--keep-last N --keep-days N]
clawstrum backup verify SNAPSHOT_DIRECTORY
clawstrum service backup --directory DIRECTORY [--output UNIT_DIRECTORY]
clawstrum service health [--interval-seconds N] [--output UNIT_DIRECTORY]
clawstrum restart request [--timeout-ms N] [--drain-ms N] [--wait] | status | cancel
clawstrum apply [--no-test]      Check, build and test this source checkout, then restart on it
clawstrum rollback               Restore the build from before the last apply and restart
clawstrum decisions lint FILE [--shared-target FILE]
clawstrum figures lint FILE
clawstrum prose lint FILE
clawstrum subagents profile [SESSION] [--since ISO_DATE] [--limit N] [--offset N]  (workers is an accepted alias)
clawstrum performance [SESSION] [--since ISO_DATE] [--limit N]
clawstrum usage profile [SESSION] [--day YYYY-MM-DD|today|yesterday] [--timezone ZONE] [--since ISO --until ISO] [--format json|markdown]
clawstrum jev profile [SESSION] [--since ISO_DATE] [--limit N] [--offset N]
clawstrum watch add SESSION --key KEY --input JSON | list [SESSION] | cancel ID
clawstrum review collect|pending [--from DAY --through DAY] [--config JSON] [--output DIRECTORY]
clawstrum review complete --date DAY --report FILE [--output DIRECTORY]
clawstrum review schedule --channel ID [--at HH:MM] [--timezone ZONE]  Turn on the nightly self-review
clawstrum gc --before DATE [--apply]  Preview or remove old transfer files offline
clawstrum memory migrate --apply [--channels-root DIR]
clawstrum group create ID --name NAME [--purpose TEXT] | join|leave ID SESSION [--role TEXT] | status [ID]
clawstrum group board SESSION --input JSON_FILE
clawstrum history SESSION --action list|search|read|rank [--query TEXT] [--id ID]
clawstrum history index          Incrementally backfill the local text index (no API calls)
clawstrum import nanoclaw BACKUP --groups-root DIR [--prefix P] [--source-root ROOT]...
    [--timezone ZONE] [--due-tasks reschedule|cancel|fire] [--apply]
    Print the mapping an offline NanoClaw import would create; --apply performs it
clawstrum retry-delivery SESSION
clawstrum smoke ACCOUNT          Run an authenticated provider smoke test
clawstrum dashboard sync [--print]  Post/update the config dashboard forum; --print renders to stdout, no Discord
clawstrum service                Print a systemd user service

Configuration and state: CLAWSTRUM_HOME (default ~/.clawstrum)
Full host access. No containers or per-tool approval prompts.
`;
/** The HELP entries for one command (an entry is its `clawstrum` line plus indented lines); all of HELP if none. */
export function commandHelp(command: string): string {
  const entries: string[][] = [];
  for (const line of HELP.split('\n')) {
    if (line.startsWith('clawstrum ')) entries.push([line]);
    else if (/^\s+\S/.test(line)) entries.at(-1)?.push(line);
  }
  const own = entries.filter((entry) =>
    entry[0]!.slice('clawstrum '.length).split(' ', 1)[0]!.split('|').includes(command),
  );
  return own.length ? own.flat().join('\n') : HELP;
}
export function flags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++)
    if (args[i]!.startsWith('--')) {
      const key = args[i]!.slice(2);
      result[key] = args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i]! : 'true';
    }
  return result;
}
function required(value: string | undefined, usage: string): string {
  if (!value) throw new Error(usage);
  return value;
}
/** Import has one positional backup and explicit valued options; never treat a missing value as a path. */
function importArguments(args: string[]) {
  let backup: string | undefined;
  let apply = false;
  const values: Record<string, string> = {};
  const sourceRoots: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!['groups-root', 'prefix', 'source-root', 'timezone', 'due-tasks'].includes(key))
        throw new Error(`Unknown import option: ${arg}`);
      const value = args[++i];
      if (value === undefined || value.startsWith('--') || (!value && key !== 'prefix'))
        throw new Error(`${arg} requires a value`);
      if (key === 'source-root') sourceRoots.push(value);
      else if (values[key] !== undefined) throw new Error(`Repeated import option: ${arg}`);
      else values[key] = value;
    } else {
      if (backup !== undefined) throw new Error('Import takes exactly one backup path');
      backup = arg;
    }
  }
  const dueTasks = values['due-tasks'] ?? 'reschedule';
  if (!['reschedule', 'cancel', 'fire'].includes(dueTasks))
    throw new Error('--due-tasks reschedule|cancel|fire');
  const options: NanoClawImportOptions = {
    prefix: values.prefix ?? '',
    sourceRoots,
    timezone: values.timezone ?? 'UTC',
    dueTasks: dueTasks as NanoClawImportOptions['dueTasks'],
  };
  return {
    backup: path.resolve(required(backup, 'import nanoclaw BACKUP --groups-root DIR')),
    groupsRoot: path.resolve(required(values['groups-root'], 'import requires --groups-root DIR')),
    apply,
    options,
  };
}
function importCommand(home: string, args: string[]): void {
  if (args[0] !== 'nanoclaw') throw new Error('import nanoclaw BACKUP --groups-root DIR');
  const { backup, groupsRoot, apply, options } = importArguments(args.slice(1));
  // Preview precedes config/credential loading and never constructs a writable Store.
  const plan = planNanoClaw(home, backup, groupsRoot, options);
  if (!apply) {
    console.log(JSON.stringify({ applied: false, plan }, null, 2));
    return;
  }
  if (plan.blockers.length) throw new Error(plan.blockers.join('; '));
  const unlock = acquireLock(home);
  let store: Store | undefined;
  try {
    store = new Store(home);
    console.log(
      JSON.stringify(
        { applied: true, ...importNanoClaw(store, backup, groupsRoot, options) },
        null,
        2,
      ),
    );
  } finally {
    store?.close();
    unlock();
  }
}
function printDashboard(data: DashboardData): void {
  for (const post of renderDashboardPosts(data)) {
    console.log(`=== ${post.title} ===`);
    console.log(post.summary);
    console.log('--- full text (attached as .md in Discord) ---');
    console.log(post.body);
    console.log();
  }
}
/** --print never loads credentials, opens a writable database or touches Discord: it reads
 * config.json and, if present, the database read-only (see workflow-cli.ts for the same pattern).
 * A real sync additionally needs the bot token and a live Discord connection.
 */
async function dashboardCommand(
  home: string,
  sub: string | undefined,
  args: string[],
): Promise<void> {
  if (sub !== 'sync') throw new Error('clawstrum dashboard sync [--print]');
  const config = readConfig(home);
  if (args.includes('--print')) {
    const dbFile = path.join(storagePolicy(home).directory, 'clawstrum.db');
    if (!fs.existsSync(dbFile)) {
      printDashboard(collectDashboardData(home, config));
      return;
    }
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const reader: DashboardReader = {
        get<T>(sql: string, ...params: SQLInputValue[]) {
          return db.prepare(sql).get(...params) as T | undefined;
        },
        all<T>(sql: string, ...params: SQLInputValue[]) {
          return db.prepare(sql).all(...params) as T[];
        },
      };
      printDashboard(collectDashboardData(home, config, reader));
    } finally {
      db.close();
    }
    return;
  }
  loadEnv(home);
  const token = takeDiscordToken(config);
  const store = new Store(home);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await client.login(token);
    const counts = await syncDashboard(client, store, config, home);
    console.log(
      counts
        ? `Dashboard synced: ${JSON.stringify(counts)}`
        : 'Dashboard disabled or its channel is unavailable; nothing synced.',
    );
  } finally {
    await client.destroy().catch(() => undefined);
    store.close();
  }
}
export interface InitIO {
  isInteractive?: boolean;
  ask?: (prompt: string) => Promise<string>;
  print?: (line: string) => void;
}
async function defaultAsk(prompt: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await input.question(prompt)).trim();
  } finally {
    input.close();
  }
}
export async function init(home: string, args: string[], io: InitIO = {}): Promise<void> {
  const file = path.join(home, 'config.json');
  if (fs.existsSync(file)) throw new Error(`Configuration already exists at ${file}`);
  const options = flags(args);
  let owner = options.owner;
  let channel = options.channel;
  let guild = options.guild;
  let provider = options.provider || 'codex';
  let reviewChannel = options['review-channel'];
  const reviewAt = options['review-at'] || '03:00';
  const isInteractive = io.isInteractive ?? !!process.stdin.isTTY;
  const ask = io.ask ?? defaultAsk;
  if (!owner && isInteractive) {
    owner = await ask('Your Discord user ID: ');
    guild = (await ask('Discord server ID (blank for DMs only): ')) || undefined;
    channel = (await ask('Discord channel ID (blank for DMs only): ')) || undefined;
    provider = (await ask('Provider [codex/claude/gemini, default codex]: ')) || 'codex';
  }
  if (!reviewChannel && isInteractive)
    reviewChannel =
      (await ask(
        'Discord channel ID for a nightly self-review of how the agent behaved (blank to skip): ',
      )) || undefined;
  const channelIds = channel ? [channel] : [];
  if (reviewChannel && !channelIds.includes(reviewChannel)) channelIds.push(reviewChannel);
  const config = configSchema.parse({
    version: 1,
    discord: {
      ownerIds: [required(owner, 'Pass --owner YOUR_DISCORD_USER_ID')],
      guildId: guild,
      channelIds,
    },
    ...(reviewChannel ? { review: { channelId: reviewChannel, at: reviewAt } } : {}),
    accounts: [{ id: 'main', provider, home: `accounts/main/${provider}` }],
  });
  saveConfig(home, config);
  if (!fs.existsSync(path.join(home, 'AGENTS.md'))) {
    const legacy = ['SELF.md', 'CLAUDE.md']
      .map((name) => path.join(home, name))
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n\n');
    fs.writeFileSync(
      path.join(home, 'AGENTS.md'),
      memoryTemplate(legacy || DEFAULT_AGENTS, path.join(home, 'history')),
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
  }
  if (!fs.existsSync(path.join(home, '.env')))
    fs.writeFileSync(
      path.join(home, '.env'),
      '# Discord bot token; do not commit this file.\nDISCORD_BOT_TOKEN=\n',
      { flag: 'wx', mode: 0o600 },
    );
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true, mode: 0o700 });
  const bundledSkills = fileURLToPath(new URL('../templates/skills/', import.meta.url));
  for (const entry of fs.readdirSync(bundledSkills, { withFileTypes: true })) {
    const destination = path.join(home, 'skills', entry.name);
    if (entry.isDirectory() && !fs.existsSync(destination))
      fs.cpSync(path.join(bundledSkills, entry.name), destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
  }
  if (reviewChannel) {
    const store = new Store(home);
    try {
      const session = store.ensureSession(reviewChannel);
      ensureReviewChannelGuide(store, session.id);
      ensureReviewTask(store, reviewChannel, reviewAt, config.runtime.timezone ?? hostTimeZone());
    } finally {
      store.close();
    }
  }
  const reviewNote = reviewChannel
    ? `A nightly self-review is scheduled in channel ${reviewChannel} at ${reviewAt} (${config.runtime.timezone ?? hostTimeZone()}). It starts reviewing once the daemon runs.\n`
    : `Recommended: make a quiet channel for a nightly self-review, then run clawstrum review schedule --channel ID.\n`;
  (io.print ?? console.log)(
    `Created ${home}\nSet DISCORD_BOT_TOKEN in ${path.join(home, '.env')}.\n${reviewNote}Then: clawstrum account login main\n      clawstrum doctor\n      clawstrum start`,
  );
}
function getAccount(config: Config, id: string | undefined): Account {
  const account = config.accounts.find((a) => a.id === id);
  if (!account)
    throw new Error('Specify an account: ' + config.accounts.map((a) => a.id).join(', '));
  return account;
}
export async function login(account: Account, config: Config, device: boolean): Promise<void> {
  fs.mkdirSync(account.home, { recursive: true, mode: 0o700 });
  if (account.provider === 'codex') {
    const file = path.join(account.home, 'config.toml');
    if (!fs.existsSync(file))
      fs.writeFileSync(
        file,
        'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\n',
        { mode: 0o600 },
      );
  }
  const runtime = runtimeCommand(account);
  // Antigravity CLI: `agy acp --login` signs in with Google in the terminal. It prints a link, you open
  // it in any browser (your laptop works), then paste the code or the page URL back. It saves the login
  // under <home>/.gemini, <home>/.config. --device is not needed: this flow never opens a browser.
  const args =
    account.provider === 'codex'
      ? ['login', ...(device ? ['--device-auth'] : [])]
      : account.provider === 'gemini'
        ? geminiArgs(account, ['--login'])
        : ['auth', 'login'];
  if (account.provider === 'gemini')
    console.log(
      `Antigravity CLI starts next. Open the link it prints, sign in with the Google account that has the subscription, then paste the code.\nThe login is saved in ${geminiStateDir(account)}.`,
    );
  let errorOutput = '';
  const code = await new Promise<number>((resolve, reject) => {
    const env = accountEnvironment(account, config.accounts);
    const child = spawn(runtime.command, [...runtime.args, ...args], {
      env: account.provider === 'gemini' ? geminiLaunchEnv(env, account) : env,
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      errorOutput = (errorOutput + chunk.toString('utf8')).slice(-16384);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  if (code !== 0) {
    const tail = errorOutput.trim().split(/\r?\n/).slice(-10).join('\n');
    throw new Error(`Login exited with code ${code}${tail ? `:\n${tail}` : ''}`);
  }
  if (account.provider === 'gemini') {
    const probe = await geminiLoginProbe(account, accountEnvironment(account, config.accounts));
    if (!probe.ok)
      throw new Error(
        `Antigravity CLI exited but the login is not usable (${probe.detail}). Run clawstrum account login ${account.id} again.`,
      );
  }
}
export interface DoctorCheck {
  check: string;
  ok: boolean;
  detail: string;
  /** A missing optional piece: shown, but not counted as a failure. */
  warn?: boolean;
}
export async function doctor(
  config: Config,
  store: Store,
  notify = false,
  report?: (checks: DoctorCheck[]) => void,
): Promise<void> {
  const checks: DoctorCheck[] = healthChecks(store, config);
  // Runs from a timer every few minutes: skip the integrity scan and the provider probes.
  if (notify) {
    const channel = config.discord.noticeChannelId;
    const token = process.env[config.discord.tokenEnv];
    if (!channel || !token)
      throw new Error(
        `doctor --notify needs discord.noticeChannelId and ${config.discord.tokenEnv}`,
      );
    await notifyHealth(store, checks, async (content) => {
      const response = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Discord returned ${response.status}`);
    });
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
    return;
  }
  checks.push({
    check: 'Discord token',
    ok: !!process.env[config.discord.tokenEnv],
    detail: `environment variable ${config.discord.tokenEnv}`,
  });
  checks.push({
    check: 'SQLite',
    ok: store.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check === 'ok',
    detail: 'database integrity',
  });
  if (config.research.enabled) {
    for (const executable of [
      config.research.pdftotext,
      ...(config.research.slurm.enabled ? Object.values(config.research.slurm.commands) : []),
    ]) {
      const probe = spawnSync(
        executable,
        [executable === config.research.pdftotext ? '-v' : '--version'],
        { encoding: 'utf8', timeout: 5000 },
      );
      checks.push({
        check: `Research executable: ${executable}`,
        ok: !probe.error && probe.status === 0,
        ...(executable === config.research.pdftotext &&
        (probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
          ? { warn: true }
          : {}),
        detail: probe.error
          ? probe.error.message
          : (probe.stdout + probe.stderr).trim().slice(0, 300),
      });
    }
  }
  for (const account of config.accounts) {
    try {
      const r = runtimeCommand(account);
      const env = accountEnvironment(account, config.accounts);
      const version = await runtimeIdentity(account, env);
      const blocked = config.runtime.blockedVersions.find(
        (v) => v.provider === account.provider && v.version === version.version,
      );
      checks.push({
        check: `${account.id} runtime`,
        ok: !blocked,
        detail: `${version.version}${blocked ? `; quarantined: ${blocked.reason}` : ''}`,
      });
      const authArgs = account.provider === 'codex' ? ['login', 'status'] : ['auth', 'status'];
      // Antigravity CLI has no auth status command; the probe asks it for a session (no model call).
      const auth =
        account.provider === 'gemini'
          ? await geminiLoginProbe(account, env).then((p) => ({
              status: p.ok ? 0 : 1,
              stdout: p.detail,
              stderr: '',
            }))
          : spawnSync(r.command, [...r.args, ...authArgs], {
              env,
              encoding: 'utf8',
              timeout: 20000,
            });
      const supportedAuth =
        account.provider !== 'codex' || !/api key/i.test(auth.stdout + auth.stderr);
      checks.push({
        check: `${account.id} sign-in`,
        ok: auth.status === 0 && supportedAuth,
        detail:
          auth.status === 0 && supportedAuth
            ? loginRefusal(account, false)
              ? `signed in with a token: ${credentialSource(account)}`
              : 'local login available'
            : loginRefusal(account, false)
              ? `run clawstrum account test ${account.id} (this account uses a token, not a login)`
              : `run clawstrum account login ${account.id}`,
      });
    } catch (error) {
      checks.push({ check: `${account.id} runtime`, ok: false, detail: String(error) });
    }
  }
  if (report) report(checks);
  else
    console.log(
      JSON.stringify(
        {
          checks,
          state: store.home,
          note: 'No Discord messages or model requests were sent. Claude subscription product availability is described in docs/subscriptions.md.',
        },
        null,
        2,
      ),
    );
  if (checks.some((c) => !c.ok && !c.warn)) process.exitCode = 1;
}
async function start(config: Config, store: Store): Promise<void> {
  if (store.get("SELECT key FROM metadata WHERE key='memory-layout-required'"))
    throw new Error(
      'Memory layout migration is required before starting. Back up state, then run clawstrum memory migrate --apply while the daemon is stopped; see docs/memory-lifecycle.md.',
    );
  const token = takeDiscordToken(config);
  applyShellCpuCap(config);
  const unlock = acquireLock(store.home);
  const engine = new Engine(config, store);
  const discord = new Discord(config, store, engine);
  const profiler = new RuntimeProfiler(store);
  // New Discord channels in config.json take effect without a restart.
  const reloadChannels = channelReloader(store.home, config);
  // Account changes (runtime/accounts.json or config.json accounts) take effect the same way.
  const reloadAccounts = accountsReloader(store.home, config);
  let timer: NodeJS.Timeout | undefined;
  let confirmTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let removeHandlers = () => {};
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= withShutdownDeadline(async () => {
      const results = await Promise.allSettled([engine.stop(), discord.close()]);
      const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
      if (errors.length) throw new AggregateError(errors, 'Daemon cleanup failed');
    }));
  let dashboardBusy = false;
  let nextDashboardSync = 0;
  let nextDashboardWatch = 0;
  let dashboardStamps: DashboardStamps = {};
  const runDashboardSync = () => {
    if (!config.discord.dashboard.enabled || dashboardBusy) return;
    dashboardBusy = true;
    void syncDashboard(discord.client, store, config, store.home)
      .catch((error) =>
        console.error(JSON.stringify({ event: 'dashboard_sync_error', error: String(error) })),
      )
      .finally(() => {
        dashboardBusy = false;
        nextDashboardSync = Date.now() + config.discord.dashboard.syncIntervalMs;
      });
  };
  // Cheap per-tick check: stat (never read) every file a sync would render from, and run a sync
  // now when one changed, instead of waiting out the rest of syncIntervalMs.
  const runDashboardWatch = () => {
    if (!config.discord.dashboard.enabled) return;
    const stamps = statDashboardFiles(dashboardWatchedFiles(store.home, config, store), store);
    const changed = dashboardStampsChanged(dashboardStamps, stamps);
    dashboardStamps = stamps;
    if (changed) runDashboardSync();
  };
  // dashboard_sync (mcp.ts) writes a request row; honor it even if the stat watch above finds
  // nothing changed on its own.
  const runPendingDashboardSyncRequest = () => {
    if (!config.discord.dashboard.enabled || dashboardBusy || !readDashboardSyncRequest(store))
      return;
    dashboardBusy = true;
    void fulfillDashboardSyncRequest(discord.client, store, config, store.home).finally(() => {
      dashboardBusy = false;
      nextDashboardSync = Date.now() + config.discord.dashboard.syncIntervalMs;
    });
  };
  try {
    await discord.connect(token);
    runDashboardSync();
    // Baseline the stamps against what the sync just started from, so the first watch tick does
    // not see every file as newly added and immediately trigger a redundant second sync.
    dashboardStamps = statDashboardFiles(dashboardWatchedFiles(store.home, config, store), store);
    nextDashboardWatch = Date.now() + config.discord.dashboard.watchIntervalMs;
    if (config.review.channelId)
      try {
        ensureReviewTask(
          store,
          config.review.channelId,
          config.review.at,
          config.runtime.timezone ?? hostTimeZone(),
        );
      } catch (error) {
        console.error(JSON.stringify({ event: 'review_task_failed', error: String(error) }));
      }
    try {
      if (ensureWelcome(store, config))
        console.log(
          JSON.stringify({ event: 'welcome_queued', channel: config.discord.channelIds[0] }),
        );
    } catch (error) {
      console.error(JSON.stringify({ event: 'welcome_failed', error: String(error) }));
    }
    engine.start();
    const instance = daemonReady(store, process.env.CLAWSTRUM_SUPERVISED === '1');
    engine.daemonInstance = instance.id;
    // An applied change counts as healthy once the daemon has run for a minute.
    confirmTimer = setTimeout(() => {
      try {
        confirmApply(store.home);
      } catch (error) {
        console.error(JSON.stringify({ event: 'apply_confirm_failed', error: String(error) }));
      }
    }, 60000).unref();
    console.log(
      JSON.stringify({ event: 'ready', name: config.name, version: '0.1.0', pid: process.pid }),
    );
    await new Promise<void>((resolve, reject) => {
      const stop = (error?: unknown, restart = false) => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        void cleanup().then(() => {
          if (restart) process.exitCode = 75;
          if (error) reject(error);
          else resolve();
        }, reject);
      };
      const signal = () => stop();
      const networkBudget = new NetworkErrorBudget();
      const fatal = (error: unknown) => {
        if (isTransientNetworkError(error) && networkBudget.allow()) {
          console.error(
            JSON.stringify({
              event: 'daemon_network_error',
              at: new Date().toISOString(),
              error: String(error),
            }),
          );
          return;
        }
        console.error(
          JSON.stringify({
            event: 'daemon_fatal',
            at: new Date().toISOString(),
            error: String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }),
        );
        stop(error);
      };
      process.once('SIGINT', signal);
      process.once('SIGTERM', signal);
      process.on('uncaughtException', fatal);
      process.on('unhandledRejection', fatal);
      removeHandlers = () => {
        process.off('SIGINT', signal);
        process.off('SIGTERM', signal);
        process.off('uncaughtException', fatal);
        process.off('unhandledRejection', fatal);
      };
      timer = setInterval(() => {
        try {
          const change = reloadChannels();
          if (change && (change.added.length || change.removed.length))
            console.log(
              JSON.stringify({
                event: 'channels_reloaded',
                at: new Date().toISOString(),
                ...change,
              }),
            );
        } catch (error) {
          console.error(JSON.stringify({ event: 'channels_reload_failed', error: String(error) }));
        }
        applyAccountReload(reloadAccounts, engine);
        try {
          profiler.measure('engine.tick', () => engine.tick());
          if (
            engine.draining &&
            commitRestart(
              store,
              instance.id,
              Date.now(),
              !engine.active.size &&
                !engine.researchWorkers.active.size &&
                !engine.maintenance.size &&
                !engine.consolidations.size &&
                !engine.watches.busy,
            )
          ) {
            console.log(JSON.stringify({ event: 'planned_restart', instance: instance.id }));
            stop(undefined, true);
            return;
          }
          store.exec(
            "INSERT INTO metadata(key,value) VALUES('heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            String(Date.now()),
          );
          profiler.flush(() => engine.performanceSnapshot());
        } catch (error) {
          if (isDatabaseBusy(error))
            console.error(
              JSON.stringify({
                event: 'database_busy',
                operation: 'daemon_tick',
                error: String(error),
              }),
            );
          else stop(error);
        }
        void discord
          .tick()
          .catch((error) =>
            console.error(JSON.stringify({ event: 'delivery_tick_error', error: String(error) })),
          );
        // The dashboard is a convenience view. A locked or failing database read here must not
        // stop the daemon: a busy read in dashboardWatchedFiles once exited the process and
        // killed every running subagent.
        try {
          if (Date.now() >= nextDashboardSync) runDashboardSync();
          runPendingDashboardSyncRequest();
          if (Date.now() >= nextDashboardWatch) {
            nextDashboardWatch = Date.now() + config.discord.dashboard.watchIntervalMs;
            runDashboardWatch();
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              event: isDatabaseBusy(error) ? 'database_busy' : 'dashboard_tick_error',
              operation: 'dashboard',
              error: String(error),
            }),
          );
        }
      }, 500);
    });
  } finally {
    clearInterval(timer);
    clearTimeout(confirmTimer);
    profiler.close();
    try {
      await cleanup();
    } finally {
      removeHandlers();
      unlock();
    }
  }
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, sub, ...rest] = args;
  const home = stateHome();
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(HELP);
    return;
  }
  if (command === '--version') {
    console.log('0.1.0');
    return;
  }
  // `clawstrum start --help` must print usage, not start the daemon. setup has its own help.
  if (command !== 'setup' && args.slice(1).some((a) => a === '--help' || a === '-h')) {
    console.log(commandHelp(command));
    return;
  }
  if (command === 'import') {
    importCommand(home, args.slice(1));
    return;
  }
  if (command === 'dashboard') {
    await dashboardCommand(home, sub, rest);
    return;
  }
  if (await workflowCommand(args, home)) return;
  if (command === 'init') {
    await init(home, args.slice(1));
    return;
  }
  if (command === 'setup') {
    const { setup } = await import('./setup.js');
    await setup(home, args.slice(1));
    return;
  }
  if (command === 'apply' || command === 'rollback') {
    process.exitCode =
      command === 'apply' ? apply({ home, test: !args.includes('--no-test') }) : rollback({ home });
    return;
  }
  if (command === 'mcp') {
    const { serveMcp } = await import('./mcp.js');
    await serveMcp(home);
    return;
  }
  loadEnv(home);
  if (!fs.existsSync(path.join(home, 'config.json'))) {
    const detail = `No config.json in ${home}. Run clawstrum setup first.`;
    if (command === 'doctor')
      console.log(JSON.stringify({ checks: [{ check: 'Config', ok: false, detail }] }, null, 2));
    else console.error(detail);
    process.exitCode = 1;
    return;
  }
  const config = readConfig(home);
  const store = new Store(home);
  try {
    if (command === 'start') return await start(config, store);
    if (command === 'doctor') return await doctor(config, store, args.includes('--notify'));
    if (command === 'memory' && sub === 'migrate') {
      if (!args.includes('--apply')) {
        console.log(
          'Use clawstrum memory migrate --apply [--channels-root DIR] while the daemon is stopped. Back up the database and source files first. The migration archives original documents and completes full-coverage memory reconciliation before retiring them.',
        );
        return;
      }
      const release = acquireLock(home);
      try {
        await migrateMemory(store, config, {
          channelsRoot: flags(rest)['channels-root'],
          progress: (event) => console.log(JSON.stringify(event)),
        });
      } finally {
        release();
      }
    } else if (command === 'history') {
      const input = flags(rest);
      if (sub === 'index') {
        console.log(JSON.stringify(indexHistory(store, 256)));
        return;
      }
      if (input.action === 'rank') {
        const session = required(sub, 'history SESSION --action rank --query TEXT');
        if (input.group) groupHistory(store, session, input.group, { action: 'list', limit: 1 });
        console.log(
          JSON.stringify(
            await rankedHistory(
              store,
              input.group ? { groupId: input.group } : session,
              {
                query: required(input.query, 'rank needs --query'),
                limit: input.limit ? Number(input.limit) : undefined,
              },
              new DecisionService(store, config.decisions),
              { sessionId: session },
            ),
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        JSON.stringify(
          (input.group
            ? (store: Store, session: string, options: any) =>
                groupHistory(store, session, input.group!, options)
            : historyPage)(store, required(sub, 'history SESSION --action list|search|read'), {
            action: (input.action ?? 'list') as 'list' | 'search' | 'read',
            query: input.query,
            id: input.id,
            after: input.after ? Number(input.after) : undefined,
            offset: input.offset ? Number(input.offset) : undefined,
          }),
          null,
          2,
        ),
      );
    } else if (command === 'research') {
      const opts = flags(rest);
      if (sub === 'enable') {
        config.research.enabled = true;
        if (opts.email) config.research.email = opts.email;
        if (opts.slurm) config.research.slurm.enabled = true;
        saveConfig(home, configSchema.parse(config));
        console.log(
          `Research profile enabled in ${path.join(home, 'config.json')}. Restart the daemon to load it. PDF extraction uses ${config.research.pdftotext}; Slurm is ${config.research.slurm.enabled ? 'enabled' : 'disabled'}.`,
        );
      } else {
        if (
          !sub ||
          !['paper', 'citation', 'note', 'delegate', 'steer', 'cluster', 'status'].includes(sub)
        )
          throw new Error(
            'Use research enable or paper|citation|note|delegate|steer|cluster|status SESSION --input JSON_FILE',
          );
        const session = store.session(required(rest[0], 'A session ID is required'));
        const input = JSON.parse(
          fs.readFileSync(required(opts.input, 'Pass --input JSON_FILE'), 'utf8'),
        );
        console.log(
          JSON.stringify(
            await researchTool(`research_${sub}` as ResearchTool, input, {
              store,
              config,
              sessionId: session.id,
              scope: 'cli',
            }),
            null,
            2,
          ),
        );
      }
    } else if (command === 'account') {
      const pool = new AccountPool(config.accounts, store, config.runtime.unknownQuotaCooldownMs);
      const opts = flags(rest.slice(1));
      if (sub === 'list')
        console.log(JSON.stringify(listAccounts(config, store, pool, home), null, 2));
      else if (sub === 'add') console.log(addAccount(home, rest[0], rest[1], flags(rest.slice(2))));
      else if (sub === 'remove') console.log(removeAccount(home, rest[0]));
      else if (sub === 'edit') console.log(editAccount(home, rest[0], opts));
      else if (sub === 'import') {
        const options = flags(rest);
        console.log(
          JSON.stringify(
            importRegistry(home, process.env, {
              moveTokens: options['move-tokens'] === 'true',
              force: options.force === 'true',
            }),
            null,
            2,
          ),
        );
      } else if (sub === 'set-token') {
        const clear = opts.clear === 'true';
        console.log(setToken(home, rest[0], clear ? null : await readSecretFromStdin()));
      } else if (sub === 'login') {
        const account = getAccount(config, rest[0]);
        const refusal = loginRefusal(account, rest.includes('--force'));
        if (refusal) throw new Error(refusal);
        await login(account, config, rest.includes('--device'));
        pool.reset(account.id);
      } else if (sub === 'test') {
        const account = getAccount(config, rest[0]);
        const model = flags(rest).model;
        if (model === 'true') throw new Error('account test ID --model MODEL needs a model name');
        const result = await testAccount(config, account, { model });
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
      } else if (sub === 'reset') {
        pool.reset(required(rest[0], 'account reset ID'));
        console.log('Account cooldown cleared.');
      } else
        throw new Error(
          'account list | import [--move-tokens] [--force] | add ID PROVIDER [--owner O --label L --model M --priority N --token-env VAR] | edit ID --FIELD VALUE | remove ID | set-token ID [--clear] (token on stdin) | login ID [--device|--force] | test ID [--model M] | reset ID',
        );
    } else if (command === 'maintenance') {
      if (sub && sub !== 'status') throw new Error('maintenance status');
      console.log(
        JSON.stringify(
          {
            ...maintenanceBudget(
              store,
              config.runtime.maintenance.maxCallsPerDay,
              Date.now(),
              config.runtime.maintenance.minIntervalMs,
            ),
            dailyConsolidation: maintenanceBudget(
              store,
              config.runtime.consolidation.daily.maxCallsPerDay,
              Date.now(),
              0,
              { daily: true },
            ),
          },
          null,
          2,
        ),
      );
    } else if (command === 'status') {
      console.log(
        sub
          ? sessionStatus(store, sub)
          : JSON.stringify(store.all('SELECT * FROM sessions'), null, 2),
      );
    } else if (['switch', 'stop', 'resume', 'reset'].includes(command)) {
      const session = store.session(required(sub, `${command} SESSION`));
      const switchOptions = flags(rest.slice(1));
      if (command === 'switch' && switchOptions.model === 'true')
        throw new Error('switch SESSION ACCOUNT --model MODEL needs a model name (or "default")');
      const account =
        command === 'switch'
          ? formatSwitchArgument(getAccount(config, rest[0]).id, switchOptions.model)
          : null;
      store.exec(
        'INSERT INTO controls(session_id,command,argument,created_at) VALUES(?,?,?,?)',
        session.id,
        command === 'stop' ? 'cancel' : command,
        account,
        Date.now(),
      );
      console.log(
        command === 'switch'
          ? 'Control queued. The running daemon applies it on its next tick; no restart.'
          : 'Control queued.',
      );
    } else if (command === 'tasks') {
      if (sub === 'list') console.log(JSON.stringify(listTasks(store), null, 2));
      else if (sub === 'history')
        console.log(
          JSON.stringify(taskHistory(store, required(rest[0], 'tasks history ID')), null, 2),
        );
      else if (sub === 'cancel')
        console.log({
          changed: Number(
            store.exec(
              "UPDATE tasks SET status='cancelled' WHERE id=?",
              required(rest[0], 'tasks cancel ID'),
            ).changes,
          ),
        });
      else if (sub === 'add') {
        if (rest[1] !== 'once' && rest[1] !== 'cron')
          throw new Error('tasks add SESSION once|cron SCHEDULE PROMPT');
        console.log(
          addTask(
            store,
            required(rest[0], 'Session required'),
            required(rest[3], 'Prompt required'),
            rest[1],
            required(rest[2], 'Schedule required'),
            flags(rest).timezone || 'UTC',
          ),
        );
      } else throw new Error('tasks list | add | cancel');
    } else if (command === 'backup') {
      console.log(backupState(store, required(sub, 'backup DIRECTORY')));
    } else if (command === 'gc') {
      const before = Date.parse(required(flags(args).before, 'gc --before DATE [--apply]'));
      console.log(
        JSON.stringify(
          {
            applied: args.includes('--apply'),
            files: collectFiles(store, before, args.includes('--apply')),
          },
          null,
          2,
        ),
      );
    } else if (command === 'group') {
      const options = flags(rest);
      if (sub === 'create')
        console.log(
          JSON.stringify(
            createGroup(
              store,
              required(rest[0], 'group create ID --name NAME'),
              required(options.name, '--name NAME'),
              options.purpose ?? '',
            ),
            null,
            2,
          ),
        );
      else if (sub === 'join' || sub === 'leave') {
        setGroupMembership(
          store,
          required(rest[0], 'group join|leave GROUP SESSION'),
          required(rest[1], 'SESSION required'),
          sub === 'join',
          options.role ?? '',
        );
        console.log(JSON.stringify({ group: rest[0], session: rest[1], joined: sub === 'join' }));
      } else if (sub === 'board')
        console.log(
          JSON.stringify(
            groupBoard(
              store,
              required(rest[0], 'group board SESSION --input JSON_FILE'),
              JSON.parse(fs.readFileSync(required(options.input, '--input JSON_FILE'), 'utf8')),
            ),
            null,
            2,
          ),
        );
      else if (sub === 'status') {
        syncGroups(store, config.groups.enabled);
        console.log(
          JSON.stringify(
            (rest[0] ? [getGroup(store, rest[0])] : groups(store)).map((g) => ({
              group: groupView(g),
              entries: groupEntries(store, g.id).map(entryView),
              issues: groupIssues(store, g.id),
              usage: usageReport(
                store,
                `group:${g.id}`,
                Math.max(1, Math.min(100, Number(options.limit) || 30)),
                Math.max(0, Number(options.offset) || 0),
              ),
            })),
            null,
            2,
          ),
        );
      } else throw new Error('group create|join|leave|status|board');
    } else if (command === 'export') {
      const session = store.session(required(sub, 'export SESSION [FILE]'));
      const rows = {
        session,
        groups: exportGroups(store, session.id),
        memory: {
          shared: readOptional(path.join(store.home, 'AGENTS.md')),
          channel: readOptional(path.join(session.workspace, 'AGENTS.md')),
        },
        history: store.all(
          'SELECT * FROM history_records WHERE session_id=? ORDER BY seq',
          session.id,
        ),
        historySupersessions: store.all(
          'SELECT s.* FROM history_supersessions s JOIN history_records r ON r.id=s.previous_id WHERE r.session_id=?',
          session.id,
        ),
        memoryLifecycle: store.all(
          'SELECT key,value FROM metadata WHERE key IN (?,?,?,?,?)',
          `consolidation:${session.id}`,
          `consolidation:${session.id}:coverage`,
          `memory-review:${session.id}`,
          `memory-review:${session.id}:coverage`,
          `memory-review:${session.id}:completed-at`,
        ),
        researchNotes: store
          .all<{
            id: string;
          }>('SELECT * FROM research_notes WHERE session_id=? ORDER BY created_at,id', session.id)
          .map((note) => ({ ...note, claim: noteClaim(store, session.id, note.id) })),
        researchJobs: store.all(
          'SELECT * FROM cluster_jobs WHERE session_id=? ORDER BY created_at,id',
          session.id,
        ),
        researchWorkers: store.all(
          'SELECT * FROM delegations WHERE session_id=? ORDER BY created_at,id',
          session.id,
        ),
        messages: store.all(
          'SELECT * FROM inbound WHERE session_id=? ORDER BY created_at',
          session.id,
        ),
        tasks: store.all('SELECT * FROM tasks WHERE session_id=? ORDER BY created_at', session.id),
        taskRuns: store.all(
          'SELECT r.* FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.session_id=? ORDER BY r.scheduled_at',
          session.id,
        ),
        runs: store.all('SELECT * FROM runs WHERE session_id=? ORDER BY started_at', session.id),
        events: store.all('SELECT * FROM events WHERE session_id=? ORDER BY seq', session.id),
        outbox: store.all(
          'SELECT * FROM outbox WHERE session_id=? ORDER BY created_at',
          session.id,
        ),
      };
      const serialized = JSON.stringify(rows, null, 2);
      if (rest[0]) writePrivate(path.resolve(rest[0]), serialized);
      else console.log(serialized);
    } else if (command === 'retry-delivery') {
      const session = store.session(required(sub, 'retry-delivery SESSION'));
      console.log({
        changed: Number(
          store.exec(
            "UPDATE outbox SET status='pending',attempts=0,available_at=? WHERE session_id=? AND status='failed'",
            Date.now(),
            session.id,
          ).changes,
        ),
      });
    } else if (command === 'service') {
      const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
      console.log(serviceUnit(home, process.execPath, cli));
    } else if (command === 'smoke') {
      const account = getAccount(config, sub);
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-smoke-'));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('Smoke timeout')), 120000);
      try {
        const answer = await supervisedProviders[account.provider].run({
          account,
          prompt: 'Reply with exactly CLAWSTRUM_OK. Do not call any tools.',
          instructions: 'Subscription connectivity check. Return the requested marker only.',
          toolless: true,
          cwd: workspace,
          controller,
          env: accountEnvironment(account, config.accounts),
          blockedVersions: config.runtime.blockedVersions,
          mcp: { command: process.execPath, args: ['-e', 'process.exit(0)'], env: {} },
          onEvent: () => {},
        });
        if (answer.trim() !== 'CLAWSTRUM_OK')
          throw new Error('Provider smoke returned an unexpected answer');
        console.log('CLAWSTRUM_OK');
      } finally {
        clearTimeout(timeout);
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    } else throw new Error(HELP);
  } finally {
    store.close();
  }
}
