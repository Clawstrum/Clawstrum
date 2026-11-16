import { updateMemory } from '../src/memory.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, settle } from './helpers.js';
import { buildContext } from '../src/context.js';
import { readInstructionSnapshot, ContextRefresh } from '../src/instructions.js';
import { createClaudeProvider } from '../src/providers.js';
import { Engine } from '../src/engine.js';
import type { ProviderRequest } from '../src/types.js';
import { codexExecutionSettings } from '../src/provider-settings.js';
import { BASE_PROMPT, CODEX_BASE_PROMPT, mainBasePrompt } from '../src/base-prompt.js';
import { recordGroupChannel } from '../src/groups/store.js';

function setup(t: any) {
  const f = fixture(t);
  const sources = {
    home: f.home,
    workspace: f.session.workspace,
    profile: f.config.accounts[0]!.home,
    maxChars: 16000,
  };
  return { ...f, sources };
}

test('canonical AGENTS overrides legacy names and expands scoped imports, symlinks and cycles once', (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.home, 'SELF.md'), 'LEGACY');
  fs.writeFileSync(path.join(f.home, 'AGENTS.md'), '@shared.md\nGLOBAL');
  fs.writeFileSync(path.join(f.home, 'shared.md'), '@AGENTS.md\nSHARED');
  fs.symlinkSync(path.join(f.home, 'shared.md'), path.join(f.session.workspace, 'shared-link.md'));
  fs.writeFileSync(
    path.join(f.session.workspace, 'AGENTS.md'),
    '@shared-link.md\nLOCAL\n```\n@ignored.md\n```',
  );
  const before = readInstructionSnapshot(f.sources);
  assert.doesNotMatch(before.instructions, /LEGACY/);
  assert.equal(before.instructions.match(/\bSHARED\b/g)?.length, 1);
  assert.ok(before.instructions.indexOf('GLOBAL') < before.instructions.indexOf('LOCAL'));
  assert.ok(!before.files.some((file) => file.endsWith('ignored.md')));
  fs.writeFileSync(path.join(f.home, 'shared.md'), 'SHARED_NEW');
  const after = readInstructionSnapshot(f.sources);
  assert.notEqual(before.revision, after.revision);
  assert.match(after.instructions, /SHARED_NEW/);
  fs.unlinkSync(path.join(f.home, 'shared.md'));
  assert.match(readInstructionSnapshot(f.sources).instructions, /File absent/);
});

test('legacy identity and Claude imports still load; override removal returns to canonical instructions', (t) => {
  const f = setup(t);
  fs.unlinkSync(path.join(f.session.workspace, 'AGENTS.md'));
  fs.writeFileSync(path.join(f.home, 'SELF.md'), 'OLD_IDENTITY');
  fs.writeFileSync(path.join(f.session.workspace, 'CLAUDE.md'), '@policy.md\nOLD_POLICY');
  fs.writeFileSync(path.join(f.session.workspace, 'policy.md'), 'IMPORTED');
  assert.match(readInstructionSnapshot(f.sources).instructions, /OLD_IDENTITY/);
  assert.match(readInstructionSnapshot(f.sources).instructions, /IMPORTED/);
  fs.writeFileSync(path.join(f.session.workspace, 'AGENTS.md'), 'CANONICAL');
  fs.writeFileSync(path.join(f.session.workspace, 'AGENTS.override.md'), 'OVERRIDE');
  assert.doesNotMatch(readInstructionSnapshot(f.sources).instructions, /CANONICAL|OLD_POLICY/);
  fs.unlinkSync(path.join(f.session.workspace, 'AGENTS.override.md'));
  assert.match(readInstructionSnapshot(f.sources).instructions, /CANONICAL/);
});

