# Instructions

`AGENTS.md` files hold the agent's identity, preferences and standing instructions. Clawstrum reads them itself and passes them to Claude, Codex and Gemini, so switching providers needs no renamed or copied files. [Memory](memory-lifecycle.md#files) lists the files and their load order.

## Base prompt

Lead runs start with Clawstrum's base prompt, [templates/base-prompt.md](../templates/base-prompt.md), in place of the provider's built-in prompt, followed by your `AGENTS.md` instructions. It changes only with a Clawstrum release. Subagents and background passes keep the provider's default. Gemini's prompt can't be replaced, so there the base prompt opens each new session.

## Editing

- Put standing instructions anywhere in an `AGENTS.md` outside its `## MEMORY` section. That section holds current facts and work, not instructions.
- `H/AGENTS.md` sets shared behavior for all channels, such as acknowledgments, writing style, progress reports and research habits. A channel's own `AGENTS.md` adds preferences for that channel.
- Tone and message style are in the `## How you talk` section of the shared `AGENTS.md`. Edit it like any other section.
- More local files come after shared ones and take precedence. Clawstrum does not resolve contradicting text for you, so fix the conflict in the files.
- At each scope, a nonempty `AGENTS.override.md` replaces that scope's instructions. The memory section of `AGENTS.md` still loads.
- If a scope has no nonempty `AGENTS.md` or `AGENTS.override.md`, Clawstrum reads `SELF.md` and `CLAUDE.md` there instead. A new install needs neither.
- Group instructions live in `H/groups/<id>/AGENTS.md`. See [channel groups](groups.md).

Edits apply without a build or restart.

## Default instructions

A new install seeds `H/AGENTS.md` from [templates/AGENTS.md](../templates/AGENTS.md). It asks the agent to answer each request, including one sent mid-run, with one line on its next step before using tools, and to stay quiet on scheduled wakes unless something is useful. It also covers skills, evidence checks, subagents and memory.

The template is used only when the shared file is missing. Your file stays authoritative, including deleted rules and an empty instruction section, and editing the template doesn't change it. To pick up new defaults after an upgrade, merge the sections you want into your shared file. Nothing restores a rule you removed.

## Imports

A line holding only `@path/to/file.md` imports that file. Quoted paths such as `@"file name.md"` may contain spaces.

- Relative paths resolve against the importing file.
- Lines inside fenced code blocks and ordinary Markdown links don't import anything.
- Each file loads once, even through symlinks or cycles. Imports nest at most 20 deep and reach at most 256 files.
- A missing import shows as absent, and its old instructions stop applying.
- Edits to imported files refresh like edits to the main file.

Imported text counts against the instruction budget set by `runtime.promptChars`. `AGENTS.md` instructions get space before imports, and an oversized file is shortened with a pointer to the full text. See [size limits](system-prompt.md#size-limits).

Clawstrum expands imports for all providers. Claude Code or Codex run on their own, outside Clawstrum, follow their own import rules.

## Moving from older files

Merge the instructions you want into `AGENTS.md` at the same scope. Move `SELF.md` and `CLAUDE.md` away as backups, or make `CLAUDE.md` a symlink to `AGENTS.md` if another tool needs it. Point `@` imports at the new files. Separate memory, checkpoint or research files need the one-time [memory migration](memory-lifecycle.md#upgrading-an-older-install).

## Live refresh

Edits to instructions or memory reach the agent without starting a new session or losing its history.

- Claude gets changes at its next tool call or input. After a compaction it gets the current instructions again.
- Codex gets changes before a resumed turn, and during a turn within about a second. A message you send mid-run also checks first. Memory arrives separately from instructions.
- Gemini gets the base prompt and instructions at the start of a new session's first prompt, and changes at the start of the next prompt. It can't take changes during a running turn.
- An edit to the shared file reaches every channel that loads it. A channel's memory stays in that channel.
- A refresh sends nothing to Discord and doesn't count as a new request.
- An idle channel picks up changes on its next run.

An edit can't change a request already sent or a tool already running. Subagents load the same instructions, and background passes see them as context. Prompt text in the code needs a new build, and configuration changes the usual reload or restart.

Clawstrum stops Claude from loading the same files natively. Codex may still load project files itself, and Clawstrum marks its own copy as the one that applies. Delivering an instruction doesn't prove the model follows it.

## Provider versions

Clawstrum does not rely on Claude's or Codex's own `AGENTS.md` discovery. A custom Claude executable must support `--system-prompt-snapshot off`, and a custom Codex executable must support `thread/inject_items`. The bundled versions are pinned in [package.json](../package.json).

See [Claude instruction discovery](https://code.claude.com/docs/en/memory#agentsmd), [Claude system-prompt snapshots](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations), [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [Codex item injection](https://learn.chatgpt.com/docs/app-server#inject-items-into-a-thread).
