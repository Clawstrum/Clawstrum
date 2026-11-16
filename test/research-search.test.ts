import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './helpers.js';
import { researchSchema } from '../src/research/config.js';
import { researchTool } from '../src/research/tools.js';
import {
  searchLiterature,
  parseId,
  fromOA,
  stemTokens,
  jevRequest,
  type SearchDeps,
  type SearchDecisions,
  withRoutes,
} from '../src/research/search.js';
import type { DecisionInput, DecisionResult } from '../src/decisions/client.js';
import { canonical } from '../src/decisions/client.js';

const OA_KEY = 'oa-secret-key-123456';
const work = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id: `https://openalex.org/${id}`,
  doi: null,
  title,
  publication_year: 2020,
  cited_by_count: 10,
  type: 'article',
  authorships: [{ author: { display_name: `Author ${id}` } }],
  abstract_inverted_index: { about: [0], [title.split(' ')[0]!.toLowerCase()]: [1] },
  referenced_works: [],
  ...extra,
});
const RELEVANT = [
  work('W1', 'Perceptron learning of spike timing decisions', {
    referenced_works: ['https://openalex.org/W50'],
  }),
  work('W2', 'Multi-spike perceptron learns precise spike timing'),
  work('W3', 'Aggregate-label perceptron learning with spike timing'),
];
const NOISE = Array.from({ length: 40 }, (_, i) =>
  work(`W${100 + i}`, `Soil erosion measurements in river basin number ${i}`),
);
const EXTRA: Record<string, ReturnType<typeof work>> = {
  W50: work('W50', 'Reference paper on perceptron synaptic plasticity foundations'),
  W60: work('W60', 'Citing work extending the perceptron to dendrites'),
  W70: work('W70', 'Seed paper about groundwater chemistry sampling', {
    doi: 'https://doi.org/10.1000/seed',
  }),
  W71: work('W71', 'Citer of the seed paper on groundwater chemistry'),
  W80: work('W80', 'Recent keyword stand-in about perceptron spike timing', {
    publication_year: 2026,
  }),
};
const ALL = new Map(
  [...RELEVANT, ...NOISE, ...Object.values(EXTRA)].map((w) => [w.id.slice(21), w]),
);
const CITERS: Record<string, string[]> = { W1: ['W60'], W70: ['W71'] };

interface Call {
  url: URL;
  auth?: string;
}
function transport(opts: { semantic504?: boolean; throwAll?: string } = {}) {
  const calls: Call[] = [];
  const cost = { 'x-ratelimit-cost-usd': '0.0001', 'x-ratelimit-remaining-usd': '0.9' };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', ...cost },
    });
  const fn = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization });
    if (opts.throwAll) throw new Error(opts.throwAll);
    if (url.hostname === 'api.openalex.org') {
      const q = url.searchParams;
      const filter = q.get('filter') ?? '';
      if (url.pathname.startsWith('/works/doi:'))
        return url.pathname.endsWith('10.1000/seed')
          ? json(ALL.get('W70'))
          : new Response('', { status: 404 });
      if (url.pathname.startsWith('/works/')) {
        const w = ALL.get(url.pathname.slice(7));
        return w ? json(w) : new Response('', { status: 404 });
      }
      if (filter.startsWith('openalex_id:'))
        return json({
          results: filter
            .slice(12)
            .split('|')
            .flatMap((id) => ALL.get(id) ?? []),
        });
      if (filter.startsWith('cites:'))
        return json({ results: (CITERS[filter.slice(6)] ?? []).map((id) => ALL.get(id)) });
      if (q.has('search.semantic')) {
        if (filter)
          return opts.semantic504
            ? new Response('Gateway Timeout', { status: 504, headers: cost })
            : json({ results: [] });
        return json({ results: [RELEVANT[1], ...NOISE.slice(20)] });
      }
      if (q.has('search')) {
        if (filter.startsWith('publication_year:>')) return json({ results: [EXTRA.W80] });
        return json({ results: [...RELEVANT, ...NOISE.slice(0, 20)] });
      }
      return json({ results: [] });
    }
    if (url.hostname === 'export.arxiv.org') return new Response('<feed></feed>');
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}
const answer = (p: number): DecisionResult => ({
  status: 'decision',
  id: 'd',
  cached: false,
  artifact: '',
  response: {
    model: 'jev-1.13.0',
    answers: {
      addresses: { type: 'noul', noul: p },
    },
    usage: { input_tokens: 500, output_tokens: 0 },
  },
});
function jev(fail: (n: number) => DecisionResult | null = () => null) {
  const inputs: DecisionInput[] = [];
  const client: SearchDecisions = {
    async decide(input) {
      inputs.push(input);
      const forced = fail(inputs.length);
      if (forced) return forced;
      const title = String((input.state as any).c_paper_title);
      return answer(/perceptron/i.test(title) ? (/citing/i.test(title) ? 0.97 : 0.9) : 0.05);
    },
  };
  return { client, inputs };
}
function deps(t: any, over: Partial<SearchDeps> = {}): SearchDeps {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-search-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-28T12:00:00Z');
  return {
    config: researchSchema.parse({ email: 'lab@example.org' }),
    artifactDir: dir,
    env: { OPENALEX_API_KEY: OA_KEY },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    ...over,
  };
}
const input = {
  q: 'How does the perceptron learn spike timing?',
  ctx: 'We model single-neuron learning of spike timing.\nWe need prior perceptron work.',
  kw: ['perceptron spike timing', 'perceptron learning rule'],
};
const artifact = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));

