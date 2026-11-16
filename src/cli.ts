#!/usr/bin/env node
// Keep this bootstrap free of dependencies and type syntax so unsupported Node versions get a useful error.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
// node:sqlite prints an ExperimentalWarning on first load, which lands in the middle of setup prompts.
// Replace Node's default warning printer with one that skips only that warning.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (!warning.message.startsWith('SQLite is an experimental feature'))
    console.error(`(node:${process.pid}) ${warning.name}: ${warning.message}`);
});
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `Clawstrum requires Node.js >=22.13.0 (found ${process.version}). Install a supported Node version and rerun clawstrum doctor.`,
  );
  process.exitCode = 1;
} else if (
  process.argv[2] === 'start' &&
  (await import('./boot-guard.js')).bootGuard() === 'rolled-back'
) {
  // Exit nonzero so the supervisor starts again, now on the restored build.
  console.error('Clawstrum did not start after the last apply; restored the previous build.');
  process.exitCode = 1;
} else {
  // 'swapped' also lands here: dist now holds the new build, so this import loads it.
  const { main } = await import('./cli-main.js');
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  // start() has finished cleanup and main() has closed the database. SDK sockets
  // can outlive destroy(); do not leave a dead daemon looking healthy to systemd.
  if (process.argv[2] === 'start') process.exit(process.exitCode ?? 0);
}
