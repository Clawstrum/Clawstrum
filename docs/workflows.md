# Operations and optional workflows

## Feature defaults

Implemented features are on by default, with explicit opt-outs. The standard profile includes research tools, background-task handling, conversation consolidation, raw history and Slurm helpers. Feature availability still depends on configured accounts and host tools: Slurm does not submit a job merely because its helpers are enabled, and paper-service credentials/contact details remain deployment inputs.

Schema defaults apply to omitted fields. Upgrading preserves an existing explicit `false`; review those settings when you want a feature on. See the [configuration reference](configuration.md).

The workflows below use the configured `CLAWSTRUM_HOME`, conversation IDs and explicit arguments. Guided setup schedules a nightly self-review in the main channel; no backup timer is enabled automatically.

## Live database snapshots

The existing `clawstrum backup DIRECTORY` remains an offline state-tree backup. The new live operation copies **SQLite only**, while the daemon continues to work:

```sh
clawstrum backup live /absolute/private/backups --keep-last 12 --keep-days 7
clawstrum backup verify /absolute/private/backups/snapshot-TIMESTAMP-UUID
```

Live WAL snapshots and review collection require Node **22.16 or newer** for `node:sqlite`'s backup API. Other commands retain the existing Node 22.13 minimum. A missing WAL backup API produces an explicit error; copying the main database alone would omit committed WAL pages.

Each snapshot directory contains `clawstrum.db` and `SNAPSHOT.json`, including source, timestamp, checksum and scope. The source is opened read-only without running schema migrations. WAL databases use SQLite's online backup API. Rollback-journal databases hold a SQLite read transaction while copying the main file, preventing concurrent commits from continually restarting the backup. Writers wait for that copy; rollback-journal Store connections allow up to 60 seconds of contention, while WAL connections retain five seconds. A large or slow copy can still exceed that allowance. Integrity is checked before publication; database and manifest files are private. A snapshot appears under its final name only after it is complete. `latest.json` identifies the latest published snapshot. A SQLite mutex serializes snapshots and retention targeting the same directory and releases on process death.

Retention keeps the newest N snapshots plus one per distinct backup date for the newest D dates, using UTC dates. It only prunes matching snapshot directories whose manifest names this source database; unrelated files and other sources are retained. An interrupted process can leave a hidden temporary directory; it is not published or treated as a successful backup. A timer run has a fifteen-minute limit, so persistent contention becomes a visible service failure. Manual runs have no total wall-clock deadline. Use a dedicated private backup directory for each installation.

Generate an optional Linux systemd timer:

```sh
clawstrum service backup --directory /absolute/private/backups \
  --interval-seconds 300 --keep-last 12 --keep-days 7 \
  --output ~/.config/systemd/user
systemctl --user daemon-reload
systemctl --user enable --now clawstrum-backup.timer
```

Without `--output`, the command prints the service and timer as JSON. The timer works whether the daemon is currently running or stopped. Inspect its failures with `systemctl --user status clawstrum-backup.service`. On other platforms, schedule the same CLI command with an existing scheduler.

These snapshots do not include configuration, credentials, workspaces, attachments, symlink targets or external project files. Continue to back those up separately, or use the offline state-tree command with its documented scope. For recovery, stop **all** writers and timers, preserve the current database and sidecars, verify the snapshot, restore its database to the configured storage location, and start a compatible binary. Reconcile external actions and Discord delivery before replaying work. This feature does not automatically restore or replace a live database.

## Planned restart

```sh
clawstrum restart request --drain-ms 30000 --timeout-ms 3600000
clawstrum restart status
clawstrum restart cancel
```

The daemon acknowledges the request by pausing admission of new top-level turns. Messages, schedule occurrences and subagent results continue to queue durably. Existing turns, their research subagents and pending deliveries get a **30-second grace period** by default. If they finish earlier, shutdown begins immediately. Otherwise the daemon uses its normal graceful stop: it saves interruption snapshots, preserves native session IDs and raw history, requeues unfinished lead inputs, and retains pending deliveries. Interrupted research subagents retain partial artifacts and notify their parent for review instead of blindly replaying external actions. It then closes its transports and exits with code **75**. The generated systemd service restarts that exit and declares `CLAWSTRUM_SUPERVISED=1`. A new daemon records readiness only after Discord connection and state recovery; the request records its new instance ID and PID. The grace bounds the wait for work to finish, not provider cleanup or supervisor startup time.

