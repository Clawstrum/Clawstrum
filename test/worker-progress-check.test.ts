import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './helpers.js';
import { AccountPool } from '../src/accounts.js';
import { configSchema } from '../src/config.js';
import { createClaudeProvider } from '../src/providers.js';
import { researchSchema } from '../src/research/config.js';
import { availableMemory } from '../src/research/memory.js';
import { steerWorker, workerSteers } from '../src/research/steering.js';
import { workerProfile, workerReport } from '../src/research/worker-profile.js';
import {
  delegate,
  ResearchWorkers,
  RESTART_PROMPT,
  workerContract,
} from '../src/research/workers.js';
import type { Provider, ProviderRequest } from '../src/types.js';
import { execFileSync } from 'node:child_process';
import { researchHooks } from '../src/research/hooks.js';

const MINUTE = 60000;

/** A worker that keeps running until it is cancelled. */
function hanging(requests: ProviderRequest[]): Provider {
  return {
    run(r) {
      requests.push(r);
      return new Promise((_, reject) =>
        r.controller.signal.addEventListener('abort', () => reject(r.controller.signal.reason)),
      );
    },
  };
}

test('workers have no step or time limit by default', () => {
  const workers = researchSchema.parse({}).workers;
  assert.equal(workers.timeoutMs, 0);
  assert.equal(workers.checkMinutes, 15);
  for (const [name, role] of Object.entries(workers.roles)) assert.equal(role.maxTurns, 0, name);
  assert.match(workerContract('/tmp/w', 1000, 0), /No step limit/);
  assert.match(workerContract('/tmp/w', 1000, 30), /Resource budget: 30 Claude turns/);
});

test('a running worker wakes its lead for a progress check every checkMinutes', async (t) => {
  const f = fixture(t);
  const requests: ProviderRequest[] = [];
  const provider = hanging(requests);
  const m = new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
  );
  const row = delegate(f.store, f.session.id, f.config, 'slow', {
    role: 'coder',
    brief: 'Port the loader to the new format.',
  });
  m.tick();
  assert.equal(requests[0]!.maxTurns, undefined);
  const start = Date.now();
  const checks = () =>
    f.store.all<{ content: string; status: string }>(
      "SELECT content, status FROM inbound WHERE id LIKE 'research:worker-check:%'",
    );
  m.progressChecks(start + 14 * MINUTE);
  assert.equal(checks().length, 0);
  m.progressChecks(start + 16 * MINUTE);
  assert.equal(checks().length, 1);
  const wake = checks()[0]!.content;
  assert.ok(wake.includes(row.id));
  assert.match(wake, /\(coder\), running 1[56] min/);
  assert.match(wake, /no progress note yet/);
  assert.match(wake, /Brief: Port the loader/);
  assert.match(wake, /EVENTS\.jsonl/);
  assert.match(wake, /cancelWorker=true/);
  // Not again within the interval, nor while the previous check is still unread.
  m.progressChecks(start + 30 * MINUTE);
  assert.equal(checks().length, 1);
  m.progressChecks(start + 40 * MINUTE);
  assert.equal(checks().length, 1);
  const read = () =>
    f.store.exec("UPDATE inbound SET status='done' WHERE id LIKE 'research:worker-check:%'");
  read();
  m.progressChecks(start + 41 * MINUTE);
  assert.equal(checks().length, 2);
  read();
  m.progressChecks(start + 50 * MINUTE);
  assert.equal(checks().length, 2);
  m.progressChecks(start + 57 * MINUTE);
  assert.equal(checks().length, 3);
  read();

  f.store.exec("UPDATE delegations SET status='cancelled' WHERE id=?", row.id);
  m.tick();
  await Promise.all([...m.active.values()].map((s) => s.promise));
  m.progressChecks(start + 80 * MINUTE);
  assert.equal(checks().length, 3);
});

