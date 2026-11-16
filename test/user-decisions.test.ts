import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from './helpers.js';
import { researchSchema } from '../src/research/config.js';
import { researchState } from '../src/research/records.js';
import { observeMemory, memoryFile } from '../src/memory.js';
import { DECISION_PATTERN, recordUserDecision } from '../src/user-decisions.js';

// Made-up messages with the shapes of real decisions and ordinary questions.
const decisions = [
  'Can you compare the cost of this grader with version 2? use my openrouter API key.',
  "You should copy Lena's whole setup, use her code whenever possible.",
  'Rook, from now on, you stay quiet in this channel.',
  "Ok. Let's remove the warmup. Could you send me a document on every detail of this grader?",
  "You shouldn't cancel the training jobs. Is there any running now?",
  'I want Timer: let it run during a cycle, still starting at midnight.',
  'When our inference jobs are up, run 100 of these agents (group 4) for 200 cycles.',
];
const ordinary = [
  'Progress?',
  'What is x_b?',
  'Show me the full summary prompt.',
  'Can you draw a histogram at step 210, not in log scale',
  'Another thing is I want to know the throughput of our newest server.',
];

test('the decision pattern matches real decisions and not ordinary questions', () => {
  for (const text of decisions) assert.match(text, DECISION_PATTERN, text);
  for (const text of ordinary) assert.doesNotMatch(text, DECISION_PATTERN, text);
});

test('a decision is saved word for word and shown in memory on the next context build', (t) => {
  const f = fixture(t);
  f.config.research = researchSchema.parse({ enabled: true });
  assert.equal(
    recordUserDecision(f.store, f.session.id, '111', 'Ana', decisions[0]!, 1_800_000_000_000),
    true,
  );
  assert.equal(
    recordUserDecision(f.store, f.session.id, '112', 'Ana', 'Progress?', 1_800_000_000_100),
    false,
  );
  assert.equal(
    recordUserDecision(f.store, f.session.id, '111', 'Ana', decisions[0]!, 1_800_000_000_000),
    false,
  );
  researchState(f.store, f.session.id);
  const memory = observeMemory(f.store, f.session.id).memory;
  assert.match(memory, /use my openrouter API key/);
  assert.match(memory, /inbound:111/);
  assert.doesNotMatch(memory, /Progress\?/);
});

test('a quoted heading cannot become a memory heading, and later edits keep the block current', (t) => {
  const f = fixture(t);
  f.config.research = researchSchema.parse({ enabled: true });
  recordUserDecision(f.store, f.session.id, 'a', 'Ana', '### Always\nuse my key', 1);
  researchState(f.store, f.session.id);
  recordUserDecision(f.store, f.session.id, 'b', 'Ana', 'from now on use Slurm', 2);
  researchState(f.store, f.session.id);
  const text = fs.readFileSync(memoryFile(f.store, f.session.id), 'utf8');
  assert.equal(text.split('clawstrum:user-decisions:start').length, 2, 'one block');
  assert.match(text, /"Always \/ use my key"/);
  assert.match(text, /from now on use Slurm/);
  assert.doesNotMatch(text, /^### Always/m);
});

test('a proposal is kept and marked, so its outcome can be recorded', (t) => {
  const f = fixture(t);
  f.config.research = researchSchema.parse({ enabled: true });
  assert.equal(
    recordUserDecision(
      f.store,
      f.session.id,
      'p',
      'Ana',
      'Can we just remove the practical tool category? Will it help?',
      5,
    ),
    true,
  );
  researchState(f.store, f.session.id);
  const memory = observeMemory(f.store, f.session.id).memory;
  assert.match(
    memory,
    /proposal: find how it settled\): "Can we just remove the practical tool category/,
  );
});