This avoids a race between checking for idle and asking systemd to restart. The admission gate is inside the engine. Queued top-level inputs run after restart; an empty inbox is not required. Research subagents continue to be admitted during the grace period so existing turns can finish delegated work. `--drain-ms 0` explicitly waits for all work and deliveries to finish. `--timeout-ms` remains the cancellation deadline: if it expires before shutdown is committed, admission resumes without interrupting work. Keep it longer than the grace period when checkpoint-and-resume is desired. Failed deliveries remain visible to `doctor` and are not silently retried by restart.

`--wait` waits for the replacement's readiness. Use it from an external operator process. An agent requesting its own restart should omit `--wait` and finish its turn, otherwise it would wait for itself. `cancel` works before shutdown is committed. A wait timeout does not cancel a pending request. If supervision fails after exit, inspect service logs and restart manually; `status` remains `restarting` rather than claiming success.

Regenerate an older service unit to obtain `CLAWSTRUM_SUPERVISED=1`, then reload systemd and perform one ordinary service restart. Other supervisors may set that variable when configured to restart exit 75. Unsupervised or unresponsive daemons reject a coordinated restart request. This command does not install code or change the configured executable. Build/install the intended version first, following the usual upgrade and backup procedure. Model timeouts and explicit stop/switch controls continue to operate during draining.

## Decision linting

```sh
clawstrum decisions lint /project/decisions.md
clawstrum decisions lint /workspace/decisions.md --shared-target /project/decisions.md
```

The command returns advisory JSON findings and exits 1 when there are findings. It never edits decisions or prevents an agent from using its normal tools. It detects duplicate active tags, malformed decision entries, invalid calendar dates, and retired entries missing an explanation. Fenced examples are ignored. Tags accept letters, digits, dots, underscores and hyphens. Sections headed `Superseded`, `Retired` or `History` contain inactive decisions. Only an explicitly supplied `--shared-target` requests symlink-target validation; no project names are built in.

```md
## Active

- 2026-09-17 [report.v2]: Save full results as an artifact.

## Superseded

- 2026-09-10 [report.v1]: Superseded by [report.v2].
```

The optional `templates/skills/decision-hygiene/SKILL.md` describes a workflow. Install it in the state or workspace skills directory if desired. These syntax checks cannot determine whether two differently tagged statements contradict each other or whether a decision is scientifically correct.

## Prose linting

```sh
clawstrum prose lint /project/manuscript.tex
clawstrum prose lint /project/notes.md
```

The manuscript write gate refuses a substantial `.tex` write until this installation's writing rules are in context, and its refusal names em dashes, bold used as emphasis, and headings that argue instead of naming. This command measures those three and nothing else. It returns advisory JSON findings and exits 1 when there are findings, and never edits prose or blocks a tool. The Unicode em dash and the LaTeX `---` spelling both count as connectives, except on a horizontal rule or a table separator row. A bold run counts only when it does not open the line, since a line-leading bold run is a run-in heading; markdown `**bold**`, `\textbf{}` and `{\bf }` are all recognized. A heading counts when its text matches a closed list of verb-led keywords or ends in `.` or `?`; that list is deliberately crude, which is why the check stays advisory. Fenced blocks, `verbatim`, `lstlisting`, `minted`, LaTeX comment lines and front matter are skipped. Adverbs, passive voice, sentence length and word choice are not checked; those preferences belong in the operator's own rules file.

The same three checks also run automatically. The research write hook lints the payload of every `.tex`, `.sty` and `.cls` write and returns the findings as context on that tool call, so the measurement arrives while the text is still in hand rather than when somebody remembers this command. That path never denies a write and never spends the strict correction budget; an Edit is previewed and reports only the findings it introduces. The command above remains the way to audit a file already on disk.

`templates/skills/onboarding/WRITING.example.md` (copied to `skills/onboarding/` in the home directory) is a starting point for that rules file, with the three measured rules separated from the ones only a reader can judge. Copy it to the workspace root, or to the home directory to cover every workspace, and edit it before relying on it. Both the gate and the automatic lint stay dormant until such a file exists.

## Figure linting

```sh
clawstrum figures lint /project/scripts/make_figure.py
```

Figure code fails the way a batch script fails: nothing catches the mistake until someone looks at the figure, or, on a headless node, until it turns out no figure was written at all. The command returns advisory JSON findings and exits 1 when there are findings, and never edits the script. It detects a file that creates axes and plots into them but labels neither axis anywhere; a rainbow colormap (`jet`, `rainbow`, `gist_rainbow`, `hsv`, `nipy_spectral`, `Spectral`, with or without a `_r` suffix) named through `cmap=`, `set_cmap(` or `colormap=`, which misorders perceived magnitude for sequential data; `plt.show()` with no `savefig(` anywhere in the file; a figure opened with `plt.figure(` or `plt.subplots(` inside a `for` or `while` body when the file never calls `.close(`, since matplotlib keeps every one of them alive; and a font size below 8pt, whether passed to a `set_*` call or set through the `font.size`, `axes.labelsize`, `xtick.labelsize`, `ytick.labelsize`, `legend.fontsize` and `axes.titlesize` rcParams keys. Python comments are stripped before matching. Each of the five is a defect rather than a preference; composition, color choice and panel layout are left to the skill.