test('shared edits reach both channels without rotating native sessions; local edits stay local', (t) => {
  const f = setup(t);
  const other = f.store.ensureSession('999999');
  fs.writeFileSync(path.join(f.home, 'AGENTS.md'), 'GLOBAL_OLD');
  for (const session of [f.session, other]) {
    const c = buildContext(f.store, session, f.config.accounts[0]!, [], 4000);
    f.store.exec(
      'UPDATE sessions SET active_account=?,remote_id=?,fingerprint=? WHERE id=?',
      'a',
      'native-' + session.id,
      c.fingerprint,
      session.id,
    );
  }
  fs.writeFileSync(path.join(f.home, 'AGENTS.md'), 'GLOBAL_NEW');
  for (const session of [f.session, other]) {
    const c = buildContext(f.store, f.store.session(session.id), f.config.accounts[0]!, [], 4000);
    assert.equal(c.resumeId, 'native-' + session.id);
    assert.match(c.instructions, /GLOBAL_NEW/);
  }
  updateMemory(f.store, f.session.id, { 'Working understanding': 'LOCAL_FACT' });
  const local = buildContext(
    f.store,
    f.store.session(f.session.id),
    f.config.accounts[0]!,
    [],
    4000,
  );
  const remote = buildContext(f.store, f.store.session(other.id), f.config.accounts[0]!, [], 4000);
  assert.match(local.contextRefresh.snapshot.memory, /LOCAL_FACT/);
  assert.doesNotMatch(remote.contextRefresh.snapshot.memory, /LOCAL_FACT/);
  assert.equal(local.resumeId, 'native-' + f.session.id);
});

test('legacy fingerprints upgrade in place and execution settings still rotate', (t) => {
  const f = setup(t);
  f.store.exec(
    'UPDATE sessions SET active_account=?,remote_id=?,fingerprint=? WHERE id=?',
    'a',
    'native',
    'legacy-hash',
    f.session.id,
  );
  const build = () =>
    buildContext(f.store, f.store.session(f.session.id), f.config.accounts[0]!, [], 4000);
  const c = build();
  assert.equal(c.resumeId, 'native');
  f.store.exec('UPDATE sessions SET fingerprint=? WHERE id=?', c.fingerprint, f.session.id);
  fs.mkdirSync(f.config.accounts[0]!.home);
  fs.writeFileSync(path.join(f.config.accounts[0]!.home, 'settings.json'), '{}');
  assert.equal(build().resumeId, undefined);
});

test('Codex trust bookkeeping preserves both channel sessions but execution edits still rotate', (t) => {
  const f = setup(t);
  const account = { ...f.config.accounts[0]!, provider: 'codex' as const };
  fs.mkdirSync(account.home, { recursive: true });
  const file = path.join(account.home, 'config.toml');
  const initial = 'model = "gpt-6-astra"\n';
  fs.writeFileSync(file, initial);
  const sessions = [f.session, f.store.ensureSession('999999')];
  const build = (id: string) => buildContext(f.store, f.store.session(id), account, [], 4000);
  for (const session of sessions) {
    f.store.exec(
      'UPDATE sessions SET active_account=?,remote_id=?,fingerprint=? WHERE id=?',
      account.id,
      'native-' + session.id,
      build(session.id).fingerprint,
      session.id,
    );
  }
  const trusts = sessions
    .map((s) => `[projects.${JSON.stringify(s.workspace)}]\ntrust_level = "trusted"\n`)
    .join('\n');
  fs.writeFileSync(file, initial + trusts);
  for (const session of sessions) assert.equal(build(session.id).resumeId, 'native-' + session.id);
  fs.writeFileSync(file, initial + trusts + 'model_instructions_file = "/new-policy.md"\n');
  assert.equal(
    build(f.session.id).resumeId,
    undefined,
    'other project settings remain significant',
  );
  fs.writeFileSync(file, initial + 'model_reasoning_effort = "high"\n' + trusts);
  assert.equal(
    build(f.session.id).resumeId,
    undefined,
    'global execution settings remain significant',
  );
});

