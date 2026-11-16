import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { HookCallback, HookInput, Options } from '@anthropic-ai/claude-agent-sdk';
import {
  applyPatchFiles,
  claudeHookInput,
  claudeHookInputs,
  geminiToolCall,
  runHooks,
  startHookRelay,
} from '../src/hook-relay.js';

const client = path.resolve('src/hook-client.ts');

function runClient(
  format: 'gemini' | 'codex',
  payload: unknown,
  env: Record<string, string | undefined>,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    if (env.CLAWSTRUM_HOOK_SOCKET === undefined) delete childEnv.CLAWSTRUM_HOOK_SOCKET;
    const child = spawn(process.execPath, ['--import', 'tsx', client, '--format', format], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, code }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function tempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-relay-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const deny = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse' as const,
    permissionDecision: 'deny' as const,
    permissionDecisionReason: reason,
  },
});

const geminiPre = (name: string, args: Record<string, unknown>) => ({
  hookEventName: 'PreToolUse',
  conversationId: 'conv-1',
  cwd: '/work',
  modelName: 'gemini-4-argon-medium',
  toolCall: { id: 'call_1', name, args },
  transcriptPath: '/t',
  workspacePaths: ['/work'],
});

test('geminiToolCall maps agy tools onto Claude tool names and keeps the original keys', () => {
  assert.deepEqual(geminiToolCall('run_command', { CommandLine: 'ls', WaitMsBeforeAsync: 1 }), {
    tool_name: 'Bash',
    tool_input: { CommandLine: 'ls', WaitMsBeforeAsync: 1, command: 'ls' },
  });
  for (const name of ['read_file', 'view_file'])
    assert.deepEqual(geminiToolCall(name, { Path: '/a', StartLine: 2 }), {
      tool_name: 'Read',
      tool_input: { Path: '/a', StartLine: 2, file_path: '/a' },
    });
  assert.deepEqual(geminiToolCall('write_file', { Path: '/a', Content: 'x', Append: true }), {
    tool_name: 'Write',
    tool_input: { Path: '/a', Content: 'x', Append: true, file_path: '/a', content: 'x' },
  });
  assert.deepEqual(geminiToolCall('edit_file', { Path: '/a', Target: 'o', Replacement: 'n' }), {
    tool_name: 'Edit',
    tool_input: {
      Path: '/a',
      Target: 'o',
      Replacement: 'n',
      file_path: '/a',
      old_string: 'o',
      new_string: 'n',
    },
  });
  assert.deepEqual(
    geminiToolCall('invoke_subagent', { TypeName: 'general', Role: 'r', Prompt: 'p' }),
    {
      tool_name: 'Agent',
      tool_input: {
        TypeName: 'general',
        Role: 'r',
        Prompt: 'p',
        subagent_type: 'general',
        description: 'r',
        prompt: 'p',
      },
    },
  );
  assert.deepEqual(
    geminiToolCall('define_subagent', { Name: 'n', Description: 'd', SystemPrompt: 's' }),
    {
      tool_name: 'Agent',
      tool_input: {
        Name: 'n',
        Description: 'd',
        SystemPrompt: 's',
        subagent_type: 'n',
        description: 'd',
        prompt: 's',
      },
    },
  );
  assert.deepEqual(geminiToolCall('run_workflow', { Script: 'phase(1)', Cwd: '/w' }), {
    tool_name: 'Workflow',
    tool_input: { Script: 'phase(1)', Cwd: '/w', script: 'phase(1)' },
  });
  const swarm = { action: 'start', tasks: ['a'], n: 2 };
  assert.deepEqual(geminiToolCall('swarm', swarm), {
    tool_name: 'Workflow',
    tool_input: { ...swarm, script: JSON.stringify(swarm) },
  });
  assert.deepEqual(geminiToolCall('search_web', { query: 'q' }), {
    tool_name: 'search_web',
    tool_input: { query: 'q' },
  });
});

