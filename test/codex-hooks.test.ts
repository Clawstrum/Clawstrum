import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { codexAppServerProvider } from '../src/codex-app-server.js';
import { codexHookArgs, codexHookCommand, withHookTrust } from '../src/codex-hooks.js';
import { researchSchema } from '../src/research/config.js';
import type { ProviderEvent, ProviderRequest } from '../src/types.js';
import { fixture } from './helpers.js';

const KEY = '/<session-flags>/config.toml:pre_tool_use:0:0';

/**
 * A fake `codex app-server`. It lists the hook passed with -c, reports it untrusted until trust is
 * written (config/batchWrite, or a [hooks.state] table in $CODEX_HOME/config.toml), and records
 * every request. Modes: `batch-fails` (config/batchWrite errors), `never-trusted` (trust has no
 * effect), `run-hook` (the turn runs the hook command on a `cat .env` call and answers with what it
 * printed), `thread-fails` (thread/start errors).
 */
function setup(t: test.TestContext, mode = 'plain') {
  const f = fixture(t);
  const account = { ...f.config.accounts[1]! };
  fs.mkdirSync(account.home, { recursive: true });
  const executable = path.join(f.home, 'codex-server.mjs');
  const record = path.join(f.home, 'protocol.jsonl');
  fs.writeFileSync(
    executable,
    `#!${process.execPath}
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
if(process.argv.includes('--version')) {console.log('codex-cli 0.154.0');process.exit(0);}
const mode=${JSON.stringify(mode)};
const key=${JSON.stringify(KEY)};
const log=x=>fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(x)+'\\n');
const socket=process.env.CLAWSTRUM_HOOK_SOCKET??null;
log({args:process.argv.slice(2),home:process.env.CODEX_HOME,socket,socketExists:socket?fs.existsSync(socket):null});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const notify=(method,params)=>send({method,params:{threadId:'thread-live',turnId:'turn-live',...params}});
const args=process.argv;
const flag=args.find(a=>a.startsWith('hooks.PreToolUse='));
const command=flag?JSON.parse(/command=("(?:[^"\\\\]|\\\\.)*")/.exec(flag)[1]):null;
const hash='sha256:'+crypto.createHash('sha256').update(command??'').digest('hex');
let trusted=false;
const config=()=>{try{return fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8');}catch{return '';}};
const status=()=>{
  if(mode==='never-trusted')return 'untrusted';
  if(trusted||config().includes('[hooks.state.'+JSON.stringify(key)+']\\ntrusted_hash = '+JSON.stringify(hash)))return 'trusted';
  return 'untrusted';
};
let runHookOutput='';
for await(const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);log(m);
 if(m.method==='initialize')send({id:m.id,result:{userAgent:'test'}});
 else if(m.method==='config/read')send({id:m.id,result:{config:{}}});
 else if(m.method==='hooks/list') {
  send({id:m.id,result:{data:[{cwd:m.params.cwds[0],warnings:[],errors:[],hooks:command?[{key,eventName:'preToolUse',handlerType:'command',command,currentHash:hash,trustStatus:status(),matcher:null,timeoutSec:60,enabled:true,isManaged:false,source:'sessionFlags',sourcePath:'/<session-flags>/config.toml',displayOrder:0,async:false,statusMessage:null,additionalContextLimit:null,pluginId:null}]:[]}]}});
 }
 else if(m.method==='config/batchWrite') {
  if(mode==='batch-fails')send({id:m.id,error:{code:-32603,message:'config write failed'}});
  else {trusted=true;send({id:m.id,result:{status:'ok',version:'v',filePath:process.env.CODEX_HOME+'/config.toml'}});}
 }
 else if(m.method==='thread/start') {
  if(mode==='thread-fails')send({id:m.id,error:{code:-32603,message:'thread failed'}});
  else send({id:m.id,result:{thread:{id:'thread-live'}}});
 }
 else if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'turn-live',status:'inProgress',items:[]}}});
  notify('turn/started',{turn:{id:'turn-live',status:'inProgress',items:[]}});
  const finish=text=>{
   notify('item/completed',{item:{type:'agentMessage',id:'answer',text,phase:'final_answer'}});
   notify('turn/completed',{turn:{id:'turn-live',status:'completed',error:null,items:[]}});
  };
  if(mode==='run-hook'&&command) {
   const child=spawn('sh',['-c',command],{stdio:['pipe','pipe','inherit']});
   let out='';child.stdout.on('data',d=>out+=d);
   child.on('close',()=>finish(out));
   child.stdin.end(JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'cat .env'},tool_use_id:'call-1',session_id:'thread-live',cwd:process.cwd()}));
  } else finish('DONE');
 }
}
`,
    { mode: 0o700 },
  );
  const events: ProviderEvent[] = [];
  const request = (extra: Partial<ProviderRequest> = {}): ProviderRequest => ({
    account: { ...account, executable },
    cwd: f.session.workspace,
    prompt: 'Original request',
    instructions: 'Clawstrum instructions',
    env: { PATH: process.env.PATH!, CODEX_HOME: account.home },
    controller: new AbortController(),
    research: researchSchema.parse({ enabled: true }),
    mcp: {
      command: process.execPath,
      args: ['test-mcp.js'],
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id },
    },
    onEvent: (event) => events.push(event),
    ...extra,
  });
  const protocol = () =>
    fs
      .readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return { ...f, account, request, events, protocol };
}

