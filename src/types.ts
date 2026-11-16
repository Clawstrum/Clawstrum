export type ProviderName = 'claude' | 'codex' | 'gemini';
export interface Account {
  id: string;
  /** Who owns the subscription, a short label and free notes; for people and the Accounts prompt section, never secret. */
  owner?: string;
  label?: string;
  notes?: string;
  /** Higher priorities are exhausted before lower ones in automatic routing. */
  priority?: number;
  provider: ProviderName;
  home: string;
  model?: string;
  quotaBuckets?: string[];
  modelFallbacks?: Array<{ model: string; quotaBuckets: string[] }>;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  tokenEnv?: string;
  executable?: string;
  maxConcurrent?: number;
}
export interface Attachment {
  name: string;
  url: string;
  size: number;
  contentType?: string;
  path?: string;
  error?: string;
  attempts?: number;
  /** Voice notes only, when config.voice is enabled (src/voice.ts). */
  transcript?: string;
  transcriptNote?: string;
  transcriptError?: string;
  durationS?: number;
}
export interface Session {
  id: string;
  channel_id: string;
  workspace: string;
  preferred_account: string | null;
  active_account: string | null;
  active_model: string | null;
  remote_id: string | null;
  fingerprint: string | null;
  created_at: number;
}
export interface Inbound {
  id: string;
  session_id: string;
  author: string;
  content: string;
  attachments: string;
  kind: 'user' | 'task';
  status: string;
  attempts: number;
  batch_id: string | null;
  interruptions: number;
  available_at: number;
  created_at: number;
}
export interface Run {
  id: string;
  session_id: string;
  message_ids: string;
  status: string;
  final_sent: number;
  logical_id: string;
  config_json: string | null;
}
export interface Outbound {
  dedupe_key?: string | null;
  origin?: 'agent' | 'notice' | 'worker' | 'provider';
  id: string;
  session_id: string;
  run_id: string | null;
  content: string;
  file_path: string | null;
  status: string;
  attempts: number;
  available_at: number;
  created_at: number;
  remote_id: string | null;
}
export interface NoticeThread {
  messageId: string;
  /** Optional notices can disappear when threads are unavailable; actionable notices cannot. */
  fallback: 'channel' | 'skip';
}
export interface ProviderEvent {
  type:
    | 'history'
    | 'ready'
    | 'session'
    | 'activity'
    | 'usage'
    | 'quota'
    | 'partial'
    | 'diagnostic'
    | 'injected'
    | 'input_started'
    | 'result_text'
    | 'context_updated'
    | 'completed';
  sessionId?: string;
  /** A native turn result; the provider may remain open for background work. */
  turnComplete?: boolean;
  /** Observable execution lifecycle; a tool invocation may be quiet while it is still running. */
  tool?: { id: string; state: 'started' | 'completed'; name?: string };
  /** Live background tasks after this message. A turn waiting on one is not a silent turn. */
  backgroundTasks?: number;
  usage?: import('./usage.js').UsageSnapshot;
  detail?: unknown;
  quota?: { rejected: boolean; utilization?: number; resetsAt?: number; bucket?: string };
}
export interface ProviderRequest {
  /** Harness-owned accounting scope for tool-free maintenance; never prompt material. */
  usageScope?: string;
  /** Interactive lead turns may use a provider transport that supports live input. */
  liveInput?: boolean;
  research?: import('./research/config.js').ResearchConfig;
  maxTurns?: number;
  /** Claude's native estimated-cost cap, not a subscription billing limit. */
  maxBudgetUsd?: number;
  account: Account;
  prompt: string;
  instructions: string;
  /** File-backed context, refreshed without discarding the native conversation. */
  contextRefresh?: import('./instructions.js').InstructionRefresh;
  /** A Clawstrum subagent's own run. Claude delivers its changed context as a user message,
   * because a subagent treats text inside tool output as untrusted. */
  subagent?: boolean;
  /** Lead run in the main channel (discord.channelIds[0]) or a thread under it: it gets the main-channel base prompt. */
  mainChannel?: boolean;
  /** The subagent's role (research.workers.roles key). */
  role?: string;
  /** config.sandbox plus the paths its hide list needs; applied to Claude subagent runs. */
  sandbox?: import('./config.js').Config['sandbox'] & { accountHomes: string[]; workspace: string };
  cwd: string;
  sessionId?: string;
  controller: AbortController;
  env: Record<string, string>;
  mcp: { command: string; args: string[]; env: Record<string, string> };
  /** Owner-configured tool servers from config.mcpServers, given to lead turns only. */
  extraMcp?: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  /** A call that must produce text and nothing else: no built-in tools, no Clawstrum MCP server, no
   * network or filesystem write access. Maintenance passes run against the live conversation's
   * identifiers with permissions bypassed, so a pass that drifts into calling `send_message` posts
   * to the user's channel. `maxTurns` does not prevent that — a tool runs before the turn is
   * counted. Only removing the tools does.
   */
  toolless?: boolean;
  onEvent: (event: ProviderEvent) => void;
  /** Register live input transport. A true return still requires an `injected` event with {ids, ok}; absent without streaming support. */
  attachInjector?: (inject: (ids: string[], text: string) => boolean) => void;
  abortGraceMs?: number;
  /** Claude streaming input: wait after background work before closing stdin. */
  inputReleaseGraceMs?: number;
  blockedVersions?: Array<{ provider: ProviderName; version: string; reason: string }>;
}
export interface Provider {
  run(request: ProviderRequest): Promise<string>;
}