test('claudeHookInput turns gemini payloads into Claude hook inputs', () => {
  assert.deepEqual(claudeHookInput('gemini', geminiPre('run_command', { CommandLine: 'ls' })), {
    hook_event_name: 'PreToolUse',
    session_id: 'conv-1',
    transcript_path: '/t',
    cwd: '/work',
    tool_name: 'Bash',
    tool_input: { CommandLine: 'ls', command: 'ls' },
    tool_use_id: 'call_1',
  });
  const post = { ...geminiPre('read_file', { Path: '/a' }), hookEventName: 'PostToolUse' };
  assert.equal(claudeHookInput('gemini', { ...post, error: '' })?.hook_event_name, 'PostToolUse');
  const failed = claudeHookInput('gemini', { ...post, error: 'boom' }) as any;
  assert.equal(failed.hook_event_name, 'PostToolUseFailure');
  assert.equal(failed.error, 'boom');
  assert.equal(claudeHookInput('gemini', { hookEventName: 'PreToolUse' }), undefined);
  assert.equal(claudeHookInput('gemini', { ...post, hookEventName: 'Stop' }), undefined);
  const codex = claudeHookInput('codex', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  }) as any;
  assert.equal(codex.tool_name, 'Bash');
  assert.equal(codex.session_id, '');
  assert.equal(typeof codex.cwd, 'string');
});

test('runHooks: the first deny wins and later callbacks do not run', async () => {
  const calls: string[] = [];
  const hooks: Options['hooks'] = {
    PreToolUse: [
      {
        hooks: [
          async () => (calls.push('a'), {}),
          async () => (calls.push('b'), deny('no')),
          async () => (calls.push('c'), {}),
        ],
      },
      { hooks: [async () => (calls.push('d'), {})] },
    ],
  };
  const input = claudeHookInput('gemini', geminiPre('run_command', { CommandLine: 'ls' }))!;
  const result = await runHooks(hooks, input, 'call_1', new AbortController().signal);
  assert.deepEqual(result, deny('no'));
  assert.deepEqual(calls, ['a', 'b']);
});

test('runHooks: a matcher filters by tool_name and additionalContext merges', async () => {
  const context =
    (text: string): HookCallback =>
    async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
    });
  const hooks: Options['hooks'] = {
    PreToolUse: [
      { matcher: 'Bash', hooks: [context('bash')] },
      { matcher: '^(Read|Write)$', hooks: [context('file')] },
      { matcher: '*', hooks: [context('all')] },
      { hooks: [context('none')] },
    ],
  };
  const input = claudeHookInput('gemini', geminiPre('read_file', { Path: '/a' }))!;
  const result = await runHooks(hooks, input, 'call_1', new AbortController().signal);
  assert.equal((result.hookSpecificOutput as any).additionalContext, 'file\n\nall\n\nnone');
});

test('relay round trip: the gemini client prints deny or allow, and PostToolUse reaches its hook', async (t) => {
  const seen: HookInput[] = [];
  const hooks: Options['hooks'] = {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            const command = String((input as any).tool_input?.command ?? '');
            return command.includes('.env') ? deny('prints a secret file') : {};
          },
        ],
      },
    ],
    PostToolUse: [{ hooks: [async (input) => (seen.push(input), {})] }],
  };
  const relay = await startHookRelay({ hooks, format: 'gemini', dir: tempDir(t) });
  t.after(() => relay.close());
  const env = relay.env;
  const denied = await runClient(
    'gemini',
    geminiPre('run_command', { CommandLine: 'cat .env' }),
    env,
  );
  assert.equal(denied.code, 0);
  assert.deepEqual(JSON.parse(denied.stdout), {
    decision: 'deny',
    reason: 'prints a secret file',
  });
  const allowed = await runClient('gemini', geminiPre('run_command', { CommandLine: 'ls' }), env);
  assert.deepEqual(JSON.parse(allowed.stdout), { decision: 'allow' });
  const post = await runClient(
    'gemini',
    { ...geminiPre('read_file', { Path: '/work/a.md' }), hookEventName: 'PostToolUse', error: '' },
    env,
  );
  assert.deepEqual(JSON.parse(post.stdout), { decision: 'allow' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.hook_event_name, 'PostToolUse');
  assert.equal((seen[0] as any).tool_name, 'Read');
  assert.equal((seen[0] as any).tool_input.file_path, '/work/a.md');
});

