# Clawstrum subagent orchestration

Clawstrum owns delegation for Claude and Codex. One lead in each Discord channel keeps the project picture, user intent, decisions and synthesis. Short-lived subagents do bounded investigation, analysis, implementation and verification. This uses the existing research subagent queue; there is no second task executor.

## When to delegate

The editable policy lives in the **Delegating work** section of the installed `H/AGENTS.md`, seeded from `templates/AGENTS.md`. Delegate substantial work that has a clear input and checkable output, especially bulk reading and specialist implementation. Parallelize independent tasks; dispatch dependent tasks after their prerequisites are available. A trivial answer or immediate decision can stay with the lead. The harness does not manufacture tasks or impose a minimum subagent count.

Use `research_delegate` with a stable deduplication key and a configured role:

```json
{
  "key": "inspect-parser-v2",
  "role": "explorer",
  "brief": "Find why the parser drops the final record.",
  "reason": "Bounded evidence discovery; keep the lead free for integration.",
  "context": "The latest user correction is that empty records are valid.",
  "paths": ["src/parser.ts", "test/parser.test.ts"],
  "deliverables": ["Exact source locations and a minimal reproducer"],
  "constraints": ["Do not change files or broaden the investigation"],
  "writePaths": []
}
```

The optional structured fields extend the original role/brief/paths contract. Existing callers remain valid. `resumeFrom` explicitly continues an ended subagent from its artifacts in a fresh context; it never blindly replays commands. A subagent that was running when Clawstrum restarted is different: it continues its own provider conversation, see [Restarts](#restarts). Only the lead delegates. Subagents have no nested delegation or Discord delivery tools.

## Models, capacity and file coordination

| Role                 | Claude default | Codex default | Effort | Turn/tool-item cap (`maxTurns`) |
| -------------------- | -------------- | ------------- | ------ | ------------------------------- |
| explorer, log-reader | haiku          | gpt-5.6-luna  | low    | none (`0`)                      |
| lit-reader           | sonnet         | gpt-5.6-sol   | medium | none (`0`)                      |
| analyst              | sonnet         | gpt-5.6-sol   | high   | none (`0`)                      |
| coder                | sonnet         | gpt-5.6-terra | high   | none (`0`)                      |
| thinker              | sonnet         | gpt-5.6-sol   | high   | none (`0`)                      |
| checker, reviewer    | opus           | gpt-5.6-sol   | high   | none (`0`)                      |

Subagents have no step or time limit by default (`maxTurns` 0, `workers.timeoutMs` 0). Instead, while subagents run, the lead is woken every `workers.checkMinutes` (15) with each one's run time, tool calls, idle time and last progress note, and decides whether to leave it, correct it or cancel it. A role can still set `maxTurns`.

These are configurable defaults, not equivalent-capability claims. Existing explicit role settings are preserved. Model selection precedes account selection so a known lead-only quota bucket does not unnecessarily block a different subagent model. Unknown quota scopes remain conservative. Role subagents do not inherit the lead's model fallback ladder. Authentication, account capacity and shared entitlement failures still apply.

Up to `workers.maxConcurrent` (20) subagents run at once across the daemon. Each one also takes a slot of its account's `maxConcurrent`, which it shares with that account's lead conversations and maintenance runs; when the preferred account is full a subagent goes to the next eligible account, and when every eligible account is full it waits in the queue. `runtime.maxConcurrent` does not limit subagents (every parsed account has its own `maxConcurrent`), but running subagents do count against it when the daemon decides whether to start background maintenance and group reviews, so those wait while many subagents run. A subagent also waits while less than `workers.minFreeMemoryMB` (1024) of memory is available. Available memory is the smallest of the host's available memory and, for each cgroup v2 directory from the daemon's cgroup up to the root with a numeric `memory.max`, `memory.max` minus (`memory.current` minus `inactive_file` and `slab_reclaimable` from `memory.stat`); subagents started in the last minute are counted at 500 MB each on top of that reading, because their processes may not have grown yet. `0` turns the memory check off. A subagent held by memory or account capacity is listed in the lead's progress check with the reason. Timeout, turn/tool-item and optional observed-token budgets also govern execution. Dollar caps are Claude provider estimates, not subscription charges. A Codex dollar cap fails explicitly; use its observed-token budget instead.

`writePaths` declares a file or directory tree the subagent intends to modify. Subagents with overlapping declared scopes wait until the earlier running subagent ends, across channels and symlink aliases. Disjoint work remains parallel. These scopes are coordination metadata, **not a sandbox**. They do not detect undeclared writes, coordinate the lead's own edits, or serialize remote side effects. The lead must arrange separate files/worktrees or explicit sequencing for those cases.

## What a subagent's brief carries

A subagent sees its brief, not the conversation that produced it. `research.workers.requireContext` (default `true`) refuses a `research_delegate` call whose `context` is missing or shorter than 40 characters; `context` should say what the work is for and any constraint the person stated that the subagent must keep. `research.workers.briefContext` (on by default) appends a "Conversation context" section to every BRIEF.md: the channel's goal entry from the AGENTS.md MEMORY (a heading or bold line naming the goal; without one, the decisions the harness saved word for word) and the last `recentMessages` (40) messages of the parent conversation from both sides, oldest first, each cut at `messageChars` (1500) characters. Past `maxChars` (30000) for the whole section the oldest messages are dropped first. Scheduled wakes and harness notices are left out. A `resumeFrom` continuation keeps its earlier brief and gets no new section.

## Same-file holds between subagents

`research.workers.fileHolds` (default `true`) stops two running subagents from editing one file at the same time through native edit tools.

- _Hold._ The first running subagent to edit a file with `Write`, `Edit`, `MultiEdit` or `NotebookEdit` holds that file until the subagent completes, fails or is cancelled. Paths are compared after canonicalization (symlinks resolved, relative paths made absolute), the same way `writePaths` are. Holds are rows in the `worker_file_holds` table, so they survive a restart; a hold counts only while its holder is still running, and the end of a subagent, cancellation and restart recovery all delete its holds.
- _Refuse._ A Claude subagent's native edit of a file another running subagent holds is refused by the PreToolUse hook, naming the holder's subagent id and role and saying it may wait or report the conflict to the lead. The lead is never held.
- _Codex._ Codex runs with `approval_policy="never"`, so Clawstrum sees a Codex file change only as an event while it is applied and cannot refuse it. The change is recorded, the hold is taken if it is free, and if another subagent holds the file the Codex subagent is told through live steering and the overlap is flagged at completion.
- _Shell edits._ A shell command's writes cannot be checked before it runs. At the end of each subagent Clawstrum lists the files it changed: native edit targets and Codex file changes, plus, for each git repository under the subagent's declared `writePaths`, paths named by commits made since it started and uncommitted paths modified since it started. Git cannot say who made a change, so changes another process made in those paths during the run are included too; deletions in the working tree are not reported. Subagents with overlapping `writePaths` never run at the same time, so this does not cause false overlap flags between them.
- _Completion wake._ The lead's wake lists the files this subagent changed and flags each one that another subagent also changed while both were running (overlapping run windows). The restart recovery wake carries the same list for native edits.

## What a subagent receives

Each subagent starts fresh with its brief, relevant facts/corrections, source paths, deliverables, constraints, continuation pointers, current shared/group/channel policy, its role prompt and selected role skills. `AGENTS.md` MEMORY sections become source references with revision hashes rather than the lead's accumulated memory text. A subagent can read a referenced section if the task requires it. Ordinary imported instruction files remain instructions; operators should keep accumulated facts inside MEMORY.

This memory mode also applies to instruction refresh and native compaction restoration. Claude excludes the canonical files from duplicate native discovery. Codex subagents set `project_doc_max_bytes=0` to avoid native ancestor discovery loading the channel MEMORY again. Clawstrum's explicitly supplied policy remains available. Subagent transcript/tool records stay in raw history; they are not copied wholesale into the lead prompt.

Artifacts under `W/research/workers/<id>/`:

- `BRIEF.md`: the actual task handoff.
- `EVENTS.jsonl`: observable execution events; large event details are bounded here and full provider records remain in raw history.
- `RESULT.md`: the full final response or failure/partial-work pointer.
- `REPORT.json`: the latest structured subagent update, final summary, execution measurements and result path. A subagent that omits structured reporting is still retained, visibly without that report.

## Progress, correction and synthesis

`research_subagent_update` is available only to the current running subagent. Its fields are `state` (`working`, `blocked`, `report`), `summary`, `evidence`, `verification`, and `uncertainties`. Report meaningful milestones, blockers and the final result; do not send periodic filler. Updates and revisions are durable. Routine progress stays internal. A new blocked report wakes the lead once per changed blocker; it does not pause the subagent budget.

`research_status collection=subagents` (`workers` accepted) exposes status, start/end timestamps, latest activity, tool count, progress, artifacts and steering acknowledgments. `research_steer` sends live corrections through the existing provider adapters. Transport acceptance is not proof that the subagent adopted the correction. Unknown delivery is not automatically replayed. Cancellation preserves partial work and never automatically repeats external actions.

Completion or failure wakes the lead with the bounded result and artifact path. The lead checks the evidence, integrates the useful conclusion, and records `research_subagent_review` with `accepted`, `rework` or `unused` plus a reason. This is an auditable review receipt, not an automated truth judgment. The profiler distinguishes unreviewed outputs from accepted ones. A rework receipt does not itself spawn another subagent.

## Restarts

As soon as a provider names its conversation (a Claude session or a Codex thread), Clawstrum saves that id and the account holding it in the subagent's profile. When the daemon stops, a subagent with a saved id stays `running` in the database instead of failing. At the next start, each subagent still marked `running` that has a saved id goes back to the queue. It starts again on the same account, continuing its own conversation with its full history, and receives one message: "Clawstrum restarted while you were working. Edits and commands you started may not have finished: check the files and state you were changing, then continue your task." Its brief and `EVENTS.jsonl` are kept, its original start time and step count carry over, steering instructions still queued are delivered to it, and the progress check covers it as before. An instruction that was being delivered when the daemon stopped is marked `unknown`. The lead gets one research wake per resume.

A subagent is resumed at most `workers.restartResumes` (2) times; `0` turns this off. A subagent without a saved id (it had not started its provider yet), one past the limit, or one whose account is no longer configured fails as before with an "interrupted" result, and the lead is woken to inspect its artifacts. If the provider cannot find the saved conversation, the resumed subagent fails with that provider error.

## Quota continuation

When a running subagent's account hits a provider quota (`classifyError` kind `quota`; an `auth` failure is unrelated and still fails the subagent as before), Clawstrum does not fail it straight away. The exhausted account is put on the normal cooldown, and if another account configured for the subagent's provider exists, the delegation is requeued under the same id, so the lead's steering, progress checks and file holds keep working. The provider conversation itself is tied to the exhausted account's profile, so the next account starts a fresh context rather than resuming native session history; it is told to read its own prior `BRIEF.md`, `RESULT.md` and `EVENTS.jsonl` and check actual project state before continuing, and its tool-call count and queue time carry over. Once it starts on the new account, the lead gets one research wake naming both accounts and the continuation count.

This happens at most `workers.quotaContinues` (2) times. Past that limit, or when no other account is configured for the subagent's provider (an explicit `provider` request never moves to a different provider), the subagent fails as before, with a message that names the exhausted account and, when the provider reported one, when its quota resets.

## Thinker, checker and reviewer

`thinker` builds: within a direction the lead has chosen, it works out design detail, tradeoffs, derivations and an implementation sketch, and marks each claim as derived from inspected evidence or assumed. It does not argue against the direction. `checker` asks whether it is true: it reads one artifact (a result, number, claim, caption or paper text) and the sources named in the brief and reports what is wrong, stale, unsupported, overclaimed or contradicted by an earlier result. It proposes nothing and never judges worth or what to cut. `reviewer` asks whether it is good enough and worth doing: its artifact is a slate (results and plan), a fresh result (its claims) or a paper draft or figure (journal-referee mode: items are claims, sections or panels, and it looks at the figure itself), and it reads the items as one story before it gives every item exactly one verdict. The brief sets the stage: `direction` for work in progress (is it promising, what story could it tell, what does it need) or `final` for a draft, final figure or submission (would it pass a referee at the venue, with a slot budget).

The jobs are split because a subagent asked to both develop and attack a direction tends to defend what it just built, because judging truth and judging worth are different jobs, and because an objection is only useful to the lead if it can be checked against the source it cites.

A checker returns at most three objections, most serious first, each in this form:

```text
OBJECTION 1 [unsupported]: The speedup claim rests on a single seed.
EVIDENCE: results/summary.md:42 "mean speedup 2.3x (seed 0)"
```

`kind` is one of `wrong`, `stale`, `unsupported`, `overclaim`, `missed_prior`. An objection may carry several `EVIDENCE` lines or none. If nothing survives, the result is one line, `NO OBJECTION: <why>`.

A reviewer first writes four story lines: `STORY NOW` (what the items say as they stand), `STORY BEST` (the strongest story the existing results could tell), `STORY GAP` (the missing link) and `LEAD` (the most promising next move). Items are judged against the best story. Each item has a kind, `result` or `plan` (work not done yet), and one verdict: `main`, `fix` (keep but change what the `FIX` line says), `develop` (interesting but not convincing yet; the `DEVELOP` line says what it needs: data, proof, control or design, and its cost), `supporting` (supplement, extended data, a check; it says where it goes), `dead_end` (a result already killed it; an `EVIDENCE` line cites that result), `cut` (final stage only) or `stop` (plan items only: halt planned or running work). In the final stage `main` and `fix` results together are at most `SLOTS`; plan items never count against them, and `PLAN SLOTS`, when the brief gives it, caps `main` plan items. The direction stage has no slot cap and no `cut`: under-evidenced work is `develop`, never cut.

```text
STAGE: final
SLOTS: 2
STORY NOW: A 2.3x speedup on one model.
STORY BEST: A speedup that holds across model sizes.
STORY GAP: A second model size.
LEAD: The 7B run in item 3.
ITEM 1 [fix, result]: Speedup claim in the abstract — rests on a single seed.
FIX: Report the mean over the three seeds already run.
KILL: A three-seed mean below 1.5x.
EVIDENCE: results/summary.md:42 "mean speedup 2.3x (seed 0)"
ITEM 2 [stop, plan]: Learning-rate sweep — cannot change the conclusion.
ITEM 3 [develop, plan]: 7B run — would make the speedup general.
DEVELOP: One run at matched compute, about 200 GPU-hours.
KILL: No speedup at 7B.
MISSING: A baseline at matched compute.
OVERALL: major: one claim carries the paper and it rests on one seed.
TOP CUT: none.
```

Every `main`, `fix`, `develop` and `supporting` item has a `KILL` line naming the result that would change its verdict; there are at most three `MISSING` lines. The verdicts are proposals: a cut, stop or dead_end is not applied until the user agrees. Run two or three reviewers in parallel, each with a different angle; a story editor is in every round, joined by a skeptic on side work (direction) or a journal referee at the venue (final). After a direction review, thinkers work out the lead and the develop items; after a final review, a checker checks what the fixes touch.

When a checker or reviewer completes, the harness parses the result and reads each cited file itself. Verification reads only regular files, with a shared 4 MiB read budget per result; oversized or unreadable evidence remains unverified. Repeated references reuse the same cached bytes for checking and display. Paths resolve against the workspace and the artifact's directory, not the subagent's own artifact directory, so a subagent cannot verify a quote from a file it wrote there. A quote counts as found when its whitespace-normalised text appears in a span of one to three lines starting within three lines of the cited line. A quote of at least 20 characters found elsewhere in the file is reported as moved, with the line where it was found. Each objection is marked verified (some quote found or moved), unverified (quotes cited but none found, or the file is missing) or unbacked (no `EVIDENCE` line). The lead's wake message carries the checker's result followed by a block headed `Checker evidence check (harness-read, not the checker's words):` with those marks and, for found quotes, the one to three lines of the matching span as read from disk, starting at the line where the quote begins; the block is capped at about 4000 characters. A result with no parseable objections gives one line saying no checkable evidence was found. The counts are recorded as a `research_checker_result` event beside `research_worker_result`. A reviewer's `EVIDENCE` lines are checked the same way, and its wake message carries a `Reviewer verdicts` block with the stage, the verdict counts and the story lines, and flags `OVER BUDGET` (more `main` and `fix` results than slots, final stage or no stage given), `OVER PLAN BUDGET` (more `main` plan items than plan slots), `STAGE MISSING`, `SLOTS MISSING` (final stage without slots), `STORY MISSING` (naming the absent story lines), `KIND MISSING`, `FIX MISSING` (a `fix` item without a `FIX` line), `DEVELOP MISSING` (a `develop` item without a `DEVELOP` line), `DEAD END UNCITED` (a `dead_end` item without an `EVIDENCE` line), `CUT IN DIRECTION`, `STOP NOT PLAN` (a `stop` on an item not marked plan) and `UNKNOWN VERDICT`; the stage, slots, plan slots and counts are recorded as `research_reviewer_result`.

`research_delegate` accepts `artifact`, the file under review, absolute or relative to the workspace. For a checker or reviewer with an existing artifact, the brief starts with `Artifact under review: <absolute path>`. `research.workers.review.artifact` decides what happens when a checker or reviewer delegation has no artifact or names a missing file: `advise` (default) queues the subagent and adds a one-line `advisory` to the tool result, `deny` refuses the delegation, `off` does nothing.

`research.workers.review.hold` (`off` by default) set to `once` holds a reply from the run that consumed a checker or reviewer result's wake (the inbound `research:worker:<id>`), once per result, with feedback naming the subagent and its objection counts or verdict counts, so the checked evidence is read before the user hears anything; a run that did not receive the wake is not held, a wake run that ends `CLAWSTRUM_QUIET` leaves nothing armed, and interim results are never held, since a held interim text has no retry; it runs in the shared outgoing reply review, so it applies to Claude and Codex leads, and it neither depends on `validation` nor spends the reply review's one correction; each hold is recorded as a `research_review_hold` event with the `workerId`. `research.workers.review.paperPush` (`off` by default) checks a `git push` for what changed against the upstream merge-base, working tree included: a changed caption, section heading, figure environment or `\includegraphics` line, abstract text, or number (`\ref`, `\cite` and `\label` arguments and comments ignored), an image file changed or added (`png`, `pdf`, `jpg`, `jpeg`, `eps`, `svg`; a compiled `<name>.pdf` next to its `<name>.tex` is ignored), or 800 or more changed characters; an untracked file counts only when a tracked `.tex` pulls it in (`\input`, `\includegraphics`, `\bibliography` and the like, transitively) or the push command `git add`s it by name. A typo fix, a citation key or a reflow triggers nothing. A triggered push needs a checker or reviewer result after the change's first `.tex` edit; each result records a snapshot tree of its artifact's repository, and edits after it re-arm the check only when the diff from that tree trips a trigger on its own, and co-author edits pulled after a review are not counted as edits since it (the reviewed change is replayed onto the new upstream merge-base; when it cannot be, the check compares against the review tree as before); a re-push passes as a retry only while the snapshot tree is unchanged since the last allowed push; edits, reviews, pushes and refusals are keyed to the real path of the git toplevel, so a push from a subfolder matches a review of the paper, while only a result naming an artifact inside that repository counts as review: `deny` refuses the push with the triggers listed (allowed after three refusals for the same change), `advise` lets it proceed with the reason as context; it is a PreToolUse hook, so it applies only to Claude leads; it is checked on the lead's pushes; subagent pushes are not checked, though a subagent's `.tex` edits still count toward the lead's next push; and every decision is recorded as a `research_paper_push_gate` event. `research.workers.review.notesChars` (`20000` by default) appends up to that many characters of the session's AGENTS.md "Research state" section to a checker's or reviewer's prompt, newest kept when over, so the subagent can check the artifact against earlier results; `0` leaves only the memory pointer every subagent gets; the delivered length is recorded on the `research_worker_route` event. The older `research.workers.critic` block is still accepted as a deprecated alias; `workers.review` wins when both are set.

## Native delegation controls

With research enabled, roles configured and `workers.enforceRoles="deny"` (default), Clawstrum removes Claude's native Agent/legacy Task/Workflow and team delegation tools and disables built-in agent definitions. Codex gets `features.multi_agent=false` and `agents.enabled=false` at process launch and thread start/resume; the SDK fallback receives the same controls. Subagents always disable native delegation, even if the lead opts out. These settings do not change full host access or introduce approval prompts.

`enforceRoles="advise"` or `"off"` permits an operator to retain native lead delegation. Providers still own their internal prompts and inference behavior; Clawstrum controls the exposed delegation interfaces, not every sentence in a proprietary prompt. Shell access can launch arbitrary programs, so this is a consistent workflow, not a security boundary. Do not bypass it with shell-launched agents. Check native tool visibility again when upgrading provider runtimes.

## Monitoring and profiling

[`clawstrum usage profile`](usage.md) compares every subagent role, including critic, with all lead and maintenance invocations over a date window. `subagents profile` below retains the detailed per-subagent progress and review receipts.

No model calls are needed for monitoring:

```bash
clawstrum subagents profile --since 2026-09-22T00:00:00Z --limit 100
clawstrum subagents profile SESSION_ID --since 2026-09-22T00:00:00Z
```

The CLI opens the database read-only and honors its pinned-host storage policy. It prints JSON suitable for saving or plotting. `research_status collection=subagent-profile` (`worker-profile` accepted) exposes the same report within the current channel. Both accept `limit`/`offset`; the MCP tool also accepts `since` as a time with an offset (`2026-11-16T03:00:00-05:00`) or epoch milliseconds. Reports disclose truncation.

The cohort is selected by subagent creation time. For each subagent the report includes queue/run duration, time since observed activity, selected provider/model, initial prompt/instruction characters, tool calls, final/returned characters, status, usage counters and review outcome. A silent tool can still be working; silence is not a failure diagnosis. Progress is sampled at most once per five seconds for ordinary streaming events and also persisted at tool/completion boundaries.

Totals use the latest cumulative usage snapshot once per invocation. Cache reads/writes, input/output tokens and provider estimated costs retain unknown values and missing-counter counts. Reports include distinct parent lead invocations so subagent cost can be considered alongside orchestration overhead. Parent usage can contain other work, and the same parent can appear on separate pages: **do not sum parent totals across pages**. Native subagent attribution is already a subset of provider totals, never an extra charge. Maintenance calls are outside this subagent/parent cohort; use the existing usage report for the whole harness.

To evaluate effects, compare matched tasks at fixed provider/model, task inputs and acceptance checks, with delegation enabled versus a lead-only baseline. Record correctness, rework, wall time, total lead+subagent usage, cache counters and input/return sizes. Repeat tasks in isolated workspaces to avoid warmed artifacts biasing one condition. Include failures and unreviewed outputs. Report quota and context-size observations separately from API-equivalent cost estimates. The tool measures observations; it does not infer a counterfactual cost saving or convert token counts into subscription quota consumption.

## Implementation and references

`src/research/workers.ts` owns the queue and lifecycle; `worker-profile.ts` owns progress, review and reporting; `tools.ts` defines the MCP contract. `src/orchestration.ts` supplies common provider controls. `src/instructions.ts` carries subagent memory references through refresh. `src/accounts.ts` separates role routing from known quota scopes. Lifecycle uses the existing delegations table, progress/usage use metadata, and audit revisions use events. `file-holds.ts` adds the `worker_file_holds` and `worker_files` tables, created if missing without a schema version change.

This is the orchestrator/subagent pattern with independent task context and synthesized results, as described in [LangGraph workflows and agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents). Provider controls are documented in [Claude subagents](https://code.claude.com/docs/en/sub-agents) and the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). Runtime behavior must be tested in addition to consulting documentation.

## Explicit subagent models and optional advice

Role models are defaults. Set `provider` and `model` on `research_delegate` to honor a specific task request, for example `{"key":"brainstorm-v2","role":"analyst","provider":"claude","model":"claude-fable-5","effort":"high","brief":"Compare the supplied designs"}`. Use an identifier supported by the selected account/provider. This does not change the lead or global role defaults. A model override requires its provider; routing applies it before quota selection. Unavailable accounts leave the request queued with the requested route visible, without substituting another model or provider. Actual model support is established by the provider response.

`research_subagent_advice` optionally suggests a role for a brief. It does not spawn, enforce its recommendation, or override explicit choices. Without Jev it returns configured roles/models. See [Jev integration](jev.md) for fallbacks and profiling.

Both leads and subagents receive a runtime setup block naming their configured subscription account, provider and requested model. It describes the actual delegation interface and native delegation controls. A shell CLI using a different login does not diagnose the configured account. Harness subagents have no Bedrock adapter; separately authorized experiment judge APIs remain a distinct workflow.
