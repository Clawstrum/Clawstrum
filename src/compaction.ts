import { HookProfiler } from './hook-profile.js';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { Store } from './store.js';
import type { ProviderRequest } from './types.js';
import {
  observeMemory,
  ensureMemory,
  updateMemory,
  compactionSectionBody,
  COMPACTION_SECTION,
  COMPACTION_SUMMARY_CAP,
} from './memory.js';
import { archiveRecord, historyHash, historyPosition, historyRoot } from './history.js';
import { readInstructionSnapshot, snapshotUpdate, hookContext } from './instructions.js';

export { COMPACTION_SUMMARY_CAP };

/** Metadata key the engine reads as "run a memory pass for this channel when it is idle". It is a
 * separate key from `consolidation:<session>`, which holds the progress of a pass in flight. */
export function consolidationRequestKey(sessionId: string): string {
  return `consolidation-request:${sessionId}`;
}

/** One preservation/restoration hook, independent of research tools and model summarization. */
export function compactionHooks(
  r: ProviderRequest,
  nativeSnapshot = r.contextRefresh?.snapshot,
): { hooks?: Options['hooks']; profile?: HookProfiler; close(): void } {
  const home = r.mcp.env.CLAWSTRUM_HOME,
    sessionId = r.mcp.env.CLAWSTRUM_SESSION;
  if (!home || !sessionId || r.toolless) return { close() {} };
  // A Clawstrum subagent runs under the channel's session id, so its own native compaction fires
  // these same hooks. Its summary is archived but must never replace the lead's MEMORY section
  // or queue a pass that rotates the lead's session.
  const delegation = r.mcp.env.CLAWSTRUM_DELEGATION;
  const isWorker = !!delegation || r.subagent === true;
  const store = new Store(home);
  const profiler = new HookProfiler(store, r);
  ensureMemory(store, null);
  ensureMemory(store, sessionId);
  const compacted = new Map<string, { confirmed: boolean; restored: boolean }>();
  const key = (input: { session_id: string; agent_id?: string }) =>
    JSON.stringify([input.session_id, input.agent_id ?? 'lead']);
  const record = (input: any, phase: string) => {
    const shared = observeMemory(store, null);
    const channel = observeMemory(store, sessionId);
    if (input.transcript_path && fs.existsSync(input.transcript_path)) {
      const raw = fs.readFileSync(input.transcript_path, 'utf8');
      // Native transcripts usually grow by appending, and long sessions compact many
      // times, so archiving the whole file on every hook stores the same prefix
      // again and again, and those copies can come to dominate the database.
      // Archive only the part no earlier record covers. Offsets are UTF-16 lengths, the unit slice() uses.
      const mark = `native-transcript-archived:${JSON.stringify([sessionId, input.session_id, input.agent_id ?? 'lead', input.transcript_path])}`;
      let stored: { length?: number; hash?: string } | undefined;
      try {
        stored =
          JSON.parse(
            store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', mark)?.value ??
              'null',
          ) ?? undefined;
      } catch {
        /* An invalid cursor is rebuilt from the complete source. */
      }
      const start =
        stored &&
        Number.isSafeInteger(stored.length) &&
        stored.length! > 0 &&
        stored.length! <= raw.length &&
        historyHash(raw.slice(0, stored.length)) === stored.hash
          ? stored.length!
          : 0;
      const hash = historyHash(raw);
      const tail = raw.slice(start);
      if (tail.length > 0) {
        store.transaction(() => {
          archiveRecord(store, {
            id: `native-transcript:${sessionId}:${input.session_id}:${hash}`,
            sessionId,
            kind: 'native_transcript',
            source: input.transcript_path,
            content: tail,
          });
          store.exec(
            'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            mark,
            JSON.stringify({ length: raw.length, hash }),
          );
        });
      }
    }
    archiveRecord(store, {
      id: `compaction:${randomUUID()}`,
      sessionId,
      kind: 'compaction',
      source: input.session_id,
      content: {
        phase,
        agent: input.agent_id,
        sharedRevision: shared.revision,
        channelRevision: channel.revision,
        historyPosition: historyPosition(store, sessionId),
      },
    });
  };
  const restore = async (agentId?: string) => {
    const snapshot = readInstructionSnapshot({
      ...r.contextRefresh?.sources,
      home,
      workspace: store.session(sessionId).workspace,
      profile: r.account.home,
      maxChars: Number.MAX_SAFE_INTEGER,
    });
    const update = snapshotUpdate(snapshot, agentId ? undefined : nativeSnapshot);
    return `CLAWSTRUM_CONTEXT_UPDATE\nNative compaction completed. Standing instructions and MEMORY remain in the native system/developer instructions. Superseded detail remains historical evidence in ${historyRoot(store, sessionId)}. Use history search/list/read for missing information.\n${hookContext(update, r.cwd)}`;
  };
  // The lead's own compaction summary goes into the channel AGENTS.md, so the next session reads
  // it from the file whatever happens to this one. PostCompact cannot return text to the model
  // (the SDK gives it no hookSpecificOutput), but it can run code, and this is that code. The
  // section is replaced, never appended to, under the same memory lock memory_update uses. A
  // failed write is recorded in history and does not stop the compaction.
  const writeSummarySection = (input: any, summary: string) => {
    try {
      updateMemory(store, sessionId, {
        [COMPACTION_SECTION]: compactionSectionBody({ summary, trigger: input.trigger }),
      });
    } catch (error) {
      archiveRecord(store, {
        id: `compaction-memory-error:${randomUUID()}`,
        sessionId,
        kind: 'compaction_memory_error',
        source: input.session_id,
        content: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  };
  // Archive what the provider kept, write the lead's summary into MEMORY and ask for a memory
  // pass. The engine runs the pass when the channel is idle; it merges the section into the other
  // MEMORY sections, clears it, and starts the next turn in a fresh native session.
  const keepSummary = (input: any) => {
    const summary = typeof input.compact_summary === 'string' ? input.compact_summary.trim() : '';
    if (!summary) return;
    const content = `Native compaction summary. Agent: ${input.agent_id ?? (isWorker ? `subagent ${delegation ?? ''}`.trim() : 'lead')}. Trigger: ${input.trigger ?? 'unknown'}.\n\n${summary}`;
    // The id covers the whole text, so a repeated hook is one record and a different agent or
    // trigger with the same summary is not a conflicting write.
    archiveRecord(store, {
      id: `compaction-summary:${sessionId}:${input.session_id}:${historyHash(content)}`,
      sessionId,
      kind: 'compaction_summary',
      source: input.session_id,
      content,
    });
    if (input.agent_id || isWorker) return;
    writeSummarySection(input, summary);
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      consolidationRequestKey(sessionId),
      JSON.stringify({ reason: 'compaction', trigger: input.trigger, at: Date.now() }),
    );
  };
  const pre: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreCompact') return {};
    compacted.set(key(input), { confirmed: false, restored: false });
    record(input, 'before');
    return {};
  };
  const post: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostCompact') return {};
    keepSummary(input);
    compacted.set(key(input), {
      confirmed: true,
      restored: compacted.get(key(input))?.restored ?? false,
    });
    record(input, 'after');
    return {};
  };
  const start: HookCallback = async (input) => {
    if (input.hook_event_name !== 'SessionStart' || input.source !== 'compact') return {};
    compacted.set(key(input), { confirmed: true, restored: true });
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: await restore(input.agent_id),
      },
    };
  };
  const tool: HookCallback = async (input) => {
    const state = compacted.get(key(input));
    if (input.hook_event_name !== 'PreToolUse' || !state?.confirmed || state.restored) return {};
    state.restored = true;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: await restore(input.agent_id),
      },
    };
  };
  return {
    profile: profiler,
    hooks: {
      PreCompact: [{ hooks: [profiler.wrap('compaction.before', pre)] }],
      PostCompact: [{ hooks: [profiler.wrap('compaction.after', post)] }],
      SessionStart: [{ matcher: 'compact', hooks: [profiler.wrap('compaction.restore', start)] }],
      PreToolUse: [{ hooks: [profiler.wrap('compaction.restore-fallback', tool)] }],
    },
    close() {
      profiler.close();
      store.close();
    },
  };
}

