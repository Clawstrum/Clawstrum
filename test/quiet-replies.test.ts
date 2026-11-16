import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { stripQuietMarker } from '../src/message-text.js';
import { fixture, settle } from './helpers.js';

test('human and mixed turns stay quiet after an actual tool reply', async (t) => {
  for (const mixed of [false, true]) {
    const f = fixture(t);
    f.enqueue('human');
    if (mixed)
      f.store.enqueue({
        id: 'wake',
        sessionId: f.session.id,
        author: 'scheduler',
        kind: 'task',
        content: 'Review result',
      });
    const provider = {
      async run() {
        const run = f.store.get<any>("SELECT id FROM runs WHERE status='running'");
        f.store.outbox(f.session.id, 'Here is the result.', { runId: run.id });
        return 'CLAWSTRUM_QUIET';
      },
    };
    const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
    engine.tick();
    await settle(engine);
    assert.deepEqual(
      f.store.all<any>('SELECT content FROM outbox').map((r) => r.content),
      ['Here is the result.'],
    );
    assert.equal(f.store.get<any>('SELECT status FROM runs').status, 'done');
  }
});

test('a quiet-only unanswered human request gets one correction, independently of research validation', async (t) => {
  for (const correct of [true, false]) {
    const f = fixture(t);
    f.config.research.enabled = false;
    let calls = 0;
    const provider = {
      async run(r: any) {
        if (calls++) {
          assert.match(r.prompt, /has no answer/);
          return correct ? 'The answer is 42.' : 'CLAWSTRUM_QUIET';
        }
        return 'CLAWSTRUM_QUIET';
      },
    };
    const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
    f.enqueue('human');
    engine.tick();
    await settle(engine);
    assert.equal(calls, 2);
    assert.equal(f.store.get<any>('SELECT status FROM runs').status, correct ? 'done' : 'failed');
    assert.equal(
      f.store.get<any>("SELECT count(*) n FROM outbox WHERE content='CLAWSTRUM_QUIET'").n,
      0,
    );
    if (correct)
      assert.equal(f.store.get<any>('SELECT content FROM outbox').content, 'The answer is 42.');
  }
});

test('marker stripping preserves inline explanations and fenced literal examples', () => {
  const text =
    'The word CLAWSTRUM_QUIET is internal.\n```text\nCLAWSTRUM_QUIET\n```\nCLAWSTRUM_QUIET\nDone.';
  assert.equal(
    stripQuietMarker(text),
    'The word CLAWSTRUM_QUIET is internal.\n```text\nCLAWSTRUM_QUIET\n```\nDone.',
  );
});

test('recent long messages suppress only equivalent delivered text, never a distinct answer', async (t) => {
  const progress = 'Q1: yes, the export is running. '.repeat(12);
  const recap = 'I answered both questions. Is the export running? Yes. '.repeat(8);
  for (const [first, result, delivered] of [
    [progress, recap, [progress, recap.trim()]],
    [progress, progress.replaceAll(' ', '\n'), [progress]],
    ['On it, checking now.', recap, ['On it, checking now.', recap.trim()]],
  ] as const) {
    const f = fixture(t);
    f.enqueue('human');
    const provider = {
      async run() {
        const run = f.store.get<any>("SELECT id FROM runs WHERE status='running'");
        const id = f.store.outbox(f.session.id, first, { runId: run.id });
        f.store.exec("UPDATE outbox SET status='sent' WHERE id=?", id);
        return result;
      },
    };
    const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
    engine.tick();
    await settle(engine);
    assert.deepEqual(
      f.store.all<any>('SELECT content FROM outbox ORDER BY rowid').map((r) => r.content),
      delivered,
    );
    assert.equal(f.store.get<any>('SELECT status FROM runs').status, 'done');
  }
});
