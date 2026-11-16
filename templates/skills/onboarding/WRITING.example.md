# Writing rules

Copy this file to the workspace root, or to the Clawstrum home directory to cover every workspace, and then edit it. Its presence arms the manuscript write gate in `src/research/writing.ts`: once it exists, a substantial write to a `.tex`, `.sty`, or `.cls` file is refused until something in that run has read it. No file, no gate.

Edit before you rely on it. What follows is a starting point, not a house style, and copying it unchanged installs someone else's preferences under your name. Delete every rule you do not hold; a rules file that says things its owner does not mean is worse than an empty workspace, because the gate will spend refusals enforcing it.

## Measured

`clawstrum prose lint FILE` counts these three and nothing else. They are here because the gate's own refusal text names them, so they are the part of this file that is checked rather than asserted.

- No em dash as a connective. Recast the sentence, or use a comma, a colon, or parentheses. A sentence that needs an em dash to hold together is usually two sentences.
- No bold for emphasis inside a sentence. Emphasis is carried by sentence structure and by word order. Bold at the start of a line, as a run-in heading, is fine.
- Section headings name, they do not argue. A heading is a noun phrase saying what the section contains, not a claim the section defends.

## Not measured

- State a claim at the strength its evidence supports. An observation is reported as an observation, an interpretation is marked as one, and a speculation says so. Defaulting to the weaker reading costs nothing and survives review.
- Cut the adverbs that tell the reader how to feel about a result rather than describing it: remarkably, interestingly, surprisingly, notably, importantly, strikingly. If the result is surprising the reader will notice without being instructed to.
- Do not invent terminology. Use the term the field already uses, even when it is clumsy, and introduce a new one only when it names something that has no name.
- Define every symbol where it first appears, and do not reuse a symbol for a second quantity.
- Prefer the concrete number to the adjective. "Twice the baseline" rather than "substantially higher".

## Venue

Record here what this particular venue requires and what it forbids: length limits, citation style, whether the first person is acceptable, figure and table conventions, and any punctuation the journal disallows. This section is the reason the file belongs in the workspace rather than in the harness.