test('an idle subagent gets an IDLE prefix and a steer-now sentence; an active one does not', async (t) => {
  // A subagent that did nothing for hours sat through many consecutive progress checks
  // ("last activity 7 min ago" up to "253 min ago") and the lead answered none of them.
  const f = fixture(t);
  const requests: ProviderRequest[] = [];
  const provider = hanging(requests);
  const m = new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
  );
  const row = delegate(f.store, f.session.id, f.config, 'maybe-idle', {
    role: 'coder',
    brief: 'Port the loader to the new format.',
  });
  m.tick();
  const start = Date.now();
  const wake = () =>
    f.store.get<{ content: string }>(
      "SELECT content FROM inbound WHERE id LIKE 'research:worker-check:%' AND status IN ('queued','running')",
    )!.content;
  const read = () =>
    f.store.exec("UPDATE inbound SET status='done' WHERE id LIKE 'research:worker-check:%'");

  // 16 min: past the check interval, but well under the 30 min idle threshold.
  m.progressChecks(start + 16 * MINUTE);
  const active = wake();
  assert.doesNotMatch(active, /IDLE/);
  assert.doesNotMatch(active, /marked IDLE/);
  read();

  // 45 min: no activity since the subagent started, 30+ min ago.
  m.progressChecks(start + 45 * MINUTE);
  const idle = wake();
  assert.match(idle, /- IDLE 45 min, no tool call or output: .*running 45 min/);
  assert.match(
    idle,
    /1 subagent\(s\) marked IDLE have done nothing for 30\+ minutes\. Steer each one or stop it in this turn; do not reply CLAWSTRUM_QUIET while one is IDLE\./,
  );

  f.store.exec("UPDATE delegations SET status='cancelled' WHERE id=?", row.id);
  m.tick();
  await Promise.all([...m.active.values()].map((s) => s.promise));
});

test('checkMinutes 0 turns the progress check off', async (t) => {
  const f = fixture(t);
  const config = configSchema.parse({
    ...f.config,
    research: { ...f.config.research, workers: { ...f.config.research.workers, checkMinutes: 0 } },
  });
  const provider = hanging([]);
  const m = new ResearchWorkers(
    f.store,
    config,
    new AccountPool(config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
  );
  const row = delegate(f.store, f.session.id, config, 'off', { role: 'explorer', brief: 'Look.' });
  m.tick();
  m.progressChecks(Date.now() + 60 * MINUTE);
  assert.equal(
    f.store.get("SELECT 1 FROM inbound WHERE id LIKE 'research:worker-check:%'"),
    undefined,
  );
  f.store.exec("UPDATE delegations SET status='cancelled' WHERE id=?", row.id);
  m.tick();
  await Promise.all([...m.active.values()].map((s) => s.promise));
});

test('subagent defaults: 20 at once, a 1024 MB memory floor and two restart resumes', () => {
  const workers = researchSchema.parse({}).workers;
  assert.equal(workers.maxConcurrent, 20);
  assert.equal(workers.minFreeMemoryMB, 1024);
  assert.equal(workers.restartResumes, 2);
});

/** A Claude adapter over a scripted SDK stream that names its session and runs until aborted. */
function claudeSession(resumes: Array<string | undefined>): Provider {
  return createClaudeProvider(((args: any) => {
    resumes.push(args.options.resume);
    const signal: AbortSignal = args.options.abortController.signal;
    return Object.assign(
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: args.options.resume ?? 'claude-1' };
        await new Promise((resolve) => signal.addEventListener('abort', resolve));
        throw signal.reason;
      })(),
      { close() {} },
    );
  }) as any);
}
/** A Codex-shaped adapter: names its thread the way codex-app-server.ts does, then runs until aborted. */
function codexSession(): Provider {
  return {
    run(r) {
      r.onEvent({ type: 'session', sessionId: r.sessionId ?? 'codex-thread-1' });
      r.attachInjector?.((ids) => {
        r.onEvent({ type: 'injected', detail: { ids, ok: true } });
        return true;
      });
      return new Promise((_, reject) =>
        r.controller.signal.addEventListener('abort', () => reject(r.controller.signal.reason)),
      );
    },
  };
}
function recording(inner: Provider, requests: ProviderRequest[]): Provider {
  return {
    run(r) {
      requests.push(r);
      return inner.run(r);
    },
  };
}
const status = (f: ReturnType<typeof fixture>, id: string) =>
  f.store.get<{ status: string; error: string | null; started_at: number }>(
    'SELECT status,error,started_at FROM delegations WHERE id=?',
    id,
  )!;

