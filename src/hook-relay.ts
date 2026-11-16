import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type {
  HookCallbackMatcher,
  HookInput,
  Options,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
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
 * input per file. Anything else is the single input claudeHookInput returns. */
export function claudeHookInputs(format: HookFormat, payload: any): HookInput[] {
  const base = claudeHookInput(format, payload);
  if (!base) return [];
  const patch = (payload as { tool_input?: { command?: unknown } }).tool_input?.command;
  if (
    format !== 'codex' ||
    base.hook_event_name !== 'PreToolUse' ||
    payload.tool_name !== 'apply_patch' ||
    typeof patch !== 'string'
  )
    return [base];
  const files = applyPatchFiles(patch);
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

/** What the CLI's hook command prints, or null for nothing. Both CLIs take refusals only: Gemini
 * drops the rest of the result, and Codex rejects any allow, so it gets output only for a deny. */
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
  if (!deny) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
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
    // The first refusal ends the call; otherwise the answer is the last input's.
    for (const input of inputs) {
      const toolUseId = (input as { tool_use_id?: string }).tool_use_id;
      const result = await Promise.race([
        runHooks(hooks, input, toolUseId, controller.signal),
        timedOut,
      ]);
      output = relayOutput(format, input, result);
      const specific = result.hookSpecificOutput as { permissionDecision?: string } | undefined;
      if (specific?.permissionDecision === 'deny') break;
    }
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