test('Codex settings normalization handles TOML strings, ordering and invalid syntax conservatively', () => {
  const base =
    'model = "gpt-6-astra"\ndeveloper_instructions = """\n[projects.fake]\ntrust_level = "keep this literal"\n"""\n';
  const trust = '\n[projects."/workspace.with.dots"]\ntrust_level="trusted"\n';
  assert.equal(codexExecutionSettings(base), codexExecutionSettings(base + trust));
  assert.notEqual(
    codexExecutionSettings(base),
    codexExecutionSettings(base.replace('keep this literal', 'changed')),
  );
  assert.equal(codexExecutionSettings('a=1\nb=2'), codexExecutionSettings('# reordered\nb=2\na=1'));
  assert.equal(
    codexExecutionSettings(''),
    codexExecutionSettings('[projects."/new"]\ntrust_level="trusted"'),
  );
  assert.equal(codexExecutionSettings('invalid = ['), 'invalid = [');
  assert.notEqual(
    codexExecutionSettings('n=9007199254740992'),
    codexExecutionSettings('n=9007199254740993'),
  );
});

test('Claude refreshes imports before tools, live input and compaction with independent subagent delivery', async (t) => {
  const f = setup(t);
  const file = path.join(f.home, 'AGENTS.md');
  fs.writeFileSync(file, 'OLD');
  const snapshot = readInstructionSnapshot(f.sources);
  const events: any[] = [];
  let inject: NonNullable<ProviderRequest['attachInjector']> extends (arg: infer A) => void
    ? A
    : never;
  const query = ((params: any) =>
    Object.assign(
      (async function* () {
        assert.deepEqual(params.options.extraArgs, { 'system-prompt-snapshot': 'off' });
        const input = params.prompt[Symbol.asyncIterator]();
        await input.next();
        yield { type: 'system', subtype: 'init', session_id: 'native' };
        fs.writeFileSync(file, 'NEW');
        const hook = params.options.hooks.PreToolUse[0].hooks[0];
        const invoke = (agent_id?: string) =>
          hook({ hook_event_name: 'PreToolUse', session_id: 'native', agent_id }, null, {});
        assert.match((await invoke('child')).hookSpecificOutput.additionalContext, /NEW/);
        assert.match((await invoke()).hookSpecificOutput.additionalContext, /NEW/);
        assert.deepEqual(await invoke(), {});
        updateMemory(f.store, f.session.id, { 'Current work': 'RECENT_CHECKPOINT' });
        assert.equal(inject(['followup'], 'User follow-up'), true);
        const followup = (await input.next()).value.message.content;
        assert.equal(followup, 'User follow-up');
        const submit = params.options.hooks.UserPromptSubmit[0].hooks[0];
        assert.match(
          (
            await submit(
              { hook_event_name: 'UserPromptSubmit', session_id: 'native', prompt: followup },
              null,
              {},
            )
          ).hookSpecificOutput.additionalContext,
          /RECENT_CHECKPOINT/,
        );
        const compact = params.options.hooks.SessionStart.at(-1).hooks[0];
        assert.match(
          (
            await compact(
              { hook_event_name: 'SessionStart', source: 'compact', session_id: 'native' },
              null,
              {},
            )
          ).hookSpecificOutput.additionalContext,
          /NEW/,
        );
        yield { type: 'result', subtype: 'success', result: 'First', usage: {} };
        yield { type: 'result', subtype: 'success', result: 'Final', usage: {} };
      })(),
      { close() {} },
    )) as any;
  await createClaudeProvider(query).run({
    account: f.config.accounts[0]!,
    cwd: f.session.workspace,
    prompt: 'Work',
    instructions: 'Fixture',
    contextRefresh: { sources: f.sources, snapshot },
    env: {},
    controller: new AbortController(),
    mcp: { command: 'node', args: [], env: {} },
    attachInjector: (fn) => (inject = fn),
    onEvent: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.type === 'context_updated'));
  assert.equal(
    events.filter((e) => e.type === 'injected').length,
    1,
    'Only actual user steering gets a user-input acknowledgment',
  );
});

