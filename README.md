<h1 align="center">Clawstrum</h1>

<p align="center">
  An AI research collaborator that lives in your Discord, runs on your own server and keeps adapting to how you work.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/index.md">Documentation</a> ·
  <a href="docs/customize.md">Customizing</a> ·
  <a href="LICENSE">MIT license</a>
</p>

<p align="center">
  <img src="docs/images/workflow.png" width="600" alt="Your messages in Discord and events from your code, cluster and the web pass through Clawstrum to Claude Code, Codex or Gemini. Clawstrum improves over time and can keep the agent working while you are away.">
</p>

Clawstrum runs Claude Code, Codex or Gemini as a collaborator you talk to in Discord, with one channel per project. It is designed for coding agents' SDKs and the Agent Client Protocol (ACP), and works with Claude, GPT and Gemini. It runs on a machine you give it, with full shell, file and network access. It writes to you when a job ends or a result comes in, keeps each project's memory in plain files and changes its own setup when you tell it what went wrong.

## Quick start

You need Linux or macOS, Claude Code or Codex to run the setup, and a Claude, ChatGPT or Google subscription with Gemini for the agent.

```sh
git clone https://github.com/clawstrum/clawstrum.git
cd clawstrum
claude        # or: codex
```

Type `/setup` in Claude Code, or say "help me install Clawstrum" in Codex. The agent walks you through the rest one step at a time and checks each step before the next.

1. It asks where the agent will run: your computer, a server or a cluster. Then it installs Clawstrum from this folder, so the agent can later change its own code, and a current Node.js if you agree.
2. It takes you through Discord, with a link to each page: an account and a server if you need them, then the bot. The bot token goes into a file, never into the chat.
3. It invites the bot and makes your first channel, `main`.
4. It signs the agent in to Claude, ChatGPT or Google, starts it and keeps it running: as a service, or in tmux on a cluster login node, with the agent's heavy work sent to jobs.

Then open `main`. The agent writes first: who it is, a few ideas to make it yours and one question. That first conversation is about you: your field, how you like answers, the projects you want, each in its own channel, and where your work runs. It also offers voice notes and a few optional keys. You can skip any question or stop halfway, and it writes nothing without your yes. `main` is also where you tell the agent what to improve.

To install without an agent, see [setup](docs/setup.md).

## What it does

- **One channel per project.** Each Discord channel has its own conversation, files and memory. By default only the owners you configure can give it work.
- **Live steering.** A message you send while the agent works goes into the run that is already going, so you can correct or add to a request without stopping it. This also works after its answer while work it started still runs, and the agent can send a correction to a subagent it started. Claude and Codex runs only: on Gemini a message waits until the current run ends. A message with a file attached waits too, on every provider.
- **Keeps watch for you.** The agent can watch a file, a command or a cluster job, or schedule a run for later. Clawstrum waits without calling the model and wakes the agent when something happens. An optional mode keeps it working toward your goal while you are away.
- **A prompt that is yours.** Main runs replace the coding agent's default system prompt, written for software engineering, with Clawstrum's base prompt for a research collaborator. Your `AGENTS.md` instructions follow it, including how you like answers. Both are plain files you can change. On Gemini, whose prompt can't be replaced, the base prompt opens each new session's first message.
- **Memory you can read.** Memory lives in plain `AGENTS.md` files, from one for all channels down to one per channel. Decisions you state are saved in your own words, and every message and tool result stays searchable.
- **Improves itself.** Once a day it rewrites each channel's memory from the new conversation and cites the records behind each change. A nightly self-review in `main` looks for what went wrong, proposes or makes small fixes within the scope you allow, and checks later whether they worked.
- **Habits in the harness.** Skills hold recurring procedures and are picked before each run. On Claude runs, hooks check each tool call before it executes. Side work goes to subagents with fixed roles, such as explorer, coder, checker and reviewer.
- **Research tools.** Literature search, paper retrieval with citation checks, Slurm jobs, scheduled runs, and channel groups that share findings between related projects.
- **Your accounts.** Spread work over several subscription accounts. When one reaches its limit, work moves to another, and each conversation can use its own model.

## Make it yours

Clawstrum is built to change while you use it. Tell the agent in any channel what went wrong or what you want, and it edits its instructions, skills, settings or code, starting with the smallest scope that does the job. Clawstrum runs from your clone, so code changes work too: they go through `clawstrum apply`, which type-checks, builds and tests a copy before Clawstrum restarts on it ([customizing](docs/customize.md)). Keep your changes in your own copy, and send back the ones that would help others as a pull request.

## Security

Every message the agent accepts runs with full access to the machine.

- Run Clawstrum as its own user, on a server or cluster account set aside for it.
- Text the agent reads, such as a web page or another bot's message, can carry instructions that it may follow.
- On Claude runs, a hook blocks common commands that print a secret file such as `.env` or the whole environment. It is a pattern check, not a barrier: other ways of reading a file get through, and it is off when `research.enabled` is false. Codex and Gemini runs do not have this check yet.
- `send_file` refuses Clawstrum's keys, logins, history and database, home dotfiles and secret files such as `.env`, on every provider. A copy under another name still goes out.

## Commands

In Discord, use `/clawstrum` or the text form.

```text
!clawstrum status
!clawstrum accounts
!clawstrum switch backup
!clawstrum stop
!clawstrum resume
!clawstrum reset
```

`switch` stops the current work and continues it on another account. `stop` cancels running and queued work. `resume` retries what failed or was delayed. `reset` starts a fresh session and keeps files and history. On the server, `clawstrum --help` lists every command.

## Documentation

[Setup](docs/setup.md) · [Configuration](docs/configuration.md) · [CLI](docs/cli.md) · [Customizing](docs/customize.md) · [Live steering](docs/live-steering.md) · [Memory](docs/memory-lifecycle.md) · [Research tools](docs/research.md) · [Channel groups](docs/groups.md) · [Operations](docs/operations.md) · [Testing](docs/testing.md) · [All docs](docs/index.md)

## Authors

Jorin Overwiening and Xu Pan

## License

Clawstrum's code is MIT licensed. Provider SDKs keep their own licenses and service terms. Clawstrum descends from NanoClaw, see [NOTICE](NOTICE).
