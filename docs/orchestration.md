# Subagents

In each channel one lead agent keeps the project picture and writes the answers. On Claude and Codex it hands bounded tasks, such as reading, analysis, a code change or a check, to subagents. Only the lead delegates. Subagents can't start subagents or post to Discord.

## Delegation policy

The policy is the "Delegating work" section of `H/AGENTS.md`, seeded from `templates/AGENTS.md`. Edit it to change when the lead delegates. By default it delegates substantial work with a clear input and a checkable output, runs independent tasks in parallel and keeps trivial answers. Clawstrum never requires a minimum number of subagents.

## Starting a subagent

The lead calls `research_delegate`. The same `key` returns the same subagent instead of starting another.

```json
{
  "key": "inspect-parser-v2",
  "role": "explorer",
  "brief": "Find why the parser drops the final record.",
  "reason": "Evidence search, so the lead can keep working.",
  "context": "The latest user correction is that empty records are valid.",
  "paths": ["src/parser.ts", "test/parser.test.ts"],
  "deliverables": ["Exact source locations and a minimal reproducer"],
  "constraints": ["Do not change files or broaden the investigation"],
  "writePaths": []
}
```

- `context` says what the work is for and any constraint you stated. Under 40 characters is refused unless `research.workers.requireContext` is `false`.
- `research.workers.briefContext` (on by default) adds the channel's goal from memory (or your saved decisions) and the last 40 messages from both sides to every `BRIEF.md`. Limits are in the [configuration reference](research.md#configuration-reference).
- `provider`, `model` and `effort` override the role for one task. A model needs its provider. If no account can take it, the request waits. Clawstrum never swaps in another model or provider.
- `artifact` names the file a checker or reviewer judges (see below).
- `resumeFrom` continues an ended subagent (see [Steering and continuing subagents](#steering-and-continuing-subagents)).

`research_subagent_advice` suggests a role for a brief and starts nothing. Without [Jev](jev.md) it lists the configured roles.

## Roles

| Role                 | Claude | Codex         | Effort | Skills       |
| -------------------- | ------ | ------------- | ------ | ------------ |
| explorer, log-reader | haiku  | gpt-5.6-luna  | low    |              |
| lit-reader           | sonnet | gpt-5.6-sol   | medium |              |
| analyst              | sonnet | gpt-5.6-sol   | high   | `theory`     |
| coder                | sonnet | gpt-5.6-terra | high   | `iterate`    |
| thinker              | sonnet | gpt-5.6-sol   | high   | `brainstorm` |
| checker, reviewer    | opus   | gpt-5.6-sol   | high   |              |

Set roles in `research.workers.roles` (defaults and prompts in `src/research/config.ts`). It replaces the whole default map, so copy the roles you want to keep. A role needs `description` and `prompt`, and can set `models` (`claude`, `codex`, `gemini`), `effort` (default `low`), `maxTurns`, `maxTokens`, `maxBudgetUsd` and `skills`. Without `models.codex` it uses the account's model. `max` effort becomes `xhigh` on Codex. A subagent gets only its role's skills. A missing skill is logged as `skillsMissing` and the subagent still starts.

## Limits

By default subagents have no turn or time limit (`maxTurns` 0, `workers.timeoutMs` 0). Instead the lead gets a progress check every `workers.checkMinutes` (15) with each one's run time, tool calls, idle time and last note, and can correct or cancel it.

- `maxTurns` counts Claude turns, or completed tool items on Codex, which can overshoot by one.
- `maxTokens` stops a subagent once its observed tokens, cache reads included, reach the limit. It can overshoot.
- `maxBudgetUsd` is Claude's estimated-cost cap. A role with it routed to Codex fails to start, so use `maxTokens` for roles that may move between providers.

A subagent that hits a limit fails, keeps its artifacts and is not retried.

## Capacity

At most `workers.maxConcurrent` (20) subagents run at once. Each also takes a slot of its account's `maxConcurrent`, shared with that account's leads and maintenance. When the preferred account (`workers.account`) is full, a subagent goes to the next one, or waits. `runtime.maxConcurrent` doesn't limit subagents, but background maintenance waits while many run. A subagent also waits while less than `workers.minFreeMemoryMB` (1024) is free on the host or in the daemon's cgroup v2 limits, counting each subagent started in the last minute as 500 MB. The progress check shows why a subagent waits.

## File coordination

`writePaths` declares what a subagent will change. A subagent whose scope overlaps a running one waits, across channels. This is not a sandbox. It misses undeclared writes, the lead's edits and remote side effects.

`research.workers.fileHolds` (default `true`) stops two running subagents from editing one file at once:

- The first running subagent to edit a file with `Write`, `Edit`, `MultiEdit` or `NotebookEdit` holds it until it ends. The lead is never held.
- On Claude, another subagent's edit of a held file is refused. On Codex it can't be refused, so the subagent is told and the overlap is flagged.
- Shell writes can't be checked. When a subagent ends, its wake lists the files it changed, including git changes under its `writePaths` by anyone, and flags files another subagent changed at the same time.

## Subagent context and files

A subagent starts fresh with its brief, the shared, group and channel instructions, its role prompt and skills, and a setup block naming its account and model. Memory sections arrive as references it can read, not as text. Only the first `workers.resultChars` (8000) characters of its final message reach the lead, so bulk output goes in files.

Files in `W/research/workers/<id>/`:

- `BRIEF.md`: the task as handed over.
- `EVENTS.jsonl`: observed events, shortened. Full records stay in history.
- `RESULT.md`: the full final answer, or a pointer to partial work.
- `REPORT.json`: the latest progress update, final summary, measurements and result path.

## Progress and results

A subagent reports with `research_subagent_update` (`state` `working`, `blocked` or `report`, `summary`, `evidence`, `verification`, `uncertainties`). A new `blocked` report wakes the lead.

`research_status collection=subagents` shows status, activity, progress, artifacts and steering. With `cancelWorker=true` and an `id` it cancels one subagent. `!clawstrum stop` cancels all of the channel's subagents. Their cluster jobs keep running.

When a subagent ends, the lead is woken with its result. The wake warns if the event log shows no tool use, none of the brief's paths, or absolute paths the result cites that don't exist (up to 50 checked). The lead then records `research_subagent_review` with `accepted`, `rework` or `unused` and a reason.

## Steering and continuing subagents

`research_steer` sends a correction to a queued or running subagent. From the shell, use `clawstrum research steer SESSION --input correction.json`:

```json
{
  "id": "REPLACE_WITH_WORKER_UUID",
  "key": "normalization-correction",
  "message": "Use population variance, and verify the saved normalization before continuing."
}
```

Messages are at most 8,000 characters, delivered in order, at most 20 outstanding per subagent. Reusing a key with different text fails. Each message is `queued`, `sending`, `accepted`, `rejected` (also when the subagent ended first) or `unknown`. `accepted` means the provider took it, not that the model followed it. `unknown` messages are never resent. Steering doesn't stop a running command.

To continue an ended subagent from the same conversation, call `research_delegate` with a new key, role and brief, and `resumeFrom` set to its id. The new subagent gets a fresh context, its own budget and pointers to the old files, and checks the project's state first. Nothing is replayed.

## Restarts

A subagent running when Clawstrum stops continues its own conversation on the same account at the next start. It is told that its edits and commands may not have finished. Queued steering is delivered, and the lead is woken. This happens at most `workers.restartResumes` (2) times. A subagent whose conversation hadn't started, past the limit, or whose account is gone fails as interrupted. Queued subagents stay queued.

## Quota continuation

When a running subagent's account hits a quota, the subagent moves, under the same id, to another account of the same provider. It starts a fresh context from its old files, and the lead is woken. This happens at most `workers.quotaContinues` (2) times. Past that, or with no other account, it fails with the quota's reset time if known. An authentication failure fails it right away.

## Thinker, checker and reviewer

- `thinker` works out a direction the lead chose: design, tradeoffs, derivations and a sketch concrete enough to cost. It marks each claim as derived or assumed and doesn't argue against the direction.
- `checker` checks whether one artifact is true against the sources in the brief. It returns at most three objections, each with a kind (`wrong`, `stale`, `unsupported`, `overclaim`, `missed_prior`) and `EVIDENCE: path:line "quote"` lines, or `NO OBJECTION: <why>`. It proposes nothing.
- `reviewer` judges whether work is worth keeping. The brief sets the stage: `direction` for work in progress, or `final` for a draft or submission, judged as a referee with `SLOTS`. It writes the story the items tell and the best story they could tell, then gives each item one verdict: `main`, `fix`, `develop`, `supporting`, `dead_end`, `cut` (final stage only) or `stop` (plan items only).

The exact output formats are in the role prompts in `src/research/config.ts`. Verdicts are proposals, and a `cut`, `stop` or `dead_end` waits for you.

When a checker or reviewer ends, Clawstrum reads each cited line itself (not from the subagent's own folder) and marks each objection verified, unverified or unbacked. The lead's wake shows these marks with the lines read from disk, and for a reviewer the verdict counts and flags such as `OVER BUDGET`.

Settings under `research.workers.review`:

- `artifact` (`advise`) applies to a checker or reviewer without an existing `artifact` file. `advise` warns, `deny` refuses, `off` does nothing.
- `hold` (`off`) set to `once` holds the first reply after a checker or reviewer result once, so the lead reads it before answering you. Interim results are never held. Works on Claude and Codex leads.
- `paperPush` (`off`), on Claude leads only, checks the lead's `git push`. A push that changes a caption, heading, figure, abstract, number or image, or 800 or more characters, needs a checker or reviewer result since the first `.tex` edit. `deny` refuses (allowed after three refusals), `advise` warns. Subagent pushes are not checked.
- `notesChars` (20000) appends that much of the channel's Research state to a checker's or reviewer's prompt, newest first. `0` leaves only the memory pointer.

The older `research.workers.critic` block still works. `workers.review` wins when both are set.

## Native delegation

With research on, roles configured and `research.workers.enforceRoles` at `deny` (the default), Clawstrum removes Claude's native Agent, Task, Workflow and team tools and turns off Codex's multi-agent features. `advise` or `off` lets the lead keep them. Subagents never get them. The shell can still start other agents, so this is not a security boundary.

## Profiling

These commands make no model calls:

```bash
clawstrum subagents profile --since 2026-09-22T00:00:00Z --limit 100
clawstrum subagents profile SESSION_ID --since 2026-09-22T00:00:00Z
```

The JSON gives each subagent's queue and run time, model, prompt and result size, tool calls, status, usage and review. `research_status collection=subagent-profile` gives the same for the current channel. Both take `limit` and `offset`, and the tool takes `since` as a time with offset or epoch milliseconds. Parent lead runs can repeat across pages, so don't add their totals. [`clawstrum usage profile`](performance.md#usage-report) compares roles with lead and maintenance runs.