test('Claude subagent gets a change at a tool boundary once as a user message, otherwise the hook', async (t) => {
  const f = setup(t);
  const file = path.join(f.home, 'AGENTS.md');
  fs.writeFileSync(file, 'OLD');
  const snapshot = readInstructionSnapshot(f.sources);
  const events: any[] = [];
  let inject: NonNullable<ProviderRequest['attachInjector']> extends (arg: infer A) => void
    ? A
    : never;
  const query = ((params: any) =>
    Object.assign(
      (async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        const prompt = (await input.next()).value;
        yield { type: 'system', subtype: 'init', session_id: 'native' };
        fs.writeFileSync(file, 'NEW');
        const hook = params.options.hooks.PreToolUse[0].hooks[0];
        const post = params.options.hooks.PostToolUse[0].hooks[0];
        const invoke = (agent_id?: string) =>
          hook({ hook_event_name: 'PreToolUse', session_id: 'native', agent_id }, null, {});
        // A Claude Code nested agent inside the subagent keeps the hook channel.
        assert.match((await invoke('child')).hookSpecificOutput.additionalContext, /NEW/);
        assert.deepEqual(await invoke(), {}, 'no additionalContext for the subagent itself');
        const update = (await input.next()).value;
        assert.equal(update.type, 'user');
        assert.match(
          update.message.content,
          /^Clawstrum update \(not a new task\): AGENTS\.md changed\. The text below replaces the earlier version in your system prompt\./,
        );
        assert.match(update.message.content, /CLAWSTRUM_CONTEXT_UPDATE[\s\S]*NEW/);
        assert.deepEqual(
          await post({ hook_event_name: 'PostToolUse', session_id: 'native' }, null, {}),
          {},
          'delivered once: neither a second message nor a hook copy',
        );
        assert.equal(inject(['steer'], 'Lead correction'), true);
        const steer = (await input.next()).value.message.content;
        assert.equal(steer, 'Lead correction');
        // A prompt hook keeps the hook channel: a message pushed there could become its own turn.
        fs.writeFileSync(file, 'PROMPT_TIME');
        const submit = params.options.hooks.UserPromptSubmit[0].hooks[0];
        assert.match(
          (
            await submit(
              { hook_event_name: 'UserPromptSubmit', session_id: 'native', prompt: steer },
              null,
              {},
            )
          ).hookSpecificOutput.additionalContext,
          /PROMPT_TIME/,
        );
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Done',
          usage: {},
          user_message_uuids: [prompt.uuid, update.uuid],
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Done after correction',
          usage: {},
          num_turns: 1,
        };
        // The stream has closed after the last result. A turn the CLI starts by itself
        // still gets a later change through the hook.
        fs.writeFileSync(file, 'NEWER');
        assert.match((await invoke()).hookSpecificOutput.additionalContext, /NEWER/);
        assert.deepEqual(await invoke(), {});
      })(),
      { close() {} },
    )) as any;
  const final = await createClaudeProvider(query).run({
    account: f.config.accounts[0]!,
    cwd: f.session.workspace,
    prompt: 'Work',
    instructions: 'Fixture',
    contextRefresh: { sources: f.sources, snapshot },
    subagent: true,
    liveInput: true,
    env: {},
    controller: new AbortController(),
    mcp: { command: 'node', args: [], env: {} },
    attachInjector: (fn) => (inject = fn),
    onEvent: (e) => events.push(e),
  });
  assert.equal(final, 'Done after correction');
  assert.equal(events.filter((e) => e.type === 'context_updated').length, 4);
  assert.equal(
    events.filter((e) => e.type === 'injected').length,
    1,
    'the update message is not reported as user steering',
  );
});

