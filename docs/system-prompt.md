# System prompt and context structure

This describes the scoped-memory implementation. `H` is `CLAWSTRUM_HOME`; `W` is the channel's stored workspace, normally `H/channels/<discord-channel-id>`. The runtime source of truth is [`buildContext`](../src/context.ts), [`readInstructionSnapshot`](../src/instructions.ts), and the provider adapters. The [memory lifecycle guide](memory-lifecycle.md) describes persistence and migration.

For the exact assembly order, literal text and dynamic substitutions in `ProviderRequest.instructions`, see [the instruction composition reference](provider-instructions.md). It also distinguishes tool guidance in that string from separately registered tool schemas.

## 1. Provider request fields

| Field                          | Meaning                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `ProviderRequest.instructions` | File-backed policy, delivery/refresh protocols, workspace/capabilities, then labeled contextual MEMORY.                 |
| `ProviderRequest.prompt`       | Current input, continuity when needed, and conditional skill/review/recovery context.                                   |
| `contextRefresh`               | Source paths, separate instruction/memory hashes, current snapshot and previously acknowledged native-session revision. |
| `sessionId`                    | Compatible native Claude session/Codex thread to resume. Its absence starts a fresh native conversation.                |
| `mcp`                          | Tools and run/channel identity, delivered as tool configuration rather than a prose section.                            |

Lead runs replace the vendor's built-in prompt with Clawstrum's base prompt ([templates/base-prompt.md](../templates/base-prompt.md), loaded by [base-prompt.ts](../src/base-prompt.ts)), placed before `ProviderRequest.instructions`. Claude Code's preset and Codex's built-in instructions are not sent. Gemini's prompt cannot be replaced, so the base prompt goes at the start of the first prompt. Research subagents and maintenance calls keep the vendor defaults. Managed rules, tool descriptions and provider compaction still add context outside these fields.

In the main channel (`discord.channelIds[0]`, and threads under it) the base prompt is the main-channel one, [templates/base-prompt-main.md](../templates/base-prompt-main.md): an opening about looking after the installation with the user in place of the research-collaborator one, the same rules, a map of the code and state, then [the guides index](index.md), [the architecture guide](architecture.md) and the customize skill (the installed copy in `$CLAWSTRUM_HOME/skills/customize/` if there is one, else the bundled one). It is read for every run, so edits to these files apply from the next turn without a restart.

## 2. Standing instruction assembly

The instruction snapshot loads provider-profile, shared, member-group (sorted ID), parent channel (for Discord threads), and channel scopes, in that order. Group membership and committed board snapshots are reread through `H/groups/index.json`; a turn does not freeze its initial memberships. At each scope `AGENTS.override.md` takes precedence for instructions, while canonical AGENTS.md MEMORY remains visible; without a canonical source, legacy SELF.md and CLAUDE.md are compatibility fallbacks. New and migrated installations use AGENTS.md. Standalone `@file.md` imports are expanded outside fenced code; canonical policy receives priority over imported material in the instruction budget.

For an AGENTS document with `## MEMORY`, text outside that section contributes instructions. The MEMORY body contributes **contextual facts**, not standing policy. Legacy explicitly imported memory/checkpoint/record documents are also classified as memory while migration removes their active imports. File naming alone does not turn historical claims into policy.

`buildContext` then assembles:

1. The rendered standing-instruction snapshot. Existing files are authoritative; there is no hidden fallback policy when the instruction section is empty.
2. `REFRESH_PROTOCOL`: current file-backed policy supersedes earlier defaults; later sections replace earlier versions, including removed entries. Internal refreshes are not new user tasks.
3. `DELIVERY_PROTOCOL`: stable delivery keys, `final=true` semantics and the `CLAWSTRUM_QUIET` marker.
4. Workspace path and conversation identity.
5. A skill catalog with paths and revisions; the full catalog is available in `W/artifacts/skills-index.txt` if necessary.
6. Configured research subagent-role descriptions and actual Slurm enablement when research is enabled.
7. Current scoped MEMORY, explicitly labeled contextual facts rather than instructions or new requests.

Behavioral instructions belong in AGENTS.md outside its MEMORY section. The installation seed, [templates/AGENTS.md](../templates/AGENTS.md), includes specific acknowledgments before tools, progress/style preferences, memory conventions, skill use and research workflow guidance. [default-instructions.ts](../src/default-instructions.ts) reads that template when initializing missing shared instructions; it does not append the template to existing policy. Existing installations can merge desired sections while preserving their custom instructions and memory.

Edit H/AGENTS.md for shared behavior or W/AGENTS.md for channel preferences; those changes use live refresh without a build or restart. Only delivery/refresh protocols and dynamic runtime assembly stay in code. Their implementation is in [`context.ts`](../src/context.ts) and [`instructions.ts`](../src/instructions.ts). Research subagents and consolidation retain dedicated role/output contracts described below.

## 3. Prompt assembly and continuity

Before taking the snapshot, the context builder renders current operational research state into MEMORY when research is enabled. It then reads the current shared/channel documents.