test('research_search ranks by Jev and expands one hop from the best-graded papers', async (t) => {
  const net = transport();
  const j = jev();
  const r = await searchLiterature(
    { ...input, k: 5, hops: 1, gradeFrac: 1 },
    deps(t, { fetch: net.fn, decisions: j.client }),
  );
  assert.equal(r.grader, 'jev');
  assert.equal(r.fallback, null);
  assert.equal(r.top.length, 5);
  assert.equal(r.top[0]!.title, 'Citing work extending the perceptron to dendrites');
  assert.equal(r.top[0]!.score, 1.02); // Jev P .97 + .05, found by two routes
  assert.equal(r.top[0]!.id, 'W60');
  assert.ok(r.top.slice(0, 5).every((row) => /perceptron/i.test(row.title)));
  assert.deepEqual(
    r.counts.hops.map((h) => h.hop),
    [1],
  );
  assert.ok(r.counts.hops[0]!.new >= 2);
  assert.ok(r.cost.openalex_usd > 0 && r.cost.openalex_calls > 0);
  assert.ok(r.cost.jev_ok > 40);
  const first = j.inputs[0]!;
  assert.equal((first.state as any).b_project_context, input.ctx);
  assert.deepEqual(Object.keys(first.questions), ['addresses']);
  assert.equal(first.questions.addresses!.type, 'noul');
  assert.equal(first.feature, 'literature-search');
  // Every OpenAlex call is authenticated and identified; the key never leaves in the output.
  const oa = net.calls.filter((c) => c.url.hostname === 'api.openalex.org');
  assert.ok(oa.every((c) => c.auth === `Bearer ${OA_KEY}`));
  assert.ok(oa.every((c) => c.url.searchParams.get('mailto') === 'lab@example.org'));
  const saved = artifact(r.artifact);
  assert.equal(saved.ranked.length, r.counts.candidates);
  assert.ok(saved.ranked.every((x: any) => x.grader === 'jev' && 'abstract' in x && x.via.length));
  assert.ok(!fs.readFileSync(r.artifact, 'utf8').includes(OA_KEY));
  assert.ok(!JSON.stringify(r).includes(OA_KEY));
});

test('research_search grades only the best half by word match unless gradeFrac says otherwise', async (t) => {
  const half = jev();
  const r = await searchLiterature(
    { ...input, k: 5, hops: 0 },
    deps(t, { fetch: transport().fn, decisions: half.client }),
  );
  assert.equal(r.grader, 'jev');
  const { candidates, graded, skipped_by_word_match: skipped } = r.counts;
  assert.equal(graded + skipped, candidates);
  assert.equal(graded, Math.ceil(candidates / 2));
  assert.equal(half.inputs.length, graded); // skipped papers cost no Jev call
  assert.ok(r.top.slice(0, 3).every((row) => /perceptron/i.test(row.title) && row.score !== null));
  const saved = artifact(r.artifact);
  const firstSkipped = saved.ranked.findIndex((x: any) => x.jev_p === null);
  assert.equal(firstSkipped, graded); // ungraded papers rank after every graded one
  const full = await searchLiterature(
    { ...input, k: 5, hops: 0, gradeFrac: 1 },
    deps(t, { fetch: transport().fn, decisions: jev().client }),
  );
  assert.equal(full.counts.skipped_by_word_match, 0);
  assert.equal(full.counts.graded, full.counts.candidates);
  await assert.rejects(
    searchLiterature({ ...input, gradeFrac: 0 }, deps(t, { fetch: transport().fn })),
  );
});