test('engine remembers acknowledged context revisions per native session and sends changed context on resume', async (t) => {
  const f = setup(t);
  let calls = 0;
  const revisions: string[] = [];
  const provider = {
    async run(r: ProviderRequest) {
      assert.ok(r.contextRefresh);
      const refresh = new ContextRefresh(r);
      const snapshot = refresh.read()!;
      if (calls === 1) assert.equal(refresh.changed(snapshot), false);
      if (calls === 2) assert.equal(refresh.changed(snapshot), true);
      r.onEvent({ type: 'session', sessionId: 'native' });
      refresh.delivered(snapshot, 'native');
      revisions.push(refresh.revision(snapshot));
      calls++;
      return 'done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  for (let i = 0; i < 3; i++) {
    if (i === 2) fs.writeFileSync(path.join(f.home, 'AGENTS.md'), 'UPDATED');
    f.enqueue('message-' + i);
    engine.tick();
    await settle(engine);
  }
  assert.equal(calls, 3);
  assert.equal(revisions[0], revisions[1]);
  assert.notEqual(revisions[1], revisions[2]);
  assert.equal(f.store.session(f.session.id).remote_id, 'native');
  await engine.stop();
});

test('engine marks lead runs in the main channel and its threads as mainChannel', async (t) => {
  const f = setup(t);
  const seen: Record<string, boolean | undefined> = {};
  const provider = {
    async run(r: ProviderRequest) {
      seen[r.cwd] = r.mainChannel;
      return 'done';
    },
  };
  const other = f.store.ensureSession('111111');
  const thread = f.store.ensureSession('222222');
  recordGroupChannel(f.store, thread, 'thread', f.config.discord.channelIds[0]!);
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  for (const session of [f.session, other, thread]) {
    f.store.enqueue({
      id: 'm-' + session.id,
      sessionId: session.id,
      author: 'owner',
      content: 'hi',
      at: Date.now(),
    });
    engine.tick();
    await settle(engine);
  }
  assert.equal(seen[f.session.workspace], true);
  assert.ok(other.workspace in seen);
  assert.ok(!seen[other.workspace]);
  assert.equal(seen[thread.workspace], true);
  await engine.stop();
});

test('memory-only refresh leaves the instruction block alone and still reports deletions', (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.home, 'AGENTS.md'), 'KEEP_INSTRUCTION');
  const snapshot = readInstructionSnapshot(f.sources);
  const request = {
    instructions: 'static',
    contextRefresh: { sources: f.sources, snapshot },
    onEvent() {},
  } as ProviderRequest;
  const refresh = new ContextRefresh(request);
  refresh.delivered(snapshot, 'native');
  updateMemory(f.store, f.session.id, { 'Working understanding': 'NEW_FACT' });
  const changed = refresh.read()!;
  assert.ok(refresh.changed(changed));
  assert.match(refresh.text(changed), /NEW_FACT/);
  assert.doesNotMatch(refresh.text(changed), /KEEP_INSTRUCTION/);
  refresh.delivered(changed, 'native');
  updateMemory(f.store, f.session.id, { 'Working understanding': '' });
  assert.doesNotMatch(refresh.text(refresh.read()!), /NEW_FACT/);
  assert.match(refresh.text(refresh.read()!), /Replace current MEMORY facts/);
});

