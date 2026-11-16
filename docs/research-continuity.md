# Research continuity and usage

These additions support work that crosses provider turns, subagent failures and research revisions. They preserve full host access and subscription execution. Research tools and maintenance passes are enabled by default; no new approval mechanism is introduced.

## Resource accounting

Use `research_status` with `{"collection":"usage","limit":20,"offset":0}`, or `clawstrum research status SESSION --input usage.json`. Results contain recorded invocations and grouped totals by role, provider and account **for the selected page**. They do not silently claim to cover the conversation's entire history. There is no retrospective import of earlier raw usage logs.

Each provider invocation owns a durable snapshot. Repeated updates replace that snapshot, so polling the status tool or restarting the daemon does not add usage again. Lead attempts and daemon-owned subagents have distinct IDs. Subagent usage is persisted during execution, including before a budget abort. Records live in the existing SQLite metadata table; no separate service or database is required.

| Field              | Interpretation                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `inputTokens`      | Reported input excluding reported cache reads; Claude also separates cache creation           |
| `outputTokens`     | Reported output, already including any reasoning tokens counted by the provider               |
| `cacheReadTokens`  | Reported cache hits, separate from uncached input                                             |
| `cacheWriteTokens` | Claude's reported cache creation; unavailable for Codex, represented as `null`                |
| `totalTokens`      | Provider total or sum of observed disjoint buckets; incomplete observations are a lower bound |
| `estimatedCostUsd` | Native provider estimate when available; Codex reports `null`                                 |

Group `missing` counts expose unavailable fields; `reportedTotals` sums only observed values. A missing field is not measured zero. Usage does not include arbitrary model calls made by programs the unrestricted agent launches outside the observed provider pipeline.

Claude assistant content blocks can share one message ID. The collector updates that request instead of charging for every block. Current SDK `modelUsage` and `total_cost_usd` are cumulative within a `query()` invocation, including streaming-input turns; the collector reconciles those totals instead of summing each result. Observed native-subagent requests are attributed using emitted subagent types, with `unknown` when absent. Their attribution is a diagnostic subset of the invocation total, not another charge to add. Internal calls may appear only in the aggregate, and native-subagent costs are not independently inferred from tokens.

