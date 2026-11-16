# Customizing

You can make every change below by hand, or ask the agent in any channel: "add my tool server", "make a skill for our imaging protocol", "stop posting progress updates here", "set up a weekly self-review". The bundled `customize` skill tells the agent where each piece lives and when a change takes effect. Except for the nightly self-review that setup schedules, nothing on this page is on by default.

`H` is `$CLAWSTRUM_HOME` (default `~/.clawstrum`). `W` is a conversation's workspace, `H/channels/<discord-channel-id>/`.

| To change                        | Edit                                                                    | Takes effect                                 |
| -------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| Behavior in every channel        | `H/AGENTS.md`                                                           | Live, at the next input or tool              |
| Behavior in one channel          | `W/AGENTS.md`                                                           | Live                                         |
| A reusable procedure             | `H/skills/<name>/SKILL.md` (all channels) or `W/skills/<name>/SKILL.md` | Next turn                                    |
| Writing rules for research prose | `WRITING.md` in `H` or `W`                                              | Next check                                   |
| Your own tools                   | `mcpServers` in `H/config.json`                                         | After a restart                              |
| Hooks (Claude turns only)        | `W/.claude/settings.json`, or `settings.json` in a Claude account home  | Next turn                                    |
| Accounts and the channel list    | `accounts`, `discord.channelIds` in `H/config.json`                     | Within a few seconds                         |
| Routing and limits               | `H/config.json`                                                         | After a restart                              |
| Clawstrum's own code             | `src/` in a source checkout, then `clawstrum apply`                     | After the restart `apply` requests           |
| Voice notes to text              | `voice` in `H/config.json`, names in `voice-words.txt`                  | After a restart; word lists at the next note |
| Working alone while you are away | `workAlone` in `H/config.json`                                          | After a restart                              |
| Worker shell sandbox             | `sandbox` in `H/config.json`                                            | After a restart                              |
| Self-review schedule             | `review` in `H/config.json`, set by `clawstrum review schedule`         | After a restart                              |

Start with the smallest scope that does the job: one channel before all channels, instructions or a skill before configuration, configuration before code. See [instruction files](instructions.md) for how the `AGENTS.md` files combine.

## Your own tools

List MCP servers under `mcpServers` in `config.json` and restart. Lead turns get them on Claude and Codex. Subagents and background passes don't. The name `clawstrum` is reserved.

```json
"mcpServers": {
  "microscope": { "command": "/opt/scope/bin/scope-mcp", "args": ["--config", "/opt/scope/limits.json"], "env": {} }
}
```

Agents have full host access, so a limit written in a prompt is not a boundary. Put hard limits for anything that acts on the physical world (stage travel, beam dose, pumps, deleting raw data) in the tool server, ideally under a separate system account.

## Hooks

Clawstrum loads Claude's user, project and local settings, so Claude's hook format works as is. Hooks for one channel go in `W/.claude/settings.json`, and hooks for every conversation on one Claude account go in that account's home (`CLAUDE_CONFIG_DIR`). Codex turns don't run them, so a rule that must hold on both providers belongs in code.

## Code

The guided install and [setup](setup.md) run Clawstrum from its git checkout through `npm link`. By hand:

```sh
npm ci
npm run check
npm link
clawstrum init
```

An `npm pack` archive has the build but no `src/`. The rest of this page works with it, but code changes don't.

After editing `src/`, run `clawstrum apply`. It type-checks, builds and tests a temporary copy, so a failure changes nothing. On success it stages the build and requests a drained restart, and an agent running it ends its turn instead of waiting. If the new build fails to start three times, Clawstrum goes back to the previous one and `clawstrum doctor` reports it. `clawstrum rollback` does the same by hand, or drops a staged build that isn't live yet. `--no-test` skips the tests. Keep local changes on a branch and merge or rebase when you pull.

## Worker sandbox

Off by default. With `sandbox.workers` on, a Claude subagent's shell commands run inside bubblewrap (`scripts/worker-sandbox.sh`), which must be installed. Each call takes about 0.5 s longer. The lead is never sandboxed.

```json
"sandbox": { "workers": true, "writable": ["~/projects/data"], "offlineRoles": ["coder"] }
```

In the sandbox, only `/tmp`, the worker directory and `writable` can be written. Hidden, also through a symlinked `H`: `H/.env`, `config.json`, `accounts/`, `runtime/`, transcripts, history, reviews, diagnostics, the database, every channel's history, and `$HOME` dotfiles such as `.ssh`, `.netrc`, `~/.config` and logins. Tool folders such as `.local`, `.nvm`, `.conda`, `.mamba`, `.cache` and `.npm` stay visible. Key-like environment variables are dropped. Slurm commands refuse and `/run/munge` and `/run/user/<uid>` are hidden. Roles in `offlineRoles` get no network.

