import fs from 'node:fs';
import path from 'node:path';
import { ProviderFailure } from './accounts.js';
import { packageRoot } from './apply.js';

/**
 * Clawstrum's tool checks reach Codex through Codex's own PreToolUse hook. Codex starts
 * dist/hook-client.js before each tool call; the client hands the call to the run's relay
 * (hook-relay.ts) and prints the answer. Codex runs a hook only once it is marked trusted, and it
 * skips an untrusted one without saying so, so the trust is written before a thread is started.
 */

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command Codex runs before each tool call. */
export function codexHookCommand(root = packageRoot()): string {
  return `${shellQuote(process.execPath)} ${shellQuote(path.join(root, 'dist', 'hook-client.js'))} --format codex`;
}

/** The app-server flags that load the hook: the feature switch and one PreToolUse entry. */
export function codexHookArgs(command: string): string[] {
  return [
    '--enable',
    'hooks',
    '-c',
    `hooks.PreToolUse=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=60}]}]`,
  ];
}

type HookRequester = (method: string, params: unknown) => Promise<any>;

type ListedHook = {
  key: string;
  command?: string;
  eventName: string;
  currentHash: string;
  trustStatus: string;
};

async function clawstrumHooks(
  request: HookRequester,
  cwd: string,
  command: string,
): Promise<ListedHook[]> {
  const listed = await request('hooks/list', { cwds: [cwd] });
  const found: ListedHook[] = [];
  for (const entry of listed?.data ?? [])
    for (const hook of entry?.hooks ?? [])
      if (
        hook?.handlerType === 'command' &&
        hook.command === command &&
        hook.eventName === 'preToolUse'
      )
        found.push(hook);
  return found;
}

/** The TOML table header Codex reads a hook's trust from. */
function trustHeader(key: string): string {
  return `[hooks.state.${JSON.stringify(key)}]`;
}

/** Adds or replaces the one `[hooks.state."<key>"]` table in config.toml text. Every other line is kept. */
export function withHookTrust(text: string, key: string, hash: string): string {
  const header = trustHeader(key);
  const line = `trusted_hash = ${JSON.stringify(hash)}`;
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() === header);
  if (at < 0) {
    if (text === '') return `${header}\n${line}\n`;
    return `${text}${text.endsWith('\n') ? '' : '\n'}\n${header}\n${line}\n`;
  }
  let end = at + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  const body = lines.slice(at + 1, end);
  const own = body.findIndex((l) => /^\s*trusted_hash\s*=/.test(l));
  if (own >= 0) body[own] = line;
  else body.unshift(line);
  return [...lines.slice(0, at + 1), ...body, ...lines.slice(end)].join('\n');
}

/** The fallback when config/batchWrite fails: one atomic edit of <CODEX_HOME>/config.toml. */
export function writeHookTrustFile(codexHome: string, key: string, hash: string): void {
  const file = path.join(codexHome, 'config.toml');
  let text = '';
  let mode = 0o600;
  try {
    text = fs.readFileSync(file, 'utf8');
    mode = fs.statSync(file).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const next = withHookTrust(text, key, hash);
  if (next === text) return;
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, next, { mode });
  fs.renameSync(temp, file);
}

/**
 * Makes every Clawstrum hook trusted for `cwd`. Reads the key and hash from hooks/list each time:
 * the hash covers the command text, so it changes when the node or package path changes. Tries
 * config/batchWrite first and the config.toml edit second. Throws when the hook is missing or still
 * not trusted afterwards: a run without its checks must not start unnoticed.
 */
export async function trustCodexHooks({
  request,
  cwd,
  command,
  codexHome,
  onFallback,
}: {
  request: HookRequester;
  cwd: string;
  command: string;
  codexHome: string;
  onFallback?: (error: unknown) => void;
}): Promise<void> {
  const needsTrust = (hook: ListedHook) => !['trusted', 'managed'].includes(hook.trustStatus);
  const hooks = await clawstrumHooks(request, cwd, command);
  if (!hooks.length)
    throw new ProviderFailure(
      'fatal',
      "Codex did not list Clawstrum's tool-check hook, so the checks cannot run",
    );
  const pending = hooks.filter(needsTrust);
  if (!pending.length) return;
  try {
    await request('config/batchWrite', {
      edits: pending.map((hook) => ({
        keyPath: `hooks.state.${JSON.stringify(hook.key)}`,
        value: { trusted_hash: hook.currentHash },
        mergeStrategy: 'upsert',
      })),
      reloadUserConfig: true,
    });
  } catch (error) {
    onFallback?.(error);
    for (const hook of pending) writeHookTrustFile(codexHome, hook.key, hook.currentHash);
  }
  let left = (await clawstrumHooks(request, cwd, command)).filter(needsTrust);
  if (left.length) {
    // batchWrite said ok but the hook is still untrusted: write the file ourselves once.
    for (const hook of left) writeHookTrustFile(codexHome, hook.key, hook.currentHash);
    left = (await clawstrumHooks(request, cwd, command)).filter(needsTrust);
  }
  if (left.length)
    throw new ProviderFailure(
      'fatal',
      `Codex still reports Clawstrum's tool-check hook as ${left[0]!.trustStatus} after its trust was written, so the checks cannot run`,
    );
}
