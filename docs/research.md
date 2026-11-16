# Research tools

Claude, Codex and Gemini get tools for literature search, open-access papers, citation checks, research notes, subagents and Slurm jobs. Hooks also check tool calls. All of it is on by default, with advisory checks. `research.enabled: false` turns the tools off, and a feature's own `enabled: false` turns off that feature. [Memory](memory-lifecycle.md) doesn't depend on these settings.

## Setup

```sh
clawstrum research enable --email you@example.org
clawstrum research enable --slurm    # turn Slurm back on if you turned it off
clawstrum doctor
```

Restart the daemon to load the change. For PDF text, install Poppler's `pdftotext` or set `research.pdftotext`. HTML and XML sources work without it. Slurm needs the Slurm commands on the daemon's machine. No cluster, account or partition is built in.

In Discord, ask for what you want, such as "find the full paper, check the DOI, run a small preflight, then watch the job". Retrieval and job polling make no model calls. From the shell:

```sh
clawstrum status
clawstrum research paper SESSION --input paper.json
clawstrum research cluster SESSION --input job.json
clawstrum research status SESSION --input status.json
```

`clawstrum research` also takes `citation`, `note`, `delegate` and `steer`. Get `SESSION` from `clawstrum status`. `paper.json` can be `{"id":"arXiv:2401.12345v2"}` and `status.json` `{"collection":"jobs"}`. Repeating a request's `key` returns the earlier result, so use a new key for new work. Shell keys last for the conversation. Agent keys last for one incoming message, so retries reuse them.

## Tools

| Tool                | Input                                                                                                                                                                                                                                    | Result                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `research_search`   | `q`, `kw` (one or more), optional `ctx`, `para`, `seeds`, `exclude`, `from`/`to`, `k` (default 30), `hops` (0 to 2, default 2), `grader` (`auto`, `jev`, `bm25`), `gradeFrac` (share of candidates Jev scores, default 0.5)              | Top `k` papers, with every candidate in a saved file                                |
| `research_paper`    | `id`: DOI, arXiv ID or version, PMID, PMCID, OpenReview or OSF ID, or URL. `refresh=true` skips the cache                                                                                                                                | Document, extracted text, manifest of sources, versions, hashes and failed attempts |
| `research_citation` | `action=verify`, `check` or `get` with `id`. `check` takes `title`, `authors`, `year`, `quote`, `textPath`. `action=scan` with `text` or `path`                                                                                          | Citation record and source response, or a list of discrepancies                     |
| `research_note`     | `kind` (`finding`, `decision`, `method`, `question`), `title`, `body`, `key`, optional `evidence`, `supersedes`, `claim`                                                                                                                 | Note in history and in memory's Research state                                      |
| `research_manifest` | Files and parameters of a run or deployment, to record or verify                                                                                                                                                                         | Content hashes, or a check against current files                                    |
| `research_delegate` | `role`, `brief`, `key`, `context` and more, see [subagents](orchestration.md)                                                                                                                                                            | Subagent id. The lead is woken with the result                                      |
| `research_steer`    | Subagent `id`, `message`, `key`                                                                                                                                                                                                          | Delivery state                                                                      |
| `research_cluster`  | `action=preflight`, `submit`, `watch`, `adopt` or `stop-watch`                                                                                                                                                                           | Saved script, preflight report, submission state, scheduler observations            |
| `research_status`   | `collection=notes`, `subagents`, `jobs`, `citations`, `usage`, `usage-profile`, `subagent-profile`, `decisions` or `maintenance`, optional `id`, `limit` (1 to 100, default 20), `offset`. Notes also take `refresh`, `query`, `current` | Records, one page at a time. `cancelWorker=true` with an `id` cancels a subagent    |

`workers` and `worker-profile` work as collection names too. Subagents don't get delegation, steering, result review or the lead's Discord tools, but keep full shell access. A tool result over 12,000 characters is saved to a file, and the agent gets an excerpt and the path.

