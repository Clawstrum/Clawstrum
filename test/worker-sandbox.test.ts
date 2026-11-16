import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import {
  SANDBOX_SCRIPT,
  keyPathReason,
  keyPlaces,
  sandboxContext,
  sandboxHooks,
  sandboxedBash,
  sendFileRefusal,
  workerToolRefusal,
} from '../src/worker-sandbox.js';
import type { ProviderRequest } from '../src/types.js';
import { fixture } from './helpers.js';
import { createClaudeProvider } from '../src/providers.js';
import { codexWorkerSandbox } from '../src/worker-sandbox.js';

function request(
  f: ReturnType<typeof fixture>,
  over: Partial<ProviderRequest> = {},
): ProviderRequest {
  return {
    account: f.config.accounts[0]!,
    cwd: path.join(f.session.workspace, 'research', 'workers', 'w1'),
    prompt: '',
    instructions: '',
    env: {},
    controller: new AbortController(),
    mcp: { command: process.execPath, args: [], env: { CLAWSTRUM_HOME: f.home } },
    onEvent() {},
    subagent: true,
    role: 'coder',
    sandbox: {
      ...f.config.sandbox,
      workers: true,
      accountHomes: f.config.accounts.map((a) => a.home),
      workspace: f.session.workspace,
    },
    ...over,
  };
}
const call = (cb: HookCallback, tool_name: string, tool_input: Record<string, unknown>) =>
  cb({ hook_event_name: 'PreToolUse', tool_name, tool_input } as any, 'id', {
    signal: new AbortController().signal,
  }) as Promise<any>;
const hook = (r: ProviderRequest, prior?: HookCallback) =>
  sandboxHooks(r, prior ? [{ hooks: [prior] }] : undefined)![0]!.hooks[0]!;

test('sandbox is off by default', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.config.sandbox, { workers: false, writable: [], offlineRoles: [] });
});

test('only sandboxed Claude subagent runs are wrapped', async (t) => {
  const f = fixture(t);
  const prior = [{ hooks: [async () => ({})] }];
  assert.equal(sandboxHooks(request(f, { subagent: false }), prior), prior);
  const off = request(f);
  off.sandbox!.workers = false;
  assert.equal(sandboxHooks(off, prior), prior);
  assert.equal(sandboxHooks(request(f, { account: f.config.accounts[1]! }), prior), prior);
  const out = await call(hook(request(f)), 'Bash', { command: 'ls' });
  const cmd = out.hookSpecificOutput.updatedInput.command as string;
  assert.ok(cmd.startsWith(`/bin/bash '${SANDBOX_SCRIPT}' --role 'coder'`));
  assert.ok(cmd.endsWith(`-- 'ls'`));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(await call(hook(request(f)), 'Read', { file_path: '/etc/hostname' }), {});
});

test('a wrapped command is not wrapped again', (t) => {
  const f = fixture(t);
  const ctx = sandboxContext(request(f))!;
  const once = sandboxedBash({ command: "echo 'a b'" }, ctx);
  assert.deepEqual(sandboxedBash(once, ctx), once);
});

test('a prior deny or stop wins over the sandbox rewrite', async (t) => {
  const f = fixture(t);
  const deny = async () => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: 'research says no',
    },
  });
  const out = await call(hook(request(f), deny), 'Bash', { command: 'ls' });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.updatedInput, undefined);
  const stop = await call(
    hook(request(f), async () => ({ continue: false })),
    'Bash',
    {
      command: 'ls',
    },
  );
  assert.deepEqual(stop, { continue: false });
  const context = async () => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse' as const, additionalContext: 'note' },
  });
  const kept = await call(hook(request(f), context), 'Bash', { command: 'ls' });
  assert.equal(kept.hookSpecificOutput.additionalContext, 'note');
  assert.match(kept.hookSpecificOutput.updatedInput.command, /worker-sandbox\.sh/);
});

