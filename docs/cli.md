# CLI

`clawstrum help` prints the short list, and `clawstrum COMMAND --help` one command. Every command works on `CLAWSTRUM_HOME` (default `~/.clawstrum`). The code is in [src/cli-main.ts](../src/cli-main.ts) and [src/workflow-cli.ts](../src/workflow-cli.ts). Controls such as `stop` and `switch` are queued and take effect at the daemon's next tick.

## Setup and running

| Command                                                                                                                                | Does                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `clawstrum --help` / `help`                                                                                                            | Show the command list                                                                                                                                  |
| `clawstrum --version`                                                                                                                  | Print the version                                                                                                                                      |
| `clawstrum setup`                                                                                                                      | Guided setup in eight steps. See [setup](setup.md#terminal-wizard)                                                                                     |
| `clawstrum setup --yes [--name NAME --provider P --application-id ID --token-file FILE --owner ID --guild ID --channel ID --no-login]` | Take values from flags, as without a terminal. `--yes` never logs in                                                                                   |
| `clawstrum setup --reconfigure`                                                                                                        | Change name, provider, Application ID or Discord IDs. Enter keeps a value, `none` clears server or channel                                             |
| `clawstrum setup --status`                                                                                                             | Print setup progress, Discord's view of the token, `next` and `hint` as JSON. Writes nothing                                                           |
| `clawstrum setup --main-channel NAME [--guild ID] [--owner ID] [--provider claude\|codex\|gemini] [--name NAME] [--json]`              | Find or create the main channel, creating `config.json` if missing, and schedule the self-review there unless another channel has it                   |
| `clawstrum setup --add-channel NAME [--json]`                                                                                          | Find or create a project channel and add it to `discord.channelIds`. No restart                                                                        |
| `clawstrum init [--provider codex\|claude\|gemini --owner ID --channel ID --guild ID] [--review-channel ID --review-at HH:MM]`         | Write a first configuration with account `main` (default `codex`). Asks for IDs on a terminal, else needs `--owner`. Refuses an existing `config.json` |
| `clawstrum doctor [--notify]`                                                                                                          | Check the installation. Exits nonzero on failure. `--notify` runs database and disk checks and posts changes to `discord.noticeChannelId`              |
| `clawstrum smoke ACCOUNT`                                                                                                              | Make one signed-in provider request that must answer exactly `CLAWSTRUM_OK`                                                                            |
| `clawstrum start`                                                                                                                      | Run the daemon                                                                                                                                         |
| `clawstrum service`                                                                                                                    | Print a systemd user unit. It doesn't install or enable it                                                                                             |

## Accounts and conversations

| Command                                                                                             | Does                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clawstrum account list`                                                                            | Show accounts, availability and credential source, never a token                                                                                      |
| `clawstrum account add ID codex\|claude\|gemini [--FIELD VALUE ...]`                                | Add an account (home `accounts/ID/PROVIDER` unless `--home`) to the registry, else `config.json`. No restart                                          |
| `clawstrum account edit ID --FIELD VALUE ...`                                                       | Change `owner`, `label`, `notes`, `priority`, `model`, `effort`, `home`, `executable`, `token-env` or `max-concurrent` in the registry. `none` clears |
| `clawstrum account remove ID`                                                                       | Remove from the registry. Not the last account                                                                                                        |
| `clawstrum account import [--move-tokens] [--force]`                                                | Create the [registry](subscriptions.md#account-registry) from `config.json`                                                                           |
| `printf %s "$TOKEN" \| clawstrum account set-token ID` / `account set-token ID [--clear]`           | Store or remove a Claude token in the registry, from stdin or a hidden prompt. Drops `tokenEnv`                                                       |
| `clawstrum account login ID [--device\|--force]`                                                    | Run the provider's login in the account's home. `--device` uses Codex device login, `--force` logs in an account that runs on a token                 |
| `clawstrum account test ID [--model M]`                                                             | Send one short prompt as the daemon would, print JSON                                                                                                 |
| `clawstrum account reset ID`                                                                        | Clear disabled and cooldown flags, not credentials                                                                                                    |
| `clawstrum status [SESSION]`                                                                        | List conversations, or show one                                                                                                                       |
| `clawstrum switch SESSION ACCOUNT [--model M\|default]`                                             | Set the conversation's account and model. No restart                                                                                                  |
| `clawstrum stop SESSION`                                                                            | Cancel active and queued work                                                                                                                         |
| `clawstrum resume SESSION`                                                                          | Retry failed or delayed input                                                                                                                         |
| `clawstrum reset SESSION`                                                                           | Start a fresh provider session. Files and history stay                                                                                                |
| `clawstrum retry-delivery SESSION`                                                                  | Requeue failed outgoing messages without new model work                                                                                               |
| `clawstrum export SESSION [FILE]`                                                                   | Write the conversation's record as JSON to a file or stdout                                                                                           |
| `clawstrum history SESSION --action list\|search\|read\|rank [--query TEXT] [--id ID] [--group ID]` | Read a conversation's history, or with `--group` a group's                                                                                            |
| `clawstrum history index`                                                                           | Add new history to the local text index. No API calls                                                                                                 |

## Scheduling and watches

| Command                                                                    | Does                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `clawstrum tasks list`                                                     | List scheduled tasks in all conversations                     |
| `clawstrum tasks add SESSION once\|cron SCHEDULE PROMPT [--timezone ZONE]` | Create a task. Quote a schedule or prompt with spaces         |
| `clawstrum tasks history ID`                                               | Show a task's recent runs and errors                          |
| `clawstrum tasks cancel ID`                                                | Stop future runs                                              |
| `clawstrum watch add SESSION --key KEY --input JSON`                       | Add a file or command [watch](workflows.md#condition-watches) |
| `clawstrum watch list [SESSION]` / `watch cancel ID`                       | List or cancel watches                                        |

## Research, groups and memory

| Command                                                                                                | Does                                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `clawstrum research enable [--email CONTACT] [--slurm]`                                                | Turn on research tools, optionally with a literature-service contact and Slurm. Restart to load             |
| `clawstrum research paper\|citation\|note\|delegate\|steer\|cluster\|status SESSION --input JSON_FILE` | Run a research tool from the shell. See [research](research.md)                                             |
| `clawstrum group create ID --name NAME [--purpose TEXT]`                                               | Create a channel group                                                                                      |
| `clawstrum group join\|leave ID SESSION [--role TEXT]`                                                 | Add a conversation to a group or remove it                                                                  |
| `clawstrum group status [ID]`                                                                          | Show groups, or one                                                                                         |
| `clawstrum group board SESSION --input JSON_FILE`                                                      | Publish to a group board. See [channel groups](groups.md)                                                   |
| `clawstrum maintenance status`                                                                         | Show background calls used, remaining and next available                                                    |
| `clawstrum memory migrate --apply [--channels-root DIR]`                                               | Offline memory migration for an older install. See [memory](memory-lifecycle.md#upgrading-an-older-install) |

## Reports and checks

| Command                                                                                                                                        | Does                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `clawstrum subagents profile [SESSION] [--since ISO_DATE] [--limit N] [--offset N]`                                                            | Report on subagent runs. `workers` is an alias                                |
| `clawstrum performance [SESSION] [--since ISO_DATE] [--limit N]`                                                                               | Report turn timings. See [performance](performance.md)                        |
| `clawstrum usage profile [SESSION] [--day YYYY-MM-DD\|today\|yesterday] [--timezone ZONE] [--since ISO --until ISO] [--format json\|markdown]` | Report token use and estimated cost. See [usage](performance.md#usage-report) |
| `clawstrum jev profile [SESSION] [--since ISO_DATE] [--limit N] [--offset N]`                                                                  | Report on the decision service. See [Jev](jev.md)                             |
| `clawstrum decisions lint FILE [--shared-target FILE]`                                                                                         | Advisory checks of a decision log                                             |
| `clawstrum figures lint FILE`                                                                                                                  | Advisory checks of a figure script                                            |
| `clawstrum prose lint FILE`                                                                                                                    | Advisory checks of prose                                                      |
| `clawstrum dashboard sync [--print]`                                                                                                           | Post or update the dashboard forum. `--print` writes it to stdout instead     |

## Self-review

| Command                                                                                                           | Does                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `clawstrum review schedule --channel ID [--at HH:MM] [--timezone ZONE]`                                           | Turn on the nightly self-review in a channel            |
| `clawstrum review pending\|collect [--date DAY \| --from DAY --through DAY] [--config JSON] [--output DIRECTORY]` | List days without a review, or collect a day's evidence |
| `clawstrum review complete --date DAY --report FILE [--output DIRECTORY]`                                         | Record a day as reviewed, with its report               |

See [self-review](customize.md#self-review).

## Backup, restart and upgrade

| Command                                                                                                                                                      | Does                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `clawstrum backup DIRECTORY`                                                                                                                                 | Snapshot state and database, daemon stopped                                 |
| `clawstrum backup live DIRECTORY [--keep-last N --keep-days N]`                                                                                              | Snapshot the database live. Node 22.16 or newer                             |
| `clawstrum backup verify SNAPSHOT_DIRECTORY`                                                                                                                 | Check a snapshot's manifest, checksum and integrity                         |
| `clawstrum service backup --directory DIRECTORY [--output UNIT_DIRECTORY]`                                                                                   | systemd timer for live snapshots (default every 300 s, keep 12 and 7 days)  |
| `clawstrum service health [--interval-seconds N] [--output UNIT_DIRECTORY]`                                                                                  | systemd timer for `doctor --notify` (default every 300 s)                   |
| `clawstrum restart request [--timeout-ms N] [--drain-ms N] [--wait]`                                                                                         | Finish current work, then restart under the supervisor                      |
| `clawstrum restart status` / `restart cancel`                                                                                                                | Show or cancel a pending restart                                            |
| `clawstrum apply [--no-test]`                                                                                                                                | Type-check, build and test this checkout, then restart on it                |
| `clawstrum rollback`                                                                                                                                         | Restore the build from before the last `apply` and restart                  |
| `clawstrum gc --before DATE [--apply]`                                                                                                                       | List transfer files older than DATE. `--apply` removes them. Run it offline |
| `clawstrum import nanoclaw BACKUP --groups-root DIR [--prefix P] [--source-root ROOT]... [--timezone ZONE] [--due-tasks reschedule\|cancel\|fire] [--apply]` | Preview a NanoClaw import. `--apply` runs it                                |
| `clawstrum mcp`                                                                                                                                              | The agent's tool server, started by the daemon                              |

See [operations](operations.md#backup) for backup, restore and upgrade steps. Clawstrum has no automatic updater.

## Daemon

`clawstrum start` takes the daemon lock, connects to Discord with the token from `discord.tokenEnv`, registers `/clawstrum`, reads missed messages and recovers interrupted work. Then it logs `ready` with name, version and process ID. One daemon runs per state directory. The lock lives in `daemon-lock.db` and is released when the process dies. `daemon.lock` records process ID, host and start time. Several hosts can't share one state directory.

On SIGINT or SIGTERM it waits for active work, then disconnects and exits. The unit from `clawstrum service` sets `Restart=on-failure`, `RestartSec=5`, `StartLimitIntervalSec=0`, `KillMode=control-group` and `TimeoutStopSec=30`. On macOS, use your own service manager or keep `clawstrum start` running in a terminal.

## Diagnostics

`clawstrum doctor` checks database integrity, the bot token, provider versions and sign-ins, the daemon heartbeat, schedules, stalled queued work, stale turns, failed deliveries and permissions on `.env` and the configuration. A fresh install that never ran isn't a dead daemon. Version probes time out after 10 seconds, sign-in probes after 20. It prints no credentials and sends no model or Discord request.

`clawstrum smoke` runs in a temporary workspace with no tools and gives up after two minutes.

`clawstrum export` writes metadata, inputs, events, outgoing messages, runs, tasks and task runs, with private permissions. It leaves out workspace files, provider transcripts and credentials, but tool output can hold private details. The console log is JSON. There is no metrics server.