for (const provider of ['claude', 'codex'] as const)
  test(`a ${provider} subagent continues its own conversation after a Clawstrum restart`, async (t) => {
    const f = fixture(t);
    const resumes: Array<string | undefined> = [];
    const requests: ProviderRequest[] = [];
    const adapter = () =>
      recording(provider === 'claude' ? claudeSession(resumes) : codexSession(), requests);
    const manager = () => {
      const a = adapter();
      return new ResearchWorkers(
        f.store,
        f.config,
        new AccountPool(f.config.accounts, f.store, 100),
        { claude: a, codex: a },
        () => 0,
        () => ({ availableMB: 64000, source: 'test' }),
      );
    };
    const expected = provider === 'claude' ? 'claude-1' : 'codex-thread-1';
    const first = manager();
    const row = delegate(f.store, f.session.id, f.config, 'long', {
      role: 'coder',
      provider,
      brief: 'Port the loader.',
    });
    first.tick();
    for (let i = 0; i < 50 && !workerProfile(f.store, row.id)?.providerSession; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(workerProfile(f.store, row.id)?.providerSession, expected);
    assert.equal(
      workerProfile(f.store, row.id)?.providerAccount,
      provider === 'claude' ? 'a' : 'b',
    );
    const dir = path.dirname(
      f.store.get<{ result_path: string }>(
        'SELECT result_path FROM delegations WHERE id=?',
        row.id,
      )!.result_path,
    );
    const brief = fs.readFileSync(path.join(dir, 'BRIEF.md'), 'utf8');
    const startedAt = status(f, row.id).started_at;
    // An instruction queued before the shutdown is delivered to the resumed subagent.
    steerWorker(f.store, f.session.id, row.id, 'fix-1', 'Also update the README.');

    // A daemon shutdown leaves it running in the database rather than failed.
    await first.stop();
    assert.equal(status(f, row.id).status, 'running');
    assert.equal(workerSteers(f.store, row.id)[0]!.status, 'queued');
    assert.equal(
      f.store.get('SELECT 1 FROM inbound WHERE id=?', `research:worker:${row.id}`),
      undefined,
    );

    const second = manager();
    second.recover();
    assert.equal(status(f, row.id).status, 'queued');
    const wake = f.store.get<{ content: string }>(
      'SELECT content FROM inbound WHERE id=?',
      `research:worker-resume:${row.id}:1`,
    )!.content;
    assert.match(wake, /was running when Clawstrum restarted/);
    assert.match(wake, /automatic resume 1 of 2/);

    second.tick();
    assert.equal(status(f, row.id).status, 'running');
    assert.equal(status(f, row.id).started_at, startedAt);
    const resumed = requests.at(-1)!;
    assert.equal(resumed.sessionId, expected);
    assert.equal(resumed.prompt, RESTART_PROMPT);
    assert.equal(resumed.account.id, provider === 'claude' ? 'a' : 'b');
    if (provider === 'claude') assert.deepEqual(resumes, [undefined, 'claude-1']);
    // Its brief and step record are kept, not started over.
    assert.equal(fs.readFileSync(path.join(dir, 'BRIEF.md'), 'utf8'), brief);
    const events = fs.readFileSync(path.join(dir, 'EVENTS.jsonl'), 'utf8');
    assert.match(events, /held_for_restart/);
    assert.match(events, /restart_resume/);
    assert.equal(workerProfile(f.store, row.id)?.resume, false);
    // The resumed invocation is metered separately, and the worker report adds the two.
    const meter = (suffix: string) => `usage:${f.session.id}:worker:${row.id}${suffix}`;
    assert.ok(f.store.get('SELECT 1 FROM metadata WHERE key=?', meter('')));
    assert.ok(f.store.get('SELECT 1 FROM metadata WHERE key=?', meter(':restart1')));
    for (const [suffix, outputTokens] of [
      ['', 300],
      [':restart1', 40],
    ] as const)
      f.store.exec(
        "UPDATE metadata SET value=json_set(value,'$.snapshot.totals.outputTokens',?) WHERE key=?",
        outputTokens,
        meter(suffix),
      );
    assert.equal(
      workerReport(f.store, { sessionId: f.session.id }).workers.find((w) => w.id === row.id)!
        .usage!.snapshot.totals.outputTokens,
      340,
    );

    // Steering reaches the resumed conversation.
    for (let i = 0; i < 50 && workerSteers(f.store, row.id)[0]!.status !== 'accepted'; i++) {
      second.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(workerSteers(f.store, row.id)[0]!.status, 'accepted');

    // The progress check still covers it.
    second.progressChecks(Date.now() + 16 * MINUTE);
    assert.ok(
      f.store
        .get<{
          content: string;
        }>("SELECT content FROM inbound WHERE id LIKE 'research:worker-check:%'")!
        .content.includes(row.id),
    );

    // A crash (no clean stop) is resumed the same way, until the limit is used up.
    const third = manager();
    third.recover();
    assert.equal(status(f, row.id).status, 'queued');
    assert.equal(workerProfile(f.store, row.id)?.restarts, 2);
    third.recover();
    // Already queued: nothing changes.
    assert.equal(status(f, row.id).status, 'queued');
    third.tick();
    assert.equal(status(f, row.id).status, 'running');
    const fourth = manager();
    fourth.recover();
    assert.equal(status(f, row.id).status, 'failed');
    assert.match(status(f, row.id).error!, /after 2 automatic resumes \(limit 2\)/);
    for (const m of [second, third]) await m.stop();
  });

test('a running subagent with no saved conversation still fails after a restart', async (t) => {
  const f = fixture(t);
  const row = delegate(f.store, f.session.id, f.config, 'early', {
    role: 'explorer',
    brief: 'Look.',
  });
  f.store.exec(
    "UPDATE delegations SET status='running',started_at=? WHERE id=?",
    Date.now(),
    row.id,
  );
  const m = new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: hanging([]), codex: hanging([]) },
    () => 0,
  );
  m.recover();
  assert.equal(status(f, row.id).status, 'failed');
  assert.match(status(f, row.id).error!, /^Daemon interrupted the subagent;/);
  assert.ok(f.store.get('SELECT 1 FROM inbound WHERE id=?', `research:worker:${row.id}`));
});

