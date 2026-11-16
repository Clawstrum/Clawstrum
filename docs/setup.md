# Setup

## Quick start

With Claude Code or Codex on this computer, the easiest start is to open one of them in the repository folder and say "help me install Clawstrum" (in Claude Code, `/setup`). It follows `.claude/skills/setup/SKILL.md`: one question at a time, each step checked before the next, and the bot token never typed into the chat. Without either, install from the clone and run setup:

```sh
git clone https://github.com/clawstrum/clawstrum.git
cd clawstrum
npm ci
npm run build
npm link
clawstrum setup
```

`npm link` puts a `clawstrum` command on the PATH that runs this folder, so the agent can later change Clawstrum's own code here ([customizing](customize.md)). Keep the folder where it is. `npm ci` must install optional packages: they hold the Claude and Codex programs. Gemini's program, Antigravity CLI (`agy`), is installed separately; see [subscriptions.md](subscriptions.md#gemini-antigravity-cli-over-acp).

It walks you through checking Node, naming your agent, choosing Claude, Codex or Gemini, creating the Discord bot and inviting it, saving the bot token, entering your Discord IDs, logging in and starting the agent; run it again to resume where you left off. When you give a channel, setup makes it the main channel and schedules the nightly self-review there. At the end it asks Discord whether the bot token works and the bot can see your server and channel. To change the agent name, provider or Discord IDs later, run `clawstrum setup --reconfigure`: each question shows the current value in brackets, Enter keeps it, and only those fields in `config.json` change. `clawstrum setup --help` lists all options.

For a coding agent guiding someone through the install, two options need no prompts. `clawstrum setup --status` prints JSON: Node, `config.json`, whether a bot token is saved (never the token), what Discord reports for that token (bot, Message Content Intent, invite link, servers with their owner, text channels and whether the bot may manage channels), the main channel, whether the nightly self-review is scheduled and the provider sign-in, plus `next` (`save-token`, `message-content-intent`, `invite-bot`, `main-channel`, `login` or `start`) and a `hint` for that step. It writes nothing. `clawstrum setup --main-channel NAME` finds the text channel NAME in the bot's server, or creates it when the bot has Manage Channels, and makes it the first entry of `discord.channelIds`. NAME is normalized as Discord does (lowercase, spaces become `-`). Without a `config.json` it creates one as setup does; the owner is the one in `config.json`, else `--owner`, else the server owner, and only the owner can talk to the agent. Pass `--provider` unless an earlier setup run saved it; with an existing `config.json`, a different `--owner`, `--provider` or `--name` is an error (use `--reconfigure`). It also schedules the nightly self-review in the main channel unless `review.channelId` already names another channel. `--guild ID` picks the server when the bot is in several. It also adds short sections on the main channel and the review to that channel's `AGENTS.md`. The review needs Node.js 22.16 or newer; setup warns on older versions. A running agent reads a changed `config.json` after `clawstrum restart request`. For a project channel, `clawstrum setup --add-channel NAME` finds or creates it in the configured server the same way and appends it to `discord.channelIds`; the running daemon picks that up within seconds, without a restart.

## Manual setup

### Discord

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable **Message Content Intent** on the bot. Clawstrum needs message content to receive normal conversation text. The switch sits under Privileged Gateway Intents on the Bot page, and without it `clawstrum start` fails with "disallowed intents".
3. Install the bot in your server with `bot` and `applications.commands` scopes. Give it View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, Attach Files and Add Reactions in the channels you intend to use, and Manage Channels, so the agent can make its main channel and, when asked, a channel per project. The Application ID on General Information is the same number as the OAuth2 "Client ID", not the Public Key.
4. Enable Discord Developer Mode (User Settings (gear icon) > Advanced (under App Settings) > Developer Mode) and copy your user ID, server ID and channel ID. To copy your user ID, right-click your name in the member list or on one of your messages (on a phone, long-press).
5. Run `clawstrum init`, or use the non-interactive form below. Put the bot token in the generated private `.env` file. Reset Token on the Bot page shows a new token and stops any bot already running on the old one.

```sh
clawstrum init --provider codex \
  --owner 123456789012345678 \
  --guild 345678901234567890 \
  --channel 234567890123456789
```

Discord's API calls a server a "guild", which is why the flag is `--guild`. Omit server and channel to use direct messages only; the bot still has to be in a server you are in. Owners' DMs are accepted when `allowDMs` is true (the default). Additional owners/channels can be added as arrays in `config.json`. By default, non-owners and bot-authored messages are ignored. `allowAllSenders=true` admits other senders in configured guild channels/threads and, if `allowDMs=true`, their DMs too. It is not a separate collaborator allowlist. `respondToBots=true` additionally admits bot messages that pass the sender/channel rules; the bot's own messages are always ignored. Both options default to false. Text and slash controls remain restricted to human owners, including when collaboration is enabled. Set `allowDMs=false` if collaboration should be confined to the configured guild routes. A registered parent channel permits its threads; each thread keeps a separate conversation.

Read Message History enables bounded recovery on startup, reconnect and periodic sweeps, including discoverable configured channels and threads. Each newly registered conversation gets a 24-hour lookback; each channel is limited to 1,000 messages per sweep. Slash controls are registered when the service connects. The text form `!clawstrum status` works without waiting for global slash-command propagation. Clawstrum uses a gateway bot connection, not a public webhook endpoint.

Clawstrum does not send automatic “Received” or “Message queued” messages. It attempts a small receipt reaction instead. The first conversational update comes from the active model through `send_message`: a short acknowledgment naming your request and the specific next action, such as “I'll read the analysis scripts and check the steps against the latest results.” This uses the normal agent turn, with no separate acknowledgment model call. It depends on the model starting and following the instruction; it is not a guarantee of immediate attention.

Useful operational notices, such as capacity waits and slow retries, go inside a real Discord thread attached to the latest admitted human message. Conversation-local quota warnings do too. A Slurm job watcher's errors, a job this account cannot see, and a research subagent queued with no eligible account do not post to that thread; they wake the lead as a task input instead, so the lead decides what, if anything, to tell the people here. A new thread is named **Clawstrum updates** and archives after an hour of inactivity; existing message threads are reused without renaming. Threads are created only when there is a notice to deliver. Inputs already inside a thread use that thread. Agent acknowledgments, answers, command responses and terminal failures stay in the conversation. An explicit `discord.noticeChannelId` sends quota alerts, account/model switch notices and [automatic group-review discussions](groups.md#issue-discussions) directly to that operator channel, including the affected conversation. Group-review delivery failures retry there instead of posting into a source channel.

DMs have no threads. When a thread is unavailable, actionable notices fall back to the conversation. Failed thread delivery cannot block the main reply queue. Partial deliveries retain their original destination and resume there. Suppression/fallback is recorded in events, and unsent automatic receipts left by older versions are retired quietly. Replies you choose to send inside a notice thread follow the usual independent-thread conversation behavior. Discord allows only one thread per starter message; see its [thread creation API](https://docs.discord.com/developers/resources/channel#start-thread-from-message).

Plain-hyphen formatting is on by default (`discord.plainDashes=true`). Set it to `false` in `config.json` and restart to keep prose dash characters. When enabled, outbound prose replaces em/en dashes and horizontal bars with spaced hyphens; numeric en-dash ranges become plain hyphens. Code spans/fences, indented code, quoted strings, paths/URLs, file contents and paragraph boundaries are preserved. The same policy applies before MCP/automatic-answer deduplication and at Discord delivery. Already-frozen delivery chunks keep their original text on retry, including after a configuration change.

### Provider and service

```sh
clawstrum account login main
clawstrum doctor
clawstrum start
```

`doctor` checks configuration, token presence, SQLite integrity, bundled runtimes, local login, daemon heartbeat, queued/running work, schedules, delivery failures and configuration permissions. A new installation without work is distinguished from a dead daemon. It does not test the bot token against Discord or call a model. `clawstrum smoke main` is the separate authenticated model test.

At its first start after setup, the agent writes first in the main channel: who it is, what the channel is for and a few ideas to make it yours. This happens once, and not on an installation that already has a conversation there or has finished onboarding.

For Codex on a machine without a browser, use `clawstrum account login main --device`. The login runs against the profile home, which `init` places inside the Clawstrum directory. For Gemini, `clawstrum account login ID` runs `agy acp --login`: open the link it prints in any browser and paste the code back (no `--device` needed). For Claude profile availability and the Gemini details, read [subscriptions.md](subscriptions.md).

Restart the daemon after adding an account or changing JSON configuration. Switching among loaded accounts is a runtime control and needs no service restart.

## Configuration

The [configuration reference](configuration.md) documents fields, defaults and validation, and the [CLI reference](cli.md) every command. The example in `templates/config.example.json` is usable with real Discord IDs and authenticated profiles. Core commands require Node 22.13+, and live snapshots/review collection require 22.16+. CI runs on Linux and macOS with Node 22 and 24; Windows is not validated. Restart after JSON configuration changes.

## Model fallback and quota notices

An account can select a fallback model while keeping its login and concurrency cap. Use model IDs available to that subscription and the exact quota bucket names reported by its runtime. For example, a **configuration fragment** replacing the illustrative model names:

```json
{
  "id": "claude-main",
  "provider": "claude",
  "home": "accounts/claude-main/claude",
  "model": "YOUR_PRIMARY_MODEL",
  "quotaBuckets": ["seven_day_overage_included"],
  "modelFallbacks": [{ "model": "YOUR_FALLBACK_MODEL", "quotaBuckets": ["seven_day_opus"] }]
}
```

This illustrates explicit mappings, not a claim that a particular model consumes these buckets. A legacy quota watcher observed the short name `7d_oi`; Clawstrum does not guess its equivalence to another runtime’s label. Only configure a mapping supported by your runtime/account evidence. General five-hour/weekly and unidentified limits always cover the whole account. With no mappings, rejection remains conservative at account level. Existing account-wide cooldowns from an older configuration remain until expiry or an explicit `clawstrum account reset ACCOUNT`. Model changes start fresh native context with a portable handoff.

`quotaWarningThreshold=0.9` posts at most one notice per account/bucket/reset window (hourly when no reset is known). Set `discord.noticeChannelId` to send these warnings to an operator channel, including before its first conversation; otherwise they go to the observing conversation. The bot needs permission to send to that channel. Automatic account routing softly prefers routes below the warning level within each configured model tier, respecting mapped model buckets; a warning alone does not select a lower tier. Explicit account preferences retain pressure-first ordered fallback behavior. If every available route is strained, work still proceeds. Unknown-reset pressure expires after `unknownQuotaCooldownMs`; a threshold of 1 disables soft avoidance. `proactiveThreshold=0.95` can exclude the short window or mapped model bucket before rejection. When changing a primary model, review its `quotaBuckets` too: a model-specific bucket must not accidentally move to its replacement. Structured percentages are available only where the runtime emits them: Claude quota events and Codex App Server lead/subagent notifications. Codex scheduled lead SDK runs use reactive classification. Codex App Server buckets retain `<limitId>:primary|secondary` names and are not automatically relabeled as Claude five-hour/weekly buckets. See [subscription routing](subscriptions.md#quota-observations). No polling endpoint or paid probe is introduced.

Transient outages now receive fast retries followed by `slowRetryMs=300000` background retries. Set it to `0` to restore terminal failure after `maxAttempts`. `stop` cancels queued/running work. Native session size/turn/age limits retire old sessions without deleting transcripts; these settings and runtime-version quarantine are described in the configuration reference.

The private `.env` accepts one assignment per line. Keep tokens on a single line; wrapped/unclosed values produce a line-number error without printing their contents. Initialization preserves preexisting `AGENTS.md` and `.env` files.

## Computational research

Research, consolidation and Slurm helpers are enabled by default. Run `clawstrum research enable --email you@example.org` to add your literature-service contact, then restart. Existing explicit `false` settings are honored; set the desired `enabled` fields to `true` to opt back in. PDF extraction uses the optional host `pdftotext` executable; Slurm needs site commands in the daemon environment. See [research.md](research.md) for all tools, role configuration, monitoring, records and validation modes. The default is advisory and retains unrestricted host tools.

For an existing installation, complete the [offline memory migration](memory-lifecycle.md#existing-installations) before starting the new schema-4 daemon. Fresh installations create unified AGENTS.md documents and channel-ID workspace paths.