Read, Edit, Write, Grep and Glob run outside the sandbox and refuse the hidden paths, including a Grep or Glob over a folder that holds one, such as `H` or `$HOME`.

Codex subagents use Codex's `workspace-write` sandbox instead. They can write only to the worker directory, `/tmp` and `writable`, network follows `offlineRoles`, and escalation is declined. They can still read Clawstrum's key files, history and dotfiles. The sandbox doesn't cover the lead or MCP tools. Gemini subagents run without a sandbox.

## Voice notes

Off by default. When on, every audio attachment, Discord voice messages included, becomes text before the turn. The speech model (NVIDIA Parakeet TDT 0.6B v2, English, through sherpa-onnx) runs on the Clawstrum host, and no audio leaves it. The agent gets the transcript, a note that names may be misheard, and the audio file's path.

```sh
PYTHON=python3 scripts/install-voice.sh   # ~630 MB into H/asr; safe to re-run
```

Then add `"voice": { "enabled": true, "python": "python3" }` to `config.json` and restart. `python` must be the interpreter the installer used. `asrDir` (default `asr`, relative to `H`) and `script` move the install and the transcriber.

Put names and jargon one per line in `H/voice-words.txt` (every channel) or `W/voice-words.txt` (one channel). Rare words that appear three or more times in `AGENTS.md` are added automatically. For a name that keeps coming out wrong, add a line such as `Jeff -> Jev`, and the transcript reads `Jeff [Jev?]`. The agent is asked to add each correction it makes.

Notes are transcribed one at a time on up to four cores, in about 5 s plus the note's length. They compete with the agents for CPU. If transcription fails, the agent gets the message unchanged with the reason.

## Working alone

Off by default. When on, you can hand the agent work ("keep going on the sweep overnight") and it keeps going without waiting for you.

```json
"workAlone": { "enabled": true, "quietMinutes": 60, "staleHours": 24, "morning": { "enabled": false, "cron": "40 3 * * *" } }
```

The agent's `work_alone` tool turns the mode on for one conversation, with your words as the task, and off with a one-line report. `continue_work` queues its own next step, one at a time. While the mode is on, a conversation quiet for `quietMinutes` with no turn running is woken with the task and its pending watches and jobs, and the hourly watch status message is skipped. After `staleHours` with no message, step or job change, the mode turns itself off. The agent messages you only for a result that changes an answer, a problem it can't get past, or the end report.

The morning message is a separate switch, `morning.enabled`, off by default. At `morning.cron` (in `morning.timezone`, else `runtime.timezone`, else the host's zone), each conversation you wrote in during the last `activeHours` (default 24) is woken. The agent reads what finished overnight, does what needs no decision from you, and sends one short status message, or nothing if there is nothing to report.

## Self-review

Setup schedules a nightly self-review in the main channel (`review.channelId` in `config.json`, at `review.at`, default 03:00 in `runtime.timezone` or the host's zone). Without that it is off. To add it later, in a quiet channel:

```sh
clawstrum review schedule --channel ID [--at HH:MM] [--timezone ZONE]
```

`clawstrum init --review-channel ID [--review-at HH:MM]` does the same at install time. Both add the channel to `discord.channelIds`, create its session and `AGENTS.md`, and register one task per channel, so a second run updates it. You can also ask the agent to "review the last week", or to "set up a weekly self-review", which it does with `clawstrum tasks add`.

The review follows the bundled `self-review` skill: find a failure in the record, make a small change, predict its effect and check it later. Say what it may change. Edits to its skills and instructions take effect live. Code changes go through `clawstrum apply`, and only if you allowed them. When there is nothing to report, the task answers `CLAWSTRUM_QUIET`.

The skill collects evidence with these commands, which make no model calls and need Node 22.16 or newer:

```sh
clawstrum review pending --from 2026-09-10 --through 2026-09-16 --config review.json
clawstrum review collect --date 2026-09-16 --config review.json
clawstrum review complete --date 2026-09-16 --report /private/review-report.md
```

```json
{
  "timezone": "America/New_York",
  "sessions": [],
  "excludeAuthors": [],
  "replyWindowMinutes": 60,
  "longReplyChars": 1200
}
```

`collect` also takes `--from` and `--through`, at most 31 dates, and `pending` up to 366. The default range is the seven days ending yesterday. `sessions: []` means all. Output goes to `H/reviews` unless you pass the same `--output DIRECTORY` every time. Each date gets `MESSAGES.json`, `TRANSCRIPT.md`, `METRICS.json` and a receipt. The metrics (replies, reply times, long replies, inputs left unanswered) are rough guides.

Collecting doesn't mark a date reviewed. `review complete` records the report's path and checksum. A missing or changed report, changed settings or a new collection make the date pending again.