test('file tools on hidden paths are refused with a pointer to the lead', async (t) => {
  const f = fixture(t);
  const ctx = sandboxContext(request(f))!;
  const home = os.homedir();
  const channels = path.dirname(f.session.workspace);
  for (const p of [
    path.join(f.home, '.env'),
    path.join(f.home, 'config.json'),
    path.join(f.home, 'runtime', 'accounts.json'),
    path.join(channels, 'other', 'history', 'h'),
    path.join(f.home, 'clawstrum.db-wal'),
    path.join(f.home, 'transcripts', 'x.jsonl'),
    path.join(f.home, 'groups', 'g', 'history', 'h'),
    path.join(f.session.workspace, 'history', 'input.full.txt'),
    path.join(f.config.accounts[0]!.home, '.credentials.json'),
    path.join(home, '.ssh', 'id_ed25519'),
    path.join(home, '.netrc'),
    path.join(home, '.cache', 'huggingface', 'token'),
    '/proc/1/environ',
  ])
    assert.ok(keyPathReason(p, ctx), p);
  for (const p of [
    path.join(f.home, 'skills', 's', 'SKILL.md'),
    path.join(f.session.workspace, 'AGENTS.md'),
    path.join(home, '.local', 'bin'),
    '/etc/hostname',
  ])
    assert.equal(keyPathReason(p, ctx), null, p);
  const out = await call(hook(request(f)), 'Grep', { path: path.join(f.home, 'accounts') });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /ask the lead/);
  for (const [tool, p] of [
    ['Grep', f.home],
    ['Glob', home],
    ['Grep', '/'],
    ['Grep', f.session.workspace],
    ['Grep', path.join(channels, 'other')],
  ]) {
    const o = await call(hook(request(f)), tool!, { path: p });
    assert.equal(o.hookSpecificOutput?.permissionDecision, 'deny', `${tool} ${p}`);
    assert.match(o.hookSpecificOutput.permissionDecisionReason, /Search a subdirectory instead/);
  }
  assert.deepEqual(await call(hook(request(f)), 'Grep', { path: path.join(f.home, 'skills') }), {});

  // A state directory reached through a symlink: the hook compares resolved paths.
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-link-'));
  t.after(() => fs.rmSync(linkDir, { recursive: true, force: true }));
  const link = path.join(linkDir, 'state');
  fs.symlinkSync(f.home, link);
  const linked = {
    ...ctx,
    home: link,
    storageDir: link,
    workspace: path.join(link, 'channels', path.basename(f.session.workspace)),
  };
  assert.ok(keyPathReason(path.join(f.home, 'runtime', 'accounts.json'), linked));
  assert.ok(keyPathReason(path.join(channels, 'other', 'history', 'h'), linked));
  assert.match(workerToolRefusal('Grep', { path: f.home }, linked) ?? '', /Search a subdirectory/);
});

test('send_file refuses what workers cannot see, database copies and secret files', (t) => {
  const f = fixture(t);
  const places = keyPlaces(
    f.home,
    f.session.workspace,
    f.config.accounts.map((a) => a.home),
  );
  const channels = path.dirname(f.session.workspace);
  for (const p of [
    path.join(f.home, '.env'),
    path.join(f.home, 'runtime', 'accounts.json'),
    path.join(f.home, 'clawstrum.db'),
    path.join(f.config.accounts[0]!.home, '.credentials.json'),
    path.join(channels, 'other', 'history', 'h'),
    path.join(f.session.workspace, 'backup', 'clawstrum.db-wal'),
    path.join(f.session.workspace, 'project', '.env'),
    path.join(os.homedir(), '.ssh', 'id_ed25519'),
    '/proc/self/environ',
  ])
    assert.match(sendFileRefusal(p, places) ?? '', /does not attach/, p);
  for (const p of [
    path.join(f.session.workspace, 'plot.png'),
    path.join(f.home, 'AGENTS.md'),
    path.join(f.home, 'skills', 's', 'SKILL.md'),
    path.join(channels, 'other', 'notes.md'),
  ])
    assert.equal(sendFileRefusal(p, places), null, p);
  fs.writeFileSync(path.join(f.home, '.env'), 'x');
  const link = path.join(f.session.workspace, 'notes.txt');
  fs.symlinkSync(path.join(f.home, '.env'), link);
  assert.match(sendFileRefusal(link, places) ?? '', /does not attach/);
});

