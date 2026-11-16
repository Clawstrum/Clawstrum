---
name: iterate
description: Force one critique and revision pass on load-bearing output before it is sent, against a fixed checklist rather than a reread.
triggers: iterate, revise, revision, harden, double-check, rework, polish
not_for: Routine replies and small edits; a first draft nobody relies on yet; the prose style of a paper (scientific-writing).
examples: double-check this derivation writeup before I send it to my advisor | harden this analysis script, it feeds the paper figures | give this proposal one more critical pass before it goes out
---

Use when being right matters more than being quick: a derivation, code about to be committed or run against real data, a figure heading for a paper, a recorded finding, or any answer where the request included a doubt. Skip it for lookups, status checks, acknowledgements, and anything a single tool call settles; a critique loop on a file path lookup costs time and changes nothing.

The default is draft and send. This skill inserts one pass between them, and the pass is a checklist rather than a reread, because rereading your own draft reliably produces the judgment that it is fine.

Draft the whole thing first without sending it. Then go through the draft against these questions, in the scratchpad and in writing, because a check performed only in the head does not happen.

1. Is every factual claim backed by something loaded right now? Numbers, file contents, function signatures, library behavior: re-check them rather than recalling them, and treat anything recalled from before a context compaction as unverified.
2. Where does this break? Empty input, a single element, a sign convention, an off-by-one, a division that can be zero, a unit that changed.
3. What was actually asked, against what is being answered? The mismatch between those two is the most common failure and the hardest to see from inside the draft.
4. Which parts are hedged, and can a tool call resolve the hedge? If it can, make the call and either strengthen the claim or drop it.
5. Is anything here a pattern from training rather than from this project? Variable names, paths, and interfaces get verified against the actual code.

Revise against each item, then run the same checklist once more against the revised draft. The second pass catches what the first revision introduced, which is why it is the pass worth keeping when time is short. If a pass produces nothing at all, that is usually the check being performed too gently rather than a clean draft.

An independent checker (is it true) or reviewer (is it worth keeping) helps only when it sees the artifact without your reasoning, because a subagent given the reasoning tends to agree with it. So hand over the output and the requirement, not the derivation or the design rationale, and ask specifically for what would make a referee object. Use one for output that is expensive to get wrong and skip it otherwise; a second opinion on a question already settled is not verification.

Send the result leading with what it is, not with an account of the process that produced it. Remaining uncertainty is stated as a caveat at the end rather than as throat-clearing at the start. Cosmetic rewording in the revision means the critique pass did not find anything real and should be run again properly.
