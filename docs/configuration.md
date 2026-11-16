# Configuration reference

Clawstrum reads `config.json` from its state directory, `CLAWSTRUM_HOME` (default `~/.clawstrum`). `clawstrum setup` or `clawstrum init` writes a first version; [templates/config.example.json](../templates/config.example.json) is a fuller example. The schema itself is in [src/config.ts](../src/config.ts), which is authoritative when this page and the code disagree.

## Parsing and reload

The file is JSON checked by strict schemas: an unknown field is an error, not ignored. Missing optional fields take the defaults below. Clawstrum validates a configuration before writing it, writes a temporary file and renames it over `config.json`.

`~` and `~/...` expand to your home directory. Relative account homes, executable paths and voice paths resolve against the state directory. Account IDs must be unique, and two accounts of the same provider cannot share a home.

The daemon reads the configuration at startup. Most changes need a restart. The exception is `discord.channelIds`: the running daemon checks the file every few seconds and applies a changed channel list without a restart. An invalid file is reported once and the running configuration stays in place. Each run stores the validated configuration it started with, and the agent's tool server uses that copy, so an edit in progress cannot change a running turn. `AGENTS.md` and skill files are read again on each attempt, and switching among configured accounts needs no restart.

## Root fields

| Field        | Type and default             | Meaning                                                                                                                                                             |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`    | `1`, required                | Configuration format version                                                                                                                                        |
| `name`       | Nonempty string; `Clawstrum` | The agent's name. Shown in the ready log and dashboard; in a channel shared with another bot, a message that contains this name as a word counts as addressed to it |
| `discord`    | Object, required             | Discord routing; see below                                                                                                                                          |
| `review`     | Object; defaults filled      | Nightly self-review channel; see below                                                                                                                              |
| `accounts`   | Nonempty array, required     | Provider profiles; see below                                                                                                                                        |
| `runtime`    | Object; defaults filled      | Timing, limits and background maintenance; see below                                                                                                                |
| `research`   | Object; defaults filled      | Research tools, validation, subagents and Slurm; see the [research configuration reference](research.md#configuration-reference)                                    |
| `groups`     | Object; defaults filled      | Channel groups and their reviewer; see [channel groups](groups.md)                                                                                                  |
| `decisions`  | Object; defaults filled      | Optional typed decision service, Jev or OpenRouter; see [Jev](jev.md#configuration)                                                                                 |
| `mcpServers` | Object by server name; `{}`  | Extra stdio MCP servers for the lead agent, each `{command, args=[], env={}}`. Names match `[A-Za-z0-9_-]+`; `clawstrum` is reserved                                |
| `voice`      | Object; off                  | Speech-to-text for audio attachments; see below                                                                                                                     |
| `workAlone`  | Object; off                  | Unattended work under a stated ask; see below                                                                                                                       |
| `sandbox`    | Object; off                  | Sandbox for subagent shell commands; see below                                                                                                                      |

## Discord

| Field                               | Type and default                    | Meaning                                                                                                                                                                                           |
| ----------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discord.tokenEnv`                  | String; `DISCORD_BOT_TOKEN`         | Name of the environment variable that holds the bot token                                                                                                                                         |
| `discord.ownerIds`                  | Nonempty array of IDs               | Discord user IDs of the owners. An ID is 5 to 25 digits                                                                                                                                           |
| `discord.guildId`                   | Optional ID                         | Restrict server input to this server and register the slash command there                                                                                                                         |
| `discord.applicationId`             | Optional ID                         | The Discord Application ID, saved by `clawstrum setup` so it can print the invite link again. Not used by the running agent                                                                       |
| `discord.channelIds`                | ID array; `[]`                      | Channels the agent answers in; threads under them are accepted too. Empty means no server channel. Reloaded while the daemon runs                                                                 |
| `discord.noticeChannelId`           | Optional ID                         | Operator channel for quota warnings, account and model switch notices, group-review issues and `doctor --notify`                                                                                  |
| `discord.plainDashes`               | Boolean; `true`                     | Replace em and en dashes in outgoing prose with plain hyphens. Code, quoted strings, paths and URLs are left alone                                                                                |
| `discord.sendAdviceChars`           | Integer ≥0; `0`                     | When above 0, a message sent through the send tool that is longer than this many characters is still sent, and the tool result advises the agent to keep the next one shorter. `0` turns this off |
| `discord.allowDMs`                  | Boolean; `true`                     | Accept direct messages from allowed senders (owners by default)                                                                                                                                   |
| `discord.newConversationLookbackMs` | Integer ≥0; `86400000`              | When a channel is first registered, how far back to read messages it already has                                                                                                                  |
| `discord.allowAllSenders`           | Boolean; `false`                    | Accept input from people who are not owners, within the configured channels and DMs. Controls stay owner-only                                                                                     |
| `discord.respondToBots`             | Boolean; `false`                    | Accept input from other bots that pass the sender and channel rules. The agent's own messages are always ignored                                                                                  |
| `discord.mentionOnlyWithBots`       | Boolean; `true`                     | In a channel another bot also answers in, keep messages that do not address this agent as context instead of answering them                                                                       |
| `discord.dashboard.enabled`         | Boolean; `false`                    | Keep a Discord forum that shows the agent's configuration, instructions, skills and tools                                                                                                         |
| `discord.dashboard.channelName`     | String, 1 to 100 chars; `dashboard` | Forum name to find or create                                                                                                                                                                      |
| `discord.dashboard.channelId`       | Optional ID                         | Use this forum as-is instead of finding or creating one. Must not also be in `discord.channelIds`                                                                                                 |
| `discord.dashboard.categoryId`      | Optional ID                         | Category for a created forum                                                                                                                                                                      |
| `discord.dashboard.syncIntervalMs`  | 60000 to 86400000; `600000`         | Interval between full dashboard syncs                                                                                                                                                             |
| `discord.dashboard.watchIntervalMs` | 10000 to 86400000; `60000`          | Interval for checking whether the files the dashboard shows have changed                                                                                                                          |
| `discord.dashboard.viewerIds`       | Optional ID array                   | Who can see the forum; unset means every owner                                                                                                                                                    |

