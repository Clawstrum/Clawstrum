import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ProviderFailure, classifyError } from './accounts.js';
import { ContextRefresh, REFRESH_PROTOCOL } from './instructions.js';
import { packageRoot } from './apply.js';
import { startHookRelay } from './hook-relay.js';
import { researchHooks } from './research/hooks.js';
import { runtimeCommand } from './runtime.js';
import type { Account, Provider, ProviderRequest } from './types.js';
import { geminiTurnUsage } from './usage.js';
import { basePrompt, usesBasePrompt } from './base-prompt.js';

/**
 * Antigravity CLI (`agy acp`) over the Agent Client Protocol (ACP): JSON-RPC 2.0, one JSON object
 * per line on the child's stdin/stdout. The CLI is the agent; Clawstrum is the client. The provider
 * keeps the name `gemini`. Google moved Gemini subscription use (and Gemini 4 Argon) from Gemini
 * CLI to Antigravity CLI. This file is a small client of its own (no ACP package) in the same
 * shape as CodexConnection in codex-app-server.ts.
 *
 * Billing rule: only the Google sign-in (`oauth-personal`, a subscription) is ever used. Clawstrum
 * never sends an API key, never calls `authenticate` with any other method, and refuses a run when
 * the account's state or the agent's own log shows another auth mode.
 */

type RpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message?: string; data?: unknown };
};
export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Default model: Gemini 4 Argon. Selected over ACP after the session exists (agy acp has no --model). */
export const GEMINI_DEFAULT_MODEL = 'gemini-4-argon';

/**
 * The account home plays the role of $HOME for agy: it keeps its state in `<home>/.gemini` (set with
 * --gemini-dir) and plugin secrets under `<home>/.config` (XDG_CONFIG_HOME). The real $HOME is untouched.
 */
export function geminiStateDir(account: { home: string }): string {
  return path.join(account.home, '.gemini');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command agy runs before and after each tool call; it hands the call to the run's hook relay. */
export function geminiHookCommand(root = packageRoot()): string {
  return `${shellQuote(process.execPath)} ${shellQuote(path.join(root, 'dist', 'hook-client.js'))} --format gemini`;
}

/** Writes the "clawstrum" group into agy's hook file, <gemini-dir>/config/hooks.json, and leaves
 * every other group as it is. Without CLAWSTRUM_HOOK_SOCKET the hook command allows every call. */
export function ensureGeminiHooks(account: { home: string }, command: string): void {
  const dir = path.join(geminiStateDir(account), 'config');
  const file = path.join(dir, 'hooks.json');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let current: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      current = parsed as Record<string, unknown>;
    else fs.renameSync(file, `${file}.invalid-${Date.now()}`);
  }
  const hook = [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 60 }] }];
  const group = { PreToolUse: hook, PostToolUse: hook };
  if (JSON.stringify(current.clawstrum) === JSON.stringify(group)) return;
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...current, clawstrum: group }, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.renameSync(temp, file);
}

/** Auth methods that bill per token or run on an enterprise or cloud account. Never acceptable. */
const NON_SUBSCRIPTION_AUTH =
  /api[_-]?key|agent[_-]?platform|vertex|oauth[_-]?business|enterprise|gateway|paygo|business/i;

/**
 * Detect an auth mode that is not the Google sign-in. `text` is a settings file or agy's log.
 * Returns a reason, or undefined when nothing shows another auth mode.
 */
export function nonSubscriptionAuth(text: string): string | undefined {
  for (const m of text.matchAll(
    /"(?:selectedType|authType|auth_type|authMethod|auth_mode)"\s*:\s*"([^"]+)"/gi,
  ))
    if (NON_SUBSCRIPTION_AUTH.test(m[1]!)) return m[1];
  // agy's own log line, for example "Auth mode is unspecified".
  for (const m of text.matchAll(/auth(?:entication)? mode (?:is|=|:)\s*"?([A-Za-z_-]+)/gi))
    if (NON_SUBSCRIPTION_AUTH.test(m[1]!)) return m[1];
  return undefined;
}

/** Pre-flight on the account's settings files. Cheap, local, and run before agy is started. */
export function geminiStateAuthProblem(account: { home: string }): string | undefined {
  const dir = geminiStateDir(account);
  // Only agy's own settings file. <home>/.gemini/settings.json belongs to the old Gemini CLI and may say gemini-api-key.
  for (const file of [path.join(dir, 'antigravity-cli', 'settings.json')]) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const reason = nonSubscriptionAuth(text);
    if (reason) return `${file} selects auth mode ${reason}`;
  }
  return undefined;
}

