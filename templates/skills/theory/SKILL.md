---
name: theory
description: Derive an analytical result one claim at a time, with a numerical test for every step before the next one is written.
triggers: derive, derivation, theory, analytic, closed-form, mean-field, asymptotic, proof, ansatz
not_for: Back-of-envelope estimates; discussing what a result means; ideation (brainstorm).
examples: derive the fixed point analytically and check it numerically | can you check the math in this derivation? | work out the mean-field limit for large N
---

Use when a later claim will rest on a derivation. Skip it for an order-of-magnitude estimate or a scale question; the machinery costs more than the answer is worth.

One claim per step, verified before the next is written. Do not produce more than a few lines of new algebra without stopping to state what was just claimed, name a numerical test of it, run the test, and record the result. A page of derivation followed by "let me verify all of this" is the failure this skill exists to prevent, because by then a sign error has propagated through every line after it.

1. State the goal in one sentence, the results being assumed, which part is the actual derivation and which is bookkeeping, and where the non-trivial step is. Read the project's own record first; a variant of this result may already be derived, and re-deriving it silently is how two incompatible versions end up in the same project.
2. Write the verification script before any math. Small enough that every quantity is inspectable: matrices of dimension three to five, a handful of modes or samples, a network of a hundred units rather than a hundred thousand, a fixed seed. Add one test function per derivation step as you go.
3. Per step: state the claim in words, then check it reduces correctly in the trivial limits (zero coupling, identity, a single mode, one sample), that the dimensions are consistent, and that the symmetries survive. Then write the test and run it. A step that passed is a record entry, not a report.
4. When a check fails, stop; do not derive further. Isolate whether the error is in the theory or in the test code, print every intermediate sub-expression with actual numbers, and bisect a step that had several parts. After fixing, re-run every test, not only the one that failed.
5. When the derivation is complete, state the result in words with no symbols, check the limiting cases that matter for the domain, name what information the result discards, and say what surprised you. An unexpected cancellation is either structure worth understanding or an error worth finding.
6. Then one revision pass before writing anything up: is there a shorter path, a symmetry argument or change of variables that collapses several steps, a cleaner statement of the same result? Could a different method have reached it, and does that method add anything? Does the functional form appear in a known framework in disguise? If a step failed earlier, ask whether the approach was wrong rather than the execution, and check the earlier steps for the same class of error.
7. Document the statement, why it takes that form, the essential steps rather than every line, the numerical evidence with its parameter values, where it breaks down, and what it predicts. Save the verification script beside the derivation; it is the evidence, and prose describing tests that no longer run is not.

Verification here means numerics you run, which are an oracle independent of your algebra. A second model re-reading the derivation is not: it is a second opinion on a question already settled, and agreement from it means very little. Delegate a genuinely different route instead, such as an alternative derivation of the same result or an attack through a limiting case you have not tried, and hand over the claim and the constraints rather than your own working.

This skill imposes no tool gate and requires no particular file layout. Tolerances belong in the assertion, stated explicitly; agreement reported without one is not a verification.
