import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildContext } from '../src/context.js';
import { ContextRefresh } from '../src/instructions.js';
import { memoryTemplate, parseMemory } from '../src/memory.js';
import { Store } from '../src/store.js';
import { fixture } from './helpers.js';
import type { ProviderRequest } from '../src/types.js';

test('fresh shared AGENTS seeds editable communication and research policy while code supplies protocols', (t) => {
  const f = fixture(t);
  const context = buildContext(
    f.store,
    f.session,
    f.config.accounts[0]!,
    [],
    4000,
    100000,
    f.config.research,
  );
  const shared = fs.readFileSync(path.join(f.home, 'AGENTS.md'), 'utf8');
  const policy = parseMemory(shared).instructions;
  assert.match(policy, /one short non-final send_message/);
  assert.match(policy, /Treat a subagent's report as a claim: check its evidence/);
  assert.match(context.instructions, /Clawstrum delivery protocol/);
  assert.match(context.instructions, /CLAWSTRUM_QUIET/);
  assert.match(context.instructions, /Available roles: explorer:/);
  assert.match(context.instructions, /Slurm operations: enabled/);
  assert.doesNotMatch(policy, /Clawstrum delivery protocol/);
  assert.equal(context.instructions.split('one short non-final send_message').length - 1, 1);
});

test('editing or removing shared behavior refreshes every channel without rotation or reseeding', (t) => {
  const f = fixture(t),
    other = f.store.ensureSession('999999');
  const account = f.config.accounts[0]!;
  const initial = buildContext(f.store, f.session, account, [], 4000, 100000, f.config.research);
  const refresh = new ContextRefresh({
    instructions: initial.instructions,
    contextRefresh: initial.contextRefresh,
    onEvent() {},
  } as ProviderRequest);
  refresh.delivered(initial.contextRefresh.snapshot, 'native');
  for (const session of [f.session, other]) {
    const context = buildContext(f.store, session, account, [], 4000, 100000, f.config.research);
    f.store.exec(
      'UPDATE sessions SET active_account=?,remote_id=?,fingerprint=? WHERE id=?',
      account.id,
      'native-' + session.id,
      context.fingerprint,
      session.id,
    );
  }
  const file = path.join(f.home, 'AGENTS.md');
  const before = fs.readFileSync(file, 'utf8');
  const edited = before.replace(
    /## Communication\n[\s\S]*?(?=\n## Memory and continuity)/,
    '## Communication\n\nFor short questions, answer directly without a separate acknowledgment.\n',
  );
  fs.writeFileSync(file, edited);
  const snapshot = refresh.read()!;
  assert.ok(refresh.changed(snapshot));
  assert.match(refresh.text(snapshot), /answer directly without a separate acknowledgment/);
  assert.doesNotMatch(refresh.text(snapshot), /one short non-final send_message/);
  assert.doesNotMatch(refresh.currentInstructions(snapshot), /one short non-final send_message/);
  for (const session of [f.session, other]) {
    const current = buildContext(
      f.store,
      f.store.session(session.id),
      account,
      [],
      4000,
      100000,
      f.config.research,
    );
    assert.equal(current.resumeId, 'native-' + session.id);
    assert.match(current.instructions, /answer directly without a separate acknowledgment/);
    assert.doesNotMatch(current.instructions, /one short non-final send_message/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), edited);
  assert.equal(parseMemory(edited).memory, parseMemory(before).memory);
  const reopened = new Store(f.home);
  try {
    const current = buildContext(reopened, reopened.session(f.session.id), account, [], 4000);
    assert.doesNotMatch(current.instructions, /one short non-final send_message/);
    assert.equal(fs.readFileSync(file, 'utf8'), edited);
  } finally {
    reopened.close();
  }
});

test('an intentionally empty shared policy does not receive default behavior as a hidden fallback', (t) => {
  const f = fixture(t);
  const file = path.join(f.home, 'AGENTS.md');
  const empty = memoryTemplate('', path.join(f.home, 'history'));
  fs.writeFileSync(file, empty);
  const context = buildContext(
    f.store,
    f.session,
    f.config.accounts[0]!,
    [],
    4000,
    100000,
    f.config.research,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), empty);
  assert.doesNotMatch(
    context.instructions,
    /acknowledge new work|Lead with the result|Give research_delegate workers narrow briefs|Read the matching SKILL/,
  );
  assert.match(context.instructions, /Clawstrum delivery protocol/);
  assert.match(context.instructions, /Skills available:/);
  assert.match(context.instructions, /Available roles:/);
});

test('channel communication preferences remain scoped and disabled capabilities are described accurately', (t) => {
  const f = fixture(t),
    other = f.store.ensureSession('999999');
  const file = path.join(f.session.workspace, 'AGENTS.md');
  fs.writeFileSync(
    file,
    memoryTemplate(
      'For this channel, use one sentence for progress updates.',
      path.join(f.session.workspace, 'history'),
    ),
  );
  f.config.research.slurm.enabled = false;
  const local = buildContext(
    f.store,
    f.session,
    f.config.accounts[0]!,
    [],
    4000,
    100000,
    f.config.research,
  );
  const remote = buildContext(
    f.store,
    other,
    f.config.accounts[0]!,
    [],
    4000,
    100000,
    f.config.research,
  );
  assert.match(local.instructions, /use one sentence for progress updates/);
  assert.doesNotMatch(remote.instructions, /use one sentence for progress updates/);
  assert.match(local.instructions, /Slurm operations: disabled/);
  f.config.research.enabled = false;
  const disabled = buildContext(
    f.store,
    f.session,
    f.config.accounts[0]!,
    [],
    4000,
    100000,
    f.config.research,
  );
  assert.doesNotMatch(
    disabled.instructions,
    /Research tools are enabled|Available roles:|Slurm operations:/,
  );
});
