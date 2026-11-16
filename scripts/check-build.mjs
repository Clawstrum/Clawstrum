// Build/test/prepack must not replace code that a running daemon loads for new workers.
// Read ownership metadata only: opening Store here could itself attempt a schema migration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const root = real(process.cwd());
const target = real(path.join(root, 'dist'));
const colocated = real(path.join(root, 'runtime'));
const homes = new Set([
  colocated,
  real(process.env.CLAWSTRUM_HOME || path.join(os.homedir(), '.clawstrum')),
]);
for (const home of homes) {
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(home, 'daemon.lock'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    if (home !== colocated) continue;
    throw new Error(
      `Cannot verify build ownership from ${home}/daemon.lock. Build in an isolated checkout.`,
    );
  }
  if (
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.host !== 'string'
  ) {
    if (home !== colocated) continue;
    throw new Error(
      `Invalid build ownership in ${home}/daemon.lock. Build in an isolated checkout.`,
    );
  }
  if (owner.host === os.hostname()) {
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') continue;
      // EPERM and other uncertainty do not prove that the owner has stopped.
    }
  }
  let entrypoint = typeof owner.entrypoint === 'string' ? owner.entrypoint : undefined;
  if (!entrypoint && owner.host === os.hostname() && process.platform === 'linux') {
    try {
      const args = fs.readFileSync(`/proc/${owner.pid}/cmdline`, 'utf8').split('\0');
      entrypoint = args.find((arg) => /(?:^|[/\\])(?:cli|cli-main)\.js$/.test(arg));
      if (entrypoint && !path.isAbsolute(entrypoint))
        entrypoint = path.resolve(fs.readlinkSync(`/proc/${owner.pid}/cwd`), entrypoint);
    } catch {
      /* Legacy colocated state remains protected below. */
    }
  }
  if (entrypoint ? real(path.dirname(real(entrypoint))) !== target : home !== colocated) continue;
  throw new Error(
    `Cannot rebuild ${target}: running Clawstrum daemon ${owner.pid} on ${owner.host} uses this build. ` +
      'npm test and npm pack also build. Use an isolated checkout/worktree, then deploy the complete artifact after saving active work and stopping the daemon.',
  );
}
