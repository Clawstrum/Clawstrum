---
name: reviewers
description: Run 2-3 reviewer workers, stage direction (work in progress: story, leads, then thinkers) or final (draft or figure: referee with scarce slots, then the checker); each reads the story first, then gives every item one verdict, main / fix / develop / supporting / dead_end / cut / stop.
triggers: review this, reviewers, critics, journal reviewer, referee, is this figure good, is this result good enough, is this promising, is this going anywhere, what's missing, is this worth it, what's bloat, judge the plan
not_for: Whether one number or claim is correct (checker); building options with nothing to judge yet (thinker, brainstorm); status summaries.
examples: spawn reviewers on the plan before we launch the next round | is this direction promising? | is this figure good enough for the paper? | journal reviewer on the draft, what's bloat
---

Use when the user asks to review or judge what exists or whether it is promising, after a result comes back that a claim will rest on, before a figure or section goes into the paper, and before a new round of experiments once the slate has grown.

A reviewer reads what exists and judges it. It never builds: anything new (a run, a proof, an analysis) it names in one line, and a thinker designs it. The checker asks whether a claim is true.

What works: every reviewer gives every item a verdict, reads the raw notes rather than the lead's summary, and names what would kill each kept item. Asked to "pressure-test" one option, reviewers keep everything.

What broke: with only keep-or-cut against slots, a lead applied cuts overnight without asking and a figure went from 7 panels to 3, promising results included. A review should help refine the story, at the level of the story, not one plot, result or text part alone. So every reviewer reads the items together first and returns the story (now / best / gap / lead), under-evidenced is _develop_, never cut, and every cut is a proposal that waits for the user.

## 1. Pick the stage

- **direction**: work in progress, pieces missing: "is this promising", "where is this going", a fresh result, a half-built figure, a plan. No slot cap, no cut: a result already killed by a control is `dead_end` (flagged, cited, not removed). Overall = promising / promising with work / not promising.
- **final**: a paper draft, a figure going into the paper, a submission. Scarce slots, journal referee. Overall = accept / minor / major / reject.

Unsure: direction. Final on unfinished work is what cut the figure above.

## 2. The artifact

- **Slate** (results + plan): write `slate-<YYYY-MM-DD>-<topic>.md` in the workspace, numbered items, no argument for any of them. _goal_ one line (paper, claim or decision; venue if any). _story_ the line the work is meant to tell. _results_ one line each with the note or results file it rests on (`<path>:<line>`). _plan_ one line each: running jobs, planned runs, controls, side threads.
- **Fresh result**: the result file, plus a short list of the claims it is meant to carry.
- **Draft or figure**: the `.tex` file or the figure PNG/PDF itself; items = claims, sections or panels. Reviewers look at the figure itself, not the caption alone.

Every brief names the story the piece sits in (paper outline, the other figures, the slate): one figure or section is judged by what it does for the whole, and content that fits the story but not this piece moves to where it serves instead of being dropped.

## 3. Dispatch 2-3 reviewers in parallel, one message

`research_delegate` with role `reviewer` and `artifact: <path>`. Each brief: `stage: direction|final`, the goal, the story it sits in, slots (final: main result or panel slots; plan slots if runs compete for compute), the raw sources (the AGENTS.md research state, the project's results files, data and log directories, specs) and ONE angle:

- _story editor_ (every round): the strongest story the existing results can tell, which ones carry it, which promising ones are under-used or in the wrong place, the single missing link.
- _skeptic on side work_: which controls, ablations and deep dives cannot change the conclusion.
- _journal referee at <venue>_: per claim or panel, what a referee would demand, the overall call. The 3 or fewer strongest correctness or novelty objections from the communities the paper borrows from or claims to beat (theorists, experimentalists, the ML method it competes with). A caveat that is not in the title, abstract or figures counts as missing.
- _PI reading fast_: the one message; what they would take away in 30 seconds.

direction: story editor + skeptic. final: story editor + referee (+ PI for a full paper slate). Never two with the same angle.

## 4. After they return

Each result's wake carries a `Reviewer verdicts` block: the story lines, each verdict with its cited lines read from disk, and any flag (`OVER BUDGET`, `OVER PLAN BUDGET`, `STAGE MISSING`, `SLOTS MISSING`, `STORY MISSING`, `KIND MISSING`, `FIX MISSING`, `DEVELOP MISSING`, `DEAD END UNCITED`, `CUT IN DIRECTION`, `STOP NOT PLAN`, `UNKNOWN VERDICT`). For every cut, stop, dead_end or fix you pass on and every missing item, check that the note behind it is current (newer entries win). A reviewer on stale notes is wrong with confidence.

**direction**: the leads get worked out. In one message, a `thinker` per lead: the story gap, and each develop item worth it (one route per thinker, a short answer back, the brief carries the reviewer's one-line need and the notes it rests on). A needed proof: the `theory` skill. When a kept result dies on a control, the same: thinkers on what could replace it, not a smaller figure. The user gets the story, the leads and the options with cost, and picks.

**final**: fixes and checks. A `checker` on every number, caption and claim the fixes touch; a `lit-reader` on prior work for any "first" or "new" claim; prose fixes follow the `scientific-writing` skill. Develop items in final = what must exist before submission.

Report per reviewer. Never "all reviewers say" unless each one did. Where their best stories differ, say so: that is often the most useful thing a round turns up.

## 5. Tell the user

First line: the story the reviewers see and the lead to develop; then the main change (final: the overall call). Then _develop_ (what it needs), _fix_, _dead end_, _cut_ (proposed), _stop_ (proposed), _missing_, and _i disagree_ (which verdict, why), one line per item. Offer the per-reviewer detail in one line. Once the user agrees, record the decision under Working understanding in the AGENTS.md MEMORY with its date, using `research_note.claim` with basis user decision.

## Don't

- Apply a cut, stop or dead_end without the user's go: no panel, result or thread leaves a figure, draft or plan, and no job is cancelled, until they answer.
- Hand reviewers your summary instead of the notes.
- Turn it into a length edit. Reviewers judge claims, panels and experiments, not words.
- Ask a reviewer to design the next step. That is the thinker's job, after the review.
