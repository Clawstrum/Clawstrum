---
name: harness-health
description: Diagnose the daemon's own health, main-loop stalls, failed deliveries, stuck consolidation or memory review, and subagent failure rates, using the built-in profiling commands.
triggers: harness health, daemon stuck, event loop stall, failed outbox, slow today, subagent failures, is the daemon ok, check the daemon
not_for: Reviewing conversation behavior, writing habits or past replies (self-review); a single job or experiment that failed for reasons outside the harness itself.
examples: the agent felt slow today, check the daemon | why are replies not being delivered | check whether memory review is keeping up | one subagent role keeps failing, find out why
---

Use when something about the harness itself, not the conversation, looks off: slow responses, missed deliveries, a subagent role that keeps failing, or a suspicion that background maintenance (consolidation, memory review) has stalled. These commands are read-only queries against the daemon's own state; running them changes nothing.

1. Run `clawstrum performance [SESSION] --since ISO_DATE [--limit N]` for the window in question. Read `health.warnings` (`event_loop_stall_observed`, `daemon_heartbeat_missing_or_stale`, `runtime_profile_missing_or_stale`, `user_queue_over_one_minute`, `provider_native_compaction_active`), `health.outbox` for rows with status `failed`, and the `runtime.samples` series for `eventLoop.maxMs` over 10000. A main-loop delay of a second or two is normal and not worth reporting; a delay over 10 s means incoming messages and deliveries were held up, and several in the window is a stall worth reporting.
2. Check `consolidation_completed`, `consolidation_deferred`, `memory_review_completed` and `memory_review_deferred` events for the same window. Deferrals with no matching completion afterward mean that maintenance is not catching up; a deferral followed by a completion is normal throttling, not a problem. `runtime.state.maintenanceBudget` in the performance output shows the remaining reservations and which roles used them.
3. Run `clawstrum subagents profile [SESSION] --since ISO_DATE [--limit N]` (`workers` is an accepted alias) and read the `statuses` and `reviews` counts per role group. A role with a rising `failed` count, or `rework`/`unused` outweighing `accepted`, is the one to dig into first; read its actual subagent artifacts before concluding why.
4. Run `clawstrum usage profile [SESSION] --since ISO_DATE --format markdown` when cost or token volume is part of the question, for example a role spending far more than its peers.
5. Report the exact warning or metric, the sample or run it came from, and the threshold it crossed, not an impression. If nothing in the window crosses a threshold, say so plainly instead of writing up something that follows the usual pattern.

A warning here does not by itself authorize a restart or config change; any fix beyond reporting needs its own authorization.
