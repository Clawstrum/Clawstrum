import type { Account, ProviderRequest } from './types.js';
import type { ResearchConfig } from './research/config.js';

/** Runtime facts, separate from editable behavioral policy. No credentials or per-turn IDs. */
export function harnessSetup(account: Account, research?: ResearchConfig, worker = false): string {
  const managed = !!research?.enabled && Object.keys(research.workers.roles).length > 0;
  const nativeDisabled = worker || (managed && research!.workers.enforceRoles === 'deny');
  return [
    'Clawstrum execution setup (runtime facts):',
    `Agent role: ${worker ? 'bounded subagent' : 'channel lead'}. Provider: ${account.provider}. Configured subscription account: ${account.id}. Requested model: ${account.model ?? 'provider default'}.`,
    `Provider adapter: ${{ claude: 'Claude Code Agent SDK', codex: 'Codex SDK / app-server', gemini: 'Antigravity CLI over ACP (Agent Client Protocol)' }[account.provider]}. Credentials come from the configured account profile, not an arbitrary default shell login. A failure in another profile does not establish this account’s authentication state.`,
    worker
      ? 'Subagent interface: report progress/results with research_subagent_update; further delegation goes back to the lead.'
      : managed
        ? 'Subagent interface: research_delegate(key, role, brief, provider?, model?, effort?, ...). Role models are defaults, not an allowed-model list. An explicit model needs its provider and is applied before subscription account/quota selection. Unavailable capacity leaves that route queued; provider authentication/model errors are reported by that route. Model support is established by the provider response.'
        : 'Managed subagent tools are unavailable in this request’s research configuration.',
    `Native provider delegation: ${nativeDisabled ? 'disabled by Clawstrum orchestration' : 'not disabled by Clawstrum orchestration'}. The managed subagent scheduler has only Claude/Codex/Gemini subscription adapters; it has no Bedrock or standalone shell-login fallback.`,
  ].join('\n');
}

/** This selects the delegation interface, not host permissions. Subagents are always leaves. */
export function ownsDelegation(
  r: Partial<Pick<ProviderRequest, 'research' | 'mcp' | 'toolless'>>,
): boolean {
  return (
    !!r.toolless ||
    !!r.mcp?.env.CLAWSTRUM_DELEGATION ||
    (!!r.research?.enabled &&
      r.research.workers.enforceRoles === 'deny' &&
      Object.keys(r.research.workers.roles).length > 0)
  );
}

export const nativeClaudeDelegationTools = [
  'Agent',
  'Task',
  'Workflow',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
];

export function codexOrchestrationConfig(
  r: Partial<Pick<ProviderRequest, 'research' | 'mcp' | 'toolless'>>,
) {
  return {
    ...(ownsDelegation(r) ? { 'features.multi_agent': false, 'agents.enabled': false } : {}),
    // Clawstrum supplies current file-backed policy. Native ancestor AGENTS discovery would
    // otherwise put the entire channel MEMORY back into an intentionally narrow subagent.
    ...(r.mcp?.env.CLAWSTRUM_DELEGATION ? { project_doc_max_bytes: 0 } : {}),
  };
}