## Self-review

| Field              | Type and default           | Meaning                                                                          |
| ------------------ | -------------------------- | -------------------------------------------------------------------------------- |
| `review.channelId` | Optional ID                | Channel for the nightly self-review. Must also be listed in `discord.channelIds` |
| `review.at`        | `HH:MM` (24-hour); `03:00` | Time of the nightly review, in `runtime.timezone` or the host's zone             |

`clawstrum review schedule --channel ID` sets both and registers the task. See [self-review](workflows.md#optional-self-review).

## Accounts

| Field                     | Type and default                          | Meaning                                                                                                                      |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | String, required                          | 1 to 80 letters, digits, underscores or hyphens; unique                                                                      |
| `provider`                | `claude`, `codex` or `gemini`, required   | Which SDK runs this account                                                                                                  |
| `home`                    | Path, required                            | Where the provider keeps its login, settings and sessions. Separate from your usual CLI login                                |
| `priority`                | Integer −1000 to 1000; unset (0)          | Automatic routing tries higher priority first                                                                                |
| `model`                   | Optional string                           | Passed to the SDK. Clawstrum does not check that the model exists for the subscription                                       |
| `effort`                  | Optional                                  | `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. Claude rejects `ultra`; what else works depends on the runtime and model |
| `quotaBuckets`            | String array; `[]`                        | Quota limits that apply only to the primary `model`                                                                          |
| `modelFallbacks`          | Array of `{model, quotaBuckets=[]}`; `[]` | Ordered fallback models on the same login and concurrency cap. Needs an explicit `model`; all model names must differ        |
| `tokenEnv`                | Optional environment variable name        | Claude only: environment variable holding an OAuth token for this account. Codex accounts use their own login home instead   |
| `executable`              | Optional path                             | Use this provider executable instead of the bundled one. It must support `--version`                                         |
| `maxConcurrent`           | Integer 1 to 64; `4`                      | Concurrent runs on this account                                                                                              |
| `owner`, `label`, `notes` | Optional text                             | Plain description for people; never a secret                                                                                 |

Leaving out `model` or `effort` uses the provider's default. The shared buckets `five_hour`, `seven_day`, `5h`, `7d` and `unknown` cannot be scoped to a model. See [model fallback and quota notices](setup.md#model-fallback-and-quota-notices) for an example and [subscriptions](subscriptions.md) for how routing uses these fields.

Quota warnings go to `discord.noticeChannelId` when it is set, even if that channel has never had a conversation; otherwise they go to the conversation that observed them. Above `runtime.quotaWarningThreshold` routing prefers other routes, but still uses a strained one when nothing else is available. An observation without a reset time expires after `runtime.unknownQuotaCooldownMs`. Hard quota cooldowns are tracked separately.

## Runtime

All fields are under `runtime`.

| Field                                | Default              | Meaning                                                                                                                                                                                      |
| ------------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxConcurrent`                      | `4`                  | Conversations running at once, 1 to 64                                                                                                                                                       |
| `debounceMs` / `debounceMaxMs`       | `1500` / `15000`     | Quiet interval that ends a burst of user messages, and the longest wait; `debounceMaxMs` must be at least `debounceMs`                                                                       |
| `typingMaxMs`                        | `300000`             | Longest wait while Discord shows the person still typing past `debounceMaxMs`; must be at least `debounceMaxMs`                                                                              |
| `startupTimeoutMs`                   | `120000`             | Deadline for the provider's first session or ready event, at least 100                                                                                                                       |
| `silenceTimeoutMs` / `turnTimeoutMs` | `600000` / `7200000` | Silence and total turn deadlines; 0 turns either off. Silence is not counted while a tool call runs or the turn holds a live background task; `turnTimeoutMs` is the only bound on that wait |
| `queuedInputTimeoutMs`               | `120000`             | A user message that cannot enter a busy turn for this long, while the turn is also idle this long, ends the turn and continues in a new one; 0 turns this off                                |
| `scheduledMaxTurns`                  | `0`                  | Turn budget for scheduled runs, 0 to 1000; 0 is no limit. Claude uses its native turn cap; Codex counts completed tool items and can overshoot by one                                        |
| `shellCpuSeconds`                    | `0`                  | Soft CPU-seconds per process for Claude agent shell commands, for shared hosts such as cluster login nodes; 0 is off. `sbatch`, `srun` and `salloc` lift it. Codex is not covered            |
| `timezone`                           | host zone            | IANA time zone for the agent's current-time line, time stamps on input and in tool results, the self-review schedule and usage reports                                                       |
| `abortGraceMs`                       | `3000`               | Grace period for a cooperative abort, 100 to 10000                                                                                                                                           |
| `inputReleaseGraceMs`                | `10000`              | How long a Claude input stream stays open after background work settles, 0 to 60000                                                                                                          |
| `promptChars`                        | `100000`             | Total characters of context the host adds to a prompt, 8000 to 1000000                                                                                                                       |
| `historyChars`                       | `32000`              | Characters of recent portable history, 2000 to 200000                                                                                                                                        |
| `unknownQuotaCooldownMs`             | `900000`             | Cooldown for a quota observation with no reset time, at least 1000                                                                                                                           |
| `proactiveThreshold`                 | `0.95`               | Usage fraction, 0 to 1, at which a route with a known reset is no longer admitted                                                                                                            |
| `quotaWarningThreshold`              | `0.9`                | Usage fraction, 0 to 1, for an early warning and for preferring other routes; 1 turns preference off                                                                                         |
| `maxAttempts`                        | `3`                  | Fast retries for a transient failure, 1 to 10                                                                                                                                                |
| `slowRetryMs`                        | `300000`             | Interval for slow retries after the fast ones, 0 or at least 60000; 0 makes the fast limit final                                                                                             |
| `blockedVersions`                    | `[]`                 | Provider CLI versions to refuse, each `{provider, version, reason}`                                                                                                                          |
| `attachmentMaxBytes`                 | `26214400`           | Size limit per incoming or outgoing file, at least 1                                                                                                                                         |
| `maintenance`                        | see below            | Budget for background model calls                                                                                                                                                            |
| `consolidation`                      | see below            | Conversation consolidation before a planned session rotation                                                                                                                                 |
| `memoryReview`                       | see below            | Regular memory consistency review                                                                                                                                                            |

`nativeSessionMaxTurns`, `nativeSessionMaxBytes` and `nativeSessionMaxAgeMs` (default `0`) are still accepted so old files load, but have no effect. Remove them when you edit the file.

Before each run, a worker asks the provider executable for its version with `--version`, records it, and refuses to run a version listed in `blockedVersions`. `clawstrum doctor` reports blocked versions and `clawstrum smoke` honors them. A version that is not listed is not thereby known to work.

### Background maintenance

| Field                                | Default              | Meaning                                                                                                                                           |
| ------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maintenance.maxCallsPerDay`         | `24`                 | Background model calls per rolling 24 hours, 0 to 10000; 0 pauses them                                                                            |
| `maintenance.minIntervalMs`          | `1800000`            | Minimum time between background call starts, 0 to 86400000                                                                                        |
| `maintenance.maxConcurrent`          | `1`                  | Background calls at once, 1 to 16                                                                                                                 |
| `maintenance.requestedReserve`       | `6`                  | Calls of `maxCallsPerDay` kept for passes requested after a compaction, at most a quarter of it                                                   |
| `maintenance.scanIntervalMs`         | `60000`              | How often sessions are checked for a due rotation or review, 1000 to 3600000                                                                      |
| `consolidation.enabled`              | `true`               | Consolidate a conversation before rotating its native session                                                                                     |
| `consolidation.models`               | `{claude: "sonnet"}` | Model per provider (`claude`, `codex`, `gemini`); a provider without one uses the account's model                                                 |
| `consolidation.effort`               | `low`                | `low`, `medium`, `high`, `xhigh` or `max`                                                                                                         |
| `consolidation.thresholdBytes`       | `0`                  | Off; the daily pass replaces it. A positive value: raw history not yet consolidated, in bytes, that triggers consolidation and a planned rotation |
| `consolidation.daily.enabled`        | `true`               | One pass per channel per local day when it has new history and is idle; no rotation                                                               |
| `consolidation.daily.hour`           | `4`                  | Local hour, 0 to 23, at or after which the daily pass may run                                                                                     |
| `consolidation.daily.timezone`       | unset                | IANA zone for the daily pass; unset uses `runtime.timezone`, else the host's zone                                                                 |
| `consolidation.daily.maxCallsPerDay` | `120`                | Daily-pass calls per 24 hours, separate from `maintenance.maxCallsPerDay`                                                                         |
| `consolidation.daily.tailChunks`     | `8`                  | Newest history chunks a daily pass reads; an older backlog stays in raw history                                                                   |
| `consolidation.requestedTailChunks`  | `2`                  | Newest history chunks a pass requested after a compaction reads, 1 to 100                                                                         |
| `consolidation.chunkChars`           | `120000`             | Characters per chunk, 2000 to 400000                                                                                                              |
| `consolidation.maxChunksPerPass`     | `8`                  | Chunks per pass, 1 to 1000                                                                                                                        |
| `consolidation.timeoutMs`            | `600000`             | Time limit per pass, 1000 to 3600000                                                                                                              |
| `memoryReview.enabled`               | `true`               | Run consistency reviews                                                                                                                           |
| `memoryReview.models`                | `{claude: "sonnet"}` | Review model per provider; a provider without one uses the account's model                                                                        |
| `memoryReview.effort`                | `low`                | `low`, `medium`, `high`, `xhigh` or `max`                                                                                                         |
| `memoryReview.debounceMs`            | `30000`              | Quiet time after new activity before a review                                                                                                     |
| `memoryReview.minIntervalMs`         | `300000`             | Minimum time between reviews of one scope                                                                                                         |
| `memoryReview.intervalMs`            | `0`                  | Off: the daily pass covers quiet channels. A positive value (at least 60000) reviews a scope after that age                                       |
| `memoryReview.chunkChars`            | `80000`              | Characters per chunk, 2000 to 400000                                                                                                              |
| `memoryReview.maxChunksPerPass`      | `4`                  | Chunks per pass, 1 to 1000                                                                                                                        |
| `memoryReview.timeoutMs`             | `300000`             | Time limit per pass, 1000 to 3600000                                                                                                              |

An older file that sets `research.consolidator.enabled`, `models` or `effort` still works: those values carry over to `runtime.consolidation` unless it sets them itself. See [memory lifecycle](memory-lifecycle.md) for what these passes do.

## Voice notes

| Field           | Default   | Meaning                                                              |
| --------------- | --------- | -------------------------------------------------------------------- |
| `voice.enabled` | `false`   | Turn audio attachments into text on this host before the turn        |
| `voice.python`  | `python3` | Python interpreter; a value containing `/` is a path                 |
| `voice.asrDir`  | `asr`     | Directory with the speech model                                      |
| `voice.script`  | unset     | Transcription script; unset uses the bundled `scripts/transcribe.py` |

`scripts/install-voice.sh` installs the model. See [voice notes](customize.md#voice-notes).

## Working alone

| Field                           | Default      | Meaning                                                                                             |
| ------------------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `workAlone.enabled`             | `false`      | Give the agent the `work_alone` and `continue_work` tools and wake it after quiet stretches         |
| `workAlone.quietMinutes`        | `60`         | Minutes with no turn running before a conversation that works alone is woken                        |
| `workAlone.staleHours`          | `24`         | Hours without progress after which working alone switches off                                       |
| `workAlone.morning.enabled`     | `false`      | Send a morning where-we-are message in each recently active conversation; needs `workAlone.enabled` |
| `workAlone.morning.cron`        | `40 3 * * *` | When the morning message runs                                                                       |
| `workAlone.morning.timezone`    | unset        | Time zone for `cron`; unset uses `runtime.timezone`, then the host's zone                           |
| `workAlone.morning.activeHours` | `24`         | Conversations with user input within this many hours get the morning message                        |

See [working alone](customize.md#working-alone).

## Subagent sandbox

| Field                  | Default | Meaning                                                                                                                                                          |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.workers`      | `false` | Run subagent shell commands in a sandbox: bubblewrap for Claude (`scripts/worker-sandbox.sh`), Codex's `workspace-write` mode for Codex. The lead is not covered |
| `sandbox.writable`     | `[]`    | Extra writable paths for sandboxed subagents, absolute or starting with `~/`                                                                                     |
| `sandbox.offlineRoles` | `[]`    | Subagent roles that get no network inside the sandbox                                                                                                            |

See [worker sandbox](customize.md#worker-sandbox).

## Environment and files

The CLI picks the state directory from `CLAWSTRUM_HOME`, then reads `.env` in it. Each line must be a single `NAME=value` assignment; a value that spans lines or an unclosed quote is rejected with its line number, without printing the value. Variables already set in the environment take precedence. `.env` cannot move the state directory.

New directories Clawstrum creates are private (`0700`). The configuration, `.env`, instruction files, exports, snapshots and transferred files are written `0600`. `clawstrum doctor` reports a `.env` or configuration file that others can read. Storage is not encrypted, and the agent has full access to the host, so it can change these files too.

`clawstrum init` refuses to overwrite an existing `config.json`. It writes the configuration, creates `AGENTS.md` and `.env` when they are missing, and creates `skills/` with the bundled skills. It is not a repair tool.
