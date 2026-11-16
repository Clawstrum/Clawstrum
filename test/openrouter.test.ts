import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from './helpers.js';
import { decisionsSchema } from '../src/decisions/config.js';
import {
  DecisionService,
  decisionEnvironment,
  decisionsAvailable,
  type DecisionInput,
} from '../src/decisions/client.js';
import { OPENROUTER_URL } from '../src/decisions/openrouter.js';
import { decisionProfile } from '../src/decisions/profile.js';

const env = { OPENROUTER_API_KEY: 'private-router-key' };
const config = (overrides: any = {}) =>
  decisionsSchema.parse({ provider: 'openrouter', ...overrides });
const input: DecisionInput = {
  feature: 'test',
  version: '1',
  scope: 'channel:one',
  state: { text: 'input' },
  questions: {
    pick: {
      type: 'choice',
      instructions: 'Which?',
      criteria: { yes: 'Yes', no: 'No', maybe: 'Maybe' },
    },
    rate: { type: 'score', instructions: 'Rate', criteria: ['low', 'mid', 'high'] },
    holds: { type: 'noul', instructions: 'True?' },
  },
};
function reply(content: unknown, extra: any = {}) {
  return new Response(
    JSON.stringify({
      id: 'gen-1',
      model: 'openai/gpt-4.1-nano',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: typeof content === 'string' ? content : JSON.stringify(content),
          },
        },
      ],
      usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 },
      ...extra,
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}
const good = {
  pick: { choice: 'no', confidence: 0.8 },
  rate: { score: 2, confidence: 0.6 },
  holds: 0.25,
};

test('OpenRouter defaults: a fixed model, its own key and a longer foreground limit', () => {
  const c = config();
  assert.equal(c.openrouter.model, 'openai/gpt-4.1-nano');
  assert.equal(c.openrouter.apiKeyEnv, 'OPENROUTER_API_KEY');
  assert.equal(c.openrouter.foregroundTimeoutMs, 3000);
  assert.equal(decisionsSchema.parse({}).provider, 'jev');
  for (const model of ['openrouter/auto', '~openai/gpt-latest', 'gpt-4.1-nano', 'a/b c'])
    assert.throws(() => config({ openrouter: { model } }), Error, model);
  assert.equal(
    config({ openrouter: { model: 'google/gemini-2.5-flash-lite' } }).openrouter.model,
    'google/gemini-2.5-flash-lite',
  );
});

test('only the chosen provider key counts: no switch by whichever key is set', async (t) => {
  const both = { JEV_API_KEY: 'jev-key', OPENROUTER_API_KEY: 'router-key' };
  assert.deepEqual(decisionEnvironment(config(), both), { OPENROUTER_API_KEY: 'router-key' });
  assert.deepEqual(decisionEnvironment(decisionsSchema.parse({}), both), {
    JEV_API_KEY: 'jev-key',
  });
  assert.equal(decisionsAvailable(decisionsSchema.parse({}), env), false);
  assert.equal(decisionsAvailable(config(), { JEV_API_KEY: 'jev-key' }), false);
  assert.deepEqual(
    decisionEnvironment(config({ openrouter: { apiKeyEnv: 'MY_ROUTER' } }), {
      MY_ROUTER: 'mine',
      ...env,
    }),
    { MY_ROUTER: 'mine' },
  );
  const f = fixture(t);
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return reply(good);
  };
  const jevOnly = await new DecisionService(f.store, config(), transport, {
    JEV_API_KEY: 'jev-key',
  }).decide(input);
  assert.deepEqual(jevOnly, { status: 'unavailable', reason: 'missing_key' });
  const routerOnly = await new DecisionService(
    f.store,
    decisionsSchema.parse({}),
    transport,
    env,
  ).decide(input);
  assert.deepEqual(routerOnly, { status: 'unavailable', reason: 'missing_key' });
  assert.equal(calls, 0);
});

