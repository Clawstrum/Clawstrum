import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

/**
 * After background work, the CLI starts turns nobody pushed: it delivers each finished task's
 * notification in a new turn, whose `system/init` arrives ~100 ms after the live set empties
 * (or after the result, when the task finished during a turn). Ending input under such a turn breaks it on CLI
 * 2.1.270+: SDK hook and canUseTool answers travel over stdin, so every tool call returns "The
 * user doesn't want to take this action right now" and the model stops to wait for a user.
 * Once a background task has been seen, the close therefore waits this long for such a turn.
 */
export const RELEASE_GRACE_MS = 10_000;

/**
 * Streaming SDK input: yields the prompt, then stays open so queued user messages can be
 * pushed into the live turn. Closes once every delivered turn has a result, nothing is
 * pending, no turn the CLI started itself is running and (when holdTasks) no observed
 * background task is still running.
 *
 * Background tasks are tracked whether or not holdTasks is set, because the engine's silence
 * watchdog reads the count to tell a turn waiting on a background task from a hung provider.
 */
export class TurnStream implements AsyncIterable<SDKUserMessage> {
  readonly tasks = new Set<string>();
  private taskSnapshotSeen = false;
  private pending: { text: string; ids: string[] }[];
  private outstanding = new Set<string>();
  private unstarted = new Map<string, { text: string; ids: string[] }>();
  private injected = 0;
  private resultSeen = false;
  private closed = false;
  private sawTasks = false;
  private cliTurn = false;
  private release?: ReturnType<typeof setTimeout>;
  private wake?: () => void;
  constructor(
    prompt: string,
    readonly holdTasks = false,
    readonly graceMs = RELEASE_GRACE_MS,
  ) {
    this.pending = [{ text: prompt, ids: [] }];
  }
  push(text: string, ids: string[] = []): boolean {
    if (this.closed) return false;
    this.cancelRelease();
    this.injected++;
    this.pending.push({ text, ids: [...ids] });
    this.wake?.();
    return true;
  }
  get hasUnfinishedInjection(): boolean {
    return this.injected > 0 && (this.pending.length > 0 || this.outstanding.size > 0);
  }
  get awaitingInput(): boolean {
    return this.resultSeen && !this.outstanding.size && !this.pending.length;
  }
  /** UserPromptSubmit also runs for input folded into an active typed turn,
   * which does not receive another UUID-stamped assistant frame. Match only
   * complete submitted prompts (or their exact newline-joined batch), never IDs
   * or snippets extracted from user-controlled prose. */
  startPrompt(prompt: string): string[] {
    const pending = [...this.unstarted];
    for (let start = 0; start < pending.length; start++) {
      let combined = '';
      const uuids: string[] = [];
      for (let i = start; i < pending.length; i++) {
        const [uuid, input] = pending[i]!;
        combined += (i === start ? '' : '\n') + input.text;
        uuids.push(uuid);
        if (combined === prompt) return this.start(uuids);
        if (!prompt.startsWith(combined + '\n')) break;
      }
    }
    return [];
  }
  private start(uuids: unknown[]): string[] {
    const ids: string[] = [];
    for (const uuid of uuids) {
      if (typeof uuid !== 'string') continue;
      ids.push(...(this.unstarted.get(uuid)?.ids ?? []));
      this.unstarted.delete(uuid);
    }
    return ids;
  }
  observe(message: unknown) {
    const m = message as Record<string, any>;
    const started: string[] = [];
    // A transport receipt is not model consumption. The pinned CLI stamps the
    // first lead stream/assistant frame with the prompt UUIDs consumed in its batch.
    // Prefer the first stream frame: a complete tool-use block may already have
    // executed by the time its assistant message arrives. Ignore subagents and repeats.
    if ((m.type === 'assistant' || m.type === 'stream_event') && !m.parent_tool_use_id) {
      const uuids = Array.isArray(m.user_message_uuids) ? m.user_message_uuids : [];
      started.push(...this.start([...uuids, m.user_message_uuid]));
    }
    if (m.type === 'system' && m.subtype === 'background_tasks_changed' && Array.isArray(m.tasks)) {
      // The SDK does not order snapshots relative to task start/finish events. Once
      // available, this per-process level signal is authoritative; mixing in late
      // bookends can resurrect a finished task or delete one from a newer snapshot.
      this.taskSnapshotSeen = true;
      this.tasks.clear();
      for (const task of m.tasks)
        if (typeof task?.task_id === 'string' && task.task_id) this.tasks.add(task.task_id);
    } else if (
      !this.taskSnapshotSeen &&
      m.type === 'system' &&
      typeof m.task_id === 'string' &&
      m.task_id
    ) {
      // Older CLIs may only emit bookends. Track a later foreground-to-background
      // transition too, without treating foreground task registration as a wait.
      if (m.subtype === 'task_started' && m.is_backgrounded) this.tasks.add(m.task_id);
      if (m.subtype === 'task_updated') {
        if (m.patch?.is_backgrounded === true) this.tasks.add(m.task_id);
        if (
          m.patch?.is_backgrounded === false ||
          ['completed', 'failed', 'killed', 'stopped'].includes(m.patch?.status)
        )
          this.tasks.delete(m.task_id);
      }
      if (
        m.subtype === 'task_notification' &&
        ['completed', 'failed', 'stopped'].includes(m.status)
      )
        this.tasks.delete(m.task_id);
    }
    if (
      !m.parent_tool_use_id &&
      this.awaitingInput &&
      (m.type === 'assistant' ||
        m.type === 'stream_event' ||
        (m.type === 'system' && m.subtype === 'init'))
    )
      this.cliTurn = true;
    if (this.tasks.size) this.sawTasks = true;
    if (m.type === 'result') {
      this.resultSeen = true;
      this.cliTurn = false;
      // The CLI can coalesce several sends into one result. Its acknowledgements
      // identify the completed inputs without consuming a newer, racing send.
      if (Array.isArray(m.user_message_uuids) || typeof m.user_message_uuid === 'string') {
        const ids = Array.isArray(m.user_message_uuids) ? m.user_message_uuids : [];
        for (const id of [...ids, m.user_message_uuid])
          if (typeof id === 'string') {
            this.outstanding.delete(id);
            this.unstarted.delete(id);
          }
      } else if (m.num_turns !== 0) {
        // Resume can first report an uncorrelated, zero-turn background catch-up.
        // It did not answer our prompt, even if the SDK has already read that prompt.
        // Older producers omit correlation IDs. Preserve the conservative FIFO
        // fallback; extra background results cannot prepay a future message.
        const first = this.outstanding.values().next().value;
        if (first) {
          this.outstanding.delete(first);
          this.unstarted.delete(first);
        }
      }
    }
    if (!this.canClose()) this.cancelRelease();
    else if (!this.sawTasks || this.tasks.size) this.close();
    else if (!this.release)
      this.release = setTimeout(() => {
        this.release = undefined;
        if (this.canClose()) this.close();
      }, this.graceMs);
    return started;
  }
  private canClose() {
    return (
      !this.closed && this.awaitingInput && !this.cliTurn && (!this.holdTasks || !this.tasks.size)
    );
  }
  private cancelRelease() {
    if (this.release) clearTimeout(this.release);
    this.release = undefined;
  }
  close() {
    this.cancelRelease();
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (!this.closed && this.pending.length) {
        const uuid = randomUUID();
        const next = this.pending.shift()!;
        this.outstanding.add(uuid);
        if (next.ids.length) this.unstarted.set(uuid, next);
        yield {
          type: 'user',
          uuid,
          message: { role: 'user', content: next.text },
          parent_tool_use_id: null,
          session_id: '',
        };
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        if (this.closed || this.pending.length) resolve();
      });
      this.wake = undefined;
    }
  }
}
