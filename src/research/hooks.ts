import { printsSecret } from './secrets.js';
import { HookProfiler } from '../hook-profile.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookCallback, Options, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { canonicalPath } from '../config.js';
import { TurnStream } from '../turn-stream.js';
import type { ProviderRequest } from '../types.js';
import { Store } from '../store.js';
import { memoryBudgets } from '../context.js';
import { scanCitationWrite } from './citations.js';
import { previewEdit } from './edits.js';
import { invokesCommand, writeTargets } from './shell.js';
import { scanFigureWrite, scanProseWrite } from './lint.js';
import { dispatchRoleRefusal, orchestrationRefusal } from './dispatch.js';
import { WRITING_RULES_FILE, loadsWritingRules, writingGateRefusal } from './writing.js';
import { Recall } from './recall.js';
import { acquireFileHold, holdRefusal, nativeEditTarget, recordWorkerFile } from './file-holds.js';
import { historyPosition } from '../history.js';
import {
  gitAddPaths,
  isGitPush,
  isTexPath,
  paperChangesBetween,
  paperPushDecision,
  paperPushState,
  pushRepoDir,
  paperChangesVsUpstream,
  rebaseTree,
  repoTop,
  snapshotTree,
  upstreamBase,
} from './paper-push.js';
/** Advisory command recognition, not a shell parser or an access boundary. */
export function invokesSbatch(command: string): boolean {
  return invokesCommand(command, 'sbatch');
}
/** True if the command already starts (after leading whitespace) with `renice` or `nice `, so a
 * command that already sets its own priority is never prefixed a second time. */
export function alreadyNiced(command: string): boolean {
  return /^\s*(renice\b|nice\s)/.test(command);
}
/** `renice` on the call's own shell: it, and anything it starts, drop to `toolNice`; the daemon and
 * the lead/subagent `claude` processes that spawned this Bash tool call are untouched, and the next
 * Bash call starts a fresh shell back at nice 0. `toolNice` 0 disables the prefix entirely. */
