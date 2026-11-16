import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Store } from '../store.js';
import { writePrivate } from '../files.js';
import { scrubbedEnvironment } from '../secrets.js';
import type { ResearchConfig } from './config.js';
import { researchWake } from './records.js';
import { bounded } from '../context.js';

const value = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[^\s\x00]+$/);
export const batchSchema = z
  .object({
    script: z.string().min(1),
    cwd: z.string().optional(),
    inputs: z.array(z.string()).max(100).default([]),
    resources: z
      .object({
        partition: value.optional(),
        account: value.optional(),
        time: value.optional(),
        mem: value.optional(),
        cpusPerTask: z.number().int().positive().optional(),
        nodes: z.number().int().positive().optional(),
        gres: value.optional(),
        array: value.optional(),
        output: value.optional(),
        error: value.optional(),
        constraint: value.optional(),
        qos: value.optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict();
type Batch = z.infer<typeof batchSchema>;
export interface ClusterJob {
  id: string;
  session_id: string;
  spec_json: string;
  script_path: string;
  script_hash: string;
  config_json: string;
  preflight_json: string;
  status: string;
  job_id: string | null;
  cluster: string | null;
  observation_json: string | null;
  error: string | null;
  checks: number;
  next_check: number | null;
}
export type Command = (
  command: string,
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
) => Promise<string>;
export function clusterCommand(config: ResearchConfig): Command {
  return async (command, args, cwd, signal) => {
    const { stdout, stderr } = await promisify(execFile)(command, args, {
      cwd,
      // Submitted jobs copy this environment by default; it holds the MCP server's research keys.
      env: scrubbedEnvironment(),
      signal,
      timeout: config.slurm.commandTimeoutMs,
      maxBuffer: 2000000,
      killSignal: 'SIGKILL',
    });
    return (
      stdout +
      (command === config.slurm.commands.sbatch && args.includes('--test-only') ? stderr : '')
    );
  };
}
function enabled(config: ResearchConfig) {
  if (!config.enabled || !config.slurm.enabled)
    throw new Error('Enable research.enabled and research.slurm.enabled first');
}
function options(spec: Batch): string[] {
  const names: Record<string, string> = { cpusPerTask: 'cpus-per-task' };
  return Object.entries(spec.resources).map(([key, val]) => `--${names[key] ?? key}=${val}`);
}
const ACTIVATE = /^\s*(?:conda|mamba|micromamba)\s+activate\b/;
const CONDA_HOOK =
  /(?:^|\s)(?:\.|source)\s+\S*\/etc\/profile\.d\/\w+\.sh|\b(?:conda|mamba|micromamba)\s+shell(?:\.[a-z]+)?\s+hook/;
const BARE_INTERPRETER = /(?:^|[\s;&|(])(?:python|python3|ipython|jupyter)(?:\s|$)/;
const ABSOLUTE_INTERPRETER = /\/[\w./+-]*\/bin\/(?:python|python3|ipython|jupyter)/;
/** Batch-script mistakes that sbatch accepts and the job only reveals once it has queued and run.
 * Scheduler validation cannot see any of them: --test-only parses directives, not the script body.
 */
export function scriptIssues(script: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = script.split('\n');
  const firstCommand = lines.findIndex(
    (line, i) => i > 0 && line.trim() && !line.trim().startsWith('#'),
  );
  if (firstCommand > 0)
    lines.forEach((line, i) => {
      if (i > firstCommand && /^\s*#SBATCH\b/.test(line))
        errors.push(
          `Line ${i + 1}: sbatch stops reading directives at the first command, so this #SBATCH is silently ignored. Move it above line ${firstCommand + 1}.`,
        );
    });
  const activate = lines.findIndex((line) => ACTIVATE.test(line));
  if (
    activate >= 0 &&
    !lines
      .slice(0, activate)
      .some((line) => !line.trimStart().startsWith('#') && CONDA_HOOK.test(line))
  )
    errors.push(
      `Line ${activate + 1}: a batch shell is not interactive, so 'activate' fails until the shell hook is sourced. Source <base>/etc/profile.d/conda.sh first, or invoke the environment's interpreter by absolute path.`,
    );
  const bare = lines.findIndex(
    (line, i) =>
      i > 0 &&
      !line.trim().startsWith('#') &&
      !/^\s*module\b/.test(line) &&
      BARE_INTERPRETER.test(line.replace(/#.*$/, '')),
  );
  if (bare >= 0 && !ABSOLUTE_INTERPRETER.test(script))
    warnings.push(
      `Line ${bare + 1}: the interpreter comes from PATH. A batch job inherits no login environment, and module- or conda-provided interpreters are observed not to resolve there on some clusters; an absolute .../bin/python path removes the failure mode.`,
    );
  return { errors, warnings };
}
function normalizeBatch(
  store: Store,
  sessionId: string,
  input: z.input<typeof batchSchema>,
): Batch {
  const parsed = batchSchema.parse(input);
  const base = store.session(sessionId).workspace;
  const cwd = path.resolve(base, parsed.cwd ?? base);
  return {
    ...parsed,
    cwd,
    script: path.resolve(base, parsed.script),
    inputs: parsed.inputs.map((file) => path.resolve(cwd, file)),
  };
}
export async function preflight(
  store: Store,
  sessionId: string,
  config: ResearchConfig,
  input: z.input<typeof batchSchema>,
  command = clusterCommand(config),
  signal?: AbortSignal,
) {
  enabled(config);
  const spec = normalizeBatch(store, sessionId, input);
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks: Record<string, string> = {};
  let script = '';
  try {
    script = fs.readFileSync(spec.script, 'utf8');
    if (!script.startsWith('#!')) errors.push('Batch script requires a shebang');
    const issues = scriptIssues(script);
    errors.push(...issues.errors);
    warnings.push(...issues.warnings);
  } catch (e) {
    errors.push(String(e));
  }
  try {
    if (!fs.statSync(spec.cwd!).isDirectory()) errors.push('cwd is not a directory');
    else {
      const disk = fs.statfsSync(spec.cwd!);
      checks.availableBytes = String(disk.bavail * disk.bsize);
    }
  } catch (e) {
    errors.push(String(e));
  }
  for (const file of spec.inputs)
    try {
      fs.accessSync(file, fs.constants.R_OK);
    } catch {
      errors.push(`Input is not readable: ${file}`);
    }
  for (const [name, args] of [
    ['sinfo', ['--noheader', '--format=%P|%a|%l|%D']],
    ['sshare', ['--noheader', '--parsable2']],
    ['squeue', ['--me', '--noheader', '--format=%i|%T|%j']],
  ] as const) {
    try {
      checks[name] = (
        await command(config.slurm.commands[name], [...args], spec.cwd, signal)
      ).slice(0, 16000);
    } catch (e) {
      signal?.throwIfAborted();
      warnings.push(`${name}: ${String(e).slice(0, 500)}`);
    }
  }
  if (!errors.length)
    try {
      checks.testOnly = (
        await command(
          config.slurm.commands.sbatch,
          ['--test-only', ...options(spec), `--chdir=${spec.cwd}`, spec.script],
          spec.cwd,
          signal,
        )
      ).slice(0, 16000);
    } catch (e) {
      signal?.throwIfAborted();
      errors.push(`sbatch --test-only: ${String(e).slice(0, 2000)}`);
    }
  signal?.throwIfAborted();
  return {
    ok: !errors.length,
    spec,
    scriptHash: createHash('sha256').update(script).digest('hex'),
    checkedAt: Date.now(),
    errors,
    warnings,
    checks,
    scope:
      'Scheduler validation and declared input checks; does not prove code, runtime environment, memory estimates or scientific correctness.',
  };
}
export async function submitJob(
  store: Store,
  sessionId: string,
  config: ResearchConfig,
  key: string,
  input: z.input<typeof batchSchema>,
  command = clusterCommand(config),
  signal?: AbortSignal,
  watchInput?: z.input<typeof watchSchema>,
): Promise<ClusterJob> {
  enabled(config);
  const spec = normalizeBatch(store, sessionId, input);
  const watch = watchInput ? normalizeWatch(store, sessionId, watchInput) : undefined;
  const script = fs.readFileSync(spec.script, 'utf8');
  const hash = createHash('sha256').update(script).digest('hex');
  const dedupe = `${sessionId}:cluster:${key}`;
  const row = store.transaction(() => {
    const old = store.get<ClusterJob>('SELECT * FROM cluster_jobs WHERE dedupe_key=?', dedupe);
    if (old) {
      if (old.spec_json !== JSON.stringify(spec) || old.script_hash !== hash)
        throw new Error('Submission key already names different script content or parameters');
      return old;
    }
    const id = randomUUID();
    const captured = path.join(store.home, 'research', 'jobs', id, 'batch.sh');
    writePrivate(captured, script);
    store.exec(
      'INSERT INTO cluster_jobs(id,session_id,dedupe_key,spec_json,script_path,script_hash,config_json,preflight_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      id,
      sessionId,
      dedupe,
      JSON.stringify(spec),
      captured,
      hash,
      JSON.stringify(config),
      JSON.stringify({ watch }),
      'prepared',
      Date.now(),
      Date.now(),
    );
    return store.get<ClusterJob>('SELECT * FROM cluster_jobs WHERE id=?', id)!;
  });
  if (row.status !== 'prepared') return row;
  const report = await preflight(
    store,
    sessionId,
    config,
    { ...spec, script: row.script_path },
    command,
    signal,
  );
  // The monitor reads follow-up settings from preflight_json, so the report must not replace them.
  store.exec(
    'UPDATE cluster_jobs SET preflight_json=?,updated_at=? WHERE id=?',
    JSON.stringify({ ...report, watch: watch ?? JSON.parse(row.preflight_json).watch }),
    Date.now(),
    row.id,
  );
  if (!report.ok)
    throw new Error(`Preflight failed; no job submitted: ${report.errors.join('; ')}`);
  signal?.throwIfAborted();
  if (
    !store.exec(
      "UPDATE cluster_jobs SET status='submitting',updated_at=? WHERE id=? AND status='prepared'",
      Date.now(),
      row.id,
    ).changes
  )
    return store.get<ClusterJob>('SELECT * FROM cluster_jobs WHERE id=?', row.id)!;
  try {
    const output = await command(
      config.slurm.commands.sbatch,
      [
        '--parsable',
        ...options(spec),
        `--chdir=${spec.cwd}`,
        `--comment=clawstrum:${row.id}`,
        row.script_path,
      ],
      spec.cwd,
      signal,
    );
    const ack = /^(\d+)(?:;([\w.-]+))?\s*$/m.exec(output);
    if (!ack) throw new Error(`Unrecognized scheduler acknowledgement: ${output.slice(0, 1000)}`);
    store.exec(
      "UPDATE cluster_jobs SET status='watching',job_id=?,cluster=?,next_check=?,updated_at=? WHERE id=?",
      ack[1]!,
      ack[2] ?? null,
      Date.now(),
      Date.now(),
      row.id,
    );
  } catch (e) {
    // A timeout does not prove the scheduler rejected the job. Never automatically submit again.
    store.transaction(() => {
      store.exec(
        "UPDATE cluster_jobs SET status='unknown',error=?,updated_at=? WHERE id=?",
        String(e).slice(0, 3000),
        Date.now(),
        row.id,
      );
      researchWake(
        store,
        sessionId,
        `job:${row.id}:unknown`,
        `Submission outcome unknown for ${row.id}. Search scheduler comments for clawstrum:${row.id}, then adopt the confirmed job ID. Do not repeat sbatch. Captured script: ${row.script_path}`,
      );
    });
  }
  return store.get<ClusterJob>('SELECT * FROM cluster_jobs WHERE id=?', row.id)!;
}
const jobId = z.string().regex(/^\d+(?:_\d+)?$/);
const clusterName = z.string().regex(/^[\w.-]+$/);
export const watchSchema = z
  .object({
    followup: z.string().min(1).max(50000).optional(),
    logPath: z.string().min(1).optional(),
    stallAfterMs: z.number().int().nonnegative().optional(),
    deadlineAt: z.number().int().positive().optional(),
    quietCancelledBy: z.number().int().nonnegative().optional(),
    stallAlreadyNotified: z.boolean().optional(),
  })
  .strict();
function normalizeWatch(store: Store, sessionId: string, watch: z.input<typeof watchSchema>) {
  const parsed = watchSchema.parse(watch);
  // The daemon's cwd is not the session workspace; a relative log would never be found.
  if (parsed.logPath)
    parsed.logPath = path.resolve(store.session(sessionId).workspace, parsed.logPath);
  return parsed;
}

export function watchJob(
  store: Store,
  sessionId: string,
  config: ResearchConfig,
  id: string,
  cluster?: string,
  adopt?: string,
  watch?: z.input<typeof watchSchema>,
) {
  enabled(config);
  if (watch) watch = normalizeWatch(store, sessionId, watch);
  jobId.parse(id);
  if (cluster) clusterName.parse(cluster);
  if (adopt) {
    const old = store.get<ClusterJob>(
      'SELECT * FROM cluster_jobs WHERE id=? AND session_id=?',
      adopt,
      sessionId,
    );
    if (!old || !['unknown', 'watch-stopped'].includes(old.status))
      throw new Error('Only an unknown submission or stopped watch can be adopted');
    store.exec(
      "UPDATE cluster_jobs SET job_id=?,cluster=?,status='watching',error=NULL,checks=0,next_check=?,updated_at=? WHERE id=?",
      id,
      cluster ?? null,
      Date.now(),
      Date.now(),
      adopt,
    );
    if (watch)
      store.exec(
        'UPDATE cluster_jobs SET preflight_json=? WHERE id=?',
        JSON.stringify({ watch }),
        adopt,
      );
    return { id: adopt, jobId: id };
  }
  const key = `${sessionId}:watch:${cluster ?? ''}:${id}`;
  const existing = store.get<ClusterJob>('SELECT * FROM cluster_jobs WHERE dedupe_key=?', key);
  if (
    existing &&
    watch &&
    JSON.stringify(JSON.parse(existing.preflight_json ?? '{}').watch) !== JSON.stringify(watch)
  )
    throw new Error(
      'Watch already has different follow-up settings; stop and adopt it to replace them',
    );
  const uuid = randomUUID();
  store.exec(
    'INSERT OR IGNORE INTO cluster_jobs(id,session_id,dedupe_key,spec_json,script_path,script_hash,config_json,preflight_json,status,job_id,cluster,next_check,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    uuid,
    sessionId,
    key,
    '{}',
    '',
    '',
    JSON.stringify(config),
    JSON.stringify({ watch }),
    'watching',
    id,
    cluster ?? null,
    Date.now(),
    Date.now(),
    Date.now(),
  );
  return store.get<ClusterJob>('SELECT * FROM cluster_jobs WHERE dedupe_key=?', key)!;
}
export function arrayIndices(expression: string): Set<number> | undefined {
  const found = new Set<number>();
  for (const term of expression.replace(/%\d+$/, '').split(',')) {
    const part = /^(\d+)(?:-(\d+)(?::(\d+))?)?$/.exec(term);
    if (!part) return;
    const first = Number(part[1]);
    const last = Number(part[2] ?? part[1]);
    const step = Number(part[3] ?? 1);
    if (!Number.isSafeInteger(last) || last < first || step < 1 || (last - first) / step > 100000)
      return;
    for (let i = first; i <= last; i += step) {
      found.add(i);
      if (found.size > 100000) return;
    }
  }
  return found;
}
function expectedArray(row: ClusterJob): string | undefined {
  const spec = JSON.parse(row.spec_json);
  if (spec.resources?.array) return spec.resources.array;
  if (!row.script_path) return;
  let expression: string | undefined;
  for (const line of fs.readFileSync(row.script_path, 'utf8').split('\n')) {
    if (line.trim() && !line.trim().startsWith('#')) break;
    const match = /^\s*#SBATCH\s+(?:--array(?:=|\s+)|-a\s+)([0-9,:%%-]+)/.exec(line);
    if (match) expression = match[1];
  }
  return expression;
}
const terminal = new Set([
  'BOOT_FAIL',
  'CANCELLED',
  'COMPLETED',
  'DEADLINE',
  'FAILED',
  'NODE_FAIL',
  'OUT_OF_MEMORY',
  'PREEMPTED',
  'REVOKED',
  'TIMEOUT',
]);
export function parseAccounting(text: string) {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id = '', raw = '', exit = '', elapsed = '', maxRss = ''] = line.split('|');
      return { id, state: raw.trim().split(/[ +]/)[0]!, exit, elapsed, maxRss };
    })
    .filter((row) => row.id);
}
/** Scheduler evidence only: exit 137, for example, does not by itself establish an OOM. */
export function classifyJobFailures(accounting: ReturnType<typeof parseAccounting>) {
  const kinds: Record<string, { kind: string; advice: string }> = {
    OUT_OF_MEMORY: {
      kind: 'out-of-memory',
      advice:
        'Inspect per-step MaxRSS and the application memory profile before changing resource requests.',
    },
    TIMEOUT: {
      kind: 'timeout',
      advice: 'Inspect elapsed time, progress and checkpoints before adjusting the walltime.',
    },
    PREEMPTED: {
      kind: 'preempted',
      advice:
        'Check whether Slurm requeued the job and whether the application saved a valid checkpoint before resubmitting.',
    },
    NODE_FAIL: {
      kind: 'node-failure',
      advice:
        'Inspect scheduler diagnostics and outputs; reconcile any existing requeue before retrying.',
    },
    BOOT_FAIL: {
      kind: 'node-failure',
      advice: 'Inspect scheduler diagnostics; application execution may not have started.',
    },
    CANCELLED: {
      kind: 'cancelled',
      advice: 'Check who cancelled the job and why before restarting work.',
    },
    DEADLINE: { kind: 'deadline', advice: 'Inspect the scheduler deadline and remaining work.' },
    REVOKED: {
      kind: 'revoked',
      advice: 'Reconcile federation or sibling job state before resubmitting.',
    },
    FAILED: {
      kind: 'application-or-unknown',
      advice:
        'Read stdout/stderr and the exit code; the scheduler state alone does not identify the cause.',
    },
  };
  return accounting.flatMap((row) => {
    const classification =
      kinds[row.state] ??
      (row.state === 'COMPLETED' && row.exit !== '0:0'
        ? /^\d+:\d+$/.test(row.exit)
          ? { kind: 'nonzero-exit', advice: 'Inspect the nonzero exit status and actual outputs.' }
          : {
              kind: 'unconfirmed-exit',
              advice:
                'Accounting has no valid exit status yet; inspect outputs and query accounting again.',
            }
        : undefined);
    return classification
      ? [{ jobId: row.id, state: row.state, exit: row.exit, ...classification }]
      : [];
  });
}
export class ClusterMonitor {
  pending?: Promise<void>;
  readonly controller = new AbortController();
  private readonly retries = new Map<string, { failures: number; nextCheck: number }>();
  constructor(
    readonly store: Store,
    readonly command?: Command,
    readonly workAlone = false,
  ) {}
  recover() {
    for (const row of this.store.all<ClusterJob>(
      "SELECT * FROM cluster_jobs WHERE status='submitting'",
    ))
      this.store.transaction(() => {
        this.store.exec(
          "UPDATE cluster_jobs SET status='unknown',error='Daemon stopped during scheduler submission',updated_at=? WHERE id=?",
          Date.now(),
          row.id,
        );
        researchWake(
          this.store,
          row.session_id,
          `job:${row.id}:unknown`,
          `Submission ${row.id} was interrupted. Reconcile scheduler comment clawstrum:${row.id}; no automatic resubmission.`,
        );
      });
  }
  tick(now = Date.now()) {
    if (this.pending || this.controller.signal.aborted) return;
    this.pending = this.poll(now)
      .catch((e) => {
        if (!this.controller.signal.aborted)
          console.error(JSON.stringify({ event: 'cluster_monitor_error', error: String(e) }));
      })
      .finally(() => {
        this.pending = undefined;
      });
  }
  async poll(now = Date.now()) {
    for (const row of this.store.all<ClusterJob>(
      "SELECT * FROM cluster_jobs WHERE status='watching' AND next_check<=? ORDER BY next_check LIMIT 20",
      now,
    )) {
      if (this.controller.signal.aborted) return;
      if ((this.retries.get(row.id)?.nextCheck ?? 0) > now) continue;
      const config: ResearchConfig = JSON.parse(row.config_json);
      const command = this.command ?? clusterCommand(config);
      const signal = this.controller.signal;
      let status = 'watching';
      let error: string | null = null;
      let observation: unknown;
      const watch = JSON.parse(row.preflight_json ?? '{}').watch ?? {};
      let quietCancellation = false;
      let stall: string | undefined;
      let notVisibleMessage: string | undefined;
      try {
        const cluster = row.cluster ? [`--clusters=${row.cluster}`] : [];
        let queue = '';
        // squeue drops a finished job and then fails, sometimes with an empty message. A failed
        // squeue is not evidence that the job is still queued: accounting below decides.
        // Otherwise finished jobs stay "watching" and keep posting error notices.
        let queueUnknown = false;
        try {
          queue = (
            await command(
              config.slurm.commands.squeue,
              [...cluster, `--jobs=${row.job_id}`, '--noheader', '--format=%i|%T|%j'],
              undefined,
              signal,
            )
          ).trim();
        } catch (e) {
          if (signal.aborted) throw e;
          if (!/Invalid job id specified/i.test(String(e))) queueUnknown = true;
        }

        // While squeue still lists the job, accounting is not needed to know it is unfinished. The
        // accounting database can refuse connections while squeue works, and a pending job's
        // watcher would then post a sacct error notice to the channel.
        let accountingDown = false;
        let accountingText = '';
        try {
          accountingText = await command(
            config.slurm.commands.sacct,
            [
              ...cluster,
              `--jobs=${row.job_id}`,
              '--noheader',
              '--parsable2',
              '--format=JobID%64,State%40,ExitCode,Elapsed,MaxRSS',
            ],
            undefined,
            signal,
          );
        } catch (e) {
          if (signal.aborted || !queue) throw e;
          accountingDown = true;
        }
        const accounting = parseAccounting(accountingText);
        observation = {
          queue,
          accounting,
          failures: classifyJobFailures(accounting),
          ...(accountingDown ? { accountingUnavailable: true } : {}),
        };
        const allocations = accounting.filter((r) => !r.id.includes('.'));
        const expression = expectedArray(row);
        const expected = expression ? arrayIndices(expression) : undefined;
        // Array tasks cancelled before they started appear as one range row, e.g.
        // "123_[7-39%4]|CANCELLED by 1000".
        const observedIndices = new Set(
          allocations.flatMap((r) => {
            const m = /_(\d+)$/.exec(r.id);
            if (m) return [Number(m[1])];
            const range = /_\[([^\]]+)\]$/.exec(r.id);
            return range ? [...(arrayIndices(range[1]!) ?? [])] : [];
          }),
        );
        const completeInventory =
          !expression || (expected && [...expected].every((i) => observedIndices.has(i)));
        if (!completeInventory && !accountingDown)
          error =
            'Array accounting is incomplete or its index expression is unsupported; completion is unconfirmed';
        if (
          !queue &&
          completeInventory &&
          allocations.length &&
          allocations.every((r) => terminal.has(r.state))
        )
          status = allocations.every((r) => r.state === 'COMPLETED' && r.exit === '0:0')
            ? 'completed'
            : 'failed';
        else if (!queue && !accounting.length) {
          // A Slurm job submitted under another Unix user is invisible to our account: squeue and
          // sacct both return nothing, on the very first check. Without this the watch polls to
          // the budget instead of stopping, then posts an unconfirmed-completion error.
          if (row.checks === 0 && !accountingDown) {
            status = 'watch-stopped';
            notVisibleMessage = `Slurm job ${row.job_id} (${row.id}) is not visible to this account: squeue and sacct both return nothing on the first check. If another Unix user submitted it, this monitor cannot watch it; watch it with a check that runs as that user. The watch is stopped.`;
            error = notVisibleMessage;
          } else
            error = queueUnknown
              ? 'Queue check failed and the job is absent from accounting; completion is unconfirmed'
              : 'Job absent from queue and accounting; completion is unconfirmed';
        }
        if (status === 'failed' && Number.isSafeInteger(watch.quietCancelledBy)) {
          const parent = accountingText
            .split('\n')
            .find((line) => line.split('|')[0]?.trim() === row.job_id);
          quietCancellation =
            parent?.split('|')[1]?.trim() === `CANCELLED by ${watch.quietCancelledBy}`;
        }
        if (
          status === 'watching' &&
          /\|RUNNING\|/.test(queue) &&
          watch.logPath &&
          watch.stallAfterMs > 0 &&
          !watch.stallAlreadyNotified
        ) {
          try {
            const age = now - fs.statSync(watch.logPath).mtimeMs;
            if (age >= watch.stallAfterMs)
              stall = `Possible stall: Slurm job ${row.job_id} is RUNNING, but ${watch.logPath} has not changed for ${Math.floor(age / 1000)} seconds. This is not a terminal state. Check accounting and the log before drawing a conclusion. The completion watch remains active.`;
          } catch {
            /* A missing log does not establish a stall. */
          }
        }
      } catch (e) {
        if (signal.aborted) return;
        error = String(e).slice(0, 2000);
        observation = { error };
      }
      if (
        status === 'watching' &&
        (row.checks + 1 >= config.slurm.maxChecks || (watch.deadlineAt && now >= watch.deadlineAt))
      ) {
        status = 'watch-stopped';
        error = error ?? 'Polling budget exhausted before confirmed completion';
      }
      // A side-effect failure (quota, NFS, SQLITE_BUSY) must not reject the whole poll: the row
      // would stay due and the daemon tick would re-query the scheduler about twice a second.
      try {
        const observationPath = path.join(
          this.store.home,
          'research',
          'jobs',
          row.id,
          'OBSERVATION.json',
        );
        writePrivate(
          observationPath,
          JSON.stringify({ at: now, status, error, observation }, null, 2),
        );
        this.store.transaction(() => {
          this.store.exec('DELETE FROM metadata WHERE key=?', `cluster-poll-failures:${row.id}`);
          if (
            !this.store.exec(
              "UPDATE cluster_jobs SET status=?,observation_json=?,error=?,checks=checks+1,next_check=?,updated_at=? WHERE id=? AND status='watching'",
              status,
              JSON.stringify(observation),
              error,
              status === 'watching' ? now + config.slurm.pollMs : null,
              now,
              row.id,
            ).changes
          )
            return;
          if (JSON.stringify(observation) !== row.observation_json)
            this.store.event(row.session_id, null, 'cluster_observation', {
              id: row.id,
              status,
              observationPath,
              excerpt: bounded(JSON.stringify(observation), 4000),
            });
          if (stall) researchWake(this.store, row.session_id, `job:${row.id}:stall`, stall);
          if (notVisibleMessage)
            researchWake(
              this.store,
              row.session_id,
              `job:${row.id}:not-visible`,
              notVisibleMessage,
            );
          else if (status !== 'watching' && !quietCancellation)
            researchWake(
              this.store,
              row.session_id,
              `job:${row.id}:${status}`,
              `Slurm job ${row.job_id} (${row.id}) is ${status}. ${error ?? ''}\nObservation: ${observationPath}\n${bounded(JSON.stringify(observation), 3000)}${watch.followup ? `\nOriginal follow-up instructions: ${watch.followup}${this.workAlone ? '\nRead the output against this follow-up first: which outcome happened, and what was planned for it.' : ''}` : ''}`,
            );
          else if (error && error !== row.error)
            // At most one wake per job per day: the error text can alternate between checks, and
            // each change used to wake again.
            researchWake(
              this.store,
              row.session_id,
              `job:${row.id}:error:${Math.floor(now / 86400000)}`,
              `Job monitor ${row.id} (Slurm job ${row.job_id}): ${error}. Polling continues within its configured budget. This is not a terminal state.`,
            );
        });
      } catch (e) {
        if (signal.aborted) return;
        const retry = { failures: (this.retries.get(row.id)?.failures ?? 0) + 1, nextCheck: now };
        const backoff = () => {
          retry.nextCheck =
            now +
            Math.max(
              config.slurm.pollMs,
              Math.min(3600000, config.slurm.pollMs * 2 ** Math.min(16, retry.failures - 1)),
            );
          this.retries.set(row.id, retry);
        };
        // Set the local gate before touching SQLite: the failed side effect may be a DB write.
        backoff();
        try {
          this.store.transaction(() => {
            const failures = Number(
              this.store.get<{ value: string }>(
                'SELECT value FROM metadata WHERE key=?',
                `cluster-poll-failures:${row.id}`,
              )?.value ?? 0,
            );
            retry.failures = Math.max(retry.failures, failures + 1);
            backoff();
            const nextCheck = retry.nextCheck;
            this.store.exec(
              'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
              `cluster-poll-failures:${row.id}`,
              String(retry.failures),
            );
            this.store.exec(
              "UPDATE cluster_jobs SET next_check=?,updated_at=? WHERE id=? AND status='watching'",
              nextCheck,
              now,
              row.id,
            );
            this.store.event(row.session_id, null, 'cluster_monitor_error', {
              id: row.id,
              error: String(e).slice(0, 2000),
              failures: retry.failures,
              nextCheck,
            });
          });
        } catch (inner) {
          console.error(
            JSON.stringify({ event: 'cluster_monitor_error', id: row.id, error: String(inner) }),
          );
        }
        continue;
      }
      this.retries.delete(row.id);
    }
  }
  async stop() {
    this.controller.abort();
    await this.pending;
    this.retries.clear();
  }
}
