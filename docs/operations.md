# Operations

Run a single daemon per state directory. Keep the SQLite database on a local disk. Do not place a live WAL database on NFS or run two hosts against it. Agents can still read and work on mounted project storage using their normal host tools.

Temporary SQLite `BUSY` contention during a daemon tick is logged as `database_busy` and retried on the next tick, without shutting down active turns. Other database errors remain failures. Repeated contention still needs investigation; it is not evidence that the storage arrangement is healthy.

Stopped-turn notices identify the request or scheduled task, provider/account, actual error and saved run ID. They go into the affected user message's Discord thread; scheduled work uses the most recent user-message thread with an explicit task label. Missing thread support falls back to the channel so actionable failures remain visible. Known environment credentials and common token formats are redacted from the notice; full errors remain in private diagnostics. A provider rejection is not automatically retried or routed around the provider's safeguards. Scheduled reviews should inspect observable conversation evidence, keep working notes in private reports, and return `CLAWSTRUM_QUIET` when no notification is warranted; `<internal>` tags do not suppress delivery.

## Performance and health

`clawstrum performance [SESSION] --limit 20` reports recent message, provider and delivery timings plus current queue and daemon health. See [performance profiling](performance.md) for metrics, monitoring commands and limitations. It is read-only and makes no model calls.

## State and session storage

`CLAWSTRUM_HOME` defaults to `~/.clawstrum` and selects the configuration/state root; it need not be the source checkout. The default locations are:

| State                                                                | Location / way to find it                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Durable sessions, inputs, runs, events, outbox and research records  | `CLAWSTRUM_HOME/clawstrum.db`                                                                                                        |
| Channel AGENTS.md instructions/MEMORY, history, skills and artifacts | `channels/<discord-channel-id>/`; `clawstrum status` reports the actual stored workspace, which migrations may place elsewhere       |
| Native provider credentials and transcripts                          | Each configured `accounts[].home`; Claude stores project JSONL under `projects/`, while provider-native layouts remain runtime-owned |
| Portable normalized history                                          | `CLAWSTRUM_HOME/transcripts/`; bounded handoff snapshots, not complete native transcripts                                            |
| Incoming/outgoing files and diagnostics                              | Workspace `attachments/`, state `outgoing/` and `diagnostics/`                                                                       |
| Research and self-review artifacts                                   | State `research/`, workspace `research/`, and state `reviews/` by default                                                            |
| Backups                                                              | Explicit destination chosen for `backup` or `backup live`; no universal automatic backup location                                    |

An optional `CLAWSTRUM_HOME/STORAGE.json` is a deployment policy separate from `config.json`. It requires `host` equal to Node's exact `os.hostname()`, an absolute `directory` for the database and daemon mutex, and `journalMode` equal to `WAL` or `DELETE`. Store opens, singleton locking and live snapshots check the host before opening the database. It does not move configuration, workspaces, provider homes or attachments. Existing data must be moved deliberately while all writers are stopped; writing this file is not a migration command.

A host pin prevents accidental CLI access from another host; it is not a distributed lease or an access-control boundary. Local disk with WAL remains the supported default. DELETE mode is an explicit deployment accommodation, not evidence that an arbitrary network filesystem safely supports SQLite. Operators must establish filesystem locking/durability and keep every writer on the owning host.

Offline backup puts its database snapshot at the backup root even if live storage was redirected. On restore, explicitly map that snapshot back to the configured storage directory and review the copied `STORAGE.json`; merely starting from a restored tree can otherwise reopen the old absolute database location. Back up external workspace/profile trees separately.

## Long-running service

On Linux with systemd:

```sh
mkdir -p ~/.config/systemd/user
clawstrum service > ~/.config/systemd/user/clawstrum.service
systemctl --user daemon-reload
systemctl --user enable --now clawstrum
journalctl --user -u clawstrum -f
```

