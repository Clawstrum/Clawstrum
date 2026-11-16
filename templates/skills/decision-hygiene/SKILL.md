---
name: decision-hygiene
description: Inspect a project's decision ledger for conflicting active revisions and document explicit replacements.
triggers: decision, decisions, ledger, superseded, retire, rationale
not_for: Making a new decision or weighing options (brainstorm); recording a single decision that conflicts with nothing.
examples: we have two active decisions about the learning rate, which one holds? | clean up the decision ledger, some entries contradict each other | mark the old normalization decision as replaced by the new one
---

Use when a project keeps a decisions.md ledger and a decision is revised or appears contradictory.

Read the current ledger and the request that authorizes the change. Run `clawstrum decisions lint /absolute/path/decisions.md` for advisory syntax and duplicate-tag findings. Read the findings against the actual intent; this linter does not decide what the user meant.

Use `- YYYY-MM-DD [stable.tag]: decision text` under `## Active`. When replacing a decision, move the previous entry to `## Superseded` and name its replacement or retirement reason. Preserve history. Check shared project files before introducing a separate copy; only use `--shared-target` when that shared-file convention was explicitly selected for this project.

Rerun the linter after editing. Report unresolved contradictions with exact evidence. These checks are advisory and do not impose a tool permission gate or a universal project layout.
