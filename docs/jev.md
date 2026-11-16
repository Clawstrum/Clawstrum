# Optional Jev decision service

Jev is a paid typed-decision API from TypeSafe (https://typesafe.ai). Clawstrum calls it only when `JEV_API_KEY` is set; without a key everything works and the decisions fall back to local rules.

Clawstrum uses Jev for small typed decisions alongside its subscription-backed Claude, Codex and Gemini agents. It does not replace their execution loop, write memory summaries, or control permissions. The active advisory integrations default on; an API key enables their bounded auxiliary calls. An installation without Jev remains fully usable.

## Features and fallbacks

| Feature                    | With Jev                                                                                                            | Without a key, or when the call fails                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `history action=rank`      | Rerank up to 12 local lexical candidates using labelled source passages                                             | Return the local SQLite FTS/BM25 order                                                              |
| Skill suggestions          | Pick one installed skill from the message, last 2 agent replies and skill criteria; load its SKILL.md into the turn | Top keyword match's SKILL.md, marked as possibly wrong; other matches as pointers; complete catalog |
| `research_subagent_advice` | Suggest a configured role or keeping the task with the lead                                                         | Return configured roles/models so the lead can choose normally                                      |

These fallbacks also cover timeouts, invalid responses, rate limits, capacity, oversize requests and the daily auxiliary budget. They do not silently switch to another paid API. Jev never spawns a subagent or changes a main-channel model. Missing Jev does not disable subagents, memory review, skills, or raw history access.

Advice is not an execution instruction. User constraints and explicit subagent provider/model selections take precedence. Confidence is reported as a model estimate; no universal confidence threshold is used as a permission or deletion rule.

## Configuration

Set `JEV_API_KEY` in the daemon's private environment; `TYPESAFE_API_KEY` is accepted when the default key name is used. Shell initialization files are not automatically sourced. Keep the key out of `config.json` and source control.

The optional top-level `decisions` configuration defaults to:

```json
{
  "enabled": true,
  "model": "jev-1.13.0",
  "apiKeyEnv": "JEV_API_KEY",
  "foregroundTimeoutMs": 1000,
  "backgroundTimeoutMs": 10000,
  "maxConcurrent": 4,
  "maxRetries": 1,
  "maxRequestBytes": 24000,
  "dailyBudgetUsd": 1,
  "inputUsdPerMillion": 0.042,
  "cacheTtlMs": 86400000,
  "history": true,
  "skills": true,
  "workers": true,
  "memoryReview": false
}
```

The model must be a pinned version identifier. The transport calls only the official HTTPS endpoint and refuses redirects. A small HTTP adapter uses built-in `fetch`, with injectable transport for tests and no additional SDK dependency. Its supported `choice`, `score` and `noul` response shapes are checked against question IDs, labels, ranges, probabilities and the requested model. See the [official API contract](https://docs.typesafe.ai/api).

Each request has a deadline including retries and waiting on an identical request. Retryable HTTP responses use bounded backoff and `Retry-After`; authentication failures are not retried. A network exception takes the fallback path. Oversize requests explicitly fall back instead of silently truncating service inputs. Feature adapters label their own sampled passages and preserve a path to complete evidence.

## Retrieval and memory integrity

`clawstrum history SESSION --action rank --query "current clustering decision"` and the MCP history tool share the same implementation. Shared and group scopes follow the normal history authorization rules. Ranking never searches other channels implicitly.

The derived FTS5 index includes complete retained history records. It backfills newest-first in bounded transactions while triggers index new writes. `history index` advances one backfill batch without an API call. Rank results expose incomplete indexing; ordinary paginated `history search/list/read` remains available for exhaustive coverage. A short lexical shortlist is not exhaustive semantic retrieval.

Ranked results contain record IDs, raw paths, content hashes, passage offsets and total lengths. Follow `supersededBy` to current corrections. Replacement records are returned separately, even when they did not match the search, and unresolved references are explicit. Ranking does not delete history or update review coverage.

Automatic per-chunk memory observation calls have been removed: they classified samples for profiling but did not change review decisions. The legacy `memoryReview` switch remains accepted for configuration compatibility and has no automatic effect. Memory revision checks, provenance validation and preservation/restoration are mechanical. Semantic reconciliation uses the subscription reviewer under the shared [maintenance budget](memory-lifecycle.md#background-call-budget-and-scheduling); no Jev-based retirement or compaction pruning is performed.

A separate scheduling fix prevents due/retrying session rotation from starving a new correction review. Review and rotation retain separate coverage and retry timers. Group findings can declare project/experiment/run/dataset/version scope. Rendered records distinguish board-edit time from observation time; missing scope/date remains unspecified. Neither a declared scope nor a recent edit independently verifies a claim.

## Cache, accounting and diagnostics

Daemon and MCP processes share the SQLite metadata cache, in-flight ownership, concurrency leases and UTC-day budget. Keys include feature/question version, pinned model, scope, exact state, questions and source revisions. Different channels or changed evidence cannot share an accidental hit. Waiter cancellation does not cancel the original request.

Before sending, the service reserves a conservative byte-based input-cost estimate. Reported usage replaces that reservation; absent usage remains explicitly unknown with the reservation retained. This is an operational spending guard and estimate, not an exact billing cap or tokenizer. Update the configured price when needed and compare with the vendor invoice. Crash recovery expires in-flight leases; an unknown in-flight charge is not refunded speculatively.

Requests and validated typed results are stored privately under `H/research/decisions/<id>.json`. Headers, keys and remote error bodies are excluded. Metadata profiles include feature, scope, run/subagent linkage, hashes, model, cache status, latency, attempt count, reported tokens, unknown-usage attempts and estimated expense. Missing-key/disabled calls return before creating a profile or artifact; other unavailable attempts are recorded. Keep artifacts under the deployment's private backup/retention policy; no automatic artifact deletion is added.

```sh
clawstrum jev profile --since 2026-09-22 --limit 100
clawstrum jev profile SESSION --offset 100
```

`research_status collection=decisions` provides the channel-scoped view. CLI reporting is read-only and does not need the key. Follow `nextOffset`: totals and p50/p95 cover the returned page, not all retained calls. Subagent profiles supply actual execution and review outcomes; classifier latency or cost alone does not establish saved subscription quota or improved scientific accuracy.

## Evaluation

From a source checkout after building:

```sh
node scripts/eval-jev.mjs
node scripts/eval-jev.mjs --threshold 0.8
node scripts/eval-jev.mjs --live --out /private/new-evaluation-directory
```

`npm test` and the package smoke remove ambient Jev keys so normal automated tests stay synthetic. The live evaluation below is opt-in.

Default mode replays eight recorded synthetic development cases with no network access. `--live` explicitly calls the API using the supplied fixture and stores fresh artifacts. `--fixture path.json` accepts additional cases with `id`, `state`, `questions`, `expected` choice labels and, for replay, `recorded` responses. The report separates availability, exact label matches, accepted accuracy and abstention. Its threshold is an evaluation parameter, not a production policy.

These cases exercise routing, explanation-only intent, corrections versus other experiments, retained historical board entries, unsupported completion claims, retrieval and injected log instructions. They are a regression set, not held-out calibration. Compare against deterministic behavior and economical generative review on independently labelled project/time splits before claiming accuracy or savings.

The active integration includes advisory routing and retrieval. Active review prioritization, automatic semantic retirement, research batch judging and transcript pruning are not implemented.