test('OpenRouter request carries a strict schema and its answers come back in the Jev shape', async (t) => {
  const f = fixture(t);
  let sent: any;
  const transport: typeof fetch = async (url, options) => {
    assert.equal(url, OPENROUTER_URL);
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer private-router-key');
    sent = JSON.parse(String(options?.body));
    return reply(good);
  };
  const result = await new DecisionService(f.store, config(), transport, env).decide(input);
  assert.equal(sent.model, 'openai/gpt-4.1-nano');
  assert.equal(sent.temperature, 0);
  assert.deepEqual(sent.provider, { require_parameters: true });
  assert.equal(sent.response_format.type, 'json_schema');
  assert.equal(sent.response_format.json_schema.strict, true);
  const schema = sent.response_format.json_schema.schema;
  assert.deepEqual(schema.required, ['pick', 'rate', 'holds']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.pick.properties.choice.enum, ['yes', 'no', 'maybe']);
  assert.deepEqual(schema.properties.rate.required, ['score', 'confidence']);
  assert.equal(schema.properties.holds.type, 'number');
  assert.deepEqual(JSON.parse(sent.messages[1].content).state, input.state);
  assert.doesNotMatch(JSON.stringify(sent), /private-router-key/);

  assert.equal(result.status, 'decision');
  if (result.status !== 'decision') return;
  const { pick, rate, holds } = result.response.answers;
  assert.ok(pick?.type === 'choice' && rate?.type === 'score' && holds?.type === 'noul');
  assert.equal(pick.choice, 'no');
  assert.equal(pick.confidence, 0.8);
  assert.equal(pick.probabilities.no, 0.8);
  assert.ok(Math.abs(pick.probabilities.yes! - 0.1) < 1e-9);
  assert.ok(Math.abs(pick.probabilities.maybe! - 0.1) < 1e-9);
  assert.equal(rate.score, 2);
  assert.equal(rate.probabilities['2'], 0.6);
  assert.ok(Math.abs(rate.probabilities['0']! - 0.2) < 1e-9);
  assert.equal(holds.noul, 0.25);
  assert.deepEqual(result.response.usage, { input_tokens: 300, output_tokens: 20 });

  const records = decisionProfile(f.store).records;
  assert.equal(records.length, 1);
  assert.equal(records[0]!.requestedModel, 'openai/gpt-4.1-nano');
  assert.ok(Math.abs(records[0]!.estimatedUsd - (300 * 0.1 + 20 * 0.4) / 1e6) < 1e-12);
  assert.doesNotMatch(fs.readFileSync(records[0]!.artifact!, 'utf8'), /private-router-key/);
  const again = await new DecisionService(f.store, config(), transport, env).decide(input);
  assert.ok(again.status === 'decision' && again.cached);
});

test('OpenRouter replies that break the schema fall back instead of being guessed', async (t) => {
  const f = fixture(t);
  const cases: Array<[string, Response]> = [
    ['not json', reply('Sure! The answer is no.')],
    ['unknown label', reply({ ...good, pick: { choice: 'perhaps', confidence: 0.8 } })],
    ['confidence above 1', reply({ ...good, pick: { choice: 'no', confidence: 1.5 } })],
    ['score out of range', reply({ ...good, rate: { score: 5, confidence: 0.5 } })],
    ['probability below 0', reply({ ...good, holds: -0.2 })],
    ['missing answer', reply({ pick: good.pick, rate: good.rate })],
    [
      'cut off',
      reply(good, {
        choices: [{ finish_reason: 'length', message: { content: JSON.stringify(good) } }],
      }),
    ],
    ['no choices', reply(good, { choices: [] })],
  ];
  for (const [name, response] of cases) {
    const result = await new DecisionService(f.store, config(), async () => response, env).decide({
      ...input,
      version: name,
    });
    assert.equal(result.status === 'unavailable' && result.reason, 'invalid_response', name);
  }
  const fenced = await new DecisionService(
    f.store,
    config(),
    async () => reply('```json\n' + JSON.stringify(good) + '\n```'),
    env,
  ).decide({ ...input, version: 'fenced' });
  assert.equal(fenced.status, 'decision');
});

test('OpenRouter calls get their own foreground limit, not the shorter Jev one', async (t) => {
  const f = fixture(t);
  const slow: typeof fetch = async () => {
    await new Promise((r) => setTimeout(r, 150));
    return reply(good);
  };
  const svc = new DecisionService(f.store, config({ foregroundTimeoutMs: 50 }), slow, env);
  assert.equal((await svc.decide(input)).status, 'decision');
  const short = new DecisionService(
    f.store,
    config({ openrouter: { foregroundTimeoutMs: 50 } }),
    slow,
    env,
  );
  const result = await short.decide({ ...input, version: 'short' });
  assert.equal(result.status === 'unavailable' && result.reason, 'timeout');
});
