# Setup

You need Linux or macOS and Node.js 22.13 or newer. Live database snapshots and the nightly self-review need 22.16. CI runs on Linux and macOS with Node 22 and 24. Windows isn't tested.

## Guided setup

Open Claude Code, Codex or Antigravity CLI (Gemini) in the repository folder. In Claude Code, type `/setup`. In the others, say "help me install Clawstrum". The agent follows [.claude/skills/setup/SKILL.md](../.claude/skills/setup/SKILL.md): one question at a time, each step checked before the next.

By default you put the bot token into the private `.env` file yourself, from a second terminal. You can paste it in the chat instead. The agent then saves it to `.env` without repeating it, but the token stays in the chat's records with the model provider, so the file is safer. The agent never reads `.env`. It only checks that the token line is there.

## Terminal wizard

```sh
git clone https://github.com/clawstrum/clawstrum.git
cd clawstrum
npm ci
npm run build
npm link
clawstrum setup
```

`npm link` puts `clawstrum` on your PATH, running this folder, so the agent can later change its own code here ([customizing](customize.md)). Keep the folder in place. `npm ci` must install optional packages, because they hold the Claude and Codex programs. Antigravity CLI (`agy`) for Gemini is installed separately. See [subscriptions](subscriptions.md#gemini).

`clawstrum setup` checks Node, SQLite and the optional `pdftotext` and `sbatch`, then asks for the agent name and provider, takes you through the Discord application and invite link, the bot token and your Discord IDs, signs you in and runs `doctor`. Run it again to resume. If you give a channel, it becomes the main channel and gets the nightly self-review. With a saved token, the last step asks Discord whether the token works and the bot can see your server and channel. Without `sbatch`, a new `config.json` gets `research.slurm.enabled: false`.

To change the name, provider or Discord IDs later, run `clawstrum setup --reconfigure`. Each question shows the current value in brackets, and Enter keeps it.

A coding agent guiding an install uses options that ask nothing:

- `clawstrum setup --status` prints JSON: what is configured, what Discord reports for the saved token (never the token itself), and `next`, one of `save-token`, `message-content-intent`, `invite-bot`, `main-channel`, `login` or `start`, with a `hint`.
- `clawstrum setup --main-channel NAME` finds or creates the text channel NAME (the bot needs Manage Channels to create it) and makes it the first entry of `discord.channelIds`. NAME is lowercased and spaces become `-`, as in Discord. `--guild ID` picks the server when the bot is in several. It schedules the nightly self-review there, unless `review.channelId` names another channel, and adds short notes on both to that channel's `AGENTS.md`. Without `config.json` it creates one, with the owner from `--owner`, else the server owner. Pass `--provider` unless setup saved one. With an existing `config.json`, a different `--owner`, `--provider` or `--name` is an error. A running agent reads the change after `clawstrum restart request`.
- `clawstrum setup --add-channel NAME` does the same for a project channel. The running daemon picks it up within seconds.

`clawstrum setup --help` and the [CLI reference](cli.md#setup-and-running) list every option.

## Manual setup

### Discord bot

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. On the Bot page, under Privileged Gateway Intents, turn on Message Content Intent. Without it `clawstrum start` fails with "disallowed intents".
3. Install the bot in your server with the `bot` and `applications.commands` scopes. In the channels you use, give it View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, Attach Files and Add Reactions. Add Manage Channels so the agent can create its main channel and project channels. The Application ID on General Information is the OAuth2 Client ID, not the Public Key.
4. Turn on Developer Mode (User Settings > Advanced > Developer Mode). Copy your user ID (right-click your name, or long-press on a phone), the server ID and the channel ID.
5. Run `clawstrum init`, or the form below, then put the bot token in the generated `.env`. Reset Token on the Bot page shows a new token and stops any bot still using the old one.

```sh
clawstrum init --provider codex \
  --owner 123456789012345678 \
  --guild 345678901234567890 \
  --channel 234567890123456789
```

Clawstrum connects to Discord's gateway and needs no public webhook endpoint. Discord's API calls a server a guild. Leave out server and channel to use direct messages only. The bot still has to be in a server you're in. `init` keeps an existing `AGENTS.md` and `.env`.

### Provider sign-in and start

```sh
clawstrum account login main
clawstrum doctor
clawstrum smoke main
clawstrum start
```

- On a machine without a browser, Codex signs in with `clawstrum account login main --device`.
- For Gemini, `account login` runs `agy acp --login`. Open the link it prints in any browser and paste the code back.
- `doctor` doesn't test the bot token against Discord or call a model. `smoke` is the model test.

At its first start the agent writes first in the main channel. It does this once, and not if the channel already has a conversation.

Account changes apply to the running daemon within seconds. Other `config.json` changes need a restart. See the [configuration reference](configuration.md) and the example [templates/config.example.json](../templates/config.example.json).

### Running as a service

On Linux with systemd, install the unit from `clawstrum service`. On macOS or a cluster login node, run the daemon in tmux under a restart loop. The guided setup writes that loop for you. See [operations](operations.md#running-as-a-service).

## Senders and channels

By default the agent answers only owners, in configured channels, their threads and DMs. Each thread is its own conversation. Bots, including itself, are ignored. `discord.allowAllSenders: true` admits anyone there (set `discord.allowDMs: false` to keep them out of DMs), and `discord.respondToBots: true` admits other bots. Controls stay owner-only. Add owners and channels as arrays in `config.json`. `!clawstrum status` works before the slash command has spread through Discord.

With Read Message History, Clawstrum catches up on missed messages at startup, on reconnect and in periodic sweeps, at most 1,000 per channel per sweep. A new conversation reads back 24 hours.

## Notices

Clawstrum sends no automatic "Received" message. It adds a reaction, and the agent's first reply, if the model follows its instructions, says what it will do next.

Waiting and retry notices and conversation quota warnings go into a thread on your latest message, named "Clawstrum updates" when Clawstrum creates it, which archives after an hour idle. In DMs, or without a thread, they go to the conversation. Answers, command replies and final failures always go to the conversation. Slurm watcher errors and subagents with no eligible account wake the agent instead. With `discord.noticeChannelId` set, quota warnings, account and model switches and [group-review issues](groups.md#issues) go there.

## Research tools and upgrades

Research tools, consolidation and Slurm helpers are on by default. To add a literature-service contact or turn Slurm back on, see [research](research.md#setup).

An existing install older than schema 4 needs the [offline memory migration](memory-lifecycle.md#upgrading-an-older-install) before the new daemon starts.
