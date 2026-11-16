// Worker shell sandbox (config.sandbox.workers). A subagent reads text nobody here wrote and acts on it with the
// daemon user's rights, so its Bash calls are rewritten to run inside scripts/worker-sandbox.sh (bubblewrap), and
// its file tools, which run inside the CLI outside any sandbox, are refused on the paths the sandbox hides.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { mergeHooks } from './compaction.js';
import { expandPath } from './config.js';
import { printsSecret } from './research/secrets.js';
import { storagePolicy } from './storage.js';
import type { ProviderRequest } from './types.js';

export const SANDBOX_SCRIPT = fileURLToPath(
  new URL('../scripts/worker-sandbox.sh', import.meta.url),
);

export interface SandboxContext {
  role: string;
  cwd: string;
  /** CLAWSTRUM_HOME */
  home: string;
  storageDir: string;
  workspace: string;
  accountHomes: string[];
  writable: string[];
  offline: boolean;
  userHome: string;
}

/** What keyPathReason checks a path against. */
export type KeyPlaces = Pick<
  SandboxContext,
  'home' | 'storageDir' | 'workspace' | 'accountHomes' | 'userHome'
>;

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function storageDirectory(home: string): string {
  try {
    return storagePolicy(home).directory;
  } catch {
    /* The daemon already opened its database; a policy it cannot read leaves the state directory. */
    return home;
  }
}

/** keyPathReason's places for a check outside a sandboxed run. */
export function keyPlaces(home: string, workspace: string, accountHomes: string[]): KeyPlaces {
  return {
    home,
    storageDir: storageDirectory(home),
    workspace,
    accountHomes,
    userHome: os.homedir(),
  };
}

export function sandboxContext(r: ProviderRequest): SandboxContext | undefined {
  const s = r.sandbox;
  const home = r.mcp.env.CLAWSTRUM_HOME;
  if (!r.subagent || !s?.workers || r.account.provider !== 'claude' || !home) return undefined;
  const role = r.role ?? '';
  return {
    role,
    cwd: r.cwd,
    home,
    storageDir: storageDirectory(home),
    workspace: s.workspace,
    accountHomes: s.accountHomes,
    writable: s.writable.map(expandPath),
    offline: s.offlineRoles.includes(role),
    userHome: os.homedir(),
  };
}

/** The Bash input rewritten to run inside the sandbox; an already rewritten input is returned unchanged. */
export function sandboxedBash(
  input: Record<string, unknown>,
  ctx: SandboxContext,
): Record<string, unknown> {
  const cmd = String(input.command ?? '');
  const prefix = `/bin/bash ${shellQuote(SANDBOX_SCRIPT)} `;
  if (cmd.startsWith(prefix)) return input;
  const args = [
    ['--role', ctx.role],
    ['--cwd', ctx.cwd],
    ...ctx.writable.map((p) => ['--writable', p]),
    ...(ctx.offline ? [['--offline']] : []),
    ['--clawstrum-home', ctx.home],
    ...(ctx.storageDir !== ctx.home ? [['--storage-dir', ctx.storageDir]] : []),
    ['--workspace', ctx.workspace],
    ...ctx.accountHomes.map((p) => ['--account-home', p]),
  ]
    .map(([flag, value]) => (value === undefined ? flag : `${flag} ${shellQuote(value)}`))
    .join(' ');
  return { ...input, command: `${prefix}${args} -- ${shellQuote(cmd)}` };
}

// Same keep-list as worker-sandbox.sh: $HOME dot-entries not listed are hidden.
const HOME_KEEP = new Set([
  '.local',
  '.nvm',
  '.mamba',
  '.conda',
  '.cache',
  '.npm',
  '.ipython',
  '.keras',
  '.triton',
  '.nv',
  '.venvs',
  '.gitconfig',
]);
const STATE_KEYS = new Set(['.env', 'config.json', 'accounts', 'runtime']);
const STATE_HIDDEN = new Set([...STATE_KEYS, 'transcripts', 'history', 'reviews', 'diagnostics']);
const DATABASE = /^(clawstrum|memory-lock)\.db(-.*)?$/;

function under(p: string, dir: string): string | null {
  if (p === dir) return '';
  return p.startsWith(dir.endsWith('/') ? dir : dir + '/') ? p.slice(dir.length + 1) : null;
}

function realDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/** `p` below `dir` as given or below its real path: callers resolve `p`, and the state directory can be a symlink. */
function below(p: string, dir: string): string | null {
  const r = under(p, dir);
  if (r !== null) return r;
  const real = realDir(dir);
  return real === dir ? null : under(p, real);
}

/** Why `p` (absolute, resolved) is hidden from a sandboxed worker, or null. */
export function keyPathReason(p: string, ctx: KeyPlaces): string | null {
  if (/^\/proc\/[^/]+\/environ$/.test(p)) return 'a process environment (it holds login tokens)';
  for (const a of ctx.accountHomes)
    if (below(p, a) !== null) return 'a provider login home (it holds credentials)';
  for (const dir of new Set([ctx.home, ctx.storageDir])) {
    const r = below(p, dir);
    if (r !== null && !r.includes('/') && DATABASE.test(r))
      return 'the Clawstrum database (it holds chat history)';
  }
  // Every channel's workspace sits in one folder; no channel's history is shown.
  const c = below(p, path.dirname(ctx.workspace));
  if (c !== null && c.split('/')[1] === 'history')
    return 'conversation history (it can hold pasted keys)';
  const s = below(p, ctx.home);
  if (s !== null) {
    const [first, second, third] = s.split('/');
    if (STATE_KEYS.has(first!)) return 'Clawstrum configuration or logins (they hold keys)';
    if (STATE_HIDDEN.has(first!) || (first === 'groups' && third === 'history' && second))
      return 'Clawstrum history or diagnostics (they can hold pasted keys)';
    return null;
  }
  const h = below(p, ctx.userHome);
  if (h) {
    const [first, second] = h.split('/');
    if (first === '.cache' && second === 'huggingface') return 'the Hugging Face token';
    if (first === '.config' && second !== 'matplotlib') return 'app config (tokens live in these)';
    if (first!.startsWith('.') && first !== '.config' && !HOME_KEEP.has(first!))
      return 'a home dotfile (keys live in these)';
  }
  return null;
}

