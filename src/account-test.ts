import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderFailure, classifyError } from './accounts.js';
import { accountEnvironment } from './providers.js';
import { hasAccountToken } from './account-registry.js';
import { runtimeCommand, runtimeIdentity } from './runtime.js';
import { supervisedProviders } from './supervisor.js';
import type { Config } from './config.js';
import type { Account, Provider, ProviderName } from './types.js';

export interface AccountTestResult {
  account: string;
  model: string;
  ok: boolean;
  reply?: string;
  error?: string;
  executable: string;
  cliVersion?: string;
}

/**
 * One short prompt through the provider adapter the daemon itself uses for this account: the same
 * executable, the same account home, the same token variable and the same environment filtering
 * (accountEnvironment). A login in the account's profile home proves nothing about an account the
 * daemon authenticates with a saved token, so this is the check to run instead.
 */
export async function testAccount(
  config: Config,
  account: Account,
  options: {
    model?: string;
    providers?: Record<ProviderName, Provider>;
    timeoutMs?: number;
    source?: NodeJS.ProcessEnv;
  } = {},
): Promise<AccountTestResult> {
  const routed = options.model ? { ...account, model: options.model } : account;
  let executable = routed.executable ?? '';
  try {
    executable = runtimeCommand(routed).command;
  } catch {
    // Reported by the run below; the executable field then keeps what the config names.
  }
  const result: AccountTestResult = {
    account: account.id,
    model: routed.model ?? 'provider default',
    ok: false,
    executable,
  };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-account-test-'));
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Account test timed out')),
    options.timeoutMs ?? 120000,
  );
  try {
    const env = accountEnvironment(routed, config.accounts, options.source);
    try {
      result.cliVersion = (await runtimeIdentity(routed, env)).version;
    } catch {
      // The version is a convenience; the model call below reports a missing executable.
    }
    const reply = await (options.providers ?? supervisedProviders)[routed.provider].run({
      account: routed,
      prompt: 'Reply with the word ok',
      instructions: 'Subscription connectivity check. Answer in one word and call no tools.',
      toolless: true,
      cwd: workspace,
      controller,
      env,
      blockedVersions: config.runtime.blockedVersions,
      mcp: { command: process.execPath, args: ['-e', 'process.exit(0)'], env: {} },
      onEvent: () => {},
    });
    result.ok = true;
    result.reply = reply.trim();
  } catch (error) {
    result.error = (
      error instanceof ProviderFailure ? error : classifyError(controller.signal.reason ?? error)
    ).message;
  } finally {
    clearTimeout(timeout);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  return result;
}

/** Why `account login` should not run for this account, or undefined when it may. */
export function loginRefusal(account: Account, force: boolean): string | undefined {
  if (force) return undefined;
  const stored = account.provider === 'claude' && hasAccountToken(account.id);
  if (!stored && !account.tokenEnv) return undefined;
  const how = stored
    ? 'the token stored in accounts.json'
    : `the saved token named by ${account.tokenEnv}`;
  return `The daemon authenticates account ${account.id} with ${how}, so a login into its profile home (${account.home}) is not used and would not fix or change anything. Run: clawstrum account test ${account.id}. Add --force to log in anyway.`;
}
