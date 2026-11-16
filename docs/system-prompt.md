# System prompt

`H` is the Clawstrum home, `W` the channel's workspace (normally `H/channels/<discord-channel-id>`) and `P` the selected account's provider profile directory. The context is built in [context.ts](../src/context.ts) and [instructions.ts](../src/instructions.ts). The request type is in [types.ts](../src/types.ts). To edit the `AGENTS.md` files, see [instructions](instructions.md).

## Request fields

| Field            | Holds                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `instructions`   | Standing instructions, Clawstrum's protocols, runtime facts, skills, then current memory as facts    |
| `prompt`         | Current input, recent history when the session is new, and per-turn skill, recovery and review notes |
| `contextRefresh` | Source paths, instruction and memory revisions, and the revision the session last confirmed          |
| `sessionId`      | The native session or thread to resume, if any                                                       |
| `mcp`            | Clawstrum's tools and the run and channel identity                                                   |

Tool definitions are registered separately in [mcp.ts](../src/mcp.ts) and [research/tools.ts](../src/research/tools.ts). Native tools, managed rules and provider compaction add context outside these fields.

## Base prompt

Lead runs replace the provider's built-in prompt with [templates/base-prompt.md](../templates/base-prompt.md), placed before `instructions`. Subagents and background passes keep the provider's prompt.

In the main channel (`discord.channelIds[0]` and its threads) it is [templates/base-prompt-main.md](../templates/base-prompt-main.md) instead: the same rules, framed around looking after the installation, plus a map of the code, [the guides index](index.md), [the architecture guide](architecture.md) and the customize skill (`H/skills/customize/` if present, else the bundled one). These files are read on every run, so edits apply from the next turn.

## Instructions

A lead run's `instructions` field holds these parts in order, separated by blank lines. The research and work-alone parts start on the next line instead.

