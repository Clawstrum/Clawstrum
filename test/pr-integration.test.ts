import test from 'node:test';
import { compactionHooks } from '../src/compaction.js';
import { updateMemory } from '../src/memory.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, ok, settle } from './helpers.js';
import { Engine } from '../src/engine.js';
import { researchSchema } from '../src/research/config.js';
import { researchHooks, validationIssues, contains } from '../src/research/hooks.js';
import { invokesCommand, writeTargets } from '../src/research/shell.js';
import { previewEdit } from '../src/research/edits.js';
import { scanProseWrite, lintDocumentLimit } from '../src/research/lint.js';
import { scriptIssues } from '../src/research/cluster.js';
import { reviewReply } from '../src/research/replies.js';
import { workerEvidence, workerFindings } from '../src/research/validate.js';
import { delegate } from '../src/research/workers.js';
import { acquireLock } from '../src/lock.js';
import { daemonReady, requestRestart, cancelRestart } from '../src/restart.js';
import type { Provider, ProviderRequest } from '../src/types.js';

function hookFixture(t: any) {
  const f = fixture(t);
  f.config.research = researchSchema.parse({ enabled: true, validation: 'strict' });
  const request: ProviderRequest = {
    account: f.config.accounts[0]!,
    cwd: f.session.workspace,
    prompt: '',
    instructions: '',
    controller: new AbortController(),
    env: {},
    research: f.config.research,
    mcp: {
      command: process.execPath,
      args: [],
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id },
    },
    onEvent() {},
  };
  const transcript = path.join(f.home, 'native.jsonl');
  fs.writeFileSync(transcript, 'lead evidence');
  const base = { session_id: 'native', transcript_path: transcript, cwd: f.session.workspace };
  const invoke = async (hooks: { hooks?: any }, event: string, extra = {}) => {
    const callback = (hooks.hooks as any)[event][0].hooks[0];
    return await callback({ ...base, hook_event_name: event, ...extra }, undefined, {
      signal: request.controller.signal,
    });
  };
  return { ...f, request, transcript, invoke };
}

test('dispatch routing is enforced by default while content checks stay advisory', async (t) => {
  const f = hookFixture(t);
  const byDefault = researchSchema.parse({ enabled: true });
  assert.equal(byDefault.validation, 'advisory');
  assert.equal(byDefault.workers.enforceRoles, 'deny');
  f.request.research = byDefault;
  const routed = researchHooks(f.request);
  try {
    const result = await f.invoke(routed, 'PreToolUse', {
      tool_name: 'Agent',
      tool_input: {},
      tool_use_id: 'dispatch',
    });
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /research routing/);
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /names no subagent_type/);
    // A citation finding is content, not routing, and keeps the advisory default it had before.
    const write = await f.invoke(routed, 'PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: 'notes.md', content: 'See doi:10.1234/example for the result.' },
      tool_use_id: 'cite',
    });
    assert.equal(write.hookSpecificOutput.permissionDecision, undefined);
    assert.match(write.hookSpecificOutput.additionalContext, /Citation/);
    // Working inline is what the lead is left with, so nothing in the lead's own tools may fire.
    assert.deepEqual(
      await f.invoke(routed, 'PreToolUse', {
        tool_name: 'Read',
        tool_input: { file_path: 'notes.md' },
        tool_use_id: 'inline',
      }),
      {},
      'Read',
    );
    // Bash always carries the CPU-priority prefix, independent of routing.
    const bash = await f.invoke(routed, 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'python analyse.py' },
      tool_use_id: 'inline',
    });
    assert.equal(bash.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(
      bash.hookSpecificOutput.updatedInput.command,
      'renice -n 15 -p $$ >/dev/null 2>&1; python analyse.py',
    );
  } finally {
    routed.close();
  }
  f.request.research = researchSchema.parse({
    enabled: true,
    workers: { enforceRoles: 'advise' },
  });
  const advise = researchHooks(f.request);
  try {
    const result = await f.invoke(advise, 'PreToolUse', {
      tool_name: 'Agent',
      tool_input: {},
      tool_use_id: 'dispatch',
    });
    assert.equal(result.hookSpecificOutput.permissionDecision, undefined);
    assert.match(result.hookSpecificOutput.additionalContext, /research_delegate/);
  } finally {
    advise.close();
  }
  f.request.research = researchSchema.parse({ enabled: true, workers: { enforceRoles: 'off' } });
  const off = researchHooks(f.request);
  try {
    assert.deepEqual(
      await f.invoke(off, 'PreToolUse', {
        tool_name: 'Agent',
        tool_input: {},
        tool_use_id: 'dispatch',
      }),
      {},
      'off removes the check rather than downgrading it',
    );
  } finally {
    off.close();
  }
  // Routing severity is its own setting, but a routing issue is still a hard finding, so strict
  // content validation denies it even where routing enforcement has been turned down to advice.
  f.request.research = researchSchema.parse({
    enabled: true,
    validation: 'strict',
    workers: { enforceRoles: 'advise' },
  });
  const strict = researchHooks(f.request);
  try {
    const result = await f.invoke(strict, 'PreToolUse', {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'explorer' },
      tool_use_id: 'dispatch',
    });
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      result.hookSpecificOutput.permissionDecisionReason,
      /does not apply the Clawstrum role/,
    );
  } finally {
    strict.close();
  }
});

