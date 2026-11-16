import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import type { Account } from './types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Antigravity CLI (`agy`) is not an npm dependency of Clawstrum. Google ships it as a release tarball
 * (github.com/google-antigravity/antigravity-cli); it is unpacked under tools/antigravity-cli-<version>
 * with an `agy` link to its binary. The highest installed version wins. Without one, the `agy` on PATH
 * is used. An account `executable` overrides both.
 */
export function geminiCommand(root = fileURLToPath(new URL('..', import.meta.url))): string {
  const tools = path.join(root, 'tools');
  let versions: string[] = [];
  try {
    versions = fs
      .readdirSync(tools)
      .filter((name) => /^antigravity-cli-\d+\.\d+\.\d+/.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    // No tools directory: fall through to PATH.
  }
  for (const name of versions.reverse()) {
    const bin = path.join(tools, name, 'agy');
    if (fs.existsSync(bin)) return bin;
  }
  return 'agy';
}

export function runtimeCommand(account: Account): { command: string; args: string[] } {
  if (account.executable) return { command: account.executable, args: [] };
  if (account.provider === 'gemini') return { command: geminiCommand(), args: [] };
  if (account.provider === 'codex') {
    const sdkRequire = createRequire(import.meta.resolve('@openai/codex-sdk'));
    const root = path.dirname(sdkRequire.resolve('@openai/codex/package.json'));
    return { command: process.execPath, args: [path.join(root, 'bin', 'codex.js')] };
  }
  const libc =
    process.platform === 'linux' &&
    !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header
      .glibcVersionRuntime
      ? '-musl'
      : '';
  const sdkRequire = createRequire(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
  const root = path.dirname(
    sdkRequire.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libc}/package.json`,
    ),
  );
  const command = path.join(root, process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (!fs.existsSync(command))
    throw new Error(
      'Bundled Claude runtime is missing; reinstall with optional dependencies enabled',
    );
  return { command, args: [] };
}

/** Probe inside the supervised worker so version lookup cannot block the daemon's event loop. */
export async function runtimeIdentity(account: Account, env: Record<string, string>) {
  const runtime = runtimeCommand(account);
  const { stdout } = await promisify(execFile)(runtime.command, [...runtime.args, '--version'], {
    env,
    timeout: 10000,
    maxBuffer: 4096,
  });
  const version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(stdout)?.[0];
  if (!version) throw new Error('Provider runtime --version did not return a semantic version');
  return {
    provider: account.provider,
    command: runtime.command,
    args: runtime.args,
    version,
    node: process.version,
  };
}