test('large imports do not displace shared or workspace policies and changes inside omitted text remain visible', (t) => {
  const f = setup(t);
  const global = '@notes.md\nGLOBAL_POLICY\n' + 'G'.repeat(6000);
  const local = 'LOCAL_POLICY\n' + 'L'.repeat(2000);
  fs.writeFileSync(path.join(f.home, 'AGENTS.md'), global);
  fs.writeFileSync(path.join(f.session.workspace, 'AGENTS.md'), local);
  const notes = path.join(f.home, 'notes.md');
  fs.writeFileSync(notes, 'N'.repeat(15000) + 'OLD_MIDDLE' + 'N'.repeat(15000));
  const before = readInstructionSnapshot(f.sources);
  assert.ok(before.instructions.includes(global));
  assert.ok(before.instructions.includes(local));
  assert.ok(before.instructions.includes(notes));
  assert.match(before.instructions, /\[Excerpt:/);
  assert.doesNotMatch(before.instructions, /OLD_MIDDLE/);
  assert.ok(before.instructions.length <= f.sources.maxChars);
  fs.writeFileSync(notes, 'N'.repeat(15000) + 'NEW_MIDDLE' + 'N'.repeat(15000));
  const after = readInstructionSnapshot(f.sources);
  assert.notEqual(
    after.instructions,
    before.instructions,
    'source revision exposes an omitted edit',
  );
  assert.notEqual(after.revision, before.revision);
  const tiny = readInstructionSnapshot({ ...f.sources, maxChars: 1000 });
  assert.ok(
    tiny.instructions.length <= 1000,
    'tiny per-file budgets never include unbounded tails',
  );
});

test('memory over budget is cut per document, never silently sliced off the head', (t) => {
  const f = setup(t);
  const scopes = [
    { dir: f.config.accounts[0]!.home, tag: 'PROFILE_MEMORY_HEAD' },
    { dir: f.home, tag: 'SHARED_MEMORY_HEAD' },
    { dir: f.session.workspace, tag: 'WORKSPACE_MEMORY_HEAD' },
  ];
  for (const { dir, tag } of scopes) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'AGENTS.md'),
      `# Agent\n\n## Instructions\n\nFollow the request.\n\n## MEMORY\n\n${tag}\n${'m'.repeat(15000)}\n`,
    );
  }
  const promptLimit = 40000;
  const context = buildContext(f.store, f.session, f.config.accounts[0]!, [], 4000, promptLimit);
  // The head-cut keeps the tail, so an unfitted memory block loses whole leading documents.
  for (const { tag } of scopes)
    assert.ok(context.instructions.includes(tag), `${tag} survived the budget`);
  const budget = JSON.parse(
    f.store.get<{ content: string }>("SELECT content FROM events WHERE type='context_budget'")!
      .content,
  );
  const memory = budget.sources.filter((source: any) => source.source === 'memory');
  assert.equal(
    memory.length,
    scopes.length,
    'every memory document is accounted for in the budget',
  );
  assert.ok(
    memory.some((source: any) => source.renderedChars < source.originalChars),
    'a memory document that had to shrink is reported as truncated',
  );
});

test('large resumed Claude context stays in native instructions across compaction and live input', async (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.home, 'AGENTS.md'), 'STANDING_POLICY\n' + 'policy '.repeat(13000));
  updateMemory(f.store, f.session.id, {
    'Working understanding': 'DURABLE_FACT ' + 'fact '.repeat(20000),
  });
  const account = f.config.accounts[0]!;
  const context = buildContext(f.store, f.session, account, [], 4000, 240000);
  let inject: any;
  const query = ((params: any) =>
    Object.assign(
      (async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        const first = (await input.next()).value.message.content;
        assert.equal(first, 'progress?');
        assert.equal(typeof params.options.systemPrompt, 'string');
        assert.ok(params.options.systemPrompt.startsWith(`${BASE_PROMPT}\n\n`));
        assert.match(params.options.systemPrompt, /STANDING_POLICY/);
        assert.match(params.options.systemPrompt, /DURABLE_FACT/);
        assert.ok(params.options.systemPrompt.length > 190000);
        yield { type: 'system', subtype: 'init', session_id: 'same-native' };
        const call = (name: string, extra = {}) =>
          params.options.hooks[name][0].hooks[0](
            {
              hook_event_name: name,
              session_id: 'same-native',
              transcript_path: '',
              cwd: f.session.workspace,
              ...extra,
            },
            null,
            { signal: new AbortController().signal },
          );
        const compact = await call('SessionStart', { source: 'compact' });
        assert.ok(compact.hookSpecificOutput.additionalContext.length < 2000);
        assert.doesNotMatch(
          compact.hookSpecificOutput.additionalContext,
          /DURABLE_FACT|STANDING_POLICY/,
        );
        updateMemory(f.store, f.session.id, { 'Working understanding': 'CORRECTED_FACT' });
        assert.equal(inject(['followup'], 'and this?'), true);
        const next = (await input.next()).value.message.content;
        assert.equal(next, 'and this?');
        const update = await call('UserPromptSubmit', { prompt: next });
        assert.match(update.hookSpecificOutput.additionalContext, /CORRECTED_FACT/);
        assert.doesNotMatch(
          update.hookSpecificOutput.additionalContext,
          /DURABLE_FACT|STANDING_POLICY/,
        );
        // Compaction can remove the earlier hook update. Restore changes relative to native launch,
        // even when that update was already delivered at a tool/input boundary.
        const again = await call('SessionStart', { source: 'compact' });
        assert.match(again.hookSpecificOutput.additionalContext, /CORRECTED_FACT/);
        assert.doesNotMatch(
          again.hookSpecificOutput.additionalContext,
          /DURABLE_FACT|STANDING_POLICY/,
        );
        yield { type: 'result', subtype: 'success', result: 'first complete', usage: {} };
        yield { type: 'result', subtype: 'success', result: 'done', usage: {} };
      })(),
      { close() {} },
    )) as any;
  await createClaudeProvider(query).run({
    ...context,
    account,
    cwd: f.session.workspace,
    prompt: 'progress?',
    sessionId: 'same-native',
    contextRefresh: { ...context.contextRefresh, previousRevision: 'older-snapshot' },
    env: {},
    controller: new AbortController(),
    mcp: {
      command: 'node',
      args: [],
      env: {
        CLAWSTRUM_HOME: f.home,
        CLAWSTRUM_SESSION: f.session.id,
      },
    },
    attachInjector: (fn) => {
      inject = fn;
    },
    onEvent() {},
  });
});