/** Merge callback results so transports invoking one callback ID do not drop earlier context. */
export function mergeHooks(first: Options['hooks'], second: Options['hooks']): Options['hooks'] {
  const out: Options['hooks'] = { ...first };
  for (const name of Object.keys(second ?? {}) as Array<keyof NonNullable<Options['hooks']>>) {
    const callbacks = [...(first?.[name] ?? []), ...(second?.[name] ?? [])].flatMap((e) => e.hooks);
    const callback: HookCallback = async (...args) => {
      let result: any = {};
      for (const invoke of callbacks) {
        const next = await invoke(...args);
        if ('async' in next && next.async) continue;
        const context = [
          result.hookSpecificOutput?.additionalContext,
          (next as any).hookSpecificOutput?.additionalContext,
        ]
          .filter(Boolean)
          .join('\n\n');
        result = {
          ...result,
          ...next,
          hookSpecificOutput: { ...result.hookSpecificOutput, ...(next as any).hookSpecificOutput },
        };
        if (context) result.hookSpecificOutput.additionalContext = context;
        if (!Object.keys(result.hookSpecificOutput).length) delete result.hookSpecificOutput;
      }
      return result;
    };
    out[name] = [{ ...(name === 'SessionStart' ? { matcher: 'compact' } : {}), hooks: [callback] }];
  }
  return out;
}
