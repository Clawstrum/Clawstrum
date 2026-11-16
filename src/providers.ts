import { Codex } from '@openai/codex-sdk';
import { createHash } from 'node:crypto';
import { codexAppServerProvider, codexMcpServers } from './codex-app-server.js';
import { geminiAcpProvider, geminiForbiddenEnv } from './gemini-acp.js';
import {
  ContextRefresh,
  nativeInstructionExcludes,
  subagentUpdateMessage,
} from './instructions.js';
import { query, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { TurnStream } from './turn-stream.js';
import { researchHooks } from './research/hooks.js';
import { compactionHooks, mergeHooks } from './compaction.js';
import { permissionGate } from './permission-gate.js';
import { codexWorkerSandbox, sandboxHooks } from './worker-sandbox.js';
import type { Account, Provider, ProviderEvent } from './types.js';
import { ProviderFailure, classifyError } from './accounts.js';
import { accountToken } from './account-registry.js';
import { ClaudeUsage, codexTurnUsage } from './usage.js';
import { scrubbedEnvironment } from './secrets.js';
import { basePrompt, usesBasePrompt } from './base-prompt.js';
import {
  ownsDelegation,
  nativeClaudeDelegationTools,
  codexOrchestrationConfig,
} from './orchestration.js';

export function accountEnvironment(
  account: Account,
  accounts: Account[],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = scrubbedEnvironment(source);
  // Explicit account routing; ambient keys must not silently select metered API billing.
  for (const key of [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CODEX_HOME',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENAI_USE_GCA',
    'GOOGLE_GEMINI_BASE_URL',
    'GEMINI_MODEL',
    'CLAUDE_CONFIG_DIR',
    'CLAUDECODE',
    ...accounts.flatMap((a) => (a.tokenEnv ? [a.tokenEnv] : [])),
  ])
    delete env[key];
  if (account.provider === 'codex') env.CODEX_HOME = account.home;
  else if (account.provider === 'gemini') {
    // Antigravity CLI: the account home is passed as --gemini-dir and XDG_CONFIG_HOME at launch.
    // Cloud, gateway and API-key variables are removed here and again at launch (geminiLaunchEnv).
    for (const key of geminiForbiddenEnv) delete env[key];
  } else env.CLAUDE_CONFIG_DIR = account.home;
  if (account.tokenEnv) {
    if (account.provider === 'codex' || account.provider === 'gemini')
      throw new ProviderFailure(
        'auth',
        account.provider === 'gemini'
          ? 'Gemini accounts use the Google sign-in only; an API key is never used'
          : 'tokenEnv is supported only for Claude accounts',
      );
    const token = source[account.tokenEnv];
    if (!token)
      throw new ProviderFailure('auth', `Missing environment variable ${account.tokenEnv}`);
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
  } else if (account.provider === 'claude') {
    // A token stored in the private registry (runtime/accounts.json) is passed exactly like a
    // tokenEnv value. It lives in a module map, not on the Account, so it cannot reach a log line.
    const stored = accountToken(account.id);
    if (stored) env.CLAUDE_CODE_OAUTH_TOKEN = stored;
  }
  return env;
}
export const codexProvider: Provider = {
  async run(r) {
    // Maintenance needs the app-server's resolved config to disable inherited MCP servers.
    if (r.liveInput || r.toolless || r.contextRefresh) return codexAppServerProvider.run(r);
    const codex = new Codex({
      env: r.env,
      codexPathOverride: r.account.executable,
      config: {
        forced_login_method: 'chatgpt',
        developer_instructions: r.instructions,
        ...codexOrchestrationConfig(r),
        mcp_servers: codexMcpServers(r),
      },
    });
    const sandbox = codexWorkerSandbox(r);
    const options = {
      workingDirectory: r.cwd,
      model: r.account.model,
      modelReasoningEffort: r.account.effort,
      sandboxMode: sandbox ? ('workspace-write' as const) : ('danger-full-access' as const),
      ...(sandbox ? { additionalDirectories: sandbox.writable_roots.slice(1) } : {}),
      approvalPolicy: 'never' as const,
      networkAccessEnabled: sandbox?.network_access ?? true,
      skipGitRepoCheck: true,
    };
    const thread = r.sessionId
      ? codex.resumeThread(r.sessionId, options)
      : codex.startThread(options);
    let final = '';
    let completed = false;
    let toolItems = 0;
    const turn = await thread.runStreamed(r.prompt, { signal: r.controller.signal });
    for await (const event of turn.events) {
      if (event.type === 'item.completed' && event.item.type !== 'reasoning')
        r.onEvent({
          type: 'history',
          detail: {
            id: `codex:${thread.id}:${event.item.id}`,
            kind: 'provider_item',
            source: thread.id ?? '',
            content: event.item,
            counted: true,
          },
        });
      if (event.type === 'thread.started')
        r.onEvent({ type: 'session', sessionId: event.thread_id });
      else if (event.type === 'turn.started') r.onEvent({ type: 'ready' });
      else if (event.type === 'turn.completed') {
        completed = true;
        r.onEvent({ type: 'usage', detail: event.usage, usage: codexTurnUsage(event.usage) });
      } else if (event.type === 'turn.failed') throw classifyError(event.error.message);
      else if (event.type === 'error') throw classifyError(event.message);
      else if (
        event.type === 'item.started' ||
        event.type === 'item.updated' ||
        event.type === 'item.completed'
      ) {
        const item = event.item;
        // Reasoning summaries stay inside the provider. Preserve observable tool work for handoffs.
        if (item.type !== 'reasoning' && item.type !== 'agent_message')
          r.onEvent({
            type: 'activity',
            detail: item,
            tool: ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(
              item.type,
            )
              ? { id: item.id, state: event.type === 'item.completed' ? 'completed' : 'started' }
              : undefined,
          });
        if (
          r.maxTurns &&
          event.type === 'item.completed' &&
          !['reasoning', 'agent_message'].includes(item.type) &&
          ++toolItems > r.maxTurns
        )
          throw new ProviderFailure(
            'budget',
            `Configured completed-tool budget exhausted (${r.maxTurns}); inspect partial artifacts`,
          );
        if (event.type === 'item.completed' && item.type === 'agent_message') {
          final = item.text;
          r.onEvent({ type: 'partial', detail: item.text });
        }
      }
    }
    if (!completed)
      throw new ProviderFailure('transient', 'Codex stream ended without turn.completed');
    return final;
  },
};
export function claudeEvent(message: unknown): ProviderEvent[] {
  const m = message as Record<string, any>;
  const events: ProviderEvent[] = [];
  if (m.type === 'system' && m.subtype === 'init')
    events.push({ type: 'session', sessionId: m.session_id });
  if (m.type === 'system' && m.subtype === 'status') events.push({ type: 'activity', detail: m });
  if (m.type === 'rate_limit_event' && m.rate_limit_info) {
    const info = m.rate_limit_info;
    const raw = info.resetsAt;
    events.push({
      type: 'quota',
      quota: {
        rejected: info.status === 'rejected',
        utilization:
          typeof info.utilization === 'number' &&
          Number.isFinite(info.utilization) &&
          info.utilization >= 0
            ? info.utilization
            : undefined,
        resetsAt:
          typeof raw === 'number' && Number.isFinite(raw)
            ? raw < 1e12
              ? raw * 1000
              : raw
            : undefined,
        bucket: info.rateLimitType,
      },
    });
  }
  if (m.type === 'assistant' || m.type === 'user') {
    const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
    for (const b of blocks)
      if (b.type === 'tool_use' || b.type === 'tool_result')
        events.push({
          type: 'activity',
          detail: b,
          tool:
            typeof (b.type === 'tool_use' ? b.id : b.tool_use_id) === 'string'
              ? {
                  id: b.type === 'tool_use' ? b.id : b.tool_use_id,
                  state: b.type === 'tool_use' ? 'started' : 'completed',
                  // Only tool_use carries the name; a tool_result is matched back by id.
                  ...(typeof b.name === 'string' ? { name: b.name } : {}),
                }
              : undefined,
        });
      else if (m.type === 'assistant' && b.type === 'text')
        events.push({ type: 'partial', detail: b.text });
  }
  if (
    m.type === 'system' &&
    [
      'task_started',
      'task_updated',
      'task_progress',
      'task_notification',
      'background_tasks_changed',
    ].includes(m.subtype)
  )
    events.push({ type: 'activity', detail: m });
  if (m.type === 'tool_progress') events.push({ type: 'activity', detail: m });
  if (m.type === 'result')
    events.push({
      type: 'usage',
      turnComplete: true,
      detail: {
        usage: m.usage,
        modelUsage: m.modelUsage,
        total_cost_usd: m.total_cost_usd,
        duration_ms: m.duration_ms,
      },
    });
  return events;
}
/** Recognize the CLI's generic refusal text. It is not evidence of a human
 * cancellation or proof of a particular CLI failure; the engine also checks its controls.
 */
export const PROVIDER_TOOL_REFUSAL =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
/** The text of an error tool_result, or undefined when the block is not one. The refused
 * call's own arguments are never returned; they can hold credentials.
 */
export function toolResultErrorText(detail: unknown): string | undefined {
  const block = detail as { type?: unknown; is_error?: unknown; content?: unknown } | null;
  if (!block || block.type !== 'tool_result' || block.is_error !== true) return undefined;
  const content = block.content;
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            (part as { type?: unknown; text?: unknown })?.type === 'text' &&
            typeof (part as { text?: unknown }).text === 'string'
              ? ((part as { text: string }).text as string)
              : '',
          )
          .join('')
      : '';
}
export function providerToolRefusal(detail: unknown): boolean {
  return toolResultErrorText(detail)?.startsWith(PROVIDER_TOOL_REFUSAL) ?? false;
}
export function createClaudeProvider(queryFn: typeof query = query): Provider {
  return {
    async run(r) {
      const usage = new ClaudeUsage(!!r.sessionId);
      const research = researchHooks(r);
      const refresh = new ContextRefresh(r);
      const initial = refresh.read();
      const compaction = compactionHooks(r, initial);
      const merged = mergeHooks(research.hooks, compaction.hooks) ?? {};
      // Before refreshedHooks wraps PreToolUse: its merge keeps the sandbox's updatedInput.
      const sandboxed = sandboxHooks(r, merged.PreToolUse);
      if (sandboxed) merged.PreToolUse = sandboxed;
      const hooks = {
        hooks: merged,
        close() {
          research.close();
          compaction.close();
        },
      };
      if (initial) refresh.useNativeInstructions(initial);
      let nativeId = r.sessionId ?? '';
      const reloadBase: HookCallback = async (event) => {
        if (event.hook_event_name === 'UserPromptSubmit' && !event.agent_id)
          inputStarted(input.startPrompt(event.prompt));
        const snapshot = refresh.read();
        const scope = ('agent_id' in event && event.agent_id) || 'lead';
        const compact = event.hook_event_name === 'SessionStart' && event.source === 'compact';
        if (compact && compaction.hooks) return {}; // The lifecycle hook restores only changes to the native instruction snapshot.
        if (!snapshot || (!compact && !refresh.changed(snapshot, scope))) return {};
        const additionalContext = refresh.text(snapshot, scope, compact);
        // A subagent's own conversation gets a change seen at a tool boundary as a user message:
        // the model reads it with the next tool result. Its Claude Code nested agents (agent_id),
        // prompt and compaction hooks keep the hook channel, and so does a turn that has ended,
        // where a message would start a new turn whose reply replaces the subagent's answer.
        if (
          r.subagent &&
          scope === 'lead' &&
          ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event.hook_event_name) &&
          !input.awaitingInput &&
          !r.controller.signal.aborted &&
          input.push(subagentUpdateMessage(additionalContext))
        ) {
          refresh.delivered(snapshot, event.session_id, scope);
          return {};
        }
        refresh.delivered(snapshot, event.session_id, scope);
        if (event.hook_event_name === 'PreToolUse')
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } };
        if (event.hook_event_name === 'PostToolUse')
          return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } };
        if (event.hook_event_name === 'PostToolUseFailure')
          return { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext } };
        if (event.hook_event_name === 'UserPromptSubmit')
          return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } };
        return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } };
      };
      const reload = compaction.profile?.wrap('context-refresh', reloadBase) ?? reloadBase;
      // Compose with the existing callback so both context and research restoration survive SDK
      // transports that address one callback ID at a time. Preserve validation/permission fields.
      const refreshedHooks = (
        event:
          | 'PreToolUse'
          | 'PostToolUse'
          | 'PostToolUseFailure'
          | 'UserPromptSubmit'
          | 'SessionStart',
      ) => {
        const entries = hooks.hooks?.[event] ?? [];
        if (!entries.length)
          return [{ ...(event === 'SessionStart' ? { matcher: 'compact' } : {}), hooks: [reload] }];
        return entries.map((entry, i) =>
          i
            ? entry
            : {
                ...entry,
                hooks: entry.hooks.map((callback, j) =>
                  j
                    ? callback
                    : ((async (...args) => {
                        const original = await callback(...args);
                        const update = await reload(...args);
                        if ('async' in original && original.async) return original;
                        if ('async' in update && update.async) return original;
                        const before =
                          'hookSpecificOutput' in original
                            ? original.hookSpecificOutput
                            : undefined;
                        const after =
                          'hookSpecificOutput' in update ? update.hookSpecificOutput : undefined;
                        if (!after) return original;
                        const additionalContext = [
                          before && 'additionalContext' in before ? before.additionalContext : '',
                          'additionalContext' in after ? after.additionalContext : '',
                        ]
                          .filter(Boolean)
                          .join('\n\n');
                        return {
                          ...original,
                          hookSpecificOutput: { ...before, ...after, additionalContext },
                        };
                      }) as HookCallback),
                ),
              },
        );
      };
      const input = new TurnStream(
        r.prompt,
        !!(r.research?.enabled && r.research.holdBackgroundTasks),
        r.inputReleaseGraceMs,
      );
      let final = '';
      // Result text otherwise reaches the engine only when the provider returns. An open
      // stream can start another turn first, so hand the unsent text over before it is replaced.
      // final=true when new input follows: the engine then reopens the reply for it. A result
      // replaced by a later result is sent as a plain reply so the later one stays the final.
      const flush = (asFinal: boolean) => {
        if (final.trim())
          r.onEvent({ type: 'result_text', detail: { text: final, final: asFinal } });
        final = '';
      };
      const inputStarted = (ids: string[]) => {
        if (!ids.length) return;
        flush(true);
        r.onEvent({ type: 'input_started', detail: { ids } });
      };
      r.attachInjector?.((ids, text) => {
        const afterResult = input.awaitingInput;
        // UserPromptSubmit reloads changed context through the hook channel. Never prepend a
        // standing snapshot to live user input: compaction may preserve that entire message.
        const ok = !r.controller.signal.aborted && input.push(text, ids);
        if (ok && afterResult) flush(true);
        r.onEvent({ type: 'injected', detail: { ids, ok } });
        return ok;
      });
      const closeInput = () => input.close();
      r.controller.signal.addEventListener('abort', closeInput, { once: true });
      const append = initial ? refresh.currentInstructions(initial) : r.instructions;
      let stream: ReturnType<typeof queryFn> | undefined;
      try {
        stream = queryFn({
          prompt: input,
          options: {
            cwd: r.cwd,
            maxTurns: r.maxTurns || undefined,
            maxBudgetUsd: r.maxBudgetUsd,
            // Consumption stamps arrive before generated tools and final replies.
            // Deltas stay out of portable history; complete messages are recorded below.
            includePartialMessages: true,
            hooks: {
              ...hooks.hooks,
              PreToolUse: refreshedHooks('PreToolUse'),
              PostToolUse: refreshedHooks('PostToolUse'),
              PostToolUseFailure: refreshedHooks('PostToolUseFailure'),
              UserPromptSubmit: refreshedHooks('UserPromptSubmit'),
              SessionStart: refreshedHooks('SessionStart'),
            },
            env: ownsDelegation(r)
              ? {
                  ...r.env,
                  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
                  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0',
                }
              : r.env,
            ...(ownsDelegation(r) ? { disallowedTools: nativeClaudeDelegationTools } : {}),
            resume: r.sessionId,
            model: r.account.model,
            effort: r.account.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
            pathToClaudeCodeExecutable: r.account.executable,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            canUseTool: permissionGate(r.onEvent, r.controller.signal),
            sandbox: { enabled: false },
            abortController: r.controller,
            systemPrompt: usesBasePrompt(r)
              ? `${basePrompt(r)}\n\n${append}`
              : { type: 'preset', preset: 'claude_code', append },
            extraArgs: { 'system-prompt-snapshot': 'off' },
            ...(r.contextRefresh && !r.toolless
              ? { settings: { claudeMdExcludes: nativeInstructionExcludes(r.contextRefresh) } }
              : {}),
            settingSources: r.toolless ? [] : ['user', 'project', 'local'],
            ...(r.toolless ? { strictMcpConfig: true } : {}),
            // `[]` removes every built-in tool; omitting it leaves the Claude Code preset in place.
            ...(r.toolless ? { tools: [] as string[] } : {}),
            stderr: (text) =>
              r.onEvent({
                type: 'diagnostic',
                detail: { event: 'claude_stderr', text: text.slice(-4000) },
              }),
            mcpServers: r.toolless
              ? {}
              : {
                  ...Object.fromEntries(
                    Object.entries(r.extraMcp ?? {}).map(([name, s]) => [
                      name,
                      { type: 'stdio' as const, command: s.command, args: s.args, env: s.env },
                    ]),
                  ),
                  clawstrum: { type: 'stdio', ...r.mcp },
                },
          },
        });
        let completed = false;
        try {
          for await (const message of stream) {
            if (['assistant', 'user', 'result', 'system'].includes(message.type)) {
              const raw = message as any;
              r.onEvent({
                type: 'history',
                detail: {
                  id: `claude:${raw.session_id ?? nativeId}:${raw.uuid ?? createHash('sha256').update(JSON.stringify(raw)).digest('hex')}`,
                  kind: 'provider_message',
                  source: raw.session_id ?? nativeId ?? '',
                  content: raw,
                  counted:
                    raw.type === 'assistant' ||
                    (raw.type === 'user' &&
                      Array.isArray(raw.message?.content) &&
                      raw.message.content.some((b: any) => b.type === 'tool_result')),
                },
              });
            }
            inputStarted(input.observe(message));
            if (message.type === 'system' && message.subtype === 'init') {
              nativeId = message.session_id;
              if (initial && !refresh.deliveredLead) refresh.delivered(initial, nativeId);
            }
            const snapshot = usage.observe(message);
            if (snapshot)
              r.onEvent({ type: 'usage', usage: snapshot, detail: { normalizedUsage: snapshot } });
            for (const event of claudeEvent(message)) {
              // The live task count travels with every event so the engine's silence watchdog
              // can see that a quiet turn is waiting on a background task it started.
              r.onEvent({ ...event, backgroundTasks: input.tasks.size });
              if (event.quota?.rejected)
                throw new ProviderFailure(
                  'quota',
                  'Claude subscription limit reached',
                  event.quota.resetsAt,
                  event.quota.bucket,
                );
            }
            if (message.type === 'assistant' && message.error) {
              const failure = classifyError(message.error);
              const explanation = (message.message?.content ?? [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n');
              throw new ProviderFailure(
                failure.kind,
                explanation ? `${message.error}: ${explanation}` : failure.message,
                failure.retryAt,
                failure.bucket,
              );
            }
            if (message.type === 'result') {
              // These are operator-configured limits, not outages or permission refusals.
              // Use the structured subtype rather than matching arbitrary provider error text.
              if (message.subtype === 'error_max_turns')
                throw new ProviderFailure(
                  'budget',
                  `Configured Claude turn limit reached${r.maxTurns ? ` (${r.maxTurns})` : ''}`,
                );
              if (message.subtype === 'error_max_budget_usd')
                throw new ProviderFailure('budget', 'Configured Claude dollar budget reached');
              if (message.subtype !== 'success')
                throw classifyError(message.errors.join('\n') || message.subtype);
              if (message.is_error) throw classifyError(message.result);
              completed = true;
              if (message.result.trim()) {
                flush(false);
                final = message.result;
              }
            }
          }
          if (!completed || input.hasUnfinishedInjection)
            throw new ProviderFailure(
              'transient',
              'Claude stream ended before all accepted input received a result',
            );
          return final;
        } finally {
          stream.close();
        }
      } finally {
        closeInput();
        r.controller.signal.removeEventListener('abort', closeInput);
        hooks.close();
      }
    },
  };
}
export const claudeProvider = createClaudeProvider();
export const providers: Record<Account['provider'], Provider> = {
  codex: codexProvider,
  claude: claudeProvider,
  gemini: geminiAcpProvider,
};