test('a queued subagent waits for free memory and the lead sees why', async (t) => {
  const f = fixture(t);
  const requests: ProviderRequest[] = [];
  const provider = hanging(requests);
  let availableMB = 600;
  const config = {
    ...f.config,
    research: {
      ...f.config.research,
      workers: { ...f.config.research.workers, minFreeMemoryMB: 1024 },
    },
  };
  const m = new ResearchWorkers(
    f.store,
    config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
    () => ({ availableMB, source: 'user.slice/test' }),
  );
  const ids = ['one', 'two', 'three'].map(
    (key) => delegate(f.store, f.session.id, f.config, key, { role: 'explorer', brief: key }).id,
  );
  m.tick();
  m.tick();
  assert.equal(requests.length, 0);
  for (const id of ids) {
    assert.equal(status(f, id).status, 'queued');
    assert.equal(workerProfile(f.store, id)?.waiting?.reason, 'memory');
  }
  // Recorded once per subagent, not once per tick.
  assert.equal(
    f.store.get<{ n: number }>(
      "SELECT COUNT(*) n FROM events WHERE type='research_worker_waiting'",
    )!.n,
    3,
  );
  m.progressChecks(Date.now() + 16 * MINUTE);
  const wake = f.store.get<{ content: string }>(
    "SELECT content FROM inbound WHERE id LIKE 'research:worker-check:%'",
  )!.content;
  assert.match(wake, /queued \d+ min, not started: not enough free memory \(600 MB available/);
  assert.match(wake, /user\.slice\/test/);
  assert.match(wake, /minFreeMemoryMB is 1024/);

  // 1600 MB: the first starts, the second is counted against the first's 500 MB and starts too,
  // the third would leave 600 MB and waits.
  availableMB = 1600;
  m.tick();
  assert.equal(requests.length, 2);
  assert.equal(workerProfile(f.store, ids[0]!)?.waiting, undefined);
  assert.equal(status(f, ids[2]!).status, 'queued');
  f.store.exec("UPDATE delegations SET status='cancelled' WHERE status IN ('queued','running')");
  m.tick();
  await Promise.all([...m.active.values()].map((s) => s.promise));
});

test('minFreeMemoryMB 0 turns the memory check off', async (t) => {
  const f = fixture(t);
  const config = configSchema.parse({
    ...f.config,
    research: {
      ...f.config.research,
      workers: { ...f.config.research.workers, minFreeMemoryMB: 0 },
    },
  });
  const requests: ProviderRequest[] = [];
  const provider = hanging(requests);
  let read = 0;
  const m = new ResearchWorkers(
    f.store,
    config,
    new AccountPool(config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
    () => {
      read++;
      return { availableMB: 0, source: 'test' };
    },
  );
  const row = delegate(f.store, f.session.id, config, 'free', { role: 'explorer', brief: 'Go.' });
  m.tick();
  assert.equal(requests.length, 1);
  assert.equal(read, 0);
  f.store.exec("UPDATE delegations SET status='cancelled' WHERE id=?", row.id);
  m.tick();
  await Promise.all([...m.active.values()].map((s) => s.promise));
});

test('available memory is the tightest cgroup limit less reclaimable cache, or host free memory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-cgroup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const GB = 1024 ** 3;
  const level = (rel: string, max: string, current: number, stat: string) => {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    fs.writeFileSync(path.join(root, rel, 'memory.max'), max + '\n');
    fs.writeFileSync(path.join(root, rel, 'memory.current'), `${current}\n`);
    fs.writeFileSync(path.join(root, rel, 'memory.stat'), stat);
  };
  // The 2026-10-31 shape: the user slice is the binding limit and most of its usage is slab.
  level('user.slice', 'max', 700 * GB, 'inactive_file 0\n');
  level(
    'user.slice/u.slice',
    String(8 * GB),
    8 * GB - 0.5 * GB,
    `anon ${0.7 * GB}\ninactive_file ${GB}\nactive_file ${0.5 * GB}\nslab_reclaimable ${6 * GB}\n`,
  );
  level('user.slice/u.slice/svc.service', 'max', 2 * GB, 'inactive_file 0\n');
  const cgroupFile = path.join(root, 'cgroup');
  fs.writeFileSync(cgroupFile, '0::/user.slice/u.slice/svc.service\n');
  const reading = availableMemory({ root, cgroupFile, hostFree: () => 100 * GB });
  // 8 GiB - (7.5 GiB - 1 GiB - 6 GiB) = 7.5 GiB
  assert.deepEqual(reading, { availableMB: 7680, source: 'user.slice/u.slice' });
  // Host free memory is the floor when it is smaller, and the only figure without a cgroup.
  assert.equal(availableMemory({ root, cgroupFile, hostFree: () => GB }).availableMB, 1024);
  assert.deepEqual(
    availableMemory({ root, cgroupFile: path.join(root, 'missing'), hostFree: () => 3 * GB }),
    { availableMB: 3072, source: 'host' },
  );
});

/** A subagent provider whose runs stay open until the test finishes them. */
function controlled() {
  const runs: Array<{ r: ProviderRequest; finish(text: string): void }> = [];
  const provider: Provider = {
    run(r) {
      return new Promise((resolve, reject) => {
        runs.push({ r, finish: resolve });
        r.controller.signal.addEventListener('abort', () => reject(r.controller.signal.reason));
      });
    },
  };
  return { runs, provider };
}
/** Call the Claude hooks a provider would install for this request, as a native edit would. */
async function nativeEdit(r: ProviderRequest, file: string, cwd: string, event = 'PreToolUse') {
  const hooks = researchHooks(r);
  try {
    return (await (hooks.hooks as any)[event][0].hooks[0](
      {
        hook_event_name: event,
        session_id: 'native',
        transcript_path: '',
        cwd,
        tool_use_id: 'edit',
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
        ...(event === 'PostToolUse' ? { tool_response: {} } : {}),
      },
      undefined,
      { signal: r.controller.signal },
    )) as any;
  } finally {
    hooks.close();
  }
}
const DASHES = new RegExp('[\\u2013\\u2014]');
const wakeOf = (f: ReturnType<typeof fixture>, id: string) =>
  f.store.get<{ content: string }>(
    'SELECT content FROM inbound WHERE id=?',
    `research:worker:${id}`,
  )?.content ?? '';

test('the first subagent to edit a file holds it; another running subagent is refused, the lead is not', async (t) => {
  const f = fixture(t);
  assert.equal(f.config.research.workers.fileHolds, true);
  const { runs, provider } = controlled();
  const m = new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
  );
  const first = delegate(f.store, f.session.id, f.config, 'first', { role: 'coder', brief: 'A' });
  const second = delegate(f.store, f.session.id, f.config, 'second', {
    role: 'analyst',
    brief: 'B',
  });
  m.tick();
  assert.equal(runs.length, 2);
  const [one, two] = runs.map((x) => x.r);
  assert.equal(one!.mcp.env.CLAWSTRUM_DELEGATION, first.id);
  const dir = f.session.workspace;
  const file = path.join(dir, 'shared.txt');
  fs.writeFileSync(file, 'a');
  fs.symlinkSync(file, path.join(dir, 'alias.txt'));

  assert.equal(
    (await nativeEdit(one!, file, dir)).hookSpecificOutput?.permissionDecision,
    undefined,
  );
  const hold = f.store.get<{ delegation_id: string }>(
    'SELECT delegation_id FROM worker_file_holds WHERE path=?',
    file,
  );
  assert.equal(hold?.delegation_id, first.id);
  // The holder keeps editing its own file.
  assert.equal(
    (await nativeEdit(one!, file, dir)).hookSpecificOutput?.permissionDecision,
    undefined,
  );

  // Relative and symlinked spellings of the same file are the same file.
  for (const spelling of ['shared.txt', 'alias.txt']) {
    const refused = await nativeEdit(two!, spelling, dir);
    assert.equal(refused.hookSpecificOutput.permissionDecision, 'deny');
    const reason = refused.hookSpecificOutput.permissionDecisionReason as string;
    assert.ok(reason.includes(`subagent ${first.id} (coder)`), reason);
    assert.match(reason, /wait/);
    assert.match(reason, /report the conflict to the lead/);
    assert.doesNotMatch(reason, DASHES);
  }
  // A different file is free.
  assert.equal(
    (await nativeEdit(two!, path.join(dir, 'other.txt'), dir)).hookSpecificOutput
      ?.permissionDecision,
    undefined,
  );

  // The lead runs with no delegation id and is never held.
  const lead = { ...one!, mcp: { ...one!.mcp, env: { ...one!.mcp.env } } };
  delete lead.mcp.env.CLAWSTRUM_DELEGATION;
  assert.equal(
    (await nativeEdit(lead, file, dir)).hookSpecificOutput?.permissionDecision,
    undefined,
  );

  // research.workers.fileHolds=false turns the refusal off.
  const off = {
    ...two!,
    research: { ...two!.research!, workers: { ...two!.research!.workers, fileHolds: false } },
  };
  assert.equal(
    (await nativeEdit(off, file, dir)).hookSpecificOutput?.permissionDecision,
    undefined,
  );

  // The hold ends with its holder, and the next subagent can take it.
  runs[0]!.finish('done');
  await Promise.allSettled([...m.active.values()].map((s) => s.promise).slice(0, 1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    f.store.get('SELECT 1 FROM worker_file_holds WHERE delegation_id=?', first.id),
    undefined,
  );
  assert.equal(
    (await nativeEdit(two!, file, dir)).hookSpecificOutput?.permissionDecision,
    undefined,
  );
  assert.equal(
    f.store.get<{ delegation_id: string }>(
      'SELECT delegation_id FROM worker_file_holds WHERE path=?',
      file,
    )?.delegation_id,
    second.id,
  );
  f.store.exec("UPDATE delegations SET status='cancelled' WHERE id=?", second.id);
  m.tick();
  await Promise.allSettled([...m.active.values()].map((s) => s.promise));
  assert.equal(f.store.get('SELECT 1 FROM worker_file_holds'), undefined);
});

test('restart recovery releases holds and lists the files the interrupted subagent changed', async (t) => {
  const f = fixture(t);
  const { runs, provider } = controlled();
  const m = new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
  );
  const row = delegate(f.store, f.session.id, f.config, 'held', { role: 'coder', brief: 'A' });
  m.tick();
  const file = path.join(f.session.workspace, 'kept.txt');
  await nativeEdit(runs[0]!.r, file, f.session.workspace);
  await nativeEdit(runs[0]!.r, file, f.session.workspace, 'PostToolUse');
  assert.ok(f.store.get('SELECT 1 FROM worker_file_holds WHERE delegation_id=?', row.id));
  // The daemon dies here: the delegation stays 'running' in the database with its hold.
  const restarted = new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
  );
  restarted.recover();
  assert.equal(
    f.store.get('SELECT 1 FROM worker_file_holds WHERE delegation_id=?', row.id),
    undefined,
  );
  const wake = wakeOf(f, row.id);
  assert.match(wake, /was interrupted/);
  assert.ok(wake.includes(`- ${file}`), wake);
  // The old in-memory run ending later must not fail the test.
  m.active.get(row.id)?.controller.abort(new Error('Daemon stopping'));
  await Promise.allSettled([...m.active.values()].map((s) => s.promise));
});

