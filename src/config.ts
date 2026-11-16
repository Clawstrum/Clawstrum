import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { memoryReviewConfig } from './memory-review.js';
import { writePrivate } from './files.js';
import { rememberSecret, rememberSecretName } from './secrets.js';
import { researchSchema } from './research/config.js';
import { groupsSchema } from './groups/config.js';
import { decisionsSchema } from './decisions/config.js';
import { accountSchema, validateAccounts } from './account-schema.js';
import { loadAccountRegistry, registryPath, setAccountTokens } from './account-registry.js';

const snowflake = z.string().regex(/^\d{5,25}$/);
const schema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).default('Clawstrum'),
    research: researchSchema,
    groups: groupsSchema,
    decisions: decisionsSchema,
    discord: z
      .object({
        tokenEnv: z.string().default('DISCORD_BOT_TOKEN'),
        ownerIds: z.array(snowflake).min(1),
        guildId: snowflake.optional(),
        applicationId: snowflake.optional(),
        channelIds: z.array(snowflake).default([]),
        noticeChannelId: snowflake.optional(),
        plainDashes: z.boolean().default(true),
        sendAdviceChars: z.number().int().min(0).default(0),
        allowDMs: z.boolean().default(true),
        newConversationLookbackMs: z.number().int().min(0).default(86400000),
        allowAllSenders: z.boolean().default(false),
        respondToBots: z.boolean().default(false),
        mentionOnlyWithBots: z.boolean().default(true),
        dashboard: z
          .object({
            enabled: z.boolean().default(false),
            channelName: z.string().min(1).max(100).default('dashboard'),
            // An explicit channel id is trusted as-is; the daemon neither searches nor creates
            // another forum when this is set.
            channelId: snowflake.optional(),
            categoryId: snowflake.optional(),
            syncIntervalMs: z.number().int().min(60000).max(86400000).default(600000),
            // How often the daemon stats the files a sync reads (never their content) to catch an
            // edited AGENTS.md, config.json, skill or rebuilt dist between full syncIntervalMs ticks.
            watchIntervalMs: z.number().int().min(10000).max(86400000).default(60000),
            // Unset means every discord.ownerIds entry; see dashboardViewerIds().
            viewerIds: z.array(snowflake).optional(),
          })
          .strict()
          .prefault({}),
      })
      .strict(),
    review: z
      .object({
        channelId: snowflake.optional(),
        at: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour HH:MM time')
          .default('03:00'),
      })
      .strict()
      .prefault({}),
    accounts: z.array(accountSchema).min(1),
    runtime: z
      .object({
        maxConcurrent: z.number().int().min(1).max(64).default(4),
        debounceMs: z.number().int().min(0).default(1500),
        debounceMaxMs: z.number().int().min(0).default(15000),
        /** While the Discord typing signal stays live past debounceMaxMs, keep waiting up to this
         * cap instead of starting mid-sentence; debounceMaxMs still caps the wait once nobody is
         * typing. Must be >= debounceMaxMs. */
        typingMaxMs: z.number().int().min(0).default(300000),
        startupTimeoutMs: z.number().int().min(100).default(120000),
        silenceTimeoutMs: z.number().int().min(0).default(600000),
        queuedInputTimeoutMs: z.number().int().min(0).default(120000),
        scheduledMaxTurns: z.number().int().min(0).max(1000).default(0),
        turnTimeoutMs: z.number().int().min(0).default(7200000),
        // Soft CPU-seconds per process for Claude agent shell commands; 0 = off. Read at start.
        shellCpuSeconds: z.number().int().min(0).default(0),
        // Deployments often run on UTC hosts while the people are elsewhere; default is the host zone.
        timezone: z
          .string()
          .refine((v) => {
            try {
              new Intl.DateTimeFormat('en-US', { timeZone: v });
              return true;
            } catch {
              return false;
            }
          }, 'runtime.timezone must be an IANA time zone')
          .optional(),
        abortGraceMs: z.number().int().min(100).max(10000).default(3000),
        // How long streaming Claude input stays open after background work settles, so a turn
        // the CLI starts to deliver a task notification is not cut off (see turn-stream.ts).
        inputReleaseGraceMs: z.number().int().min(0).max(60000).default(10000),
        promptChars: z.number().int().min(8000).max(1000000).default(100000),
        unknownQuotaCooldownMs: z.number().int().min(1000).default(900000),
        proactiveThreshold: z.number().min(0).max(1).default(0.95),
        quotaWarningThreshold: z.number().min(0).max(1).default(0.9),
        maxAttempts: z.number().int().min(1).max(10).default(3),
        slowRetryMs: z
          .number()
          .int()
          .refine((n) => n === 0 || n >= 60000, 'Use 0 or at least 60000 ms')
          .default(300000),
        nativeSessionMaxTurns: z.number().int().min(0).default(0),
        nativeSessionMaxBytes: z.number().int().min(0).default(0),
        nativeSessionMaxAgeMs: z.number().int().min(0).default(0),
        maintenance: z
          .object({
            maxCallsPerDay: z.number().int().min(0).max(10000).default(24),
            minIntervalMs: z.number().int().min(0).max(86400000).default(1800000),
            maxConcurrent: z.number().int().min(1).max(16).default(1),
            // Calls per 24h window that only a requested pass (a channel's compaction summary
            // waiting to be merged into MEMORY) may use. Backlog catch-up and periodic review
            // share the other maxCallsPerDay - requestedReserve calls. Capped at a quarter of the limit.
            requestedReserve: z.number().int().min(0).max(10000).default(6),
            // The consolidation/review scan reads every session on each pass; with many sessions
            // that is hundreds of point-queries per engine tick and stalls the event loop. Throttling
            // the scan itself, not its per-session query count, keeps a due session's wait bounded
            // by this interval, not by how fast ticks happen to run.
            scanIntervalMs: z.number().int().min(1000).max(3600000).default(60000),
          })
          .strict()
          .prefault({}),
        memoryReview: memoryReviewConfig,
        consolidation: z
          .object({
            enabled: z.boolean().default(true),
            models: z
              .object({
                claude: z.string().optional(),
                codex: z.string().optional(),
                gemini: z.string().optional(),
              })
              .strict()
              .prefault({ claude: 'sonnet' }),
            effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
            // 0 turns the byte-threshold trigger off (the default): the daily pass below replaces
            // it. A positive value restores it: a channel whose new history reaches this many
            // bytes gets a rotating pass, whatever the time of day.
            thresholdBytes: z.number().int().min(0).default(0),
            // Once per local day per channel (and once for the shared scope) that has new history
            // since its last daily pass, at or after `hour`, while the channel is idle. It does not
            // rotate the native session and has its own call cap, separate from
            // runtime.maintenance.maxCallsPerDay.
            daily: z
              .object({
                enabled: z.boolean().default(true),
                hour: z.number().int().min(0).max(23).default(4),
                timezone: z
                  .string()
                  .min(1)
                  .refine((zone) => {
                    try {
                      new Intl.DateTimeFormat('en-US', { timeZone: zone });
                      return true;
                    } catch {
                      return false;
                    }
                  }, 'Use an IANA time zone name such as America/New_York')
                  .optional(),
                maxCallsPerDay: z.number().int().min(0).max(10000).default(120),
                // A daily pass reads at most this many chunks of the newest history. An older
                // backlog (the first pass of a channel that never had one) is skipped with a
                // coverage record, not summarized; it stays in raw history.
                tailChunks: z.number().int().min(1).max(1000).default(8),
              })
              .strict()
              .prefault({}),
            chunkChars: z.number().int().min(2000).max(400000).default(120000),
            maxChunksPerPass: z.number().int().min(1).max(1000).default(8),
            // A requested pass (after a compaction) reads at most this many chunks of the newest
            // history; an older backlog is skipped with a coverage record, not summarized.
            requestedTailChunks: z.number().int().min(1).max(100).default(2),
            timeoutMs: z.number().int().min(1000).max(3600000).default(600000),
          })
          .strict()
          .prefault({}),
        blockedVersions: z
          .array(
            z
              .object({
                provider: z.enum(['claude', 'codex', 'gemini']),
                version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
                reason: z.string().min(1),
              })
              .strict(),
          )
          .default([]),
        historyChars: z.number().int().min(2000).max(200000).default(32000),
        attachmentMaxBytes: z
          .number()
          .int()
          .min(1)
          .default(25 * 1024 * 1024),
      })
      .strict()
      .prefault({}),
    mcpServers: z
      .record(
        z.string().regex(/^[A-Za-z0-9_-]+$/),
        z
          .object({
            command: z.string().min(1),
            args: z.array(z.string()).default([]),
            env: z.record(z.string(), z.string()).default({}),
          })
          .strict(),
      )
      .default({}),
    // Speech-to-text for voice notes on the daemon's host; scripts/install-voice.sh sets it up.
    voice: z
      .object({
        enabled: z.boolean().default(false),
        python: z.string().min(1).default('python3'),
        asrDir: z.string().min(1).default('asr'),
        script: z.string().min(1).optional(),
      })
      .strict()
      .prefault({}),
    // Opt-in: the agent works on its own under a stated ask, woken after quiet stretches.
    workAlone: z
      .object({
        enabled: z.boolean().default(false),
        quietMinutes: z.number().positive().default(60),
        staleHours: z.number().positive().default(24),
        morning: z
          .object({
            enabled: z.boolean().default(false),
            cron: z.string().min(1).default('40 3 * * *'),
            timezone: z.string().min(1).optional(),
            activeHours: z.number().positive().default(24),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    // Claude subagent shell commands run under bubblewrap (scripts/worker-sandbox.sh); off by default.
    sandbox: z
      .object({
        workers: z.boolean().default(false),
        writable: z
          .array(z.string().regex(/^(\/|~$|~\/)/, 'Use an absolute or ~-relative path'))
          .default([]),
        offlineRoles: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (Object.hasOwn(c.mcpServers, 'clawstrum'))
      ctx.addIssue({
        code: 'custom',
        message: "mcpServers.clawstrum is reserved for Clawstrum's own tools",
        path: ['mcpServers', 'clawstrum'],
      });
    if (c.review.channelId && !c.discord.channelIds.includes(c.review.channelId))
      ctx.addIssue({
        code: 'custom',
        message: 'review.channelId must also be listed in discord.channelIds',
        path: ['review', 'channelId'],
      });
    // Posting a Clawstrum message into the dashboard, or an operator question there, must never
    // start a conversation (see discord.ts accepts()); keep the two lists disjoint.
    if (
      c.discord.dashboard.channelId &&
      c.discord.channelIds.includes(c.discord.dashboard.channelId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'discord.dashboard.channelId must not also be listed in discord.channelIds',
        path: ['discord', 'dashboard', 'channelId'],
      });
    if (c.research.workers.account && !c.accounts.some((a) => a.id === c.research.workers.account))
      ctx.addIssue({
        code: 'custom',
        message: 'Research subagent account must be configured',
        path: ['research', 'workers', 'account'],
      });
    validateAccounts(c.accounts, ctx, ['accounts']);
    if (c.runtime.debounceMaxMs < c.runtime.debounceMs)
      ctx.addIssue({
        code: 'custom',
        message: 'debounceMaxMs must be >= debounceMs',
        path: ['runtime'],
      });
    if (c.runtime.typingMaxMs < c.runtime.debounceMaxMs)
      ctx.addIssue({
        code: 'custom',
        message: 'typingMaxMs must be >= debounceMaxMs',
        path: ['runtime'],
      });
  });
/** Accept old configuration files without reviving the retired native-compaction model or
 * file curation. Only explicit model routing and opt-out preferences carry forward. */
export const configSchema = z.preprocess((value: any) => {
  if (!value || typeof value !== 'object') return value;
  const legacy = value.research?.consolidator;
  if (!legacy) return value;
  const inherited: Record<string, unknown> = {};
  for (const name of ['enabled', 'models', 'effort'])
    if (legacy[name] !== undefined) inherited[name] = legacy[name];
  return {
    ...value,
    runtime: { ...value.runtime, consolidation: { ...inherited, ...value.runtime?.consolidation } },
  };
}, schema);
export type Config = z.infer<typeof configSchema>;
export function expandPath(value: string): string {
  return path.resolve(
    value === '~'
      ? os.homedir()
      : value.startsWith('~/')
        ? path.join(os.homedir(), value.slice(2))
        : value,
  );
}
export function stateHome(): string {
  return expandPath(process.env.CLAWSTRUM_HOME || '~/.clawstrum');
}
/**
 * Read config.json. When the private registry (runtime/accounts.json) exists its accounts replace
 * config.json `accounts`; otherwise config.json is used unchanged. Registry tokens are put into the
 * in-process token map only after the whole configuration validated, and only when applyTokens is
 * true (readers that merely inspect the file, such as the channel reloader, leave the map alone).
 */
export function readConfig(home: string, options: { applyTokens?: boolean } = {}): Config {
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  const registry = loadAccountRegistry(home);
  if (registry && raw && typeof raw === 'object') raw.accounts = registry.accounts;
  const config = normalizeConfig(home, raw);
  if (options.applyTokens !== false) setAccountTokens(registry?.tokens ?? new Map());
  return config;
}
/**
 * Resolve existing symlink ancestors even when the final directory does not yet exist. A link whose
 * destination does not exist yet also redirects a create through it, so follow those one hop at a
 * time rather than reporting the link's own location. `hops` bounds a chain of them.
 */
export function canonicalPath(filename: string, hops = 32): string {
  try {
    return fs.realpathSync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    let link: string | null = null;
    try {
      link = fs.readlinkSync(filename);
    } catch {
      link = null;
    }
    if (link !== null) {
      if (hops === 0) throw error;
      return canonicalPath(path.resolve(path.dirname(filename), link), hops - 1);
    }
    const parent = path.dirname(filename);
    if (parent === filename) throw error;
    return path.join(canonicalPath(parent, hops), path.basename(filename));
  }
}
export function normalizeConfig(home: string, value: unknown): Config {
  const config = configSchema.parse(value);
  for (const a of config.accounts) {
    if (a.tokenEnv) rememberSecretName(a.tokenEnv);
    a.home = canonicalPath(
      a.home === '~' || a.home.startsWith('~/') || path.isAbsolute(a.home)
        ? expandPath(a.home)
        : path.resolve(home, a.home),
    );
    if (a.executable && !path.isAbsolute(a.executable))
      a.executable = path.resolve(home, a.executable);
  }
  return configSchema.parse(config);
}
/**
 * Copy the channel list from config.json into a running config, in place, so every holder of the
 * object sees the new list. Only discord.channelIds changes live; other edits still need a restart.
 * Returns the added and removed channel IDs. An invalid file throws and leaves the config unchanged.
 */
export function reloadChannelIds(
  home: string,
  config: Config,
): { added: string[]; removed: string[] } {
  const next = readConfig(home, { applyTokens: false }).discord.channelIds;
  const current = config.discord.channelIds;
  const added = next.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !next.includes(id));
  if (added.length || removed.length) current.splice(0, current.length, ...next);
  return { added, removed };
}
/**
 * Return a check the daemon can call on every tick. At most once per interval it compares the
 * config file's modification time and size with the last applied version and reloads the channel
 * list when they differ. A file that fails to load is reported once and retried after it changes.
 */
export function channelReloader(home: string, config: Config, intervalMs = 5000) {
  const file = path.join(home, 'config.json');
  const stamp = () => {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  };
  let applied = stamp();
  let failed: string | undefined;
  let checked = Date.now();
  return (now = Date.now()): { added: string[]; removed: string[] } | null => {
    if (now - checked < intervalMs) return null;
    checked = now;
    const current = stamp();
    if (current === applied || current === failed) return null;
    try {
      const change = reloadChannelIds(home, config);
      applied = current;
      failed = undefined;
      return change;
    } catch (error) {
      failed = current;
      throw error;
    }
  };
}
/**
 * Return a check the daemon can call on every tick that applies account changes without a restart.
 * At most once per interval it compares the modification time and size of config.json and of the
 * private registry (accounts.json, which may be absent) with the last applied version. On a change
 * it reads the whole configuration; if the resulting account list or the registry differs from
 * what is running it returns the new list. A file that fails to load throws once, the old list
 * stays in force, and the next attempt waits until the file changes again.
 */
export function accountsReloader(home: string, config: Config, intervalMs = 5000) {
  const files = [path.join(home, 'config.json'), registryPath(home)];
  const stamp = () =>
    files
      .map((file) => {
        try {
          const s = fs.statSync(file);
          return `${s.mtimeMs}:${s.size}`;
        } catch {
          return 'absent';
        }
      })
      .join('|');
  let applied = stamp();
  let appliedRegistry = applied.split('|')[1];
  let failed: string | undefined;
  let checked = Date.now();
  return (
    now = Date.now(),
  ): { accounts: Config['accounts']; added: string[]; removed: string[] } | null => {
    if (now - checked < intervalMs) return null;
    checked = now;
    const current = stamp();
    if (current === applied || current === failed) return null;
    try {
      const next = readConfig(home).accounts;
      applied = current;
      failed = undefined;
      const registry = current.split('|')[1];
      if (JSON.stringify(next) === JSON.stringify(config.accounts) && registry === appliedRegistry)
        return null;
      appliedRegistry = registry;
      const before = config.accounts.map((a) => a.id);
      const after = next.map((a) => a.id);
      return {
        accounts: next,
        added: after.filter((id) => !before.includes(id)),
        removed: before.filter((id) => !after.includes(id)),
      };
    } catch (error) {
      failed = current;
      throw error;
    }
  };
}
export function loadEnv(home: string): void {
  const filename = path.join(home, '.env');
  if (!fs.existsSync(filename)) return;
  // Node's permissive parser silently ignores a wrapped token's second line. Reject ambiguous input without echoing secrets.
  const lines = fs.readFileSync(filename, 'utf8').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!assignment)
      throw new Error(
        `Invalid .env assignment at line ${index + 1}; keep each credential on one line`,
      );
    const value = assignment[2]!;
    if (/^["'`]/.test(value) && !value.slice(1).includes(value[0]!))
      throw new Error(
        `Unclosed or multiline .env value at line ${index + 1}; keep each credential on one line`,
      );
  }
  process.loadEnvFile(filename);
}
export function dashboardViewerIds(config: Config): string[] {
  return config.discord.dashboard.viewerIds ?? config.discord.ownerIds;
}
// Provider runs, subagents, MCP servers and cluster jobs all inherit process.env; none needs the bot token.
export function takeDiscordToken(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  const token = env[config.discord.tokenEnv];
  if (!token) throw new Error(`Set ${config.discord.tokenEnv} before starting`);
  delete env[config.discord.tokenEnv];
  rememberSecret(token); // failure text is redacted from process.env, which no longer has it
  return token;
}
// For hosts shared with other conversations and users, such as a cluster login node. Workers and the Claude CLI
// inherit process.env, so every agent shell command runs under the prefix; Codex commands do not.
export function applyShellCpuCap(config: Config, env: NodeJS.ProcessEnv = process.env): void {
  const seconds = config.runtime.shellCpuSeconds;
  if (!seconds || process.platform === 'win32') return;
  env.CLAUDE_CODE_SHELL_PREFIX = fileURLToPath(new URL('../scripts/cpu-cap.sh', import.meta.url));
  env.CLAWSTRUM_CPU_CAP_S = String(seconds);
}
export function saveConfig(home: string, config: unknown): void {
  normalizeConfig(home, config);
  writePrivate(path.join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}