The generated service contains absolute executable/state paths, restart-on-failure, a five-second restart delay, disabled start-rate limiting (`StartLimitIntervalSec=0`) and `KillMode=control-group`. It does not add a filesystem sandbox. For macOS, use a user service manager or keep `clawstrum start` in a supervised terminal; a launchd installer is not shipped in 0.1.0. On clusters, place the service on an appropriate persistent/allocated host and choose either a node-local state directory with an explicit backup plan or, as the guided setup does, a home on an NFS version 4 drive with a `STORAGE.json` that pins the database to the login node in DELETE journal mode. If the daemon runs on a login node shared with other users, set `runtime.shellCpuSeconds` (e.g. `300`): every Claude agent shell command then runs under that soft per-process CPU limit and a process over it is killed with a note to submit a job. `sbatch`, `srun` and `salloc` are wrapped to lift the limit, because SLURM copies resource limits into jobs. Codex shell commands are not covered.

Without systemd user services (macOS, and cluster login nodes that do not allow them), run the daemon in tmux under a restart loop that exports `CLAWSTRUM_SUPERVISED=1`, restarts after a non-zero exit with a five-second delay like the unit (75 is a requested restart) and stops on exit 0 or Ctrl+C. The guided setup writes this loop to `CLAWSTRUM_HOME/start-tmux.sh` with `PATH` and `CLAWSTRUM_HOME` written out, because a tmux server started earlier gives new sessions its own environment. A tmux session does not survive a reboot of its host; run the script again there.

A process marked `active` by systemd can still be unhealthy: check the daemon heartbeat with `clawstrum doctor`. On a fatal error, Clawstrum stops intake, interrupts subagents so their progress can be saved/requeued, awaits Discord shutdown and accepted handlers, and closes SQLite. The `start` command then explicitly exits even if an SDK leaves socket handles alive, allowing the service manager to restart it. Cleanup has a 25-second deadline; a stalled cleanup logs `daemon_shutdown_timeout` and exits with failure. Abrupt termination can leave work marked running; startup recovers that state and Discord history, rather than declaring it completed. A synchronous event-loop or filesystem stall can prevent this in-process timer from firing; this is not an external watchdog. Normal SDK shard errors are logged separately as `discord_shard_error`; an unhandled error still triggers fatal recovery, with a timestamp and stack for diagnosis.

For an external check, `clawstrum service health --output ~/.config/systemd/user` writes a timer that runs `clawstrum doctor --notify` every five minutes (`--interval-seconds` to change it). It runs the database health checks plus free space on the state directory's filesystem and, when `STORAGE.json` puts the database on another one, on that filesystem too (each fails below 1 GiB or 2 %) and posts to `discord.noticeChannelId` through the Discord HTTP API, so it works while the daemon is down. It posts when the set of failing checks changes and once when they all pass again. The integrity scan and provider sign-in probes stay with plain `clawstrum doctor`.

Uncaught daemon exceptions/rejections trigger cleanup and a nonzero exit for supervision; the service does not continue in an unknown state. Subagent uncaught failures are reported over IPC before exit and process-group cleanup. SIGINT/SIGTERM abort active SDK calls and return unfinished input to the queue. Subagents have bounded abort/TERM/KILL cleanup; the default silence deadline is ten minutes and the absolute turn deadline is two hours. Interrupted partial text and private diagnostic snapshots remain in state. Stop through the service manager so it can clean up the process group. Detached commands deliberately started by an agent may outlive its turn; stopping a conversation is not a job-cancellation primitive.

## Inspect and recover

```sh
clawstrum status                 # list session IDs and workspaces
clawstrum status SESSION
clawstrum account list                           # includes how each account is authenticated, never a value
clawstrum account test ACCOUNT [--model MODEL]   # one short prompt through the daemon's own adapter
clawstrum switch SESSION ACCOUNT [--model MODEL|default]   # applies without a restart
clawstrum tasks list
clawstrum tasks history TASK_ID
clawstrum export SESSION conversation.json
```

`status` shows the last run outcome and error, queue counts and failed delivery count. Provider quota usage and account cooldowns are in `account list`; model-specific cooldowns live in the bucket observations, so account-wide cooldown alone is not a complete availability signal. Run exports include route and executable-version events. Successful scheduler dispatch is distinct from completion of its resulting work: inspect the associated inbox/run outcome.

