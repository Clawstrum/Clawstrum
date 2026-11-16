// Synthetic tests must not consume an operator's auxiliary API key from shell initialization.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
// On a shared login node the full suite can starve the running daemon. Set this variable there
// (subagent shells inherit it); a Slurm job sets SLURM_JOB_ID and is unaffected.
if (process.env.CLAWSTRUM_TEST_REQUIRE_SLURM === '1' && !process.env.SLURM_JOB_ID) {
  console.error(
    'Full test suite refused on this host (CLAWSTRUM_TEST_REQUIRE_SLURM=1): run it in a Slurm job. Single files: node --test <file>.',
  );
  process.exit(2);
}
const env = { ...process.env };
delete env.JEV_API_KEY;
delete env.TYPESAFE_API_KEY;
delete env.OPENROUTER_API_KEY;
const files = fs
  .readdirSync('test')
  .filter((name) => name.endsWith('.test.ts'))
  .sort();
const child = spawnSync(
  process.execPath,
  [
    '--import',
    import.meta.resolve('tsx'),
    '--test',
    ...process.argv.slice(2),
    ...files.map((name) => 'test/' + name),
  ],
  { env, stdio: 'inherit' },
);
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