test('compaction stores new transcript text once and preserves rewritten or reused sources', async (t) => {
  const f = hookFixture(t);
  const hooks = compactionHooks(f.request);
  const initial = 'start 🌱\n',
    tail = 'new evidence\n',
    replacement = 'a different source with a longer prefix\n';
  try {
    fs.writeFileSync(f.transcript, initial);
    await f.invoke(hooks, 'PreCompact');
    fs.appendFileSync(f.transcript, tail);
    await f.invoke(hooks, 'PostCompact');
    await f.invoke(hooks, 'PostCompact');
    fs.writeFileSync(f.transcript, replacement);
    await f.invoke(hooks, 'PreCompact');
    fs.writeFileSync(f.transcript, 'short\n');
    await f.invoke(hooks, 'PreCompact');
    await f.invoke(hooks, 'PreCompact', { session_id: 'another-native-session' });
    assert.deepEqual(
      f.store
        .all<any>("SELECT content FROM history_records WHERE kind='native_transcript' ORDER BY seq")
        .map((r) => r.content),
      [initial, tail, replacement, 'short\n', 'short\n'],
    );
  } finally {
    hooks.close();
  }
});

test('compaction archives every native source but restores current memory instead of stale state copies', async (t) => {
  const f = hookFixture(t);
  const lead = compactionHooks(f.request);
  const worker = compactionHooks({
    ...f.request,
    mcp: { ...f.request.mcp, env: { ...f.request.mcp.env, CLAWSTRUM_DELEGATION: 'worker' } },
  });
  try {
    updateMemory(f.store, f.session.id, { 'Current work': 'OLD_STATE' });
    await f.invoke(lead, 'PreCompact', { trigger: 'auto', custom_instructions: null });
    fs.writeFileSync(f.transcript, 'worker evidence');
    await f.invoke(worker, 'PreCompact', { trigger: 'auto', custom_instructions: null });
    updateMemory(f.store, f.session.id, { 'Current work': 'CURRENT_STATE' });
    for (const hooks of [lead, worker]) {
      const result = await f.invoke(hooks, 'SessionStart', { source: 'compact' });
      assert.match(result.hookSpecificOutput.additionalContext, /CURRENT_STATE/);
      assert.doesNotMatch(
        result.hookSpecificOutput.additionalContext,
        /OLD_STATE|lead evidence|worker evidence/,
      );
    }
    const records = f.store.all<any>(
      "SELECT content FROM history_records WHERE kind='native_transcript'",
    );
    assert.deepEqual(
      records.map((r) => r.content),
      ['lead evidence', 'worker evidence'],
    );
    await f.invoke(lead, 'PostCompact', { compact_summary: 'native summary' });
    // SessionStart already restored the standing context, and the summary now goes to MEMORY
    // instead of an instruction, so a late PostCompact adds nothing before the next tool.
    const late = await f.invoke(lead, 'PreToolUse', {
      tool_name: 'Read',
      tool_input: {},
      tool_use_id: 'x',
    });
    assert.deepEqual(late, {});
    assert.deepEqual(
      await f.invoke(lead, 'PreToolUse', { tool_name: 'Read', tool_input: {}, tool_use_id: 'y' }),
      {},
      'late PostCompact does not restore twice',
    );
  } finally {
    lead.close();
    worker.close();
  }
});