test('client without a relay allows; with a missing socket it denies PreToolUse only', async (t) => {
  const pre = geminiPre('run_command', { CommandLine: 'ls' });
  const none = await runClient('gemini', pre, { CLAWSTRUM_HOOK_SOCKET: undefined });
  assert.equal(none.code, 0);
  assert.deepEqual(JSON.parse(none.stdout), { decision: 'allow' });
  const codexNone = await runClient('codex', { hook_event_name: 'PreToolUse' }, {});
  assert.equal(codexNone.stdout, '');
  const missing = { CLAWSTRUM_HOOK_SOCKET: path.join(tempDir(t), 'hook.sock') };
  const denied = await runClient('gemini', pre, missing);
  assert.equal(denied.code, 0);
  const out = JSON.parse(denied.stdout);
  assert.equal(out.decision, 'deny');
  assert.match(
    out.reason,
    /^Clawstrum's tool check could not run \(.+\)\. The call was not made\./,
  );
  const post = await runClient('gemini', { ...pre, hookEventName: 'PostToolUse' }, missing);
  assert.deepEqual(JSON.parse(post.stdout), { decision: 'allow' });
  const codex = await runClient(
    'codex',
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    missing,
  );
  const codexOut = JSON.parse(codex.stdout);
  assert.equal(codexOut.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(codexOut.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(
    codexOut.hookSpecificOutput.permissionDecisionReason,
    /^Clawstrum's tool check could not run/,
  );
  const codexPost = await runClient('codex', { hook_event_name: 'PostToolUse' }, missing);
  assert.equal(codexPost.stdout, '');
});

test('codex relay: only a deny is printed, with a reason even when the hook gave none', async (t) => {
  let answer: any = {};
  const hooks: Options['hooks'] = { PreToolUse: [{ hooks: [async () => answer] }] };
  const relay = await startHookRelay({ hooks, format: 'codex', dir: tempDir(t) });
  t.after(() => relay.close());
  const payload = {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    cwd: '/work',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  };
  answer = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { command: 'nice ls' },
      additionalContext: 'note',
    },
  };
  const allowed = await runClient('codex', payload, relay.env);
  assert.equal(allowed.code, 0);
  assert.equal(allowed.stdout, '');
  answer = deny('');
  const denied = await runClient('codex', payload, relay.env);
  assert.deepEqual(JSON.parse(denied.stdout), deny('Refused by a Clawstrum check.'));
});

test('a throwing hook answers an error, and the client denies without echoing the input', async (t) => {
  const events: unknown[] = [];
  const hooks: Options['hooks'] = {
    PreToolUse: [
      {
        hooks: [
          async () => {
            throw new Error('store locked');
          },
        ],
      },
    ],
  };
  const relay = await startHookRelay({
    hooks,
    format: 'gemini',
    dir: tempDir(t),
    onEvent: (e) => events.push(e),
  });
  t.after(() => relay.close());
  const out = await runClient(
    'gemini',
    geminiPre('run_command', { CommandLine: 'echo TOPSECRET' }),
    relay.env,
  );
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.decision, 'deny');
  assert.match(parsed.reason, /store locked/);
  assert.doesNotMatch(out.stdout, /TOPSECRET/);
  assert.equal(events.length, 1);
});

test('close stops the relay and removes the socket', async (t) => {
  const dir = tempDir(t);
  const relay = await startHookRelay({ hooks: {}, format: 'gemini', dir });
  assert.equal(relay.env.CLAWSTRUM_HOOK_SOCKET, path.join(dir, 'hook.sock'));
  assert.ok(fs.existsSync(relay.env.CLAWSTRUM_HOOK_SOCKET!));
  await relay.close();
  assert.ok(!fs.existsSync(relay.env.CLAWSTRUM_HOOK_SOCKET!));
});

