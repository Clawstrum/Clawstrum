# Memory, history, compaction and consolidation

Clawstrum maintains **one active `AGENTS.md` per scope**: the shared installation (`H`, `CLAWSTRUM_HOME`) and each Discord channel (`W`). Instructions describe how to act. The document's `## MEMORY` section describes current knowledge and work.

## Files and authority

```text
H/
  AGENTS.md
  clawstrum.db
  history/records/
  channels/<discord-channel-id>/
    AGENTS.md
    history/records/
    artifacts/
```

The channel root can be configured during migration. Discord threads and DMs have their own channel IDs. A channel's SQLite identity survives account switches, native compactions and native-session replacements. The checkout-root development AGENTS.md is independent of these runtime documents.

Each MEMORY has four third-level sections, plus a fifth that exists only after a compaction:

| Section                     | Contents                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Working understanding       | Current objectives, supported findings, applicable decisions and unresolved uncertainty.  |
| Current work                | Outstanding work, next steps, artifacts and external actions already started.             |
| Research state              | Current findings, evidence and a generated block of active jobs/subagents.                |
| History access and coverage | Archive location, navigation instructions and the completed consolidation range.          |
| Last compaction summary     | The lead's latest native compaction summary until the next memory pass merges it (below). |

Keep current applicable facts, with a brief change date and history reference when useful. Replace corrected decisions; detailed obsolete rationale and conversations belong in history. A tentative suggestion is not automatically a replacement decision. Shared memory changes are deliberate lead/user edits, not automatic propagation from every channel.

SQLite owns operational state: queues, delivery, schedules, native IDs, subagent/job identifiers and history coverage. The MEMORY section owns current authored explanations. Research database rows are an audit trail, not a source for reconstructing prose that has been condensed or removed from AGENTS.md.

[`memory.ts`](../src/memory.ts) parses headings outside fenced code, preserves non-memory bytes, serializes harness writes with a SQLite mutex, checks revisions and archives observed revisions before atomic replacement. External editors remain supported. Unobserved intermediate external edits cannot be recovered, and a noncooperating editor can still race an atomic rename; the archive records this observation limit.

## Agent tools

- `memory_update`: read a shared/channel MEMORY and its revision, then replace one section using that revision. Nested headings in section content start at `####`. Standing instructions are outside this tool's update scope.
- `memory_review`: request or inspect the asynchronous shared/channel consistency review. It reconciles corrections independently of session rotation.
- `checkpoint`: compatibility writer for channel MEMORY / Current work.
- `research_note`: retain the original note and explicit supersession links in history/SQLite, and add the current note to MEMORY / Research state. Superseded managed note blocks are removed. Notes already condensed or deleted from memory are not regenerated on an unrelated save. When revising a fact that has been integrated into free-form prose, reconcile that prose with `memory_update` too.
- `history`: `search`, `list` or `read`, scoped to the channel or shared history. Search matches the entire stored record, including its middle. Filters support sequence/time ranges, source and kind. Follow `nextAfter` for result pages and `nextOffset` for long records. Known research-note replacements appear as `supersededBy`.

A channel export includes current shared/channel documents, its raw history and replacement links, lifecycle metadata and research records. `clawstrum export SESSION FILE` avoids printing a large archive to the terminal.

The CLI also exposes `clawstrum history SESSION --action search --query TEXT` and `--action read --id RECORD_ID`. Record IDs and exact paths returned by the tool are the source references to retain in memory.

## Raw history

[`history.ts`](../src/history.ts) writes complete observable provider messages/items, inputs, recoverable partial output and memory revisions to SQLite before materializing immutable private JSON files under `history/records/`. Missing files can be rebuilt from SQLite with `repairHistory`. Provider item revisions have content hashes and one logical byte counter, so repeated snapshots do not multiply the threshold. Codex streaming deltas are batched and flushed on interruption; completed items retain their full exposed result. The archive also retains original native transcripts at Claude compaction and available current native logs during migration.