test('oversized multibyte context updates retain every byte in a private immutable file', (t) => {
  const f = setup(t);
  const snapshot = readInstructionSnapshot(f.sources);
  const refresh = new ContextRefresh({
    account: f.config.accounts[0]!,
    cwd: f.session.workspace,
    prompt: '',
    instructions: snapshot.instructions,
    contextRefresh: { sources: f.sources, snapshot },
    env: {},
    controller: new AbortController(),
    mcp: { command: 'node', args: [], env: {} },
    onEvent() {},
  });
  refresh.useNativeInstructions(snapshot);
  const fact = '科学'.repeat(20000) + 'IMPORTANT_TAIL';
  updateMemory(f.store, f.session.id, { 'Working understanding': fact });
  const changed = refresh.read()!;
  const output = refresh.text(changed);
  assert.ok(Buffer.byteLength(output) < 12000);
  const file = /complete replacement context is in (.+?) \(SHA-256/.exec(output)![1]!;
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(saved.includes(fact));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  updateMemory(f.store, f.session.id, { 'Working understanding': 'LATEST' });
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.match(refresh.currentInstructions(refresh.read()!), /LATEST/);
  assert.doesNotMatch(refresh.currentInstructions(refresh.read()!), /IMPORTANT_TAIL/);
});

test('a local memory correction does not resend unchanged large shared facts; removed sources are retired', (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.home, 'AGENTS.md'), '# Shared\n\n## MEMORY\n');
  updateMemory(f.store, null, {
    'Working understanding': 'SHARED_BOARD ' + 'context '.repeat(10000),
  });
  updateMemory(f.store, f.session.id, { 'Working understanding': 'OLD_LOCAL' });
  const snapshot = readInstructionSnapshot(f.sources);
  const refresh = new ContextRefresh({
    account: f.config.accounts[0]!,
    cwd: f.session.workspace,
    prompt: '',
    instructions: snapshot.instructions,
    contextRefresh: { sources: f.sources, snapshot },
    env: {},
    controller: new AbortController(),
    mcp: { command: 'node', args: [], env: {} },
    onEvent() {},
  });
  refresh.useNativeInstructions(snapshot);
  updateMemory(f.store, f.session.id, { 'Working understanding': 'NEW_LOCAL' });
  const changed = refresh.read()!;
  const update = refresh.text(changed);
  assert.match(update, /NEW_LOCAL/);
  assert.doesNotMatch(update, /SHARED_BOARD|OLD_LOCAL|complete replacement context is in/);
  refresh.delivered(changed, 'native');
  fs.writeFileSync(path.join(f.session.workspace, 'AGENTS.md'), '# Instructions only');
  const removed = refresh.text(refresh.read()!);
  assert.match(removed, /Removed; discard all earlier MEMORY facts from this source/);
  assert.doesNotMatch(removed, /SHARED_BOARD|NEW_LOCAL/);
});