/** Environment variables that select API-key, cloud or gateway auth. Removed for every Gemini run. */
export const geminiForbiddenEnv = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_BASE_URL',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_GENAI_USE_ENTERPRISE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
  'AGY_ADC_AUTH',
  'AGY_LLM_GATEWAY_URL',
  'AGY_LLM_GATEWAY_PROXY_URL',
  'AGY_LLM_GATEWAY_CLIENT_KEY',
  'AGY_LLM_GATEWAY_CLIENT_CERT',
  'AGY_LLM_GATEWAY_MODELS',
];

/** Arguments that put every agy file in the account home. `--login` is the browserless sign-in. */
export function geminiArgs(account: { home: string }, extra: string[] = []): string[] {
  return ['acp', '--gemini-dir', geminiStateDir(account), '--disable-telemetry', ...extra];
}

/** Environment agy needs beyond the account environment. Never contains a credential. */
export function geminiLaunchEnv(
  env: Record<string, string>,
  account: { home: string },
): Record<string, string> {
  const clean = { ...env };
  for (const key of geminiForbiddenEnv) delete clean[key];
  return {
    ...clean,
    // Plugin secrets and any file-based token go here, not in the real home. A cluster node has no keyring.
    XDG_CONFIG_HOME: path.join(account.home, '.config'),
  };
}

/** Map a JSON-RPC error from the agent to a failure kind. The CLI uses an HTTP status as the code. */
export function acpFailure(error: AcpRpcError): ProviderFailure {
  const { code, message } = error;
  if (code === 429) return new ProviderFailure('quota', message);
  if (code === 401 || code === 403) return new ProviderFailure('auth', message);
  if (code === 404 && /session/i.test(message)) return new ProviderFailure('session', message);
  if (code >= 500 && code < 600) return new ProviderFailure('transient', message);
  if (
    /authentication required|api key is missing|not (logged in|authenticated)|no browser is available|agy acp --login/i.test(
      message,
    )
  )
    return new ProviderFailure('auth', message);
  if (code === -32602 && /session not found/i.test(message))
    return new ProviderFailure('session', message);
  return classifyError(message);
}

/** One local stdio connection. The agent may also send requests to us (permission, file access). */
export class AcpConnection {
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private closed = false;
  private failureReason?: unknown;
  private pending = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: unknown) => void; timer?: NodeJS.Timeout }
  >();
  private readonly exited: Promise<void>;
  constructor(
    spawnSpec: { command: string; args: string[]; cwd: string; env: Record<string, string> },
    handlers: {
      notification: (method: string, params: any) => void;
      request: (method: string, params: any) => Promise<unknown>;
      stderr: (text: string) => void;
      failure: (error: unknown) => void;
    },
  ) {
    this.child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: spawnSpec.cwd,
      env: spawnSpec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const fail = (error: unknown) => {
      if (this.closed) return;
      this.cancelPending(error);
      handlers.failure(error);
    };
    this.exited = new Promise((resolve) => {
      this.child.once('close', () => {
        fail(
          new ProviderFailure('transient', 'Antigravity CLI exited before completing the request'),
        );
        resolve();
      });
    });
    this.child.on('error', fail);
    this.child.stdin.on('error', fail);
    this.child.stderr.on('data', (data: Buffer) => {
      if (!this.closed) handlers.stderr(data.toString().slice(-4000));
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      if (this.closed || !line.trim()) return;
      let message: RpcMessage;
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== 'object') throw new Error('Expected a JSON-RPC object');
      } catch {
        // The CLI can print a stray non-JSON line before the protocol starts; ignore it.
        return;
      }
      if (message.method) {
        if (message.id !== undefined) {
          const id = message.id;
          handlers.request(message.method, message.params).then(
            (result) => this.write({ id, result: result ?? null }),
            (error) =>
              this.write({
                id,
                error: {
                  code: error instanceof AcpRpcError ? error.code : -32603,
                  message: error instanceof Error ? error.message : String(error),
                },
              }),
          );
        } else handlers.notification(message.method, message.params);
        return;
      }
      const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!pending) return;
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new AcpRpcError(message.error.code, message.error.message ?? 'Gemini ACP request failed'),
        );
      else pending.resolve(message.result);
    });
  }
  cancelPending(error: unknown): void {
    this.failureReason = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  private write(message: RpcMessage): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    } catch {
      // A broken pipe is reported by the stdin error handler.
    }
  }
  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }
  /** `timeoutMs` 0 means no timeout (a prompt runs as long as the agent works). */
  request(method: string, params: unknown, timeoutMs = 60000): Promise<any> {
    if (this.failureReason) return Promise.reject(this.failureReason);
    if (this.closed)
      return Promise.reject(new ProviderFailure('transient', 'Gemini connection is closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new ProviderFailure('transient', `Gemini ${method} timed out`));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ProviderFailure('transient', 'Gemini connection closed'));
    }
    this.pending.clear();
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 2000);
      }),
    ]);
    clearTimeout(kill);
    clearTimeout(deadline);
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}

