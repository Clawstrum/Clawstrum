import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamHistory } from './provider-history.js';
import { codexBasePrompt, usesBasePrompt } from './base-prompt.js';
import { ContextRefresh, REFRESH_PROTOCOL } from './instructions.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ProviderFailure, classifyError } from './accounts.js';
import { runtimeCommand } from './runtime.js';
import { maintenanceCodexConfig, maintenanceCodexOverrides } from './maintenance-config.js';
import { codexOrchestrationConfig } from './orchestration.js';
import type { Provider, ProviderRequest } from './types.js';
import { codexWorkerSandbox } from './worker-sandbox.js';
import { CodexUsage, type UsageSnapshot } from './usage.js';
import { startHookRelay } from './hook-relay.js';
import { researchHooks } from './research/hooks.js';
import { codexHookArgs, codexHookCommand, trustCodexHooks } from './codex-hooks.js';

/** Clawstrum's own server goes last so an owner-configured server cannot replace it. */
export function codexMcpServers(r: ProviderRequest) {
  return {
    ...(r.toolless ? {} : r.extraMcp),
    clawstrum: { command: r.mcp.command, args: r.mcp.args, env: r.mcp.env },
  };
}

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** One local stdio connection, owned by the provider worker's process group. */
export class CodexConnection {
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private closed = false;
  private failureReason?: unknown;
  private pending = new Map<
    number,
    {
      resolve: (result: any) => void;
      reject: (error: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly exited: Promise<void>;
  constructor(
    r: Pick<ProviderRequest, 'account' | 'env' | 'cwd' | 'onEvent' | 'toolless'> &
      Partial<Pick<ProviderRequest, 'research' | 'mcp' | 'subagent' | 'sandbox' | 'role'>>,
    notification: (message: RpcMessage) => void,
    failure: (error: unknown) => void,
    /** Command for Codex's PreToolUse hook; set only when Clawstrum's tool checks apply to the run. */
    hookCommand?: string,
  ) {
    const runtime = runtimeCommand(r.account);
    const sandbox = codexWorkerSandbox(r);
    this.child = spawn(
      runtime.command,
      [
        ...runtime.args,
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        'forced_login_method="chatgpt"',
        '-c',
        'approval_policy="never"',
        '-c',
        `sandbox_mode="${r.toolless ? 'read-only' : sandbox ? 'workspace-write' : 'danger-full-access'}"`,
        ...(sandbox
          ? [
              '-c',
              `sandbox_workspace_write.writable_roots=${JSON.stringify(sandbox.writable_roots)}`,
              '-c',
              `sandbox_workspace_write.network_access=${sandbox.network_access}`,
            ]
          : []),
        ...Object.entries(codexOrchestrationConfig(r)).flatMap(([key, value]) => [
          '-c',
          `${key}=${JSON.stringify(value)}`,
        ]),
        ...(hookCommand ? codexHookArgs(hookCommand) : []),
        ...(r.toolless
          ? Object.entries(maintenanceCodexConfig.features).flatMap(([key, value]) => [
              '-c',
              `features.${key}=${value}`,
            ])
          : []),
      ],
      { cwd: r.cwd, env: r.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const fail = (error: unknown) => {
      if (this.closed) return;
      this.cancelPending(error);
      failure(error);
    };
    this.exited = new Promise((resolve) => {
      this.child.once('close', () => {
        fail(
          new ProviderFailure('transient', 'Codex app-server exited before completing the request'),
        );
        resolve();
      });
    });
    this.child.on('error', fail);
    this.child.stdin.on('error', fail);
    this.child.stderr.on('data', (data: Buffer) => {
      if (!this.closed)
        r.onEvent({
          type: 'diagnostic',
          detail: { event: 'codex_stderr', text: data.toString().slice(-4000) },
        });
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      if (this.closed || !line.trim()) return;
      try {
        const message: RpcMessage = JSON.parse(line);
        if (!message || typeof message !== 'object') throw new Error('Expected a JSON-RPC object');
        if (message.method) {
          if (message.id !== undefined) {
            // The configured full-access policy authorizes execution without user approval; a sandboxed worker gets none.
            let result: unknown;
            if (
              ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(
                message.method,
              )
            )
              result = { decision: r.toolless || sandbox ? 'decline' : 'accept' };
            else if (message.method === 'item/permissions/requestApproval')
              result = {
                permissions: r.toolless || sandbox ? {} : (message.params?.permissions ?? {}),
                scope: 'turn',
              };
            else {
              this.send({
                id: message.id,
                error: {
                  code: -32601,
                  message: `Clawstrum does not implement ${message.method}; use Discord for user questions`,
                },
              });
              return;
            }
            this.send({ id: message.id, result });
          } else notification(message);
          return;
        }
        const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
        if (!pending) return;
        this.pending.delete(message.id as number);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(
            new RpcError(message.error.code, message.error.message ?? 'Codex RPC failed'),
          );
        else pending.resolve(message.result);
      } catch (error) {
        fail(new ProviderFailure('transient', `Invalid Codex app-server event: ${String(error)}`));
      }
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
  send(message: RpcMessage): void {
    if (this.failureReason && message.method !== 'turn/interrupt') throw this.failureReason;
    if (this.closed) throw new ProviderFailure('transient', 'Codex connection is closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderFailure('transient', `Codex ${method} acknowledgment timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ProviderFailure('transient', 'Codex connection closed'));
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

function turnFailure(error: any): ProviderFailure {
  const info = error?.codexErrorInfo;
  const message = error?.message ?? 'Codex turn failed';
  if (info === 'contextWindowExceeded') return new ProviderFailure('context', message);
  if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded')
    return new ProviderFailure('quota', message);
  if (info === 'unauthorized') return new ProviderFailure('auth', message);
  if (
    ['serverOverloaded', 'internalServerError'].includes(info) ||
    (info && typeof info === 'object')
  ) {
    const value = Object.values(info)[0] as any;
    if (value?.httpStatusCode === 401) return new ProviderFailure('auth', message);
    if (value?.httpStatusCode === 429) return new ProviderFailure('quota', message);
    return new ProviderFailure('transient', message);
  }
  return classifyError(message);
}

export const codexAppServerProvider: Provider = {
  async run(r) {
    if (r.controller.signal.aborted) throw r.controller.signal.reason;
    let threadId = '';
    let turnId = '';
    let accepting = false;
    let ended = false;
    let final = '';
    let lastDeltaAt = 0;
    const history = new StreamHistory(r.onEvent, () => threadId);
    const refresh = new ContextRefresh(r);
    let refreshTimer: NodeJS.Timeout | undefined;
    let refreshing: Promise<void> = Promise.resolve();
    let forceContext = false;
    let reloadContext: (() => Promise<void>) | undefined;
    let toolItems = 0;
    const usage = new CodexUsage(!!r.sessionId);
    let latestUsage: UsageSnapshot | undefined;
    let finish!: (turn: any) => void;
    let fail!: (error: unknown) => void;
    const finished = new Promise<any>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // Startup can fail before we begin awaiting the turn.
    void finished.catch(() => {});
    const injections = new Set<Promise<void>>();
    // Clawstrum's tool checks reach Codex through its PreToolUse hook and a relay socket in a private temp dir.
    let research: ReturnType<typeof researchHooks> | undefined;
    let relay: Awaited<ReturnType<typeof startHookRelay>> | undefined;
    let relayDir: string | undefined;
    let hookCommand: string | undefined;
    const releaseHooks = async () => {
      await relay?.close();
      research?.close();
      if (relayDir) fs.rmSync(relayDir, { recursive: true, force: true });
    };
    if (!r.toolless)
      try {
        research = researchHooks(r);
        if (research.hooks) {
          relayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-codex-'));
          relay = await startHookRelay({
            hooks: research.hooks,
            format: 'codex',
            dir: relayDir,
            onEvent: r.onEvent,
          });
          hookCommand = codexHookCommand();
        }
      } catch (error) {
        await releaseHooks();
        throw error;
      }
    let connection: CodexConnection;
    try {
      connection = new CodexConnection(
        { ...r, env: { ...r.env, ...relay?.env } },
        ({ method, params: p }) => {
          if (method === 'account/rateLimits/updated') {
            for (const bucket of ['primary', 'secondary']) {
              const window = p?.rateLimits?.[bucket];
              if (typeof window?.usedPercent !== 'number') continue;
              r.onEvent({
                type: 'quota',
                quota: {
                  rejected: false,
                  utilization: window.usedPercent / 100,
                  resetsAt:
                    typeof window.resetsAt === 'number' ? window.resetsAt * 1000 : undefined,
                  bucket: `${p.rateLimits.limitId ?? 'codex'}:${bucket}`,
                },
              });
            }
            return;
          }
          if (!threadId || p?.threadId !== threadId) return;
          if (method === 'item/started' && p.item?.type === 'contextCompaction') {
            r.onEvent({
              type: 'activity',
              detail: { type: 'contextCompaction', status: 'compacting' },
            });
            return;
          }
          if (
            method === 'thread/compacted' ||
            (method === 'item/completed' && p.item?.type === 'contextCompaction')
          ) {
            forceContext = true;
            r.onEvent({ type: 'activity', detail: { type: 'contextCompaction', status: null } });
            r.onEvent({
              type: 'history',
              detail: {
                id: `codex-compaction:${threadId}:${p.item?.id ?? randomUUID()}`,
                kind: 'compaction',
                source: threadId,
                content: { method, ...p },
                counted: false,
              },
            });
            void reloadContext?.().catch(fail);
            return;
          }
          if (method === 'turn/started') {
            if (turnId && turnId !== p.turn.id) return;
            turnId = p.turn.id;
            if (!ended) accepting = true;
            r.onEvent({ type: 'ready' });
            return;
          }
          const eventTurn = p.turnId ?? p.turn?.id;
          if (!turnId || eventTurn !== turnId || ended) return;
          if (method === 'turn/completed') {
            if (latestUsage)
              r.onEvent({
                type: 'usage',
                usage: { ...latestUsage, final: true },
                detail: { normalizedUsage: latestUsage },
              });
            accepting = false;
            ended = true;
            finish(p.turn);
          } else if (method === 'error') {
            r.onEvent({ type: 'diagnostic', detail: p });
            if (!p.willRetry) {
              accepting = false;
              fail(turnFailure(p.error));
            }
          } else if (method === 'thread/tokenUsage/updated') {
            latestUsage = usage.observe(p.tokenUsage);
            r.onEvent({ type: 'usage', detail: p.tokenUsage, usage: latestUsage });
          } else if (method === 'item/agentMessage/delta') {
            history.delta(p.itemId, method, p.delta ?? '');
            // Avoid a synchronous SQLite write for every token; completed items retain full text.
            if (Date.now() - lastDeltaAt >= 1000) {
              lastDeltaAt = Date.now();
              r.onEvent({ type: 'partial', detail: p.delta });
            }
          } else if (method === 'item/started' || method === 'item/completed') {
            const item = p.item;
            if (method === 'item/completed') history.completed(item.id);
            if (method === 'item/completed' && item.type !== 'reasoning')
              r.onEvent({
                type: 'history',
                detail: {
                  id: `codex:${threadId}:${item.id}`,
                  kind: 'provider_item',
                  source: threadId,
                  content: item,
                  counted: item.type !== 'userMessage',
                },
              });
            if (item.type === 'agentMessage') {
              if (method === 'item/completed') {
                if (item.text?.trim()) final = item.text;
                r.onEvent({ type: 'partial', detail: item.text ?? '' });
              }
            } else if (item.type !== 'reasoning' && item.type !== 'userMessage') {
              r.onEvent({
                type: 'activity',
                detail: item,
                tool: ['commandExecution', 'mcpToolCall', 'fileChange', 'webSearch'].includes(
                  item.type,
                )
                  ? {
                      id: item.id,
                      name: item.type,
                      state: method === 'item/completed' ? 'completed' : 'started',
                    }
                  : undefined,
              });
              if (r.maxTurns && method === 'item/completed' && ++toolItems > r.maxTurns)
                fail(
                  new ProviderFailure(
                    'budget',
                    `Configured completed-tool budget exhausted (${r.maxTurns}); inspect partial artifacts`,
                  ),
                );
            }
          } else if (/^item\/(commandExecution|fileChange|mcpToolCall)\//.test(method ?? '')) {
            if (typeof p.delta === 'string') history.delta(p.itemId, method!, p.delta);
            r.onEvent({ type: 'activity', detail: { method, ...p } });
          }
        },
        fail,
        hookCommand,
      );
    } catch (error) {
      await releaseHooks();
      throw error;
    }
    let interruption: Promise<unknown> | undefined;
    const abort = () => {
      accepting = false;
      connection.cancelPending(r.controller.signal.reason);
      if (threadId && turnId)
        interruption = connection
          .request('turn/interrupt', { threadId, turnId }, 1000)
          .catch(() => {});
      fail(r.controller.signal.reason);
    };
    r.controller.signal.addEventListener('abort', abort, { once: true });
    try {
      await connection.request('initialize', {
        clientInfo: { name: 'clawstrum', title: 'Clawstrum', version: '0.1.0' },
      });
      connection.send({ method: 'initialized', params: {} });
      // Codex skips an untrusted hook silently, so the trust is written before the thread starts.
      if (hookCommand)
        await trustCodexHooks({
          request: (method, params) => connection.request(method, params),
          cwd: r.cwd,
          command: hookCommand,
          codexHome: r.env.CODEX_HOME ?? r.account.home,
          onFallback: (error) =>
            r.onEvent({
              type: 'diagnostic',
              detail: { event: 'codex_hook_trust_fallback', error: String(error) },
            }),
        });
      const maintenance = r.toolless
        ? maintenanceCodexOverrides(
            (
              await connection.request('config/read', {
                cwd: r.cwd,
                includeLayers: false,
              })
            ).config,
          )
        : undefined;
      const workerSandbox = codexWorkerSandbox(r);
      const parameters = {
        cwd: r.cwd,
        model: r.account.model,
        approvalPolicy: 'never',
        sandbox: r.toolless
          ? 'read-only'
          : workerSandbox
            ? 'workspace-write'
            : 'danger-full-access',
        developerInstructions: r.instructions,
        ...(usesBasePrompt(r) ? { baseInstructions: codexBasePrompt(r) } : {}),
        config: {
          ...codexOrchestrationConfig(r),
          ...(workerSandbox ? { sandbox_workspace_write: workerSandbox } : {}),
          ...(maintenance ?? {
            mcp_servers: codexMcpServers(r),
          }),
        },
      };
      let thread;
      try {
        thread = await connection.request(r.sessionId ? 'thread/resume' : 'thread/start', {
          ...parameters,
          ...(r.sessionId ? { threadId: r.sessionId } : {}),
        });
      } catch (error) {
        if (
          r.sessionId &&
          error instanceof RpcError &&
          /rollout|not found|does not exist/i.test(error.message)
        )
          throw new ProviderFailure('session', error.message);
        throw error;
      }
      threadId = thread?.thread?.id;
      if (!threadId) throw new ProviderFailure('transient', 'Codex did not return a thread ID');
      r.onEvent({ type: 'session', sessionId: threadId });
      const reload = () => {
        refreshing = refreshing.then(async () => {
          if (ended || r.controller.signal.aborted) return;
          const snapshot = refresh.read();
          if (!snapshot || (!forceContext && !refresh.changed(snapshot))) return;
          const force = forceContext;
          await connection.request('thread/inject_items', {
            threadId,
            items: [
              {
                type: 'message',
                role: 'developer',
                content: [
                  {
                    type: 'input_text',
                    text: `CLAWSTRUM_CONTEXT_UPDATE\n${REFRESH_PROTOCOL}\nCurrent harness instructions and contextual MEMORY facts:\n${refresh.currentInstructions(snapshot)}`,
                  },
                ],
              },
            ],
          });
          refresh.delivered(snapshot, threadId);
          if (force) forceContext = false;
        });
        return refreshing;
      };
      reloadContext = reload;
      // Resume overrides alone do not replace an existing developer message. Explicit injection
      // preserves the native history and is acknowledged before the next turn is started.
      const changedAtLaunch = refresh.read()?.revision !== r.contextRefresh?.snapshot.revision;
      if (r.sessionId || changedAtLaunch) await reload();
      const start = await connection.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: r.prompt }],
        effort: r.account.effort,
      });
      if (!start?.turn?.id || (turnId && start.turn.id !== turnId))
        throw new ProviderFailure('transient', 'Codex returned an unexpected turn ID');
      turnId = start.turn.id;
      if (!ended) accepting = true;
      if (!r.sessionId && !changedAtLaunch) {
        const snapshot = r.contextRefresh?.snapshot;
        if (snapshot) refresh.delivered(snapshot, threadId);
      }
      if (r.contextRefresh && !r.toolless)
        refreshTimer = setInterval(() => {
          if (!ended) void reload().catch(fail);
        }, 1000);
      r.onEvent({ type: 'ready' });
      r.attachInjector?.((ids, text) => {
        if (!accepting || r.controller.signal.aborted) return false;
        const expectedTurnId = turnId;
        const injection = (async () => {
          let ok = false;
          let uncertain = false;
          try {
            await reload();
            const result = await connection.request('turn/steer', {
              threadId,
              expectedTurnId,
              input: [{ type: 'text', text }],
            });
            ok = result?.turnId === expectedTurnId && !r.controller.signal.aborted;
            uncertain = !ok;
          } catch (error) {
            uncertain = !(error instanceof RpcError && [-32600, -32602].includes(error.code));
            r.onEvent({
              type: 'diagnostic',
              detail: {
                event: uncertain ? 'codex_steer_unknown' : 'codex_steer_rejected',
                error: String(error),
              },
            });
          }
          r.onEvent({
            type: 'injected',
            detail: { ids, ok, ...(uncertain ? { uncertain: true } : {}) },
          });
        })();
        injections.add(injection);
        void injection.finally(() => injections.delete(injection)).catch(fail);
        return true;
      });
      const turn = await finished;
      // A completion notification can precede an accepted steer's response. Persist its
      // acknowledgment before the worker returns a result and the engine settles its batch.
      await Promise.all(injections);
      if (r.controller.signal.aborted) throw r.controller.signal.reason;
      if (turn.status !== 'completed')
        throw turnFailure(turn.error ?? { message: `Codex turn ${turn.status}` });
      return final;
    } finally {
      accepting = false;
      clearInterval(refreshTimer);
      r.controller.signal.removeEventListener('abort', abort);
      await interruption;
      try {
        await connection.close();
        history.flush();
        await Promise.allSettled([refreshing, ...injections]);
      } finally {
        await releaseHooks();
      }
    }
  },
};