const methods = (messages: any[]) => messages.filter((m) => m.method).map((m) => m.method);

test('hook command and flags quote a path with a space and an apostrophe', () => {
  const command = codexHookCommand("/opt/it's here");
  assert.equal(
    command,
    `'${process.execPath}' '/opt/it'\\''s here/dist/hook-client.js' --format codex`,
  );
  assert.deepEqual(codexHookArgs(command).slice(0, 3), ['--enable', 'hooks', '-c']);
  const value = codexHookArgs(command)[3]!;
  assert.match(
    value,
    /^hooks\.PreToolUse=\[\{hooks=\[\{type="command",command=".*",timeout=60\}\]\}\]$/,
  );
  assert.equal(JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(value)![1]!), command);
});

test('withHookTrust adds one table, replaces its own hash and keeps every other line', () => {
  const header = `[hooks.state.${JSON.stringify(KEY)}]`;
  assert.equal(withHookTrust('', KEY, 'sha256:a'), `${header}\ntrusted_hash = "sha256:a"\n`);
  const own = 'model = "x"\n# note\n[projects."/p"]\ntrust_level = "trusted"\n';
  const added = withHookTrust(own, KEY, 'sha256:a');
  assert.ok(added.startsWith(own));
  assert.ok(added.endsWith(`\n${header}\ntrusted_hash = "sha256:a"\n`));
  const replaced = withHookTrust(added + '[other]\nx = 1\n', KEY, 'sha256:b');
  assert.equal(replaced, `${own}\n${header}\ntrusted_hash = "sha256:b"\n[other]\nx = 1\n`);
  assert.equal(withHookTrust(replaced, KEY, 'sha256:b'), replaced);
  const noNewline = withHookTrust('model = "x"', KEY, 'sha256:a');
  assert.equal(noNewline, `model = "x"\n\n${header}\ntrusted_hash = "sha256:a"\n`);
});

