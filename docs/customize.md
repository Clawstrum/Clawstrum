# Customizing Clawstrum after installation

Every change below can be made by hand or by asking the agent in any channel, for example "add my tool server", "make a skill for our imaging protocol", "stop posting progress updates here" or "set up a weekly self-review". The bundled `customize` skill tells the agent where each piece lives and how it takes effect. Nothing on this page is enabled by default.

`H` is `$CLAWSTRUM_HOME` (default `~/.clawstrum`). `W` is a conversation's workspace, `H/channels/<discord-channel-id>/`.

| To change                           | Edit                                                                    | Takes effect                                 |
| ----------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| Behavior in every channel           | `H/AGENTS.md`                                                           | Live, at the next input or tool              |
| Behavior in one channel             | `W/AGENTS.md`                                                           | Live                                         |
| A reusable procedure                | `H/skills/<name>/SKILL.md` (all channels) or `W/skills/<name>/SKILL.md` | Next turn                                    |
| Writing rules for research prose    | `WRITING.md` in `H` or `W`                                              | Next check                                   |
| Your own tools                      | `mcpServers` in `H/config.json`                                         | After a restart                              |
| Hooks (Claude turns only)           | `W/.claude/settings.json`, or `settings.json` in a Claude account home  | Next turn                                    |
| Accounts, routing, limits, channels | `H/config.json`                                                         | After a restart                              |
| Clawstrum's own code                | `src/` in a source checkout, then `clawstrum apply`                     | After the restart `apply` requests           |
| Voice notes to text                 | `voice` in `H/config.json`, names in `voice-words.txt`                  | After a restart; word lists at the next note |
| Working alone while you are away    | `workAlone` in `H/config.json`                                          | After a restart                              |
| Worker shell sandbox                | `sandbox` in `H/config.json`                                            | After a restart                              |

Start with the smallest scope that does the job: one channel before all channels, instructions or a skill before configuration, configuration before code. See [instruction files and refresh](instructions.md) for how AGENTS.md scopes combine.

## Your own tools

List MCP servers in `config.json`. Clawstrum gives them to lead turns on both Claude and Codex, next to its own tools; research workers and maintenance passes do not get them. The name `clawstrum` is reserved.

```json
"mcpServers": {
  "microscope": { "command": "/opt/scope/bin/scope-mcp", "args": ["--config", "/opt/scope/limits.json"], "env": {} }
}
```

Restart after editing. Agents have full host access, so a limit stated in a prompt or checked inside Clawstrum is not a boundary. Hard limits for anything that acts on the physical world (stage travel, beam dose, pumps, deletion of raw data) belong in the tool server itself, ideally under a separate operating-system account.

## Hooks

Clawstrum loads Claude's user, project and local settings, so Claude's own hook format works without code changes. Put per-channel hooks in `W/.claude/settings.json`. Hooks for every conversation on one Claude account go in that account's home, which Clawstrum passes as `CLAUDE_CONFIG_DIR`. Codex turns do not run these hooks; a rule that must hold for both providers belongs in code.

## Code

The guided install and the one in [setup](setup.md) run Clawstrum from its git checkout (`npm link`), so the source sits next to the build. By hand:

```sh
npm ci
npm run check
npm link
clawstrum init
```

The compiled archive (`npm pack`) contains `dist/` only. Everything above this section works with it; code changes do not.

After editing `src/`, run `clawstrum apply`. It type-checks, builds and runs the test suite in a temporary copy of the checkout, so a failed step changes nothing and the running build is never touched. On success it stages the new build and requests a drained restart; an agent running it finishes its turn instead of waiting. The new build goes live at that restart. If it then fails to start three times, Clawstrum returns to the previous build on its own and `clawstrum doctor` reports it. `clawstrum rollback` returns to the previous build by hand, or discards a staged build that has not gone live yet. `--no-test` skips the test suite and keeps the type check and build.

Upstream changes are a separate step: keep local changes on a branch and merge or rebase when you pull.

## Worker sandbox

Off by default. A subagent reads text nobody here wrote (web pages, papers, repositories) and acts on it with the daemon user's rights; with `sandbox.workers` on, its shell commands run inside bubblewrap (`scripts/worker-sandbox.sh`). The lead is never sandboxed.

```json
"sandbox": { "workers": true, "writable": ["~/projects/data"], "offlineRoles": ["coder"] }
```

