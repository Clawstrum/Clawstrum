import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { lintProse, lintProseFile } from '../src/prose.js';

test('prose lint flags an em dash and the LaTeX triple-hyphen spelling, and names the count above one', () => {
  const single = lintProse('This clause—that clause.');
  assert.deepEqual(
    single.map((f) => f.code),
    ['em-dash'],
  );
  assert.doesNotMatch(single[0]!.message, /\(\d+ on this line\)/);
  const multiple = lintProse('One—two—three—four.');
  assert.match(multiple[0]!.message, /\(3 on this line\)/);
  const latex = lintProse('A clause---another clause.');
  assert.deepEqual(
    latex.map((f) => f.code),
    ['em-dash'],
  );
});

test('prose lint ignores an em dash inside a fenced code block and a markdown table separator row', () => {
  const fenced = ['```', 'A clause—that clause.', '```'].join('\n');
  assert.deepEqual(lintProse(fenced), []);
  const table = ['| A | B |', '|---|---|', '| 1 | 2 |'].join('\n');
  assert.deepEqual(lintProse(table), []);
});

test('prose lint flags bold used as emphasis but allows a run-in heading at the start of the line', () => {
  const inline = lintProse('The result was **highly significant** in every trial.');
  assert.deepEqual(
    inline.map((f) => f.code),
    ['bold-emphasis'],
  );
  const latexInline = lintProse('The result was \\textbf{highly significant} in every trial.');
  assert.deepEqual(
    latexInline.map((f) => f.code),
    ['bold-emphasis'],
  );
  const runIn = lintProse('**Results.** The effect was consistent across trials.');
  assert.deepEqual(runIn, []);
});

test('prose lint flags argumentative headings and ends-in-punctuation headings but allows a noun phrase', () => {
  const markdown = lintProse('## Why This Method Works');
  assert.deepEqual(
    markdown.map((f) => f.code),
    ['heading-claim'],
  );
  const latexSection = lintProse('\\section{Is the effect real}');
  assert.deepEqual(
    latexSection.map((f) => f.code),
    ['heading-claim'],
  );
  const question = lintProse('## Does the model generalize?');
  assert.deepEqual(
    question.map((f) => f.code),
    ['heading-claim'],
  );
  const nounPhrase = lintProse('## Experimental Results');
  assert.deepEqual(nounPhrase, []);
});

test('prose lint skips LaTeX comment lines, verbatim environments and markdown front matter', () => {
  const comment = lintProse('% This line has an em dash—see above.');
  assert.deepEqual(comment, []);
  const verbatim = ['\\begin{verbatim}', 'A clause—that clause.', '\\end{verbatim}'].join('\n');
  assert.deepEqual(lintProse(verbatim), []);
  const front = ['---', 'title: A clause—that clause.', '---', 'Body text.'].join('\n');
  assert.deepEqual(lintProse(front), []);
});

test('prose lint file reads from disk', (t) => {
  const f = fixture(t);
  const file = path.join(f.home, 'notes.md');
  fs.writeFileSync(file, 'Clause one—clause two.\n');
  assert.deepEqual(
    lintProseFile(file).map((finding) => finding.code),
    ['em-dash'],
  );
});
