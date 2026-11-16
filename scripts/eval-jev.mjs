#!/usr/bin/env node
// Offline by default. Live mode uses only the explicitly supplied synthetic/labeled fixture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from '../dist/store.js';
import { decisionsSchema } from '../dist/decisions/config.js';
import { DecisionService, decisionsAvailable } from '../dist/decisions/client.js';
import { decisionProfile } from '../dist/decisions/profile.js';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    fixture: {
      type: 'string',
      default: new URL('../test/fixtures/jev-synthetic.json', import.meta.url).pathname,
    },
    out: { type: 'string' },
    threshold: { type: 'string', default: '0' },
  },
});
const threshold = Number(values.threshold);
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
  throw new Error('threshold must be between 0 and 1');
if (values.live && !values.out)
  throw new Error('Live evaluation requires --out for reproducible artifacts');
const config = decisionsSchema.parse({ foregroundTimeoutMs: 10000, dailyBudgetUsd: 0.05 });
if (values.live && !decisionsAvailable(config))
  throw new Error('Live evaluation requires JEV_API_KEY or TYPESAFE_API_KEY');
const home = values.out
  ? path.resolve(values.out)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-jev-eval-'));
if (values.out && fs.existsSync(path.join(home, 'store')))
  throw new Error('Use a new evaluation output directory');
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const store = new Store(home);
try {
  const cases = JSON.parse(fs.readFileSync(values.fixture, 'utf8'));
  const records = [];
  for (const item of cases) {
    const transport = values.live
      ? fetch
      : async () => {
          if (!item.recorded) return new Response('', { status: 503 });
          return new Response(JSON.stringify(item.recorded), {
            headers: { 'content-type': 'application/json' },
          });
        };
    const service = new DecisionService(
      store,
      config,
      transport,
      values.live ? process.env : { JEV_API_KEY: 'offline-replay-no-network' },
    );
    const decision = await service.decide({
      feature: 'evaluation',
      version: '1',
      scope: item.id,
      state: item.state,
      questions: item.questions,
    });
    const labels = Object.entries(item.expected);
    const answers = decision.status === 'decision' ? decision.response.answers : {};
    const accepted =
      decision.status === 'decision' &&
      labels.every(([id]) => answers[id]?.type === 'choice' && answers[id].confidence >= threshold);
    const correct =
      decision.status === 'decision' &&
      labels.every(([id, label]) => answers[id]?.choice === label);
    records.push({ id: item.id, accepted, correct, expected: item.expected, decision });
  }
  const accepted = records.filter((r) => r.accepted),
    correct = records.filter((r) => r.correct);
  const result = {
    mode: values.live ? 'live-synthetic' : 'offline-recorded-replay',
    model: config.model,
    threshold,
    cases: records.length,
    available: records.filter((r) => r.decision.status === 'decision').length,
    exactChoiceMatches: correct.length,
    accepted: accepted.length,
    acceptedAccuracy: accepted.length
      ? accepted.filter((r) => r.correct).length / accepted.length
      : null,
    abstainedOrUnavailable: records.length - accepted.length,
    records,
    profile: decisionProfile(store, { limit: 1000 }),
    limitation:
      'Small development regression set, not held-out calibration or a savings benchmark. Threshold is an evaluation parameter, not a production rule. Offline timing measures replay overhead only.',
  };
  if (values.out)
    fs.writeFileSync(path.join(home, 'evaluation.json'), JSON.stringify(result, null, 2) + '\n', {
      mode: 0o600,
    });
  const { records: _, profile, ...summary } = result;
  console.log(
    JSON.stringify(
      { ...summary, profile: profile.features, output: values.out ? home : undefined },
      null,
      2,
    ),
  );
} finally {
  store.close();
  if (!values.out) fs.rmSync(home, { recursive: true, force: true });
}