test('the completion wake lists changed files and flags a file another subagent changed at the same time', async (t) => {
  const f = fixture(t);
  const { runs, provider } = controlled();
  const m = new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
    () => ({ availableMB: 64000, source: 'test' }),
  );
  const dir = f.session.workspace;
  const shared = path.join(dir, 'shared.txt');
  const claude = delegate(f.store, f.session.id, f.config, 'claude', {
    role: 'coder',
    provider: 'claude',
    brief: 'A',
  });
  const codex = delegate(f.store, f.session.id, f.config, 'codex', {
    role: 'coder',
    provider: 'codex',
    brief: 'B',
  });
  m.tick();
  const [a, b] = runs;
  assert.equal(a!.r.account.provider, 'claude');
  assert.equal(b!.r.account.provider, 'codex');
  await nativeEdit(a!.r, shared, dir);
  await nativeEdit(a!.r, shared, dir, 'PostToolUse');
  // Codex applies its change without asking, so Clawstrum sees it only as an event.
  b!.r.onEvent({
    type: 'activity',
    detail: { type: 'fileChange', id: 'fc1', changes: [{ path: shared, kind: 'update' }] },
    tool: { id: 'fc1', name: 'fileChange', state: 'started' },
  });
  b!.r.onEvent({
    type: 'activity',
    detail: { type: 'file_change', id: 'fc2', changes: [{ path: 'own.txt', kind: 'add' }] },
  });
  assert.ok(
    f.store.get(
      "SELECT 1 FROM events WHERE type='research_file_hold_conflict' AND content LIKE ?",
      `%${claude.id}%`,
    ),
  );
  const steer = workerSteers(f.store, codex.id);
  assert.equal(steer.length, 1);
  assert.ok(steer[0]!.message.includes(`subagent ${claude.id} (coder)`));

  a!.finish('Claude result');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const first = wakeOf(f, claude.id);
  assert.match(first, /Files this subagent changed \(1;/);
  assert.ok(first.includes(`- ${shared}`), first);
  assert.ok(
    first.includes(`${shared} was also changed by subagent ${codex.id} (coder, running)`),
    first,
  );
  b!.finish('Codex result');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = wakeOf(f, codex.id);
  assert.ok(second.includes(`- ${path.join(b!.r.cwd, 'own.txt')}`), second);
  assert.ok(
    second.includes(`${shared} was also changed by subagent ${claude.id} (coder, completed)`),
  );
  assert.doesNotMatch(first + second, DASHES);

  // A subagent that ran after both ended is not flagged.
  const later = delegate(f.store, f.session.id, f.config, 'later', { role: 'coder', brief: 'C' });
  m.tick();
  await nativeEdit(runs[2]!.r, shared, dir);
  await nativeEdit(runs[2]!.r, shared, dir, 'PostToolUse');
  runs[2]!.finish('Later result');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.doesNotMatch(wakeOf(f, later.id), /also changed by/);
});

