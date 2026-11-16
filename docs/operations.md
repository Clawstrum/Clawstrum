# Operations

Run one daemon per state directory. Keep the SQLite database on a local disk, not on NFS, and never run two hosts against it.

## State

`CLAWSTRUM_HOME` is the state root, `~/.clawstrum` by default. It need not be the source checkout.

| State                                             | Location                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| Sessions, queues, runs, events, research records  | `clawstrum.db`                                                                 |
| Channel `AGENTS.md`, history, skills, artifacts   | `channels/<discord-channel-id>/`, or wherever `clawstrum status` says          |
| Provider logins and native transcripts            | Each account's `accounts[].home`                                               |
| Portable history snapshots (not full transcripts) | `transcripts/`                                                                 |
| Files and diagnostics                             | Workspace `attachments/`, state `outgoing/` and `diagnostics/`                 |
| Research and self-review artifacts                | State and workspace `research/`, state `reviews/`                              |
| Accounts                                          | `runtime/accounts.json` (mode 0600, may hold tokens) and `runtime/ACCOUNTS.md` |
| Backups                                           | Only where you point `backup` or `backup live`                                 |

Edits to the account files or to `accounts` in `config.json` reach the running daemon within seconds. See [subscriptions](subscriptions.md#account-registry).

An optional `STORAGE.json` in the state root moves the database and daemon lock. It needs `host` equal to Node's `os.hostname()`, an absolute `directory`, and `journalMode` set to `WAL` or `DELETE`. Every open checks the host first. Writing the file moves nothing, so move existing data yourself with every writer stopped. WAL on local disk is the supported default. With DELETE mode on a network filesystem, you must check its locking and keep every writer on the owning host.

Temporary SQLite `BUSY` errors log `database_busy` and retry on the next tick. If they keep coming, check the storage.

## Running as a service

On Linux with systemd:

```sh
mkdir -p ~/.config/systemd/user
clawstrum service > ~/.config/systemd/user/clawstrum.service
systemctl --user daemon-reload
systemctl --user enable --now clawstrum
journalctl --user -u clawstrum -f
```

The unit restarts on failure after five seconds, with no start-rate limit and `KillMode=control-group`. It sets `CLAWSTRUM_SUPERVISED=1` and adds no sandbox. Stop Clawstrum through the service manager.

Without systemd user services (macOS, many cluster login nodes), run the daemon in tmux under a restart loop that exports `CLAWSTRUM_SUPERVISED=1`, restarts after a non-zero exit with a five-second delay (75 is a requested restart) and stops on exit 0 or Ctrl+C. The guided setup writes this loop to `CLAWSTRUM_HOME/start-tmux.sh`. Run it again after the host reboots.

On a cluster, the guided setup puts the home on an NFS version 4 drive, with a `STORAGE.json` that pins the database to the login node in DELETE mode. On a login node shared with others, set `runtime.shellCpuSeconds` (for example `300`). Claude agent shell commands then get that soft CPU limit per process, and a process over it is killed with a note to submit a job. `sbatch`, `srun` and `salloc` lift the limit. Codex shell commands are not covered.

On a fatal error the daemon requeues work and exits non-zero within 25 seconds (`daemon_shutdown_timeout` if cleanup stalls). By default a turn stops after ten minutes of silence or two hours in total.

### Health checks

systemd can call an unhealthy daemon `active`. `clawstrum doctor` checks the heartbeat, queues, schedules, failed deliveries, permissions and sign-ins.

`clawstrum service health --output ~/.config/systemd/user` writes a timer that runs `clawstrum doctor --notify` every five minutes (`--interval-seconds` to change). It runs the database checks and checks free space where the state and database live, failing below 1 GiB or 2 %. It skips the integrity scan and sign-in checks, so run plain `clawstrum doctor` now and then. It posts to `discord.noticeChannelId` through Discord's HTTP API, so it works while the daemon is down, when the set of failures changes and once when all pass again.

`clawstrum performance [SESSION] --limit 20` shows recent timings and the queue without a model call. See [performance](performance.md). Memory reviews log `memory_review_completed` or `memory_review_deferred`. Their limits are in [memory](memory-lifecycle.md#background-passes) and their settings under `runtime.memoryReview` in [configuration](configuration.md).

## Inspect and recover

```sh
clawstrum status                 # session IDs and workspaces
clawstrum status SESSION         # last run and error, queue, failed deliveries
clawstrum account list           # quota, cooldowns, how each account signs in
clawstrum account test ACCOUNT [--model MODEL]
clawstrum switch SESSION ACCOUNT [--model MODEL|default]   # no restart
clawstrum tasks list
clawstrum tasks history TASK_ID
clawstrum export SESSION conversation.json
```

`account list` shows account-wide cooldowns, but one model can be in cooldown on its own. When a turn stops, Clawstrum posts the request, account, error and run ID in the message's thread, with known secrets redacted. The full error stays in `diagnostics/`. A provider refusal is not retried.

| Situation                         | Action                                                                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account needs login               | `clawstrum account login ACCOUNT`, then `clawstrum resume SESSION`. A token account can't log in: check it with `account test`, replace it with `printf %s "$TOKEN" \| clawstrum account set-token ACCOUNT` |
| Working account stuck in cooldown | `clawstrum account reset ACCOUNT`, then resume                                                                                                                                                              |
| Prompt too large                  | Shorten instructions, skills or memory, `reset`, then resume                                                                                                                                                |
| Model request keeps failing       | After the fast retries it retries every five minutes. Switch or stop as needed                                                                                                                              |
| Discord delivery failed           | Retries for 24 hours, at most five minutes apart. HTTP 4xx other than 408 and 429 fails at once. Fix the cause, then `clawstrum retry-delivery SESSION`                                                     |
| Stop model work                   | `/clawstrum action:stop` or `clawstrum stop SESSION`                                                                                                                                                        |
| Continue on another account       | `/clawstrum action:switch account:ID [model:M]` or `clawstrum switch SESSION ID [--model M]`                                                                                                                |
| Another host holds the lock       | Check that host. Never delete `daemon-lock.db`                                                                                                                                                              |

`stop` doesn't cancel background commands, Slurm jobs or watches. See [research tools](research.md). A reply that is only `CLAWSTRUM_QUIET` is never delivered. `<internal>` tags don't hide text: it is sent like the rest.

Lead turns have no tool-turn cap by default (`runtime.scheduledMaxTurns: 0`). A positive value applies to every task-only lead turn, and hitting it saves a resumable failure. Change the value, restart, then `resume`.

## Backup

For a full backup, stop the service, run `clawstrum backup /absolute/new/backup-directory`, then start it again. It refuses to run beside a live daemon. It copies the state tree with a database snapshot, but not account homes, workspaces or symlink targets outside it. Back those up separately. Restore to the same absolute path. The database snapshot sits at the backup root even if `STORAGE.json` moved it, so copy it back to the configured directory. The backup holds credentials, so keep it private.

### Live database snapshots

These copy only `clawstrum.db` while the daemon runs. They need Node 22.16 or newer.

```sh
clawstrum backup live /absolute/private/backups --keep-last 12 --keep-days 7
clawstrum backup verify /absolute/private/backups/snapshot-TIMESTAMP-UUID
```

Each snapshot has `clawstrum.db` and a `SNAPSHOT.json` with its checksum. `latest.json` names the newest. Clawstrum keeps the newest `--keep-last` snapshots plus one per UTC date for the last `--keep-days` dates, and deletes only snapshots of this database. In DELETE mode, writers wait up to 60 seconds during the copy. Use one backup directory per install.

To take one every five minutes on Linux:

```sh
clawstrum service backup --directory /absolute/private/backups \
  --interval-seconds 300 --keep-last 12 --keep-days 7 \
  --output ~/.config/systemd/user
systemctl --user daemon-reload
systemctl --user enable --now clawstrum-backup.timer
```

Without `--output` it prints the units as JSON. Each run has 15 minutes.

To restore, stop every writer and timer, keep a copy of the current database, `backup verify` the snapshot, copy it to the database location and start a matching build. Check what the agent already did outside Clawstrum before replaying work.

`clawstrum gc --before 2026-01-01` previews old attachments, diagnostics and transcript snapshots. Add `--apply`, with the daemon stopped, to delete them. Pending files, database history and research evidence are kept.

## Upgrading

Install a tested version, stop the service, back up, fix the executable path in the unit if it changed, and start. Check the version in the ready log and send a test message.

The database schema is 6. Upgrades need the daemon stopped. To roll back, restore the full backup with its matching build, and never point an older build at upgraded state. An install older than schema 4 first needs `clawstrum memory migrate --apply`. See [memory](memory-lifecycle.md#upgrading-an-older-install). Schema 5 adds [channel groups](groups.md).

Build in a separate checkout. `npm test` and `npm pack` also build and can replace code under a running daemon. A `prebuild` check refuses to overwrite the active build, but can't stop a direct `tsc`. In a source install, `clawstrum apply` builds in a copy. See [customizing](customize.md#code).

### Planned restart

```sh
clawstrum restart request --drain-ms 30000 --timeout-ms 3600000
clawstrum restart status
clawstrum restart cancel
```

The daemon stops starting new turns, and new messages queue. Running turns, their subagents and pending deliveries get 30 seconds by default. Then it saves interrupted work, exits with code 75, and the supervisor starts it again. `--drain-ms 0` waits for all work. If `--timeout-ms` passes first, the request lapses and work goes on. `cancel` works until shutdown starts.

`--wait` waits for the new daemon to be ready. An agent restarting itself should leave it off and end its turn. If the restart fails, `status` stays `restarting`.

The daemon refuses the request unless `CLAWSTRUM_SUPERVISED=1` is set. Regenerate an older unit to get it, or set it in another supervisor that restarts exit 75. The command installs no code, so install the new version first.
