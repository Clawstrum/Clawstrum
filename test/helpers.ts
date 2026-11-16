import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { configSchema } from '../src/config.js';
import type { Engine } from '../src/engine.js';
import type { Provider } from '../src/types.js';

export const ok: Provider = {
  async run() {
    return 'Finished';
  },
};
export function fixture(t: any) {
  // macOS exposes its temp directory through /var -> /private/var. Providers
  // canonicalize workspaces, so fixture paths and transcript slugs must agree.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-review-')));
  const store = new Store(home);
  const config = configSchema.parse({
    version: 1,
    discord: { ownerIds: ['123456'], channelIds: ['987654'], guildId: '555555', allowDMs: false },
    accounts: [
      { id: 'a', provider: 'claude', home: path.join(home, 'a') },
      { id: 'b', provider: 'codex', home: path.join(home, 'b') },
    ],
    // The daily consolidation pass depends on the clock, so tests start with it off and the
    // daily tests turn it on with a fixed hour.
    runtime: {
      debounceMs: 0,
      debounceMaxMs: 0,
      inputReleaseGraceMs: 0,
      consolidation: { daily: { enabled: false } },
    },
    // Tests must not depend on the test machine's free memory; the memory gate tests set it.
    // context is required by default, and the appended conversation-context section would make
    // BRIEF.md depend on whatever inbound/outbox rows a fixture happens to hold; most tests care
    // about neither, so both are off here and turned on explicitly by the tests that cover them.
    research: {
      workers: { minFreeMemoryMB: 0, requireContext: false, briefContext: { enabled: false } },
    },
  });
  const session = store.ensureSession('987654');
  const enqueue = (id: string, at = Date.now()) =>
    store.enqueue({ id, sessionId: session.id, author: 'owner', content: id, at });
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, store, config, session, enqueue };
}
export async function settle(engine: Engine) {
  await Promise.all([...engine.active.values()].map((s) => s.promise));
}