test('git changes in declared write paths are listed; older untracked files are not', async (t) => {
  const f = fixture(t);
  const { runs, provider } = controlled();
  const m = new ResearchWorkers(
    f.store,
    f.config,
    new AccountPool(f.config.accounts, f.store, 100),
    { claude: provider, codex: provider },
    () => 0,
  );
  const repo = path.join(f.session.workspace, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one');
  git('add', '.');
  git('commit', '-qm', 'start');
  fs.writeFileSync(path.join(repo, 'old.txt'), 'before the subagent');
  const past = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(repo, 'old.txt'), past, past);
  const row = delegate(f.store, f.session.id, f.config, 'git', {
    role: 'coder',
    brief: 'A',
    writePaths: [repo],
  });
  m.tick();
  // A shell edit: invisible to the hooks, visible to git at the end.
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'two');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new');
  runs[0]!.finish('done');
  await Promise.allSettled([...m.active.values()].map((s) => s.promise));
  const wake = wakeOf(f, row.id);
  assert.ok(wake.includes(`- ${path.join(repo, 'tracked.txt')} (git)`), wake);
  assert.ok(wake.includes(`- ${path.join(repo, 'new.txt')} (git)`), wake);
  assert.ok(!wake.includes('old.txt'), wake);
  assert.match(wake, /plus git changes in its declared write paths/);
});