This is observable history, not access to provider-private state. Attachments and large artifacts remain referenced files. Historic imports identify their provenance and gaps; old shortened events cannot be retroactively recovered by renaming them a full archive. Preserve original provider storage as additional evidence. Archive growth is unbounded by design; include both SQLite and channel files in backup/storage planning.

## Regular consistency review

Memory consistency review reuses the reconciler on an independent schedule, enabled by default. It reviews new evidence after idle activity, with a five-minute cooldown. It no longer runs just because a day has passed with nothing new: the daily consolidation pass below covers that, and `runtime.memoryReview.intervalMs` (default 0, off) restores an age-only run if wanted. It can reconcile current prose, patch evidence-backed stale canonical instructions, mark notes superseded, and refer shared/group conflicts to their owning reviewer. It preserves native sessions and the consolidation coverage/byte counter. `memory_update` still cannot edit standing instructions. The maintenance model receives an additional review contract; no reply blacklist is involved.

## Native compaction: one hook, no extra model

Native compaction continues to be controlled by Claude/Codex. It shortens the provider's working context without resetting the Clawstrum history interval. The order for a lead compaction on Claude is:

1. **PreCompact** ([`compaction.ts`](../src/compaction.ts)): archive all available transcript content and the current document revision IDs.
2. Claude Code compacts natively and writes the summary.
3. **PostCompact**: archive the transcript again; archive the provider's `compact_summary` whole as a `compaction_summary` history record; **write the summary into the channel AGENTS.md** `### Last compaction summary` MEMORY subsection; set the metadata key `consolidation-request:<session>` (separate from `consolidation:<session>`, which holds pass progress). PostCompact cannot return text to the model (the SDK gives it no `hookSpecificOutput`), but it can run code, so the file is the channel to the next session.
4. **SessionStart `compact`** (or the PreToolUse fallback, once): restore changes relative to the query-start instruction/MEMORY snapshot. The restore text no longer asks the lead to edit MEMORY; only the idle pass writes it.
5. **Idle pass**: when the channel is idle, the engine runs one consolidation pass for it, even though the byte trigger is off by default. The pass is shown the section (as `lastCompactionSummary`) and the archived summary record, merges what they hold into Working understanding, Current work and Research state, and fixes lines the summary shows are wrong. When the pass commits, the harness replaces the section with a one-line note (`Merged into ... at <local time>`) and **rotates the native session**: the next turn starts a fresh session from AGENTS.md. This is the consistency check.

