# Instructions shared by Claude, Codex and Gemini

Use `AGENTS.md` for agent identity, preferences and standing instructions. Clawstrum reads the same files and supplies their contents to either backend, including Claude runtimes that do not discover AGENTS.md themselves. Switching providers requires no file renaming or duplicate instructions. Tone and message style are in the `## How you talk` section of the shared `AGENTS.md`; edit it like any other section. In front of these files, lead runs get a fixed base prompt ([templates/base-prompt.md](../templates/base-prompt.md)) in place of the provider's built-in prompt; it changes only with a Clawstrum release. For the exact assembly order, literal harness boilerplate and provider roles, see [system prompt structure](system-prompt.md).

| File                                | Role                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `$CLAWSTRUM_HOME/AGENTS.md`         | Shared identity and behavior for all conversations                                   |
| `<workspace>/AGENTS.md`             | Additional instructions for this conversation                                        |
| `## MEMORY` inside either AGENTS.md | Current facts, work, research state and archive/coverage pointers for that scope     |
| `SELF.md`, `CLAUDE.md`              | Legacy instruction sources, used only when that scope has no nonempty canonical file |

Clawstrum loads profile instructions, shared instructions, member-group instructions in sorted group-ID order, then workspace instructions. G/AGENTS.md is at `H/groups/<id>/AGENTS.md`; its SQLite-backed MEMORY board is contextual data. See [channel groups](groups.md). More local instructions take precedence. At each scope, nonempty `AGENTS.override.md` takes precedence for standing instructions; canonical AGENTS.md MEMORY remains visible. If neither exists, Clawstrum reads existing `SELF.md` and `CLAUDE.md` together. `SELF.md` was Clawstrum's identity convention; `CLAUDE.md` is Claude's native convention; neither is required for a new Clawstrum installation. Initialization creates AGENTS.md, preserving an existing canonical file and importing existing legacy identity text when present.

## Editable behavioral policy

Put behavioral instructions outside `## MEMORY`. H/AGENTS.md controls shared identity, acknowledgments, writing style, progress reporting and research workflow preferences. W/AGENTS.md supplies channel-specific preferences. MEMORY holds contextual facts and current work rather than standing instructions.

New installations seed shared instructions from [templates/AGENTS.md](../templates/AGENTS.md). Its communication section asks the lead agent to acknowledge each human request, including live steering, with the specific next action before tools. Scheduled/internal wakes stay quiet unless useful. The template also includes skill selection, evidence checking, delegation and memory habits.

The seed is used only when a shared document is missing. Existing AGENTS.md content, including deleted rules and an empty instruction section, remains authoritative. Editing an installed file uses the existing live-refresh mechanism across both providers; editing the shipped template does not change an existing deployment. More local instructions follow shared ones, but contradictory prose still needs to be reconciled by the author/model.

When upgrading from a version with hardcoded behavioral guidance, merge the desired sections from the template into the existing shared instruction section. Preserve the deployment's identity, custom rules and MEMORY. There is no automatic rewrite that can reinstate a deliberately removed preference.

The context builder retains dynamic workspace identity, the skill catalog, enabled capabilities and the small delivery/refresh protocols. Tool schemas and dedicated subagent/maintenance role contracts stay with their runtime interfaces. For example, whether to send a progress update is policy; what `final=true` does is a delivery contract.

## Imports and migration

A standalone `@path/to/file.md` line imports another instruction file. Relative paths resolve against the importing file, quoted paths may contain spaces, symlink targets are deduplicated, and cycles do not repeat content. Lines inside fenced code blocks do not import files. Ordinary prose links do not make an artifact an instruction. Changes and deletions of imports are tracked along with the entrypoint files. Imported text remains subject to the configured context budget. Canonical policies receive space before imported notes; oversized files receive separate excerpts so one long decision history cannot remove another scope’s policy. Source revisions expose edits even inside omitted text, and excerpts identify the files to read when their contents matter. The budget must still be large enough for the policies themselves.

To migrate an existing installation, combine its intended identity and standing instructions into AGENTS.md at the same scope. Preserve legacy files as backups outside instruction-discovery paths, or use a compatibility symlink if an older standalone tool still needs CLAUDE.md. Do not leave independent, conflicting copies. Update `@` imports to point to the canonical files. A shared policy imported by several workspaces is tracked independently in every affected conversation.

Clawstrum itself expands these imports for both providers. Native tools used outside Clawstrum have their own discovery/import rules; the `@` syntax is not a promise that every standalone tool expands imports identically.

## Refresh without losing history

Instruction and memory changes no longer invalidate an otherwise compatible native session. Account switches, incompatible execution configuration, completed consolidation and recovery conditions can still replace it. Existing pre-upgrade fingerprints are upgraded in place, with explicit instruction refresh before continued work.

- Claude receives `--system-prompt-snapshot off`, so a new SDK invocation can replace the system prompt while resuming the native session. During an active invocation, Clawstrum supplies updated file-backed context before tool calls and live user input. It also restores the current snapshot after compaction. Native subagents have separate refresh acknowledgments.
- Gemini (Antigravity CLI; ACP has no developer-instruction field) receives the base prompt (lead runs) and the instructions at the start of a new session's first prompt, after Google's own prompt, which cannot be replaced, and changed instructions as a `CLAWSTRUM_CONTEXT_UPDATE` block at the start of the next prompt. It cannot receive them during a running turn.
- Codex receives changed developer instructions through `thread/inject_items` before a resumed turn. During active work, a one-second check delivers changed instructions into the existing thread. Live user steering also checks before submission. Memory is delivered separately as context, not as developer instructions. This path also covers scheduled Codex lead runs.
- Shared edits affect all conversations that load the file; workspace memory stays local. No Discord acknowledgement or extra user turn is generated by a refresh. A memory-only update during a run does not repeat the unchanged instruction block.
- Acknowledged revisions are recorded against the native session ID. Repeated checks do not repeatedly inject unchanged snapshots. Queued, failed or unacknowledged updates are not treated as delivered.

“Immediate” means the next model step after delivery. An edit cannot alter an already submitted model request or an already executing tool. Claude's active process refreshes at its input/tool boundaries; idle conversations pick up changes when next invoked. Delegated research subagents load the same scoped instructions; maintenance summarizers receive dedicated prompts with applicable instructions included as context (see the provider-native discovery distinction in [system prompt structure](system-prompt.md#7-other-model-calls)). A change to compiled harness prompt text requires deploying the new code; editing daemon configuration requires its normal reload/restart workflow.

Claude native discovery excludes the sources Clawstrum already supplies, avoiding duplicated or stale legacy copies. Other native rules and managed instructions keep their normal discovery. Codex native discovery may also load project files. Clawstrum's current snapshot explicitly supersedes earlier file-backed instructions so a stale native copy is not authoritative. As with any natural-language instruction, delivery does not prove model compliance.

## Runtime compatibility

The implementation is verified against bundled Claude Code 2.1.270 and Codex 0.154.0. Claude's native AGENTS.md discovery was introduced in 2.1.277 and has provider, feature-flag and project-instruction-setting conditions. Clawstrum's explicit loader avoids depending on those conditions. Custom executables must support the snapshot flag or Codex item-injection RPC respectively.

See [Claude instruction discovery](https://code.claude.com/docs/en/memory#agentsmd), [Claude system-prompt snapshots](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations), [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md), and [Codex item injection](https://learn.chatgpt.com/docs/app-server#inject-items-into-a-thread).

Existing separate memory/checkpoint/research files require the offline [memory migration](memory-lifecycle.md#existing-installations); do not leave them as competing active sources.