test('a run with research hooks passes the hook flags and the relay socket, and writes trust before the thread starts', async (t) => {
  const s = setup(t);
  const final = await codexAppServerProvider.run(s.request());
  assert.equal(final, 'DONE');
  const messages = s.protocol();
  const args: string[] = messages[0].args;
  assert.ok(args.includes('hooks'));
  assert.equal(args[args.indexOf('hooks') - 1], '--enable');
  const flag = args.find((a) => a.startsWith('hooks.PreToolUse='))!;
  assert.ok(flag.includes(codexHookCommand()));
  assert.equal(args[args.indexOf(flag) - 1], '-c');
  // The relay socket sits in a private temp folder and is open while Codex runs.
  assert.match(messages[0].socket, /clawstrum-codex-[^/]+\/hook\.sock$/);
  assert.equal(messages[0].socketExists, true);
  // Trust: listed, written with config/batchWrite from the listed key and hash, then thread/start.
  const order = methods(messages);
  assert.ok(order.indexOf('hooks/list') < order.indexOf('config/batchWrite'));
  assert.ok(order.indexOf('config/batchWrite') < order.indexOf('thread/start'));
  const list = messages.find((m) => m.method === 'hooks/list');
  assert.deepEqual(list.params, { cwds: [s.session.workspace] });
  const write = messages.find((m) => m.method === 'config/batchWrite');
  assert.equal(write.params.edits.length, 1);
  assert.equal(write.params.edits[0].keyPath, `hooks.state.${JSON.stringify(KEY)}`);
  assert.match(write.params.edits[0].value.trusted_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(write.params.edits[0].mergeStrategy, 'upsert');
  // The relay closed with the run: no socket file, no private folder.
  assert.ok(!fs.existsSync(messages[0].socket));
  assert.ok(!fs.existsSync(path.dirname(messages[0].socket)));
});

test('an already trusted hook is not written again', async (t) => {
  const s = setup(t);
  await codexAppServerProvider.run(s.request());
  assert.equal(methods(s.protocol()).filter((m) => m === 'config/batchWrite').length, 1);
  // Second run on the same account: Codex's config now holds the trust, so there is no new write.
  const first = s.protocol()[0].args.find((a: string) => a.startsWith('hooks.PreToolUse='));
  const hash = (await import('node:crypto'))
    .createHash('sha256')
    .update(codexHookCommand())
    .digest('hex');
  fs.writeFileSync(
    path.join(s.account.home, 'config.toml'),
    withHookTrust('', KEY, `sha256:${hash}`),
  );
  fs.rmSync(path.join(s.home, 'protocol.jsonl'));
  await codexAppServerProvider.run(s.request());
  assert.ok(first);
  assert.equal(methods(s.protocol()).filter((m) => m === 'config/batchWrite').length, 0);
  assert.ok(methods(s.protocol()).includes('thread/start'));
});

test('when config/batchWrite fails the trust goes into config.toml and nothing else in it changes', async (t) => {
  const s = setup(t, 'batch-fails');
  const file = path.join(s.account.home, 'config.toml');
  const own = 'model = "x"\n# a note\n[projects."/p"]\ntrust_level = "trusted"\n';
  fs.writeFileSync(file, own, { mode: 0o600 });
  assert.equal(await codexAppServerProvider.run(s.request()), 'DONE');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith(own));
  assert.match(
    text,
    /\n\[hooks\.state\."\/<session-flags>\/config\.toml:pre_tool_use:0:0"\]\ntrusted_hash = "sha256:[0-9a-f]{64}"\n$/,
  );
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(
    s.events.some(
      (e) => e.type === 'diagnostic' && e.detail?.event === 'codex_hook_trust_fallback',
    ),
  );
  assert.ok(
    methods(s.protocol()).indexOf('thread/start') > methods(s.protocol()).indexOf('hooks/list'),
  );
});

test('a hook that stays untrusted fails the run before the thread starts and still closes the relay', async (t) => {
  const s = setup(t, 'never-trusted');
  await assert.rejects(codexAppServerProvider.run(s.request()), /still reports .* untrusted/);
  const messages = s.protocol();
  assert.ok(!methods(messages).includes('thread/start'));
  assert.ok(!fs.existsSync(path.dirname(messages[0].socket)));
});

test('the relay is closed when the thread fails to start', async (t) => {
  const s = setup(t, 'thread-fails');
  await assert.rejects(codexAppServerProvider.run(s.request()), /thread failed/);
  const messages = s.protocol();
  assert.equal(messages[0].socketExists, true);
  assert.ok(!fs.existsSync(path.dirname(messages[0].socket)));
});

for (const [name, extra] of [
  ['a text-only run', { toolless: true }],
  ['a run with research off', { research: researchSchema.parse({ enabled: false }) }],
  ['a run without a Clawstrum session', { mcp: { command: 'node', args: ['mcp.js'], env: {} } }],
] as const)
  test(`${name} gets no hook flag, no relay and no trust request`, async (t) => {
    const s = setup(t);
    assert.equal(
      await codexAppServerProvider.run(s.request(extra as Partial<ProviderRequest>)),
      'DONE',
    );
    const messages = s.protocol();
    const args: string[] = messages[0].args;
    assert.ok(!args.includes('hooks'));
    assert.ok(!args.some((a) => a.startsWith('hooks.')));
    assert.equal(messages[0].socket, null);
    assert.ok(!methods(messages).includes('hooks/list'));
    assert.ok(!methods(messages).includes('config/batchWrite'));
    assert.ok(!fs.existsSync(path.join(s.account.home, 'config.toml')));
  });

test('Codex running the hook command reaches the research checks, which refuse cat .env', async (t) => {
  const s = setup(t, 'run-hook');
  const final = await codexAppServerProvider.run(s.request());
  const out = JSON.parse(final);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.length > 0);
});