| Situation                                                           | Action                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile needs login                                                 | `clawstrum account login ACCOUNT`, then `clawstrum resume SESSION`. An account with `tokenEnv` or a stored `token` is not logged in this way: check it with `clawstrum account test ACCOUNT`; replace a stored token with `printf %s "$TOKEN" \| clawstrum account set-token ACCOUNT` |
| Known-good account remains in cooldown                              | `clawstrum account reset ACCOUNT`, then resume the conversation                                                                                                                                                                                                                       |
| Provider-native session is missing                                  | The engine retries once with portable context                                                                                                                                                                                                                                         |
| Prompt is too large                                                 | Shorten SELF/skills/checkpoint as appropriate, reset the native session and resume                                                                                                                                                                                                    |
| Model request failed repeatedly                                     | Transient failures retry every five minutes after the fast budget; inspect status, switch or stop as needed                                                                                                                                                                           |
| Discord delivery has failed                                         | Transient failures retry for 24 hours with delays capped at five minutes; permanent HTTP 4xx errors (except 408/429) fail immediately. Fix the cause, then `clawstrum retry-delivery SESSION`                                                                                         |
| Active model work should stop                                       | `/clawstrum action:stop` or `clawstrum stop SESSION`                                                                                                                                                                                                                                  |
| Work should continue on another account, or on another model of one | `/clawstrum action:switch account:ID [model:M]` or `clawstrum switch SESSION ID [--model M]`; no restart                                                                                                                                                                              |
| Another host owns the daemon lock                                   | Check that host and its process; never remove the daemon-lock.db mutex to bypass ownership                                                                                                                                                                                            |

Provider errors and normalized tool activity are local records, and may contain private work details. Export only conversations you intend to share. Authentication material stays in private provider homes and `.env`; the release package does not include them.

Accounts: the private list is `runtime/accounts.json` (mode 0600; may hold tokens, so back it up as private) and the owner's rules are `runtime/ACCOUNTS.md`; see [subscription support](subscriptions.md#private-account-registry). A change to either, or to `config.json` `accounts`, reaches the running daemon within seconds; the log lines are `accounts_reloaded` (ids only) and `accounts_reload_failed` (the old list stays). To move an existing installation to the registry: `clawstrum account import --move-tokens` while the daemon runs, check `clawstrum account list`, then write `ACCOUNTS.md`.

## Backup and upgrade

For live SQLite snapshots, optional backup timers and a coordinated restart that lets current work finish, see [operations and workflows](workflows.md). Live snapshots cover the database; the offline procedure below covers the state tree as well.

For a consistent backup, stop the service, run `clawstrum backup /absolute/new/backup-directory`, then restart. The command refuses a live daemon, snapshots SQLite with `VACUUM INTO`, and atomically publishes the copied state tree. Restore to the original absolute state path, or deliberately migrate stored paths. External account/workspace paths and symlink targets are outside this snapshot; quiesce their writers and back them up separately. Include the database, workspaces, account homes, outgoing spool, identity and configuration. Treat that backup as private because it contains credentials and conversations. A live filesystem copy of SQLite and its WAL is not the documented backup procedure.

To upgrade, install a tested package version, stop the service, back up state, update the executable path in the service if necessary, and restart. Check the ready log for the running version, then send a simple test request. A successful build is not evidence that the running service loaded it.

The working tree uses schema 6, which adds the last active model to each session. Schema upgrades require the daemon to be stopped; earlier memory-layout migrations still need their documented preparation. Unsupported versions are rejected before schema writes. Rollback means restoring the complete pre-upgrade backup with the matching binary. Do not point an older binary at upgraded state.

Build in an isolated checkout/worktree. `npm test` and `npm pack` also invoke the build, so running either in a live checkout can replace subagent code while the daemon retains older modules and an older database schema. The `prebuild` check uses daemon ownership metadata from the colocated `runtime` directory or `CLAWSTRUM_HOME` (default `~/.clawstrum`) to reject overwriting the matching active build. New daemon metadata records its entrypoint, allowing an isolated build to inherit the live state environment without being blocked. Legacy colocated metadata and Linux process entrypoints are supported; remote owners of shared builds are treated as active until stopped. This check does not intercept direct `tsc`, arbitrary filesystem writes, or an undiscoverable legacy custom state directory. Deploy a complete tested artifact, migrate while stopped, then verify the replacement PID and readiness.

`clawstrum gc --before 2026-01-01` previews old attachment/spool files, diagnostic snapshots and normalized transcript artifacts; add `--apply` to remove them with the daemon stopped. Pending/failed input and delivery files are protected. Database history and provider-native transcripts are retained. External workspace directories and symlink targets are excluded from cleanup. Back up artifacts you want to keep before deliberate transfer cleanup.