1. Standing instructions from the files, in the [load order](memory-lifecycle.md#files). Each source starts with a header naming its path and a 16-character revision hash.
2. The refresh protocol: later context updates replace earlier sections, and an update is not a new task. Text is `REFRESH_PROTOCOL` in [instructions.ts](../src/instructions.ts).
3. The delivery protocol: stable keys for `send_message` and `send_file`, what `final=true` means, and the `CLAWSTRUM_QUIET` marker for a wake with nothing to say. Text is `DELIVERY_PROTOCOL` in [instructions.ts](../src/instructions.ts).
4. Runtime facts from `harnessSetup` in [orchestration.ts](../src/orchestration.ts): role, provider, account, requested model, the subagent interface and whether native delegation is off. It is off for a lead when research roles are enabled and `research.workers.enforceRoles` is `deny`. No credentials or request IDs.
5. Each configured account's model and state, without secrets, from [account-context.ts](../src/account-context.ts).
6. `Workspace: W` and `Conversation id`. In a thread it also names the parent workspace and says that `memory_update` writes the thread's own memory section.
7. The skill catalog (below).
8. When `research.enabled` is true (the default), the research roles with their descriptions from `research.workers.roles`, and whether Slurm is on (`research.slurm.enabled`).
9. When `workAlone.enabled` is true, the rules in [templates/work-alone/rules.md](../templates/work-alone/rules.md).
10. Current memory from every scope, between `CLAWSTRUM_CURRENT_MEMORY_BEGIN` and `CLAWSTRUM_CURRENT_MEMORY_END` and labeled as facts, not instructions or requests. With no memory it reads `[No current MEMORY facts remain.]`.

Text outside `## MEMORY` becomes instructions. That section ends at the next level 1 or 2 heading outside fenced code. Imported legacy `MEMORY.md`, `CHECKPOINT.md` and `RECORDS.md` count as memory. Clawstrum adds no default policy of its own. Empty instruction sections give the agent none. A missing `H/AGENTS.md` is created from [templates/AGENTS.md](../templates/AGENTS.md) first.

Memory goes into the instructions on new and resumed sessions, never into the prompt, so native compaction doesn't keep it as the latest user message. A stable start also lets the provider cache the instructions.

### Skill catalog

The catalog lists each skill directory under `H/skills`, then `W/skills`, with its `description:` line (at most 300 characters), `SKILL.md` path and a 12-character revision hash. A workspace skill replaces a shared one of the same name. The full list is always in `W/artifacts/skills-index.txt`. Over 5,000 characters of names, the inline list is cut. Over 6,000 characters of catalog, descriptions are left out and read from that file.

## Prompt

A resumed session's prompt holds:

- the history archive path and how far consolidation has read it
- `Current time:` in local time with its offset
- the current input as JSON records, each with ID, role, author, send time (`at`), text and attachment details
- the outstanding inputs and recent delivery state from `W/CONVERSATION.json`
- skill hints, recovery guidance and outgoing-review corrections when they apply

Times use `runtime.timezone`, default the host's zone. Tool results show times the same way, except `group_board`, which takes Unix milliseconds. The time filters of `history` and `research_status` accept the same form.

A new session's prompt also starts with recent history that consolidation has not covered yet: at most 100 records after the last completed consolidation, then cut to the last `runtime.historyChars` characters. It is labeled incomplete and points to the `history` tool for the rest. A planned session change waits for consolidation to finish.

With [Jev](jev.md) on, the skill it picks goes into the prompt for that turn, so a changing pick doesn't refresh the instructions. Without a Jev answer, the current input is matched against the phrases in each skill's `triggers:` frontmatter. The top match's `SKILL.md` is loaded (at most 12,000 characters) with a note that it may be wrong, and up to two more are named. Skills without `triggers:` never match.

## Providers

- Claude lead runs get `systemPrompt` as one string, the base prompt then `instructions`, after one fixed SDK line. Subagents and background passes get the `claude_code` preset with `instructions` appended. Claude resumes with `--system-prompt-snapshot off`.
- Codex App Server gets `instructions` as developer instructions and the prompt as user text. A lead thread also gets `baseInstructions`, the base prompt plus [templates/base-prompt-codex.md](../templates/base-prompt-codex.md), in place of Codex's built-in prompt. That file holds tool lines copied from Codex's prompt for the pinned version. Re-copy them when the pin changes. Lead runs always use App Server. The SDK fallback keeps Codex's prompt.
- Gemini gets the base prompt and `instructions` at the start of a new session's first prompt, after Google's own prompt. See [gemini-acp.ts](../src/gemini-acp.ts).

## Live refresh and compaction

When the agent gets changes is in [instructions](instructions.md#live-refresh). Instruction and memory revisions are tracked separately. Claude hooks send only changed sections. An update over 12,000 bytes is saved to `W/history/context-updates/<sha256>.txt` and the agent is told to read it. A Claude subagent gets updates as a message starting `Clawstrum update (not a new task)`. Codex gets one developer item replacing instructions and memory together. A refresh counts as delivered once the session confirms it, so failed ones are retried.

A new session starts when the account or execution settings change. Codex's own `projects.<path>.trust_level` entries in `config.toml`, formatting and key order don't count.

After a native compaction, the [compaction hook](memory-lifecycle.md#background-passes) archives the transcript and the agent gets its current instructions and memory again. Codex re-sends them when it sees compaction finish. The hook makes no model call.

## Size limits

Sizes are JavaScript string lengths, not tokens.

| Limit                                  | Behavior                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `runtime.promptChars`, default 100,000 | Total characters for `instructions` plus `prompt`                                 |
| Standing instructions                  | `max(2000, floor(promptChars * 0.6) - 4000)`, 56,000 by default, headers included |
| Workspace and skill blocks             | 12,000 characters each, cut with a marker                                         |
| Accounts section                       | 2,000 characters                                                                  |
| `runtime.historyChars`, default 32,000 | Recent uncovered history in a new session's prompt                                |
| Claude refresh hook                    | 12,000 bytes, then a file under `W/history/context-updates/`                      |

Standing instructions first reserve up to 1,024 characters per source, then give spare room to `AGENTS.md` instructions before imports. An overlong source keeps its beginning and end with a marker pointing to the file.

If the assembled instructions still exceed 60% of `promptChars`, the full text goes to `W/history/instructions.full.txt` and the field keeps its first and last 30% plus that path.

Memory gets the room left after the instructions and the prompt. If it doesn't fit, small documents stay whole and the larger ones share the rest. A document still too large keeps whole sections in this order: Last compaction summary, Current work, the saved decisions in Research state, Working understanding, the rest of Research state, everything else. The first section that doesn't fit keeps its newest lines, and each cut names the file with the full text ([memory-fit.ts](../src/memory-fit.ts)). With too little room even for that, memory becomes a pointer to a saved file.

If `instructions` and `prompt` together still exceed `promptChars`, the full prompt goes to `W/history/input.full.txt` and the prompt keeps a marker and its end. Overflow files are replaced on later turns. `W/history/records/` is the permanent history. If the provider rejects the context as too long, Clawstrum retries once in a fresh session with less context, then reports an error.

## Other model calls

- Research subagents get the refresh protocol, the same standing instructions, subagent runtime facts, their role prompt and skills, and the contract from `workerContract` in [research/workers.ts](../src/research/workers.ts). They get paths to memory, not its text. See [orchestration](orchestration.md).
- Consolidation uses `CONSOLIDATION_INSTRUCTIONS` in [consolidation.ts](../src/consolidation.ts), gets history chunks and memory as input and returns JSON. See [memory](memory-lifecycle.md#background-passes).
- Memory review adds `MEMORY_REVIEW_INSTRUCTIONS` from [memory-review.ts](../src/memory-review.ts). Its changes reach running sessions through live refresh.
- The group reviewer uses `GROUP_REVIEW_INSTRUCTIONS` in [groups/review.ts](../src/groups/review.ts). See [channel groups](groups.md).
- Research claims show their source status in the Research state section of memory. See [research](research.md).

## Inspecting a run

`clawstrum status` shows the channel's workspace and native session. `context_budget` events record each part's size, `context_excerpt` events each cut, and `context_updated` events each confirmed refresh. Transport options are in [providers.ts](../src/providers.ts).
