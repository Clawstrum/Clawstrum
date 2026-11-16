# Usage by role, activity and day

`clawstrum usage profile` compares the main channel agents with every configured research subagent (including `critic`), consolidation, memory review, group review and each Jev decision feature. It also reports local-hook activity. Recording is automatic; it makes no additional model calls and does not alter routing or execution budgets.

```sh
clawstrum usage profile --day today --timezone America/New_York --format markdown
clawstrum usage profile --day yesterday --timezone America/New_York --format markdown
clawstrum usage profile --since 2026-09-29T04:00:00Z --until 2026-09-30T04:00:00Z
clawstrum usage profile SESSION --day yesterday --timezone America/New_York
```

The default is the last 24 hours in JSON. `--day` accepts an ISO calendar date, `today` or `yesterday`; timezone defaults to `runtime.timezone` or the host timezone. Calendar windows honor daylight saving transitions. A current or future calendar window is necessarily incomplete. The CLI is read-only and never initializes or migrates a database. The agent can request its channel's report through `research_status` with `collection="usage-profile"` and optional `since`/`until`, each a time with an offset (`2026-11-16T03:00:00-05:00`) or epoch milliseconds. Shared and group maintenance belong in the operator's all-scope report, not an individual channel's report.

## Comparison and interpretation

For each role the report includes invocation counts, completion observations, fresh input, cache writes, cache reads, output tokens, total tokens, provider-estimated cost, missing-counter counts, percentage of all reported tokens and percentages relative to the lead for each counter. It also groups by lead/subagent/maintenance/decision category and by role/provider/model/account. Unused configured roles appear with zero invocations, so a newly installed critic does not disappear from the report. Failed attempts with no provider counters are recorded with unknown usage, not assumed free.

Token percentages are not subscription quota percentages. A million cached input tokens is not equivalent in cost to a million output tokens; compare the separate counters and selected models. Cost estimates are not subscription bills. Jev uses its own API accounting, and failed attempts may retain conservative expense reservations. Old Jev records lack output-token counters; those remain unknown.

Fresh Claude queries use cumulative `modelUsage`, which includes native subagents and native compaction where reported. Some Claude runtimes restore these counters from earlier native-session history on resume, despite the SDK documentation describing fresh counters. Using them again would substantially overcount. Resumed queries therefore use distinct per-turn main-loop `usage`, deduplicated observed native-child requests, and in-flight request observations. Their unobserved internal/compaction calls and cost remain unknown: totals can be lower bounds. No native request is added twice. `accountingSources` identifies which method supplied each invocation's counters. Codex subtracts the pre-turn native-thread baseline from its counters.

## Observations from deployment onward

The existing `usage:<session>:<invocation>` metadata records retain the latest cumulative snapshot for compatibility. The new `usage-ledger:v2:<timestamp>:<id>` records store positive counter differences, plus invocation dispatch/completion observations. Snapshot replacement and each difference commit together. Repeated cumulative events add no tokens; final corrections add only the positive difference. A continued native session gets a new invocation identity, while multiple usage updates within one invocation share that identity.

This makes tomorrow's date-window report possible without assigning an entire long-running session to its last update date. A call spanning midnight contributes each observed difference to the corresponding window. Timestamps are observation time, not precise inference/billing time: a provider can report work late, including in a final reconciliation. A killed process may leave completion or counters unknown. No prompts, tool arguments or message content are copied into the ledger.

`coverage.since` records when the ledger was enabled. Earlier `legacySnapshots` remain in JSON for diagnosis. They cannot reconstruct daily usage, and older Claude snapshots may contain repeated lifetime-session totals. They are **not a reliable historical baseline**; their comparison percentages are disabled and the Markdown table excludes them. Ledger version 2 starts a new coverage boundary for corrected resume accounting; earlier ledger records remain stored as evidence and are excluded from the new report. **Never add historical snapshot totals to observed-window totals.** A report discloses incomplete coverage and truncation. Missing fields are counted, and known totals can be lower bounds.

## Local hooks and indirect context cost

Clawstrum's compaction preservation/restoration, instruction refresh, research validation and history recall callbacks run locally. They make **zero separate model calls**. Research validation includes citation/prose/figure checks, routing, writing rules and the optional paper-push gate. The hook report records checks, responses, denials, errors, elapsed time and returned text characters. Identical text repeated in multiple output fields is counted once within that callback.

Returned text can increase later lead/subagent input and can trigger another model turn. Those tokens are already included in the parent usage; the provider does not say precisely which input tokens or subsequent reasoning belong to one hook. `indirectTokens` therefore stays `null`, not zero. Character counts are not converted to invented token estimates. A critic is a research-subagent role, and Jev-backed advice is a separately metered decision feature; neither is hidden under a zero-token local hook.

Hook coverage is Clawstrum-owned Claude SDK callbacks. Codex does not expose those callbacks. External provider plugins/scripts are outside this inventory. Hook counters flush in small batches after 30 seconds of callback activity or at close; hard kills can lose an unflushed batch. Monitoring errors do not deny tools.

## Overhead and retention

The report uses primary-key range scans of small metadata records, paged in batches of 256 without holding a long read transaction. It does not inspect the large event or raw-history tables. Each of the invocation ledger, legacy snapshots, Jev records and hook streams is capped at 50,000 records; `coverage.truncated=true` warns that the totals are incomplete. Narrow the window if needed. For reproducible comparisons, save the JSON report and its coverage information.

Hook instrumentation adds no database write per tool call. Provider counter changes append one small ledger record in the same transaction as the existing snapshot update; dispatch and completion add records even when counters are unavailable. Metadata records persist with the existing database and backups; no automatic historical deletion is introduced. Keep profiling files private when they contain channel names, model/account routing or subagent details.
