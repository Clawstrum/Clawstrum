import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from './helpers.js';
import { ensureMemory, memoryFile, parseMemory, COMPACTION_SECTION } from '../src/memory.js';
import { compactionHooks, consolidationRequestKey } from '../src/compaction.js';
import type { ProviderRequest } from '../src/types.js';

// ---- Fix 2: a subagent's compaction cannot overwrite the lead's summary ----------------------

function request(f: ReturnType<typeof fixture>, delegation?: string): ProviderRequest {
  return {
    account: f.config.accounts[0]!,
    cwd: f.session.workspace,
    prompt: '',
    instructions: '',
    controller: new AbortController(),
    env: {},
    research: f.config.research,
    mcp: {
      command: 'node',
      args: [],
      env: {
        CLAWSTRUM_HOME: f.home,
        CLAWSTRUM_SESSION: f.session.id,
        ...(delegation ? { CLAWSTRUM_DELEGATION: delegation } : {}),
      },
    },
    onEvent() {},
  };
}
const post = (summary: string) => ({
  hook_event_name: 'PostCompact',
  session_id: 'sdk',
  transcript_path: '',
  cwd: '/',
  trigger: 'auto',
  compact_summary: summary,
});
const fire = async (hooks: any, input: any) =>
  hooks.hooks.PostCompact[0].hooks[0](input, undefined, { signal: new AbortController().signal });

test('a Clawstrum subagent compaction is archived but leaves the lead section and request alone', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, f.session.id);
  const section = () => {
    const doc = parseMemory(fs.readFileSync(memoryFile(f.store, f.session.id), 'utf8'));
    const s = doc.sections.find((x) => x.name === COMPACTION_SECTION);
    return s ? doc.text.slice(s.body, s.end) : undefined;
  };
  const key = consolidationRequestKey(f.session.id);
  const lead = compactionHooks(request(f));
  const worker = compactionHooks(request(f, 'worker-1'));
  try {
    await fire(lead, post('Lead summary: batch is 16.'));
    const written = section();
    assert.match(written!, /batch is 16/);
    f.store.exec('DELETE FROM metadata WHERE key=?', key);
    const revision = fs.readFileSync(memoryFile(f.store, f.session.id), 'utf8');

    await fire(worker, post('Worker summary: reading file X.'));

    assert.equal(section(), written, 'the lead section is unchanged');
    assert.equal(fs.readFileSync(memoryFile(f.store, f.session.id), 'utf8'), revision);
    assert.equal(f.store.get('SELECT key FROM metadata WHERE key=?', key), undefined, 'no request');
    const rows = f.store.all<{ content: string }>(
      "SELECT content FROM history_records WHERE kind='compaction_summary' ORDER BY seq",
    );
    assert.equal(rows.length, 2);
    assert.match(rows[1]!.content, /Agent: subagent worker-1\./);
    assert.match(rows[1]!.content, /Worker summary/);
  } finally {
    lead.close();
    worker.close();
  }
});
