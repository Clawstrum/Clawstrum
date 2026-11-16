import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProviderFailure } from './accounts.js';
import type { Provider, ProviderName, ProviderRequest } from './types.js';

export function runWorker(
  r: ProviderRequest,
  worker = new URL(
    import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
    import.meta.url,
  ),
): Promise<string> {
  if (r.controller.signal.aborted) return Promise.reject(r.controller.signal.reason);
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(worker), [], {
      detached: process.platform !== 'win32',
      env: r.env,
      execArgv: worker.pathname.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let settled = false;
    let terminating = false;
    let answer: string | undefined;
    let failure: unknown;
    let grace: NodeJS.Timeout | undefined;
    let kill: NodeJS.Timeout | undefined;
    let stderr = '';
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32')
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 1000 });
        else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          emit({
            type: 'diagnostic',
            detail: { event: 'worker_kill_error', pid: child.pid, error: String(error) },
          });
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      clearTimeout(kill);
      r.controller.signal.removeEventListener('abort', abort);
      // Also reap descendants whose parent exited first.
      signalGroup('SIGKILL');
      child.stderr?.destroy();
      if (child.connected) child.disconnect();
      if (r.controller.signal.aborted) reject(r.controller.signal.reason);
      else if (failure) reject(failure);
      else if (answer !== undefined) resolve(answer);
      else
        reject(
          new ProviderFailure(
            'transient',
            `Provider worker exited without a result${stderr ? ': ' + stderr.slice(-2000) : ''}`,
          ),
        );
    };
    const terminate = () => {
      if (terminating || settled) return;
      terminating = true;
      signalGroup('SIGTERM');
      kill = setTimeout(() => {
        signalGroup('SIGKILL');
        // Normally exit reaps the child first. Bound even an OS process stuck in uninterruptible I/O.
        kill = setTimeout(finish, 1000);
      }, 1000);
    };
    const emit = (event: Parameters<ProviderRequest['onEvent']>[0]) => {
      if (settled) return;
      try {
        r.onEvent(event);
      } catch (error) {
        failure = error;
        terminate();
      }
    };
    const abort = () => {
      emit({
        type: 'diagnostic',
        detail: { event: 'worker_abort', pid: child.pid, stderr: stderr.slice(-4000) },
      });
      if (child.connected)
        child.send({ type: 'abort', message: String(r.controller.signal.reason) }, () => {});
      grace = setTimeout(terminate, r.abortGraceMs ?? 3000);
    };
    r.controller.signal.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => {
      failure = error;
      terminate();
    });
    child.on('exit', finish);
    child.stderr?.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-12000);
      emit({
        type: 'diagnostic',
        detail: { event: 'worker_stderr', pid: child.pid, text: data.toString().slice(-4000) },
      });
    });
    const attachInjector = () =>
      r.attachInjector?.((ids, text) => {
        if (settled || terminating || r.controller.signal.aborted || !child.connected) return false;
        try {
          child.send({ type: 'inject', ids, text }, (error) => {
            if (error) emit({ type: 'injected', detail: { ids, ok: false, uncertain: true } });
          });
          return true;
        } catch {
          return false;
        }
      });
    child.on('message', (message: any) => {
      if (settled) return;
      if (message.type === 'injector_ready') {
        attachInjector();
        return;
      }
      if (message.type === 'event') {
        emit(message.event);
        return;
      }
      if (message.type === 'result') {
        answer = message.result;
        emit({ type: 'completed' });
      } else if (message.type === 'failure')
        failure = new ProviderFailure(
          message.kind,
          message.message,
          message.retryAt,
          message.bucket,
        );
      else return;
      terminate();
    });
    emit({
      type: 'diagnostic',
      detail: { event: 'worker_started', pid: child.pid, provider: r.account.provider },
    });
    const { controller: _, onEvent: __, attachInjector: ___, ...request } = r;
    child.send({ type: 'run', request }, (error) => {
      if (error) {
        failure = error;
        terminate();
      }
    });
    if (r.controller.signal.aborted) abort();
  });
}
export const supervisedProviders: Record<ProviderName, Provider> = {
  claude: { run: runWorker },
  codex: { run: runWorker },
  gemini: { run: runWorker },
};
