import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { Store } from './store.js';
import type { ProviderRequest } from './types.js';
import { timeKey } from './usage-ledger.js';
import { HOOK_PREFIX, type HookUsage } from './usage-profile.js';

/** No extra model work and no write per tool call. Aggregate until close or 30 seconds of activity.
 * Monitoring failure is diagnostic only and cannot block the original tool. */
export class HookProfiler {
  private readonly id = randomUUID();
  private rows = new Map<string, HookUsage>();
  private lastFlush = Date.now();
  private closed = false;
  constructor(
    readonly store: Store,
    readonly request: ProviderRequest,
  ) {}
  record(hook: string, result: unknown, durationMs = 0, error = false): void {
    if (this.closed) return;
    const now = Date.now();
    const row = this.rows.get(hook) ?? {
      at: now,
      sessionId: this.request.mcp.env.CLAWSTRUM_SESSION!,
      runId: this.request.mcp.env.CLAWSTRUM_RUN,
      workerId: this.request.mcp.env.CLAWSTRUM_DELEGATION,
      hook,
      checks: 0,
      responses: 0,
      blocks: 0,
      errors: 0,
      emittedChars: 0,
      durationMs: 0,
    };
    const value = result as any;
    const texts = [
      typeof result === 'string' ? result : undefined,
      value?.systemMessage,
      value?.reason,
      value?.hookSpecificOutput?.additionalContext,
      value?.hookSpecificOutput?.permissionDecisionReason,
    ].filter((x): x is string => typeof x === 'string' && x.length > 0);
    row.checks++;
    row.responses += Number(texts.length > 0);
    row.emittedChars += [...new Set(texts)].reduce((n, s) => n + s.length, 0);
    row.blocks += Number(
      value?.hookSpecificOutput?.permissionDecision === 'deny' || value?.decision === 'block',
    );
    row.durationMs += durationMs;
    row.errors += Number(error);
    row.at = now;
    this.rows.set(hook, row);
    if (now - this.lastFlush >= 30000) this.flush();
  }
  wrap(hook: string, callback: HookCallback): HookCallback {
    return async (...args) => {
      const start = performance.now();
      try {
        const result = await callback(...args);
        this.record(hook, result, performance.now() - start);
        return result;
      } catch (error) {
        this.record(hook, undefined, performance.now() - start, true);
        throw error;
      }
    };
  }
  flush(): void {
    if (!this.rows.size) return;
    this.lastFlush = Date.now();
    try {
      this.store.transaction(() => {
        for (const row of this.rows.values())
          this.store.exec(
            'INSERT INTO metadata(key,value) VALUES(?,?)',
            timeKey(HOOK_PREFIX, row.at) + this.id + ':' + row.hook + ':' + randomUUID(),
            JSON.stringify(row),
          );
      });
      this.rows.clear();
      this.lastFlush = Date.now();
    } catch (error) {
      try {
        this.request.onEvent({
          type: 'diagnostic',
          detail: { event: 'hook_profile_unavailable', error: String(error) },
        });
      } catch {
        /* Telemetry cannot deny the original tool. */
      }
    }
  }
  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }
}