A compatible native resume receives:

```text
History archive path and completed consolidation coverage
Current time (local, with zone)
Current input (JSON records)
Conversation ledger / delivery ownership context
Conditional skill hints, recovery guidance, and outgoing-review feedback
```

Neither fresh nor resumed human prompts contain standing MEMORY. Both receive it at the end of native system/developer instructions. This prevents native compaction from preserving a large snapshot as the latest user message. The snapshot includes current H/G/W memory and explicitly configured profile memory. Each current input has an ID, role, author, send time (`at`), text and attachment metadata. The `Current time:` line, each record's `at` and each bounded-continuation record's `at` are ISO-8601 local times with numeric offset in `runtime.timezone` (default: the host zone); the current time is in the prompt, never the instructions, so instructions stay cache-stable. Tool results show times the same way (except `group_board`, whose entries take Unix milliseconds back), and the time filters of `history` and `research_status` accept that form. Task wakes retain scheduled/internal semantics. The ledger in `W/CONVERSATION.json` reports outstanding inputs and recent delivery state; it is operational JSON, not an additional memory document.

When there is no compatible native session, the prompt additionally starts with a **bounded continuation** of recent uncovered raw records: at most 100 relevant records after the last completed consolidation, then the configured `historyChars` tail. It is labeled incomplete and points to `history` for the full interval. This continuation is not a second compaction summary and is not the permanent archive. Current input remains separate.

Consolidated knowledge is in AGENTS.md / MEMORY. No digest or candidates queue is injected. Emergency/provider handoffs can have a large uncovered interval; they do not falsely advance coverage. Planned rotation requires completed consolidation first.

Conditional additions include:

- Skill hints matched to current input, not arbitrary earlier transcript text.
- Recovery guidance to verify artifacts and already-started external actions before repeating work.
- Outgoing-review feedback for the same logical input when a correction is required.
- Harness-generated research wakes, which identify themselves as internal events.

## 4. Claude and Codex transport

For a lead run the Claude Agent SDK receives `systemPrompt` as one string, the base prompt followed by the instructions; the SDK puts one fixed line in front of it ("You are a Claude agent, built on Anthropic's Claude Agent SDK."). Research subagents and maintenance calls receive `systemPrompt: {type: 'preset', preset: 'claude_code', append: instructions}`. Prompt content goes through the SDK user-input stream. Claude resumes with `--system-prompt-snapshot off`, uses the user's subscription credentials, and retains full host access. Clawstrum excludes explicitly loaded instruction files from native discovery to avoid stale duplicates. Native managed/provider policy remains outside Clawstrum's control.

Codex App Server starts/resumes a thread with Clawstrum's developer instructions and submits the prompt as user text. A lead thread also gets `baseInstructions`, which replaces Codex's built-in instructions: the base prompt plus [templates/base-prompt-codex.md](../templates/base-prompt-codex.md), tool lines copied from Codex's own prompt for the pinned Codex version. Re-copy them when the pin changes. Resumed and live instruction replacement uses explicit `thread/inject_items` with developer content. Memory replacement travels inside the same labeled developer item; it does not create a synthetic user message. The SDK fallback uses its supported developer-instruction configuration, keeps Codex's built-in instructions and receives current memory in the next request; App Server provides the live protocol, and lead runs always use it.

Tool schemas are registered separately. Lead tools include messages/files, scheduling/watches, status, checkpoint, `memory_update`, `history` and enabled research tools. Research subagents have their own tool subset and cannot claim the lead's final reply. See [`mcp.ts`](../src/mcp.ts) and [`research/tools.ts`](../src/research/tools.ts).

## 5. Live changes and native compaction

The instruction loader hashes instruction and memory parts separately. Claude hooks send only changed instructions and changed or removed MEMORY sources; unchanged shared/group facts are not repeated. Codex replaces the combined developer instructions explicitly, including labeled MEMORY facts. Shared edits affect every channel that loads them; channel edits remain scoped to that channel and its threads. Threads retain their own conversation/history and memory writes. Successful delivery is acknowledged against the native session, so failed or pending refreshes are retried.

Native-session compatibility separately fingerprints execution settings. For Codex, `config.toml` is parsed and normalized: automatic `projects.<path>.trust_level` bookkeeping does not restart this or other channels. Clawstrum supplies its approval and sandbox policy explicitly. All other configuration fields, including other project settings, remain significant; invalid TOML falls back to hashing the unchanged source. Formatting and key order alone do not force a new session.

Claude refreshes at input and tool boundaries. Codex checks on active turns and before live steering. Idle channels receive changes on their next invocation. No file edit can change an already submitted model request or an executing tool; “immediate” means the next model step after successful delivery.