test('Claude provider wraps subagent Bash after the research hooks and leaves the lead alone', async (t) => {
  const f = fixture(t);
  let command = '';
  let result: any;
  // The research hooks close their store when the run ends, so the hook is called mid-run.
  const query = ((p: any) => {
    const cb = p.options.hooks.PreToolUse[0].hooks[0] as HookCallback;
    return Object.assign(
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'test' };
        result = await cb(
          {
            hook_event_name: 'PreToolUse',
            session_id: 'sdk',
            transcript_path: '',
            cwd: p.options.cwd,
            tool_use_id: 'tool',
            tool_name: 'Bash',
            tool_input: { command },
          } as any,
          'tool',
          { signal: new AbortController().signal },
        );
        yield { type: 'result', subtype: 'success', result: 'done', usage: {} };
      })(),
      { close() {} },
    );
  }) as any;
  const research = (over: Partial<ProviderRequest> = {}) =>
    request(f, {
      research: f.config.research,
      mcp: {
        command: process.execPath,
        args: [],
        env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id },
      },
      ...over,
    });
  const pre = async (r: ProviderRequest, cmd: string) => {
    command = cmd;
    result = undefined;
    await createClaudeProvider(query).run(r);
    return result;
  };
  const wrapped = await pre(research(), 'ls');
  assert.ok(
    wrapped.hookSpecificOutput.updatedInput.command.startsWith(`/bin/bash '${SANDBOX_SCRIPT}'`),
  );
  const denied = await pre(research(), 'env');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /environment/);
  assert.equal(denied.hookSpecificOutput.updatedInput, undefined);
  const lead = await pre(research({ subagent: false }), 'ls');
  // The lead gets no sandbox wrap; it may still get the unrelated toolNice renice prefix.
  assert.ok(
    !lead.hookSpecificOutput?.updatedInput?.command?.startsWith(`/bin/bash '${SANDBOX_SCRIPT}'`),
  );
});

test('Codex subagents get workspace-write with the worker directory, /tmp and configured roots', (t) => {
  const f = fixture(t);
  const codex = f.config.accounts.find((a) => a.provider === 'codex')!;
  const r = request(f, { account: codex, role: 'web' });
  r.sandbox!.writable = ['/data/x'];
  assert.deepEqual(codexWorkerSandbox(r), {
    writable_roots: [r.cwd, '/tmp', '/data/x'],
    network_access: true,
  });
  r.sandbox!.offlineRoles = ['web'];
  assert.equal(codexWorkerSandbox(r)!.network_access, false);
  assert.equal(codexWorkerSandbox({ ...r, subagent: false }), undefined);
  assert.equal(codexWorkerSandbox(request(f)), undefined);
});

const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']);
const noBwrap = probe.status === 0 ? false : 'bwrap cannot create a sandbox on this host';