/** ACP stdio MCP server entries (env is a list of name/value pairs): the owner's, then Clawstrum's. */
export function acpMcpServers(
  mcp: ProviderRequest['mcp'],
  toolless?: boolean,
  extra: ProviderRequest['extraMcp'] = {},
) {
  if (toolless) return [];
  const entry = (name: string, server: ProviderRequest['mcp']) => ({
    name,
    command: server.command,
    args: server.args,
    env: Object.entries(server.env).map(([key, value]) => ({ name: key, value })),
  });
  return [
    ...Object.entries(extra ?? {}).map(([name, server]) => entry(name, server)),
    entry('clawstrum', mcp),
  ];
}

/**
 * agy's thinking level for the account's effort: low and medium as named, anything higher takes
 * the highest level offered. Undefined when there is no effort, no such option, or nothing to change.
 */
export function pickThoughtLevel(
  configOptions: any[] | undefined,
  effort: Account['effort'],
): { configId: string; value: string } | undefined {
  if (!effort) return undefined;
  const option = (configOptions ?? []).find(
    (o: any) => o?.category === 'thought_level' || o?.id === 'thought_level',
  );
  const values: string[] = (option?.options ?? [])
    .flatMap((o: any) => o?.options ?? [o])
    .map((o: any) => String(o?.value));
  if (!option || !values.length) return undefined;
  const value = values.includes(effort)
    ? effort
    : effort === 'low' || effort === 'medium'
      ? undefined
      : values.includes('high')
        ? 'high'
        : values[values.length - 1];
  if (!value || value === option.currentValue) return undefined;
  return { configId: String(option.id), value };
}

