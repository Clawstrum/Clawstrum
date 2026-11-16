---
name: customize
description: Change Clawstrum itself when the user asks: instructions, skills, tool servers, hooks, configuration or code, each at the right scope and applied safely.
triggers: customize, customise, configure clawstrum, clawstrum config, tool server, mcp server, add a skill, add a hook, clawstrum code, voice notes, transcription
not_for: The user's research, data or analysis; editing a project's files; a single reply in a different style (just do it).
examples: add my microscope tool server | make a skill for our imaging protocol | in this channel, stop posting progress updates | set up a weekly self-review | change how Clawstrum handles attachments
---

Use when the user wants Clawstrum to behave differently from now on. The full map is `docs/customize.md` in the Clawstrum package. `$CLAWSTRUM_HOME` is `~/.clawstrum` unless set.

1. Pick the smallest scope that does the job. One channel before all channels. Instructions or a skill before configuration. Configuration before code. Say which you chose.
   - Behavior: `$CLAWSTRUM_HOME/AGENTS.md` for every channel, the workspace `AGENTS.md` for this one. Live, no restart. Standing instructions go outside `## MEMORY`.
   - A procedure the user will want again: a skill at `$CLAWSTRUM_HOME/skills/<name>/SKILL.md` (or the workspace `skills/`), with the same frontmatter as this file. Picked up next turn.
   - The user's own tools: an entry under `mcpServers` in `$CLAWSTRUM_HOME/config.json` (`command`, `args`, `env`), then a restart. Their limits belong in the tool server, not in instructions.
   - Voice notes to text: run `scripts/install-voice.sh` from the Clawstrum package, set `voice.enabled` in `config.json`, then a restart (`docs/customize.md`, Voice notes). Names go in `voice-words.txt` in `$CLAWSTRUM_HOME` or the workspace, live.
   - Hooks: Claude's own settings format in the workspace `.claude/settings.json`. Claude turns only.
   - Accounts and the channel list (`accounts`, `discord.channelIds` in `config.json`): live within a few seconds. Other limits and routing: `config.json`, then a restart.
   - Code: only in a source checkout (`src/` next to `dist/`). Never edit `dist/`.
2. Read the file before changing it and keep the user's existing rules. Make the change.
3. Other configuration changes need a restart: run `clawstrum restart request` without `--wait` and finish the turn.
4. Code changes: edit `src/`, add or adjust a test, run `clawstrum apply` with a long command timeout (it runs the whole test suite), which tests the change in a separate copy and requests the restart itself, and finish the turn. If a step fails, the running build is unchanged: read its output, fix and run it again, or stop and report. After the restart, check that the change works. `clawstrum rollback` returns to the previous build.
5. Tell the user in two or three lines what changed, in which file, and when it takes effect. Do not push or open a pull request unless asked.

Self-review runs only when the user asks for one or sets a schedule; then follow the `self-review` skill. Changing its own instructions and skills is fine within what the user allowed; code changes need the user's go.
