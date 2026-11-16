import type { ResearchConfig } from './config.js';

/** Compatibility hook for native dispatch attempts. Default provider configuration removes
 * these tools; the hook also supports operators explicitly choosing advisory native routing.
 * Shared role routing and telemetry belong to research_delegate, regardless of provider defaults.
 */
const DISPATCH_TOOLS = new Set(['Task', 'Agent']);

export function roleMenu(config: ResearchConfig): string {
  return Object.entries(config.workers.roles)
    .map(
      ([name, role]) =>
        `  ${name} (${role.models.claude ?? 'default model'}, ${role.effort} effort, ${role.maxTurns ? `${role.maxTurns} turns` : 'no step limit'}) — ${role.description}`,
    )
    .join('\n');
}
/**
 * Orchestration tools fan out through a script, not through research_delegate, so none of the
 * research profile's controls apply to the agents they spawn: not the roles, not workers.maxConcurrent
 * (2 by default, against a workflow's own cap of about 16), not workers.timeoutMs, not the result
 * artifacts, not the deduplication key, and not the wake-the-lead review path. Such a dispatch is outside the shared subagent lifecycle. There is no partial form to allow, because a script has no way to name a
 * configured role, so the refusal is total and says what to use instead.
 */
export function orchestrationRefusal(
  config: ResearchConfig,
  tool: string,
  input: Record<string, any>,
): string | null {
  if (tool !== 'Workflow') return null;
  const phases = typeof input.script === 'string' ? input.script.match(/\bphase\(/g)?.length : null;
  const roles = Object.keys(config.workers.roles);
  if (!roles.length) return null;
  return (
    `Refusing this workflow${phases ? ` (${phases} phases)` : ''}: a workflow script fans out through its own agents, so none of the research controls reach them. They take no configured role, ignore the workers.maxConcurrent limit of ${config.workers.maxConcurrent}${config.workers.timeoutMs ? ` and the ${Math.round(config.workers.timeoutMs / 1000)}s subagent timeout` : ''}, are not in the lead's progress checks, write no result artifact and never wake the lead to review what they returned. ` +
    `Decompose it yourself and queue the independent pieces with research_delegate, which does all of that. Keep the sequencing in your own turn, where you can read each result before choosing the next step.`
  );
}
/** Null when the call is not a dispatch, or the configuration has no roles to route it to. */
export function dispatchRoleRefusal(
  config: ResearchConfig,
  tool: string,
  input: Record<string, any>,
  isWorker: boolean,
): string | null {
  if (!DISPATCH_TOOLS.has(tool)) return null;
  const roles = Object.keys(config.workers.roles);
  if (!roles.length) return null;
  if (isWorker)
    return `Refusing this dispatch: a subagent does not spawn further subagents. Nested delegation is not exposed through research_delegate either, for the same reason — it puts work two contexts away from the lead that has to synthesize it. Return the further work you have identified in your result and let the lead decide whether to delegate it.`;
  const named = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : '';
  return (
    `Refusing this dispatch: ${named ? `native subagent_type '${named}' does not apply the Clawstrum role configuration` : 'it names no subagent_type, so it would run as the generic subagent'}. Native dispatch bypasses Clawstrum's role model, task budget, progress records and result review. Use research_delegate with one of these roles:\n${roleMenu(config)}\n` +
    `Re-issue as research_delegate with role, a narrow brief and the source paths you already know. If none of the roles fits, the work is the lead's to do inline.`
  );
}
