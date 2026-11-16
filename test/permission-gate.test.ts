import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { createClaudeProvider } from '../src/providers.js';
import { permissionGate } from '../src/permission-gate.js';
import type { ProviderEvent } from '../src/types.js';

for (const tool of ['Bash', 'Read'])
  test(`full-access approval answers a headless ${tool} escalation without rewriting input`, async () => {
    const events: ProviderEvent[] = [];
    const input = { command: 'printf sensitive-example', file_path: '/outside/workspace/example' };
    const result = await permissionGate((e) => events.push(e))(tool, input, {
      signal: new AbortController().signal,
      decisionReason: 'sensitive-example',
      blockedPath: '/private/example',
    } as any);
    assert.deepEqual(result, { behavior: 'allow', updatedInput: input });
    assert.deepEqual(events, [
      { type: 'diagnostic', detail: { event: 'permission_gate_allowed', tool } },
    ]);
  });

for (const source of ['tool', 'turn'])
  test(`approval respects ${source} cancellation`, async () => {
    const cancelled = AbortSignal.abort();
    const result = await permissionGate(undefined, source === 'turn' ? cancelled : undefined)(
      'Bash',
      {},
      {
        signal: source === 'tool' ? cancelled : new AbortController().signal,
      } as any,
    );
    assert.equal(result?.behavior, 'deny');
    assert.equal(result?.behavior === 'deny' && result.interrupt, true);
  });

test('diagnostic failures do not turn an approval into a tool failure', async () => {
  const result = await permissionGate(() => {
    throw new Error('disk full');
  })('Bash', {}, { signal: new AbortController().signal } as any);
  assert.equal(result?.behavior, 'allow');
});

test(
  'installed Claude SDK carries the full-access approval through its real control protocol',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    const executable = path.join(f.home, 'permission-cli.mjs');
    const record = path.join(f.home, 'decision.json');
    fs.writeFileSync(
      executable,
      `import fs from 'node:fs';import {createInterface} from 'node:readline';
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],models:[],account:null}}});
 if(m.type==='user')send({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool',tool_name:'Bash',tool_use_id:'tool',input:{command:'printf example'},decision_reason:'test escalation'}});
 if(m.type==='control_response'&&m.response.request_id==='permission'){
  fs.writeFileSync(process.env.RECORD,JSON.stringify(m.response));
  send({type:'result',subtype:'success',result:'APPROVAL_OK',is_error:false,session_id:'native',uuid:'result',duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{},modelUsage:{},permission_denials:[]});
 }
}`,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('approval protocol timeout')), 10000);
    try {
      assert.equal(
        await createClaudeProvider().run({
          account: { ...f.config.accounts[0]!, executable },
          cwd: f.home,
          prompt: 'test',
          instructions: '',
          controller,
          env: {
            PATH: process.env.PATH!,
            RECORD: record,
            CLAUDE_CONFIG_DIR: f.config.accounts[0]!.home,
          },
          mcp: { command: process.execPath, args: [], env: {} },
          onEvent() {},
        }),
        'APPROVAL_OK',
      );
      const response = JSON.parse(fs.readFileSync(record, 'utf8'));
      assert.equal(response.subtype, 'success');
      assert.equal(response.response.behavior, 'allow');
      assert.deepEqual(response.response.updatedInput, { command: 'printf example' });
    } finally {
      clearTimeout(timer);
    }
  },
);
