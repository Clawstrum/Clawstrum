import { readInstructionSnapshot } from '../src/instructions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexConnection, codexAppServerProvider } from '../src/codex-app-server.js';
import { codexProvider } from '../src/providers.js';
import { Engine } from '../src/engine.js';
import { ProviderFailure } from '../src/accounts.js';
import type { ProviderEvent, ProviderRequest } from '../src/types.js';
import { fixture, settle, ok } from './helpers.js';
import { researchSchema } from '../src/research/config.js';
import { delegate } from '../src/research/workers.js';
import { steerWorker, workerSteers } from '../src/research/steering.js';
import { usageReport } from '../src/usage.js';
import { CODEX_BASE_PROMPT, codexBasePrompt } from '../src/base-prompt.js';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for Codex steering');
    await delay(10);
  }
}

function server(t: any, mode = 'steer') {
  const f = fixture(t);
  const executable = path.join(f.home, 'codex-server.mjs');
  const record = path.join(f.home, 'protocol.jsonl');
  fs.writeFileSync(
    executable,
    `#!${process.execPath}
import fs from 'node:fs';
import {createInterface} from 'node:readline';
if(process.argv.includes('--version')) {console.log('codex-cli 0.154.0');process.exit(0);}
const mode=${JSON.stringify(mode)};
const log=x=>fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(x)+'\\n');
log({args:process.argv.slice(2),home:process.env.CODEX_HOME});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const notify=(method,params)=>send({method,params:{threadId:'thread-live',turnId:'turn-live',...params}});
const answer=text=>notify('item/completed',{item:{type:'agentMessage',id:'answer',text,phase:'final_answer'}});
const complete=(status='completed',error=null)=>notify('turn/completed',{turn:{id:'turn-live',status,error,items:[]}});
for await(const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);log(m);
 if(m.method==='initialize') { if(mode==='startup-abort')continue;send({id:m.id,result:{userAgent:'test'}}); }
 else if(m.method==='config/read')send({id:m.id,result:{config:{mcp_servers:{inherited:{command:'/bin/false'}},plugins:{inherited:{enabled:true}}}}});
 else if(m.method==='thread/start'||m.method==='thread/resume') {
  if(mode==='missing-thread')send({id:m.id,error:{code:-32600,message:'no rollout found for thread'}});
  else send({id:m.id,result:{thread:{id:'thread-live'}}});
 }
 else if(m.method==='hooks/list') {
  const flag=process.argv.find(a=>a.startsWith('hooks.PreToolUse='));
  const command=flag?JSON.parse(/command=("(?:[^"\\\\]|\\\\.)*")/.exec(flag)[1]):null;
  send({id:m.id,result:{data:[{cwd:m.params.cwds[0],warnings:[],errors:[],hooks:command?[{key:'k',eventName:'preToolUse',handlerType:'command',command,currentHash:'sha256:h',trustStatus:'trusted'},{key:'k2',eventName:'postToolUse',handlerType:'command',command,currentHash:'sha256:h',trustStatus:'trusted'}]:[]}]}});
 }
 else if(m.method==='thread/inject_items')send({id:m.id,result:{}});
 else if(m.method==='turn/start') {
  notify('turn/started',{turn:{id:'turn-live',status:'inProgress',items:[]}});
  send({id:m.id,result:{turn:{id:'turn-live',status:'inProgress',items:[]}}});
  notify('item/completed',{threadId:'unrelated',item:{id:'wrong',type:'agentMessage',text:'WRONG'}});
  notify('turn/completed',{turnId:'old',turn:{id:'old',status:'completed',items:[]}});
  notify('item/agentMessage/delta',{itemId:'work',delta:'Working'});
  notify('item/completed',{item:{id:'command',type:'commandExecution',command:'echo test',exitCode:0}});
  notify('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:2,outputTokens:1},total:{inputTokens:2,outputTokens:1}}});
  send({method:'account/rateLimits/updated',params:{rateLimits:{limitId:'codex',primary:{usedPercent:30,resetsAt:1900000000}}}});
  if(mode==='compact') {
    notify('item/started',{item:{id:'native-compact',type:'contextCompaction'}});
    notify('item/completed',{item:{id:'native-compact',type:'contextCompaction'}});
  }
  if(mode==='legacy-compact')notify('thread/compacted',{});
  if(mode==='no-steer') {answer('NO_STEER');complete();}
  if(mode==='quota')complete('failed',{message:'Backend limit',codexErrorInfo:'usageLimitExceeded'});
  if(mode==='auth')complete('failed',{message:'Expired login',codexErrorInfo:'unauthorized'});
  if(mode==='disconnect')process.exit(0);
  if(mode==='malformed')process.stdout.write('not-json\\n');
  if(mode==='approvals')send({id:'approve',method:'item/commandExecution/requestApproval',params:{threadId:'thread-live',turnId:'turn-live'}});
 }
 else if(m.id==='approve'&&m.result) {answer('APPROVED');complete();}
 else if(m.method==='turn/steer') {
  if(mode==='reject') {send({id:m.id,error:{code:-32600,message:'No active turn'}});answer('FIRST');complete();}
  else if(mode==='mismatch') {send({id:m.id,result:{turnId:'other'}});answer('FIRST');complete();}
  else if(mode==='steer-disconnect')process.exit(0);
  else if(mode==='late-ack') {answer('STEERED');complete();setTimeout(()=>send({id:m.id,result:{turnId:'turn-live'}}),80);}
  else if(mode==='abort') { /* Wait for interruption. */ }
  else {send({id:m.id,result:{turnId:'turn-live'}});answer('STEERED');complete();}
 }
 else if(m.method==='turn/interrupt') {send({id:m.id,result:{}});complete('interrupted');}
}
`,
    { mode: 0o700 },
  );
  const events: ProviderEvent[] = [];
  const request: ProviderRequest = {
    liveInput: true,
    account: { ...f.config.accounts[1]!, executable },
    cwd: f.session.workspace,
    prompt: 'Original request',
    instructions: 'Clawstrum instructions',
    env: { PATH: process.env.PATH!, CODEX_HOME: f.config.accounts[1]!.home },
    controller: new AbortController(),
    mcp: {
      command: process.execPath,
      args: ['test-mcp.js'],
      env: { CLAWSTRUM_SESSION: f.session.id },
    },
    onEvent: (event) => events.push(event),
  };
  return {
    ...f,
    request,
    events,
    record,
    protocol: () =>
      fs
        .readFileSync(record, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  };
}

for (const mode of ['steer', 'late-ack'])
  test(
    `Codex ${mode} uses the guarded active turn and acknowledges before returning`,
    { timeout: 20000 },
    async (t) => {
      const f = server(t, mode);
      let inject!: (ids: string[], text: string) => boolean;
      f.request.attachInjector = (fn) => {
        inject = fn;
      };
      const work = codexProvider.run(f.request);
      await until(() => !!inject);
      assert.equal(inject(['new'], 'Follow-up'), true);
      assert.equal(await work, 'STEERED');
      assert.deepEqual(
        f.events.filter((e) => e.type === 'injected').map((e) => e.detail),
        [{ ids: ['new'], ok: true }],
      );
      assert.equal(inject(['late'], 'Late'), false);
      const messages = f.protocol();
      const call = messages.find((m) => m.method === 'turn/steer');
      assert.deepEqual(call.params, {
        threadId: 'thread-live',
        expectedTurnId: 'turn-live',
        input: [{ type: 'text', text: 'Follow-up' }],
      });
      assert.equal(messages.filter((m) => m.method === 'turn/start').length, 1);
      assert.equal(messages[0].home, f.request.account.home);
      assert.ok(messages[0].args.includes('forced_login_method="chatgpt"'));
      assert.equal(
        messages.find((m) => m.method === 'thread/start').params.sandbox,
        'danger-full-access',
      );
      assert.equal(
        messages.find((m) => m.method === 'thread/start').params.approvalPolicy,
        'never',
      );
      assert.deepEqual(
        messages.find((m) => m.method === 'thread/start').params.config.mcp_servers.clawstrum,
        f.request.mcp,
      );
      assert.ok(f.events.some((e) => e.type === 'activity'));
      assert.ok(f.events.some((e) => e.type === 'usage'));
      assert.ok(
        f.events.some(
          (e) =>
            e.type === 'quota' &&
            e.quota?.utilization === 0.3 &&
            e.quota.resetsAt === 1900000000000,
        ),
      );
    },
  );

for (const mode of ['reject', 'mismatch'])
  test(`Codex ${mode} steering leaves the new input unacknowledged`, async (t) => {
    const f = server(t, mode);
    let inject!: (ids: string[], text: string) => boolean;
    f.request.attachInjector = (fn) => {
      inject = fn;
    };
    const work = codexAppServerProvider.run(f.request);
    await until(() => !!inject);
    inject(['new'], 'Follow-up');
    assert.equal(await work, 'FIRST');
    assert.deepEqual(
      f.events.filter((e) => e.type === 'injected').map((e) => e.detail),
      [{ ids: ['new'], ok: false, ...(mode === 'mismatch' ? { uncertain: true } : {}) }],
    );
  });

for (const [mode, kind] of [
  ['quota', 'quota'],
  ['auth', 'auth'],
  ['disconnect', 'transient'],
  ['malformed', 'transient'],
])
  test(`Codex ${mode} follows the existing failure contract`, async (t) => {
    const f = server(t, mode);
    await assert.rejects(
      codexAppServerProvider.run(f.request),
      (e: unknown) => e instanceof ProviderFailure && e.kind === kind,
    );
  });

test('Codex resumes native history with the configured model and effort', async (t) => {
  const f = server(t, 'no-steer');
  f.request.sessionId = 'saved-thread';
  f.request.account.model = 'selected-model';
  f.request.account.effort = 'high';
  assert.equal(await codexAppServerProvider.run(f.request), 'NO_STEER');
  const resume = f.protocol().find((m) => m.method === 'thread/resume');
  assert.equal(resume.params.threadId, 'saved-thread');
  assert.equal(resume.params.model, 'selected-model');
  assert.equal(resume.params.developerInstructions, f.request.instructions);
  assert.equal(resume.params.baseInstructions, CODEX_BASE_PROMPT);
  assert.equal(f.protocol().find((m) => m.method === 'turn/start').params.effort, 'high');
});

for (const resumed of [false, true])
  test(`Codex ${resumed ? 'thread/resume' : 'thread/start'} carries the base prompt only for lead runs`, async (t) => {
    for (const flags of [{}, { subagent: true }, { toolless: true }]) {
      const f = server(t, 'no-steer');
      Object.assign(f.request, flags);
      if (resumed) f.request.sessionId = 'saved-thread';
      assert.equal(await codexAppServerProvider.run(f.request), 'NO_STEER');
      const params = f
        .protocol()
        .find((m) => m.method === (resumed ? 'thread/resume' : 'thread/start')).params;
      assert.equal(params.developerInstructions, f.request.instructions);
      if (Object.keys(flags).length) assert.equal('baseInstructions' in params, false);
      else assert.equal(params.baseInstructions, CODEX_BASE_PROMPT);
    }
  });

test('Codex main-channel lead runs get the main base prompt; subagent and toolless get none', async (t) => {
  for (const flags of [{}, { subagent: true }, { toolless: true }]) {
    const f = server(t, 'no-steer');
    Object.assign(f.request, flags, { mainChannel: true });
    assert.equal(await codexAppServerProvider.run(f.request), 'NO_STEER');
    const params = f.protocol().find((m) => m.method === 'thread/start').params;
    if (Object.keys(flags).length) assert.equal('baseInstructions' in params, false);
    else {
      assert.equal(params.baseInstructions, codexBasePrompt({ mainChannel: true }));
      assert.notEqual(params.baseInstructions, CODEX_BASE_PROMPT);
    }
  }
});

test('Codex lead turns get owner MCP servers with Clawstrum last', async (t) => {
  const f = server(t, 'no-steer');
  const docs = { command: '/usr/bin/docs-mcp', args: ['--stdio'], env: { TOKEN_FILE: 'x' } };
  f.request.extraMcp = { docs, clawstrum: { command: '/bin/false', args: [], env: {} } };
  assert.equal(await codexAppServerProvider.run(f.request), 'NO_STEER');
  const servers = f.protocol().find((m) => m.method === 'thread/start').params.config.mcp_servers;
  assert.deepEqual(Object.keys(servers), ['docs', 'clawstrum']);
  assert.deepEqual(servers.docs, docs);
  assert.deepEqual(servers.clawstrum, f.request.mcp);
});

test('missing Codex rollout requests a fresh portable session', async (t) => {
  const f = server(t, 'missing-thread');
  f.request.sessionId = 'missing';
  await assert.rejects(
    codexAppServerProvider.run(f.request),
    (e: unknown) => e instanceof ProviderFailure && e.kind === 'session',
  );
});

for (const mode of ['abort', 'startup-abort'])
  test(`Codex ${mode} cancels promptly and does not claim in-flight steering`, async (t) => {
    const f = server(t, mode);
    let inject: ((ids: string[], text: string) => boolean) | undefined;
    f.request.attachInjector = (fn) => {
      inject = fn;
    };
    const work = assert.rejects(codexAppServerProvider.run(f.request), /cancel test/);
    await until(() => (mode === 'abort' ? !!inject : fs.existsSync(f.record)));
    if (inject) inject(['new'], 'Follow-up');
    if (mode === 'abort') await until(() => f.protocol().some((m) => m.method === 'turn/steer'));
    const start = Date.now();
    f.request.controller.abort(new Error('cancel test'));
    await work;
    assert.ok(Date.now() - start < 3000);
    assert.ok(!f.events.some((e) => e.type === 'injected' && (e.detail as any).ok));
    if (mode === 'abort') assert.ok(f.protocol().some((m) => m.method === 'turn/interrupt'));
  });

test('Codex unexpected execution approval uses the authorized full-access policy', async (t) => {
  const f = server(t, 'approvals');
  assert.equal(await codexAppServerProvider.run(f.request), 'APPROVED');
  assert.deepEqual(f.protocol().find((m) => m.id === 'approve').result, { decision: 'accept' });
});

test(
  'compiled Codex accepts a follow-up after a delivered final without waiting for turn completion',
  { timeout: 25000 },
  async (t) => {
    const f = server(t);
    f.config.accounts = [f.request.account];
    const { Engine: CompiledEngine } = await import('../dist/engine.js' as string);
    const engine: Engine = new CompiledEngine(f.config, f.store);
    try {
      f.enqueue('first');
      engine.tick();
      await until(
        () =>
          engine.active.get(f.session.id)?.ready === true &&
          !!engine.active.get(f.session.id)?.inject,
      );
      const run = f.store.get<any>('SELECT * FROM runs');
      f.store.outbox(f.session.id, 'Earlier answer', { runId: run.id, final: true });
      f.enqueue('progress?');
      engine.tick();
      await until(() => engine.active.size === 0);
      assert.equal(
        f.store.get<any>("SELECT status FROM inbound WHERE id='progress?'").status,
        'done',
      );
      assert.equal(f.protocol().filter((m) => m.method === 'turn/steer').length, 1);
      assert.deepEqual(
        f.store.all<any>('SELECT content FROM outbox ORDER BY rowid').map((m) => m.content),
        ['Earlier answer', 'STEERED'],
      );
    } finally {
      await engine.stop();
    }
  },
);

for (const mode of ['late-ack', 'reject', 'steer-disconnect'])
  test(
    `compiled Codex worker handles ${mode} without losing queued input`,
    { timeout: 25000 },
    async (t) => {
      const f = server(t, mode);
      f.config.accounts = [f.request.account];
      const { Engine: CompiledEngine } = await import('../dist/engine.js' as string);
      const engine: Engine = new CompiledEngine(f.config, f.store);
      try {
        f.enqueue('first');
        engine.tick();
        await until(
          () =>
            engine.active.get(f.session.id)?.ready === true &&
            !!engine.active.get(f.session.id)?.inject &&
            fs.existsSync(f.record) &&
            f.protocol().some((m) => m.method === 'turn/start'),
        );
        f.enqueue('follow-up');
        engine.tick();
        await until(() => engine.active.size === 0);
        assert.equal(f.store.all('SELECT * FROM runs').length, 1);
        assert.deepEqual(
          f.store.all<{ status: string }>('SELECT status FROM inbound').map((m) => m.status),
          mode === 'late-ack'
            ? ['done', 'done']
            : mode === 'reject'
              ? ['done', 'queued']
              : ['queued', 'queued'],
        );
        if (mode !== 'steer-disconnect')
          assert.equal(
            f.store.get<any>('SELECT content FROM outbox').content,
            mode === 'late-ack' ? 'STEERED' : 'FIRST',
          );
        assert.equal(
          f.store.all("SELECT * FROM events WHERE type='steered'").length,
          mode === 'late-ack' ? 1 : 0,
        );
      } finally {
        await engine.stop();
      }
    },
  );

for (const mode of ['late-ack', 'reject', 'steer-disconnect'])
  test(
    `compiled research worker preserves ${mode} steering and usage across supervisor IPC`,
    { timeout: 25000 },
    async (t) => {
      const f = server(t, mode);
      f.config.accounts = [f.request.account];
      f.config.research = researchSchema.parse({
        enabled: true,
        validation: 'off',
        workers: { minFreeMemoryMB: 0 },
      });
      const { Engine: CompiledEngine } = await import('../dist/engine.js' as string);
      const engine: Engine = new CompiledEngine(f.config, f.store);
      try {
        const worker = delegate(f.store, f.session.id, f.config, 'compiled-worker', {
          role: 'analyst',
          brief: 'Inspect evidence and wait for additional guidance',
        });
        engine.researchWorkers.tick();
        await until(
          () =>
            engine.researchWorkers.active.get(worker.id)?.ready === true &&
            !!engine.researchWorkers.active.get(worker.id)?.inject &&
            fs.existsSync(f.record) &&
            f.protocol().some((m) => m.method === 'turn/start'),
        );
        const instruction = steerWorker(
          f.store,
          f.session.id,
          worker.id,
          'focus',
          'Focus on the control condition',
        );
        engine.researchWorkers.tick();
        await until(() => engine.researchWorkers.active.size === 0);
        const saved = f.store.get<any>('SELECT * FROM delegations WHERE id=?', worker.id);
        assert.equal(saved.status, mode === 'steer-disconnect' ? 'failed' : 'completed');
        assert.deepEqual(
          workerSteers(f.store, worker.id).map((s) => [s.id, s.status]),
          [
            [
              instruction.id,
              mode === 'late-ack' ? 'accepted' : mode === 'reject' ? 'rejected' : 'unknown',
            ],
          ],
        );
        assert.equal(
          usageReport(f.store, f.session.id, 10, 0).records[0]?.snapshot.totals.totalTokens,
          3,
        );
        const protocol = f.protocol();
        assert.equal(protocol.filter((m) => m.method === 'turn/start').length, 1);
        assert.equal(protocol.filter((m) => m.method === 'turn/steer').length, 1);
        assert.match(
          fs.readFileSync(saved.result_path, 'utf8'),
          mode === 'late-ack' ? /STEERED/ : mode === 'reject' ? /FIRST/ : /Subagent stopped/,
        );
      } finally {
        await engine.stop();
      }
    },
  );

test('acknowledged Codex steering survives quota handoff into Claude', async (t) => {
  const f = server(t, 'reject');
  let release!: () => void;
  let prompt = '';
  const engine = new Engine(f.config, f.store, {
    codex: {
      async run(r) {
        r.attachInjector!((ids) => {
          r.onEvent({ type: 'injected', detail: { ids, ok: true } });
          return true;
        });
        r.onEvent({ type: 'ready' });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new ProviderFailure('quota', 'limit');
      },
    },
    claude: {
      async run(r) {
        prompt = r.prompt;
        return 'Recovered';
      },
    },
  });
  f.store.exec('UPDATE sessions SET preferred_account=? WHERE id=?', 'b', f.session.id);
  f.enqueue('first');
  engine.tick();
  await until(() => !!release);
  f.enqueue('follow-up');
  engine.tick();
  release();
  await settle(engine);
  assert.match(prompt, /"text":"follow-up"/);
  assert.equal(f.store.get<any>("SELECT status FROM inbound WHERE id='follow-up'").status, 'done');
});

test('scheduled Codex lead runs enable live input for arriving users', async (t) => {
  const f = fixture(t);
  let enabled: boolean | undefined;
  const engine = new Engine(f.config, f.store, {
    claude: ok,
    codex: {
      async run(r) {
        enabled = r.liveInput;
        return 'Scheduled';
      },
    },
  });
  f.store.exec('UPDATE sessions SET preferred_account=? WHERE id=?', 'b', f.session.id);
  f.enqueue('scheduled');
  f.store.exec("UPDATE inbound SET kind='task'");
  engine.tick();
  await settle(engine);
  assert.equal(enabled, true);
});

test(
  'bundled Codex app-server supports initialization and guarded steering without a model call',
  { timeout: 25000 },
  async (t) => {
    const f = fixture(t);
    const home = path.join(f.home, 'protocol-home');
    fs.mkdirSync(home, { recursive: true });
    const failures: unknown[] = [];
    const connection = new CodexConnection(
      {
        account: { ...f.config.accounts[1]!, home },
        cwd: f.home,
        env: { PATH: process.env.PATH!, HOME: f.home, CODEX_HOME: home },
        onEvent() {},
      },
      () => {},
      (error) => failures.push(error),
    );
    try {
      const initialized = await connection.request('initialize', {
        clientInfo: { name: 'clawstrum_test', version: '0.1.0' },
      });
      assert.equal(typeof initialized.userAgent, 'string');
      connection.send({ method: 'initialized', params: {} });
      const started = await connection.request('thread/start', {
        cwd: f.home,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ephemeral: true,
      });
      assert.equal(typeof started.thread.id, 'string');
      await assert.rejects(
        connection.request('turn/steer', {
          threadId: started.thread.id,
          expectedTurnId: 'no-active-turn',
          input: [{ type: 'text', text: 'Must not run a model' }],
        }),
        /no active turn|not.*active|mismatch/i,
      );
      assert.equal(failures.length, 0);
    } finally {
      await connection.close();
    }
  },
);

test('Codex maintenance disables inherited tools and refuses execution escalation', async (t) => {
  const f = server(t, 'approvals');
  f.request.toolless = true;
  f.request.liveInput = false;
  f.request.extraMcp = { docs: { command: '/usr/bin/docs-mcp', args: [], env: {} } };
  assert.equal(await codexProvider.run(f.request), 'APPROVED');
  const messages = f.protocol();
  assert.deepEqual(messages.find((m) => m.id === 'approve').result, { decision: 'decline' });
  const params = messages.find((m) => m.method === 'thread/start').params;
  assert.equal(params.sandbox, 'read-only');
  assert.equal(params.config.features.shell_tool, false);
  assert.equal(params.config.features.unified_exec, false);
  assert.equal(params.config.features.codex_hooks, false);
  assert.equal(params.config.web_search, 'disabled');
  assert.deepEqual(params.config.mcp_servers, { inherited: { enabled: false } });
  assert.deepEqual(params.config.plugins, { inherited: { enabled: false } });
});

test(
  'bundled Codex resolves inherited MCP servers for explicit maintenance overrides',
  { timeout: 25000 },
  async (t) => {
    const { maintenanceCodexOverrides } = await import('../src/maintenance-config.js');
    const f = fixture(t);
    const home = path.join(f.home, 'maintenance-codex');
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      '[mcp_servers.inherited]\ncommand="/bin/false"\n',
    );
    const connection = new CodexConnection(
      {
        account: { ...f.config.accounts[1]!, home },
        cwd: f.home,
        toolless: true,
        env: { PATH: process.env.PATH!, HOME: f.home, CODEX_HOME: home },
        onEvent() {},
      },
      () => {},
      () => {},
    );
    try {
      await connection.request('initialize', {
        clientInfo: { name: 'clawstrum_test', version: '1' },
      });
      connection.send({ method: 'initialized', params: {} });
      const { config } = await connection.request('config/read', {
        cwd: f.home,
        includeLayers: false,
      });
      assert.equal(config.mcp_servers.inherited.enabled, true);
      assert.equal(config.features.shell_tool, false);
      const overrides = maintenanceCodexOverrides(config);
      assert.equal(overrides.mcp_servers.inherited.enabled, false);
      const started = await connection.request('thread/start', {
        cwd: f.home,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        config: overrides,
      });
      assert.equal(typeof started.thread.id, 'string');
      // No turn/start: validates the pinned runtime's config protocol without spending a model call.
    } finally {
      await connection.close();
    }
  },
);

