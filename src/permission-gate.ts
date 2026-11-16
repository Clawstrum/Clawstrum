import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderEvent } from './types.js';

/** Clawstrum's configured host policy is full access. Answer headless permission
 * requests explicitly, including CLI checks that still ask in bypass mode.
 * Cancellation wins; no persistent permission rules or tool inputs are rewritten.
 */
export function permissionGate(
  onEvent?: (event: ProviderEvent) => void,
  turnSignal?: AbortSignal,
): CanUseTool {
  return async (toolName, input, options) => {
    if (turnSignal?.aborted || options.signal.aborted)
      return { behavior: 'deny', message: 'This operation was cancelled.', interrupt: true };
    // Tool arguments, paths and free-form reasons can contain credentials. Record
    // the decision and tool identity only; diagnostics must not change the decision.
    try {
      onEvent?.({
        type: 'diagnostic',
        detail: { event: 'permission_gate_allowed', tool: toolName },
      });
    } catch {
      /* Best-effort diagnostics. */
    }
    return { behavior: 'allow', updatedInput: input };
  };
}
