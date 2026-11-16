/**
 * A network failure inside a library (Discord gateway, provider HTTP) that nothing awaited
 * reaches the process as an uncaught exception. Stopping the daemon on each one interrupted
 * running turns and subagents, sometimes several times within an hour in one deployment. The
 * stacks logged had no Clawstrum frame in them, and the libraries reconnect on their own, so
 * these are logged and the daemon keeps running.
 */
const NETWORK_MESSAGES = [
  /socket hang up/i,
  /Opening handshake has timed out/i,
  /Client network socket disconnected before secure TLS connection was established/i,
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH)\b/,
  /Cannot read properties of null \(reading 'setHeader'\)/,
];
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);
/** True when the stack contains a frame from Clawstrum's own code (src or dist). */
function hasOwnFrame(stack: string): boolean {
  return stack
    .split('\n')
    .slice(1)
    .some((line) => !line.includes('node_modules') && /[/\\](src|dist)[/\\]/.test(line));
}
export function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const stack = error.stack ?? '';
  if (hasOwnFrame(stack)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && NETWORK_CODES.has(code)) return true;
  return NETWORK_MESSAGES.some((pattern) => pattern.test(error.message));
}
/**
 * Too many in a short time means the network is not coming back by itself; then the caller
 * should stop and let the service manager restart the process.
 */
export class NetworkErrorBudget {
  private times: number[] = [];
  constructor(
    readonly limit = 20,
    readonly windowMs = 600000,
  ) {}
  /** Records one error; returns false once more than `limit` fall inside the window. */
  allow(now = Date.now()): boolean {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    this.times.push(now);
    return this.times.length <= this.limit;
  }
}