test('Codex refreshes resumed and live instructions with acknowledged developer injection', async (t) => {
  const f = server(t);
  const file = path.join(f.home, 'AGENTS.md');
  fs.writeFileSync(file, 'INITIAL');
  const sources = {
    home: f.home,
    workspace: f.session.workspace,
    profile: f.request.account.home,
    maxChars: 10000,
  };
  f.request.contextRefresh = { sources, snapshot: readInstructionSnapshot(sources) };
  f.request.instructions += '\n' + f.request.contextRefresh.snapshot.instructions;
  f.request.sessionId = 'thread-live';
  let inject: any;
  f.request.attachInjector = (fn) => (inject = fn);
  const running = codexAppServerProvider.run(f.request);
  await until(() => !!inject);
  fs.writeFileSync(file, 'LIVE_REPLACEMENT');
  await until(() => f.events.filter((e) => e.type === 'context_updated').length >= 2);
  inject(['second'], 'User followup');
  assert.equal(await running, 'STEERED');
  const calls = fs
    .readFileSync(f.record, 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  const updates = calls.filter((c) => c.method === 'thread/inject_items');
  assert.equal(updates.length, 2);
  assert.match(JSON.stringify(updates[1].params.items), /LIVE_REPLACEMENT/);
  assert.equal(updates[1].params.items[0].role, 'developer');
  assert.doesNotMatch(JSON.stringify(updates[1].params.items), /INITIAL/);
  assert.ok(calls.indexOf(updates[0]) < calls.findIndex((c) => c.method === 'turn/start'));
  assert.equal(
    calls.filter((c) => c.method === 'turn/start').length,
    1,
    'Refresh does not manufacture user turns',
  );
});

for (const mode of ['compact', 'legacy-compact'])
  test(`Codex ${mode} restores unchanged instructions and memory without replacing the native thread`, async (t) => {
    const f = server(t, mode);
    fs.writeFileSync(
      path.join(f.home, 'AGENTS.md'),
      '# Agent\nCURRENT_POLICY\n\n## MEMORY\n### Current work\nJob 7712331 is running.',
    );
    const sources = {
      home: f.home,
      workspace: f.session.workspace,
      profile: f.request.account.home,
      maxChars: 10000,
    };
    f.request.contextRefresh = { sources, snapshot: readInstructionSnapshot(sources) };
    f.request.instructions += '\n' + f.request.contextRefresh.snapshot.instructions;
    f.request.sessionId = 'thread-live';
    let inject: any;
    f.request.attachInjector = (fn) => (inject = fn);
    const running = codexAppServerProvider.run(f.request);
    await until(() => !!inject && f.events.filter((e) => e.type === 'context_updated').length >= 2);
    inject(['next'], 'Continue');
    assert.equal(await running, 'STEERED');
    const updates = f.protocol().filter((c) => c.method === 'thread/inject_items');
    assert.equal(updates.length, 2);
    assert.match(JSON.stringify(updates[1].params.items), /CURRENT_POLICY/);
    assert.match(JSON.stringify(updates[1].params.items), /7712331/);
    // The reload no longer asks the lead to edit MEMORY: the idle memory pass owns that.
    assert.doesNotMatch(
      JSON.stringify(updates[1].params.items),
      /compare the compacted|memory_update/,
    );
    assert.equal(updates[1].params.items[0].role, 'developer');
    assert.equal(
      updates[1].params.items.length,
      1,
      'Memory never creates a synthetic user message',
    );
    assert.equal(f.protocol().filter((c) => c.method === 'thread/start').length, 0);
    assert.ok(
      f.events.some((e) => e.type === 'history' && (e.detail as any).kind === 'compaction'),
    );
    const phases = f.events
      .filter((e) => e.type === 'activity' && (e.detail as any)?.type === 'contextCompaction')
      .map((e) => (e.detail as any).status);
    assert.deepEqual(phases, mode === 'compact' ? ['compacting', null] : [null]);
  });

for (const resume of [false, true])
  test(`Codex ${resume ? 'resume' : 'start'} applies Clawstrum delegation controls to launch and thread overrides`, async (t) => {
    const f = server(t, 'no-steer');
    f.request.research = f.config.research;
    f.request.mcp.env.CLAWSTRUM_DELEGATION = 'worker';
    if (resume) f.request.sessionId = 'thread-live';
    assert.equal(await codexProvider.run(f.request), 'NO_STEER');
    const messages = f.protocol();
    const config = messages.find((m) => m.method === (resume ? 'thread/resume' : 'thread/start'))
      .params.config;
    assert.equal(config['agents.enabled'], false);
    assert.equal(config['features.multi_agent'], false);
    assert.equal(config.project_doc_max_bytes, 0);
    assert.ok(messages[0].args.includes('agents.enabled=false'));
    assert.ok(messages[0].args.includes('features.multi_agent=false'));
    assert.ok(messages[0].args.includes('project_doc_max_bytes=0'));
  });