These five also run automatically on every `.py` write through the research write hook, on the same terms as the prose checks: advisory in all modes, and an Edit reports only what it introduces. No rules file or configuration is involved. Checks recognize plotting syntax rather than execute Python; font settings in configuration-only files can receive advice. Oversized Write payloads and complete Edit previews are skipped.

## Durable condition watches

Use a watch when completion depends on a file or a cheap observation command. Use a scheduled task when the trigger is a calendar time. Watches do not call a model while waiting.

Example `watch.json`:

```json
{
  "condition": { "type": "file", "path": "results/summary.json", "nonempty": true },
  "message": "Validate the measurements and attach the summary.",
  "intervalMs": 60000,
  "timeoutMs": 86400000,
  "warnAfterMs": 3600000
}
```

```sh
clawstrum watch add SESSION --key experiment-summary --input watch.json
clawstrum watch list SESSION
clawstrum watch cancel WATCH_ID
```

The lead agent has a `watch` MCP tool with `action=add|list|cancel`, the same spec, a stable `key` for additions, and an `id` for cancellation. Keys belong to a conversation; repeating a key with the same normalized spec returns the original record, including its terminal status. A changed spec requires a new key. Paths resolve relative to the conversation workspace. Cancellation through MCP is scoped to that conversation.

A command condition uses `{"type":"command","argv":["program","argument"],"cwd":"."}`. Arguments are passed directly, without an implicit shell. Exit zero means the condition is satisfied; other exits mean it remains pending. Executable errors and timeouts are recorded as `lastError`. Use observation-only commands because a daemon crash can cause a probe to be repeated. Commands retain full host access. An explicit shell executable is allowed when needed.

The default check timeout is ten seconds (maximum sixty), polling interval is one minute (minimum one second), and overall deadline is one day (maximum thirty). At most four probes run concurrently in a daemon. POSIX command probes run in process groups that are terminated on timeout, cancellation of the monitor or probe exit. This is process cleanup, not a filesystem sandbox. Platform restrictions and uninterruptible operating-system I/O can prevent immediate cleanup. A hard-killed unsupervised daemon cannot perform its cleanup; use supervisor control-group cleanup before restarting it.

Watch specifications, next-check times, errors and terminal status are stored in SQLite `metadata` under `watch:` keys. Completion, expiry, and the optional one-time warning each commit their state with a deduplicated task input. Cancellation wins over an in-flight result. A stopped daemon leaves unfinished watches active for the next daemon. Expiry explicitly says completion was not confirmed; it never presents the success follow-up as accomplished. A file already satisfying the condition fires on its first check. File existence does not establish scientific correctness; follow-ups should validate artifacts.

`doctor` reports overdue active watches. `stop SESSION` cancels model work; it does not cancel watches or external jobs. Cancel those explicitly. Historical watch records remain until an operator deliberately manages them; ordinary attachment GC does not remove them.

## Optional self-review

Self-review consists of deterministic evidence collection followed by a user-selected review process. The collector never invokes a model, edits code or changes memory. No automatic style enforcement or code-deployment job is installed.

A new installation can turn this on without any hand-written cron entry or script. Pick a quiet Discord channel for it, then either answer `init`'s interactive question for it, pass `--review-channel ID [--review-at HH:MM]` to `clawstrum init`, or run `clawstrum review schedule --channel ID [--at HH:MM] [--timezone ZONE]` on an existing installation. Either path adds the channel to `discord.channelIds`, creates its session and workspace `AGENTS.md` directly (no live Discord connection needed), writes a short marked section into that `AGENTS.md` describing the harness, and registers a cron task keyed by channel id, so a repeated `review schedule` call or a daemon restart updates that one task instead of creating another. The task's prompt names no installation-specific paths: it tells the agent to use the bundled `self-review` skill and the `clawstrum review pending|collect|complete` commands, to keep the ledger and reports inside that channel's own workspace, and to answer `CLAWSTRUM_QUIET` when nothing needs the user. The schedule defaults to 03:00 in `runtime.timezone` (or the host's time zone if that is unset).

Example `review.json`:

