# Channel groups

A group shares current findings, decisions, artifacts and open questions between related channels. Channels join explicitly, and a channel can be in several groups. Discord threads inherit their parent channel's groups. DMs join only explicitly. Groups and their reviewer are on by default, whether or not `research.enabled` is set.

## Commands

Run these on the machine that holds the database, with the install's `CLAWSTRUM_HOME`:

```bash
clawstrum group create lab --name Lab --purpose "Shared research findings and experimental infrastructure"
clawstrum group join lab SESSION_ID --role "Analysis and measurement"
clawstrum group status lab
clawstrum group leave lab SESSION_ID
clawstrum group board SESSION_ID --input publication.json
clawstrum history SESSION_ID --group lab --action search --query "baseline"
```

`clawstrum status` lists session IDs. Membership follows the Discord channel ID, so renames, account switches and new provider sessions don't change it. Leaving a parent channel removes its threads' inherited membership. An explicit join or leave on a thread overrides what it inherits. `group status` also shows the reviewer's usage, paged with `--limit` and `--offset`. Its costs are provider estimates, not subscription charges.

## Files

```text
H/groups/<id>/AGENTS.md             group instructions and current board
H/groups/<id>/history/records/      group events and review evidence
H/groups/<id>/snapshots/            saved board versions
H/groups/index.json                 membership list, rebuilt as needed
```

`H` is the Clawstrum home. Channel folders don't move. A new group's `AGENTS.md` starts from [templates/group-AGENTS.md](../templates/group-AGENTS.md). You can edit its instructions. Its memory section shows members, entries, open issues and review status. It is rebuilt from the database, so a deleted file comes back.

A run loads the provider account's instructions, then `H/AGENTS.md`, then each group's `AGENTS.md` in order of group ID, then the channel's own. An entry shared with several of a channel's groups appears once. Changes reach an idle channel on its next run and a working channel at its next context refresh, without resetting its session. Leaving a group can't remove what an older session has already seen.

## Board entries

The lead uses the `group_board` tool.

| Action    | Effect                                                                                  |
| --------- | --------------------------------------------------------------------------------------- |
| `list`    | Memberships, current entries and open issues                                            |
| `read`    | One or more boards, or one active or retired entry. Follow `nextAfter` for more         |
| `publish` | Adds an entry for the named groups. It is visible at once and the review runs afterward |
| `revise`  | Replaces an active entry, given its current revision                                    |
| `retract` | Retires an entry for the named groups and keeps its history                             |
| `resolve` | Closes an issue, given its revision, a reason and evidence                              |

Each change needs a `key`. Repeating a key with the same content returns the same result. Reusing it with different content fails. Name the target `groups` unless the channel is in only one group. A revision conflict means you reread and try again.

Example `publication.json`:

```json
{
  "action": "publish",
  "key": "batch-invariance-check-20260921",
  "groups": ["lab"],
  "entry": {
    "kind": "finding",
    "subject": "Baseline rerun agrees under the pinned configuration",
    "summary": "The repeated baseline agreed for this dataset and model revision. Other configurations have not been checked.",
    "evidence": ["history:inbound:DISCORD_MESSAGE_ID", "/absolute/path/to/results.json"],
    "dependsOn": [],
    "supersedes": []
  }
}
```

- `kind` is `finding`, `decision`, `progress`, `question` or `artifact`.
- An entry's `active` status means it stays on the board as context. It does not mean a running job or an open task.
- `observedAt`, `expiresAt` and `reviewAfter` are Unix milliseconds. Only entries with `expiresAt` disappear on time alone. Reaching `reviewAfter` opens one status check for that revision.
- `scope` takes at least one of `project`, `experiment`, `run`, `dataset` and `version`. These are the source's own claims. The board shows observation time and edit time separately, and marks missing scope or date as unspecified.
- `dependsOn` and `supersedes` name existing entries in every target group. Superseding your own channel's entry retires it at once. Superseding another channel's entry opens an issue. Channels that depend on an entry are told when it is revised or retired.

The `history` tool takes `scope: "group", group: "lab"` with `search`, `list` and `read`. Only members can read a group's history. `clawstrum export SESSION_ID` includes the channel's groups, their history, issues and review progress.

You can edit board entries in `AGENTS.md` by hand. Valid edits to existing entries and removals are imported. Stale, malformed or free-form edits are archived and become review issues. Use `publish` for new entries and the commands above for membership.

## Reviewer

After each board or instruction change, the reviewer checks the board for duplicates, replacements and contradictions. It waits `debounceMs` for more changes, at most `debounceMaxMs`. Publishing never waits for it. It runs only when an account has spare capacity, and it yields to your messages.

Default settings:

```json
{
  "groups": {
    "enabled": true,
    "reviewer": {
      "enabled": true,
      "models": { "claude": "haiku" },
      "effort": "low",
      "debounceMs": 10000,
      "debounceMaxMs": 30000,
      "timeoutMs": 180000,
      "chunkChars": 40000,
      "maxCallsPerPass": 8,
      "retryMs": 60000
    }
  }
}
```

- It runs on your subscription with the lead's accounts, but never on the lead's model. On Claude it uses `haiku`. A Codex-only install must set `groups.reviewer.models.codex` to a small model its subscription offers.
- Without a usable account, publishing and sharing go on, and the board shows why review is pending. There is no fallback to paid API calls.
- Group reviews share the background call limit with memory passes, see [call limits](memory-lifecycle.md#call-limits).
- It reads the board, open issues, group instructions and every change since its last review, in chunks of `chunkChars`. It applies its plan only if the board hasn't changed meanwhile. Otherwise the next pass starts over.
- It can retire clear duplicates and replaced entries, and opens an issue when unsure. It checks reported evidence for consistency and does not rerun experiments.

## Issues

An issue starts a review task in the affected channels. With `discord.noticeChannelId` set, its notice, replies and resolution go to that channel and name the affected channels. The notice channel doesn't join the group. Without it, the discussion goes into a thread under the original message, or a shared group-review thread. Your replies there go to the owning channel. Ordinary board updates send no notice. Resolved issues stay in history.

## Upgrading an older install

Groups need database schema 5. The step from 4 is additive, and existing history stays where it is.

1. Stop the daemon and anything else that writes the database. A command refuses to migrate while an older daemon runs.
2. Back up the database and the whole `H` folder, including `H/groups/`. A database backup alone misses group instructions and files.
3. Install the new build, let it migrate, and restart.

To roll back, restore the old build and the old database together. Reverting only the program after the migration does not work.
