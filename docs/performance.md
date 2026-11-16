# Performance and usage

`clawstrum performance` shows where a turn spent its time and whether the daemon is healthy. `clawstrum usage profile` shows tokens by role, day and Jev feature. Both are read-only and make no model calls or Discord requests.

## Performance report

```sh
clawstrum performance
clawstrum performance SESSION --since 2026-09-23T00:00:00Z --limit 50
watch -n 15 'clawstrum performance --limit 5'
```

By default it shows the newest 20 runs started in the last six hours. `--limit` goes up to 100, and `more: true` means some runs were left out. Daemon health covers the whole daemon even when you name a session.

| Metric                   | Measures                                                                        |
| ------------------------ | ------------------------------------------------------------------------------- |
| Input ingress            | Discord message creation to local receipt                                       |
| Queue                    | Receipt to run start, or to joining a live run                                  |
| Preparation              | Run start to the first provider request                                         |
| Provider startup/content | Request to provider ready and to its first event, not an exact first token      |
| Context size             | Characters (not tokens) of prompt, instructions and saved memory                |
| Native compaction        | Compactions the provider reported, and their wall time                          |
| First reply              | First agent output, not counting notices. It can be an acknowledgment.          |
| Delivery                 | Outbox entry to confirmed Discord delivery, including retries                   |
| Daemon health            | Heartbeat age, queue ages, active tools and tasks, subagent and maintenance use |
| Runtime                  | Event-loop delay, daemon memory and CPU, engine tick and SQLite timings         |

CPU and memory cover the daemon, not its child processes. Tick and SQLite timings overlap, so don't add them.

`health.warnings` flags a stale heartbeat or runtime sample, event-loop stalls over 10 seconds, user messages queued over one minute, and a native compaction in progress. The warnings change nothing on their own. A delay of a second or two is normal on a shared login node.

The daemon takes a runtime sample every 15 seconds. The `runtime` field holds the last 60 (about 15 minutes) and restarts with the daemon. Every sample is also appended to `<home>/performance/YYYY-MM-DD.jsonl`, one file per local day, and finished days are gzipped. These files are never deleted and grow about 2.9 MB a day before compression. `clawstrum performance` does not read them.

## Reading a slow turn

1. A stale runtime sample means the daemon's health is unknown. High tick, SQLite or event-loop times point to local blocking or slow storage.
2. Check queue age and the run blocking it.
3. Compare preparation with first provider content and native compaction. A provider can compact for minutes while Clawstrum stays responsive.
4. Compare outbox creation with delivery.

## Native compaction

Clawstrum does not set `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. A low value set elsewhere makes Claude compact early. To go back to the provider default, remove it from the service environment, the Claude profile settings, and each channel workspace's `.claude/settings.json` or `.claude/settings.local.json`. Running provider processes keep the old value until they restart.

## Stuck queue

If your message stays queued for two minutes while the provider has been silent for two minutes with no foreground tool running, Clawstrum saves a diagnostic snapshot and ends that provider turn. The next turn keeps the session and history, and unfinished work resumes in order. A queued watch or job wake-up is passed on the same way once only background tasks hold the turn. Ending the turn stops its local child processes. Slurm jobs and research subagents keep running.

`runtime.queuedInputTimeoutMs` sets the wait (default 120000). 0 turns it off. The events `live_input_rejected` and `queued_input_handoff` record these cases without message content.

In `clawstrum maintenance status`, `remaining` can be above zero while `available` is false, because background calls start at least 30 minutes apart. See [memory call limits](memory-lifecycle.md#call-limits).

## Usage report

```sh
clawstrum usage profile --day today --timezone America/New_York --format markdown
clawstrum usage profile --day yesterday --timezone America/New_York --format markdown
clawstrum usage profile --since 2026-09-29T04:00:00Z --until 2026-09-30T04:00:00Z
clawstrum usage profile SESSION --day yesterday --timezone America/New_York
```

By default it covers the last 24 hours, in JSON. `--day` takes an ISO date, `today` or `yesterday`. The time zone defaults to `runtime.timezone`, then the machine's.

The report compares the channel agents with each configured research subagent (including `checker` and `reviewer`), consolidation, memory review, group review and each Jev decision feature. For each it shows calls, fresh input, cache writes, cache reads, output, total tokens, estimated cost, missing counters, and shares of the total and of the lead. Unused roles show zero calls. Failed calls without counters show unknown usage, not zero.

- Token shares are not subscription quota, and cost estimates are not bills.
- On resumed Claude sessions some internal calls go unreported, so totals can be lower bounds. `accountingSources` shows how each call was counted.
- `coverage.since` is when recording began. Never add `legacySnapshots` to window totals.
- Each record type is capped at 50,000. `coverage.truncated=true` means the totals are incomplete, so narrow the window.

The agent can get its own channel's report through `research_status` with `collection="usage-profile"` and optional `since` and `until`, each a time with an offset (`2026-11-16T03:00:00-05:00`) or epoch milliseconds. Shared and group maintenance appear only in the CLI's all-channel report.

The report also counts Clawstrum's local Claude hooks (compaction backup and restore, instruction refresh, research checks, history recall): checks, denials, errors, time and characters returned. They make no model calls. Their effect on later input tokens is unknown, so `indirectTokens` stays `null`. Codex has no such hooks. Hook counters are saved every 30 seconds and at shutdown, so a hard kill can lose the last batch.

The reports name channels, accounts, models and subagents. Keep saved copies private.