test('research_search ranks with bm25 from the start when Jev is unavailable', async (t) => {
  const net = transport();
  const j = jev(() => ({ status: 'unavailable', reason: 'missing_key' }));
  const r = await searchLiterature(input, deps(t, { fetch: net.fn, decisions: j.client }));
  assert.equal(r.grader, 'bm25');
  assert.match(r.fallback!, /jev: no Jev API key/);
  assert.ok(r.warnings.some((w) => /whole run re-ranked by bm25/.test(w)));
  assert.equal(r.cost.jev_ok, 0);
  assert.ok(j.inputs.length <= 24);
  assert.equal(r.counts.hops.length, 1);
  assert.equal(r.counts.hops[0]!.seeds, 3);
  assert.ok(r.top.every((row) => row.score !== null));
  assert.match(r.top[0]!.title, /perceptron/i);
  const noClient = await searchLiterature(input, deps(t, { fetch: transport().fn }));
  assert.equal(noClient.grader, 'bm25');
  const forced = await searchLiterature(
    { ...input, grader: 'bm25' },
    deps(t, { fetch: transport().fn, decisions: jev().client }),
  );
  assert.equal(forced.grader, 'bm25');
  assert.equal(forced.fallback, 'grader=bm25 requested');
  assert.equal(forced.cost.jev_calls, 0);
});

test('research_search moves the whole run to bm25 when Jev fails mid-run', async (t) => {
  const j = jev((n) => (n > 20 ? { status: 'unavailable', reason: 'transport_error' } : null));
  const r = await searchLiterature(
    { ...input, k: 10, gradeFrac: 1 },
    deps(t, { fetch: transport().fn, decisions: j.client }),
  );
  assert.ok(r.cost.jev_ok >= 20);
  assert.equal(r.grader, 'bm25');
  assert.match(r.fallback!, /^jev: .*(in a row failed|Jev calls failed).*transport_error/);
  const saved = artifact(r.artifact);
  assert.ok(
    saved.ranked.every((x: any) => x.grader === 'bm25' && Math.abs(x.score - x.pre) < 1e-4),
  );
});

test('research_search substitutes a recent keyword search for a semantic 504', async (t) => {
  const net = transport({ semantic504: true });
  const r = await searchLiterature(
    { ...input, hops: 0 },
    deps(t, { fetch: net.fn, decisions: jev().client }),
  );
  assert.equal(r.counts.by_source.kw1r, 1);
  assert.equal(r.counts.by_source.sem1r, undefined);
  assert.ok(!r.warnings.some((w) => /504/.test(w)));
  assert.ok(artifact(r.artifact).ranked.some((x: any) => x.openalex === 'W80'));
  const recentSemantic = net.calls.filter(
    (c) => c.url.searchParams.has('search.semantic') && c.url.searchParams.get('filter'),
  );
  assert.equal(recentSemantic.length, 1);
});

test('research_search warns without an OpenAlex key and redacts secrets from errors', async (t) => {
  const net = transport();
  const r = await searchLiterature(
    { ...input, hops: 0 },
    deps(t, { fetch: net.fn, decisions: jev().client, env: {} }),
  );
  assert.ok(r.warnings.some((w) => /no OpenAlex API key in \$OPENALEX_API_KEY/.test(w)));
  assert.ok(net.calls.every((c) => c.auth === undefined));

  const jevKey = 'jev-secret-key-abcdef';
  await assert.rejects(
    searchLiterature(
      input,
      deps(t, {
        fetch: transport({ throwAll: `connect refused ${OA_KEY} ${jevKey}` }).fn,
        secrets: [jevKey],
      }),
    ),
    (e: Error) => {
      assert.match(e.message, /nothing retrieved/);
      assert.match(e.message, /<key>/);
      assert.ok(!e.message.includes(OA_KEY) && !e.message.includes(jevKey));
      return true;
    },
  );
});

