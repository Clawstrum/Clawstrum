// A stand-in for `agy acp` (Antigravity CLI): JSON-RPC 2.0 lines on stdio. FAKE_ACP_SCENARIO picks the behavior.
// Every message received is appended to FAKE_ACP_LOG so a test can assert what the client sent.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import readline from 'node:readline';

if (process.argv.includes('--version')) {
  console.log('0.0.1');
  process.exit(0);
}
const scenario = process.env.FAKE_ACP_SCENARIO || 'text';
const log = process.env.FAKE_ACP_LOG;
const record = (entry) => log && fs.appendFileSync(log, JSON.stringify(entry) + '\n');
record({
  argv: process.argv.slice(2),
  env: {
    xdg: process.env.XDG_CONFIG_HOME,
    key: process.env.GEMINI_API_KEY ?? null,
    cloud: process.env.GOOGLE_CLOUD_PROJECT ?? null,
    hookSocket: process.env.CLAWSTRUM_HOOK_SOCKET ?? null,
  },
});
const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i < 0 ? undefined : process.argv[i + 1];
};
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = (sessionId, u) =>
  send({ method: 'session/update', params: { sessionId, update: u } });
const chunk = (sessionId, text) =>
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
let promptId;
let promptSession;

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  record({ received: m });
  if (m.method === undefined && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
    return;
  }
  if (m.method === 'initialize')
    return send({
      id: m.id,
      result: {
        protocolVersion: 1,
        authMethods: [
          { id: 'oauth-personal', name: 'Log in with Google' },
          { id: 'oauth-business', name: 'Log in with Gemini Enterprise' },
          { id: 'gemini-api-key', name: 'Gemini API key' },
          { id: 'agent-platform', name: 'Gemini Enterprise Agent Platform' },
        ],
        agentInfo: { name: 'Antigravity ACP Server', version: '0.0.1' },
        agentCapabilities: {
          loadSession: scenario !== 'noload' && scenario !== 'resume',
          sessionCapabilities: scenario === 'resume' ? { resume: {}, load: {} } : {},
          ...(process.env.FAKE_ACP_APPEND
            ? { _meta: { antigravity: { systemPrompt: { append: true } } } }
            : {}),
        },
      },
    });
  if (m.method === 'authenticate') {
    if (scenario === 'nologin')
      return send({
        id: m.id,
        error: {
          code: -32603,
          message:
            'No browser is available here (no graphical display is available to open a browser). Run `agy acp --login` in a terminal on this machine, then retry; or use a Gemini API key.',
        },
      });
    return send({ id: m.id, result: {} });
  }
  if (m.method === 'session/new') {
    if (scenario === 'authfail')
      return send({
        id: m.id,
        error: { code: -32000, message: 'Gemini API key is missing or not configured.' },
      });
    // agy writes the auth mode it runs under to the log named by --log-file.
    const logFile = argAfter('--log-file');
    if (logFile)
      fs.appendFileSync(
        logFile,
        scenario === 'apikeymode'
          ? 'I1112 server.go: Auth mode is AUTH_MODE_GEMINI_API_KEY\n'
          : 'I1112 server.go: Auth mode is AUTH_MODE_PERSONAL_CONSUMER\n',
      );
    return send({
      id: m.id,
      result: {
        sessionId: 'sess-new-1',
        modes: {
          currentModeId: 'default',
          availableModes: ['default', 'accept-edits', 'plan', 'auto'].map((id) => ({
            id,
            name: id,
          })),
        },
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'gemini-3.5-flash',
            options:
              scenario === 'nomodel'
                ? [{ value: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' }]
                : [
                    { value: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
                    { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
                  ],
          },
          {
            id: 'thought_level',
            name: 'Thinking Level',
            category: 'thought_level',
            type: 'select',
            currentValue: 'medium',
            options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })),
          },
        ],
      },
    });
  }
  if (m.method === 'session/set_config_option')
    return send({ id: m.id, result: { configOptions: [] } });
  if (m.method === 'session/resume') return send({ id: m.id, result: {} });
  if (m.method === 'session/load') {
    if (scenario === 'loadfail')
      return send({
        id: m.id,
        error: { code: -32602, message: `Session not found: ${m.params.sessionId}` },
      });
    // A real agent replays the old conversation as updates before it answers.
    chunk(m.params.sessionId, 'OLD HISTORY SHOULD NOT BE IN THE RESULT');
    return send({ id: m.id, result: {} });
  }
  if (m.method === 'session/set_mode') return send({ id: m.id, result: {} });
  if (m.method === 'session/cancel') {
    if (promptId !== undefined) send({ id: promptId, result: { stopReason: 'cancelled' } });
    return;
  }
  if (m.method !== 'session/prompt')
    return send({ id: m.id, error: { code: -32601, message: 'unknown' } });
  const runningId = promptId;
  promptId = m.id;
  const sid = m.params.sessionId;
  promptSession = sid;
  const usage = {
    inputTokens: 100,
    outputTokens: 20,
    cachedReadTokens: 40,
    thoughtTokens: 5,
    totalTokens: 120,
  };
  if (['text', 'noload', 'load', 'resume'].includes(scenario)) {
    chunk(sid, 'Hello ');
    chunk(sid, 'world');
    return send({ id: m.id, result: { stopReason: 'end_turn', usage } });
  }
  if (scenario === 'tool') {
    chunk(sid, 'Let me look.');
    update(sid, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'ls',
      kind: 'execute',
      status: 'pending',
    });
    const answer = await ask('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: 't1' },
      options: [
        { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
        { optionId: 'proceed_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ],
    });
    record({ permissionAnswer: answer.result });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    chunk(sid, 'Done: ');
    chunk(sid, `outcome=${answer.result.outcome.outcome}:${answer.result.outcome.optionId ?? ''}`);
    return send({ id: m.id, result: { stopReason: 'end_turn', usage } });
  }
  if (scenario === 'fs') {
    const file = process.env.FAKE_ACP_FILE;
    const w = await ask('fs/write_text_file', {
      sessionId: sid,
      path: file,
      content: 'from agent\nline2\nline3',
    });
    const r = await ask('fs/read_text_file', { sessionId: sid, path: file, line: 2, limit: 1 });
    record({ fsWrite: w.result ?? w.error, fsRead: r.result ?? r.error });
    chunk(sid, 'fs ok');
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (scenario === 'cancel') {
    chunk(sid, 'working...');
    return; // wait for session/cancel
  }
  if (scenario === 'hang') return;
  if (scenario === 'refusal') return send({ id: m.id, result: { stopReason: 'refusal' } });
  if (scenario === 'max_tokens') return send({ id: m.id, result: { stopReason: 'max_tokens' } });
  if (scenario === 'max_turn_requests')
    return send({ id: m.id, result: { stopReason: 'max_turn_requests' } });
  if (scenario === 'quota')
    return send({
      id: m.id,
      error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' },
    });
  if (scenario === 'overloaded')
    return send({ id: m.id, error: { code: 503, message: 'The model is overloaded.' } });
  if (scenario === 'toolbudget') {
    for (const id of ['a', 'b', 'c']) {
      update(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: id,
        kind: 'read',
        status: 'pending',
      });
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' });
    }
    return;
  }
  // Live input, as agy does it: a second prompt ends the running turn (end_turn, no text) and
  // starts a new one. steer_refused rejects the second prompt and lets the first turn finish.
  // agy echoes each prompt as a user_message_chunk when its turn starts.
  const echo = () =>
    update(sid, { sessionUpdate: 'user_message_chunk', content: m.params.prompt[0] });
  if (scenario === 'steer' || scenario === 'steer_refused') {
    if (runningId === undefined) {
      echo();
      chunk(sid, 'Let me run it.');
      update(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 's1',
        title: 'sleep',
        kind: 'execute',
      });
      return;
    }
    if (scenario === 'steer_refused') {
      promptId = runningId;
      send({ id: m.id, error: { code: -32600, message: 'A prompt is already running' } });
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 's1', status: 'completed' });
      chunk(sid, 'First answer');
      return send({ id: runningId, result: { stopReason: 'end_turn', usage } });
    }
    // The cut turn can still stream a little before it ends.
    chunk(sid, 'tail of the cut turn');
    send({ id: runningId, result: { stopReason: 'end_turn', usage } });
    echo();
    chunk(sid, 'Steered answer');
    return send({ id: m.id, result: { stopReason: 'end_turn', usage } });
  }
  // A shell command outlives the turn that started it (agy moved it to the background).
  if (scenario === 'background') {
    echo();
    if (runningId === undefined) {
      update(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 'bg1',
        title: 'sleep 99; echo done',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'sleep 99; echo done' },
      });
      chunk(sid, 'It runs in the background, I will report when it finishes.');
      return send({ id: m.id, result: { stopReason: 'end_turn', usage } });
    }
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'bg1', status: 'completed' });
    if (!process.env.FAKE_ACP_SILENT) chunk(sid, 'It printed done.');
    return send({ id: m.id, result: { stopReason: 'end_turn', usage } });
  }
  // Runs the PreToolUse command from <gemini-dir>/config/hooks.json the way agy does: through a
  // shell, in the hook file's folder, with the payload on stdin. Replies with what it printed.
  if (scenario === 'hook') {
    const dir = path.join(argAfter('--gemini-dir'), 'config');
    const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
    const payload = {
      hookEventName: 'PreToolUse',
      conversationId: sid,
      cwd: process.cwd(),
      toolCall: { id: 'call_1', name: 'run_command', args: { CommandLine: 'cat .env' } },
      workspacePaths: [process.cwd()],
    };
    const out = execSync(hooks.clawstrum.PreToolUse[0].hooks[0].command, {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: 'utf8',
    });
    chunk(sid, out.trim());
    return send({ id: m.id, result: { stopReason: 'end_turn', usage } });
  }
  if (scenario === 'crash') process.exit(3);
});
process.on('SIGTERM', () => process.exit(0));
void promptSession;
