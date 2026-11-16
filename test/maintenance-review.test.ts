import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, settle } from './helpers.js';
import { ensureMemory, observeMemory } from '../src/memory.js';
import { archiveRecord } from '../src/history.js';
import { consolidateMemory, consolidationCoverage } from '../src/consolidation.js';
import { Engine } from '../src/engine.js';

test(
  'compiled idle consolidation crosses provider IPC, accounts usage, and commits before native rotation',
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t);
    ensureMemory(f.store, null);
    f.config.runtime.maxConcurrent = 1;
    f.config.accounts[0]!.maxConcurrent = 1;
    // Immediate re-ticks must still see the scan each time, not wait for scanIntervalMs.
    f.config.runtime.maintenance.scanIntervalMs = 0;
    f.config.runtime.consolidation.thresholdBytes = 1;
    f.config.runtime.consolidation.models.claude = 'haiku';
    fs.mkdirSync(f.config.accounts[0]!.home, { recursive: true });
    const executable = path.join(f.home, 'maintenance-cli.mjs');
    fs.writeFileSync(
      executable,
      `#!${process.execPath}
import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('2.1.270');process.exit(0);}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],models:[],account:null}}});
 if(m.type==='user'){
  send({type:'system',subtype:'init',session_id:'native',tools:[],mcp_servers:[],model:'test',permissionMode:'bypassPermissions',apiKeySource:'none',cwd:process.cwd(),uuid:'init'});
  let result='Lead finished';
  if(process.argv.includes('haiku')){
   const p=JSON.parse(m.message.content);
   result=JSON.stringify({chunk:p.chunk,sections:{'Working understanding':'Verified result; source history:'+p.sourceParts[0].id,'Current work':'Retain job 5512331','Research state':''},sources:p.sourceParts.map(p=>p.id)});
  }
  send({type:'result',subtype:'success',result,is_error:false,session_id:'native',uuid:'result',duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{},modelUsage:{fake:{inputTokens:10,outputTokens:1}},permission_denials:[]});
 }
}`,
      { mode: 0o700 },
    );
    f.config.accounts[0]!.executable = executable;
    const { Engine: CompiledEngine } = await import('../dist/engine.js' as string);
    const engine: Engine = new CompiledEngine(f.config, f.store);
    try {
      f.enqueue('Please retain job 5512331');
      engine.tick();
      await settle(engine);
      assert.equal(f.store.session(f.session.id).remote_id, 'native');
      engine.tick();
      await Promise.all([...engine.consolidations]);
      assert.equal(f.store.session(f.session.id).remote_id, null);
      assert.ok(consolidationCoverage(f.store, f.session.id) > 0);
      assert.match(observeMemory(f.store, f.session.id).memory, /5512331/);
      const usage = f.store
        .all<{ value: string }>("SELECT value FROM metadata WHERE key LIKE 'usage:%'")
        .map((row) => JSON.parse(row.value))
        .filter((row) => row.role === 'consolidator');
      assert.equal(usage.length, 1);
      assert.equal(usage[0].snapshot.totals.totalTokens, 11);
      assert.equal(engine.maintenance.size, 0);
      const completed = f.store.all<{ content: string }>(
        "SELECT content FROM events WHERE type='consolidation_completed'",
      );
      assert.equal(
        completed.length,
        1,
        'a successful pass also records a dedicated completion event',
      );
      const summary = JSON.parse(completed[0]!.content);
      assert.equal(summary.chunks, 1);
      assert.ok(summary.through > summary.from);
    } finally {
      await engine.stop();
    }
  },
);

test('an already aborted consolidation cannot invoke a provider or rotate', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  archiveRecord(f.store, {
    id: 'input',
    sessionId: f.session.id,
    kind: 'user',
    content: 'hello',
    counted: true,
  });
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    consolidateMemory({
      store: f.store,
      sessionId: f.session.id,
      config: { ...f.config.runtime.consolidation, thresholdBytes: 1 },
      signal: controller.signal,
      call: async () => {
        calls++;
        return '{}';
      },
    }),
  );
  assert.equal(calls, 0);
  assert.equal(consolidationCoverage(f.store, f.session.id), 0);
});

test('new user input aborts idle maintenance and keeps the native session available', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  f.config.runtime.consolidation.thresholdBytes = 1;
  f.config.runtime.maxConcurrent = 1;
  archiveRecord(f.store, {
    id: 'old',
    sessionId: f.session.id,
    kind: 'user',
    content: 'old result',
    counted: true,
  });
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'native', f.session.id);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const provider = {
    async run(r: any) {
      if (r.toolless) {
        started();
        return new Promise<string>((_, reject) =>
          r.controller.signal.addEventListener('abort', () => reject(r.controller.signal.reason), {
            once: true,
          }),
        );
      }
      return 'Acknowledged and completed';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  try {
    engine.tick();
    await ready;
    f.enqueue('new');
    engine.tick();
    await Promise.all([...engine.consolidations]);
    assert.equal(consolidationCoverage(f.store, f.session.id), 0);
    assert.equal(f.store.session(f.session.id).remote_id, 'native');
    engine.tick();
    await settle(engine);
    assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='new'").status, 'done');
  } finally {
    await engine.stop();
  }
});

test('cancel interrupts maintenance and remains in the archived conversation', async (t) => {
  const f = fixture(t);
  ensureMemory(f.store, null);
  f.config.runtime.consolidation.thresholdBytes = 1;
  archiveRecord(f.store, {
    id: 'old',
    sessionId: f.session.id,
    kind: 'user',
    content: 'unfinished work',
    counted: true,
  });
  f.store.exec('UPDATE sessions SET remote_id=? WHERE id=?', 'native', f.session.id);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const provider = {
    async run(r: any) {
      started();
      return new Promise<string>((_, reject) =>
        r.controller.signal.addEventListener('abort', () => reject(r.controller.signal.reason), {
          once: true,
        }),
      );
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  try {
    engine.tick();
    await ready;
    f.store.exec(
      'INSERT INTO controls(session_id,command,created_at) VALUES(?,?,?)',
      f.session.id,
      'cancel',
      Date.now(),
    );
    engine.tick();
    await Promise.all([...engine.consolidations]);
    assert.equal(consolidationCoverage(f.store, f.session.id), 0);
    assert.equal(f.store.session(f.session.id).remote_id, 'native');
    assert.equal(f.store.all('SELECT * FROM controls').length, 0);
    assert.equal(f.store.all("SELECT * FROM history_records WHERE kind='control'").length, 1);
  } finally {
    await engine.stop();
  }
});
