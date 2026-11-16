---
name: brainstorm
description: Generate several distinct approaches to an open question, evaluate them against stated constraints, and converge on one or two with a reason.
triggers: brainstorm, alternatives, options, approaches, ideas, tradeoffs, divergent
not_for: Carrying out a direction already chosen (do X, fix Y, run Z); status updates; depth on one chosen approach; derivations (theory).
examples: brainstorm what experiments would actually test this | what are our options for speeding this up? | I don't like this direction, go wide and list what else we could do
---

Use when the question is which direction to take and the answer is not already obvious. Skip it when the direction is chosen and the need is depth, when the request is to do a named thing, and when you already know what to do; a brainstorm used to postpone starting is the most common way this skill is misapplied.

Start by writing one paragraph to yourself naming what is being decided, what constrains it in time, compute, or mathematics, what has already been tried, and what a good answer would look like. Unconstrained exploration produces ideas that cannot be judged, so if the constraints cannot be stated, ask for them rather than guessing.

Then generate three to five genuinely distinct approaches, not variations on one. For each: a short name, the core idea in a sentence, the insight it depends on, the risk that would kill it, and rough effort. Include at least one conservative option already known to work and at least one that would be unusual if it worked. Do not filter while generating; evaluation is a separate pass and mixing them produces three versions of the first idea.

Evaluate against what was actually established rather than what sounds plausible, and rank. Then one refinement pass, which is the part that is usually skipped and usually where the answer comes from: would the ranking change if effort or risk were weighted differently, can the best parts of two approaches combine, is there an option visible now that was not visible before the landscape was laid out, and how does the leading option most plausibly fail. The best idea often arrives after three mediocre ones.

Recommend one or two, say what you would do immediately, and say what evidence would change your mind. Then stop and wait for an answer rather than beginning the work.

Delegated exploration is useful here, one direction per subagent, run at the same time. What comes back is a lead and not a conclusion: anything from a subagent that reaches the recommendation gets checked first-hand.

Report this as short prose. Name the candidates inline with a sentence each, say which you would pick and why in one line, then ask the one question you need answered. The structure above organizes the thinking and is not the shape of the message; a feasibility table, phase labels, and a steelman appendix mean scratch work was sent instead of a recommendation. Derivation does not belong here either. A brainstorm decides what to derive; leave it before deriving, because reasoning inside a brainstorm skips the verification a derivation needs.