test('research_search honours exclude and expands every seed', async (t) => {
  const r = await searchLiterature(
    {
      ...input,
      k: 50,
      hops: 1,
      seeds: ['doi:10.1000/seed'],
      exclude: ['W2', 'Aggregate-label perceptron learning with spike timing'],
    },
    deps(t, { fetch: transport().fn, decisions: jev().client }),
  );
  const saved = artifact(r.artifact);
  const ids = saved.ranked.map((x: any) => x.openalex);
  assert.ok(!ids.includes('W2') && !ids.includes('W3'));
  assert.ok(ids.includes('W70'), 'seed is a candidate');
  assert.ok(ids.includes('W71'), 'citer of the seed came in through expansion');
  assert.ok(saved.seeds[0].seeds.some((s: any) => s.title.startsWith('Seed paper')));
  assert.equal(saved.ranked.find((x: any) => x.openalex === 'W70').via[0], 'seed#');
});

test('research_search helpers and tool input', async (t) => {
  assert.deepEqual(parseId('https://doi.org/10.48550/arXiv.2106.09685v2'), {
    kind: 'arxiv',
    id: '2106.09685',
  });
  assert.deepEqual(parseId('w123'), { kind: 'openalex', id: 'W123' });
  assert.deepEqual(parseId('doi:10.1038/NN1643'), { kind: 'doi', doi: '10.1038/nn1643' });
  assert.equal(parseId('not an id'), null);
  const r = fromOA({
    id: 'https://openalex.org/W123',
    doi: 'https://doi.org/10.1000/ABC.',
    title: 'A <i>neuron</i> that learns',
    locations: [{ landing_page_url: 'https://arxiv.org/abs/2101.00001v2' }],
    authorships: [1, 2, 3, 4].map((i) => ({ author: { display_name: `N${i}` } })),
    abstract_inverted_index: { learns: [1], it: [0] },
  });
  assert.equal(r.doi, '10.1000/abc');
  assert.equal(r.arxiv, '2101.00001');
  assert.equal(r.title, 'A neuron that learns');
  assert.deepEqual(r.authors, ['N1', 'N2', 'N3', 'et al.']);
  assert.equal(r.abstract, 'it learns');
  assert.deepEqual(stemTokens('The learning of spiking neurons'), ['learn', 'spik', 'neuron']);
  const noCtx = jevRequest({ title: 'T', abstract: 'x'.repeat(4000) }, 'Q', '');
  assert.equal(noCtx.state.b_project_context, undefined);
  assert.equal(noCtx.state.d_paper_abstract!.length, 1500);
  assert.match(noCtx.questions.addresses!.instructions, /working on exactly that question/);
  /* Jev reads state in the client's sorted key order; the question must come before the paper. */
  const withCtx = jevRequest({ title: 'T', abstract: 'A' }, 'Q', 'C');
  assert.deepEqual(Object.keys(JSON.parse(canonical(withCtx.state))), [
    'a_research_question',
    'b_project_context',
    'c_paper_title',
    'd_paper_abstract',
  ]);

  const f = fixture(t);
  await assert.rejects(
    researchTool(
      'research_search',
      { q: 'x', kw: [] },
      {
        store: f.store,
        config: f.config,
        sessionId: f.session.id,
        scope: 'test',
      },
    ),
  );
  await assert.rejects(
    researchTool(
      'research_search',
      { q: 'x', kw: ['y'], grader: 'haiku' },
      {
        store: f.store,
        config: f.config,
        sessionId: f.session.id,
        scope: 'test',
      },
    ),
  );
});

test('withRoutes adds 0.05 per search route past the first, capped at +0.2', () => {
  assert.equal(withRoutes(0.5, 1), 0.5);
  assert.ok(Math.abs(withRoutes(0.5, 3) - 0.6) < 1e-9);
  assert.ok(Math.abs(withRoutes(0.5, 14) - 0.7) < 1e-9);
});
