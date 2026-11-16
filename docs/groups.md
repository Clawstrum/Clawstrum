# Groups of related Discord channels

Groups share current research findings, decisions, artifacts and blockers across related channels. Membership is explicit. A channel may belong to several groups; Discord task threads inherit their parent's memberships, and DMs require an explicit join. Groups and their reviewer default to enabled independently of `research.enabled`.

## Storage and context

```text
H/AGENTS.md                         installation policy and memory
H/groups/<id>/AGENTS.md             group policy and current board
H/groups/<id>/history/records/      immutable group events and review evidence
H/groups/<id>/snapshots/            immutable board projections
H/groups/index.json                rebuildable membership/context manifest
W/AGENTS.md                         channel policy and memory
W/history/records/                 existing channel history
```

`H` is `CLAWSTRUM_HOME`, `W` the channel's stored workspace. No channel directories move.

SQLite schema 5 owns groups, channel names/parents, memberships, canonical entries, per-group audiences/status, issues, delivery routes, mutation receipts and resumable reviewer jobs. The standing instructions in G/AGENTS.md remain editable. Its MEMORY section renders membership, active entries, open issues, review status and the archive path. The template is [group-AGENTS.md](../templates/group-AGENTS.md); creating a group seeds it without changing H/W instructions.

Entry `status` describes board retention, not task execution. `active` means retained as current context, including an explicitly scoped historical question; it does not mean a running job, current assignment, blocker, or permission to resume old requests. `kind` classifies the information. The summary supplies its factual and temporal scope. Tools, rendered context and reviewer requests expose this distinction. Historical framing alone is not a contradiction or grounds to retire a record or ask for confirmation.

Instruction order is **profile → H → member groups (sorted ID) → W**. Group MEMORY enters contextual facts, alongside other MEMORY sections. Shared publications retain one entry/origin ID across audiences and appear only once in a multi-group channel's contextual memory. Other groups' references still identify their participation.

The daemon publishes immutable board snapshots, then atomically replaces the membership manifest. Provider refresh rereads that manifest rather than freezing membership when a turn starts. Publications, joins/removals and policy edits reach idle channels on their next invocation and active channels at their next supported refresh boundary. They do not reset native sessions. Removing membership cannot erase information already present in an older native transcript. Existing complete-memory overflow handling still applies; full boards remain available through the tool and named files.

## Administration

Run commands on the database's owning host, with the installation's `CLAWSTRUM_HOME`:

```bash
clawstrum group create lab --name Lab --purpose "Shared research findings and experimental infrastructure"
clawstrum group join lab SESSION_ID --role "Analysis and measurement"
clawstrum group status lab
clawstrum group leave lab SESSION_ID
clawstrum group board SESSION_ID --input publication.json
clawstrum history SESSION_ID --group lab --action search --query "baseline"
```

Session IDs are Clawstrum's conversation IDs, as listed by `clawstrum status`. Stable Discord IDs determine membership; channel renames, account switches and provider-native session rotation do not change it. Leaving a parent removes inherited membership; an explicit thread join or leave overrides inheritance. Creating/joining a group does not infer other related channels or automatically forward information to other groups.

## Publication and retrieval

The lead's `group_board` MCP tool supports:

| Action    | Behavior                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| `list`    | Memberships, current entries and open issues.                                                                        |
| `read`    | One or more member boards, or an identified active/retired entry. Follow `nextAfter` for entry pagination.           |
| `publish` | Create one canonical entry with explicit audience groups; its revision is immediately visible and review is pending. |
| `revise`  | Replace an active entry's structured content using its expected revision and every active audience.                  |
| `retract` | Retire an entry for specified audiences, preserving its history.                                                     |
| `resolve` | Resolve an issue with its expected revision, reason and supporting evidence.                                         |

Mutations require a stable `key`. Repeating the same key and payload returns the same result; reusing it for different content fails. Ambiguous publication requires explicit `groups`; a sole membership is the default destination. Revision conflicts require rereading current state.

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

Entry kinds are `finding`, `decision`, `progress`, `question` and `artifact`. Optional `observedAt`, `expiresAt` and `reviewAfter` are Unix milliseconds. `dependsOn` and `supersedes` identify existing entries in every target group. Explicit source-channel supersession retires its earlier entry immediately. A proposed replacement of another source's claim raises an issue. Revisions/retirements notify channels with declared dependencies. A direct member correction remains an audited collaborative operation, not an approval gate.

Only explicitly expiring entries disappear on time alone. Reaching `reviewAfter` opens one status check for that entry revision; it does not declare unfinished work completed. Ordinary stable facts have no automatic age-based TTL.

The existing `history` MCP tool accepts `scope: "group", group: "lab"`, with `search`, `list` and `read` and the usual cursors. Membership scopes access; group history does not become installation-wide shared history. Full publications, corrections, retired versions, observed documents, review inputs/attempts/evidence and outcomes are archived. Channel evidence retains its original history IDs and paths. `clawstrum export SESSION_ID` includes its groups, documents, complete group history, issues and current review progress.

## Reviewer