Codex SDK completion usage belongs to the turn. App Server totals belong to the native thread: for a resumed turn, its first current-turn update establishes the preceding baseline as `total - last`; subsequent updates contribute the delta. If a resumed invocation lacks the initial `last` counters, the corresponding fields remain unknown rather than counting earlier thread work. Repeated totals do not add usage. Counter resets preserve work already observed. The adapter filters by thread and turn IDs. Missing or delayed updates limit accounting and enforcement precision. This follows the pinned runtime protocol and [App Server event interface](https://learn.chatgpt.com/docs/app-server); it does not poll a private quota endpoint.

These are resource observations and provider cost estimates, not subscription invoices or a measurement of savings versus APIs. Native OpenTelemetry remains an optional operator-configured source for deeper diagnostics; this change does not enable an exporter or send telemetry elsewhere. [Claude monitoring reference](https://code.claude.com/docs/en/monitoring-usage).

## Optional subagent limits

Existing role `maxTurns`, subagent timeout and concurrency caps remain. Add `maxTokens` to a configured role to stop a subagent after its observed token total reaches that limit. Cache reads count toward that total. Add `maxBudgetUsd` for Claude's native estimated-cost cap. Both are absent by default.

This **configuration fragment** defines one role; supplying `workers.roles` replaces the default map, so preserve other roles you still want:

```json
{
  "research": {
    "enabled": true,
    "workers": {
      "roles": {
        "analyst": {
          "description": "A bounded analysis",
          "prompt": "Analyze the supplied evidence and verify the result.",
          "effort": "high",
          "maxTurns": 25,
          "maxTokens": 200000
        }
      }
    }
  }
}
```

For a Claude-only role, an additional `"maxBudgetUsd": 2` passes the cap to the Claude SDK. If that role is routed to Codex, Clawstrum reports an unsupported cap and does not start execution; it does not fabricate a Codex price or silently ignore the requested ceiling. `workers.account` is a preference rather than a provider lock, so use the token limit for roles intended to move between providers.

The token limit is a stop-on-observation limit, not a prepaid reservation or an exact hard ceiling: a request may already have consumed tokens before it reports usage, and some internal calls surface only at completion. Claude's native estimated-cost enforcement operates inside its runtime but remains an estimate. Exceeded limits retain usage, event artifacts and an explicit failed status for review. There is no automatic retry with a fresh budget.

## Steering and continuing subagents

`research_steer` accepts a subagent UUID, a stable key and a text correction of at most 8,000 characters. The CLI equivalent is `clawstrum research steer SESSION --input correction.json`:

```json
{
  "id": "REPLACE_WITH_WORKER_UUID",
  "key": "normalization-correction",
  "message": "Use population variance, and verify the saved normalization before continuing."
}
```

Replace the placeholder with an actual subagent UUID. Instructions are persisted and delivered in order, with at most one acknowledgment pending per subagent and twenty outstanding instructions. MCP keys are scoped to the parent logical input; CLI keys persist across that conversation's CLI calls. Reusing a key with changed text fails. The lead can inspect `research_status` with `collection=subagents` (`workers` accepted) to see each instruction's state:

| State      | Meaning                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| `queued`   | Waiting for a ready provider and open input transport                         |
| `sending`  | Delivery started; acknowledgment is outstanding                               |
| `accepted` | Claude's input stream or the matching Codex turn accepted it                  |
| `rejected` | Delivery was rejected, cancelled before delivery, or the subagent ended first |
| `unknown`  | Delivery may have occurred, but no valid acknowledgment survived              |

Acceptance does not establish model adoption. Steering does not kill a command already running, extend a deadline, or create another model turn to imitate support. Claude uses streaming input; Codex subagents use the bundled App Server's guarded `turn/steer`. Scheduled Codex lead work retains its SDK path. Research subagents cannot dispatch or steer other Clawstrum subagents through their MCP tools.

Uncertain delivery is never automatically replayed. Inspect the artifacts and current outputs before deciding what to do next. An ended subagent rejects new steering; a repeated key can still retrieve the original delivery record.

To continue an ended subagent, create a new `research_delegate` request with a new key, role and brief, and `resumeFrom` set to its UUID. The old subagent must belong to this conversation. The new subagent gets a fresh native context and its own budget, with pointers to the old BRIEF, RESULT and EVENTS artifacts and its saved summary. It is instructed to inspect actual project state before acting. The old record and files remain intact. This is explicit continuation from evidence, not native-session resurrection, verified workflow caching, or automatic replay of edits and submissions.

## Quiet tools and compaction recovery

The lead tracks observed tool start/completion IDs in both providers. While a tool is in flight or Claude reports a live background task, event silence alone does not kill the turn. Completion refreshes the silence clock. Background task tracking works even with research or `holdBackgroundTasks` disabled; that setting controls input-stream lifetime after a result, not the watchdog. Full SDK task snapshots are authoritative once observed; older CLIs fall back to task start/update/terminal events. Snapshot and bookend ordering is unspecified, so the tracker never mixes them after the first snapshot. Counts reset on each provider attempt, including account/provider handoffs. The wait includes SDK-reported ambient monitors because an armed watch can legitimately be quiet; it does not establish that the watched work is healthy. Startup and absolute-turn deadlines, explicit cancellation and supervised process cleanup still apply. A tool without a completion event can therefore run until the absolute deadline; disabling that deadline is an explicit operator choice. Use scheduled/cluster work for computations whose lifecycle should outlast the provider process.

Claude `SessionStart(compact)` remains the primary context restoration path. If `PostCompact` confirms a compaction that was not restored, the next `PreToolUse` supplies the same invocation/native-agent-scoped state once. This also works with research validation off, and preserves strict validation decisions when enabled. `PreCompact` alone never arms restoration because the runtime can decide there is nothing to compact. The fallback does not read undocumented transcript flags. It cannot help if no confirmation arrives or no later tool runs; no authenticated claim about hook failure rates is made.

## Explicit research-note revisions

Use a new `research_note` key and `supersedes` containing one or more current note UUIDs. This can replace an outdated decision or consolidate duplicate notes. References must belong to the same conversation. An already superseded note cannot be replaced again through a stale branch; inspect its current replacement first. Repeating the same request is idempotent.

SQLite and raw history retain original text and replacement links. AGENTS.md MEMORY retains current notes and authored explanations. The agent or user selects explicit note revisions; long-term consolidation can reconcile recorded corrections into current memory, while cross-channel propagation remains deliberate.

## Citation and scheduler evidence

DOI verification falls back from a Crossref 404 to the [public DataCite singleton API](https://support.datacite.org/docs/api-get-doi). It validates the returned DOI, requires title/creators, and retains the response bytes, hash and source. Organizational creators and publisher objects are supported. Related version identifiers are preserved as metadata; they do not establish that a work is retracted. Throttling, malformed Crossref metadata and transport errors remain explicit errors rather than triggering an unrelated lookup.

Slurm observations now classify explicit scheduler states such as OOM, timeout, preemption and node failure, retaining job/step IDs and exit status with suggested checks. Generic FAILED and exit 137 do not prove a memory failure. Classifications do not change terminal detection, accounting completeness requirements or duplicate-submission handling. No resources are automatically changed and no job is automatically resubmitted. MaxRSS remains a scheduler observation, not an estimate of an entire future allocation's memory requirement.

## Conversation consolidation

Long-term consolidation is now part of the core memory lifecycle for both providers. It processes the complete history interval in resumable chunks and updates AGENTS.md MEMORY before planned native-session rotation. It runs once a local day per channel with new history (the daily pass, which does not rotate) and after a native compaction (which does), with user work taking priority over idle maintenance. The old 4 MiB byte trigger is off by default. Configuration lives under `runtime.consolidation`; the prior sampled transcript digest, candidates queue and independent file curator are retired.

See [memory lifecycle](memory-lifecycle.md) for source coverage, native compaction, section ownership, configuration, evidence lookup, concurrency, commit recovery and migration. Usage retains the `consolidator` role. Mechanically complete coverage is not a guarantee of semantic recall.