The single [compaction hook](memory-lifecycle.md#native-compaction-one-hook-no-extra-model) archives available native evidence. Claude retains standing context in native instructions and restores changes relative to the query-start snapshot after compaction. Claude uses supported compact hooks. Codex detects context-compaction completion and explicitly re-injects current sections. The hook performs no second model summary and does not reset long-term consolidation coverage.

## 6. Budgets and overflow

| Setting/artifact                       | Purpose                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `runtime.promptChars`, default 100,000 | Total constructed prompt/instruction character budget. This is not native context tokens. |
| Instruction snapshot allocation        | `max(2000, floor(promptChars * 0.6) - 4000)`; overflow names source files.                |
| `runtime.historyChars`, default 32,000 | Bounded uncovered continuation for a fresh native session.                                |
| `W/history/instructions.full.txt`      | Complete derived instruction rendering when the final instruction block overflows.        |
| `W/history/input.full.txt`             | Complete derived handoff/input rendering when the total prompt overflows.                 |
| `W/history/records/`                   | Immutable raw archive, independent of prompt fitting.                                     |

MEMORY has no separate 6,000/12,000-character file-fitting policy and no implicit size-based tool denial. If the whole request exceeds its configured budget, it spills to an explicitly named complete file. Claude hook updates exceeding 12,000 UTF-8 bytes are saved completely under `W/history/context-updates/<sha256>.txt`; the hook instructs the agent to read that immutable file in full before dependent work. No text is discarded, but delivery of a file reference does not prove the model read it. The next ordinary query installs the current snapshot directly in native instructions. Unchanged standing context is not duplicated by the compaction hook. Consolidation processes complete source chunks and pauses/resumes rather than sampling away the middle of the interval.

The derived overflow files can be replaced on subsequent turns; they are navigation aids, not immutable evidence. The raw record archive and observed document revisions provide historical evidence. A provider context rejection permits one fresh smaller handoff; persistent rejection becomes an actionable error without erasing history.

## 7. Other model calls

Research subagents receive the same scoped instruction snapshot, current memory, a configured role prompt and a narrow task brief. They retain full host access within the user's authorized work and their configured budgets. Their observable provider history is archived under the channel.

The consolidation subagent receives dedicated maintenance instructions, full source chunks, current memory, applicable standing instructions and active operational state. It returns structured section replacements or read-only evidence lookups. Native tools/external-action dispatch are disabled for this maintenance call; normal agents remain unrestricted. Per-pass progress and usage are tracked. There is no independent curator.

## 8. Inspection

Use `clawstrum status` for the stored channel workspace and native identity; inspect H/AGENTS.md, W/AGENTS.md, raw history and the latest derived overflow files. Context-budget events record rendering sizes; context-update events record acknowledged revisions. The exact request shape is defined in [`types.ts`](../src/types.ts), and transport options are in [`providers.ts`](../src/providers.ts) and [`codex-app-server.ts`](../src/codex-app-server.ts).

## Group scope and maintenance

See [channel groups](groups.md) for G/AGENTS.md ownership, complete board review, history and threaded issue routing. Membership, board and group-policy changes use the same live refresh mechanism and do not rotate native sessions. The dedicated economical reviewer receives a structured complete-board/change snapshot and a JSON reconciliation contract; it is separate from lead and research-subagent prompts. Channel consolidation can read current group context, retain entry references and local consequences, and cannot rewrite the group board.

## Memory consistency review

Default-enabled [consistency reviews](memory-lifecycle.md#regular-consistency-review) reconcile shared/channel memory separately from rotation, including evidence-backed patches to stale canonical standing instructions. Resulting AGENTS.md changes flow through the existing instruction/MEMORY refresh protocol; they do not reset native sessions. Current experimental scope and user corrections belong in active memory, while superseded detail remains in raw history.

## Evidence provenance in memory

Tracked research claims render a source-status block in AGENTS.md / MEMORY / Research state. It enters the existing contextual memory path, not a new system-policy layer. Checks before provider turns and Claude compaction restoration refresh registered dependencies. Maintenance receives the same scoped claims as `claimEvidence` and can request current source pages through its existing lookup protocol. Behavioral guidance distinguishing chosen design, executed analysis, and deployed output lives in the editable AGENTS.md template.

## Clawstrum subagent orchestration

See [subagent orchestration](orchestration.md) for the shared Claude/Codex delegation policy, brief and context contract, native delegation controls, progress/review tools and profiling commands. Subagent requests receive MEMORY references rather than the full lead memory; main-channel context composition is unchanged.

## Optional Jev advice

Jev picks a skill from the user's message, the agent's last 2 replies and each skill's structured criteria (`description`, `not_for`, `examples` frontmatter). The picked SKILL.md body is appended to `ProviderRequest.prompt` for that turn; when Jev decides (a skill or none), keyword hints are left out. It is not part of `ProviderRequest.instructions` or its fingerprint, so a changing pick does not itself invalidate the stable instruction prefix. Both providers retain the complete available skill catalog and explicit user choices. Subagent prompts use the same mechanism over their configured role skills, without previous replies. When Jev is disabled or unavailable, keyword hints are used instead: the top match's SKILL.md body is loaded with a header saying it was a keyword match and can be wrong, and the other matches are pointers; see [Jev integration](jev.md).
