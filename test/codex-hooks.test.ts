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
const POST_KEY = '/<session-flags>/config.toml:post_tool_use:0:0';

/**
 * A fake `codex app-server`. It lists the hook passed with -c, reports it untrusted until trust is
 * written (config/batchWrite, or a [hooks.state] table in $CODEX_HOME/config.toml), and records
 * every request. Modes: `batch-fails` (config/batchWrite errors), `never-trusted` (trust has no
 * effect), `run-hook` (the turn runs the hook command on a `cat .env` call and answers with what it
 * printed), `run-calls` (the turn runs the hook command once per call listed in calls.json, as
 * Codex would before and after each tool, and answers with the list of printed outputs),
 * `no-post` (the PostToolUse flag is ignored), `thread-fails` (thread/start errors).
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
const keys={preToolUse:${JSON.stringify(KEY)},postToolUse:${JSON.stringify(POST_KEY)}};
const log=x=>fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(x)+'\\n');
const socket=process.env.CLAWSTRUM_HOOK_SOCKET??null;
log({args:process.argv.slice(2),home:process.env.CODEX_HOME,socket,socketExists:socket?fs.existsSync(socket):null});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const notify=(method,params)=>send({method,params:{threadId:'thread-live',turnId:'turn-live',...params}});
const args=process.argv;
const flag=args.find(a=>a.startsWith('hooks.PreToolUse='));
const command=flag?JSON.parse(/command=("(?:[^"\\\\]|\\\\.)*")/.exec(flag)[1]):null;
const postFlag=args.find(a=>a.startsWith('hooks.PostToolUse='));
const postCommand=postFlag&&mode!=='no-post'?JSON.parse(/command=("(?:[^"\\\\]|\\\\.)*")/.exec(postFlag)[1]):null;
const hash='sha256:'+crypto.createHash('sha256').update(command??'').digest('hex');
const trusted=new Set();
const config=()=>{try{return fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8');}catch{return '';}};
const status=key=>{
  if(mode==='never-trusted')return 'untrusted';
  if(trusted.has(key)||config().includes('[hooks.state.'+JSON.stringify(key)+']\\ntrusted_hash = '+JSON.stringify(hash)))return 'trusted';
  return 'untrusted';
};
const listed=(eventName,key,command)=>({key,eventName,handlerType:'command',command,currentHash:hash,trustStatus:status(key),matcher:null,timeoutSec:60,enabled:true,isManaged:false,source:'sessionFlags',sourcePath:'/<session-flags>/config.toml',displayOrder:0,async:false,statusMessage:null,additionalContextLimit:null,pluginId:null});
let runHookOutput='';
for await(const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);log(m);
 if(m.method==='initialize')send({id:m.id,result:{userAgent:'test'}});
 else if(m.method==='config/read')send({id:m.id,result:{config:{}}});
 else if(m.method==='hooks/list') {
  send({id:m.id,result:{data:[{cwd:m.params.cwds[0],warnings:[],errors:[],hooks:[...(command?[listed('preToolUse',keys.preToolUse,command)]:[]),...(postCommand?[listed('postToolUse',keys.postToolUse,postCommand)]:[])]}]}});
 }
 else if(m.method==='config/batchWrite') {
  if(mode==='batch-fails')send({id:m.id,error:{code:-32603,message:'config write failed'}});
  else {for(const e of m.params.edits)trusted.add(JSON.parse(e.keyPath.slice('hooks.state.'.length)));send({id:m.id,result:{status:'ok',version:'v',filePath:process.env.CODEX_HOME+'/config.toml'}});}
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
  if(mode.startsWith('run-hook')&&command) {
   const child=spawn('sh',['-c',command],{stdio:['pipe','pipe','inherit']});
   let out='';child.stdout.on('data',d=>out+=d);
   child.on('close',()=>finish(out));
   const call=mode==='run-hook-patch'?{tool_name:'apply_patch',tool_input:{command:'*** Begin Patch\\n*** Add File: /var/lib/clawstrum-test-outside/x.txt\\n+x\\n*** End Patch'}}:{tool_name:'Bash',tool_input:{command:'cat .env'}};
   child.stdin.end(JSON.stringify({hook_event_name:'PreToolUse',...call,tool_use_id:'call-1',session_id:'thread-live',cwd:process.cwd()}));
  } else if(mode==='run-calls'&&command) {
   const calls=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.home, 'calls.json'))},'utf8'));
   const outputs=[];
   for(const call of calls) {
    const {event,...rest}=call;
    const printed=await new Promise(resolve=>{
     const child=spawn('sh',['-c',command],{stdio:['pipe','pipe','inherit']});
     let out='';child.stdout.on('data',d=>out+=d);
     child.on('close',()=>resolve(out));
     child.stdin.end(JSON.stringify({hook_event_name:event,...rest,tool_use_id:'call-x',session_id:'thread-live',cwd:process.cwd()}));
    });
    outputs.push(printed===''?null:JSON.parse(printed));
   }
   finish(JSON.stringify(outputs));
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
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const flag = args.find((a) => a.startsWith(`hooks.${event}=`))!;
    assert.ok(flag.includes(codexHookCommand()));
    assert.equal(args[args.indexOf(flag) - 1], '-c');
  }
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
  // One trust entry per hook event, each from the listed key.
  assert.deepEqual(
    write.params.edits.map((e: any) => e.keyPath),
    [KEY, POST_KEY].map((key) => `hooks.state.${JSON.stringify(key)}`),
  );
  for (const edit of write.params.edits) {
    assert.match(edit.value.trusted_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(edit.mergeStrategy, 'upsert');
  }
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
    withHookTrust(withHookTrust('', KEY, `sha256:${hash}`), POST_KEY, `sha256:${hash}`),
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
    /\n\[hooks\.state\."\/<session-flags>\/config\.toml:pre_tool_use:0:0"\]\ntrusted_hash = "sha256:[0-9a-f]{64}"\n\n\[hooks\.state\."\/<session-flags>\/config\.toml:post_tool_use:0:0"\]\ntrusted_hash = "sha256:[0-9a-f]{64}"\n$/,
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

test('a Codex that does not list the PostToolUse hook fails the run before the thread starts', async (t) => {
  const s = setup(t, 'no-post');
  await assert.rejects(codexAppServerProvider.run(s.request()), /did not list .*postToolUse/);
  const messages = s.protocol();
  assert.ok(!methods(messages).includes('thread/start'));
  assert.ok(!fs.existsSync(path.dirname(messages[0].socket)));
});

test('Codex running the hook command on an apply_patch outside the permitted roots is refused in strict mode', async (t) => {
  const s = setup(t, 'run-hook-patch');
  const final = await codexAppServerProvider.run(
    s.request({ research: researchSchema.parse({ enabled: true, validation: 'strict' }) }),
  );
  const out = JSON.parse(final);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(
    out.hookSpecificOutput.permissionDecisionReason,
    /clawstrum-test-outside\/x\.txt.*outside every permitted root/,
  );
});

test('the same apply_patch goes ahead when validation is advisory, and the warning reaches Codex as additionalContext only', async (t) => {
  const s = setup(t, 'run-hook-patch');
  const out = JSON.parse(await codexAppServerProvider.run(s.request()));
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), [
    'additionalContext',
    'hookEventName',
  ]);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(
    out.hookSpecificOutput.additionalContext,
    /clawstrum-test-outside\/x\.txt.*outside every permitted root/,
  );
});

const LONG_PROSE = 'Neurons in cortex fire in sparse bursts. '.repeat(10);
const texPatch = `*** Begin Patch\n*** Add File: paper.tex\n+\\section{Introduction}\n+${LONG_PROSE}\n*** End Patch`;
const readRules = { tool_name: 'Bash', tool_input: { command: 'cat WRITING.md' } };

/** Runs the hook command once per call, as Codex does before and after each tool, and returns what it printed. */
async function runCalls(
  t: test.TestContext,
  calls: object[],
  validation: 'strict' | 'advisory',
): Promise<any[]> {
  const s = setup(t, 'run-calls');
  fs.writeFileSync(path.join(s.session.workspace, 'WRITING.md'), 'Use plain words.\n');
  fs.writeFileSync(path.join(s.session.workspace, 'notes.txt'), 'a note\n');
  fs.writeFileSync(path.join(s.home, 'calls.json'), JSON.stringify(calls));
  const final = await codexAppServerProvider.run(
    s.request({ research: researchSchema.parse({ enabled: true, validation }) }),
  );
  return JSON.parse(final);
}
const texWrite = { tool_name: 'apply_patch', tool_input: { command: texPatch } };

