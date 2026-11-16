// Records the commit this dist/ was built from, for the dashboard's Overview post. Best effort:
// a tarball or shallow checkout without git history still produces a usable dist/.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
fs.writeFileSync(
  'dist/BUILD.json',
  JSON.stringify(
    {
      commit: commit.status === 0 ? commit.stdout.trim() : undefined,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);
