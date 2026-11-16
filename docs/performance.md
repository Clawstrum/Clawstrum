# Performance and health profiling

For tokens by lead, subagent/critic, maintenance role and Jev feature, use [`clawstrum usage profile`](usage.md). That report also records local-hook activity and separates direct model usage from unmeasurable indirect context cost.

```sh
clawstrum performance
clawstrum performance SESSION --since 2026-09-23T00:00:00Z --limit 50
watch -n 15 'clawstrum performance --limit 5'
```

The command opens SQLite read-only, does not hold a long read transaction, and makes no provider or Discord requests. JSON output can be saved for before/after comparisons. The default is the newest 20 runs started within six hours; `limit` is capped at 100, and `more` indicates an incomplete selection. Runtime/heartbeat/outbox health is daemon-wide even for a channel-filtered run report.

## What is measured

| Metric                   | Meaning                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Input ingress            | Discord creation to local durable receipt, including gateway/recovery delays. Unknown for messages received before instrumentation.                                                                                      |
| Queue                    | Local receipt to run admission or acknowledged live injection. Provider consumption is a separate timestamp when observable.                                                                                             |
| Preparation              | Run start to first provider route; individual attachment, skill-advice and context-building timings are recorded.                                                                                                        |
| Provider startup/content | Request to provider readiness and first observable content/tool/usage event. These are lifecycle observations, not an exact first-token metric.                                                                          |
| Context size             | Prompt, instruction and saved-memory character counts; characters are not tokens.                                                                                                                                        |
| Native compaction        | Observed compaction episodes and wall time from provider status events. Repeated status heartbeats do not count as new compactions.                                                                                      |
| First reply              | First agent-origin output created/delivered, excluding notices. It can be an acknowledgment and does not establish task completion or an answer to every injected question.                                              |
| Delivery                 | Durable outbox creation to confirmed Discord delivery, including retries; pending replies remain unknown.                                                                                                                |
| Daemon health            | Heartbeat age, queue ages/blocking runs, active tools/background tasks, subagent/maintenance counts and maintenance allowance.                                                                                           |
| Runtime                  | Event-loop p50/p95/max delay, daemon RSS/CPU, engine tick and SQLite operation timings. Transaction/tick timings are inclusive and overlap; do not add them together. CPU/RSS cover the daemon, not all child processes. |

The daemon records a runtime sample every 15 seconds, retaining at most 60 samples in one metadata row (about 15 minutes) for `clawstrum performance`'s live `runtime` field. Every sample is also appended as one JSON line to `<home>/performance/YYYY-MM-DD.jsonl` (local calendar day). This history is kept forever, it is never pruned or deleted; a finished day's file is gzip-compressed to `.jsonl.gz` the first time a later day's sample is flushed. One sample line is about 500 bytes, so the history grows about 2.9 MB/day uncompressed (about 1.1 GB/year) before compression shrinks older days. Samples restart with the daemon (a new process starts a fresh 60-sample window and a fresh in-memory day tracker, but still appends to and rotates the on-disk history correctly). A failure writing or compressing the history file is caught and logged as at most one warning; it never breaks the daemon tick. `clawstrum performance` itself still only reads the live metadata row, not the on-disk history files. Query timing receives only fixed operation labels, never SQL or parameters. Per-run timing events and receipt stamps use the existing event ledger and do not enter conversation history, prompt context or consolidation byte counts. Monitoring makes no model calls and does not send automatic Discord notices.

`health.warnings` identifies stale/missing telemetry, event-loop stalls over 10 seconds (a delay of a second or two is normal on a shared login node), user queues older than one minute, and observed active native compaction. These are diagnostic flags, not automatic cancellation or model-switch policies. The current live-run snapshot distinguishes waiting for provider startup, active tools, background tasks, whether the stream has completed or still exposes an injector, and input awaiting transport or lacking a consumption observation. Claude exposes more consumption/status detail than some other transports; missing observations stay unknown.