For a Claude subagent each Bash call runs with the filesystem read-only except `/tmp`, the worker directory and `writable`; `H/.env`, `config.json`, `accounts/`, `runtime/` (account tokens), transcripts, history, reviews, diagnostics, the database and every channel's history hidden, also when `H` is reached through a symlink; `$HOME` dotfiles (`.ssh`, `.netrc`, logins, `~/.config`, the Hugging Face token) hidden except toolchains (`.local`, `.nvm`, `.conda`, `.mamba`, `.cache`, `.npm` and similar); key-looking environment variables dropped; `/run/munge` and `/run/user/<uid>` hidden and `sbatch`/`srun`/`salloc`/`scancel`/`scontrol`/`squeue`/`sacct` replaced by a refusal, so no SLURM access; no network for roles in `offlineRoles`. Read, Edit, Write, Grep and Glob run outside the sandbox, so they are refused on the hidden paths, and Grep or Glob over a directory that contains one (`H`, `$HOME`, `/`, a channel workspace) is refused with a pointer to a subdirectory. Each shell call costs about 0.5 s more. Bubblewrap must be installed on the host; without it subagent shell commands fail with a message saying so.

Codex subagents run in Codex's own `workspace-write` sandbox instead: writable are the worker directory, `/tmp` and `writable`, network follows `offlineRoles`, and escalation requests are declined. Codex's sandbox limits writes and network only: reads stay allowed, so a Codex worker can still read Clawstrum's key files, history and `$HOME` dotfiles.

Not covered: the lead (Claude or Codex), reads by Codex workers, and anything a worker reaches through MCP tools.

## Voice notes

Off by default. When on, every audio attachment, Discord voice messages included, is turned into text before the turn, on the host Clawstrum runs on, by a small open speech-to-text model (NVIDIA Parakeet TDT 0.6B v2, English, through sherpa-onnx). Nothing goes to an outside service. The agent gets the transcript, a note that names may be misheard, and the audio file's path; the history archive keeps the transcript.

```sh
PYTHON=python3 scripts/install-voice.sh   # ~630 MB into H/asr; safe to re-run
```

Then add `"voice": { "enabled": true, "python": "python3" }` to `config.json` and restart. `python` must be the interpreter the installer used. `asrDir` (default `asr`, relative to `H`) and `script` move the install and the transcriber.

Names and jargon go one per line in `H/voice-words.txt` (every channel) or `W/voice-words.txt` (one channel), and the model is nudged toward them. Words that appear three or more times in `AGENTS.md` and are rare in ordinary speech are added on their own. When a name keeps coming out as a common word, add a `heard -> meant` line, for example `Jeff -> Jev`: the transcript then reads `Jeff [Jev?]` and keeps the heard word, since it may be what was said. The agent is asked to add each correction it makes.

One note is transcribed at a time, using up to four cores: about 5 s to load the model plus roughly the note's length (an 8 s note took 12 s on a cluster login node). On a shared host it competes with the agents for CPU. A failure leaves the message as it was and tells the agent why.

## Working alone

Off by default. When on, you can hand the agent work to do without you ("keep going on the sweep overnight"), and it keeps working instead of waiting for your next message.

```json
"workAlone": { "enabled": true, "quietMinutes": 60, "staleHours": 24, "morning": { "enabled": false, "cron": "40 3 * * *" } }
```

The agent gets two tools. `work_alone` switches the mode on for one conversation, with your words and the time as the ask, and off with a one-line end report when the work is done, blocked or nothing worth doing is left. `continue_work` hands itself the next step as the next turn; only one such step can be queued at a time, and each call is logged.

While the mode is on, a conversation that has been quiet for `quietMinutes` (no message, reply or turn ending) and has no turn running gets a wake that repeats the ask and names its pending watches and cluster jobs. The hourly watch status message is skipped for it. If nothing has moved for `staleHours` (no message from you, no message or step from the agent, no cluster job change), the mode switches itself off. While on, the agent messages you only for a result that changes an answer, a blocker, or the end report.

The morning message is a separate switch, `morning.enabled`, also off by default. At `morning.cron` (in `morning.timezone`, else `runtime.timezone`, else the host zone) every conversation where you wrote in the last `activeHours` is woken to get ready for you: read what finished overnight, finish work that needs no decision from you, and send one short message saying where things stand, what was done and what could come next. A conversation with nothing to report stays silent.

## Self-review

Setup turns it on: when it makes or picks your main channel, it schedules a nightly self-review there (`review.channelId` in `config.json`, at `review.at`). Without that it is off. Ask the agent to "review the last week" for one review, or to "set up a weekly self-review" for a schedule. It follows the bundled `self-review` skill: `clawstrum review collect` gathers each day's messages and metrics without a model call, and a schedule is a task created with `clawstrum tasks add`. Say what it may change. Edits to its own skills and instructions take effect live; code changes go through `clawstrum apply`, and only when you have allowed them.
