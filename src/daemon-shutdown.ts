/** Give subagents time to save/requeue progress, then let the supervisor recover a stuck daemon. */
export function withShutdownDeadline(
  cleanup: () => Promise<void>,
  timeoutMs = 25000,
): Promise<void> {
  const deadline = setTimeout(() => {
    console.error(JSON.stringify({ event: 'daemon_shutdown_timeout', timeoutMs }));
    process.exit(1);
  }, timeoutMs);
  return Promise.resolve()
    .then(cleanup)
    .finally(() => clearTimeout(deadline));
}