test('writing rules require a successful read and are scoped to each native context', async (t) => {
  const f = hookFixture(t);
  fs.writeFileSync(path.join(f.session.workspace, 'WRITING.md'), 'Write clearly.');
  const hooks = researchHooks(f.request);
  const write = {
    tool_name: 'Write',
    tool_input: { file_path: 'paper.tex', content: 'prose '.repeat(60) },
    tool_use_id: 'write',
  };
  const read = { tool_name: 'Read', tool_input: { file_path: 'WRITING.md' }, tool_use_id: 'read' };
  try {
    await f.invoke(hooks, 'PreToolUse', read);
    assert.equal(
      (await f.invoke(hooks, 'PreToolUse', write)).hookSpecificOutput.permissionDecision,
      'deny',
    );
    await f.invoke(hooks, 'PostToolUse', { ...read, tool_response: 'Write clearly.' });
    assert.deepEqual(await f.invoke(hooks, 'PreToolUse', write), {});
    assert.equal(
      (await f.invoke(hooks, 'PreToolUse', { ...write, agent_id: 'child' })).hookSpecificOutput
        .permissionDecision,
      'deny',
    );
    await f.invoke(hooks, 'SessionStart', { source: 'compact' });
    assert.equal(
      (await f.invoke(hooks, 'PreToolUse', write)).hookSpecificOutput.permissionDecision,
      'deny',
    );
  } finally {
    hooks.close();
  }
});

test('style findings reach the write that causes them and never deny it', async (t) => {
  const f = hookFixture(t);
  assert.equal(f.config.research.validation, 'strict');
  fs.writeFileSync(path.join(f.session.workspace, 'WRITING.md'), 'Write clearly.');
  const hooks = researchHooks(f.request);
  try {
    const tex = await f.invoke(hooks, 'PreToolUse', {
      tool_name: 'Write',
      tool_input: {
        file_path: 'paper.tex',
        content: '\\section{Why this matters}\nA claim — and its qualifier.\n',
      },
      tool_use_id: 'tex',
    });
    assert.equal(tex.hookSpecificOutput.permissionDecision, undefined);
    assert.match(tex.hookSpecificOutput.additionalContext, /Prose line 1: Heading argues/);
    assert.match(tex.hookSpecificOutput.additionalContext, /Prose line 2: Em dash/);
    // The single strict correction per run belongs to findings that can deny. If style spent it,
    // the next citation error would be advisory, which is the opposite of the intended ordering.
    const cite = await f.invoke(hooks, 'PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: 'notes.md', content: 'See doi:10.1234/example for the result.' },
      tool_use_id: 'cite',
    });
    assert.equal(cite.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    hooks.close();
  }
});