const FILE_TOOLS: Record<string, string> = {
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'path',
  Glob: 'path',
};

function resolveReal(p: string, cwd: string): string {
  const abs = path.resolve(cwd, p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * Why send_file refuses `file`, or null. A web page or another bot's message can ask the agent to attach a file, so
 * send_file refuses what workers cannot see (keys, logins, history, the database, provider login homes, home
 * dotfiles, process environments), a copy of the database, and the secret files the Read hook refuses. A copy under
 * another name still goes out.
 */
export function sendFileRefusal(file: string, places: KeyPlaces): string | null {
  const p = resolveReal(file, places.workspace);
  const why =
    keyPathReason(p, places) ??
    (DATABASE.test(path.basename(p)) ? 'a copy of the Clawstrum database' : null) ??
    (printsSecret('Read', { file_path: p }) ? 'a file that holds secrets' : null);
  return why && `send_file does not attach ${p}: it is ${why}.`;
}

export function workerToolRefusal(
  toolName: string,
  input: Record<string, unknown>,
  ctx: SandboxContext,
): string | null {
  const field = FILE_TOOLS[toolName];
  if (!field) return null;
  const raw = typeof input[field] === 'string' && input[field] ? (input[field] as string) : ctx.cwd;
  const p = resolveReal(raw, ctx.cwd);
  const why = keyPathReason(p, ctx);
  if (why)
    return `Workers cannot open ${p}: it is ${why}. If the task needs it, say so in your answer and ask the lead to handle it.`;
  if ((toolName === 'Grep' || toolName === 'Glob') && coversKeys(p, ctx))
    return (
      `${toolName} over ${p} would read hidden files (keys, logins, history) below it. ` +
      `Search a subdirectory instead, e.g. ${ctx.cwd} or a project directory.`
    );
  return null;
}

/** A search rooted at `p` reaches a hidden path below it. */
function coversKeys(p: string, ctx: SandboxContext): boolean {
  const channels = path.dirname(ctx.workspace);
  // A channel's workspace, or the folder holding them, has history below it.
  const c = below(p, channels);
  if (c !== null && !c.includes('/')) return true;
  const hidden = [ctx.home, ctx.storageDir, ctx.userHome, channels, ...ctx.accountHomes].flatMap(
    (d) => [d, realDir(d)],
  );
  return hidden.some((d) => d === p || d.startsWith(p === '/' ? '/' : p + '/'));
}

/**
 * Codex app-server settings for a sandboxed Codex subagent run: workspace-write with the worker directory (the
 * thread's cwd, always writable), /tmp and config.sandbox.writable. Codex's sandbox does not hide files, so reads of
 * Clawstrum's key files stay allowed.
 */
export function codexWorkerSandbox(
  r: Pick<ProviderRequest, 'account' | 'cwd' | 'toolless'> &
    Partial<Pick<ProviderRequest, 'subagent' | 'sandbox' | 'role'>>,
): { writable_roots: string[]; network_access: boolean } | undefined {
  const s = r.sandbox;
  if (!r.subagent || !s?.workers || r.toolless || r.account.provider !== 'codex') return undefined;
  return {
    writable_roots: [r.cwd, '/tmp', ...s.writable.map(expandPath)],
    network_access: !s.offlineRoles.includes(r.role ?? ''),
  };
}

/**
 * PreToolUse for a sandboxed subagent run. The prior hooks run first; a deny or stop from them is returned as is,
 * because mergeHooks lets a later result override an earlier one. Otherwise Bash gets the sandboxed command and file
 * tools on hidden paths are denied. Returns `prior` unchanged when the run is not sandboxed.
 */
export function sandboxHooks(
  r: ProviderRequest,
  prior: HookCallbackMatcher[] | undefined,
): HookCallbackMatcher[] | undefined {
  const ctx = sandboxContext(r);
  if (!ctx) return prior;
  const before = prior?.length
    ? mergeHooks({ PreToolUse: prior }, { PreToolUse: [] })!.PreToolUse![0]!.hooks[0]!
    : undefined;
  const callback: HookCallback = async (event, toolUseId, options) => {
    const result: any = before ? await before(event, toolUseId, options) : {};
    if (event.hook_event_name !== 'PreToolUse') return result;
    if ('async' in result && result.async) return result;
    const out = result.hookSpecificOutput ?? {};
    if (
      result.continue === false ||
      result.decision === 'block' ||
      out.permissionDecision === 'deny'
    )
      return result;
    const input = (out.updatedInput ?? event.tool_input ?? {}) as Record<string, unknown>;
    if (event.tool_name === 'Bash')
      return {
        ...result,
        hookSpecificOutput: {
          ...out,
          hookEventName: 'PreToolUse',
          permissionDecision: out.permissionDecision ?? 'allow',
          updatedInput: sandboxedBash(input, ctx),
        },
      };
    const refusal = workerToolRefusal(event.tool_name, input, ctx);
    if (refusal)
      return {
        ...result,
        hookSpecificOutput: {
          ...out,
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: refusal,
        },
      };
    return result;
  };
  return [{ hooks: [callback] }];
}