## Turn limits

Lead turns, including scheduled tasks and internal recovery tasks, have no tool-turn cap by default: `runtime.scheduledMaxTurns=0`. If a deployment sets a positive value, it applies to every task-only lead turn, including denial recovery and research-result wakes. Claude enforces native turns; Codex counts completed tool items and may exceed the limit by one. An explicitly configured limit produces a saved, resumable failure with a specific limit notice, not a generic fatal-error notice. It does not automatically retry and reset its own budget. Set the value to `0` to remove the cap, restart the daemon to load the configuration, and use `resume` only for work that still needs completion. Separately configured research-subagent budgets and runtime watchdogs still apply.

## Self-review

The useful part of a daily self-review is a falsifiable loop: identify an interaction failure from raw evidence, make a small change, name a measurable expectation, and verify it on later use. The optional [self-review collector and skill](workflows.md#optional-self-review) provide private evidence, configurable metrics and explicit review receipts. Guided setup schedules the nightly review in the main channel; the scope and policies of any change it makes are yours to set.

## Research operations

`clawstrum research status SESSION --input status.json` reads durable notes/subagents/jobs/citations. Doctor reports unresolved submissions, overdue watches and stalled subagents, and checks optional tool executables when the profile is enabled. General stop cancels model subagents but does not cancel remote Slurm jobs or their watches. Use `research_cluster` action `stop-watch` to stop polling. Unknown submissions must be reconciled by their scheduler comment before adoption; never simply resubmit them. Preserve research artifacts separately when pruning other state; current GC does not delete research evidence. Full details and example inputs are in [research.md](research.md).

## Memory lifecycle upgrades

Schema 4 uses one AGENTS.md per shared/channel scope. Existing installations require an offline, resumable `memory migrate --apply` before startup. Preserve a database/document/path backup and the matching prior build; a build-only rollback cannot reverse this migration. See [the memory lifecycle migration guide](memory-lifecycle.md#existing-installations).

## Channel groups (schema 5)

Related Discord channels can share G/AGENTS.md policy and a SQLite-backed current information board under `H/groups/<id>/`. Publications refresh member context immediately at existing provider boundaries without rotating sessions. An economical subscription reviewer reconciles complete board/change inputs, preserves raw history, and sends concrete issues to Discord review threads. Membership, multiple audiences, revisions, recovery and upgrade requirements are described in [channel groups](groups.md). Existing H/W memory and channel workspaces retain their roles.

## Memory consistency maintenance

`runtime.memoryReview.enabled` defaults to true independently of consolidation. Claude reviews use `sonnet`; configure `runtime.memoryReview.models.codex` to enable an economical Codex maintenance route. `memory_review` requests a review or reports coverage/status. Inspect `memory_review_completed` / `memory_review_deferred` events and the corresponding raw-history records. The default debounce is 30 seconds, cooldown five minutes, fallback daily, chunks 80,000 characters, four chunks per pass and five minutes per pass. User work preempts maintenance. A successful review preserves native IDs and rotation coverage. See [memory lifecycle](memory-lifecycle.md#regular-consistency-review).

## Discord recovery and internal output

Account/model notices identify the source conversation separately from their operator-channel destination. DMs use a direct-message label; channels and threads use their names and stable IDs. These labels work across guilds without relying on Discord mentions. Failed source lookups retain the ID and do not prevent delivery; retries reuse the frozen payload.

Recovery reads known conversations before discovering additional threads. Up to four conversations recover concurrently, so one slow route does not block all others. Existing cursors and message IDs retain their deduplication behavior. The `discord-recovery` metadata record exposes the current phase, conversation count, start time and last phase change.

A bare `CLAWSTRUM_QUIET` line is internal control text. Provider results, the message tool and final Discord delivery suppress it, including queued payloads from older builds. Real prose, attachments and quoted/code examples remain intact. An unanswered human request gets one delivery-correction attempt; repeated silence becomes an explicit failure rather than a silently completed request. This does not certify that an earlier progress message fully answered the request.

Returned answers are deduplicated against text already delivered in the same answer during the preceding two minutes. Whitespace-only differences in prose are ignored, while code formatting is preserved. Message length and proximity alone never suppress a distinct answer; semantic paraphrases remain deliverable because their equivalence is not established mechanically.