test('strict: a .tex write is refused until a finished shell read of the rules file, then it is allowed', async (t) => {
  const out = await runCalls(
    t,
    [
      { event: 'PreToolUse', ...texWrite },
      // A read that failed, and a read of some other file, do not count.
      { event: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat nowhere.md' } },
      {
        event: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'cat nowhere.md' },
        tool_response: 'cat: nowhere.md: No such file or directory\n',
      },
      {
        event: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'cat notes.txt' },
        tool_response: 'a note\n',
      },
      { event: 'PreToolUse', ...texWrite },
      // A rules read that has only started (PreToolUse) does not count either.
      { event: 'PreToolUse', ...readRules },
      { event: 'PreToolUse', ...texWrite },
      { event: 'PostToolUse', ...readRules, tool_response: 'Use plain words.\n' },
      { event: 'PreToolUse', ...texWrite },
      {
        event: 'PostToolUse',
        ...texWrite,
        tool_response:
          'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nA paper.tex\n',
      },
    ],
    'strict',
  );
  const refused = [0, 4, 6].map((i) => out[i].hookSpecificOutput);
  for (const r of refused) {
    assert.equal(r.hookEventName, 'PreToolUse');
    assert.equal(r.permissionDecision, 'deny');
    assert.match(r.permissionDecisionReason, /nothing has read them during this run/);
    assert.match(r.permissionDecisionReason, /Refusing Write on .*then re-issue the write/);
  }
  assert.deepEqual(
    out.filter((_, i) => ![0, 4, 6].includes(i)),
    [null, null, null, null, null, null, null],
  );
});

test('advisory: the same .tex write goes ahead and the writing warning is delivered as additionalContext', async (t) => {
  const out = await runCalls(
    t,
    [
      { event: 'PreToolUse', ...texWrite },
      { event: 'PostToolUse', ...readRules, tool_response: 'Use plain words.\n' },
      { event: 'PreToolUse', ...texWrite },
    ],
    'advisory',
  );
  assert.deepEqual(Object.keys(out[0]), ['hookSpecificOutput']);
  assert.equal(out[0].hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out[0].hookSpecificOutput.permissionDecision, undefined);
  assert.match(
    out[0].hookSpecificOutput.additionalContext,
    /nothing has read them during this run/,
  );
  // The write went through, so the note must not read as a refusal or ask for the write again.
  assert.match(out[0].hookSpecificOutput.additionalContext, /goes ahead, no need to repeat it/);
  assert.doesNotMatch(out[0].hookSpecificOutput.additionalContext, /Refusing|re-issue/);
  // Once the rules were read there is nothing to warn about.
  assert.equal(out[1], null);
  assert.equal(out[2], null);
});