## Reading a slow turn

1. Check heartbeat and runtime sample age. A stale sample means the daemon cannot currently establish health. High tick/SQLite/event-loop timings point to local blocking or storage contention.
2. Check input queue age and the blocking run. Scheduled/recovery lead work accepts live user text using the same ordering and acceptance safeguards as interactive work. Attachments and delayed retry batches still use the normal preparation path.
3. Compare preparation time with first provider content and native compaction. A provider can spend minutes compacting while the harness remains responsive. Maintenance allowance does not control the provider's own native compaction.
4. Compare outbox creation with delivery. Sends are bounded to 16 concurrent destinations and tracked independently, so a stuck route cannot hold all channel replies behind one global busy flag. Existing per-destination ordering and retry receipts still apply.
5. Compare equivalent workloads and account/model routes. Page-limited percentiles are descriptive observations, not a controlled benchmark or a promise of speedup.

Metadata namespace queries on hot paths use indexed, case-sensitive key ranges. In particular, watch polling and Jev lease lookups must not scan unrelated metadata values on every tick; a query-plan regression checks that the watch poll uses the existing key index. No index migration is needed.

## Context reuse

Both fresh and resumed lead requests put standing MEMORY beside native system/developer instructions, explicitly labeled as facts. Claude resumes with system-prompt snapshots off and installs the latest instructions directly. Neither initial input nor live user follow-ups are prefixed with a whole standing snapshot. Codex replacement uses one developer item. This matters because Claude native compaction can preserve the latest user message verbatim: a large context-update prefix can survive compaction and immediately trigger another.

Claude compaction hooks archive native evidence without another model call. They reuse unchanged native instructions and restore only changes since query start. Large hook payloads are preserved in complete private files with explicit read guidance, avoiding SDK truncation. Existing native histories remain intact.

Clawstrum does not set `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. A low value set elsewhere causes early native compaction even on models with a much larger context window. Clawstrum loads user, project and local Claude settings, so to return to provider defaults remove such a value from the service environment, the Claude profile settings, and each channel workspace's `.claude/settings.json` or `.claude/settings.local.json`; checking only the daemon environment misses workspace overrides. Running provider processes keep the old value until their next launch. Provider thresholds depend on the selected model and runtime. Clawstrum's character budgets, consolidation threshold and daily maintenance allowance are separate controls.

Tests cover queued input during scheduled work for both providers, memory refresh after resume, delivery isolation, bounded telemetry, missing historical timestamps and timing attribution. These tests use fake transports and incur no model usage.

## Queue recovery and maintenance pacing

A new human message must not wait indefinitely behind stale background-task bookkeeping. If it remains queued for two minutes while the ready provider has also been silent for two minutes and has no foreground tool in flight, the engine saves a diagnostic snapshot and releases that provider turn. The next turn keeps the native session and durable input/history. Already answered work is not replayed; unfinished batches are resumed in order. A queued task wake (a watch expiry or research job event), which cannot be injected, is handed off the same way once the provider has returned its result and only background tasks hold the turn. This applies to both backends. Live steering remains the first path, and active tool work is not cancelled by this safeguard. `runtime.queuedInputTimeoutMs` defaults to 120000; zero disables it independently of the absolute and silence timeouts.

`live_input_rejected` records synchronous or asynchronous refusal of an injection. `queued_input_handoff` records queue age, silence duration, injector availability and background-task count without copying user content. Releasing a provider terminates its local child processes; independent remote/Slurm work and harness-managed research subagents retain their normal lifecycles.

Model maintenance defaults to 24 invocations per rolling day, with at least 30 minutes between starts, shared across channels, accounts, roles and repair calls. Check both `remaining` and `available`: daily allowance can remain while pacing defers dispatch. This is separate from local compaction backup/restore hooks and provider-native compaction. Counts cap invocations, not tokens; a single large maintenance call may still be costly. See [memory lifecycle](memory-lifecycle.md#background-call-budget-and-scheduling).
