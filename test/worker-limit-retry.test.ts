import test from 'node:test';
import assert from 'node:assert/strict';
import { limitHit, SMALLER_RETRY, workerContract } from '../src/research/workers.js';

test('a worker stopped by a configured limit is told to retry with a smaller job', () => {
  for (const error of [
    'Configured completed-tool budget exhausted (25); inspect partial artifacts',
    'Research subagent time budget exhausted',
    'Research subagent observed token budget exhausted (900/800); inspect partial artifacts',
    'Configured Claude dollar budget reached',
    'Configured Claude turn limit reached (25)',
  ])
    assert.equal(limitHit(error), true, error);
  for (const error of [undefined, '', 'Subagent ended without a result', 'quota exceeded'])
    assert.equal(limitHit(error), false, String(error));
  assert.match(SMALLER_RETRY, /at most half of the unfinished items/);
  assert.match(workerContract('/tmp/w', 1000, 50), /Save each finished item/);
});
