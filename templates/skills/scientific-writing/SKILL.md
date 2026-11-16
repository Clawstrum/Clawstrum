---
name: scientific-writing
description: Draft or revise manuscript prose against the installation's own writing rules, then measure the draft for the specific habits those rules exist to stop.
triggers: manuscript, paper, abstract, draft, prose, writing, rewrite, referee, latex, caption
not_for: Chat explanations; figures for the paper (plotting); code comments, commit messages, notes.
examples: draft the methods section from these notes | tighten the abstract to 200 words | write a reply to the second reviewer's main point
---

Use when writing or revising prose that someone will read as a document: a manuscript, an abstract, a grant section, a referee reply, a figure caption. Skip it for chat, for code comments, and for notes to yourself.

This skill owns no writing rules. The rules are the installation's, they live in its `WRITING.md`, and they differ between people and between venues. Read that file first and follow what it actually says. Do not infer a universal rule from one person's preference, and do not carry a rule from one project into another because it was stated confidently somewhere else.

The order matters. Read the rules, then draft, then measure, then revise. Rules read after a draft exists get argued with rather than applied, which is why the gate refuses the write instead of annotating it afterwards.

If the rules file keeps any of the three measured rules (no em dashes as connectives, no bold for emphasis inside a sentence, section headings that name instead of argue), run `clawstrum prose lint /absolute/path/draft.tex` on the draft and act only on the findings for rules the file keeps. If it keeps none of them, skip the linter. Everything else the rules file says is yours to apply by reading. The linter skips code blocks and verbatim environments, its heading check is a crude keyword list, and it has no opinion about whether a sentence is any good.

Revise against the findings and against the rules together, then rerun the linter. A finding that is correct in context stays, and saying why in the report is better than silently suppressing it.

Two habits worth stating because they survive most rule files. Make the claim at the strength the evidence supports and no higher, so an observation is reported as an observation and an interpretation is marked as one. And cut the adverbs that instruct the reader how to feel about a result rather than describing it; if the result is surprising, the reader will find it so without being told.

Before the paper is pushed, a changed claim, number or caption goes to a `checker`; a new section, a new abstract or a "first" claim also goes to reviewers in journal-referee mode (the `reviewers` skill).

These checks are advisory and impose no tool permission gate of their own. The manuscript write gate is separate, is armed only when a rules file exists, and is satisfied by reading that file or this one.
