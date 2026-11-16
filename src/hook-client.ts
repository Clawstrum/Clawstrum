// Started by a provider CLI (Antigravity CLI, Codex) for each tool call. Hands the hook payload to
// the run's relay (hook-relay.ts) and prints its answer. Imports only node: builtins to start fast.
import net from 'node:net';

const ANSWER_TIMEOUT_MS = 55_000;

const formatArg = process.argv[process.argv.indexOf('--format') + 1];
const format = formatArg === 'codex' ? 'codex' : 'gemini';

function finish(output: object | null): void {
  if (output === null) process.exit(0);
  process.stdout.write(JSON.stringify(output) + '\n', () => process.exit(0));
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (text += chunk));
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', () => resolve(text));
  });
}

function allow(): object | null {
  return format === 'gemini' ? { decision: 'allow' } : null;
}

const raw = await readStdin();
let payload: any;
try {
  payload = JSON.parse(raw);
} catch {
  payload = undefined;
}

function fallback(why: string): void {
  const event = format === 'gemini' ? payload?.hookEventName : payload?.hook_event_name;
  if (event !== 'PreToolUse') return finish(allow());
  const reason = `Clawstrum's tool check could not run (${why}). The call was not made. Tell the user instead of retrying it.`;
  finish(
    format === 'gemini'
      ? { decision: 'deny', reason }
      : {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        },
  );
}

const socketPath = process.env.CLAWSTRUM_HOOK_SOCKET;
if (!socketPath) {
  finish(allow());
} else {
  let buffer = '';
  let settled = false;
  const socket = net.createConnection(socketPath);
  const settle = (act: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    act();
  };
  const timer = setTimeout(
    () => settle(() => fallback(`no answer in ${ANSWER_TIMEOUT_MS / 1000} s`)),
    ANSWER_TIMEOUT_MS,
  );
  const reply = () => {
    const end = buffer.indexOf('\n');
    const line = end < 0 ? buffer : buffer.slice(0, end);
    let answer: any;
    try {
      answer = JSON.parse(line);
    } catch {
      return fallback('unreadable answer');
    }
    if (answer && typeof answer === 'object' && 'output' in answer && !('error' in answer))
      return finish(answer.output && typeof answer.output === 'object' ? answer.output : null);
    fallback(typeof answer?.error === 'string' ? answer.error.slice(0, 200) : 'unexpected answer');
  };
  socket.setEncoding('utf8');
  socket.on('connect', () =>
    socket.write(
      (payload !== undefined ? JSON.stringify(payload) : raw.replace(/\n/g, ' ')) + '\n',
    ),
  );
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.includes('\n')) settle(reply);
  });
  socket.on('end', () => settle(reply));
  socket.on('error', (error: NodeJS.ErrnoException) =>
    settle(() => fallback(`no connection to Clawstrum: ${error.code ?? error.message}`)),
  );
}