test('bwrap sandbox confines writes, env, SLURM, network and state', { skip: noBwrap }, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-sbx-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The sandbox leaves /tmp writable by design, so a checkout under /tmp cannot host the outside
  // directory; the home directory (non-dot name, so it is bound back read-only) stands in.
  const tmp = fs.realpathSync('/tmp');
  const base = [process.cwd(), os.homedir()]
    .map((p) => fs.realpathSync(p))
    .find((p) => p !== tmp && !p.startsWith(tmp + '/'));
  if (!base) {
    t.skip(
      'checkout and home are both under /tmp, so there is no directory outside /tmp to test confinement against',
    );
    return;
  }
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(base, 'clawstrum-sbx-out-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const cwd = path.join(root, 'w');
  const mhome = path.join(root, 'state');
  fs.mkdirSync(cwd);
  fs.mkdirSync(mhome);
  fs.writeFileSync(path.join(mhome, 'config.json'), '{"secret":1}');
  fs.writeFileSync(path.join(mhome, 'AGENTS.md'), 'notes');
  fs.writeFileSync(path.join(mhome, 'clawstrum.db'), 'chat');
  const slurm = path.join(root, 'bin');
  fs.mkdirSync(slurm);
  fs.writeFileSync(path.join(slurm, 'sbatch'), '#!/bin/bash\necho submitted\n', { mode: 0o755 });
  const run = (cmd: string, extra: string[] = []) =>
    spawnSync(
      '/bin/bash',
      [SANDBOX_SCRIPT, '--cwd', cwd, '--clawstrum-home', mhome, ...extra, '--', cmd],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, FOO_TOKEN: 'x', PATH: `${slurm}:${process.env.PATH}` },
      },
    );
  const r = run(
    `echo a > /tmp/${path.basename(root)}-t && rm /tmp/${path.basename(root)}-t && echo b > f && cat f; ` +
      `LC_ALL=C touch ${outside}/x 2>&1 | grep -q 'Read-only file system' && echo ro; echo "\${FOO_TOKEN:-gone}"; ` +
      `cat ${mhome}/config.json 2>/dev/null || echo hidden; cat ${mhome}/AGENTS.md; echo; ` +
      `cat ${mhome}/clawstrum.db 2>/dev/null || echo nodb; ls -A /run/munge /run/user/$(id -u) 2>/dev/null | grep -v : | grep . || echo norun`,
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'b',
    'ro',
    'gone',
    'hidden',
    'notes',
    'nodb',
    'norun',
  ]);
  assert.equal(fs.existsSync(path.join(outside, 'x')), false);
  const s = run('sbatch job.sh');
  assert.equal(s.status, 126);
  assert.match(s.stderr, /sbatch is not available to subagents/);
  assert.doesNotMatch(s.stdout, /submitted/);
  const net = run(`awk -F: 'NR > 2 { gsub(/ /, "", $1); print $1 }' /proc/net/dev`, ['--offline']);
  assert.deepEqual(net.stdout.trim().split('\n'), ['lo']);
});

test(
  'bwrap sandbox hides state in the default layout and through a symlink',
  { skip: noBwrap },
  (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-sbx-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const mhome = path.join(root, 'state');
    const files = [
      'runtime/accounts.json',
      'accounts/main/claude/.credentials.json',
      'channels/c1/history/h',
      'channels/c2/history/h',
      'channels/c2/AGENTS.md',
    ];
    for (const rel of files) {
      fs.mkdirSync(path.dirname(path.join(mhome, rel)), { recursive: true });
      fs.writeFileSync(path.join(mhome, rel), 'x');
    }
    const cwd = path.join(mhome, 'channels', 'c1', 'research', 'workers', 'w1');
    fs.mkdirSync(cwd, { recursive: true });
    const link = path.join(root, 'link');
    fs.symlinkSync(mhome, link);
    // An account home in the default <state>/accounts/<id>/<provider> once failed every command.
    for (const state of [mhome, link]) {
      const probe = files
        .map((rel) => `[ -s ${path.join(state, rel)} ] && echo shown || echo hidden`)
        .join('; ');
      const r = spawnSync(
        '/bin/bash',
        [
          SANDBOX_SCRIPT,
          '--cwd',
          cwd,
          '--clawstrum-home',
          state,
          '--workspace',
          path.join(state, 'channels', 'c1'),
          '--account-home',
          path.join(state, 'accounts', 'main', 'claude'),
          '--',
          probe,
        ],
        { cwd, encoding: 'utf8' },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(
        r.stdout.trim().split('\n'),
        ['hidden', 'hidden', 'hidden', 'hidden', 'shown'],
        state,
      );
    }
  },
);