Codex App Server observes completed `contextCompaction` items and the legacy `thread/compacted` notification, then re-delivers the current instruction/memory snapshot through explicit `thread/inject_items`. One developer message contains instructions and clearly labeled contextual MEMORY facts; no synthetic user-memory message is added. The official [App Server protocol](https://learn.chatgpt.com/docs/app-server) documents the completion signal. The SDK-only fallback cannot provide every App Server notification; its next normal turn still receives current memory. Codex reports no summary text, so nothing is written to the section: the compaction event only queues the pass (step 5), which reads the new history and rotates. The reload message no longer asks the lead to edit MEMORY.

**The section.** The body starts with `Compacted <YYYY-MM-DD HH:MM> (local), trigger: <auto|manual>.` and holds the summary inside a code fence, cut at 6,000 characters with a note that the full text is in history (`compaction_summary`). Each compaction replaces the whole section; it is never appended to. Written by `updateMemory` under the same memory lock as `memory_update`. The summary is model output, so it cannot add headings: the fence is longer than any tilde run in the text (the parser treats a fence's content as plain text), and lines that look like headings are also escaped for plain-text readers. Subagent compactions are archived but never written, and never queue a pass: this covers a native sub-agent inside a lead's turn (the hook input carries `agent_id`) and a Clawstrum subagent's own compaction (its run carries `CLAWSTRUM_DELEGATION`, and it shares the channel's session id). If the write fails (for example a damaged AGENTS.md), a `compaction_memory_error` history record is kept and the hook continues. The consolidator never writes this section itself: a returned `Last compaction summary` key is dropped, and the harness sets the merged note at commit, only when the committed baseline still held the unmerged text the model was shown. A summary written while a pass is in flight changes the revision, so the pass rebases and the model sees it before the section is cleared.

**Rotation safety.** The pass commits and rotates only through `canCommit`, which is the engine's idle test (no active turn and no queued input), checked immediately before the commit in the same synchronous step. A turn or input that arrives during the model calls leaves the pass pending: nothing is rotated and the request stays queued. A queued input is never dropped by a rotation: it is dispatched into the fresh session. Under constant traffic the pass can wait; the native session then keeps the compacted context it already holds.

The compaction hook works when research tools are disabled. It restores current saved state, not a claim that every detail omitted by the provider's summary has been recovered. The first archive contains the full transcript; subsequent records contain only appended text after verifying the previously archived prefix hash. Cursors are scoped by native context and source path. A rewritten, truncated or reused source is archived in full, and the record and cursor advance together transactionally. An update larger than 12,000 UTF-8 bytes is retained in full in an immutable private `history/context-updates/<sha256>.txt` file and the hook instructs the agent to read it before dependent work. State is tracked per native agent context; a late PostCompact does not cause duplicate restoration. No stale state-file copy, candidate queue, transcript sampling or second summarizer is used.

## Consolidation

[`consolidation.ts`](../src/consolidation.ts) processes the interval since the last completed consolidation. There are three triggers.

**1. The daily pass (the main one, on by default).** Once per local day, for every channel that has new history since its last pass, and once for the shared scope. It works like the "dreaming" phase described in [Components of agent memory](https://www.anthropic.com/research/components-of-agent-memory): offline, it re-reads the new transcripts and turns experience into reusable knowledge. A separate memory reviewer already checks MEMORY lines against new history after each activity burst, so the daily pass does not repeat that. The general advice to be concise does not apply to it: losing a fact or lesson costs more than a longer MEMORY, and it never removes a line only to save space. The pass is told to:

- read the new history since the last pass, together with the existing MEMORY and the research notes;
- extract reusable knowledge, including what no single record states but several show together: procedures that worked, mistakes and their fixes (especially repeated ones), patterns across runs or projects, how the people here want the work done, and open questions the evidence now answers;
- write each item under a `#### Reusable knowledge` heading in Working understanding, as a rule or procedure the lead can act on, with its date;
- maintain those items: refresh the date when new history confirms one, rewrite one that new history contradicts or replaces, and merge duplicates without losing detail;
- keep the rest of MEMORY complete: add durable facts, decisions and current setup the lead did not write down, and move bulky detail out behind a reference (a research note id or a history record);
- never invent facts: every change cites a supplied record.

It runs when all of these hold: `runtime.consolidation.daily.enabled`, the local time in `daily.timezone` (default: `runtime.timezone`, else the host's time zone) is at or after `daily.hour` (default 4), the channel has not had a daily pass that local day, the channel has new history (user and assistant messages, research notes, claims, compaction summaries) since its consolidation coverage point, and the channel is idle. The day is recorded in the database (`consolidation-daily:<session>:last`), so a restart does not repeat a pass. Bookkeeping records and memory edits do not count as new history, so a pass never triggers the next day's pass by itself.

The daily pass **does not rotate** the native session. It reads user-visible exchanges, notes and claims (the same source set as the memory review), not raw tool output, which stays in history for lookup. It uses the same validated section format and patch safety as every other pass: source citations, exact unresolved-work references and revision checks are unchanged. If a channel has a large unread backlog (for example its first pass), the pass reads only the newest `daily.tailChunks` chunks (default 8) and writes a `coverage` record naming the skipped range, which stays in raw history.

**2. A compaction request.** Described above. It merges the `Last compaction summary` section and rotates the native session.

**3. The byte threshold (off by default).** `runtime.consolidation.thresholdBytes` is 0, which turns it off. A positive value restores the old rule: a channel whose new history reaches that many bytes of unique observed conversation content gets a rotating pass at any time of day. The daily pass replaced it because it had run only during the one-time NanoClaw migration. The former native age, lifetime-file-size and turn thresholds no longer trigger rotation.

The engine admits user work first. Eligible idle channels use spare credential/concurrency capacity for a dedicated subscribed-provider maintenance call. New user input aborts maintenance; completed chunks remain saved. Maintenance cannot dispatch external actions. It receives full ordered chunks, current shared/channel memory, applicable instructions, and exact active job/subagent state. It can request read-only paginated history records, workspace artifacts or explicitly referenced external artifacts through a structured lookup response.

Chunks partition the whole processing interval; there is no head/tail sampling or total-input cutoff. Each result replaces a provisional current-state summary and identifies its chunk and source records. Per-pass time/chunk budgets pause work and preserve progress. A time budget that saved new chunks yields another pass automatically; a deadline with no progress remains a failure, and user cancellation always interrupts. If canonical memory changes during consolidation, the next validated chunk reconciles the saved provisional summary with the latest own/shared memory. Already processed history and its cursor are retained rather than replayed. Commit still requires the current revisions. Consistency reviews with exact instruction patches restart preparation when those instructions change. Records arriving during preparation extend the range before commit. Operational identifiers are retained mechanically alongside the model's prose. Unresolved job/process/task references and artifact paths extracted from current work or migrated checkpoints cannot disappear without cited resolution evidence; an omitted reference blocks commit. This mechanical check is conservative and does not prove the semantics of the evidence.

Each source chunk and evidence response supplies short citation labels such as `s1` and `e1`. Verified citations carried in current/shared memory also receive `m1` labels, so rolling summaries do not repeatedly transcribe long IDs. The model can use these in source lists, evidence lookups and `[source:s1]` prose markers; the harness resolves them to permanent history IDs before committing and archives the mapping with each proposal. Unknown labels are rejected. Unrecognized references are left unchanged rather than guessed.

Model-generated headings are nested inside their MEMORY subsection. Explicit continuation fields are folded into their named subsection; model-supplied history coverage is ignored and generated from the actual commit range. Citations may refer to the current source chunk, retrieved evidence, previously processed records, or verified references already present in current/shared memory. Invalid JSON, unsupported citations or omitted work references receive up to two corrective retries using the same complete chunk and the rejected proposal and explicit validation feedback. Every returned proposal is archived; maintenance records do not increase the rotation threshold. Exhausting repair leaves the chunk and native session uncommitted, and archives a `consolidation_rejected`/`memory_review_rejected` record naming the exact chunk hash, cursor, offset and consecutive rejection count. Each pass counts its first invalid proposal before attempting repair, so maintenance pacing cannot bypass rejection accounting. Feedback and the rejected proposal survive a deferred repair or restart. After three rejected passes at the same history position, model calls pause for six hours; repeated failures double the pause up to 24 hours. Source coverage and the native session remain unchanged during the pause. Exhausted repair attempts also save an audit row. The latest validation error seeds the next pass over the same chunk. Rebased or resized chunks do not inherit an unrelated prior error, and committing any chunk clears the rejection state. Audit records have distinct IDs even when different slices share a cursor.

The commit sequence is recoverable:

1. Persist validated chunk results, range manifests and provisional sections.
2. Confirm current document revisions, complete range coverage and an idle channel.
3. Persist the intended replacement hash, archive both document revisions, then atomically replace MEMORY.
4. Transactionally advance coverage and clear the native session ID (rotation). Passes requested by a compaction, and passes started by a byte threshold, rotate. The daily pass advances coverage but leaves the native session alone.

Recovery recognizes a prepared or already-written replacement. An invalid response, capacity failure, cancellation or conflicting edit never counts as a completed consolidation and never triggers planned rotation. Emergency recovery/account switching can replace a native session sooner; it leaves coverage and the unprocessed backlog intact. The next native session receives current memory, pending input and a clearly labeled bounded continuation with access to the complete archive.

A completed pass records a `consolidation_completed` event carrying the chunk count and covered history range, for monitoring whether consolidation is actually succeeding. Older databases may also hold the earlier name of this event, `session_rotation` with reason `consolidation`. A deferred or failed pass instead records `consolidation_deferred`.

Complete source coverage is mechanically testable. Perfect semantic retention, source interpretation and correct rejection of every obsolete claim are not. Original records remain available to audit and correct summaries.

The model is asked to keep the three authored sections around 1,500–2,000 words, exceeding that target when essential current work or evidence requires it. This is a summary-writing guideline, not an input cutoff or a hard output truncation. Exact unresolved-work checks still apply.

Maintenance summarizes observable work and outcomes; historical requests are evidence, not instructions to execute or to reconstruct private model reasoning. Provider refusals remain failures: their explanatory text is retained with the structured error category, and incomplete coverage cannot retire a native session.

## Background-call budget and scheduling

Automatic consolidation (compaction requests and the byte trigger), consistency review and group review share a persistent **24 provider-invocation limit per rolling 24 hours**, across every channel, account and model. The daily consolidation pass has its **own** limit, `runtime.consolidation.daily.maxCallsPerDay` (default 120 per rolling 24 hours, no pacing interval), counted separately, so a long daily pass cannot use up the calls the memory reviewer needs, and the reviewer cannot block the daily pass. One background invocation at a time (`maxConcurrent`) still applies to both. When the daily limit is reached, the remaining channels wait for the next window and a `consolidation_deferred` event is logged once per channel and local day. One background invocation runs at a time by default, with at least 30 minutes between starts across all maintenance roles. This durable pacing prevents an idle backlog from consuming the daily allowance in one burst. Repairs, evidence lookups, failed calls and cancellations consume reservations before dispatch; switching accounts or restarting does not reset the allowance. This counts harness provider invocations, not tokens, vendor-internal HTTP retries or exact subscription charges. Foreground lead turns and requested research subagents have separate controls.

Exhausting the allowance defers maintenance. Raw history and validated partial summaries remain saved; coverage does not advance and native sessions are not retired until a complete valid commit. The first upgraded daemon seeds the ledger from retained maintenance usage during the preceding day, conservatively using its last update time. A deployment after an overrun therefore cannot immediately spend another allowance.

Pending human requests prevent new background dispatch. Interrupted/failed passes back off from one minute to one hour, with retry state surviving a restart. Successful partial passes also wait at least a minute before another pass. Check `clawstrum maintenance status` or `research_status collection=maintenance` for used/remaining calls (the `dailyConsolidation` field shows the daily limit), `available` (whether dispatch is allowed now), and the next available reservation time. A positive daily remainder does not bypass pacing. Completed chunks remain resumable between paced calls; large backlogs can take multiple days. Set `runtime.maintenance.maxCallsPerDay=0` to pause automatic model maintenance without disabling history or native compaction restoration.

**Requested passes come first.** A pass queued by a compaction (`consolidation-request:<session>`) is scanned before every other channel, runs instead of a due review for that channel, may use the whole daily limit, and ignores the pacing interval. Everything else (backlog catch-up and periodic review) may use only `maxCallsPerDay - requestedReserve` calls per 24 hours (`runtime.maintenance.requestedReserve`, default 6, capped at a quarter of the limit), so a backlog cannot leave a requested pass with no call. A requested pass also does not walk a backlog: it reads only the newest `runtime.consolidation.requestedTailChunks` chunks (default 2) of unprocessed history, keeps whatever an in-flight pass already merged, and writes a `coverage` history record naming the skipped sequence range (still searchable in raw history). It then needs at most that many model calls plus repairs.

The engine checks every session for a due rotation, daily pass or review at most once per `runtime.maintenance.scanIntervalMs` (default 60000ms), not on every tick; a session newly marked due waits at most that long before the scan picks it up.

## Configuration

```json
{
  "runtime": {
    "maintenance": {
      "maxCallsPerDay": 24,
      "minIntervalMs": 1800000,
      "maxConcurrent": 1,
      "requestedReserve": 6,
      "scanIntervalMs": 60000
    },
    "consolidation": {
      "enabled": true,
      "thresholdBytes": 0,
      "daily": {
        "enabled": true,
        "hour": 4,
        "timezone": "America/New_York",
        "maxCallsPerDay": 120,
        "tailChunks": 8
      },
      "chunkChars": 120000,
      "maxChunksPerPass": 8,
      "requestedTailChunks": 2,
      "timeoutMs": 600000,
      "models": { "claude": "sonnet" },
      "effort": "low"
    }
  }
}
```

Claude consolidation defaults to `sonnet` (was unset, so the account's own model, and `haiku` in some installs). Other unspecified provider models use that account's configured model. These calls use the existing subscription account pool and record channel usage as `consolidator`. Each individual call is one tool-free model turn; structured evidence lookups require additional calls. Artifact lookups read byte pages instead of loading large scientific files in full; returned evidence is archived. Missing files return uncertainty, and credential files are excluded from maintenance evidence. There is a 20-lookup budget per chunk; exhaustion leaves the chunk incomplete.

`research.enabled=false` does not disable core history/compaction/consolidation. Explicit `runtime.consolidation.enabled=false` disables automatic consolidation, including the daily pass and planned rotation; `runtime.consolidation.daily.enabled=false` disables only the daily pass. Legacy explicit `research.consolidator.enabled/models/effort` values carry forward unless overridden under runtime. Other old consolidator fields, all `research.curation` fields, and `nativeSessionMaxTurns/Bytes/AgeMs` are accepted for configuration compatibility but are inert. Remove them when updating configuration. There is one memory-maintenance implementation, not two parallel paths.

## Existing installations

The schema is version 4. A schema upgrade with existing sessions requires an explicit offline memory migration before daemon startup. Do not run an old binary against the upgraded database.

1. Drain active turns and subagents; stop the daemon and other database writers. Back up SQLite using its online backup API before the upgrade, plus configuration, instruction/memory files and native storage. Record workspace paths and the old build. Do not copy an actively written database with plain `cp`.
2. Run `clawstrum memory migrate --apply`, optionally with `--channels-root /absolute/channels`. The command holds the daemon lock and starts no Discord connection.
3. Migration archives old instructions/imports, memory, checkpoints, research records and retained inputs/events. It folds shared policy into H/AGENTS.md and removes duplicate shared-policy imports from channels. Imported legacy decision/working-memory files become historical memory input. Original files outside a scope are preserved as external references rather than deleted.
4. Shared memory is migrated first. Independent channels then start in descending backlog size, using the configured global/account concurrency limits to reduce offline time. A subscribed-model pass reconciles the complete retained migration interval before retiring active legacy memory files or replacing a native ID. It preserves exact external-work identifiers. Missing native archives and pre-recorder limitations are explicit coverage records. A failure retains progress; rerun the same command after resolving it.
5. Channel workspaces move to the chosen root under their Discord IDs; choose a root on the same filesystem as existing workspaces. Old paths become compatibility symlinks so already-submitted jobs and path-bearing scripts continue working. The canonical database workspace is updated. No external job is cancelled or resubmitted.
6. Verify archive counts, current memory, channel IDs, schedules, research state and paths, then start the new daemon and verify readiness.

Keep the rollback bundle until the deployment is verified. Rollback after schema/path migration requires restoring the matching database, documents and workspace mapping with **all writers stopped**; swapping only `dist` is insufficient. Reconcile external actions and Discord delivery before reverting to an older snapshot.

## Validation

`test/memory-lifecycle.test.ts` covers complete middle-of-record coverage, pagination, source deduplication, lost-file repair, revision conflicts, resumable consolidation, decision replacement and archived migration sources. `test/maintenance-review.test.ts` exercises the compiled provider worker, usage accounting, idle commit and user interruption. Existing provider, compaction, instruction-refresh, research, MCP, migration and delivery suites run against the new layout. Package tests verify installed entrypoints and initialization.

## Channel groups (schema 5)

Related Discord channels can share G/AGENTS.md policy and a SQLite-backed current information board under `H/groups/<id>/`. Publications refresh member context immediately at existing provider boundaries without rotating sessions. An economical subscription reviewer reconciles complete board/change inputs, preserves raw history, and sends concrete issues to Discord review threads. Membership, multiple audiences, revisions, recovery and upgrade requirements are described in [channel groups](groups.md). Existing H/W memory and channel workspaces retain their roles.
