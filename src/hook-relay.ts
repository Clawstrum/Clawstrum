import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type {
  HookCallbackMatcher,
  HookInput,
  Options,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { commandArgvs } from './research/shell.js';
import type { ProviderEvent } from './types.js';

/**
 * Runs Clawstrum's Claude hook callbacks for providers whose CLI calls a hook command of its own
 * (Antigravity CLI's hooks.json, later Codex). The CLI starts dist/hook-client.js per tool call; the
 * client hands the payload to this relay over a Unix socket and prints the answer for the CLI.
 * Protocol: the client writes one JSON line, the relay answers one JSON line and closes.
 */
export type HookFormat = 'gemini' | 'codex';

const HOOK_TIMEOUT_MS = 50_000;

/** Map an Antigravity CLI tool call onto the Claude tool names and keys the research hooks read.
 * The original keys stay next to the mapped ones. */
export function geminiToolCall(
  name: string,
  args: unknown,
): { tool_name: string; tool_input: Record<string, unknown> } {
  const input: Record<string, any> =
    args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  switch (name) {
    case 'run_command':
      return { tool_name: 'Bash', tool_input: { ...input, command: input.CommandLine } };
    case 'read_file':
    case 'view_file':
      return { tool_name: 'Read', tool_input: { ...input, file_path: input.Path } };
    case 'write_file':
      // With Append, content is only the appended text, so the memory-budget check under-counts it.
      return {
        tool_name: 'Write',
        tool_input: { ...input, file_path: input.Path, content: input.Content },
      };
    case 'edit_file':
      return {
        tool_name: 'Edit',
        tool_input: {
          ...input,
          file_path: input.Path,
          old_string: input.Target,
          new_string: input.Replacement,
        },
      };
    case 'invoke_subagent':
    case 'define_subagent':
      return {
        tool_name: 'Agent',
        tool_input: {
          ...input,
          subagent_type: input.TypeName ?? input.Name,
          description: input.Role ?? input.Description,
          prompt: input.Prompt ?? input.SystemPrompt,
        },
      };
    case 'run_workflow':
      return { tool_name: 'Workflow', tool_input: { ...input, script: input.Script } };
    case 'swarm':
      return { tool_name: 'Workflow', tool_input: { ...input, script: JSON.stringify(input) } };
    default:
      return { tool_name: name, tool_input: input };
  }
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/** Commands that read the files named on their command line. `pattern` commands take a pattern or
 * script as their first operand unless -e or -f gave one. `values` are the options that take a value. */
const READERS: Record<string, { pattern: boolean; values: string[] }> = {
  cat: { pattern: false, values: [] },
  nl: { pattern: false, values: ['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w'] },
  head: { pattern: false, values: ['-n', '-c', '--lines', '--bytes'] },
  tail: { pattern: false, values: ['-n', '-c', '--lines', '--bytes'] },
  less: { pattern: false, values: ['-p', '-P', '-x', '-z', '-h', '-j', '-b'] },
  more: { pattern: false, values: ['-n', '-p'] },
  bat: { pattern: false, values: ['-l', '-r', '-m', '-H', '--language', '--line-range'] },
  sed: { pattern: true, values: ['-e', '-f', '-l', '--expression', '--file'] },
  grep: {
    pattern: true,
    values: ['-e', '-f', '-m', '-A', '-B', '-C', '--regexp', '--file', '--max-count'],
  },
  rg: { pattern: true, values: ['-e', '-f', '-m', '-A', '-B', '-C', '-g', '-t', '-T', '--glob'] },
};
READERS.egrep = READERS.fgrep = READERS.grep!;
READERS.batcat = READERS.bat!;

/**
 * The files a shell command reads with cat, head, tail, less, more, nl, bat, sed or grep (and
 * rg), as absolute paths. Conservative on purpose: it follows `cd DIR` and `bash -c '...'` inside
 * the one command, skips any word with a variable, command substitution or glob, and does not
 * count `sed -i` (an edit). Anything it cannot read with certainty is left out, so a miss costs the
 * agent one more read and a wrong guess never counts as a read that did not happen.
 */
export function shellReadFiles(command: unknown, cwd: string, depth = 0): string[] {
  if (typeof command !== 'string') return [];
  const found: string[] = [];
  let dir = cwd;
  const literal = (word: string): string | undefined => {
    if (/[$`*?[\]{}()<>|&;!\\]/.test(word) || word === '-' || word === '') return undefined;
    if (word === '~' || word.startsWith('~/'))
      return path.resolve(dir, path.join(os.homedir(), word.slice(1)));
    if (word.startsWith('~')) return undefined;
    return path.resolve(dir, word);
  };
  for (const words of commandArgvs(command)) {
    const head = words[0]!.split('/').pop()!;
    const args = words.slice(1);
    if (head === 'cd') {
      const target = args.find((a) => !a.startsWith('-'));
      const next = target === undefined ? undefined : literal(target);
      if (next) dir = next;
      continue;
    }
    if (SHELLS.has(head)) {
      const at = args.findIndex((a) => /^-[a-z]*c$/.test(a));
      if (depth < 2 && at >= 0 && args[at + 1])
        found.push(...shellReadFiles(args[at + 1], dir, depth + 1));
      continue;
    }
    const spec = READERS[head];
    if (!spec) continue;
    const operands: string[] = [];
    let patternGiven = false;
    let edits = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--') {
        operands.push(...args.slice(i + 1));
        break;
      }
      if (!arg.startsWith('-') || arg === '-') {
        operands.push(arg);
        continue;
      }
      if (head === 'sed' && (/^-[A-Za-z]*i/.test(arg) || arg.startsWith('--in-place')))
        edits = true;
      const name = arg.startsWith('--') ? arg.split('=')[0]! : arg.slice(0, 2);
      if (spec.values.includes(name)) {
        // -e/-f give the pattern or script themselves, attached (-ePATTERN, --regexp=P) or as the next word.
        if (
          name === '-e' ||
          name === '-f' ||
          name === '--regexp' ||
          name === '--file' ||
          name === '--expression'
        )
          patternGiven = true;
        const attached = arg.startsWith('--') ? arg.includes('=') : arg.length > 2;
        if (!attached) i++;
      }
    }
    if (edits) continue;
    if (spec.pattern && !patternGiven) operands.shift();
    for (const operand of operands) {
      const file = literal(operand);
      if (file) found.push(file);
    }
  }
  return [...new Set(found)];
}

/** A Codex apply_patch response starts `Exit code: N`; a patch that did not apply must not count as an edit. */
function patchFailed(response: unknown): boolean {
  return typeof response === 'string' && /^Exit code: (?!0\b)/.test(response);
}

/** A file a finished shell command read. Codex's shell response is only the command's output, with
 * no exit code, so a path that is not a readable file now (a read that failed) does not count. */
function isReadableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The Claude hook input for a CLI's hook payload, or undefined when no hook applies to it. */
export function claudeHookInput(format: HookFormat, payload: any): HookInput | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  if (format === 'codex') {
    if (typeof payload.hook_event_name !== 'string') return undefined;
    return {
      ...payload,
      cwd: payload.cwd ?? process.cwd(),
      session_id: payload.session_id ?? '',
    } as HookInput;
  }
  const call = payload.toolCall;
  if (!call || typeof call !== 'object') return undefined;
  const base = {
    session_id: payload.conversationId ?? '',
    transcript_path: payload.transcriptPath ?? '',
    cwd: payload.cwd ?? payload.workspacePaths?.[0] ?? process.cwd(),
    ...geminiToolCall(String(call.name ?? ''), call.args),
    tool_use_id: call.id,
  };
  if (payload.hookEventName === 'PreToolUse') return { ...base, hook_event_name: 'PreToolUse' };
  if (payload.hookEventName !== 'PostToolUse') return undefined;
  return payload.error
    ? { ...base, hook_event_name: 'PostToolUseFailure', error: String(payload.error) }
    : { ...base, hook_event_name: 'PostToolUse', tool_response: '' };
}

/** The files a Codex apply_patch patch touches. `added` is the text it adds, `removed` the text it
 * replaces (update only). A rename also lists the new path, with nothing added. */
export function applyPatchFiles(
  patch: string,
): Array<{ path: string; kind: 'add' | 'update' | 'delete'; added: string; removed: string }> {
  const files: Array<{
    path: string;
    kind: 'add' | 'update' | 'delete';
    added: string[];
    removed: string[];
  }> = [];
  let current: (typeof files)[number] | undefined;
  for (const line of patch.split('\n')) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (header) {
      current = {
        path: header[2]!,
        kind: header[1]!.toLowerCase() as 'add' | 'update' | 'delete',
        added: [],
        removed: [],
      };
      files.push(current);
    } else if (move) {
      // The hunks that follow still belong to the file being updated.
      files.push({ path: move[1]!, kind: 'add', added: [], removed: [] });
    } else if (current && line.startsWith('+')) current.added.push(line.slice(1));
    else if (current && current.kind === 'update' && (line.startsWith('-') || line.startsWith(' ')))
      current.removed.push(line.slice(1));
  }
  return files.map((f) => ({
    ...f,
    added: f.added.join('\n'),
    removed: f.removed.join('\n'),
  }));
}

/** Every Claude hook input a CLI hook payload stands for. A Codex apply_patch edits several files
 * at once, and the research checks look at one path per Write or Edit call, so it becomes one
 * input per file (before the call and after it). A Codex shell command that has finished and read
 * files becomes its own PostToolUse plus one Read PostToolUse per file: the writing gate and the
 * file holds know only Read, and Codex reads files through the shell. Anything else is the single
 * input claudeHookInput returns. */
export function claudeHookInputs(format: HookFormat, payload: any): HookInput[] {
  const base = claudeHookInput(format, payload);
  if (!base) return [];
  if (format !== 'codex') return [base];
  const event = base.hook_event_name;
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return [base];
  const toolInput = (payload as { tool_input?: { command?: unknown } }).tool_input;
  if (payload.tool_name === 'apply_patch' && typeof toolInput?.command === 'string') {
    if (event === 'PostToolUse' && patchFailed(payload.tool_response)) return [base];
    const files = applyPatchFiles(toolInput.command);
    if (!files.length) return [base];
    return files.map(
      (file) =>
        ({
          ...base,
          tool_name: file.kind === 'update' ? 'Edit' : 'Write',
          tool_input:
            file.kind === 'update'
              ? { file_path: file.path, old_string: file.removed, new_string: file.added }
              : { file_path: file.path, content: file.added },
        }) as HookInput,
    );
  }
  if (event === 'PostToolUse' && payload.tool_name === 'Bash') {
    const reads = shellReadFiles(toolInput?.command, base.cwd).filter(isReadableFile);
    return [
      base,
      ...reads.map(
        (file) => ({ ...base, tool_name: 'Read', tool_input: { file_path: file } }) as HookInput,
      ),
    ];
  }
  return [base];
}

// As in Claude Code: a plain name matches only that tool, `Edit|Write` either of them.
function applies(matcher: HookCallbackMatcher, toolName: string): boolean {
  if (!matcher.matcher || matcher.matcher === '*') return true;
  return new RegExp(`^(?:${matcher.matcher})$`).test(toolName);
}

/** The SDK's semantics: matching callbacks in order, the first deny wins at once, other results
 * merge as mergeHooks does. */
export async function runHooks(
  hooks: Options['hooks'],
  input: HookInput,
  toolUseId: string | undefined,
  signal: AbortSignal,
): Promise<SyncHookJSONOutput> {
  const toolName = String((input as { tool_name?: unknown }).tool_name ?? '');
  let result: any = {};
  for (const matcher of hooks?.[input.hook_event_name] ?? []) {
    if (!applies(matcher, toolName)) continue;
    for (const invoke of matcher.hooks) {
      const next = await invoke(input, toolUseId, { signal });
      if ('async' in next && next.async) continue;
      const specific = (next as SyncHookJSONOutput).hookSpecificOutput as any;
      if (specific?.permissionDecision === 'deny') return next as SyncHookJSONOutput;
      const context = [result.hookSpecificOutput?.additionalContext, specific?.additionalContext]
        .filter(Boolean)
        .join('\n\n');
      result = {
        ...result,
        ...next,
        hookSpecificOutput: { ...result.hookSpecificOutput, ...specific },
      };
      if (context) result.hookSpecificOutput.additionalContext = context;
      if (!Object.keys(result.hookSpecificOutput).length) delete result.hookSpecificOutput;
    }
  }
  return result;
}

function allowForm(format: HookFormat): object | null {
  return format === 'gemini' ? { decision: 'allow' } : null;
}

/** The advisory text a check attached to its result, if any. */
function advice(result: SyncHookJSONOutput): string | undefined {
  const text = (result.hookSpecificOutput as { additionalContext?: unknown } | undefined)
    ?.additionalContext;
  return typeof text === 'string' && text ? text : undefined;
}

/** What the CLI's hook command prints, or null for nothing. Gemini takes refusals only: it drops the
 * rest of the result. Codex takes a refusal, or advice as `additionalContext` with no decision (it
 * rejects any allow, ask or rewrite), so a warning reaches the model and the call goes on. */
export function relayOutput(
  format: HookFormat,
  input: HookInput,
  result: SyncHookJSONOutput,
): object | null {
  const specific = result.hookSpecificOutput as
    | { permissionDecision?: string; permissionDecisionReason?: string }
    | undefined;
  const deny = input.hook_event_name === 'PreToolUse' && specific?.permissionDecision === 'deny';
  const reason = specific?.permissionDecisionReason || 'Refused by a Clawstrum check.';
  if (format === 'gemini') return deny ? { decision: 'deny', reason } : { decision: 'allow' };
  if (deny)
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  const additionalContext = advice(result);
  if (!additionalContext || !['PreToolUse', 'PostToolUse'].includes(input.hook_event_name))
    return null;
  return { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext } };
}

/** The socket reply: {output} for the client to print (null: print nothing), or {error}. */
async function answer(
  hooks: Options['hooks'],
  format: HookFormat,
  line: string,
  onEvent?: (event: ProviderEvent) => void,
): Promise<{ output: object | null } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`tool check timed out after ${HOOK_TIMEOUT_MS / 1000} s`)),
    HOOK_TIMEOUT_MS,
  );
  try {
    const inputs = claudeHookInputs(format, JSON.parse(line));
    if (!inputs.length) return { output: allowForm(format) };
    const timedOut = new Promise<never>((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      }),
    );
    let output: object | null = allowForm(format);
    const advisories: string[] = [];
    // The first refusal ends the call. Otherwise Gemini gets the last input's answer, and Codex gets
    // every different advisory text the checks returned, joined (one call can stand for several inputs).
    for (const input of inputs) {
      const toolUseId = (input as { tool_use_id?: string }).tool_use_id;
      const result = await Promise.race([
        runHooks(hooks, input, toolUseId, controller.signal),
        timedOut,
      ]);
      output = relayOutput(format, input, result);
      const specific = result.hookSpecificOutput as { permissionDecision?: string } | undefined;
      if (specific?.permissionDecision === 'deny') return { output };
      const text = advice(result);
      if (text && !advisories.includes(text)) advisories.push(text);
    }
    if (format === 'codex')
      output = advisories.length
        ? {
            hookSpecificOutput: {
              hookEventName: inputs[0]!.hook_event_name,
              additionalContext: advisories.join('\n\n'),
            },
          }
        : null;
    return { output };
  } catch (error) {
    // Only the message: the tool input can hold secrets.
    const message = error instanceof Error ? error.message : String(error);
    onEvent?.({ type: 'diagnostic', detail: { event: 'hook_relay_failed', error: message } });
    return { error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** `dir` is a private (0700) directory the caller owns; the socket is created inside it. */
export async function startHookRelay({
  hooks,
  format,
  dir,
  onEvent,
}: {
  hooks: Options['hooks'];
  format: HookFormat;
  dir: string;
  onEvent?: (event: ProviderEvent) => void;
}): Promise<{ env: Record<string, string>; close(): Promise<void> }> {
  const socketPath = path.join(dir, 'hook.sock');
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    let buffer = '';
    let done = false;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk: string) => {
      if (done) return;
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      done = true;
      void answer(hooks, format, buffer.slice(0, end), onEvent).then((out) =>
        socket.end(JSON.stringify(out) + '\n'),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    env: { CLAWSTRUM_HOOK_SOCKET: socketPath },
    async close() {
      // server.close waits for open connections; a hook still running would hold the run's end.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of open) socket.destroy();
      await closed;
      fs.rmSync(socketPath, { force: true });
    },
  };
}
