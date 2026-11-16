# Configuration

Clawstrum reads `config.json` from `CLAWSTRUM_HOME` (default `~/.clawstrum`). `clawstrum setup` or `clawstrum init` writes a first version, and [templates/config.example.json](../templates/config.example.json) is a fuller example. The schema in [src/config.ts](../src/config.ts) wins when this page disagrees.

## Loading

- Unknown fields are an error. Missing optional fields take the defaults below.
- Clawstrum validates a configuration before writing it and replaces the file atomically.
- `~` expands to your home. Relative account homes, executables and voice paths resolve against `CLAWSTRUM_HOME`.
- Account IDs are unique, and two accounts of one provider can't share a home.
- Most changes need a restart. The daemon applies `discord.channelIds` and `accounts` within a few seconds (see [subscriptions](subscriptions.md#account-registry)). An invalid file is reported once and the running configuration stays.
- A running turn keeps the configuration it started with. `AGENTS.md` and skills are read again on each attempt.

## Top level

- `version` is `1` and required.
- `name` is the agent name, `Clawstrum` by default. It shows in logs and the dashboard. In a channel with another bot, a message naming it counts as addressed to it.
- `discord` and `accounts` are required. Both are below, with `review`, `runtime`, `voice`, `workAlone` and `sandbox`.
- `research` is in [research configuration](research.md#configuration-reference), `groups` in [channel groups](groups.md), and `decisions` (Jev or OpenRouter) in [Jev](jev.md#configuration).
- `mcpServers` adds stdio MCP servers for the lead agent by name, each `{command, args=[], env={}}`, default `{}`. Names match `[A-Za-z0-9_-]+`, and `clawstrum` is reserved.

## Discord

An ID is 5 to 25 digits.

| Field                               | Default             | Meaning                                                                                           |
| ----------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| `discord.tokenEnv`                  | `DISCORD_BOT_TOKEN` | Variable that holds the bot token                                                                 |
| `discord.ownerIds`                  | required, nonempty  | Owners' user IDs                                                                                  |
| `discord.guildId`                   | unset               | Accept server input only from this server, and register the slash command there                   |
| `discord.applicationId`             | unset               | Saved by setup to print the invite link again. Unused at run time                                 |
| `discord.channelIds`                | `[]`                | Channels the agent answers in, with their threads. Empty means no server channel                  |
| `discord.noticeChannelId`           | unset               | Channel for quota warnings, account and model switches, group-review issues and `doctor --notify` |
| `discord.plainDashes`               | `true`              | Replace em and en dashes in outgoing prose with hyphens. Code, quotes, paths and URLs stay        |
| `discord.sendAdviceChars`           | `0`                 | Above 0, a sent message longer than this still goes out and the agent is asked to be shorter      |
| `discord.allowDMs`                  | `true`              | Accept DMs from allowed senders                                                                   |
| `discord.newConversationLookbackMs` | `86400000`          | How far back a newly registered channel reads                                                     |
| `discord.allowAllSenders`           | `false`             | Accept input from non-owners. Controls stay owner-only                                            |
| `discord.respondToBots`             | `false`             | Accept other bots that pass the sender and channel rules                                          |
| `discord.mentionOnlyWithBots`       | `true`              | Where another bot also answers, keep messages not addressed to this agent as context only         |
| `discord.dashboard.enabled`         | `false`             | Keep a forum showing configuration, instructions, skills and tools                                |
| `discord.dashboard.channelName`     | `dashboard`         | Forum name to find or create, 1 to 100 characters                                                 |
| `discord.dashboard.channelId`       | unset               | Use this forum as is. Must not be in `discord.channelIds`                                         |
| `discord.dashboard.categoryId`      | unset               | Category for a created forum                                                                      |
| `discord.dashboard.syncIntervalMs`  | `600000`            | Full sync interval, 60000 to 86400000                                                             |
| `discord.dashboard.watchIntervalMs` | `60000`             | Changed-file check interval, 10000 to 86400000                                                    |
| `discord.dashboard.viewerIds`       | unset               | Who sees the forum. Unset means every owner                                                       |

## Self-review

| Field              | Default | Meaning                                                                   |
| ------------------ | ------- | ------------------------------------------------------------------------- |
| `review.channelId` | unset   | Channel for the nightly self-review. Must also be in `discord.channelIds` |
| `review.at`        | `03:00` | 24-hour time, in `runtime.timezone` or the host's zone                    |

`clawstrum review schedule --channel ID` sets both and registers the task. See [self-review](customize.md#self-review).

## Accounts

| Field                     | Default          | Meaning                                                                                                              |
| ------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`                      | required         | Up to 80 characters from `A-Z a-z 0-9 _ -`                                                                           |
| `provider`                | required         | `claude`, `codex` or `gemini`                                                                                        |
| `home`                    | required         | Where the provider keeps login, settings and sessions. Separate from your usual CLI login                            |
| `priority`                | `0`              | -1000 to 1000. Automatic routing tries higher first                                                                  |
| `model`                   | provider default | Passed to the SDK unchecked                                                                                          |
| `effort`                  | provider default | `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. Claude rejects `ultra`                                           |
| `quotaBuckets`            | `[]`             | Quota limits that apply only to the primary `model`                                                                  |
| `modelFallbacks`          | `[]`             | Ordered `{model, quotaBuckets=[]}` on the same login and concurrency cap. Needs `model`. No model twice              |
| `tokenEnv`                | unset            | Claude only: variable holding an OAuth token for this account                                                        |
| `executable`              | bundled          | Provider executable to use. Must support `--version`. Gemini has none bundled, see [Gemini](subscriptions.md#gemini) |
| `maxConcurrent`           | `4`              | Concurrent runs, 1 to 64                                                                                             |
| `owner`, `label`, `notes` | unset            | Description for people. Never a secret                                                                               |

The buckets `five_hour`, `seven_day`, `5h`, `7d` and `unknown` can't be scoped to a model. See [subscriptions](subscriptions.md) for routing, fallback and quota warnings.

## Runtime

All fields are under `runtime`.

| Field                                | Default              | Meaning                                                                                                                     |
| ------------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `maxConcurrent`                      | `4`                  | Conversations at once, 1 to 64                                                                                              |
| `debounceMs` / `debounceMaxMs`       | `1500` / `15000`     | Quiet time that ends a burst of messages, and the longest wait. Max ≥ `debounceMs`                                          |
| `typingMaxMs`                        | `300000`             | Longest wait while you're shown typing. At least `debounceMaxMs`                                                            |
| `startupTimeoutMs`                   | `120000`             | Deadline for the provider's first event, at least 100                                                                       |
| `silenceTimeoutMs` / `turnTimeoutMs` | `600000` / `7200000` | Silence and total turn limits. 0 is off. Silence isn't counted while a tool or live background task runs                    |
| `queuedInputTimeoutMs`               | `120000`             | A message that can't enter a busy turn idle this long ends it and starts a new one. 0 is off                                |
| `scheduledMaxTurns`                  | `0`                  | Turn budget for scheduled runs, 0 (no limit) to 1000. Codex can go one over                                                 |
| `shellCpuSeconds`                    | `0`                  | Soft CPU seconds per process for Claude agent shell commands. 0 is off. `sbatch`, `srun` and `salloc` lift it. Not on Codex |
| `timezone`                           | host zone            | IANA zone for the agent's clock, time stamps, self-review and usage reports                                                 |
| `abortGraceMs`                       | `3000`               | Grace for a cooperative abort, 100 to 10000                                                                                 |
| `inputReleaseGraceMs`                | `10000`              | How long a Claude input stream stays open after background work settles, 0 to 60000                                         |
| `promptChars`                        | `100000`             | Context characters the host adds to a prompt, 8000 to 1000000                                                               |
| `historyChars`                       | `32000`              | Characters of recent portable history, 2000 to 200000                                                                       |
| `unknownQuotaCooldownMs`             | `900000`             | Lifetime of a quota observation with no reset time, at least 1000                                                           |
| `proactiveThreshold`                 | `0.95`               | Usage, 0 to 1, at which a route with a known reset stops being used                                                         |
| `quotaWarningThreshold`              | `0.9`                | Usage, 0 to 1, for a warning and preferring other routes. 1 turns preference off                                            |
| `maxAttempts`                        | `3`                  | Fast retries for a transient failure, 1 to 10                                                                               |
| `slowRetryMs`                        | `300000`             | Slow retry interval after that, 0 or at least 60000. 0 makes the fast limit final                                           |
| `blockedVersions`                    | `[]`                 | Provider CLI versions to refuse, each `{provider, version, reason}`                                                         |
| `attachmentMaxBytes`                 | `26214400`           | Size limit per file in or out                                                                                               |

Clawstrum checks the provider's `--version` before each run. `clawstrum doctor` reports blocked versions and `clawstrum smoke` honors them. An unlisted version isn't known to work.

`nativeSessionMaxTurns`, `nativeSessionMaxBytes` and `nativeSessionMaxAgeMs` still load but do nothing. Remove them.

### Background passes

See [memory](memory-lifecycle.md) for what these do. Models are per provider (`claude`, `codex`, `gemini`). A provider without one uses the account's model. Effort is `low`, `medium`, `high`, `xhigh` or `max`.

| Field                                | Default              | Meaning                                                                          |
| ------------------------------------ | -------------------- | -------------------------------------------------------------------------------- |
| `maintenance.maxCallsPerDay`         | `24`                 | Calls per rolling 24 hours, 0 to 10000. 0 pauses all but the daily pass          |
| `maintenance.minIntervalMs`          | `1800000`            | Time between call starts, 0 to 86400000                                          |
| `maintenance.maxConcurrent`          | `1`                  | Calls at once, 1 to 16                                                           |
| `maintenance.requestedReserve`       | `6`                  | Calls kept for passes after a compaction, at most a quarter of the total         |
| `maintenance.scanIntervalMs`         | `60000`              | How often due passes are checked, 1000 to 3600000                                |
| `consolidation.enabled`              | `true`               | Run consolidation, including the daily pass                                      |
| `consolidation.models`               | `{claude: "sonnet"}` | Model per provider                                                               |
| `consolidation.effort`               | `low`                | Effort                                                                           |
| `consolidation.thresholdBytes`       | `0`                  | Off. A positive value consolidates with a fresh session at that much new history |
| `consolidation.daily.enabled`        | `true`               | One pass per channel per local day, when it has new history and is idle          |
| `consolidation.daily.hour`           | `4`                  | Local hour, 0 to 23, from which it may run                                       |
| `consolidation.daily.timezone`       | unset                | Zone. Unset uses `runtime.timezone`, else the host's                             |
| `consolidation.daily.maxCallsPerDay` | `120`                | Calls per 24 hours, separate from `maintenance`                                  |
| `consolidation.daily.tailChunks`     | `8`                  | Newest chunks it reads                                                           |
| `consolidation.requestedTailChunks`  | `2`                  | Newest chunks a pass after a compaction reads, 1 to 100                          |
| `consolidation.chunkChars`           | `120000`             | Characters per chunk, 2000 to 400000                                             |
| `consolidation.maxChunksPerPass`     | `8`                  | Chunks per pass, 1 to 1000                                                       |
| `consolidation.timeoutMs`            | `600000`             | Time limit per pass, 1000 to 3600000                                             |
| `memoryReview.enabled`               | `true`               | Run memory reviews                                                               |
| `memoryReview.models`                | `{claude: "sonnet"}` | Model per provider                                                               |
| `memoryReview.effort`                | `low`                | Effort                                                                           |
| `memoryReview.debounceMs`            | `30000`              | Quiet time after activity before a review                                        |
| `memoryReview.minIntervalMs`         | `300000`             | Time between reviews of one scope                                                |
| `memoryReview.intervalMs`            | `0`                  | Off. A positive value (at least 60000) reviews a scope after that age            |
| `memoryReview.chunkChars`            | `80000`              | Characters per chunk, 2000 to 400000                                             |
| `memoryReview.maxChunksPerPass`      | `4`                  | Chunks per pass, 1 to 1000                                                       |
| `memoryReview.timeoutMs`             | `300000`             | Time limit per pass, 1000 to 3600000                                             |

Old `research.consolidator.enabled`, `models` and `effort` values still apply unless `runtime.consolidation` sets them.

## Voice notes

| Field           | Default   | Meaning                                                   |
| --------------- | --------- | --------------------------------------------------------- |
| `voice.enabled` | `false`   | Transcribe audio attachments on this host before the turn |
| `voice.python`  | `python3` | Python interpreter. A value with `/` is a path            |
| `voice.asrDir`  | `asr`     | Directory with the speech model                           |
| `voice.script`  | unset     | Transcription script. Unset uses `scripts/transcribe.py`  |

`scripts/install-voice.sh` installs the model. See [voice notes](customize.md#voice-notes).

## Working alone

| Field                           | Default      | Meaning                                                                            |
| ------------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| `workAlone.enabled`             | `false`      | Give the agent `work_alone` and `continue_work`, and wake it after quiet time      |
| `workAlone.quietMinutes`        | `60`         | Minutes with no turn before a conversation working alone is woken                  |
| `workAlone.staleHours`          | `24`         | Hours without progress before working alone stops                                  |
| `workAlone.morning.enabled`     | `false`      | Morning status message in recently active conversations. Needs `workAlone.enabled` |
| `workAlone.morning.cron`        | `40 3 * * *` | When it runs                                                                       |
| `workAlone.morning.timezone`    | unset        | Zone for `cron`. Unset uses `runtime.timezone`, then the host's                    |
| `workAlone.morning.activeHours` | `24`         | Conversations with your input within this many hours get it                        |

See [working alone](customize.md#working-alone).

## Subagent sandbox

| Field                  | Default | Meaning                                                                                                                       |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.workers`      | `false` | Sandbox subagent shell commands: bubblewrap on Claude (`scripts/worker-sandbox.sh`), `workspace-write` on Codex. Not the lead |
| `sandbox.writable`     | `[]`    | Extra writable paths, absolute or starting with `~/`                                                                          |
| `sandbox.offlineRoles` | `[]`    | Subagent roles with no network in the sandbox                                                                                 |

See [worker sandbox](customize.md#worker-sandbox).

## Environment and files

The CLI reads `.env` in `CLAWSTRUM_HOME`. Each line is one `NAME=value`. A multi-line value or unclosed quote is rejected with its line number, without printing the value. Variables already set win. `.env` can't move the state directory.

New directories are `0700`. The configuration, `.env`, instruction files, exports, snapshots and transferred files are `0600`. `clawstrum doctor` reports a `.env` or configuration others can read. Storage isn't encrypted, and the agent has full host access.

`clawstrum init` refuses to overwrite `config.json`. It creates `AGENTS.md`, `.env` and `skills/` if missing. It isn't a repair tool.