test('literal snapshot marker examples cannot replace standing policy during memory refresh', (t) => {
  const f = setup(t);
  const policy =
    'Keep this example: CLAWSTRUM_CURRENT_MEMORY_BEGIN policy example CLAWSTRUM_CURRENT_MEMORY_END';
  fs.writeFileSync(path.join(f.home, 'AGENTS.md'), policy);
  updateMemory(f.store, f.session.id, { 'Working understanding': 'OLD_FACT' });
  const context = buildContext(f.store, f.session, f.config.accounts[0]!, [], 4000);
  const refresh = new ContextRefresh({
    ...context,
    account: f.config.accounts[0]!,
    cwd: f.session.workspace,
    env: {},
    controller: new AbortController(),
    mcp: { command: 'node', args: [], env: {} },
    onEvent() {},
  });
  updateMemory(f.store, f.session.id, { 'Working understanding': 'NEW_FACT' });
  const instructions = refresh.currentInstructions(refresh.read()!);
  assert.ok(instructions.includes(policy));
  assert.match(instructions, /NEW_FACT/);
  assert.doesNotMatch(instructions, /OLD_FACT/);
});

test('base prompt templates load trimmed, and the Codex one adds its tool lines', () => {
  assert.ok(BASE_PROMPT.startsWith('You are a research collaborator'));
  assert.doesNotMatch(BASE_PROMPT, /\n---\s*$/);
  assert.ok(CODEX_BASE_PROMPT.startsWith(`${BASE_PROMPT}\n\n`));
  assert.match(CODEX_BASE_PROMPT, /functions\.exec/);
});

test('Claude lead runs replace the preset with the base prompt; subagent and toolless keep it', async (t) => {
  const f = setup(t);
  for (const flags of [{}, { subagent: true }, { toolless: true }]) {
    let systemPrompt: any;
    const query = ((params: any) =>
      Object.assign(
        (async function* () {
          systemPrompt = params.options.systemPrompt;
          yield { type: 'result', subtype: 'success', result: 'ok', usage: {} };
        })(),
        { close() {} },
      )) as any;
    await createClaudeProvider(query).run({
      ...flags,
      account: f.config.accounts[0]!,
      cwd: f.session.workspace,
      prompt: 'Work',
      instructions: 'FIXTURE_INSTRUCTIONS',
      env: {},
      controller: new AbortController(),
      mcp: { command: 'node', args: [], env: {} },
      onEvent() {},
    });
    if (!flags.subagent && !flags.toolless)
      assert.equal(systemPrompt, `${BASE_PROMPT}\n\nFIXTURE_INSTRUCTIONS`);
    else
      assert.deepEqual(systemPrompt, {
        type: 'preset',
        preset: 'claude_code',
        append: 'FIXTURE_INSTRUCTIONS',
      });
  }
});

test('Claude main-channel lead runs get the main base prompt; subagent and toolless keep the preset', async (t) => {
  const f = setup(t);
  for (const flags of [{}, { subagent: true }, { toolless: true }]) {
    let systemPrompt: any;
    const query = ((params: any) =>
      Object.assign(
        (async function* () {
          systemPrompt = params.options.systemPrompt;
          yield { type: 'result', subtype: 'success', result: 'ok', usage: {} };
        })(),
        { close() {} },
      )) as any;
    await createClaudeProvider(query).run({
      ...flags,
      mainChannel: true,
      account: f.config.accounts[0]!,
      cwd: f.session.workspace,
      prompt: 'Work',
      instructions: 'FIXTURE_INSTRUCTIONS',
      env: {},
      controller: new AbortController(),
      mcp: { command: 'node', args: [], env: {} },
      onEvent() {},
    });
    if (!Object.keys(flags).length)
      assert.equal(systemPrompt, `${mainBasePrompt()}\n\nFIXTURE_INSTRUCTIONS`);
    else
      assert.deepEqual(systemPrompt, {
        type: 'preset',
        preset: 'claude_code',
        append: 'FIXTURE_INSTRUCTIONS',
      });
  }
});