/** Pick the permission option to answer with. Never throws: an unusable list cancels. */
export function permissionOutcome(options: any[] | undefined, allow: boolean) {
  const list = Array.isArray(options) ? options : [];
  const pick = allow
    ? (list.find((o) => o?.kind === 'allow_once') ??
      list.find((o) => o?.kind === 'allow_always') ??
      list.find((o) => typeof o?.kind === 'string' && !o.kind.startsWith('reject')))
    : list.find((o) => typeof o?.kind === 'string' && o.kind.startsWith('reject'));
  return pick?.optionId
    ? { outcome: { outcome: 'selected', optionId: pick.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function textOf(content: any): string {
  if (!content) return '';
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  return '';
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const norm = (text: unknown) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Find `model` among what the agent offers: a session config option of category "model"
 * (session/set_config_option) or the older `models` list (session/set_model). Matches a value or a
 * display name exactly, then by a unique prefix, so `gemini-4-argon` finds "Gemini 4 Argon (High)".
 * `select` has no method when the agent already runs that model.
 */
export function pickModel(
  created: any,
  model: string,
): {
  offered: string[];
  select?: { method?: string; params?: Record<string, unknown> };
} {
  const want = norm(model);
  type Entry = {
    value: string;
    name: string;
    apply: { method: string; params: Record<string, unknown> };
  };
  const entries: Entry[] = [];
  let current: string | undefined;
  for (const option of created?.configOptions ?? []) {
    if (option?.category !== 'model' && option?.id !== 'model') continue;
    current = option.currentValue;
    const flat = (option.options ?? []).flatMap((o: any) => o?.options ?? [o]);
    for (const o of flat)
      entries.push({
        value: String(o.value),
        name: String(o.name ?? o.value),
        apply: {
          method: 'session/set_config_option',
          params: { configId: option.id, value: o.value },
        },
      });
  }
  if (created?.models) {
    current ??= created.models.currentModelId;
    for (const o of created.models.availableModels ?? [])
      entries.push({
        value: String(o.modelId),
        name: String(o.name ?? o.modelId),
        apply: { method: 'session/set_model', params: { modelId: o.modelId } },
      });
  }
  const offered = entries.map((e) => (e.name === e.value ? e.value : `${e.value} (${e.name})`));
  const exact = entries.filter((e) => norm(e.value) === want || norm(e.name) === want);
  const prefix = entries.filter(
    (e) => norm(e.value).startsWith(want) || norm(e.name).startsWith(want),
  );
  const found = exact[0] ?? (prefix.length === 1 ? prefix[0] : undefined);
  if (!found) return { offered };
  return { offered, select: found.value === current ? {} : found.apply };
}

/** Live input ends agy's running turn. Without this note the model drops the work that turn was
 * doing; in live tests it said it was waiting for a command and ended without the result. */
export const GEMINI_STEER_NOTE =
  'This message arrived while you were working and ended your previous turn early. Finish that work too, unless this message changes it, then answer both in one reply.';

export function backgroundNote(commands: string[]): string {
  const list = commands.map((c) => `\`${c.length > 200 ? `${c.slice(0, 200)}…` : c}\``).join(', ');
  return `Clawstrum: your turn ended while shell commands you started are still running in the background: ${list}. Nothing will tell you when they finish. If you need a result, wait for it now and then answer; if a command is meant to keep running, say so.`;
}

/** Token counts summed over the run's prompts (live input adds prompts). */
function sumUsage(usages: any[]): Record<string, number> {
  const sum: Record<string, number> = {};
  for (const u of usages)
    for (const [key, value] of Object.entries(u ?? {}))
      if (typeof value === 'number' && Number.isFinite(value)) sum[key] = (sum[key] ?? 0) + value;
  return sum;
}

export const geminiAcpProvider = {
  /** `hookCommand` replaces the command written to agy's hook file (tests). */
  async run(r: ProviderRequest, hookCommand?: string): Promise<string> {
    if (r.controller.signal.aborted) throw r.controller.signal.reason;
    const account = r.account;
    // Subscription only. An account that names an API key, or state that selects one, never starts.
    if (account.tokenEnv)
      throw new ProviderFailure(
        'auth',
        `Gemini account ${account.id} names tokenEnv ${account.tokenEnv}; API keys are never used. Use clawstrum account login ${account.id}`,
      );
    const stateProblem = geminiStateAuthProblem(account);
    if (stateProblem)
      throw new ProviderFailure(
        'auth',
        `Gemini account ${account.id} is not on the Google subscription login: ${stateProblem}`,
      );
    const model = account.model || GEMINI_DEFAULT_MODEL;
    const runtime = runtimeCommand(account);
    // The agent's own log is the evidence of which auth mode it actually ran under.
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-agy-'));
    const logFile = path.join(logDir, 'acp.log');
    const args = [
      ...runtime.args,
      ...geminiArgs(account, [
        '--log-file',
        logFile,
        // Full access means no approval prompts; plan mode (below) is read-only for a text-only call.
        ...(r.toolless ? [] : ['--dangerously-skip-permissions']),
      ]),
    ];
    let sessionId = '';
    let loading = false;
    let accepting = false;
    const injections = new Set<Promise<void>>();
    let ended = false;
    let toolCompletions = 0;
    let budgetExceeded = false;
    let segment = '';
    let lastSegment = '';
    let allText = '';
    let segmentNumber = 0;
    let lastPartialAt = 0;
    let failure: unknown;
    const toolNames = new Map<string, string>();
    // Shell commands without a completion yet. agy reports one finishing only while a turn runs.
    const running = new Map<string, string>();
    const refresh = new ContextRefresh(r);
    const contextUpdate = (snapshot: NonNullable<ReturnType<ContextRefresh['read']>>) =>
      `CLAWSTRUM_CONTEXT_UPDATE\n${REFRESH_PROTOCOL}\nCurrent harness instructions and contextual MEMORY facts:\n${refresh.currentInstructions(snapshot)}`;
    const prompts: Promise<any>[] = [];
    // The last live input until agy echoes it.
    let steered = '';
    const endSegment = () => {
      if (segment.trim()) {
        lastSegment = segment;
        r.onEvent({
          type: 'history',
          detail: {
            id: `gemini:${sessionId}:${r.sessionId ?? 'new'}:${Date.now()}:${++segmentNumber}`,
            kind: 'provider_item',
            source: sessionId,
            content: { type: 'agent_message', text: segment },
            counted: true,
          },
        });
      }
      segment = '';
    };
    // Clawstrum's tool checks reach agy through its own hook file and a relay socket in logDir.
    let research: ReturnType<typeof researchHooks> | undefined;
    let relay: Awaited<ReturnType<typeof startHookRelay>> | undefined;
    const releaseHooks = async () => {
      await relay?.close();
      research?.close();
    };
    if (!r.toolless)
      try {
        research = researchHooks(r);
        if (research.hooks) {
          ensureGeminiHooks(account, hookCommand ?? geminiHookCommand());
          relay = await startHookRelay({
            hooks: research.hooks,
            format: 'gemini',
            dir: logDir,
            onEvent: r.onEvent,
          });
        }
      } catch (error) {
        await releaseHooks();
        fs.rmSync(logDir, { recursive: true, force: true });
        throw error;
      }
    let connection: AcpConnection;
    try {
      connection = new AcpConnection(
        {
          command: runtime.command,
          args,
          cwd: r.cwd,
          env: { ...geminiLaunchEnv(r.env, account), ...relay?.env },
        },
        {
          failure: (error) => {
            failure = error;
          },
          stderr: (text) =>
            r.onEvent({ type: 'diagnostic', detail: { event: 'gemini_stderr', text } }),
          notification: (method, p) => {
            if (method !== 'session/update' || loading || ended) return;
            if (p?.sessionId && sessionId && p.sessionId !== sessionId) return;
            const u = p?.update;
            switch (u?.sessionUpdate) {
              case 'agent_message_chunk': {
                const text = textOf(u.content);
                segment += text;
                allText += text;
                if (Date.now() - lastPartialAt >= 1000) {
                  lastPartialAt = Date.now();
                  r.onEvent({ type: 'partial', detail: text });
                }
                break;
              }
              case 'user_message_chunk': {
                // agy echoes a prompt as its turn starts. Text between live input and its echo is
                // the tail of the turn that input cut off, not part of the answer.
                const echoed = textOf(u.content);
                if (steered && echoed && steered.startsWith(echoed.slice(0, 200))) {
                  steered = '';
                  endSegment();
                  lastSegment = '';
                  allText = '';
                }
                break;
              }
              case 'tool_call': {
                endSegment();
                const name = String(u.kind ?? u.title ?? 'tool');
                toolNames.set(u.toolCallId, name);
                if (u.kind === 'execute' && u.status !== 'completed' && u.status !== 'failed')
                  running.set(
                    String(u.toolCallId),
                    String(u.rawInput?.CommandLine ?? u.title ?? ''),
                  );
                r.onEvent({
                  type: 'activity',
                  detail: u,
                  tool: { id: String(u.toolCallId), name, state: 'started' },
                });
                break;
              }
              case 'tool_call_update': {
                const done = u.status === 'completed' || u.status === 'failed';
                if (done) running.delete(String(u.toolCallId));
                r.onEvent({
                  type: 'activity',
                  detail: u,
                  tool: {
                    id: String(u.toolCallId),
                    name: toolNames.get(u.toolCallId),
                    state: done ? 'completed' : 'started',
                  },
                });
                if (done) {
                  r.onEvent({
                    type: 'history',
                    detail: {
                      id: `gemini:${sessionId}:${u.toolCallId}`,
                      kind: 'provider_item',
                      source: sessionId,
                      content: u,
                      counted: true,
                    },
                  });
                  if (r.maxTurns && ++toolCompletions > r.maxTurns && !budgetExceeded) {
                    budgetExceeded = true;
                    connection.notify('session/cancel', { sessionId });
                  }
                }
                break;
              }
              case 'plan':
                r.onEvent({ type: 'activity', detail: u });
                break;
              case 'usage_update':
                r.onEvent({ type: 'diagnostic', detail: { event: 'gemini_context', ...u } });
                break;
              default:
                break;
            }
          },
          request: async (method, p) => {
            if (method === 'session/request_permission')
              // The configured full-access policy authorizes execution without user approval.
              return permissionOutcome(p?.options, !r.toolless);
            if (method === 'fs/read_text_file') {
              const text = fs.readFileSync(String(p.path), 'utf8');
              if (!p.line && !p.limit) return { content: text };
              const lines = text.split('\n');
              const start = Math.max(0, (p.line ?? 1) - 1);
              return {
                content: lines.slice(start, p.limit ? start + p.limit : undefined).join('\n'),
              };
            }
            if (method === 'fs/write_text_file') {
              if (r.toolless) throw new AcpRpcError(-32000, 'Writes are disabled for this call');
              fs.mkdirSync(path.dirname(String(p.path)), { recursive: true });
              fs.writeFileSync(String(p.path), String(p.content ?? ''));
              return null;
            }
            throw new AcpRpcError(
              -32601,
              `Clawstrum does not implement ${method}; use Discord for user questions`,
            );
          },
        },
      );
    } catch (error) {
      await releaseHooks();
      fs.rmSync(logDir, { recursive: true, force: true });
      throw error;
    }
    let cancelled: Promise<unknown> | undefined;
    const abort = () => {
      if (sessionId) connection.notify('session/cancel', { sessionId });
      // Give the agent a moment to answer with stopReason "cancelled", then drop the connection.
      cancelled = new Promise((resolve) => setTimeout(resolve, 1500)).then(() =>
        connection.cancelPending(r.controller.signal.reason),
      );
    };
    r.controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const init = await connection.request('initialize', {
        protocolVersion: 1,
        // Gemini reads and writes files itself; we do not offer file access through the client.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'clawstrum', title: 'Clawstrum', version: '0.1.0' },
      });
      if (failure) throw failure;
      const methods: string[] = (init?.authMethods ?? []).map((m: any) => m.id);
      // The Google sign-in is the only method Clawstrum ever asks for. No other id, no _meta.apiKey.
      const method = 'oauth-personal';
      if (methods.length && !methods.includes(method))
        throw new ProviderFailure('fatal', `Antigravity CLI does not offer auth method ${method}`);
      try {
        await connection.request('authenticate', { methodId: method }, 120000);
      } catch (error) {
        if (error instanceof AcpRpcError) throw acpFailure(error);
        throw error;
      }
      const mcpServers = acpMcpServers(r.mcp, r.toolless, r.extraMcp);
      // session/resume reopens a conversation without replaying it; session/load replays it as updates.
      const canResume = !!init?.agentCapabilities?.sessionCapabilities?.resume;
      const canLoad = !!init?.agentCapabilities?.loadSession;
      // agy adds this text to its own system prompt and keeps it across session/resume; a second
      // append would stack on the first, so it is sent at session/new only. Without the capability
      // the base prompt and instructions lead the first prompt instead.
      const canAppend = init?.agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true;
      const snapshot = refresh.read();
      const initial = r.contextRefresh?.snapshot;
      const current = snapshot && initial ? refresh.currentInstructions(snapshot) : r.instructions;
      const system = usesBasePrompt(r) ? `${basePrompt(r)}\n\n${current}` : current;
      // A new ACP session has no earlier conversation, even when the engine asked to resume one.
      let resumed = false;
      let created: any;
      try {
        if (r.sessionId && (canResume || canLoad)) {
          loading = !canResume;
          created = await connection.request(
            canResume ? 'session/resume' : 'session/load',
            { sessionId: r.sessionId, cwd: r.cwd, mcpServers },
            120000,
          );
          sessionId = r.sessionId;
          resumed = true;
          loading = false;
        } else {
          created = await connection.request(
            'session/new',
            {
              cwd: r.cwd,
              mcpServers,
              ...(canAppend
                ? { _meta: { antigravity: { systemPrompt: { append: system } } } }
                : {}),
            },
            120000,
          );
          sessionId = created?.sessionId;
          if (!sessionId)
            throw new ProviderFailure('transient', 'Gemini did not return a session ID');
        }
      } catch (error) {
        loading = false;
        if (error instanceof AcpRpcError) {
          const mapped = acpFailure(error);
          if (r.sessionId && mapped.kind !== 'auth' && mapped.kind !== 'quota')
            throw new ProviderFailure('session', error.message);
          throw mapped;
        }
        throw error;
      }
      r.onEvent({ type: 'session', sessionId });
      // The log must not show a non-subscription auth mode. Checked before any prompt is sent.
      const logProblem = nonSubscriptionAuth(readText(logFile));
      if (logProblem)
        throw new ProviderFailure(
          'auth',
          `Antigravity CLI reports auth mode ${logProblem}; Clawstrum only uses the Google subscription login`,
        );
      // Full access means auto mode (no approvals). Plan mode is read-only for a text-only call.
      const wanted = r.toolless ? 'plan' : 'auto';
      const modes: string[] = (created?.modes?.availableModes ?? []).map((m: any) => m.id);
      const modeId =
        !modes.length || modes.includes(wanted) ? wanted : r.toolless ? 'plan' : 'accept-edits';
      await connection.request('session/set_mode', { sessionId, modeId }, 15000).catch((error) =>
        r.onEvent({
          type: 'diagnostic',
          detail: { event: 'gemini_set_mode_failed', error: String(error) },
        }),
      );
      // Select the model (default Gemini 4 Argon). Running on another model would be a silent substitution.
      const choice = pickModel(created, model);
      // A resumed session keeps its model; its reply may not list the pickers again.
      if (!choice.select && !(resumed && !choice.offered.length))
        throw new ProviderFailure(
          'fatal',
          `Antigravity CLI does not offer model ${model}; offered: ${choice.offered.join(', ') || 'no model picker'}`,
        );
      let options = created?.configOptions;
      if (choice.select?.method) {
        const selected = await connection
          .request(choice.select.method, { sessionId, ...choice.select.params }, 15000)
          .catch((error) => {
            throw new ProviderFailure('fatal', `Could not select model ${model}: ${String(error)}`);
          });
        // The levels on offer can depend on the model.
        if (selected?.configOptions?.length) options = selected.configOptions;
      }
      const level = pickThoughtLevel(options, account.effort);
      if (level)
        await connection
          .request('session/set_config_option', { sessionId, ...level }, 15000)
          .catch((error) =>
            r.onEvent({
              type: 'diagnostic',
              detail: { event: 'gemini_thought_level_failed', ...level, error: String(error) },
            }),
          );
      let text = r.prompt;
      if (!resumed) {
        if (!canAppend) text = `${system}\n\n${r.prompt}`;
        const delivered = snapshot ?? initial;
        if (delivered) refresh.delivered(delivered, sessionId);
      } else if (snapshot && refresh.changed(snapshot)) {
        text = `${contextUpdate(snapshot)}\n\n${r.prompt}`;
        refresh.delivered(snapshot, sessionId);
      }
      r.onEvent({ type: 'ready' });
      const prompt = (body: string) => {
        const sent = connection.request(
          'session/prompt',
          { sessionId, prompt: [{ type: 'text', text: body }] },
          0,
        );
        prompts.push(sent);
        return sent;
      };
      prompt(text);
      accepting = !r.toolless;
      const refused = new Set<Promise<any>>();
      // Live input is another session/prompt: agy ends the running turn at once (end_turn, usually
      // no text) and starts a new one on the whole conversation.
      r.attachInjector?.((ids, input) => {
        if (!accepting || r.controller.signal.aborted) return false;
        const latest = refresh.read();
        const changed = latest && refresh.changed(latest) ? latest : undefined;
        // What the cut turn wrote stays in history; the answer comes from the new turn.
        endSegment();
        lastSegment = '';
        allText = '';
        const previous = prompts[prompts.length - 1]!;
        steered = [changed ? contextUpdate(changed) : '', GEMINI_STEER_NOTE, input]
          .filter(Boolean)
          .join('\n\n');
        const next = prompt(steered);
        let previousEnded = false;
        const injection = new Promise<boolean>((resolve) => {
          const accepted = () => {
            previousEnded = true;
            resolve(true);
          };
          previous.then(accepted, accepted);
          // Refused while the running turn goes on: that turn still gives the answer.
          next.catch(() => {
            if (previousEnded) return;
            refused.add(next);
            resolve(false);
          });
        }).then((accepted) => {
          const ok = accepted && !r.controller.signal.aborted;
          if (ok && changed) refresh.delivered(changed, sessionId);
          r.onEvent({ type: 'injected', detail: { ids, ok } });
          if (ok) r.onEvent({ type: 'input_started', detail: { ids } });
        });
        injections.add(injection);
        void injection.finally(() => injections.delete(injection));
        return true;
      });
      let response: any;
      const usages: any[] = [];
      let followedUp = false;
      // The answer of the turn before the follow-up; sent ahead of the follow-up's, as on Claude.
      let earlier = '';
      for (let i = 0; ; i++) {
        if (i === prompts.length) {
          // agy moves a long shell command to the background and may end the turn without its
          // result; nothing wakes the model when it finishes. One follow-up asks it to wait.
          if (
            followedUp ||
            r.toolless ||
            !running.size ||
            response?.stopReason !== 'end_turn' ||
            budgetExceeded ||
            !(r.research?.enabled && r.research.holdBackgroundTasks)
          )
            break;
          followedUp = true;
          endSegment();
          earlier = (lastSegment || allText).trim();
          lastSegment = '';
          allText = '';
          prompt(backgroundNote([...running.values()]));
        }
        try {
          response = await prompts[i];
          if (response?.usage) usages.push(response.usage);
        } catch (error) {
          if (r.controller.signal.aborted) throw r.controller.signal.reason;
          // A refused live input, or a turn that live input cut off.
          if (refused.has(prompts[i]!) || i < prompts.length - 1) continue;
          if (error instanceof AcpRpcError) throw acpFailure(error);
          throw error;
        }
      }
      accepting = false;
      // An acknowledgment must reach the engine before the result does.
      await Promise.all(injections);
      ended = true;
      endSegment();
      const usage = usages.length > 1 ? sumUsage(usages) : usages[0];
      if (usage) r.onEvent({ type: 'usage', detail: usage, usage: geminiTurnUsage({ usage }) });
      if (r.controller.signal.aborted) throw r.controller.signal.reason;
      if (budgetExceeded)
        throw new ProviderFailure(
          'budget',
          `Configured completed-tool budget exhausted (${r.maxTurns}); inspect partial artifacts`,
        );
      switch (response?.stopReason) {
        case 'end_turn':
          break;
        case 'cancelled':
          throw new ProviderFailure('transient', 'Gemini ended the turn as cancelled');
        case 'refusal':
          throw new ProviderFailure('fatal', 'Gemini refused the request (stopReason refusal)');
        case 'max_tokens':
          throw new ProviderFailure('context', 'Gemini context window exceeded (max_tokens)');
        case 'max_turn_requests':
          throw new ProviderFailure(
            'budget',
            'Gemini stopped at its own turn limit (max_turn_requests)',
          );
        default:
          throw new ProviderFailure(
            'transient',
            `Gemini ended the turn with stopReason ${String(response?.stopReason)}`,
          );
      }
      const final = (lastSegment || allText).trim();
      if (earlier && final)
        r.onEvent({ type: 'result_text', detail: { text: earlier, final: false } });
      r.onEvent({ type: 'partial', detail: final || earlier });
      return final || earlier;
    } finally {
      accepting = false;
      ended = true;
      r.controller.signal.removeEventListener('abort', abort);
      await cancelled;
      await connection.close();
      for (const sent of prompts) void sent.catch(() => {});
      await Promise.allSettled([...injections]);
      await releaseHooks();
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  },
} satisfies Provider;

/**
 * Is the account logged in with the Google subscription? Starts `agy acp`, asks for a session (no model
 * call, no cost) and reads the answer: "Authentication required" means no login. Used by doctor and
 * after `account login`.
 */
export async function geminiLoginProbe(
  account: Account,
  env: Record<string, string>,
): Promise<{ ok: boolean; detail: string }> {
  const stateProblem = geminiStateAuthProblem(account);
  if (stateProblem)
    return { ok: false, detail: `not the Google subscription login: ${stateProblem}` };
  const runtime = runtimeCommand(account);
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-agy-'));
  const logFile = path.join(logDir, 'acp.log');
  let failure: unknown;
  const connection = new AcpConnection(
    {
      command: runtime.command,
      args: [...runtime.args, ...geminiArgs(account, ['--log-file', logFile])],
      cwd: os.tmpdir(),
      env: geminiLaunchEnv(env, account),
    },
    {
      notification: () => {},
      request: async () => null,
      stderr: () => {},
      failure: (e) => (failure = e),
    },
  );
  try {
    await connection.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30000);
    await connection.request('session/new', { cwd: os.tmpdir(), mcpServers: [] }, 30000);
    const mode = nonSubscriptionAuth(readText(logFile));
    if (mode) return { ok: false, detail: `agy reports auth mode ${mode}, not the Google login` };
    return { ok: true, detail: 'Google sign-in available' };
  } catch (error) {
    if (error instanceof AcpRpcError && acpFailure(error).kind === 'auth')
      return { ok: false, detail: 'not logged in' };
    return { ok: false, detail: String(failure ?? error).slice(0, 200) };
  } finally {
    await connection.close();
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}