## Literature search

`research_search` runs OpenAlex keyword search per `kw`, OpenAlex semantic search for `q` and each `para` (once as is and once limited to the last two years), and arXiv search on the first three `kw` for the last 18 months. When the year-limited semantic search fails, about a third of the time, a keyword search replaces it without a warning. `seeds` (DOI, arXiv ID or OpenAlex W-ID) are always candidates. `exclude` (IDs or exact titles) never are.

Jev scores how directly each candidate addresses the question. It scores only the top half by word overlap and search rank (`gradeFrac`), and the rest rank after them. Give three or four lines on the project as `ctx`, or ranking gets worse. Calls run up to `decisions.maxConcurrent` at once (at most 24), with 20 s and three attempts per paper. Without a working Jev key or budget, the run ranks by bm25 (word overlap). If Jev fails mid-run (all of the first 12 calls, 8 papers in a row, or more than 25 % once 20 or more are graded), the whole run is re-ranked by bm25. `fallback` gives the reason.

Each hop then adds the references and the 25 most-cited and 25 newest citing papers of up to five papers scored 0.5 or more (plus the seeds in hop 1). A second hop runs only if the first put two new papers in the top `k`. With bm25 there is one hop, from the top 3. A run stops after 240 s or $0.10 of OpenAlex spend. The full result goes to `research/searches/` in the Clawstrum home.

The OpenAlex key comes from the variable named by `research.openalexKeyEnv`. Without it the search warns and runs unauthenticated. `research.email` is sent to OpenAlex and Crossref.

## Paper retrieval

`research_paper` tries free sources in order. arXiv uses the PDF, arXiv HTML and ar5iv, keeping the requested version. A DOI tries PMC, Springer open access, eLife, Unpaywall and the landing page's PDF link. bioRxiv and medRxiv DOIs use their servers' API, OSF uses its API, an OpenReview ID looks for the same title on arXiv and Crossref first, and a ResearchGate URL is resolved by its title. Plain titles are not accepted. If all fail and an OpenAlex key is set, OpenAlex's paid copy is tried while its remaining daily budget is above `research.openalexReserveUsd`.

- A versioned eLife DOI such as `10.7554/eLife.110287.1` is refused if the API returns another version.
- `textPath` is the text in reading order. `layoutTextPath` keeps the page layout for tables but can mix columns. Check quotes, equations and tables against the document.
- Text under `research.minTextChars` (1000) doesn't count. If nothing works, the result is `no-fulltext` with reasons. Scans need OCR elsewhere.
- Cached papers don't expire. Use `refresh=true` when the source changed, especially for unversioned identifiers.
- Unpaywall needs `research.email`. Springer needs the key named by `research.springerKeyEnv`.

## Citations

`research_citation action=verify` looks up a DOI at Crossref (DataCite after a Crossref 404) or an arXiv ID, and saves a record with title, authors, year, venue, correction links and the source response. `action=check` compares title and authors, allows a one-year difference, and finds a `quote` in the `textPath` you give. It doesn't check that the file is that paper or that a claim is right.