```json
{
  "timezone": "America/New_York",
  "sessions": [],
  "excludeAuthors": [],
  "replyWindowMinutes": 60,
  "longReplyChars": 1200
}
```

```sh
clawstrum review pending --from 2026-09-10 --through 2026-09-16 --config review.json
clawstrum review collect --from 2026-09-10 --through 2026-09-16 --config review.json
clawstrum review collect --date 2026-09-16 --config review.json
clawstrum review complete --date 2026-09-16 --report /private/review-report.md
```

Output defaults to `CLAWSTRUM_HOME/reviews`; use `--output DIRECTORY` consistently for another destination. The default range is the seven calendar dates ending yesterday in the configured timezone. Collection supports at most 31 dates per invocation; pending-date inspection supports 366. `sessions=[]` selects all sessions. Exclusions match stored author labels, which are not proof of human/bot identity.

The collector takes one private, uniquely named online SQLite snapshot and reads that snapshot. It deletes it afterward and fails visibly if snapshotting fails. There is no shared `/tmp` filename and no fallback to querying the live database. Each date receives `MESSAGES.json`, `TRANSCRIPT.md`, `METRICS.json` and a collection receipt. Local day boundaries are calculated independently, so daylight-saving days can contain 23 or 25 hours.

Metrics include input and task-wake counts, delivered agent replies, notices, long replies, reply latency and inputs without a reply inside the selected window. Delivery events determine the reply time where available; imported rows without such events use their stored creation time. Pending/failed outbox rows and provider notices do not count as agent replies. An answer just after midnight can satisfy the previous day's reply window. Windows still awaiting observation are distinguished from elapsed windows without a reply. These are diagnostic heuristics: a later message may not answer the preceding question, and one answer may cover several inputs.

Collection alone does **not** mark a date reviewed. `review complete` records the path and checksum of a nonempty report. Pending-date calculation checks every requested date independently, including holes before a later completed review. Missing/changed reports, changed settings or recollection make the date pending again. A report receipt refers to one specific collection. Collect the completed calendar day before marking it reviewed; collection and completion operations targeting the same output directory are serialized. Keep reports private and retain the raw evidence used to justify a proposed change.

The optional `templates/skills/self-review/SKILL.md` supplies an evidence → change → prediction → later verification workflow and an outcome-ledger format. `clawstrum init` installs it into every new home automatically. Recurring reviews need either the one-step `--review-channel`/`review schedule` setup above, or a cron task added by hand through `clawstrum tasks add`. The schedule and permission to make changes remain user choices; the feature does not automatically deploy changes or restart the harness.

## Optional research skills

`templates/skills/` carries further workflows alongside `decision-hygiene` and `self-review`, installed automatically by `clawstrum init` for new homes, without replacing existing skill directories. Existing installations can copy the desired templates into `H/skills`. `theory` is a derivation protocol whose load-bearing rule is that an analytical result is not trusted until it has been checked numerically against code. `plotting` states what a figure has to show before it is drawn, and `scientific-writing` states a claim at the strength its evidence supports. `brainstorm` separates generating options from judging them, and `iterate` forces one critique pass against a fixed checklist before load-bearing output is sent. `harness-health` points at the `performance`, `usage profile` and `workers profile` commands and the `consolidation`/`memory_review` completed-or-deferred events, so that diagnosing a slow or stuck daemon starts from those instead of from guessing. `onboarding` runs the first conversation after setup (the user, their projects as channels, their skills, tools and data), `customize` covers later changes to instructions, skills, tools and code, and `reviewers` judges work in progress or a final draft. Each is a workflow description with no command behind it, so none of them enforces anything on its own.

A subagent role names the skills its subagents receive, by directory name, under `research.workers.roles.<role>.skills`; the lead receives the whole installed inventory regardless. Defaults give `analyst` `theory`, `coder` `iterate` and `thinker` `brainstorm`, and the three search roles none. A role may name a skill this installation has not installed: the dispatch proceeds and the name is recorded in the subagent's `research_worker_route` event as `skillsMissing`, since a role travels with the configuration while skills travel with the installation.

## Validation and state compatibility

The implementation uses the existing `metadata` table, task inputs and events. Live snapshots are database backups, and a ready replacement process is not proof that a newly installed application version is correct.

Regression coverage in `test/operations-workflows.test.ts` exercises snapshot restoration and retention, source host pinning, checksum failures, decision conflicts, durable watches and cancellation races, bounded command probes, draining with queued input, compiled subprocess restart and readiness, local calendar boundaries, actual delivery timestamps and review catch-up. MCP and installed-package checks cover public entrypoints. These are controlled checks, not a live Discord or provider run.