const PATCH = [
  '*** Begin Patch',
  '*** Add File: /w/new.txt',
  '+one',
  '+two',
  '*** Update File: /w/old.txt',
  '*** Move to: /w/renamed.txt',
  '@@',
  ' keep',
  '-gone',
  '+came',
  '*** Delete File: /w/dead.txt',
  '*** End Patch',
].join('\n');

test('applyPatchFiles lists every file a Codex patch touches with its added and removed text', () => {
  assert.deepEqual(applyPatchFiles(PATCH), [
    { path: '/w/new.txt', kind: 'add', added: 'one\ntwo', removed: '' },
    { path: '/w/old.txt', kind: 'update', added: 'came', removed: 'keep\ngone' },
    { path: '/w/renamed.txt', kind: 'add', added: '', removed: '' },
    { path: '/w/dead.txt', kind: 'delete', added: '', removed: '' },
  ]);
  assert.deepEqual(applyPatchFiles('not a patch'), []);
});

test('claudeHookInputs maps a Codex apply_patch to one Write or Edit per file and leaves other calls alone', () => {
  const payload = {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    cwd: '/w',
    tool_name: 'apply_patch',
    tool_input: { command: PATCH },
    tool_use_id: 'exec-1',
  };
  const inputs = claudeHookInputs('codex', payload) as any[];
  assert.deepEqual(
    inputs.map((i) => [i.tool_name, i.tool_input.file_path]),
    [
      ['Write', '/w/new.txt'],
      ['Edit', '/w/old.txt'],
      ['Write', '/w/renamed.txt'],
      ['Write', '/w/dead.txt'],
    ],
  );
  assert.equal(inputs[0].tool_input.content, 'one\ntwo');
  assert.deepEqual(inputs[1].tool_input, {
    file_path: '/w/old.txt',
    old_string: 'keep\ngone',
    new_string: 'came',
  });
  assert.ok(inputs.every((i) => i.hook_event_name === 'PreToolUse' && i.tool_use_id === 'exec-1'));
  // A patch with no file header, a shell call and a Gemini payload stay one input.
  assert.equal(claudeHookInputs('codex', { ...payload, tool_input: { command: 'x' } }).length, 1);
  const shell = claudeHookInputs('codex', {
    ...payload,
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  assert.deepEqual(
    shell.map((i: any) => i.tool_name),
    ['Bash'],
  );
  assert.deepEqual(claudeHookInputs('codex', { nothing: true }), []);
  assert.equal(
    claudeHookInputs('gemini', geminiPre('run_command', { CommandLine: 'ls' })).length,
    1,
  );
});

test('codex relay: an apply_patch is refused when any one of its files is refused', async (t) => {
  const dir = tempDir(t);
  const seen: string[] = [];
  const hooks: Options['hooks'] = {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            const i = input as any;
            seen.push(`${i.tool_name}:${i.tool_input.file_path}`);
            return i.tool_input.file_path === '/forbidden/b.txt'
              ? deny('b is outside the allowed roots')
              : {};
          },
        ],
      },
    ],
  };
  const relay = await startHookRelay({ hooks, format: 'codex', dir });
  t.after(() => relay.close());
  const patch = (...paths: string[]) => ({
    hook_event_name: 'PreToolUse',
    session_id: 's',
    cwd: '/w',
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        '*** Begin Patch',
        ...paths.flatMap((p) => [`*** Add File: ${p}`, '+x']),
        '*** End Patch',
      ].join('\n'),
    },
  });
  const refused = await runClient(
    'codex',
    patch('/w/a.txt', '/forbidden/b.txt', '/w/c.txt'),
    relay.env,
  );
  assert.deepEqual(JSON.parse(refused.stdout), deny('b is outside the allowed roots'));
  // The first refusal ends the check: c.txt was never looked at.
  assert.deepEqual(seen, ['Write:/w/a.txt', 'Write:/forbidden/b.txt']);
  seen.length = 0;
  const allowed = await runClient('codex', patch('/w/a.txt', '/w/c.txt'), relay.env);
  assert.equal(allowed.stdout, '');
  assert.deepEqual(seen, ['Write:/w/a.txt', 'Write:/w/c.txt']);
});