Every board or policy mutation persists a dirty revision. The daemon batches nearby triggers for 10 seconds, with a 30-second maximum debounce. Publication never waits for the reviewer. Maintenance uses spare account/global capacity and yields to queued human input; it resumes durable progress afterward.

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

The reviewer uses the same subscription-backed provider transport and account credentials as the lead, with an explicit economical model mapping. It never inherits the lead's flagship model or model fallback chain. Codex-only installations must set `groups.reviewer.models.codex` to an economical model available to their subscription. Without a configured/available economical account, publication and context sharing continue and board/status show the pending-review reason. There is no silent API billing fallback. Usage is attributed separately as `group_reviewer`, under `group:<id>` in the usage metadata. `group status` includes a paginated usage report (`--limit`, `--offset`); reported costs are provider estimates, not subscription charges.

Each job snapshots the entire current board, open issues, applicable group policy and all relevant changes since completed coverage. Sources are split into complete character ranges, with no discarded middle. Each model reply returns a complete provisional reconciliation plan and working notes; later chunks may revise or withdraw earlier proposals. Chunk progress, lookup results and repair feedback survive pauses. Evidence lookup can page original history and explicitly cited artifact files. Only the final validated plan is applied, after all chunks complete.

Requests enumerate allowed evidence references and existing issue IDs. A citation printed inside an entry must be retrieved before being used as direct evidence; the entry itself can be cited for its reported claim. Repair feedback identifies invalid references and issue revisions explicitly, so an economical model can correct or remove an unsupported proposal. A revision already applied to an entry does not imply that a separate issue exists to resolve.

Before commit the group revision and policy hash must still match. A concurrent publication, membership change or edit invalidates the old proposal and the next pass rereads current state. This conservative check may postpone reconciliation during continuous heavy traffic; it cannot delay publication. Operation validation rejects invented references, wrong revisions, conflicting mutations and replacement cycles. The model has a maintenance-only output contract; it does not execute historical tasks or edit standing policy. Clear supported duplicates/replacements or resolutions may retire entries. Uncertainty opens an issue rather than asserting a winner. Review is consistency checking of reported evidence, not independent replication of experiments.

The review contract and lifecycle definitions also participate in the policy hash. A paused plan from an older reviewer contract is reread under the new contract instead of applying its old provisional operations. This clarifies the model's task; it is not a guarantee that every semantic judgment is correct.

## Issue discussions

An actionable issue creates a concrete internal review task for affected source/dependent channels. With `discord.noticeChannelId` configured, its notice, automatic review replies and resolution go directly to that operator channel, with the affected source channels identified. One issue or resolution notice is delivered even when several source channels investigate it. Internal tasks keep their original workspace and evidence access. The operator channel does not acquire group membership or a new workspace merely by receiving a notice.

Without an operator destination, Discord places the discussion in a thread under the originating message when possible, otherwise in a reusable group-review thread. Human replies in an existing review thread continue there, routed through the owning channel's session. Ordinary channel answers remain in their conversation. The output's source discussion is frozen when queued; the actual Discord destination is persisted before the first delivery attempt. Existing attempted routes and acknowledged chunks survive retries/restarts. An issue's centralized resolution follows its original operator destination even if configuration changes. Operator-channel delivery failures retry there; they never spill into a source channel. Locally routed threads retain the existing actionable-notice fallback.

Regular board updates do not send notices or wake every channel. Group policy asks agents to publish consequential new evidence, correct their own claims, avoid relaying received facts without new evidence, and use received updates as context rather than new user requests. Resolved issues remain in history and receive a resolution notice in the configured destination.

## Direct edits, recovery and upgrade

The document writer preserves instructions outside MEMORY. It detects direct board edits using the exported board and entry revisions. Valid edits to existing JSON entry cards and removals are imported through the database. Stale, malformed or other free-form board edits are fully archived and become review issues; their text is not silently lost or accepted over newer facts. Use `group_board publish` for new structured entries and administrative commands for membership changes. SQLite is authoritative for rendered MEMORY; deleting a projection is repairable.

Schema 4 → 5 is additive. Existing history remains in its original scope; group records receive an explicit group ID. A CLI/MCP process refuses to migrate beneath a running older daemon. Stop all writers, preserve a compatible database backup, install the matching tested build, migrate and restart. Keep the old build and database together for rollback; reverting only the executable after migration is invalid. A SQLite-only snapshot does not back up authored group policy, files or external evidence; include the full home/group tree in file backups.

Tests cover scoped context and live membership, thread inheritance, multiple audiences, idempotency, revision conflicts, expiry/dependencies, direct-edit recovery, archive transaction boundaries, full chunk coverage, paused lookup progress, stale/invalid model proposals, economical routing, compiled provider IPC/usage and threaded Discord delivery. Fixtures do not measure scientific accuracy.

## Declared research scope

An entry may include `scope: {project, experiment, run, dataset, version}` with at least one field. These fields are source declarations, not independently verified facts. `observedAt` describes the observation; the board update time describes the record edit. Rendered boards distinguish both dates and mark missing scope/date as unspecified. Older entries remain readable without a migration and should not be silently treated as current experiment defaults.
