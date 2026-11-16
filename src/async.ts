/** Bound cancellation even when a dependency ignores its AbortSignal. */
export function abortAfter<T>(promise: Promise<T>, signal: AbortSignal, graceMs = 0): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const abort = () => {
      timer = setTimeout(() => reject(signal.reason), graceMs);
    };
    const clean = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      (value) => {
        clean();
        resolve(value);
      },
      (error) => {
        clean();
        reject(error);
      },
    );
  });
}