`{"action":"scan","path":"report.md"}` (or `"text"`) checks author and year citations, BibTeX, DOIs and arXiv IDs in up to 2,000,000 bytes against saved records, with no network call. Paths are relative to the workspace. `verify` missing ones, then scan again. `ok` means nothing wrong was found, not that everything was checked. Clawstrum also scans `.md`, `.markdown`, `.tex`, `.bib` and `.rst` attachments and writes, but not PDFs. See [hooks and gates](hooks-and-gates.md#tool-call-checks) before treating a clean scan as covering a whole manuscript.

## Slurm jobs

```json
{
  "action": "submit",
  "key": "pilot-seed-42",
  "batch": {
    "script": "/project/experiment/run.sh",
    "cwd": "/project/experiment",
    "inputs": ["data/input.npy"],
    "resources": {
      "time": "00:10:00",
      "mem": "2G",
      "cpusPerTask": 1,
      "output": "logs/%j.out"
    }
  }
}
```

`resources` also takes `partition`, `account`, `nodes`, `gres`, `array`, `error`, `constraint` and `qos`. `cwd` defaults to the workspace. Clawstrum keeps a copy of the script only, so record code versions and seeds with `research_note`.

`action=preflight` checks the same `batch` without submitting: script, inputs, free space, `sinfo`, `sshare`, your `squeue` and `sbatch --test-only`. A `#SBATCH` line after the first command or `conda activate` without a shell hook is an error, and an interpreter from `PATH` a warning. Errors stop a submission.

Submission tags the job `--comment=clawstrum:<record-id>` and starts a watch. If the reply is unclear or the daemon restarts mid-submission, the record becomes `unknown`, and the same key never submits again. Find the job by its comment and adopt it:

```json
{ "action": "adopt", "id": "CLAWSTRUM_RECORD_ID", "jobId": "123456", "cluster": "OPTIONAL_CLUSTER" }
```

`{"action":"watch","jobId":"123456"}` watches a job submitted elsewhere.

- Watches survive restarts and poll every five minutes, 288 times (about a day), with no model calls.
- Results label OOM, timeout, preemption, node failure and cancellation, and keep step `MaxRSS`. Exit 137 alone is not called OOM. Nothing is resubmitted.
- A submitted array is done only when every index is.
- When the job ends or the polls run out (`watch-stopped`), the lead is woken once.
- `stop-watch` stops polling without `scancel`. `!clawstrum stop` leaves jobs and watches running. Adopt a job again to resume watching.

## Research notes

`research_note` saves a note to history and to the channel memory's Research state. To replace notes, use a new `key` and list their ids in `supersedes`. A replaced note can't be replaced again. Originals stay in history. `claim` adds the project, run or version a finding holds for and the files it depends on.

Each lead run gets a list of the channel's current notes (`- <date> <title> (id <id>)`), newest first, limited by `research.notesIndex`. Subagents don't get it. Read a note with `research_status collection=notes id=<id>`, and search with `query="width sweep"` (every word must match). `current=true` leaves out replaced notes.

## Recall

On Claude, when the lead calls `Grep`, `Glob`, `WebSearch` or `research_delegate`, a hook searches the conversation's history for records sharing two or more of the search terms, and returns up to `recall.maxHits` excerpts with record ids, at most `recall.maxNotices` times per run. It never blocks a call and doesn't run in subagents or on Codex and Gemini. Recalls are logged as `research_recall` events. `clawstrum history index` indexes older records.

On each message you send, message recall ranks notes no longer in loaded memory against it, asks Jev about the best `messageRecall.candidates`, and pastes up to `messageRecall.maxNotes` scoring at least `messageRecall.threshold` (1,500 characters each, 4,000 in total). Without a Jev key it does nothing. It logs `research_message_recall` events.

## Checks

Hooks check tool calls: citations and write locations in Write and Edit, writing rules for LaTeX files, raw `sbatch`, direct PDF fetches and Unpaywall calls without a contact. `research.validation` decides whether a finding is advice (`advisory`, the default) or refused (`strict`), or turns the checks off (`off`). Gemini gets only refusals, so there the checks act only under `strict`. Fetches through Codex's and Gemini's own web tools aren't checked. See [hooks and gates](hooks-and-gates.md).

Native `Task`, `Agent` and `Workflow` calls go to `research_delegate` instead, and subagents may not delegate. `research.workers.enforceRoles` sets this: `deny` (default), `advise` or `off`. It applies only when roles are configured. `validation: off` turns this check off too, but [native delegation](orchestration.md#native-delegation) tools stay removed while `enforceRoles` is `deny`.

On Claude, every `Bash` command runs at CPU priority `research.toolNice` (15) so the daemon stays responsive, unless it starts with `nice` or `renice`.

On every provider, outgoing messages and prose attachments are checked for citations, and message bodies against `research.reply.maxLines` (25) and `maxChars` (2000). In `advisory` findings are recorded. In `strict` the first problem holds the message for one correction, then it goes out. See [hooks and gates](hooks-and-gates.md).

## Resource accounting

`research_status` with `{"collection":"usage","limit":20,"offset":0}` (or the same JSON via `clawstrum research status`) lists recorded model calls, with totals by role, provider and account for that page only.

| Field              | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `inputTokens`      | Input, without cache reads                                                 |
| `outputTokens`     | Output, including reasoning tokens                                         |
| `cacheReadTokens`  | Cache hits                                                                 |
| `cacheWriteTokens` | Cache writes. Claude only, `null` on Codex                                 |
| `totalTokens`      | Provider total, or the sum of observed fields, which is then a lower bound |
| `estimatedCostUsd` | The provider's own estimate. `null` on Codex                               |

A missing field means unknown, not zero, and `reportedTotals` sums only observed values. Model calls from programs the agent starts itself are not counted.

## Background tasks

With `research.holdBackgroundTasks` on (default), a Claude run stays open after its result while Claude reports background tasks, which also keeps [live steering](live-steering.md) working. Native tasks don't survive an account switch. Use subagents or Slurm watches for work that must.

## Files

`research/` in the Clawstrum home holds `papers`, `citations`, `jobs`, `compactions`, `tool-results`, `reply-reviews` and `searches`. Subagent files are in the channel's `research/workers/<id>/` (see [subagents](orchestration.md#subagent-context-and-files)). `clawstrum gc` doesn't delete them. Back up workspaces outside the Clawstrum home yourself.

## Configuration reference

All fields are under `research`. Missing fields get their defaults.

| Field                                 | Default               | Meaning                                                                                            |
| ------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| `enabled`                             | `true`                | Research tools, context, subagents and job polling                                                 |
| `email`                               | unset                 | Contact for literature services. Needed for Unpaywall                                              |
| `validation`                          | `advisory`            | `strict`, `advisory` or `off`. Claude tool checks and outgoing citation review                     |
| `requestTimeoutMs`                    | `30000`               | Limit per HTTP request or extraction                                                               |
| `maxDownloadBytes`                    | `50000000`            | Limit per response. Metadata is limited to 5 MB                                                    |
| `minTextChars`                        | `1000`                | Smallest extracted text that counts as full text                                                   |
| `pdftotext`                           | `pdftotext`           | PDF extraction program                                                                             |
| `springerKeyEnv`                      | `SPRINGER_OA_API_KEY` | Variable holding the optional Springer key                                                         |
| `openalexKeyEnv`                      | `OPENALEX_API_KEY`    | Variable holding the OpenAlex key, for search and paid full text                                   |
| `openalexReserveUsd`                  | `0.25`                | OpenAlex budget (USD) that paid downloads leave for search                                         |
| `stateChars`                          | `12000`               | Size of the research state excerpt                                                                 |
| `reply.maxLines`                      | `25`                  | Line limit for outgoing messages. `0` turns it off                                                 |
| `reply.maxChars`                      | `2000`                | Character limit for outgoing message bodies. `0` turns it off                                      |
| `writeRoots`                          | `[]`                  | More absolute paths writes may go to in `strict`                                                   |
| `holdBackgroundTasks`                 | `true`                | Keep Claude input open for background tasks                                                        |
| `toolNice`                            | `15`                  | CPU priority for Claude `Bash` commands. `0` turns it off                                          |
| `recall.enabled`                      | `true`                | Tool-call recall. Independent of `validation`                                                      |
| `recall.maxNotices`                   | `3`                   | Recall notices with hits per run. `0` turns recall off                                             |
| `recall.maxHits`                      | `3`                   | Excerpts per notice                                                                                |
| `notesIndex.enabled`                  | `true`                | List current notes in the lead's prompt                                                            |
| `notesIndex.maxItems`                 | `40`                  | Most notes listed                                                                                  |
| `notesIndex.maxChars`                 | `4000`                | Size limit of the list                                                                             |
| `messageRecall.enabled`               | `true`                | Message recall. Needs a Jev key                                                                    |
| `messageRecall.candidates`            | `24`                  | Notes sent to Jev per run                                                                          |
| `messageRecall.threshold`             | `0.78`                | Lowest Jev score that gets pasted                                                                  |
| `messageRecall.maxNotes`              | `3`                   | Notes pasted per run                                                                               |
| `messageRecall.budgetMs`              | `2500`                | Time limit for the whole step. Unanswered notes are dropped                                        |
| `workers.maxConcurrent`               | `20`                  | Subagents running at once. Each also uses a slot of its account's `maxConcurrent`                  |
| `workers.minFreeMemoryMB`             | `1024`                | Hold queued subagents while less memory is free. `0` turns it off                                  |
| `workers.restartResumes`              | `2`                   | Times a subagent continues its conversation after a restart. `0` turns it off                      |
| `workers.quotaContinues`              | `2`                   | Times a subagent moves to another account after a quota error. `0` turns it off                    |
| `workers.timeoutMs`                   | `0`                   | Time limit per subagent. `0` means none                                                            |
| `workers.checkMinutes`                | `15`                  | How often the lead gets a progress check on running subagents. `0` turns it off                    |
| `workers.fileHolds`                   | `true`                | Stop two subagents editing one file. See [file coordination](orchestration.md#file-coordination)   |
| `workers.resultChars`                 | `8000`                | Characters of a subagent's result the lead gets                                                    |
| `workers.requireContext`              | `true`                | Refuse `research_delegate` without at least 40 characters of `context`                             |
| `workers.briefContext.enabled`        | `true`                | Add recent conversation and the channel goal to each brief                                         |
| `workers.briefContext.recentMessages` | `40`                  | Messages added                                                                                     |
| `workers.briefContext.messageChars`   | `1500`                | Limit per message                                                                                  |
| `workers.briefContext.maxChars`       | `30000`               | Limit for the whole section                                                                        |
| `workers.account`                     | unset                 | Preferred account id                                                                               |
| `workers.roles`                       | eight roles           | Role map. Replaces the defaults. See [roles](orchestration.md#roles)                               |
| `workers.enforceRoles`                | `deny`                | `deny`, `advise` or `off` for native delegation. Independent of `validation`                       |
| `workers.review.artifact`             | `advise`              | `deny`, `advise` or `off` for a checker or reviewer without an artifact                            |
| `workers.review.hold`                 | `off`                 | `once` holds one reply after a checker or reviewer result. Claude and Codex leads                  |
| `workers.review.paperPush`            | `off`                 | `deny`, `advise` or `off` for paper pushes without a review. Any lead                              |
| `workers.review.notesChars`           | `20000`               | Research state characters added to checker and reviewer prompts                                    |
| `workers.critic.*`                    | unset                 | Old name for `workers.review.*`. `review` wins                                                     |
| `slurm.enabled`                       | `true`                | Job tools. The Slurm commands must be installed                                                    |
| `slurm.pollMs`                        | `300000`              | Poll interval, at least one minute                                                                 |
| `slurm.maxChecks`                     | `288`                 | Polls per watch                                                                                    |
| `slurm.commandTimeoutMs`              | `20000`               | Limit per Slurm command                                                                            |
| `slurm.commands`                      | command names         | Paths for `sbatch`, `squeue`, `sacct`, `sinfo` and `sshare`                                        |
| `consolidator.*`                      | see memory            | Old. `enabled`, `models` and `effort` still apply, see [memory](memory-lifecycle.md#configuration) |
| `curation.*`                          | unset                 | Old and ignored                                                                                    |