test('write lint is scoped to manuscripts and plots, and reports only what the write adds', (t) => {
  const f = fixture(t);
  const rules = [path.join(f.session.workspace, 'WRITING.md')];
  const advisory = (tool: string, input: Record<string, unknown>, writingRules: string[] = rules) =>
    validationIssues(f.store, f.config.research, tool, input, {
      cwd: f.session.workspace,
      writingRules,
    }).advisory;
  const tex = path.join(f.session.workspace, 'draft.tex');
  const markdown = path.join(f.session.workspace, 'draft.md');
  assert.deepEqual(
    advisory('Write', { file_path: markdown, content: 'A claim — here.' }),
    [],
    'Markdown is out of scope here for the same reason it is out of scope for the writing gate',
  );
  assert.deepEqual(
    advisory('Write', { file_path: tex, content: 'A claim — here.' }, []),
    [],
    'No rules file, no opinion',
  );
  assert.equal(advisory('Write', { file_path: tex, content: 'A claim — here.' }).length, 1);
  fs.writeFileSync(tex, 'One — two.\nThree — four.\n');
  assert.deepEqual(
    advisory('Edit', { file_path: tex, old_string: 'Three', new_string: 'Five' }),
    [],
    'An edit that adds nothing reports nothing, whatever the file already contains',
  );
  assert.equal(
    advisory('Edit', { file_path: tex, old_string: 'Three', new_string: 'Six — seven' }).length,
    1,
  );
  const script = path.join(f.session.workspace, 'plot.py');
  assert.deepEqual(
    advisory('Write', { file_path: script, content: 'x = 1\n' }),
    [],
    'A script that draws nothing is not a figure',
  );
  assert.match(
    advisory('Write', {
      file_path: script,
      content: 'import matplotlib.pyplot as plt\nplt.plot(x, y)\nplt.xlabel("t")\nplt.show()\n',
    })[0]!,
    /^Figure: plt\.show\(\) with no savefig/,
  );
});

test('write lint bounds the complete Edit preview, including replace-all expansion', (t) => {
  const f = fixture(t);
  const file = path.join(f.session.workspace, 'large.tex');
  const rules = [path.join(f.session.workspace, 'WRITING.md')];
  fs.writeFileSync(file, 'x'.repeat(100));
  assert.deepEqual(
    scanProseWrite(
      'Edit',
      {
        file_path: file,
        old_string: 'x',
        new_string: '—'.repeat(lintDocumentLimit / 100 + 1),
        replace_all: true,
      },
      rules,
    ),
    [],
  );
  assert.equal(
    scanProseWrite(
      'Edit',
      {
        file_path: file,
        old_string: 'x',
        new_string: '—',
        replace_all: true,
      },
      rules,
    ).length,
    1,
    'A bounded edit still receives advice',
  );
});

test('memory budgets count prompt characters and all replacements without blocking shrinking edits', (t) => {
  const f = fixture(t),
    target = path.join(f.session.workspace, 'MEMORY.md');
  const limits = { budgets: { [target]: 10 } };
  const issues = (tool: string, input: Record<string, unknown>) =>
    validationIssues(f.store, f.config.research, tool, { file_path: target, ...input }, limits)
      .issues;
  fs.writeFileSync(target, 'é'.repeat(10));
  assert.equal(issues('Write', { content: 'é'.repeat(11) }).length, 1);
  fs.writeFileSync(target, 'aa aa aa');
  assert.equal(
    issues('Edit', { old_string: 'aa', new_string: 'bbbb', replace_all: true }).length,
    1,
  );
  assert.equal(
    issues('Edit', { old_string: 'aa', new_string: 'bbbb' }).length,
    0,
    'Ambiguous edits are the native tool error',
  );
  fs.writeFileSync(target, 'é'.repeat(20));
  assert.equal(issues('Write', { content: 'é'.repeat(15) }).length, 0);
  assert.equal(previewEdit('abc', { old_string: 'b', new_string: '$&' }), 'a$&c');
  assert.equal(contains(path.parse(target).root, target), true);
  assert.equal(
    contains(f.session.workspace, path.join(f.session.workspace, '..', 'outside')),
    false,
  );
});

