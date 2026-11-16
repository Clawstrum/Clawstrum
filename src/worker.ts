// Each provider turn owns a process group. This is lifecycle isolation, not a sandbox.
import { providers } from './providers.js';
import { classifyError, ProviderFailure } from './accounts.js';
import type { ProviderRequest } from './types.js';
import { runtimeIdentity } from './runtime.js';

const controller = new AbortController();
let started = false;
let inject: ((ids: string[], text: string) => boolean) | undefined;
const send = (message: unknown) => {
  if (process.connected) process.send!(message, () => {});
};
let crashed = false;
const crash = (error: unknown) => {
  if (crashed) return;
  crashed = true;
  const failure = classifyError(error);
  controller.abort(failure);
  send({
    type: 'failure',
    kind: failure.kind,
    message: failure.message,
    retryAt: failure.retryAt,
    bucket: failure.bucket,
  });
  // Report once, then exit. The parent reaps this entire process group.
  setTimeout(() => process.exit(1), 50);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
process.on('disconnect', () => {
  controller.abort(new Error('Clawstrum supervisor disconnected'));
  if (process.platform !== 'win32') {
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      process.exit(1);
    }
  } else process.exit(1);
});
process.on('message', async (message: any) => {
  if (message.type === 'abort') {
    controller.abort(new ProviderFailure(message.kind ?? 'fatal', message.message));
    return;
  }
  if (message.type === 'inject') {
    if (inject && !controller.signal.aborted) inject(message.ids, message.text);
    else
      send({
        type: 'event',
        event: { type: 'injected', detail: { ids: message.ids, ok: false } },
      });
    return;
  }
  if (message.type !== 'run' || started) return;
  started = true;
  const request = message.request as ProviderRequest;
  try {
    const identity = await runtimeIdentity(request.account, request.env);
    send({
      type: 'event',
      event: { type: 'diagnostic', detail: { event: 'runtime_version', ...identity } },
    });
    const blocked = request.blockedVersions?.find(
      (v) => v.provider === identity.provider && v.version === identity.version,
    );
    if (blocked)
      throw new ProviderFailure(
        'fatal',
        `Runtime ${identity.provider} ${identity.version} is quarantined: ${blocked.reason}`,
      );
    const result = await providers[request.account.provider].run({
      ...request,
      controller,
      attachInjector: (fn) => {
        inject = fn;
        send({ type: 'injector_ready' });
      },
      onEvent: (event) => send({ type: 'event', event }),
    });
    inject = undefined;
    send({ type: 'result', result });
  } catch (error) {
    inject = undefined;
    const failure = classifyError(error);
    send({
      type: 'failure',
      kind: failure.kind,
      message: failure.message,
      retryAt: failure.retryAt,
      bucket: failure.bucket,
    });
  }
});