export function nicedCommand(command: string, toolNice: number): string | undefined {
  if (!toolNice || alreadyNiced(command)) return undefined;
  return `renice -n ${toolNice} -p $$ >/dev/null 2>&1; ${command}`;
}
/** Write tools that name their target with a path this hook can resolve. */
const WRITE_PATHS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
};
const TEX_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
/** A gate has to answer, so an unresolvable path keeps the lexical reading rather than throwing. */
function resolved(target: string): string {
  try {
    return canonicalPath(target);
  } catch {
    return path.resolve(target);
  }
}
export function contains(root: string, target: string): boolean {
  const relative = path.relative(resolved(root), resolved(target));
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
}
function fileText(target: string): string {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
/** Findings are correctable when a single revision turn can resolve all of them. Attribution is;
 * escaping the permitted roots or overflowing a prompt budget is not, so neither may spend the
 * one-shot correction budget — both have to deny on every attempt.
 */
export interface Validation {
  issues: string[];
  correctable: boolean;
  /** The subset of issues that are routing refusals rather than content findings. They are reported
   * in `issues` like everything else; they are listed separately because research.workers
   * .enforceRoles decides their severity, not research.validation. */
  routing: string[];
  /** The subset of issues that may never deny, in any validation mode, and may never spend the
   * one-shot correction budget. Style and figure observations are reported so the agent has them
   * while the payload is still in hand; they are not grounds to refuse a write. Reported in
   * `issues` like everything else. */
  advisory: string[];
}
export function validationIssues(
  store: Store,
  config: NonNullable<ProviderRequest['research']>,
  tool: string,
  input: Record<string, any>,
  limits: {
    roots?: string[];
    budgets?: Record<string, number>;
    cwd?: string;
    worker?: boolean;
    /** Writing-rules files that exist on disk. Prose findings are reported only where one does. */
    writingRules?: string[];
  } = {},
): Validation {
  const issues: string[] = [];
  const hard: string[] = [];
  const roots = limits.roots ?? [];
  const target = input[WRITE_PATHS[tool] ?? ''];
  if (
    roots.length > 0 &&
    typeof target === 'string' &&
    path.isAbsolute(target) &&
    !roots.some((root) => contains(root, target))
  )
    hard.push(
      `${tool} targets ${target}, which is outside every permitted root (${roots.join(', ')}). Agents run with host permissions, so a write here is not contained by the session. Keep artifacts in the workspace, or add the root to research.writeRoots if it is genuinely shared.`,
    );
  const budget = typeof target === 'string' ? limits.budgets?.[target] : undefined;
  if (budget !== undefined && ['Write', 'Edit'].includes(tool)) {
    const original = fileText(target);
    const current = original.length;
    const proposed = tool === 'Write' ? String(input.content ?? '') : previewEdit(original, input);
    const projected = proposed?.length;
    if (projected !== undefined && projected > budget && projected > current)
      hard.push(
        `${path.basename(target)} is read back into the prompt fitted to ${budget} characters, and this write leaves it at about ${projected}. Past the budget the middle of the file is replaced by an outline plus the newest entries, so what you are adding costs you older entries silently. Evict superseded entries in the same write to stay under the budget.`,
      );
  }
  const routing: string[] = [];
  const dispatch =
    config.workers.enforceRoles === 'off'
      ? null
      : (dispatchRoleRefusal(config, tool, input, limits.worker ?? false) ??
        orchestrationRefusal(config, tool, input));
  if (dispatch) {
    hard.push(dispatch);
    routing.push(dispatch);
  }
  // A shell command's effect on file size is not computable without running it, so the rule while
  // already over budget is stricter than the measured one above: no shell writes at all. That is
  // safe to be strict about because the remedy, rewriting the file smaller, is a Write and stays
  // allowed. The message has to say so or the gate blocks its own fix.
  if (tool === 'Bash' && limits.budgets)
    for (const [budgeted, budget] of Object.entries(limits.budgets)) {
      const current = fileText(budgeted).length;
      if (current <= budget) continue;
      const writes = writeTargets(String(input.command ?? ''), path.basename(budgeted)).some(
        (token) => path.resolve(limits.cwd ?? '.', token) === budgeted,
      );
      if (writes)
        hard.push(
          `Refusing this shell write: ${path.basename(budgeted)} is ${current} characters, ${Math.round((current / budget) * 100)}% of the ${budget} it is fitted to when read back into the prompt. A shell command's effect on file size cannot be checked before it runs, so while the file is over budget it may only be changed through Write or Edit, which are measured. A shrinking rewrite is what is wanted here: evict superseded entries, compress what stays, and include whatever you were about to append in the same rewrite. Reading the file is unaffected.`,
        );
    }
  issues.push(...hard);
  if (tool === 'WebFetch' && typeof input.url === 'string') {
    try {
      const url = new URL(input.url);
      if (
        /\.pdf(?:$|\/)|\/arxiv\.org\/pdf\//i.test(url.pathname) ||
        (url.hostname === 'arxiv.org' && url.pathname.startsWith('/pdf/'))
      )
        issues.push(
          'Use research_paper for PDFs; it extracts full text on the host and records provenance.',
        );
      if (url.hostname === 'api.unpaywall.org' && !url.searchParams.has('email'))
        issues.push(
          'Unpaywall requires a contact email. Configure research.email and use research_paper.',
        );
    } catch {
      /* Let the provider handle malformed URLs. */
    }
  }
  if (['Write', 'Edit'].includes(tool)) {
    try {
      const scan = scanCitationWrite(store, tool, input);
      if (scan) issues.push(...scan.findings.map((f) => `Citation line ${f.line}: ${f.message}`));
    } catch (error) {
      issues.push(
        `Citation scan unavailable: ${String(error)}. Use research_citation action=scan with a bounded text excerpt.`,
      );
    }
  }
  if (config.slurm.enabled && tool === 'Bash' && invokesSbatch(String(input.command ?? '')))
    issues.push(
      'Use research_cluster preflight and submit for captured scripts, scheduler validation, deduplication and durable job watches. A raw sbatch command bypasses those records.',
    );
  // Last, so that bounding the feedback to ten issues drops observations before enforceable findings.
  const advisory: string[] = [];
  if (['Write', 'Edit'].includes(tool))
    try {
      for (const f of scanProseWrite(tool, input, limits.writingRules ?? []))
        advisory.push(`Prose line ${f.line}: ${f.message}`);
      for (const f of scanFigureWrite(tool, input))
        advisory.push(f.line ? `Figure line ${f.line}: ${f.message}` : `Figure: ${f.message}`);
    } catch (error) {
      // A gate has to answer. A linter that cannot read its own payload says so and stays advisory.
      advisory.push(`Write lint unavailable: ${String(error)}.`);
    }
  issues.push(...advisory);
  return {
    issues,
    correctable: !hard.length && ['Write', 'Edit'].includes(tool),
    routing,
    advisory,
  };
}
export function researchHooks(r: ProviderRequest): { hooks?: Options['hooks']; close(): void } {
  if (!r.research?.enabled || !r.mcp.env.CLAWSTRUM_HOME || !r.mcp.env.CLAWSTRUM_SESSION)
    return { close() {} };
  const config = r.research;
  const store = new Store(r.mcp.env.CLAWSTRUM_HOME);
  const profiler = new HookProfiler(store, r);
  const sessionId = r.mcp.env.CLAWSTRUM_SESSION;
  const run = r.mcp.env.CLAWSTRUM_RUN ?? null;
  // Lead only: a subagent is handed its brief and is not the one that loses track of what was found.
  let recall: Recall | undefined;
  if (config.recall.enabled && config.recall.maxNotices > 0 && !r.mcp.env.CLAWSTRUM_DELEGATION)
    try {
      recall = new Recall(store, sessionId, historyPosition(store, sessionId), config.recall);
    } catch (error) {
      r.onEvent({
        type: 'diagnostic',
        detail: { event: 'research_recall_failed', error: String(error) },
      });
    }
  let limits: { roots: string[]; budgets: Record<string, number>; cwd: string } | undefined;
  const writeLimits = () => {
    if (limits) return limits;
    try {
      const workspace = store.session(sessionId).workspace;
      return (limits = {
        roots: [workspace, store.home, os.tmpdir(), ...config.writeRoots].map((dir) =>
          path.resolve(dir),
        ),
        budgets: memoryBudgets(store.home, workspace),
        // Relative paths in a Bash command resolve against the session's working directory.
        cwd: path.resolve(workspace),
      });
    } catch (error) {
      // Without a workspace there is nothing to contain writes to; say so rather than deny everything.
      r.onEvent({
        type: 'diagnostic',
        detail: { event: 'write_limits_unavailable', error: String(error) },
      });
      return { roots: [], budgets: {}, cwd: process.cwd() };
    }
  };
  const nativeKey = (input: { session_id: string; agent_id?: string }) =>
    JSON.stringify([input.session_id, input.agent_id ?? 'lead']);
  let writingRules: string[] | undefined;
  const writingContexts = new Map<string, { satisfied: boolean; blocks: number }>();
  const writingContext = (input: { session_id: string; agent_id?: string }) => {
    const key = nativeKey(input);
    let state = writingContexts.get(key);
    if (!state) writingContexts.set(key, (state = { satisfied: false, blocks: 0 }));
    return state;
  };
  const writingRulePaths = () => {
    if (writingRules) return writingRules;
    const candidates = [
      path.join(writeLimits().cwd, WRITING_RULES_FILE),
      path.join(store.home, WRITING_RULES_FILE),
    ];
    return (writingRules = candidates.filter((file) => fs.existsSync(file)));
  };
  /** workers.review.paperPush has its own switch, so it runs before and apart from validation. */
  const paperPush = (
    input: Parameters<HookCallback>[0],
  ): { deny: boolean; reason: string } | undefined => {
    const mode = config.workers.review.paperPush;
    if (mode === 'off' || input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash')
      return undefined;
    // Checked on the lead's pushes only: the refusal's remedy is research_delegate, which subagents lack.
    if (r.mcp.env.CLAWSTRUM_DELEGATION || input.agent_id) return undefined;
    const command = String((input.tool_input as Record<string, unknown>)?.command ?? '');
    if (!isGitPush(command)) return undefined;
    const dir = pushRepoDir(command, input.cwd);
    const top = dir ? repoTop(dir) : null;
    const added = dir && top ? gitAddPaths(command, dir, top) : [];
    const triggers = dir && top ? paperChangesVsUpstream(dir, added) : null;
    // Only a push with triggers can need the retry or since-review comparison.
    const tree = top && triggers?.length ? snapshotTree(top, added) : null;
    const verdict = paperPushDecision({
      state: top
        ? paperPushState(store, sessionId, top)
        : { firstEditSeq: null, review: null, lastPushSeq: 0, lastPushTree: null, blocks: 0 },
      dir: dir ?? '(unresolved)',
      top,
      triggers,
      tree,
      sinceReview: top
        ? (review, to) => {
            // Co-author edits pulled since the review moved the merge-base; they are not edits since it.
            const nowBase = review.base ? upstreamBase(top) : null;
            const from =
              review.base && nowBase && nowBase !== review.base
                ? (rebaseTree(top, review.tree, review.base, nowBase) ?? review.tree)
                : review.tree;
            const triggers = paperChangesBetween(top, from, to);
            return triggers ? { triggers, from } : null;
          }
        : undefined,
      mode,
    });
    store.event(sessionId, run, 'research_paper_push_gate', {
      decision: verdict.decision,
      why: verdict.why,
      triggers,
      dir,
      top,
      tree,
    });
    return verdict.reason
      ? { deny: verdict.decision === 'deny', reason: verdict.reason }
      : undefined;
  };
  const validateTool = async (input: Parameters<HookCallback>[0]): Promise<SyncHookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const push = paperPush(input);
    if (push?.deny)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: push.reason,
        },
      };
    const pushAdvice: SyncHookJSONOutput = push
      ? {
          systemMessage: push.reason,
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: push.reason },
        }
      : {};
    if (config.validation === 'off') return pushAdvice;
    const toolInput = { ...(input.tool_input as Record<string, unknown>) };
    const pathKey = WRITE_PATHS[input.tool_name];
    if (pathKey && typeof toolInput[pathKey] === 'string')
      toolInput[pathKey] = path.resolve(input.cwd, toolInput[pathKey] as string);
    const writingState = writingContext(input);
    const {
      issues,
      correctable: revisable,
      routing,
      advisory,
    } = validationIssues(
      store,
      config,
      input.tool_name,
      toolInput,
      // The hook reports the tool call's own working directory, which is what a relative path in a
      // Bash command resolves against; the workspace is only the fallback.
      {
        ...writeLimits(),
        cwd: input.cwd,
        worker: !!r.mcp.env.CLAWSTRUM_DELEGATION || !!input.agent_id,
        writingRules: writingRulePaths(),
      },
    );
    const writing = writingGateRefusal({
      toolName: input.tool_name,
      target: typeof toolInput[pathKey ?? ''] === 'string' ? (toolInput[pathKey!] as string) : null,
      payload:
        typeof toolInput.content === 'string'
          ? toolInput.content
          : typeof toolInput.new_string === 'string'
            ? toolInput.new_string
            : undefined,
      rulesPaths: writingRulePaths(),
      satisfied: writingState.satisfied,
      blocksSoFar: writingState.blocks,
    });
    // Never correctable: the remedy is a Read, not a revision of the payload, so it must not be
    // able to spend the one-shot correction budget the citation findings use.
    if (writing) {
      writingState.blocks++;
      issues.unshift(writing);
    }
    const correctable = revisable && !writing;
    if (!issues.length) return pushAdvice;
    const budget = `research-write-review:${r.mcp.env.CLAWSTRUM_DELEGATION ?? run ?? input.session_id}:${input.agent_id ?? 'lead'}`;
    // Routing severity comes from workers.enforceRoles and content severity from validation, so the
    // two are decided separately rather than folded together: under the advisory default the strict
    // branch never runs, and a routing refusal still has to deny. A routing issue also lands in
    // `hard`, so it is never correctable and never spends the one-shot citation correction budget.
    const routed = routing.length > 0 && config.workers.enforceRoles === 'deny';
    // A write whose only findings are style observations reports them and proceeds, in every mode.
    // Without this the strict branch would deny on an em dash and spend the run's one correction on
    // it, leaving the next real citation error advisory.
    const enforceable = issues.length > advisory.length;
    const deny =
      routed ||
      (enforceable &&
        config.validation === 'strict' &&
        (!correctable ||
          store.transaction(() => {
            return (
              Number(
                store.exec('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)', budget, 'used')
                  .changes,
              ) > 0
            );
          })));
    const mode = routed ? 'routing' : config.validation;
    store.event(sessionId, run, 'research_validation', {
      tool: input.tool_name,
      agentId: input.agent_id,
      mode,
      issues,
      // Counted separately so it is answerable whether the linters ever fire, rather than inferred
      // from a hook that logs that it ran.
      advisory: advisory.length,
      blocked: deny,
    });
    const reason = `Clawstrum research ${mode}: ${issues.slice(0, 10).join(' ').slice(0, 5000)}${correctable && enforceable ? ' Citation writes get one correction opportunity per run and native agent; later issues remain advisory. Use research_citation action=scan for the full report.' : ''}`;
    const context = push ? `${push.reason}\n\n${reason}` : reason;
    return deny
      ? {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }
      : {
          systemMessage: context,
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context },
        };
  };
  const recallNotice = (input: Parameters<HookCallback>[0]): string | undefined => {
    if (!recall || input.hook_event_name !== 'PreToolUse' || input.agent_id) return undefined;
    try {
      return recall.consider(
        input.tool_name,
        input.tool_input as Record<string, unknown>,
        (detail) => store.event(sessionId, run, 'research_recall', detail),
      );
    } catch (error) {
      // Recall is an aid; a failed search must never stand between the model and its tool call.
      r.onEvent({
        type: 'diagnostic',
        detail: { event: 'research_recall_failed', error: String(error) },
      });
      return undefined;
    }
  };
  // Subagents only: the lead is never held. Independent of `validation`, like the paper-push gate.
  const delegation = config.workers.fileHolds ? r.mcp.env.CLAWSTRUM_DELEGATION : undefined;
  const fileHold = (input: Parameters<HookCallback>[0]): SyncHookJSONOutput | undefined => {
    if (!delegation || input.hook_event_name !== 'PreToolUse') return undefined;
    const target = nativeEditTarget(
      input.tool_name,
      input.tool_input as Record<string, unknown>,
      input.cwd,
    );
    if (!target) return undefined;
    const holder = acquireFileHold(store, delegation, target);
    if (!holder) return undefined;
    store.event(sessionId, run, 'research_file_hold_refused', {
      tool: input.tool_name,
      path: target,
      worker: delegation,
      holder: holder.holder,
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: holdRefusal(holder),
      },
    };
  };
  const validation = profiler.wrap('research.validation', validateTool);
  const preTool: HookCallback = async (input, toolUseId, options) => {
    if (input.hook_event_name === 'PreToolUse') {
      const secret = printsSecret(input.tool_name, input.tool_input as Record<string, unknown>);
      if (secret) {
        store.event(sessionId, run, 'secret_print_blocked', { tool: input.tool_name });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: secret,
          },
        };
      }
    }
    const result = (await validation(input, toolUseId, options)) as SyncHookJSONOutput;
    const output =
      result.hookSpecificOutput?.hookEventName === 'PreToolUse'
        ? result.hookSpecificOutput
        : undefined;
    if (output?.permissionDecision === 'deny') return result;
    // After validation, so an edit that validation refuses takes no hold.
    const held = fileHold(input);
    if (held) return held;
    const recallStarted = performance.now();
    const notice = recallNotice(input);
    if (recall && input.hook_event_name === 'PreToolUse' && !input.agent_id)
      profiler.record('research.recall', notice, performance.now() - recallStarted);
    // Every deny check above has passed. Lower the CPU priority of the command itself, never the
    // daemon or the agent process that issued it; leads and subagents both reach this path.
    let updatedInput: Record<string, unknown> | undefined;
    if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash') {
      const toolInput = input.tool_input as Record<string, unknown>;
      const command = typeof toolInput?.command === 'string' ? toolInput.command : undefined;
      const niced = command !== undefined ? nicedCommand(command, config.toolNice) : undefined;
      if (niced !== undefined) updatedInput = { ...toolInput, command: niced };
    }
    if (!notice && !updatedInput) return result;
    return {
      ...result,
      hookSpecificOutput: {
        ...output,
        hookEventName: 'PreToolUse',
        ...(updatedInput ? { permissionDecision: 'allow' as const, updatedInput } : {}),
        ...(notice
          ? { additionalContext: [output?.additionalContext, notice].filter(Boolean).join('\n\n') }
          : {}),
      },
    };
  };
  const postTool: HookCallback = async (input) => {
    if (delegation && input.hook_event_name === 'PostToolUse') {
      const target = nativeEditTarget(
        input.tool_name,
        input.tool_input as Record<string, unknown>,
        input.cwd,
      );
      if (target) recordWorkerFile(store, delegation, target, 'edit');
    }
    if (input.hook_event_name === 'PostToolUse' && TEX_EDIT_TOOLS.has(input.tool_name)) {
      const target = (input.tool_input as Record<string, unknown>)?.file_path;
      if (isTexPath(target))
        store.event(sessionId, run, 'research_tex_edit', {
          tool: input.tool_name,
          path: resolved(path.resolve(input.cwd, target as string)),
        });
    }
    // PreToolUse is only an attempt; a failed Read must not satisfy the writing-rules check.
    if (
      input.hook_event_name === 'PostToolUse' &&
      loadsWritingRules(
        input.tool_name,
        input.tool_input as Record<string, unknown>,
        writingRulePaths(),
        input.cwd,
      )
    )
      writingContext(input).satisfied = true;
    return {};
  };
  return {
    hooks: {
      PreToolUse: [{ hooks: [preTool] }],
      PostToolUse: [{ hooks: [profiler.wrap('research.post-tool', postTool)] }],
      SessionStart: [
        {
          matcher: 'compact',
          hooks: [
            profiler.wrap('research.session-start', async (input) => {
              if (input.hook_event_name === 'SessionStart' && input.source === 'compact')
                writingContexts.delete(nativeKey(input));
              return {};
            }),
          ],
        },
      ],
    },
    close() {
      profiler.close();
      store.close();
    },
  };
}
/** Compatibility wrapper for callers that only need background-task holding. */
export class BackgroundInput extends TurnStream {
  constructor(prompt: string, graceMs?: number) {
    super(prompt, true, graceMs);
  }
}