test('root containment follows symlinks in both directions', (t) => {
  const f = fixture(t);
  const real = path.join(f.home, 'real');
  const outside = path.join(f.home, 'outside');
  fs.mkdirSync(real, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  // A second spelling of the root, which is what a share exported under two mount paths gives.
  fs.symlinkSync(real, path.join(f.home, 'alias'));
  // Links that leave the root: one to a directory that exists, one to a file the write itself
  // would create.
  fs.symlinkSync(outside, path.join(real, 'escape'));
  fs.symlinkSync(path.join(outside, 'new.md'), path.join(real, 'dangling.md'));
  assert.equal(contains(real, path.join(real, 'notes.md')), true, 'plain path inside the root');
  assert.equal(
    contains(real, path.join(f.home, 'alias', 'notes.md')),
    true,
    'the other spelling of the root is the same directory',
  );
  assert.equal(
    contains(real, path.join(real, 'escape', 'notes.md')),
    false,
    'a link out of the root does not carry containment with it',
  );
  assert.equal(
    contains(real, path.join(real, 'dangling.md')),
    false,
    'a link whose destination does not exist yet still redirects the write',
  );
  fs.symlinkSync(path.join(real, 'loop-b.md'), path.join(real, 'loop-a.md'));
  fs.symlinkSync(path.join(real, 'loop-a.md'), path.join(real, 'loop-b.md'));
  assert.equal(
    contains(real, path.join(real, 'loop-a.md')),
    true,
    'a path that cannot be resolved keeps the lexical answer instead of throwing',
  );
});

test('shell recognition does not turn quoted examples or heredoc text into gated actions', () => {
  for (const command of [
    "printf '%s' 'example; sbatch job.sh'",
    'echo "first\nsbatch job.sh"',
    "cat <<'END'\ntee MEMORY.md\nsbatch job.sh\nEND",
    'echo "x > MEMORY.md"',
    "echo 'tee MEMORY.md'",
    "grep 'sed -i x MEMORY.md' notes",
  ]) {
    assert.equal(invokesCommand(command, 'sbatch'), false, command);
    assert.deepEqual(writeTargets(command, 'MEMORY.md'), [], command);
  }
  assert.equal(invokesCommand("bash -c 'sbatch job.sh'", 'sbatch'), true);
  assert.equal(invokesCommand('bash -c \'echo "sbatch job.sh"\'', 'sbatch'), false);
  assert.equal(invokesCommand('env -u TOKEN sudo -u researcher sbatch job.sh', 'sbatch'), true);
  assert.deepEqual(writeTargets('echo x >> "a directory/MEMORY.md"', 'MEMORY.md'), [
    'a directory/MEMORY.md',
  ]);
  assert.deepEqual(writeTargets('cp MEMORY.md /tmp/backup', 'MEMORY.md'), []);
});

test('batch preflight cannot accept a conda hook in a comment or after activation', () => {
  const start = '#!/bin/bash\n';
  assert.equal(
    scriptIssues(start + '# source /opt/etc/profile.d/conda.sh\nconda activate env').errors.length,
    1,
  );
  assert.equal(
    scriptIssues(start + 'conda activate env\nsource /opt/etc/profile.d/conda.sh').errors.length,
    1,
  );
  assert.equal(
    scriptIssues(start + 'source /opt/etc/profile.d/conda.sh\nconda activate env').errors.length,
    0,
  );
});

test('one reply review records citation and length findings with one correction budget', (t) => {
  const f = fixture(t);
  f.config.research = researchSchema.parse({
    enabled: true,
    validation: 'strict',
    reply: { maxChars: 10 },
  });
  f.enqueue('review');
  const run = f.store.claim(f.session.id)!.run;
  const input = {
    sessionId: f.session.id,
    runId: run.id,
    scope: run.logical_id,
    text: 'Unverified doi:10.1234/example',
    route: 'provider-result',
  };
  const first = reviewReply(f.store, f.config.research, input);
  assert.equal(first.blocked, true);
  const artifact = JSON.parse(fs.readFileSync(first.artifactPath!, 'utf8'));
  assert.equal(artifact.shapeIssues.length, 1);
  assert.equal(artifact.scans[0].scan.findings.length, 1);
  assert.equal(
    reviewReply(f.store, f.config.research, { ...input, route: 'send_message' }).blocked,
    false,
  );
});

test('worker evidence reports observation limits without claiming that an unlogged read never happened', (t) => {
  const f = fixture(t),
    file = path.join(f.home, 'events.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'activity', detail: 'read README.md' }, null, 0) + '\nnot json\n',
  );
  assert.equal(workerEvidence(file, ['/project/README.md']).toolEvents, 1);
  const findings = workerFindings('Result', {
    toolEvents: 0,
    suppliedPaths: ['/project/README.md'],
    suppliedPathsSeen: 0,
  }).join('\n');
  assert.match(findings, /unconfirmed/);
  assert.doesNotMatch(findings, /without reading|came from somewhere/);
});

test('queued workers from before the new configuration fields receive schema defaults', async (t) => {
  const f = fixture(t);
  f.config.research.enabled = true;
  const row = delegate(f.store, f.session.id, f.config, 'legacy', {
    role: 'explorer',
    brief: 'Inspect',
  });
  const saved = JSON.parse(row.config_json);
  delete saved.research.reply;
  delete saved.research.writeRoots;
  f.store.exec('UPDATE delegations SET config_json=? WHERE id=?', JSON.stringify(saved), row.id);
  let called = false;
  const provider: Provider = {
    async run(r) {
      called = true;
      assert.deepEqual(r.research!.writeRoots, []);
      assert.equal(r.research!.reply.maxChars, 2000);
      return 'Done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  try {
    engine.tick();
    await Promise.all([...engine.researchWorkers.active.values()].map((r) => r.promise));
    assert.equal(called, true);
    assert.equal(
      f.store.get<any>('SELECT status FROM delegations WHERE id=?', row.id).status,
      'completed',
    );
  } finally {
    await engine.stop();
  }
});

for (const providerName of ['claude', 'codex'] as const)
  test(`${providerName} steering stops during restart drain and resumes after cancellation`, async (t) => {
    const f = fixture(t),
      unlock = acquireLock(f.home);
    const instance = daemonReady(f.store, true);
    f.store.exec(
      'UPDATE sessions SET preferred_account=? WHERE id=?',
      providerName === 'claude' ? 'a' : 'b',
      f.session.id,
    );
    let release!: () => void,
      injected = 0;
    const provider: Provider = {
      async run(r) {
        r.onEvent({ type: 'ready' });
        r.attachInjector!((ids) => {
          injected++;
          r.onEvent({ type: 'injected', detail: { ids, ok: true } });
          return true;
        });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return 'Finished';
      },
    };
    const engine = new Engine(f.config, f.store, {
      claude: providerName === 'claude' ? provider : ok,
      codex: providerName === 'codex' ? provider : ok,
    });
    engine.daemonInstance = instance.id;
    try {
      f.enqueue('first');
      engine.tick();
      await delay(10);
      requestRestart(f.store);
      f.enqueue('during-drain');
      engine.tick();
      assert.equal(engine.draining, true);
      assert.equal(injected, 0);
      assert.equal(
        f.store.get<any>("SELECT status FROM inbound WHERE id='during-drain'").status,
        'queued',
      );
      cancelRestart(f.store);
      engine.tick();
      assert.equal(injected, 1);
      release();
      await settle(engine);
      assert.equal(
        f.store.get<any>("SELECT status FROM inbound WHERE id='during-drain'").status,
        'done',
      );
    } finally {
      release?.();
      await engine.stop();
      unlock();
    }
  });
