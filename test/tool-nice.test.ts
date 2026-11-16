import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture } from './helpers.js';
import { researchHooks, alreadyNiced, nicedCommand } from '../src/research/hooks.js';
import type { ProviderRequest } from '../src/types.js';

function enabled(t: any, overrides: Record<string, unknown> = {}) {
  const f = fixture(t);
  f.config.research.enabled = true;
  f.config.research.validation = 'strict';
  Object.assign(f.config.research, overrides);
  return f;
}

let invocation = 0;
async function invokePreTool(
  f: ReturnType<typeof fixture>,
  toolName: string,
  toolInput: Record<string, unknown>,
  agentId?: string,
) {
  f.enqueue(`tool-nice-${invocation++}`);
  const run = f.store.claim(f.session.id)!.run;
  // Hooks only need a run id to wire into the MCP env; finish it immediately so a fixture reused
  // across several calls in one test can claim its next run.
  f.store.exec("UPDATE runs SET status='done', ended_at=? WHERE id=?", Date.now(), run.id);
  const request: ProviderRequest = {
    account: f.config.accounts[0]!,
    cwd: f.session.workspace,
    prompt: '',
    instructions: '',
    controller: new AbortController(),
    env: {},
    research: f.config.research,
    mcp: {
      command: 'node',
      args: [],
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id, CLAWSTRUM_RUN: run.id },
    },
    onEvent() {},
  };
  const hooks = researchHooks(request);
  try {
    return (await hooks.hooks!.PreToolUse![0]!.hooks[0]!(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sdk',
        transcript_path: '',
        cwd: f.session.workspace,
        tool_use_id: 't',
        tool_name: toolName,
        tool_input: toolInput,
        ...(agentId ? { agent_id: agentId } : {}),
      },
      undefined,
      { signal: request.controller.signal },
    )) as any;
  } finally {
    hooks.close();
  }
}

test('a plain Bash command gets a renice prefix, lead and subagent alike, text otherwise unchanged', async (t) => {
  const f = enabled(t, { validation: 'off' });
  const command = 'ls -la\necho done';
  for (const agentId of [undefined, 'worker']) {
    const result = await invokePreTool(f, 'Bash', { command }, agentId);
    const out = result.hookSpecificOutput;
    assert.equal(out.permissionDecision, 'allow');
    assert.equal(out.updatedInput.command, `renice -n 15 -p $$ >/dev/null 2>&1; ${command}`);
  }
});

test('a heredoc or multi-line command keeps its exact text after the prefix', async (t) => {
  const f = enabled(t, { validation: 'off' });
  const command = "python3 <<'EOF'\nprint('a; b')\nEOF\n";
  const result = await invokePreTool(f, 'Bash', { command });
  assert.equal(
    result.hookSpecificOutput.updatedInput.command,
    `renice -n 15 -p $$ >/dev/null 2>&1; ${command}`,
  );
});

test('toolNice 0 disables the prefix entirely', async (t) => {
  const f = enabled(t, { validation: 'off', toolNice: 0 });
  const command = 'ls -la';
  const result = await invokePreTool(f, 'Bash', { command });
  assert.equal(result.hookSpecificOutput ?? undefined, undefined);
});

test('a command that already renices itself is not prefixed a second time', async (t) => {
  const f = enabled(t, { validation: 'off' });
  for (const command of ['renice -n 10 -p $$; ls', '  nice -n 5 ls', 'nice ls'])
    assert.equal(nicedCommand(command, 15), undefined, command);
  assert.equal(alreadyNiced('renice -n 1 -p $$'), true);
  assert.equal(alreadyNiced('nice ls'), true);
  assert.equal(alreadyNiced('reniceless ls'), false);
  assert.equal(alreadyNiced('ls'), false);
  const result = await invokePreTool(f, 'Bash', { command: 'renice -n 10 -p $$; ls' });
  assert.equal(result.hookSpecificOutput ?? undefined, undefined);
});

test('the prefix is never added to a non-Bash tool', async (t) => {
  const f = enabled(t, { validation: 'off' });
  const file = path.join(f.session.workspace, 'notes.md');
  const result = await invokePreTool(f, 'Write', { file_path: file, content: 'hello' });
  assert.equal(result.hookSpecificOutput ?? undefined, undefined);
});

test('a secret-print deny still denies and carries no updatedInput', async (t) => {
  const f = enabled(t);
  const result = await invokePreTool(f, 'Bash', { command: 'cat ~/.bashrc' });
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(result.hookSpecificOutput.updatedInput, undefined);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /secrets/);
});

test('a raw sbatch submission under strict validation still denies and carries no updatedInput', async (t) => {
  const f = enabled(t);
  const result = await invokePreTool(f, 'Bash', { command: 'sbatch run.sh' });
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(result.hookSpecificOutput.updatedInput, undefined);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /research_cluster/);
});

test('a Bash command allowed with advisory context still gets niced, keeping both outputs', async (t) => {
  const f = enabled(t, { validation: 'advisory' });
  const result = await invokePreTool(f, 'Bash', { command: 'sbatch run.sh' });
  const out = result.hookSpecificOutput;
  assert.equal(out.permissionDecision, 'allow');
  assert.equal(out.updatedInput.command, 'renice -n 15 -p $$ >/dev/null 2>&1; sbatch run.sh');
  assert.match(out.additionalContext, /research_cluster/);
});
