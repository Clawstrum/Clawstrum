import test from 'node:test';
import { compactionHooks, mergeHooks } from '../src/compaction.js';
import { updateMemory } from '../src/memory.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, ok, settle } from './helpers.js';
import { configSchema } from '../src/config.js';
import { Store } from '../src/store.js';
import { ResearchHttp, publicUrl } from '../src/research/http.js';
import { researchSchema } from '../src/research/config.js';
import {
  parseCitation,
  citationRefs,
  verifyCitation,
  citationRecord,
  checkCitation,
  retrievePaper,
} from '../src/research/literature.js';
import { saveNote, researchState } from '../src/research/records.js';
import {
  preflight,
  submitJob,
  watchJob,
  ClusterMonitor,
  clusterCommand,
  type Command,
} from '../src/research/cluster.js';
import { delegate, reconcileResult } from '../src/research/workers.js';
import { workerProfile } from '../src/research/worker-profile.js';
import { researchTool } from '../src/research/tools.js';
import { BackgroundInput, researchHooks, invokesSbatch } from '../src/research/hooks.js';
import { createClaudeProvider } from '../src/providers.js';
import { Engine } from '../src/engine.js';
import { buildContext } from '../src/context.js';
import { deliveryPayloads } from '../src/discord.js';
import type { Provider, ProviderRequest } from '../src/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function enabled(t: any) {
  const f = fixture(t);
  f.config.research = researchSchema.parse({
    enabled: true,
    minTextChars: 30,
    // Explicitly exercise advisory behavior independently of the configured default.
    validation: 'advisory',
    slurm: { enabled: true },
    // Off by default here for the same reason as the shared fixture: most of these tests do not
    // care about either feature, and turn it on explicitly where they do.
    workers: { minFreeMemoryMB: 0, requireContext: false, briefContext: { enabled: false } },
  });
  return f;
}
function http(
  config: ReturnType<typeof researchSchema.parse>,
  fn: (url: URL) => Response | Promise<Response>,
) {
  return new ResearchHttp(config, (async (input: any) =>
    fn(new URL(String(input)))) as typeof fetch);
}
const metadata = (doi = '10.1234/example') =>
  JSON.stringify({
    message: {
      DOI: doi,
      title: ['An experiment'],
      author: [{ given: 'Jane', family: 'Doe' }],
      issued: { 'date-parts': [[2024]] },
      'container-title': ['Journal'],
      'update-to': [{ DOI: '10.1234/correction' }],
    },
  });
function batch(f: ReturnType<typeof fixture>) {
  const script = path.join(f.session.workspace, 'batch.sh');
  fs.writeFileSync(script, '#!/bin/bash\n#SBATCH --time=00:01:00\nprintf hello\n');
  return { script };
}

test('briefContext and requireContext default on, and typingMaxMs defaults to 300000 and must be >= debounceMaxMs', (t) => {
  const research = researchSchema.parse({});
  assert.equal(research.workers.requireContext, true);
  assert.equal(research.workers.briefContext.enabled, true);
  assert.equal(research.workers.briefContext.recentMessages, 40);
  assert.equal(research.workers.briefContext.messageChars, 1500);
  assert.equal(research.workers.briefContext.maxChars, 30000);
  const f = fixture(t);
  assert.equal(configSchema.parse(f.config).runtime.typingMaxMs, 300000);
  assert.throws(
    () =>
      configSchema.parse({
        ...f.config,
        runtime: { ...f.config.runtime, debounceMaxMs: 100, typingMaxMs: 10 },
      }),
    /typingMaxMs must be >= debounceMaxMs/,
  );
});
test('research defaults are enabled, validate roles and require known account IDs', (t) => {
  const f = fixture(t);
  assert.equal(f.config.research.enabled, true);
  assert.equal(f.config.research.consolidator.enabled, true);
  assert.equal(f.config.research.curation.enabled, true);
  assert.equal(f.config.research.slurm.enabled, true);
  assert.equal(f.config.discord.plainDashes, true);
  // Enabling research does not silently opt existing installations into denials.
  assert.equal(f.config.research.validation, 'advisory');
  assert.equal(f.config.runtime.nativeSessionMaxTurns, 0);
  assert.equal(f.config.research.workers.roles.explorer!.models.codex, 'gpt-5.6-luna');
  assert.throws(() =>
    configSchema.parse({ ...f.config, research: { workers: { account: 'absent' } } }),
  );
  assert.throws(() =>
    researchSchema.parse({
      workers: { roles: { a: { description: 'd', prompt: 'p', maxTurns: -1 } } },
    }),
  );
});
test('explicit feature opt-outs remain disabled when defaults are on', (t) => {
  const f = fixture(t);
  const config = configSchema.parse({
    ...f.config,
    discord: { ...f.config.discord, plainDashes: false },
    research: {
      enabled: false,
      consolidator: { enabled: false },
      curation: { enabled: false },
      slurm: { enabled: false },
      holdBackgroundTasks: false,
    },
  });
  assert.equal(config.research.enabled, false);
  assert.equal(config.research.consolidator.enabled, false);
  assert.equal(config.research.curation.enabled, false);
  assert.equal(config.research.slurm.enabled, false);
  assert.equal(config.research.holdBackgroundTasks, false);
  assert.equal(config.discord.plainDashes, false);
  assert.equal(config.research.validation, 'advisory');
});
test('schema 2 upgrades to 5 and labels historical harness notices without losing deliveries', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-v3-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const old = new Store(home);
  const s = old.ensureSession('123456');
  old.outbox(s.id, 'notice');
  old.close();
  const db = new DatabaseSync(path.join(home, 'clawstrum.db'));
  db.exec(
    'DROP TABLE group_review_routes; DROP TABLE group_receipts; DROP TABLE group_review_jobs; DROP TABLE group_issues; DROP TABLE group_audiences; DROP TABLE group_entries; DROP TABLE group_memberships; DROP TABLE group_channels; DROP TABLE groups; DROP TABLE history_supersessions; DROP TABLE history_usage; DROP TABLE history_records; ALTER TABLE outbox DROP COLUMN origin; DROP TABLE citations; DROP TABLE research_notes; DROP TABLE delegations; DROP TABLE cluster_jobs; ALTER TABLE sessions DROP COLUMN active_model; UPDATE schema_version SET version=2;',
  );
  db.close();
  const upgraded = new Store(home);
  try {
    assert.equal(upgraded.get<any>('SELECT version FROM schema_version').version, 6);
    assert.equal(upgraded.get<any>('SELECT origin FROM outbox').origin, 'notice');
    assert.equal(upgraded.get<any>('SELECT content FROM outbox').content, 'notice');
  } finally {
    upgraded.close();
  }
});
test('citation identifiers normalize mirrored arXiv DOIs, versions and prose punctuation', () => {
  assert.equal(
    parseCitation('https://doi.org/10.48550/arXiv.2401.12345v2')?.key,
    'arxiv:2401.12345v2',
  );
  assert.equal(parseCitation('arXiv:hep-th/9901001')?.kind, 'arxiv');
  assert.deepEqual(
    citationRefs('[paper](https://doi.org/10.1234/a(b)). arXiv:2401.12345v2.').map((i) => i.key),
    ['doi:10.1234/a(b)', 'arxiv:2401.12345v2'],
  );
});
test('registry identity mismatch is not verified; checks surface title, author, year and quote mismatches', async (t) => {
  const f = enabled(t);
  await assert.rejects(
    verifyCitation(
      f.store,
      f.config.research,
      '10.1234/example',
      http(f.config.research, () => new Response(metadata('10.1234/wrong'))),
    ),
    /different DOI/,
  );
  assert.equal(citationRecord(f.store, '10.1234/example'), undefined);
  const record = await verifyCitation(
    f.store,
    f.config.research,
    '10.1234/example',
    http(f.config.research, () => new Response(metadata())),
  );
  assert.equal(record.authors[0], 'Jane Doe');
  assert.equal(record.correctionLinks.length, 1);
  assert.equal(fs.statSync(record.responsePath).mode & 0o777, 0o600);
  assert.equal(checkCitation(f.store, { id: record.key, authors: ['Doe'], year: 2025 }).ok, true);
  const textPath = path.join(f.home, 'quote.txt');
  fs.writeFileSync(textPath, 'Observed variance decreases with population size.');
  const checked = checkCitation(f.store, {
    id: record.key,
    title: 'Other',
    authors: ['Smith'],
    year: 2001,
    quote: '...',
    textPath,
  });
  assert.equal(checked.ok, false);
  assert.equal(checked.issues.length, 4);
  assert.equal(
    checkCitation(f.store, { id: record.key, quote: 'variance decreases', textPath }).ok,
    true,
  );
});
test('arXiv metadata requires real title/authors and preserves requested version', async (t) => {
  const f = enabled(t);
  const record = await verifyCitation(
    f.store,
    f.config.research,
    '2401.12345v2',
    http(
      f.config.research,
      () =>
        new Response(
          '<meta name="citation_title" content="Test &amp; evidence"><meta name="citation_author" content="A. Author"><meta name="citation_date" content="2024/01/22"><meta name="citation_arxiv_id" content="2401.12345">',
        ),
    ),
  );
  assert.equal(record.id, '2401.12345v2');
  assert.equal(record.year, 2024);
  assert.equal(record.title, 'Test & evidence');
  await assert.rejects(
    verifyCitation(
      f.store,
      f.config.research,
      '2402.12345',
      http(f.config.research, () => new Response('<html>challenge</html>')),
    ),
    /not recorded/,
  );
});
test('retrieval rejects challenge PDFs and login pages, then caches full article provenance', async (t) => {
  const f = enabled(t);
  let calls = 0;
  const fetcher = http(f.config.research, (url) => {
    calls++;
    return new Response(
      url.hostname === 'ar5iv.labs.arxiv.org'
        ? '<article><p>A full scientific result with enough evidence for the extraction test.</p></article>'
        : url.pathname.startsWith('/pdf')
          ? 'Just a moment'
          : '<html><body>Login required to access this article with many many characters</body></html>',
    );
  });
  const paper = await retrievePaper(f.store, f.config.research, '2401.12345v2', fetcher);
  assert.equal(paper.status, 'ok');
  assert.equal(paper.source, 'ar5iv');
  assert.equal(paper.version, 'preprint');
  assert.equal(calls, 3);
  const cached = await retrievePaper(f.store, f.config.research, '2401.12345v2', fetcher);
  assert.ok(paper.retrievedAt > 0);
  assert.equal(cached.cached, true);
  assert.equal(cached.version, paper.version);
  assert.equal(calls, 3);
  fs.writeFileSync(paper.textPath!, 'corrupted');
  assert.equal(
    (await retrievePaper(f.store, f.config.research, '2401.12345v2', fetcher)).cached,
    undefined,
  );
  assert.equal(calls, 6);
});
test('DOI retrieval prefers repository copies, identifies Unpaywall requests and skips optional credentials', async (t) => {
  const f = enabled(t);
  f.config.research.email = 'researcher@example.org';
  const seen: URL[] = [];
  const network = http(f.config.research, (url) => {
    seen.push(url);
    if (url.hostname.includes('ebi.ac.uk')) return new Response('{}');
    if (url.hostname === 'api.unpaywall.org')
      return new Response(
        JSON.stringify({
          doi: '10.1234/example',
          oa_locations: [
            {
              host_type: 'publisher',
              url_for_pdf: 'https://publisher.example/full.pdf',
              version: 'publishedVersion',
            },
            {
              host_type: 'repository',
              url: 'https://repository.example/paper',
              version: 'acceptedVersion',
            },
          ],
        }),
      );
    if (url.hostname === 'repository.example')
      return new Response('<html><meta name="citation_pdf_url" content="/full.pdf"></html>');
    return new Response('No PDF here');
  });
  const result = await retrievePaper(f.store, f.config.research, '10.1234/example', network);
  assert.equal(result.status, 'no-fulltext');
  assert.equal(
    seen.find((u) => u.hostname === 'api.unpaywall.org')?.searchParams.get('email'),
    'researcher@example.org',
  );
  assert.ok(
    seen.findIndex((u) => u.hostname === 'repository.example') <
      seen.findIndex((u) => u.hostname === 'publisher.example'),
  );
  assert.ok(result.attempts.some((a) => a.source === 'springer-oa' && /Skipped/.test(a.outcome)));
});
test('PDF extraction uses a bounded host process and returns text files rather than inline paper text', async (t) => {
  const f = enabled(t);
  const extractor = path.join(f.home, 'pdftotext');
  fs.writeFileSync(
    extractor,
    `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.argv.at(-1),'A host-extracted scientific paper with detailed reproducible evidence.');`,
    { mode: 0o700 },
  );
  f.config.research.pdftotext = extractor;
  const result = await retrievePaper(
    f.store,
    f.config.research,
    'https://papers.example/full.pdf',
    http(f.config.research, () => new Response('%PDF-test fixture')),
  );
  assert.equal(result.status, 'ok');
  assert.match(fs.readFileSync(result.textPath!, 'utf8'), /host-extracted/);
  assert.ok(!JSON.stringify(result).includes('detailed reproducible'));
  assert.equal(fs.statSync(result.textPath!).mode & 0o777, 0o600);
});
test('PDF text is extracted in reading order, keeping the page-preserving copy aside for tables', async (t) => {
  const f = enabled(t);
  const extractor = path.join(f.home, 'pdftotext-columns');
  fs.writeFileSync(
    extractor,
    `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.argv.at(-1),process.argv.includes('-layout')?'Left column line one.   Right column line nine.':'Left column line one. Left column line two. Right column line nine.');`,
    { mode: 0o700 },
  );
  f.config.research.pdftotext = extractor;
  let calls = 0;
  const fetcher = http(f.config.research, () => {
    calls++;
    return new Response('%PDF-two column fixture');
  });
  const paper = await retrievePaper(
    f.store,
    f.config.research,
    'https://papers.example/two.pdf',
    fetcher,
  );
  assert.equal(paper.status, 'ok');
  const quotable = fs.readFileSync(paper.textPath!, 'utf8');
  assert.match(quotable, /line one\. Left column line two\./);
  assert.ok(!/line one\.   Right/.test(quotable));
  assert.match(fs.readFileSync(paper.layoutTextPath!, 'utf8'), /line one\.   Right/);
  assert.match(paper.layoutNote!, /Quote from textPath/);
  assert.equal(fs.statSync(paper.layoutTextPath!).mode & 0o777, 0o600);
  assert.equal(paper.pdfExtraction, 2);
  fs.writeFileSync(paper.layoutTextPath!, 'altered table');
  const cached = await retrievePaper(
    f.store,
    f.config.research,
    'https://papers.example/two.pdf',
    fetcher,
  );
  assert.equal(cached.cached, true);
  assert.equal(cached.layoutTextPath, undefined);
  assert.ok(cached.textPath);
  /* Text cached before the columns were separated is -layout text; refetch rather than quote it. */
  const stale = JSON.parse(fs.readFileSync(paper.manifestPath, 'utf8'));
  delete stale.pdfExtraction;
  fs.writeFileSync(paper.manifestPath, JSON.stringify(stale));
  const refetched = await retrievePaper(
    f.store,
    f.config.research,
    'https://papers.example/two.pdf',
    fetcher,
  );
  assert.equal(refetched.cached, undefined);
  assert.equal(calls, 2);
});
test('PMC retrieval ignores the open-access licence flag and records the deposited version', async (t) => {
  const f = enabled(t);
  const seen: URL[] = [];
  const network = http(f.config.research, (url) => {
    seen.push(url);
    if (url.hostname.includes('ebi.ac.uk'))
      return new Response(
        JSON.stringify({
          resultList: {
            result: [{ doi: '10.1234/manuscript', pmcid: 'PMC7654321', isOpenAccess: 'N' }],
          },
        }),
      );
    if (url.hostname === 'eutils.ncbi.nlm.nih.gov')
      return new Response(
        '<pmc-articleset><article><front><article-id pub-id-type="manuscript">NIHMS1</article-id></front><body><p>An author manuscript deposit that reads in full whatever the licence flag says.</p></body></article></pmc-articleset>',
      );
    return new Response('No PDF here');
  });
  const result = await retrievePaper(f.store, f.config.research, '10.1234/manuscript', network);
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'ncbi-efetch');
  assert.equal(result.version, 'acceptedVersion');
  assert.match(fs.readFileSync(result.textPath!, 'utf8'), /reads in full/);
  /* fullTextXML answers 500 outside the redistributable subset, so a flagged-N record skips it. */
  assert.ok(!seen.some((u) => u.pathname.endsWith('/fullTextXML')));
});
test('PMC records absent from the search index are resolved by identifier, and front matter is refused', async (t) => {
  const f = enabled(t);
  const network = http(f.config.research, (url) => {
    if (url.hostname.includes('ebi.ac.uk')) return new Response('{}');
    if (url.hostname === 'pmc.ncbi.nlm.nih.gov')
      return new Response(
        JSON.stringify({ records: [{ pmcid: 'PMC1111111', doi: '10.1234/front-matter' }] }),
      );
    if (url.hostname === 'eutils.ncbi.nlm.nih.gov')
      return new Response(
        '<pmc-articleset><article><front><title-group><article-title>Front matter alone, long enough that the character floor accepts it.</article-title></title-group></front></article></pmc-articleset>',
      );
    return new Response('No PDF here');
  });
  const result = await retrievePaper(f.store, f.config.research, '10.1234/front-matter', network);
  assert.equal(result.status, 'no-fulltext');
  assert.ok(
    result.attempts.some((a) => a.source === 'ncbi-efetch' && /metadata only/.test(a.outcome)),
  );
});
test('eLife reviewed preprints are unwrapped from their API envelope', async (t) => {
  const f = enabled(t);
  /* The payload carries no <article> wrapper, so the envelope is what identifies it as full text. */
  const result = await retrievePaper(
    f.store,
    f.config.research,
    '10.7554/elife.110287.1',
    http(f.config.research, (url) =>
      url.hostname === 'api.elifesciences.org'
        ? new Response(
            JSON.stringify({
              id: '110287',
              version: 1,
              indexContent:
                '<h2>Introduction</h2><p>A reviewed preprint with a full article-body section.</p>',
            }),
          )
        : new Response('{}'),
    ),
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'elife-reviewed-preprint');
  assert.equal(result.version, 'reviewedPreprint-v1');
  assert.match(result.documentPath!, /\.json$/);
  const empty = await retrievePaper(
    f.store,
    f.config.research,
    '10.7554/elife.222222.1',
    http(f.config.research, (url) =>
      url.hostname === 'api.elifesciences.org'
        ? new Response('{"id":"222222","version":1,"indexContent":""}')
        : new Response('{}'),
    ),
  );
  assert.ok(
    empty.attempts.some(
      (a) => a.source === 'elife-reviewed-preprint' && /no article payload/.test(a.outcome),
    ),
  );
});
test('eLife rejects wrong identifiers, newer versions, and abstract-only search payloads', async (t) => {
  const f = enabled(t);
  for (const [id, version, indexContent, reason] of [
    ['999', 1, '<h2>Introduction</h2><p>Full body.</p>', /different preprint/],
    ['110287', 2, '<h2>Introduction</h2><p>Full body.</p>', /requested preprint version/],
    ['110287', 1, '<h2>Abstract</h2><p>' + 'metadata '.repeat(500) + '</p>', /metadata only/],
  ] as const) {
    const result = await retrievePaper(
      f.store,
      f.config.research,
      '10.7554/elife.110287.1',
      http(
        f.config.research,
        (url) =>
          new Response(
            url.hostname === 'api.elifesciences.org'
              ? JSON.stringify({ id, version, indexContent })
              : '{}',
          ),
      ),
      undefined,
      true,
    );
    assert.equal(result.status, 'no-fulltext');
    assert.ok(
      result.attempts.some((a) => a.source === 'elife-reviewed-preprint' && reason.test(a.outcome)),
    );
  }
});

test('PMC manuscript version detection uses front matter on both retrieval paths and invalidates older structured caches', async (t) => {
  const f = enabled(t);
  let calls = 0;
  const network = http(f.config.research, (url) => {
    calls++;
    if (url.pathname.endsWith('/search'))
      return new Response(
        JSON.stringify({
          resultList: {
            result: [{ doi: '10.1234/pmc-version', pmcid: 'PMC12345', isOpenAccess: 'Y' }],
          },
        }),
      );
    return new Response(
      "<article><front><article-id pub-id-type='manuscript'>NIHMS1</article-id><article-id pub-id-type='doi'>10.1234/pmc-version</article-id></front><body><p>A sufficiently long author manuscript body for the extraction fixture.</p></body></article>",
    );
  });
  const first = await retrievePaper(f.store, f.config.research, '10.1234/pmc-version', network);
  assert.equal(first.source, 'europe-pmc');
  assert.equal(first.version, 'acceptedVersion');
  const manifest = JSON.parse(fs.readFileSync(first.manifestPath, 'utf8'));
  delete manifest.retrievalVersion;
  fs.writeFileSync(first.manifestPath, JSON.stringify(manifest));
  const before = calls;
  const refreshed = await retrievePaper(f.store, f.config.research, '10.1234/pmc-version', network);
  assert.equal(refreshed.cached, undefined);
  assert.ok(calls > before);
});

test('PMC converter and article identities must match; an unclosed body is not full text', async (t) => {
  const f = enabled(t);
  for (const kind of ['converter', 'article', 'unclosed']) {
    let fetched = false;
    const result = await retrievePaper(
      f.store,
      f.config.research,
      '10.1234/expected',
      http(f.config.research, (url) => {
        if (url.hostname.includes('ebi.ac.uk')) return new Response('{}');
        if (url.hostname === 'pmc.ncbi.nlm.nih.gov')
          return new Response(
            JSON.stringify({
              records: [
                {
                  doi: kind === 'converter' ? '10.1234/wrong' : '10.1234/expected',
                  pmcid: 'PMC12345',
                },
              ],
            }),
          );
        if (url.hostname === 'eutils.ncbi.nlm.nih.gov') {
          fetched = true;
          return new Response(
            kind === 'unclosed'
              ? '<article><front>' + 'metadata '.repeat(100) + '</front><body><p>truncated'
              : '<article><front><article-id pub-id-type="doi">10.1234/wrong</article-id></front><body><p>' +
                  'body '.repeat(100) +
                  '</p></body></article>',
          );
        }
        return new Response('');
      }),
      undefined,
      true,
    );
    assert.equal(result.status, 'no-fulltext');
    assert.equal(fetched, kind !== 'converter');
    assert.ok(result.attempts.some((a) => /different DOI|metadata only/.test(a.outcome)));
  }
});

test('failure of optional layout extraction preserves valid PDF prose', async (t) => {
  const f = enabled(t);
  const executable = path.join(f.home, 'layout-failure');
  fs.writeFileSync(
    executable,
    `#!${process.execPath}\nif(process.argv.includes('-layout'))process.exit(1);require('node:fs').writeFileSync(process.argv.at(-1),'Valid prose from a PDF whose optional table-layout extraction fails.');`,
    { mode: 0o700 },
  );
  f.config.research.pdftotext = executable;
  const result = await retrievePaper(
    f.store,
    f.config.research,
    'https://papers.example/table.pdf',
    http(f.config.research, () => new Response('%PDF-fixture')),
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.layoutTextPath, undefined);
  assert.match(fs.readFileSync(result.textPath!, 'utf8'), /Valid prose/);
});
test('HTTP retrieval bounds streamed bodies, sanitizes credential URLs and propagates cancellation', async (t) => {
  const f = enabled(t);
  await assert.rejects(
    http(f.config.research, () => new Response('x'.repeat(2000))).get('https://example.org', 1024),
    /exceeded/,
  );
  assert.ok(
    !publicUrl('https://x:pw@example.org/p?api_key=secret&email=private').includes('secret'),
  );
  const failing = new ResearchHttp(f.config.research, (async () => {
    throw new Error('https://example.org?api_key=secret');
  }) as typeof fetch);
  await assert.rejects(
    failing.get('https://example.org?api_key=secret'),
    (e) => !String(e).includes('secret'),
  );
  const ctrl = new AbortController();
  ctrl.abort(new Error('stop-retrieval'));
  await assert.rejects(
    retrievePaper(
      f.store,
      f.config.research,
      '2401.12345',
      http(f.config.research, () => new Response('')),
      ctrl.signal,
    ),
    /stop-retrieval/,
  );
});
test('structured research notes are idempotent, scoped and restored into resumed context', (t) => {
  const f = enabled(t);
  const note = {
    kind: 'method' as const,
    title: 'Simulation',
    body: 'Seed 42, dt=0.01 s; result /tmp/result.csv',
    evidence: ['/tmp/code.py'],
  };
  const saved = saveNote(f.store, f.session.id, 'seed', note);
  assert.equal(saveNote(f.store, f.session.id, 'seed', note).id, saved.id);
  assert.throws(
    () => saveNote(f.store, f.session.id, 'seed', { ...note, body: 'changed' }),
    /different content/,
  );
  const before = buildContext(
    f.store,
    f.session,
    f.config.accounts[0]!,
    [],
    2000,
    20000,
    f.config.research,
  );
  f.store.exec(
    'UPDATE sessions SET remote_id=?,active_account=?,fingerprint=? WHERE id=?',
    'native',
    'a',
    before.fingerprint,
    f.session.id,
  );
  const after = buildContext(
    f.store,
    f.store.session(f.session.id),
    f.config.accounts[0]!,
    [],
    2000,
    20000,
    f.config.research,
  );
  assert.equal(after.resumeId, 'native');
  assert.match(before.instructions, /Seed 42/);
  assert.match(after.instructions, /Seed 42/);
  assert.doesNotMatch(after.prompt, /Seed 42/);
  assert.match(after.contextRefresh.snapshot.memory, /Seed 42/);
  assert.match(researchState(f.store, f.session.id), /Simulation/);
});
test('Slurm preflight checks declared inputs and never performs a real submission', async (t) => {
  const f = enabled(t);
  const calls: string[][] = [];
  const spec = batch(f);
  const cmd: Command = async (name, args) => {
    calls.push([name, ...args]);
    return 'ok';
  };
  assert.equal((await preflight(f.store, f.session.id, f.config.research, spec, cmd)).ok, true);
  assert.ok(calls.some((c) => c[0] === 'sbatch' && c.includes('--test-only')));
  assert.ok(!calls.some((c) => c.includes('--parsable')));
  calls.length = 0;
  assert.equal(
    (
      await preflight(
        f.store,
        f.session.id,
        f.config.research,
        { ...spec, inputs: ['missing.npy'] },
        cmd,
      )
    ).ok,
    false,
  );
  assert.ok(!calls.some((c) => c[0] === 'sbatch'));
});
test('preflight reads the script body for mistakes the scheduler accepts', async (t) => {
  const f = enabled(t);
  const spec = batch(f);
  const calls: string[][] = [];
  const cmd: Command = async (name, args) => {
    calls.push([name, ...args]);
    return 'ok';
  };
  fs.writeFileSync(
    spec.script,
    '#!/bin/bash\n#SBATCH --time=00:10:00\nmodule load python\n#SBATCH --mem=8G\nconda activate torch\npython train.py\n',
  );
  const report = await preflight(f.store, f.session.id, f.config.research, spec, cmd);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /Line 4: sbatch stops reading directives/);
  assert.match(report.errors.join('\n'), /Line 5: a batch shell is not interactive/);
  assert.match(report.warnings.join('\n'), /Line 6: the interpreter comes from PATH/);
  assert.ok(!calls.some((c) => c[0] === 'sbatch'));
  fs.writeFileSync(
    spec.script,
    '#!/bin/bash\n#SBATCH --time=00:10:00\n#SBATCH --mem=8G\nsource /opt/conda/etc/profile.d/conda.sh\nconda activate torch\n/opt/conda/envs/torch/bin/python train.py\n',
  );
  const clean = await preflight(f.store, f.session.id, f.config.research, spec, cmd);
  assert.deepEqual(clean.errors, []);
  assert.deepEqual(clean.warnings, []);
});
test('Slurm submission captures scripts, deduplicates concurrent calls and rejects changed keys', async (t) => {
  const f = enabled(t);
  const spec = batch(f);
  let submissions = 0;
  const cmd: Command = async (_name, args) => {
    if (args.includes('--parsable')) {
      submissions++;
      await delay(5);
      return '123;testcluster';
    }
    return '';
  };
  const [a, b] = await Promise.all([
    submitJob(f.store, f.session.id, f.config.research, 'one', spec, cmd),
    submitJob(f.store, f.session.id, f.config.research, 'one', spec, cmd),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(submissions, 1);
  assert.equal(f.store.get<any>('SELECT status FROM cluster_jobs').status, 'watching');
  assert.equal(fs.readFileSync(a.script_path, 'utf8'), fs.readFileSync(spec.script, 'utf8'));
  fs.appendFileSync(spec.script, '# changed');
  await assert.rejects(
    submitJob(f.store, f.session.id, f.config.research, 'one', spec, cmd),
    /different script/,
  );
});
test('Slurm submission stores follow-up watch settings where the monitor reads them', async (t) => {
  const f = enabled(t);
  const spec = batch(f);
  const cmd: Command = async (_name, args) => (args.includes('--parsable') ? '123' : '');
  const watch = { followup: 'Plot the loss curve', stallAfterMs: 60000, deadlineAt: 2e12 };
  const row = await submitJob(
    f.store,
    f.session.id,
    f.config.research,
    'watched',
    spec,
    cmd,
    undefined,
    watch,
  );
  const stored = JSON.parse(
    f.store.get<any>('SELECT preflight_json FROM cluster_jobs WHERE id=?', row.id).preflight_json,
  );
  assert.deepEqual(stored.watch, watch);
  assert.equal(stored.ok, true, 'the preflight report is kept alongside the watch');
  const again = await submitJob(
    f.store,
    f.session.id,
    f.config.research,
    'watched',
    spec,
    cmd,
    undefined,
    watch,
  );
  assert.equal(again.id, row.id);
});
test('a relative watch logPath is resolved against the session workspace for stall detection', async (t) => {
  const f = enabled(t);
  fs.mkdirSync(path.join(f.session.workspace, 'logs'));
  const log = path.join(f.session.workspace, 'logs', 'run.log');
  fs.writeFileSync(log, 'epoch 1');
  fs.utimesSync(log, 1, 1);
  const watch = { logPath: 'logs/run.log', stallAfterMs: 1000 };
  const row = watchJob(
    f.store,
    f.session.id,
    f.config.research,
    '123',
    undefined,
    undefined,
    watch,
  );
  assert.equal(JSON.parse(row.preflight_json).watch.logPath, log);
  const submitted = await submitJob(
    f.store,
    f.session.id,
    f.config.research,
    'relative-log',
    batch(f),
    async (_name, args) => (args.includes('--parsable') ? '124' : ''),
    undefined,
    watch,
  );
  assert.equal(JSON.parse(submitted.preflight_json).watch.logPath, log);
  const monitor = new ClusterMonitor(f.store, async (name) =>
    name === 'squeue' ? '123|RUNNING|sim' : '123|RUNNING|0:0|1:00|1M',
  );
  await monitor.poll(Date.now() + 100);
  const wakes = f.store.all<{ content: string }>('SELECT content FROM inbound');
  assert.ok(wakes.some((w) => w.content.includes(`${log} has not changed`)));
});
test('ambiguous Slurm acknowledgement is never retried and can be adopted after reconciliation', async (t) => {
  const f = enabled(t);
  const spec = batch(f);
  let submissions = 0;
  const cmd: Command = async (_name, args) => {
    if (args.includes('--parsable')) {
      submissions++;
      throw new Error('Connection lost after accepting job');
    }
    return '';
  };
  const row = await submitJob(f.store, f.session.id, f.config.research, 'uncertain', spec, cmd);
  assert.equal(row.status, 'unknown');
  assert.equal(
    (await submitJob(f.store, f.session.id, f.config.research, 'uncertain', spec, cmd)).status,
    'unknown',
  );
  assert.equal(submissions, 1);
  watchJob(f.store, f.session.id, f.config.research, '123', undefined, row.id);
  assert.equal(f.store.get<any>('SELECT job_id FROM cluster_jobs').job_id, '123');
  assert.equal(f.store.all("SELECT * FROM inbound WHERE kind='task'").length, 1);
});
test('Slurm restart marks in-flight submission unknown and preserves established watches', (t) => {
  const f = enabled(t);
  const row = watchJob(f.store, f.session.id, f.config.research, '123');
  f.store.exec("UPDATE cluster_jobs SET status='submitting' WHERE id=?", row.id);
  watchJob(f.store, f.session.id, f.config.research, '456');
  const monitor = new ClusterMonitor(f.store);
  monitor.recover();
  monitor.recover();
  assert.equal(
    f.store.get<any>('SELECT status FROM cluster_jobs WHERE id=?', row.id).status,
    'unknown',
  );
  assert.equal(
    f.store.get<any>("SELECT status FROM cluster_jobs WHERE job_id='456'").status,
    'watching',
  );
  assert.equal(f.store.all("SELECT * FROM inbound WHERE kind='task'").length, 1);
});
test('job monitor waits for queue disappearance and complete array accounting before waking once', async (t) => {
  const f = enabled(t);
  watchJob(f.store, f.session.id, f.config.research, '123');
  let running = true;
  const monitor = new ClusterMonitor(f.store, async (name) =>
    name === 'squeue'
      ? running
        ? '123_2|RUNNING|sim'
        : ''
      : '123_1|COMPLETED|0:0|00:01:00|100K\n123_1.batch|COMPLETED|0:0||100K\n123_2|COMPLETED|0:0|00:02:00|',
  );
  const now = Date.now() + 100;
  await monitor.poll(now);
  assert.equal(f.store.all('SELECT * FROM inbound').length, 0);
  running = false;
  await monitor.poll(now + f.config.research.slurm.pollMs);
  await monitor.poll(now + f.config.research.slurm.pollMs * 2);
  assert.equal(f.store.get<any>('SELECT status FROM cluster_jobs').status, 'completed');
  assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
});
test('accounting failure wakes the lead instead of posting a notice, and polling budgets stop with unconfirmed status', async (t) => {
  const f = enabled(t);
  f.config.research.slurm.maxChecks = 2;
  watchJob(f.store, f.session.id, f.config.research, '123');
  const monitor = new ClusterMonitor(f.store, async () => {
    throw new Error('Accounting unavailable');
  });
  await monitor.poll(Date.now() + 100);
  assert.equal(f.store.get<any>('SELECT status FROM cluster_jobs').status, 'watching');
  assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
  const wakes = f.store.all<{ id: string; content: string }>('SELECT * FROM inbound');
  assert.equal(wakes.length, 1);
  assert.match(wakes[0]!.id, /^research:/);
  assert.match(
    wakes[0]!.content,
    /Job monitor .* \(Slurm job 123\): Error: Accounting unavailable/,
  );
  assert.match(wakes[0]!.content, /This is not a terminal state/);
  await monitor.poll(Date.now() + f.config.research.slurm.pollMs + 200);
  assert.equal(f.store.get<any>('SELECT status FROM cluster_jobs').status, 'watch-stopped');
  assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
  assert.equal(f.store.all('SELECT * FROM inbound').length, 2);
});
test('a job invisible to this account on the first check stops the watch and wakes the lead once', async (t) => {
  const f = enabled(t);
  const row = watchJob(f.store, f.session.id, f.config.research, '123');
  assert.equal(row.checks, 0);
  const monitor = new ClusterMonitor(f.store, async () => '');
  await monitor.poll(Date.now() + 100);
  const after = f.store.get<any>('SELECT * FROM cluster_jobs');
  assert.equal(after.status, 'watch-stopped');
  assert.match(after.error, /not visible to this account/);
  assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
  const wakes = f.store.all<{ id: string; content: string }>('SELECT * FROM inbound');
  assert.equal(wakes.length, 1);
  assert.match(wakes[0]!.id, /^research:job:.*:not-visible$/);
  assert.match(
    wakes[0]!.content,
    /Slurm job 123 .* is not visible to this account: squeue and sacct both return nothing on the first check/,
  );
  assert.match(wakes[0]!.content, /runs as that user/);
  // Status is no longer 'watching', so a later poll call does not query this row again.
  await monitor.poll(Date.now() + f.config.research.slurm.pollMs + 200);
  assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
});
test('a job visible on the first check that later vanishes keeps polling with the old unconfirmed message', async (t) => {
  const f = enabled(t);
  watchJob(f.store, f.session.id, f.config.research, '123');
  let visible = true;
  const monitor = new ClusterMonitor(f.store, async (name) =>
    visible ? (name === 'squeue' ? '123|RUNNING|sim' : '123|RUNNING|0:0|1:00|1M') : '',
  );
  const now = Date.now() + 100;
  await monitor.poll(now);
  assert.equal(f.store.get<any>('SELECT status,checks FROM cluster_jobs').status, 'watching');
  assert.equal(f.store.get<any>('SELECT checks FROM cluster_jobs').checks, 1);
  visible = false;
  await monitor.poll(now + f.config.research.slurm.pollMs);
  const after = f.store.get<any>('SELECT * FROM cluster_jobs');
  // Row.checks was 1 (not the first check) when this job went invisible, so the watch keeps
  // polling with the pre-existing unconfirmed message instead of stopping.
  assert.equal(after.status, 'watching');
  assert.equal(after.error, 'Job absent from queue and accounting; completion is unconfirmed');
});
test('a failed monitor side effect backs off that row instead of rejecting every tick', async (t) => {
  const f = enabled(t);
  const row = watchJob(f.store, f.session.id, f.config.research, '123');
  // A regular file where the job directory belongs makes the observation write throw.
  fs.mkdirSync(path.join(f.home, 'research', 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'research', 'jobs', row.id), '');
  let queries = 0;
  const monitor = new ClusterMonitor(f.store, async (name) => {
    queries++;
    return name === 'squeue' ? '123|RUNNING|sim' : '123|RUNNING|0:0|1:00|1M';
  });
  const now = Date.now() + 100;
  await monitor.poll(now);
  assert.equal(queries, 2);
  const after = f.store.get<any>('SELECT * FROM cluster_jobs WHERE id=?', row.id);
  assert.ok(after.next_check >= now + f.config.research.slurm.pollMs);
  assert.equal(after.status, 'watching');
  await monitor.poll(now + 500);
  assert.equal(queries, 2, 'the failed row is not re-queried at tick rate');
  assert.equal(f.store.all("SELECT * FROM events WHERE type='cluster_monitor_error'").length, 1);
});
test('job monitor backs off in memory when SQLite cannot persist its failure', async (t) => {
  const f = enabled(t);
  const row = watchJob(f.store, f.session.id, f.config.research, '123');
  let queries = 0;
  const monitor = new ClusterMonitor(f.store, async (name) => {
    queries++;
    return name === 'squeue' ? '123|RUNNING|sim' : '123|RUNNING|0:0|1:00|1M';
  });
  const original = f.store.exec;
  f.store.exec = function (sql, ...args) {
    if (/cluster_jobs|metadata/.test(sql)) throw new Error('SQLITE_BUSY');
    return original.call(this, sql, ...args);
  };
  const now = Date.now() + 100;
  try {
    await monitor.poll(now);
    assert.equal(queries, 2);
    assert.ok(
      f.store.get<any>('SELECT next_check FROM cluster_jobs WHERE id=?', row.id).next_check < now,
    );
    await monitor.poll(now + 500);
    assert.equal(queries, 2, 'a failed database write cannot defeat the local backoff');
  } finally {
    f.store.exec = original;
  }
  await monitor.poll(now + f.config.research.slurm.pollMs + 1);
  assert.equal(queries, 4, 'polling resumes when the backoff expires');
  await monitor.stop();
});

for (const provider of ['claude', 'codex'] as const)
  test(`bounded ${provider} workers survive lead completion and wake it for synthesis`, async (t) => {
    const f = enabled(t);
    const keyName = `CLAWSTRUM_TEST_OPENALEX_${provider.toUpperCase()}`;
    process.env[keyName] = 'test-openalex-secret';
    t.after(() => delete process.env[keyName]);
    f.config.research.openalexKeyEnv = keyName;
    f.config.accounts = f.config.accounts.filter((a) => a.provider === provider);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let workerRequest: ProviderRequest | undefined;
    const adapter: Provider = {
      async run(r) {
        assert.equal(
          r.mcp.env[keyName],
          'test-openalex-secret',
          'lead and worker MCP get the configured literature credential',
        );
        assert.ok(!r.prompt.includes('test-openalex-secret'));
        assert.ok(!r.instructions.includes('test-openalex-secret'));
        if (r.mcp.env.CLAWSTRUM_DELEGATION) {
          workerRequest = r;
          await wait;
          r.onEvent({ type: 'usage', detail: { input_tokens: 100, output_tokens: 10 } });
          return 'Measured result. Evidence /tmp/output.csv';
        }
        return 'Work dispatched';
      },
    };
    f.enqueue('parent');
    const engine = new Engine(f.config, f.store, { claude: adapter, codex: adapter });
    const row = delegate(f.store, f.session.id, f.config, 'task', {
      role: 'explorer',
      brief: 'Read data',
      paths: ['/tmp/data'],
    });
    assert.equal(
      delegate(f.store, f.session.id, f.config, 'task', {
        role: 'explorer',
        brief: 'Read data',
        paths: ['/tmp/data'],
      }).id,
      row.id,
    );
    engine.tick();
    await settle(engine);
    assert.equal(engine.active.size, 0);
    assert.equal(engine.researchWorkers.active.size, 1);
    assert.equal(workerRequest!.sessionId, undefined);
    assert.ok(workerRequest!.cwd.endsWith(row.id));
    assert.equal(workerRequest!.maxTurns, undefined);
    release();
    await Promise.all([...engine.researchWorkers.active.values()].map((s) => s.promise));
    const done = f.store.get<any>('SELECT * FROM delegations');
    assert.equal(done.status, 'completed');
    assert.match(fs.readFileSync(done.result_path, 'utf8'), /Measured result/);
    assert.equal(f.store.all("SELECT * FROM inbound WHERE kind='task'").length, 1);
    assert.equal(
      f.store.all('SELECT * FROM outbox').length,
      1,
      'Worker does not post its own final answer',
    );
    await engine.stop();
  });
test('reconcileResult keeps a longer self-written RESULT.md and saves the final message to FINAL.md', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const resultPath = path.join(dir, 'RESULT.md');
  const longReport = 'A'.repeat(500);
  fs.writeFileSync(resultPath, longReport);
  const shortFinal = 'Done. Here is the short version.';
  const kept = reconcileResult(resultPath, shortFinal);
  assert.equal(kept.finalPath, path.join(dir, 'FINAL.md'));
  assert.equal(kept.selfWritten?.chars, longReport.length);
  assert.equal(fs.readFileSync(resultPath, 'utf8'), longReport, 'RESULT.md is left untouched');
  assert.equal(fs.readFileSync(kept.finalPath, 'utf8'), shortFinal + '\n');
});
test('reconcileResult writes the final message to RESULT.md when no self-written file exists', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const resultPath = path.join(dir, 'RESULT.md');
  const finalMessage = 'The run is done; see artifacts.';
  const kept = reconcileResult(resultPath, finalMessage);
  assert.equal(kept.finalPath, resultPath);
  assert.equal(kept.selfWritten, undefined);
  assert.equal(fs.readFileSync(resultPath, 'utf8'), finalMessage + '\n');
  assert.ok(!fs.existsSync(path.join(dir, 'FINAL.md')));
});
test('reconcileResult treats a RESULT.md that is just an earlier copy of the final message as unwritten', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const resultPath = path.join(dir, 'RESULT.md');
  const finalMessage = 'Same text, written once already with a trailing newline.';
  fs.writeFileSync(resultPath, finalMessage + '\n');
  const kept = reconcileResult(resultPath, finalMessage);
  assert.equal(kept.finalPath, resultPath, 'a copy of the final message is overwritten, not kept');
  assert.equal(kept.selfWritten, undefined);
});
test('a longer self-written RESULT.md survives worker completion, and the wake names both files', async (t) => {
  const f = enabled(t);
  const adapter: Provider = {
    async run(r) {
      if (r.mcp.env.CLAWSTRUM_DELEGATION) {
        fs.writeFileSync(path.join(r.cwd, 'RESULT.md'), 'A'.repeat(5000));
        return "Done. Here's the short version.";
      }
      return 'Work dispatched';
    },
  };
  f.enqueue('parent');
  const engine = new Engine(f.config, f.store, { claude: adapter, codex: adapter });
  delegate(f.store, f.session.id, f.config, 'task', { role: 'explorer', brief: 'Read data' });
  engine.tick();
  await settle(engine);
  await Promise.all([...engine.researchWorkers.active.values()].map((s) => s.promise));
  const done = f.store.get<any>('SELECT * FROM delegations');
  assert.equal(done.status, 'completed');
  assert.equal(
    fs.readFileSync(done.result_path, 'utf8'),
    'A'.repeat(5000),
    'RESULT.md keeps the longer self-written report',
  );
  const dir = path.dirname(done.result_path);
  const finalPath = path.join(dir, 'FINAL.md');
  assert.match(fs.readFileSync(finalPath, 'utf8'), /Done\. Here's the short version\./);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'REPORT.json'), 'utf8'));
  assert.equal(report.finalResult, done.result_path);
  assert.equal(report.finalMessage, finalPath);
  const wake = f.store.get<any>("SELECT content FROM inbound WHERE kind='task'").content;
  assert.match(
    wake,
    new RegExp(`${done.result_path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(5000 chars\\)`),
  );
  assert.match(
    wake,
    new RegExp(`${finalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(31 chars\\)`),
  );
  await engine.stop();
});
test('a role carries its declared skills into the worker and reports the ones it cannot find', async (t) => {
  const f = enabled(t);
  const install = (root: string, name: string, description: string, triggers: string) => {
    const dir = path.join(root, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\ntriggers: ${triggers}\n---\n`,
    );
  };
  install(f.home, 'theory', 'Derive and check analytically', 'derivation, scaling');
  install(f.session.workspace, 'plotting', 'Draw a figure', 'figure');
  install(f.home, 'unrelated', 'Installed but named by no role', 'derivation');
  f.config.research.workers.roles.analyst!.skills = ['theory', 'plotting', 'not-installed'];
  let workerRequest: ProviderRequest | undefined;
  const adapter: Provider = {
    async run(r) {
      if (r.mcp.env.CLAWSTRUM_DELEGATION) {
        workerRequest = r;
        return 'Derived the scaling. Evidence /tmp/out.txt';
      }
      return 'Dispatched';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: adapter, codex: adapter });
  delegate(f.store, f.session.id, f.config, 'task', {
    role: 'analyst',
    brief: 'Check the scaling of the derivation against the supplied data',
  });
  try {
    engine.tick();
    await Promise.all([...engine.researchWorkers.active.values()].map((s) => s.promise));
    const instructions = workerRequest!.instructions;
    assert.match(instructions, /Skills available to this role/);
    assert.match(instructions, /theory: Derive and check analytically/);
    assert.match(instructions, /plotting: Draw a figure/);
    assert.doesNotMatch(
      instructions,
      /unrelated/,
      'a worker is given its role, not the whole inventory the lead gets',
    );
    // The worker contract has to name where its result is truncated, because that boundary is the
    // one thing a worker cannot discover from inside the run.
    assert.match(instructions, /saved to RESULT\.md/);
    assert.match(instructions, /saved to FINAL\.md instead/);
    assert.match(
      instructions,
      new RegExp(`first ${f.config.research.workers.resultChars} characters`),
    );
    // Hints match the brief and go in the prompt, never the instructions, whose text decides
    // whether the provider is handed a refresh.
    assert.match(
      workerRequest!.prompt,
      /Skill `theory` was loaded for this turn by keyword match \(the skill router was off or did not answer; matched derivation, scaling\)/,
    );
    assert.doesNotMatch(instructions, /matched derivation/);
    const route = JSON.parse(
      f.store.get<any>("SELECT content FROM events WHERE type='research_worker_route'").content,
    );
    assert.deepEqual(route.skills, ['theory', 'plotting']);
    assert.deepEqual(
      route.skillsMissing,
      ['not-installed'],
      'a role naming an uninstalled skill is a configuration mismatch, not a failed dispatch',
    );
  } finally {
    await engine.stop();
  }
});
test("BRIEF.md carries the channel's goal entry and recent messages from both sides, excluding scheduled wakes and notices", async (t) => {
  const f = enabled(t);
  f.config.name = 'Rowan';
  f.config.research.workers.briefContext = {
    enabled: true,
    recentMessages: 40,
    messageChars: 1500,
    maxChars: 30000,
  };
  fs.writeFileSync(
    path.join(f.session.workspace, 'AGENTS.md'),
    [
      '# Agent',
      '',
      '## Instructions',
      '',
      'Follow the shared instructions.',
      '',
      '## MEMORY',
      '',
      '### Goal',
      '',
      'Reduce pipeline variance, stated by Alice.',
      '',
      '### Current work',
      '',
      'Nothing pending.',
      '',
    ].join('\n'),
  );
  const now = Date.now();
  f.store.enqueue({
    id: 'u1',
    sessionId: f.session.id,
    author: 'Alice',
    content: 'Keep each agent group on its own model.',
    at: now,
  });
  f.store.enqueue({
    id: 'sched1',
    sessionId: f.session.id,
    author: 'scheduler',
    content: 'SCHEDULED_WAKE_MARKER should not reach a subagent',
    kind: 'task',
    at: now + 10,
  });
  f.store.exec(
    "INSERT INTO outbox(id,dedupe_key,session_id,content,status,created_at,available_at,payload_hash,origin) VALUES('o1','k1',?,'Understood, each group stays on its model.','sent',?,?,'h','agent')",
    f.session.id,
    now + 20,
    now + 20,
  );
  f.store.exec(
    "INSERT INTO outbox(id,dedupe_key,session_id,content,status,created_at,available_at,payload_hash,origin) VALUES('o2','k2',?,'Clawstrum notice: a job failed','sent',?,?,'h','notice')",
    f.session.id,
    now + 30,
    now + 30,
  );
  let workerRequest: ProviderRequest | undefined;
  const adapter: Provider = {
    async run(r) {
      if (r.mcp.env.CLAWSTRUM_DELEGATION) {
        workerRequest = r;
        return 'Done';
      }
      return 'Dispatched';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: adapter, codex: adapter });
  delegate(f.store, f.session.id, f.config, 'task', {
    role: 'analyst',
    brief: 'Compare the two agent groups',
    context: 'This is a model comparison; each agent group must stay on its own model.',
  });
  engine.tick();
  await Promise.all([...engine.researchWorkers.active.values()].map((s) => s.promise));
  const dir = path.join(
    f.session.workspace,
    'research',
    'workers',
    f.store.get<any>('SELECT id FROM delegations').id,
  );
  const brief = fs.readFileSync(path.join(dir, 'BRIEF.md'), 'utf8');
  assert.match(brief, /Conversation context \(added by Clawstrum, verbatim\)/);
  assert.match(brief, /Reduce pipeline variance, stated by Alice\./);
  assert.match(brief, /Alice: Keep each agent group on its own model\./);
  assert.match(brief, /Rowan: Understood, each group stays on its model\./);
  assert.doesNotMatch(brief, /SCHEDULED_WAKE_MARKER/);
  assert.doesNotMatch(brief, /Clawstrum notice: a job failed/);
  assert.match(workerRequest!.prompt, /Conversation context \(added by Clawstrum, verbatim\)/);
});
test('the conversation-context section drops the oldest messages first past maxChars, and briefContext.enabled=false omits it entirely', async (t) => {
  const f = enabled(t);
  f.config.research.workers.briefContext = {
    enabled: true,
    recentMessages: 40,
    messageChars: 1500,
    maxChars: 520,
  };
  const now = Date.now();
  f.store.enqueue({
    id: 'old',
    sessionId: f.session.id,
    author: 'Alice',
    content: 'OLDEST_MESSAGE_MARKER '.repeat(10),
    at: now,
  });
  f.store.enqueue({
    id: 'new',
    sessionId: f.session.id,
    author: 'Alice',
    content: 'NEWEST_MESSAGE_MARKER '.repeat(10),
    at: now + 1000,
  });
  const adapter: Provider = {
    async run(r) {
      return r.mcp.env.CLAWSTRUM_DELEGATION ? 'Done' : 'Dispatched';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: adapter, codex: adapter });
  delegate(f.store, f.session.id, f.config, 'capped', {
    role: 'analyst',
    brief: 'Summarize',
    context: 'Verify the maxChars cap drops the oldest message first.',
  });
  engine.tick();
  await Promise.all([...engine.researchWorkers.active.values()].map((s) => s.promise));
  const row = f.store.get<any>("SELECT id FROM delegations WHERE dedupe_key LIKE '%:capped'");
  const dir = path.join(f.session.workspace, 'research', 'workers', row.id);
  const brief = fs.readFileSync(path.join(dir, 'BRIEF.md'), 'utf8');
  assert.match(brief, /NEWEST_MESSAGE_MARKER/);
  assert.doesNotMatch(brief, /OLDEST_MESSAGE_MARKER/);

  const g = enabled(t);
  g.config.research.workers.briefContext = {
    enabled: false,
    recentMessages: 40,
    messageChars: 1500,
    maxChars: 30000,
  };
  g.store.enqueue({
    id: 'u2',
    sessionId: g.session.id,
    author: 'Alice',
    content: 'hello',
    at: now,
  });
  const engine2 = new Engine(g.config, g.store, { claude: adapter, codex: adapter });
  delegate(g.store, g.session.id, g.config, 'off', {
    role: 'analyst',
    brief: 'Summarize',
    context: 'Verify briefContext.enabled=false omits the section entirely.',
  });
  engine2.tick();
  await Promise.all([...engine2.researchWorkers.active.values()].map((s) => s.promise));
  const offRow = g.store.get<any>("SELECT id FROM delegations WHERE dedupe_key LIKE '%:off'");
  const offDir = path.join(g.session.workspace, 'research', 'workers', offRow.id);
  const offBrief = fs.readFileSync(path.join(offDir, 'BRIEF.md'), 'utf8');
  assert.doesNotMatch(offBrief, /Conversation context \(added by Clawstrum, verbatim\)/);
});
test('research_delegate refuses a missing or too-short context, and requireContext=false allows it', async (t) => {
  const f = enabled(t);
  // enabled() turns requireContext off so unrelated tests do not need a context; this test is the
  // one that exercises the default, so it turns the default (true) back on explicitly.
  f.config.research.workers.requireContext = true;
  const ctx = { store: f.store, config: f.config, sessionId: f.session.id, scope: 'test' };
  await assert.rejects(
    researchTool('research_delegate', { key: 'k1', role: 'analyst', brief: 'x' }, ctx),
    /context is required/,
  );
  await assert.rejects(
    researchTool(
      'research_delegate',
      { key: 'k2', role: 'analyst', brief: 'x', context: 'too short' },
      ctx,
    ),
    /context is required/,
  );
  const row: any = await researchTool(
    'research_delegate',
    {
      key: 'k3',
      role: 'analyst',
      brief: 'x',
      context: 'This is a model comparison; each agent group must stay on its own model.',
    },
    ctx,
  );
  assert.ok(row.id);
  f.config.research.workers.requireContext = false;
  const bare: any = await researchTool(
    'research_delegate',
    { key: 'k4', role: 'analyst', brief: 'x' },
    ctx,
  );
  assert.ok(bare.id);
});
test('main turns and workers share credential capacity and cancelled workers do not wake the lead', async (t) => {
  const f = enabled(t);
  f.config.accounts = [f.config.accounts[0]!];
  f.config.accounts[0]!.maxConcurrent = 1;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter: Provider = {
    async run(r) {
      if (r.mcp.env.CLAWSTRUM_DELEGATION)
        return new Promise((_, reject) =>
          r.controller.signal.addEventListener('abort', () => reject(r.controller.signal.reason), {
            once: true,
          }),
        );
      await waiting;
      return 'Lead done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: adapter, codex: adapter });
  f.enqueue('lead');
  delegate(f.store, f.session.id, f.config, 'worker', { role: 'coder', brief: 'bounded' });
  engine.tick();
  assert.equal(engine.researchWorkers.active.size, 0);
  release();
  await settle(engine);
  engine.tick();
  assert.equal(engine.researchWorkers.active.size, 1);
  engine.researchWorkers.cancel(f.session.id);
  await Promise.all([...engine.researchWorkers.active.values()].map((s) => s.promise));
  assert.equal(f.store.get<any>('SELECT status FROM delegations').status, 'cancelled');
  assert.equal(f.store.all("SELECT * FROM inbound WHERE kind='task'").length, 0);
  await engine.stop();
});
test('a subagent queued for a provider with no configured account wakes the lead instead of posting a notice', (t) => {
  const f = enabled(t);
  const row = delegate(f.store, f.session.id, f.config, 'worker', {
    role: 'coder',
    brief: 'bounded',
    provider: 'codex',
  });
  // The codex account existed when delegate() validated it; remove it before this tick builds the
  // pool, as if the account had been dropped from config between delegation and this tick.
  f.config.accounts = f.config.accounts.filter((a) => a.provider !== 'codex');
  const engine = new Engine(f.config, f.store, { claude: ok, codex: ok });
  engine.researchWorkers.tick();
  assert.equal(
    f.store.get<any>('SELECT status FROM delegations WHERE id=?', row.id).status,
    'queued',
  );
  assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
  const wakes = f.store.all<{ id: string; content: string }>('SELECT * FROM inbound');
  assert.equal(wakes.length, 1);
  assert.match(wakes[0]!.id, /^research:research-capacity:/);
  assert.match(wakes[0]!.content, new RegExp(`Research subagent ${row.id} is queued for codex`));
  assert.match(wakes[0]!.content, /no eligible account is available/);
});
test('recovery exposes interrupted worker artifacts without replaying edits', (t) => {
  const f = enabled(t);
  const row = delegate(f.store, f.session.id, f.config, 'worker', {
    role: 'coder',
    brief: 'bounded',
  });
  f.store.exec("UPDATE delegations SET status='running' WHERE id=?", row.id);
  const engine = new Engine(f.config, f.store, { claude: ok, codex: ok });
  engine.start();
  engine.researchWorkers.recover();
  assert.equal(f.store.get<any>('SELECT status FROM delegations').status, 'failed');
  assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
});
test('background input remains open through results until the full live task set is empty', async () => {
  const input = new BackgroundInput('work', 0);
  const iterator = input[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  let ended = false;
  const pending = iterator.next().then(() => {
    ended = true;
  });
  input.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'one' }, { task_id: 'two' }],
  });
  input.observe({ type: 'result' });
  await delay(2);
  assert.equal(ended, false);
  input.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'one',
    status: 'completed',
  });
  await delay(2);
  assert.equal(ended, false);
  input.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  await pending;
  assert.equal(ended, true);
});
test('Claude integration configures advisory hooks, archives compaction and holds background SDK input', async (t) => {
  const f = enabled(t);
  const transcript = path.join(f.home, 'native.jsonl');
  fs.writeFileSync(transcript, '{"evidence":"full transcript"}\n');
  let options: any;
  let inputEnded = false;
  const query = ((params: any) => {
    options = params.options;
    const generator = (async function* () {
      const iterator = params.prompt[Symbol.asyncIterator]();
      await iterator.next();
      const done = iterator.next().then(() => {
        inputEnded = true;
      });
      yield { type: 'system', subtype: 'task_started', task_id: 'bg', is_backgrounded: true };
      yield { type: 'result', subtype: 'success', result: 'Initial answer', usage: {} };
      await delay(2);
      assert.equal(inputEnded, false);
      yield { type: 'system', subtype: 'task_notification', task_id: 'bg', status: 'completed' };
      await done;
    })();
    return Object.assign(generator, { close() {} });
  }) as any;
  const request: ProviderRequest = {
    account: f.config.accounts[0]!,
    cwd: f.session.workspace,
    prompt: 'research',
    instructions: '',
    controller: new AbortController(),
    env: {},
    research: f.config.research,
    inputReleaseGraceMs: 0,
    mcp: {
      command: 'node',
      args: [],
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id },
    },
    onEvent() {},
  };
  const research = researchHooks(request),
    compaction = compactionHooks(request);
  const hooks = {
    hooks: mergeHooks(research.hooks, compaction.hooks),
    close() {
      research.close();
      compaction.close();
    },
  };
  try {
    const pre = hooks.hooks!.PreToolUse![0]!.hooks[0]!;
    const output: any = await pre(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sdk',
        transcript_path: transcript,
        cwd: f.session.workspace,
        tool_use_id: 'tool',
        tool_name: 'Write',
        tool_input: { file_path: 'paper.md', content: 'doi:10.1234/example' },
      },
      undefined,
      { signal: request.controller.signal },
    );
    assert.match(output.systemMessage, /advisory/);
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
    const compact = hooks.hooks!.PreCompact![0]!.hooks[0]!;
    const archived: any = await compact(
      {
        hook_event_name: 'PreCompact',
        session_id: 'sdk',
        transcript_path: transcript,
        cwd: f.session.workspace,
        trigger: 'auto',
        custom_instructions: null,
      },
      undefined,
      { signal: request.controller.signal },
    );
    // Restoration uses supported SessionStart context, without a speculative summarizer channel.
    assert.equal(archived.systemMessage, undefined);
    saveNote(f.store, f.session.id, 'compact-evidence', {
      kind: 'method',
      title: 'Compaction evidence',
      body: 'Retain the verified seed 42',
    });
    const restored: any = await hooks.hooks!.SessionStart![0]!.hooks[0]!(
      {
        hook_event_name: 'SessionStart',
        session_id: 'sdk',
        transcript_path: transcript,
        cwd: f.session.workspace,
        source: 'compact',
      },
      undefined,
      { signal: request.controller.signal },
    );
    assert.match(restored.hookSpecificOutput.additionalContext, /verified seed 42/);
    assert.equal(restored.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(restored.hookSpecificOutput.additionalContext, /^CLAWSTRUM_CONTEXT_UPDATE/);
    assert.doesNotMatch(restored.hookSpecificOutput.additionalContext, /full transcript/);
    const event = f.store.get<any>(
      "SELECT content FROM history_records WHERE kind='native_transcript'",
    );
    assert.equal(event.content, fs.readFileSync(transcript, 'utf8'));
  } finally {
    hooks.close();
  }
  assert.equal(await createClaudeProvider(query).run(request), 'Initial answer');
  assert.equal(inputEnded, true);
  assert.equal(options.permissionMode, 'bypassPermissions');
  assert.equal(options.sandbox.enabled, false);
});
test('strict hooks return the SDK permission reason and command recognition avoids prose mentions', async (t) => {
  const f = enabled(t);
  f.config.research.validation = 'strict';
  assert.equal(invokesSbatch('echo sbatch job.sh'), false);
  assert.equal(invokesSbatch("echo 'sbatch job.sh'"), false);
  assert.equal(invokesSbatch('cd /tmp && /usr/bin/sbatch job.sh'), true);
  const r: ProviderRequest = {
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
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id },
    },
    onEvent() {},
  };
  const hooks = researchHooks(r);
  try {
    const output: any = await hooks.hooks!.PreToolUse![0]!.hooks[0]!(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sdk',
        transcript_path: '',
        cwd: f.session.workspace,
        tool_use_id: 'id',
        tool_name: 'Bash',
        tool_input: { command: 'sbatch job.sh' },
      },
      undefined,
      { signal: r.controller.signal },
    );
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /research_cluster/);
  } finally {
    hooks.close();
  }
});
test('writes outside the permitted roots are denied every time, not once per run', async (t) => {
  const f = enabled(t);
  f.config.research.validation = 'strict';
  f.config.research.writeRoots = [path.join(f.home, 'shared')];
  const r: ProviderRequest = {
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
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id },
    },
    onEvent() {},
  };
  const hooks = researchHooks(r);
  const write = (file_path: string) =>
    hooks.hooks!.PreToolUse![0]!.hooks[0]!(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sdk',
        transcript_path: '',
        cwd: f.session.workspace,
        tool_use_id: 'id',
        tool_name: 'Write',
        tool_input: { file_path, content: 'A summary with no citations.' },
      },
      undefined,
      { signal: r.controller.signal },
    ) as Promise<any>;
  try {
    const outside = path.join(path.sep, 'clawstrum-elsewhere', 'notes.md');
    for (const attempt of [1, 2]) {
      const output = await write(outside);
      assert.equal(
        output.hookSpecificOutput.permissionDecision,
        'deny',
        `attempt ${attempt} was allowed`,
      );
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /outside every permitted/);
    }
    for (const allowed of [
      path.join(f.session.workspace, 'notes.md'),
      path.join(f.home, 'research', 'notes.md'),
      path.join(f.home, 'shared', 'notes.md'),
      path.join(os.tmpdir(), 'scratch.md'),
      'relative.md',
    ])
      assert.deepEqual(await write(allowed), {}, allowed);
  } finally {
    hooks.close();
  }
});
test('a symlink out of a permitted root does not carry the write past the gate', async (t) => {
  const f = enabled(t);
  f.config.research.validation = 'strict';
  f.config.research.writeRoots = [path.join(f.home, 'shared')];
  fs.mkdirSync(path.join(f.home, 'shared'), { recursive: true });
  // Lexically inside both the home and the configured root; actually a path no root covers.
  // Dangling on purpose, because creating the file is the write being judged.
  fs.symlinkSync(path.join(path.sep, 'clawstrum-elsewhere'), path.join(f.home, 'shared', 'escape'));
  const r: ProviderRequest = {
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
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id },
    },
    onEvent() {},
  };
  const hooks = researchHooks(r);
  try {
    const output = (await hooks.hooks!.PreToolUse![0]!.hooks[0]!(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sdk',
        transcript_path: '',
        cwd: f.session.workspace,
        tool_use_id: 'id',
        tool_name: 'Write',
        tool_input: {
          file_path: path.join(f.home, 'shared', 'escape', 'notes.md'),
          content: 'A summary with no citations.',
        },
      },
      undefined,
      { signal: r.controller.signal },
    )) as any;
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /outside every permitted/);
  } finally {
    hooks.close();
  }
});
test('compaction hook works without research and restores complete current memory', async (t) => {
  const f = enabled(t);
  f.config.research.enabled = false;
  const r: ProviderRequest = {
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
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id },
    },
    onEvent() {},
  };
  const hooks = compactionHooks(r);
  try {
    const fact = 'A'.repeat(20000) + 'MIDDLE_FACT' + 'Z'.repeat(20000);
    updateMemory(f.store, f.session.id, { 'Current work': fact });
    const result: any = await hooks.hooks!.SessionStart![0]!.hooks[0]!(
      {
        hook_event_name: 'SessionStart',
        session_id: 'sdk',
        transcript_path: '',
        cwd: f.session.workspace,
        source: 'compact',
      },
      undefined,
      { signal: r.controller.signal },
    );
    const output = result.hookSpecificOutput.additionalContext;
    assert.ok(Buffer.byteLength(output) < 12000);
    const file = /complete replacement context is in (.+?) \(SHA-256/.exec(output)![1]!;
    assert.ok(fs.readFileSync(file, 'utf8').includes(fact));
    assert.doesNotMatch(
      result.hookSpecificOutput.additionalContext,
      /Unmaintained|STATE AS IT STOOD/,
    );
  } finally {
    hooks.close();
  }
});
test('memory writes have no implicit prompt-size denial, including strict research mode', async (t) => {
  const f = enabled(t);
  f.config.research.validation = 'strict';
  const r: ProviderRequest = {
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
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id },
    },
    onEvent() {},
  };
  const hooks = researchHooks(r);
  try {
    const result: any = await hooks.hooks!.PreToolUse![0]!.hooks[0]!(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sdk',
        transcript_path: '',
        cwd: f.session.workspace,
        tool_use_id: 'write',
        tool_name: 'Write',
        tool_input: {
          file_path: path.join(f.session.workspace, 'AGENTS.md'),
          content: 'Durable fact. '.repeat(5000),
        },
      },
      undefined,
      { signal: r.controller.signal },
    );
    assert.notEqual(result.hookSpecificOutput?.permissionDecision, 'deny');
  } finally {
    hooks.close();
  }
});
test('host notice provenance is explicit while normal assistant messages keep their text', (t) => {
  const f = fixture(t);
  const id = f.store.outbox(f.session.id, 'Job failed');
  const row = f.store.get<any>('SELECT * FROM outbox WHERE id=?', id);
  assert.match(deliveryPayloads(row)[0]!.content, /Clawstrum notice/);
  assert.equal(deliveryPayloads({ ...row, origin: 'agent' })[0]!.content, 'Job failed');
});
test('real MCP exposes research tools to a lead and restricts worker reply ownership after parent completion', async (t) => {
  const f = enabled(t);
  f.enqueue('lead');
  const run = f.store.claim(f.session.id)!.run;
  f.store.exec('UPDATE runs SET config_json=? WHERE id=?', JSON.stringify(f.config), run.id);
  const connect = async (env: Record<string, string>) => {
    const client = new Client({ name: 'research-test', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', path.resolve('src/cli.ts'), 'mcp'],
        env: {
          PATH: process.env.PATH!,
          CLAWSTRUM_HOME: f.home,
          CLAWSTRUM_SESSION: f.session.id,
          ...env,
        },
        stderr: 'pipe',
      }),
    );
    return client;
  };
  const lead = await connect({ CLAWSTRUM_RUN: run.id });
  let workerId: string;
  try {
    assert.ok(
      (await lead.listTools()).tools.some((tool) => tool.name === 'research_worker_review'),
    );
    assert.ok(
      !(await lead.listTools()).tools.some((tool) => tool.name === 'research_worker_update'),
    );
    assert.ok((await lead.listTools()).tools.some((tool) => tool.name === 'research_manifest'));
    const review = await lead.callTool({
      name: 'memory_review',
      arguments: { action: 'request', reason: 'The user corrected the experimental setup' },
    });
    assert.ok(!review.isError);
    assert.equal(JSON.parse((review.content as any)[0].text).enabled, true);
    assert.ok(
      f.store.get(
        "SELECT id FROM history_records WHERE kind='memory_review_request' AND session_id=?",
        f.session.id,
      ),
    );
    assert.ok((await lead.listTools()).tools.some((tool) => tool.name === 'group_board'));
    const result = await lead.callTool({
      name: 'research_delegate',
      arguments: {
        role: 'analyst',
        brief: 'Check variance',
        key: 'one',
        context: 'Test tool-dispatch delegation; no real constraint to carry forward.',
      },
    });
    assert.ok(!result.isError);
    workerId = JSON.parse((result.content as any)[0].text).id;
    const note = await lead.callTool({
      name: 'research_note',
      arguments: {
        kind: 'finding',
        title: 'Variance',
        body: 'Pending confirmation',
        key: 'finding',
      },
    });
    assert.ok(!note.isError);
  } finally {
    await lead.close();
  }
  f.store.finish(run, 'done');
  f.store.exec("UPDATE delegations SET status='running' WHERE id=?", workerId!);
  const worker = await connect({ CLAWSTRUM_DELEGATION: workerId! });
  try {
    const names = (await worker.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('research_worker_update'));
    assert.ok(!names.includes('research_worker_review'));
    assert.ok(names.includes('research_manifest'));
    assert.ok(!names.includes('send_message'));
    assert.ok(!names.includes('research_delegate'));
    assert.ok(
      !(await worker.callTool({ name: 'research_status', arguments: { collection: 'notes' } }))
        .isError,
    );
    const profile = await worker.callTool({
      name: 'research_status',
      arguments: { collection: 'usage-profile', since: '2026-01-15T09:00:00-05:00' },
    });
    assert.ok(!profile.isError, (profile.content as any)[0].text);
    let report = JSON.parse((profile.content as any)[0].text);
    // Results over 12000 characters come back as a pointer to an artifact file.
    if (report.artifactPath) report = JSON.parse(fs.readFileSync(report.artifactPath, 'utf8'));
    const range = report.range;
    assert.ok(range, JSON.stringify(report).slice(0, 500));
    assert.match(range.since, /^2026-01-1[56]T\d\d:\d\d:00[+-]\d\d:\d\d$/);
    assert.equal(Date.parse(range.since), Date.UTC(2026, 0, 15, 14));
    f.store.exec("UPDATE delegations SET status='cancelled' WHERE id=?", workerId!);
    assert.equal(
      (await worker.callTool({ name: 'research_status', arguments: { collection: 'notes' } }))
        .isError,
      true,
    );
  } finally {
    await worker.close();
  }
});
test('research_subagent_* tool names are advertised over MCP and research_worker_* keeps working as an alias', async (t) => {
  const f = enabled(t);
  f.enqueue('lead');
  const run = f.store.claim(f.session.id)!.run;
  f.store.exec('UPDATE runs SET config_json=? WHERE id=?', JSON.stringify(f.config), run.id);
  const connect = async (env: Record<string, string>) => {
    const client = new Client({ name: 'research-test', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', path.resolve('src/cli.ts'), 'mcp'],
        env: {
          PATH: process.env.PATH!,
          CLAWSTRUM_HOME: f.home,
          CLAWSTRUM_SESSION: f.session.id,
          ...env,
        },
        stderr: 'pipe',
      }),
    );
    return client;
  };
  const lead = await connect({ CLAWSTRUM_RUN: run.id });
  let workerId: string;
  try {
    const leadNames = (await lead.listTools()).tools.map((tool) => tool.name);
    assert.ok(leadNames.includes('research_subagent_review'));
    assert.ok(leadNames.includes('research_subagent_advice'));
    assert.ok(leadNames.includes('research_worker_review'), 'old name still advertised as alias');
    assert.ok(
      !leadNames.includes('research_subagent_update'),
      'lead-only tools exclude the update tool under either name',
    );
    assert.ok(!leadNames.includes('research_worker_update'));
    const result = await lead.callTool({
      name: 'research_delegate',
      arguments: {
        role: 'analyst',
        brief: 'Check variance',
        key: 'alias-test',
        context: 'Test tool-dispatch delegation; no real constraint to carry forward.',
      },
    });
    assert.ok(!result.isError);
    workerId = JSON.parse((result.content as any)[0].text).id;
  } finally {
    await lead.close();
  }
  f.store.exec("UPDATE delegations SET status='running' WHERE id=?", workerId!);
  const worker = await connect({ CLAWSTRUM_DELEGATION: workerId! });
  try {
    const workerNames = (await worker.listTools()).tools.map((tool) => tool.name);
    assert.ok(workerNames.includes('research_subagent_update'));
    assert.ok(workerNames.includes('research_worker_update'), 'old name still advertised as alias');
    assert.ok(!workerNames.includes('research_subagent_review'));
    // New and old update tool names must reach the identical delegation.
    const viaNewName = await worker.callTool({
      name: 'research_subagent_update',
      arguments: { state: 'working', summary: 'via new name' },
    });
    assert.ok(!viaNewName.isError);
    const viaOldName = await worker.callTool({
      name: 'research_worker_update',
      arguments: { state: 'working', summary: 'via old name' },
    });
    assert.ok(!viaOldName.isError);
    assert.equal(workerProfile(f.store, workerId!)!.progress!.summary, 'via old name');
    // research_status collection=subagents is the same data as collection=workers.
    const viaSubagents = await worker.callTool({
      name: 'research_status',
      arguments: { collection: 'subagents', id: workerId! },
    });
    const viaWorkers = await worker.callTool({
      name: 'research_status',
      arguments: { collection: 'workers', id: workerId! },
    });
    assert.ok(!viaSubagents.isError && !viaWorkers.isError);
    assert.deepEqual(
      JSON.parse((viaSubagents.content as any)[0].text),
      JSON.parse((viaWorkers.content as any)[0].text),
    );
  } finally {
    await worker.close();
  }
});
test('research status scopes job/worker operations to the originating conversation', async (t) => {
  const f = enabled(t);
  const other = f.store.ensureSession('111111');
  const row = delegate(f.store, other.id, f.config, 'one', {
    role: 'coder',
    brief: 'Other channel',
  });
  const ctx = { store: f.store, config: f.config, sessionId: f.session.id, scope: 'test' };
  assert.deepEqual(
    await researchTool(
      'research_status',
      { collection: 'workers', id: row.id, cancelWorker: true },
      ctx,
    ),
    [],
  );
  assert.equal(
    f.store.get<any>('SELECT status FROM delegations WHERE id=?', row.id).status,
    'queued',
  );
});

test('finished Slurm jobs tolerate invalid-job squeue responses and keep step memory evidence', async (t) => {
  const f = enabled(t);
  watchJob(f.store, f.session.id, f.config.research, '123');
  const monitor = new ClusterMonitor(f.store, async (name) => {
    if (name === 'squeue') throw new Error('slurm_load_jobs error: Invalid job id specified');
    return '123|COMPLETED|0:0|00:01:00|\n123.batch|COMPLETED|0:0|00:01:00|12345K';
  });
  await monitor.poll(Date.now() + 100);
  const row = f.store.get<any>('SELECT * FROM cluster_jobs');
  assert.equal(row.status, 'completed');
  assert.match(row.observation_json, /12345K/);
});
test('submitted arrays remain unconfirmed until all declared indices have accounting records', async (t) => {
  const f = enabled(t);
  const spec = { ...batch(f), resources: { array: '0-2' } };
  await submitJob(f.store, f.session.id, f.config.research, 'array', spec, async (_cmd, args) =>
    args.includes('--parsable') ? '123' : '',
  );
  let complete = false;
  const monitor = new ClusterMonitor(f.store, async (name) =>
    name === 'squeue'
      ? ''
      : `123_0|COMPLETED|0:0||\n123_1|COMPLETED|0:0||${complete ? '\n123_2|FAILED|1:0||' : ''}`,
  );
  const now = Date.now() + 100;
  await monitor.poll(now);
  assert.equal(f.store.get<any>('SELECT status FROM cluster_jobs').status, 'watching');
  complete = true;
  await monitor.poll(now + f.config.research.slurm.pollMs);
  assert.equal(f.store.get<any>('SELECT status FROM cluster_jobs').status, 'failed');
});
test('an array whose unstarted tasks were cancelled completes even when squeue fails', async (t) => {
  // Real sacct output from 2026-10-16: tasks 7-39 were cancelled before starting and show as one
  // range row; squeue on the finished array failed with an empty message.
  const f = enabled(t);
  const spec = { ...batch(f), resources: { array: '0-39%4' } };
  await submitJob(f.store, f.session.id, f.config.research, 'array', spec, async (_cmd, args) =>
    args.includes('--parsable') ? '123' : '',
  );
  const done = Array.from({ length: 7 }, (_, i) => `123_${i}|COMPLETED|0:0|00:00:01|`).join('\n');
  const monitor = new ClusterMonitor(f.store, async (name) => {
    if (name === 'squeue') throw new Error('Command failed: squeue --jobs=123');
    return `${done}\n123_[7-39%4]|CANCELLED by 1000|0:0|00:00:00|`;
  });
  await monitor.poll(Date.now() + 100);
  assert.equal(f.store.get<any>('SELECT status FROM cluster_jobs').status, 'failed');
  assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
  assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
});
test('a failed squeue on a running job is not an error notice', async (t) => {
  const f = enabled(t);
  watchJob(f.store, f.session.id, f.config.research, '123');
  const monitor = new ClusterMonitor(f.store, async (name) => {
    if (name === 'squeue') throw new Error('Command failed: squeue --jobs=123');
    return '123|RUNNING|0:0|1:00|1M';
  });
  const now = Date.now() + 100;
  await monitor.poll(now);
  await monitor.poll(now + f.config.research.slurm.pollMs);
  assert.equal(f.store.get<any>('SELECT status FROM cluster_jobs').status, 'watching');
  assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
});
test('a queued job is not an error when the accounting database is down', async (t) => {
  const f = enabled(t);
  watchJob(f.store, f.session.id, f.config.research, '123');
  const monitor = new ClusterMonitor(f.store, async (name) => {
    if (name === 'squeue') return '123|PENDING|sim';
    throw new Error(
      'Command failed: sacct ... Problem talking to the database: Connection refused',
    );
  });
  await monitor.poll(Date.now() + 100);
  const row = f.store.get<any>('SELECT status,error FROM cluster_jobs');
  assert.equal(row.status, 'watching');
  assert.equal(row.error, null);
  assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
});
test('empty research worker output is a visible failure with artifacts, not an empty success', async (t) => {
  const f = enabled(t);
  const empty: Provider = {
    async run() {
      return '';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: empty, codex: empty });
  delegate(f.store, f.session.id, f.config, 'empty', { role: 'explorer', brief: 'Inspect' });
  engine.researchWorkers.tick();
  await Promise.all([...engine.researchWorkers.active.values()].map((s) => s.promise));
  const row = f.store.get<any>('SELECT * FROM delegations');
  assert.equal(row.status, 'failed');
  assert.match(fs.readFileSync(row.result_path, 'utf8'), /without a result/);
  assert.equal(f.store.all('SELECT * FROM inbound').length, 1);
  await engine.stop();
});
test('background input releases on abort and an empty notification result cannot erase an answer', async (t) => {
  const f = enabled(t);
  const input = new BackgroundInput('task');
  const iterator = input[Symbol.asyncIterator]();
  await iterator.next();
  const next = iterator.next();
  input.close();
  assert.equal((await next).done, true);
  const query = (() =>
    Object.assign(
      (async function* () {
        yield { type: 'result', subtype: 'success', result: 'Answer', usage: {} };
        yield { type: 'result', subtype: 'success', result: '', usage: {} };
      })(),
      { close() {} },
    )) as any;
  const answer = await createClaudeProvider(query).run({
    account: f.config.accounts[0]!,
    cwd: f.session.workspace,
    prompt: 'test',
    instructions: '',
    controller: new AbortController(),
    env: {},
    research: f.config.research,
    mcp: { command: 'node', args: [], env: {} },
    onEvent() {},
  });
  assert.equal(answer, 'Answer');
});
test('shared memory is not silently shortened to the retired file budget', (t) => {
  const f = fixture(t);
  buildContext(f.store, f.session, f.config.accounts[0]!, [], 2000);
  const fact = 'shared '.repeat(2000) + 'END_SHARED_FACT';
  updateMemory(f.store, null, { 'Working understanding': fact });
  const context = buildContext(f.store, f.session, f.config.accounts[0]!, [], 2000);
  assert.ok(context.instructions.includes(fact));
});

test(
  'installed Claude SDK transports research hook callbacks and holds actual subprocess stdin',
  { timeout: 20000 },
  async (t) => {
    const f = enabled(t);
    const executable = path.join(f.home, 'claude-research.mjs');
    const record = path.join(f.home, 'protocol.json');
    fs.writeFileSync(
      executable,
      `import fs from 'node:fs'; import {createInterface} from 'node:readline';
    const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let hooks;let closed=false;let hookResult;let restoreResult;
    process.stdin.on('end',()=>{closed=true;});
    for await(const line of createInterface({input:process.stdin})) {
      const m=JSON.parse(line);
      if(m.type==='control_request') {hooks=m.request.hooks??hooks;send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],models:[],account:null}}});}
      if(m.type==='user') {
        send({type:'system',subtype:'init',session_id:'native',tools:[],mcp_servers:[],model:'test',permissionMode:'bypassPermissions',apiKeySource:'none',cwd:process.cwd(),uuid:'init'});
        send({type:'control_request',request_id:'research-restore',request:{subtype:'hook_callback',callback_id:hooks.SessionStart[0].hookCallbackIds[0],input:{hook_event_name:'SessionStart',session_id:'native',cwd:process.cwd(),transcript_path:'',source:'compact'}}});
      }
      if(m.type==='control_response'&&m.response.request_id==='research-restore') { restoreResult=m.response;
        send({type:'control_request',request_id:'research-hook',request:{subtype:'hook_callback',callback_id:hooks.PreToolUse[0].hookCallbackIds[0],tool_use_id:'tool',input:{hook_event_name:'PreToolUse',session_id:'native',cwd:process.cwd(),transcript_path:'',tool_use_id:'tool',tool_name:'WebFetch',tool_input:{url:'https://arxiv.org/pdf/2401.12345'}}}});
      }
      if(m.type==='control_response'&&m.response.request_id==='research-hook') {
        hookResult=m.response;
        send({type:'system',subtype:'task_started',task_id:'background',is_backgrounded:true,description:'read',uuid:'task',session_id:'native'});
        send({type:'result',subtype:'success',result:'BACKGROUND_OK',is_error:false,session_id:'native',uuid:'result',duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{},modelUsage:{},permission_denials:[]});
        setTimeout(()=>{fs.writeFileSync(process.env.RECORD,JSON.stringify({closedBeforeCompletion:closed,hookResult,restoreResult}));send({type:'system',subtype:'task_notification',task_id:'background',status:'completed',output_file:'result.txt',summary:'done',uuid:'notification',session_id:'native'});},100);
      }
    }`,
    );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('SDK background contract timeout')),
      12000,
    );
    try {
      const result = await createClaudeProvider().run({
        account: { ...f.config.accounts[0]!, executable },
        prompt: 'Research',
        instructions: '',
        cwd: f.session.workspace,
        controller,
        research: f.config.research,
        inputReleaseGraceMs: 50,
        env: {
          PATH: process.env.PATH!,
          RECORD: record,
          CLAUDE_CONFIG_DIR: f.config.accounts[0]!.home,
        },
        mcp: {
          command: process.execPath,
          args: [],
          env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id },
        },
        onEvent() {},
      });
      assert.equal(result, 'BACKGROUND_OK');
      const protocol = JSON.parse(fs.readFileSync(record, 'utf8'));
      assert.equal(protocol.closedBeforeCompletion, false);
      assert.match(JSON.stringify(protocol.hookResult), /Use research_paper/);
      assert.match(JSON.stringify(protocol.restoreResult), /additionalContext/);
      assert.match(JSON.stringify(protocol.restoreResult), /### Research state/);
    } finally {
      clearTimeout(timer);
    }
  },
);

test(
  'Codex worker tool budget preserves the final observed action before stopping',
  { timeout: 15000 },
  async (t) => {
    const { codexProvider } = await import('../src/providers.js');
    const f = enabled(t);
    const executable = path.join(f.home, 'codex-budget.mjs');
    fs.writeFileSync(
      executable,
      `#!${process.execPath}\nconst send=x=>process.stdout.write(JSON.stringify(x)+'\\n');for await(const chunk of process.stdin){};send({type:'thread.started',thread_id:'budget'});send({type:'turn.started'});for(let i=0;i<3;i++)send({type:'item.completed',item:{id:String(i),type:'command_execution',command:'echo '+i,aggregated_output:String(i),exit_code:0,status:'completed'}});send({type:'item.completed',item:{id:'final',type:'agent_message',text:'should not arrive'}});send({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}});`,
      { mode: 0o700 },
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const activity: any[] = [];
    try {
      await assert.rejects(
        codexProvider.run({
          account: { ...f.config.accounts[1]!, executable },
          prompt: 'bounded',
          instructions: '',
          cwd: f.home,
          maxTurns: 2,
          controller,
          env: { PATH: process.env.PATH! },
          mcp: { command: process.execPath, args: [], env: {} },
          onEvent(e) {
            if (e.type === 'activity') activity.push(e.detail);
          },
        }),
        (error: any) => error.kind === 'budget' && /completed-tool budget/.test(error.message),
      );
      assert.equal(activity.length, 3);
      assert.equal(activity[2].command, 'echo 2');
    } finally {
      clearTimeout(timer);
    }
  },
);
test('research CLI enables validated settings and reads the same persistent records', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { saveConfig, readConfig } = await import('../src/config.js');
  const f = fixture(t);
  saveConfig(f.home, f.config);
  const command = (args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', path.resolve('src/cli.ts'), 'research', ...args],
      { env: { ...process.env, CLAWSTRUM_HOME: f.home }, encoding: 'utf8', timeout: 10000 },
    );
  const enable = command(['enable', '--email', 'researcher@example.org', '--slurm']);
  assert.equal(enable.status, 0, enable.stderr);
  assert.equal(readConfig(f.home).research.slurm.enabled, true);
  const filename = path.join(f.home, 'note.json');
  fs.writeFileSync(
    filename,
    JSON.stringify({
      kind: 'method',
      title: 'CLI test',
      body: 'Persisted research method',
      key: 'one',
    }),
  );
  const saved = command(['note', f.session.id, '--input', filename]);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /AGENTS.md/);
  fs.writeFileSync(filename, JSON.stringify({ collection: 'notes' }));
  const status = command(['status', f.session.id, '--input', filename]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Persisted research method/);
});

test('refresh bypasses a valid paper cache and blank registry authors are not verified', async (t) => {
  const f = enabled(t);
  let count = 0;
  const network = http(f.config.research, (url) => {
    count++;
    return url.pathname.startsWith('/pdf')
      ? new Response('missing', { status: 404 })
      : new Response(
          '<article>Scientific evidence with enough text to test refreshed retrieval.</article>',
        );
  });
  await retrievePaper(f.store, f.config.research, '2401.12345', network);
  const first = count;
  const refreshed = await retrievePaper(
    f.store,
    f.config.research,
    '2401.12345',
    network,
    undefined,
    true,
  );
  assert.ok(count > first);
  assert.equal(refreshed.cached, undefined);
  const raw = JSON.parse(metadata());
  raw.message.author = [{}];
  await assert.rejects(
    verifyCitation(
      f.store,
      f.config.research,
      '10.1234/example',
      http(f.config.research, () => new Response(JSON.stringify(raw))),
    ),
    /not recorded/,
  );
});

/* Records request headers as well as URLs, for the routes that authenticate by header. */
function recorded(
  config: ReturnType<typeof researchSchema.parse>,
  fn: (url: URL) => Response | Promise<Response>,
) {
  const requests: Array<{ url: URL; headers: Record<string, string> }> = [];
  const network = new ResearchHttp(config, (async (input: any, init: any) => {
    const url = new URL(String(input));
    requests.push({ url, headers: { ...(init?.headers ?? {}) } });
    return fn(url);
  }) as typeof fetch);
  return { network, requests };
}
function fakePdftotext(f: ReturnType<typeof fixture>, text: string) {
  const extractor = path.join(f.home, 'pdftotext-routes');
  fs.writeFileSync(
    extractor,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.argv.at(-1),${JSON.stringify(text)});`,
    { mode: 0o700 },
  );
  f.config.research.pdftotext = extractor;
}
const jats = (doi: string, text: string) =>
  `<article><front><article-id pub-id-type="doi">${doi}</article-id></front><body><p>${text}</p></body></article>`;

test('PMCID, PubMed, OpenReview and OSF inputs parse to their own identifiers', async (t) => {
  const key = (raw: string) => parseCitation(raw)?.key;
  assert.equal(key('PMC1234567'), 'pmcid:PMC1234567');
  assert.equal(key('pmcid:pmc1234567'), 'pmcid:PMC1234567');
  assert.equal(key('https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/'), 'pmcid:PMC1234567');
  assert.equal(
    key('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/?doi=10.1234/other'),
    'pmcid:PMC1234567',
  );
  assert.equal(key('https://europepmc.org/article/PMC/PMC1234567'), 'pmcid:PMC1234567');
  assert.equal(key('https://europepmc.org/article/MED/31234567'), 'pmid:31234567');
  assert.equal(key('pmid:31234567'), 'pmid:31234567');
  assert.equal(key('https://pubmed.ncbi.nlm.nih.gov/31234567/'), 'pmid:31234567');
  assert.equal(key('https://www.ncbi.nlm.nih.gov/pubmed/31234567'), 'pmid:31234567');
  assert.equal(key('https://openreview.net/forum?id=AbC_d-12'), 'openreview:AbC_d-12');
  assert.equal(key('https://openreview.net/pdf?id=AbC_d-12'), 'openreview:AbC_d-12');
  assert.equal(key('openreview:AbC_d-12'), 'openreview:AbC_d-12');
  assert.equal(key('https://osf.io/preprints/psyarxiv/Abc12_v2/'), 'osf:abc12_v2');
  assert.equal(key('https://osf.io/abc12'), 'osf:abc12');
  /* A registered OSF DOI stays a DOI so registry verification still applies to it. */
  assert.equal(key('10.31234/osf.io/abc12'), 'doi:10.31234/osf.io/abc12');
  assert.equal(key('https://www.researchgate.net/publication/123_A_Title'), undefined);
  /* URLs typed without a scheme; DOIs and old-style arXiv ids keep their own meaning. */
  assert.equal(key('arxiv.org/abs/2509.13978'), 'arxiv:2509.13978');
  assert.equal(key('pubmed.ncbi.nlm.nih.gov/31234567/'), 'pmid:31234567');
  assert.equal(key('math.GT/0309136'), 'arxiv:math.gt/0309136');
  assert.equal(key('10.1101/2024.11.11.623004'), 'doi:10.1101/2024.11.11.623004');
  const f = enabled(t);
  await assert.rejects(
    retrievePaper(
      f.store,
      f.config.research,
      'Attention is all you need',
      http(f.config.research, () => new Response('{}')),
    ),
    /Not a DOI, arXiv id/,
  );
  await assert.rejects(
    verifyCitation(
      f.store,
      f.config.research,
      'pmid:31234567',
      http(f.config.research, () => new Response('{}')),
    ),
    /DOI or arXiv/,
  );
});
test('PMCID and PMID inputs reach the PMC rungs without a DOI search', async (t) => {
  const f = enabled(t);
  const serve = (url: URL) => {
    if (url.pathname.endsWith('/search'))
      return new Response(
        JSON.stringify({
          resultList: {
            result: [{ pmcid: 'PMC7654321', doi: '10.1234/pmcid', isOpenAccess: 'Y' }],
          },
        }),
      );
    if (url.pathname.endsWith('/PMC7654321/fullTextXML'))
      return new Response(jats('10.1234/pmcid', 'A deposited article body long enough to accept.'));
    if (url.hostname === 'pmc.ncbi.nlm.nih.gov')
      return new Response(
        JSON.stringify({
          records: [{ pmid: '31234567', pmcid: 'PMC7654321', doi: '10.1234/pmcid' }],
        }),
      );
    return new Response('none', { status: 404 });
  };
  for (const input of ['PMC7654321', 'pmid:31234567']) {
    const { network, requests } = recorded(f.config.research, serve);
    const result = await retrievePaper(f.store, f.config.research, input, network);
    assert.equal(result.status, 'ok', input);
    assert.equal(result.source, 'europe-pmc');
    assert.equal(result.input, parseCitation(input)!.key);
    const searches = requests.filter((r) => r.url.pathname.endsWith('/search'));
    assert.deepEqual(
      searches.map((r) => r.url.searchParams.get('query')),
      ['PMCID:PMC7654321'],
    );
  }
});
test('bioRxiv DOIs are fetched through the details API at the latest version', async (t) => {
  const f = enabled(t);
  const doi = '10.1101/2024.01.01.123456';
  const { network, requests } = recorded(f.config.research, (url) => {
    if (url.hostname === 'api.biorxiv.org' && url.pathname.startsWith('/details/biorxiv/'))
      return new Response(
        JSON.stringify({
          collection: [
            { doi, version: '1', jatsxml: 'https://www.biorxiv.org/jats/v1.source.xml' },
            { doi, version: '2', jatsxml: 'https://www.biorxiv.org/jats/v2.source.xml' },
          ],
        }),
      );
    if (url.pathname === '/jats/v2.source.xml')
      return new Response(jats(doi, 'The second version of a bioRxiv preprint, in full.'));
    return new Response('{}');
  });
  const result = await retrievePaper(f.store, f.config.research, doi, network);
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'biorxiv-jats');
  assert.equal(result.version, 'preprint');
  assert.ok(!requests.some((r) => r.url.pathname === '/jats/v1.source.xml'));
  assert.ok(!requests.some((r) => r.url.pathname.startsWith('/details/medrxiv/')));
});
test('OSF preprints are fetched through the OSF API, from a URL or a PsyArXiv DOI', async (t) => {
  const f = enabled(t);
  fakePdftotext(f, 'An OSF preprint extracted from its primary file.');
  const serve = (url: URL) => {
    if (url.hostname === 'api.osf.io' && url.pathname === '/v2/preprints/abc12/')
      return new Response(
        JSON.stringify({
          data: {
            relationships: {
              primary_file: { links: { related: { href: 'https://api.osf.io/v2/files/f1/' } } },
            },
          },
        }),
      );
    if (url.hostname === 'api.osf.io' && url.pathname === '/v2/files/f1/')
      return new Response(
        JSON.stringify({ data: { links: { download: 'https://osf.io/download/f1/' } } }),
      );
    if (url.pathname === '/download/f1/') return new Response('%PDF-osf fixture');
    return new Response('{}');
  };
  for (const input of ['https://osf.io/preprints/psyarxiv/abc12', '10.31234/osf.io/abc12']) {
    const result = await retrievePaper(
      f.store,
      f.config.research,
      input,
      recorded(f.config.research, serve).network,
    );
    assert.equal(result.status, 'ok', input);
    assert.equal(result.source, 'osf-pdf');
    assert.equal(result.version, 'preprint');
  }
});
test('OpenReview submissions are retrieved through their arXiv twin by exact title', async (t) => {
  const f = enabled(t);
  const { network, requests } = recorded(f.config.research, (url) => {
    if (url.hostname === 'api2.openreview.net')
      return new Response(
        JSON.stringify({
          notes: [{ id: 'XyZ123', content: { title: { value: 'Deep Nets Learn Things' } } }],
        }),
      );
    if (url.hostname === 'export.arxiv.org')
      return new Response(
        '<feed><entry><id>http://arxiv.org/abs/2401.99999v1</id><title>Deep Nets Learn Things Too</title></entry>' +
          '<entry><id>http://arxiv.org/abs/2401.00001v2</id><title>Deep Nets\n  Learn Things</title></entry></feed>',
      );
    if (url.hostname === 'api.crossref.org') return new Response('{"message":{"items":[]}}');
    if (url.hostname === 'arxiv.org' && url.pathname === '/html/2401.00001')
      return new Response('<article><p>The arXiv twin of an OpenReview submission.</p></article>');
    return new Response('none', { status: 404 });
  });
  const result = await retrievePaper(
    f.store,
    f.config.research,
    'https://openreview.net/forum?id=XyZ123',
    network,
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'arxiv-html');
  assert.ok(
    result.attempts.some((a) => a.source === 'title-arxiv' && /2401\.00001$/.test(a.outcome)),
  );
  assert.ok(!requests.some((r) => r.url.pathname.includes('2401.99999')));
  assert.ok(!requests.some((r) => r.url.hostname === 'openreview.net'));
});
test('ResearchGate links and landing pages that name a title resolve through Crossref', async (t) => {
  const f = enabled(t);
  const serve = (url: URL) => {
    if (url.hostname === 'export.arxiv.org') return new Response('<feed></feed>');
    if (url.hostname === 'api.crossref.org')
      return new Response(
        JSON.stringify({
          message: {
            items: [
              { DOI: '10.1234/Wrong', title: ['A Study'] },
              { DOI: '10.1234/Resolved', title: ['A Study of Very Long Titles in Modern Science'] },
            ],
          },
        }),
      );
    if (url.pathname.endsWith('/search'))
      return new Response(
        JSON.stringify({
          resultList: {
            result: [{ doi: '10.1234/resolved', pmcid: 'PMC2222222', isOpenAccess: 'Y' }],
          },
        }),
      );
    if (url.pathname.endsWith('/PMC2222222/fullTextXML'))
      return new Response(jats('10.1234/resolved', 'The article found under its exact title.'));
    if (url.hostname === 'journal.example')
      return new Response(
        '<html><meta name="citation_title" content="A Study of Very Long Titles in Modern Science"></html>',
      );
    return new Response('none', { status: 404 });
  };
  const rg = recorded(f.config.research, serve);
  const result = await retrievePaper(
    f.store,
    f.config.research,
    'https://www.researchgate.net/publication/123456_A_Study_of_Very_Long_Titles_in_Modern',
    rg.network,
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'europe-pmc');
  assert.ok(
    result.attempts.some(
      (a) => a.source === 'title-crossref' && /10\.1234\/resolved$/.test(a.outcome),
    ),
  );
  assert.ok(!rg.requests.some((r) => r.url.hostname.endsWith('researchgate.net')));
  const landing = await retrievePaper(
    f.store,
    f.config.research,
    'https://journal.example/article/9',
    recorded(f.config.research, serve).network,
  );
  assert.equal(landing.status, 'ok');
  assert.equal(landing.source, 'europe-pmc');
  assert.ok(
    landing.attempts.some((a) => a.source === 'given-url' && /without a PDF link/.test(a.outcome)),
  );
});

const OPENALEX_ENV = 'CLAWSTRUM_TEST_OPENALEX_KEY';
const OPENALEX_KEY = 'oa-secret-key-7f3a';
function openalex(t: any, remaining = '0.90') {
  const f = enabled(t);
  f.config.research.openalexKeyEnv = OPENALEX_ENV;
  process.env[OPENALEX_ENV] = OPENALEX_KEY;
  t.after(() => delete process.env[OPENALEX_ENV]);
  const content = {
    grobid:
      '<TEI><teiHeader><title>x</title></teiHeader><text><body><div><head>Introduction</head><p>Stored full text that no open location serves.</p></div></body></text></TEI>',
    remaining,
  };
  const serve = (url: URL) => {
    if (url.hostname === 'api.openalex.org')
      return new Response(
        JSON.stringify({
          id: 'https://openalex.org/W123',
          doi: 'https://doi.org/10.1234/paid',
          has_content: { grobid_xml: true, pdf: true },
        }),
        { headers: { 'x-ratelimit-remaining-usd': content.remaining } },
      );
    if (url.hostname === 'content.openalex.org' && url.pathname === '/works/W123.grobid-xml')
      return new Response(content.grobid, {
        headers: { 'x-ratelimit-remaining-usd': content.remaining },
      });
    if (url.hostname === 'content.openalex.org') return new Response('%PDF-partial');
    if (url.hostname.includes('ebi.ac.uk') || url.hostname === 'pmc.ncbi.nlm.nih.gov')
      return new Response('{}');
    return new Response('none', { status: 404 });
  };
  return { f, content, serve };
}
test('OpenAlex stored content is a paid rung reached only after every free rung fails', async (t) => {
  const { f, serve } = openalex(t);
  const { network, requests } = recorded(f.config.research, serve);
  const result = await retrievePaper(f.store, f.config.research, '10.1234/paid', network);
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'openalex-grobid-xml');
  assert.match(fs.readFileSync(result.textPath!, 'utf8'), /Stored full text/);
  const first = requests.findIndex((r) => r.url.hostname.endsWith('openalex.org'));
  assert.ok(requests.some((r) => r.url.hostname === 'doi.org'));
  assert.ok(requests.slice(first).every((r) => r.url.hostname.endsWith('openalex.org')));
  assert.ok(!requests.some((r) => r.url.pathname.endsWith('.pdf')));
  for (const r of requests)
    assert.equal(
      r.headers.authorization,
      r.url.hostname.endsWith('openalex.org') ? `Bearer ${OPENALEX_KEY}` : undefined,
    );
  assert.ok(!requests.some((r) => r.url.href.includes(OPENALEX_KEY)));
  assert.ok(!JSON.stringify(result).includes(OPENALEX_KEY));
  assert.ok(!fs.readFileSync(result.manifestPath, 'utf8').includes(OPENALEX_KEY));
  /* A free success never touches the paid service. */
  const free = recorded(f.config.research, (url) =>
    url.pathname.endsWith('/search')
      ? new Response(
          JSON.stringify({
            resultList: { result: [{ doi: '10.1234/free', pmcid: 'PMC3', isOpenAccess: 'Y' }] },
          }),
        )
      : url.pathname.endsWith('/PMC3/fullTextXML')
        ? new Response(jats('10.1234/free', 'An open archive copy that reads in full.'))
        : serve(url),
  );
  const open = await retrievePaper(
    f.store,
    f.config.research,
    '10.1234/free',
    free.network,
    undefined,
    true,
  );
  assert.equal(open.status, 'ok');
  assert.ok(!free.requests.some((r) => r.url.hostname.endsWith('openalex.org')));
});
test('the OpenAlex reserve skips paid downloads once the budget runs low', async (t) => {
  const { f, content, serve } = openalex(t, '0.10');
  const low = recorded(f.config.research, serve);
  const skipped = await retrievePaper(f.store, f.config.research, '10.1234/paid', low.network);
  assert.equal(skipped.status, 'no-fulltext');
  assert.ok(
    skipped.attempts.some(
      (a) => a.source === 'openalex-content' && /below the \$0\.25 reserve/.test(a.outcome),
    ),
  );
  assert.ok(!low.requests.some((r) => r.url.hostname === 'content.openalex.org'));
  /* The balance after one paid download also gates the next: a failed grobid copy that leaves the
   * budget under the reserve does not buy the PDF too. */
  content.remaining = '0.30';
  content.grobid = '<TEI><text></text></TEI>';
  const drained = recorded(f.config.research, (url) => {
    if (url.hostname === 'content.openalex.org') content.remaining = '0.20';
    return serve(url);
  });
  const result = await retrievePaper(
    f.store,
    f.config.research,
    '10.1234/paid',
    drained.network,
    undefined,
    true,
  );
  assert.equal(result.status, 'no-fulltext');
  assert.ok(result.attempts.some((a) => a.source === 'openalex-pdf' && /reserve/.test(a.outcome)));
  assert.ok(!drained.requests.some((r) => r.url.pathname === '/works/W123.pdf'));
});
test('OpenAlex is skipped without a key, and the key never reaches attempts or errors', async (t) => {
  const { f, serve } = openalex(t);
  delete process.env[OPENALEX_ENV];
  const none = recorded(f.config.research, serve);
  const skipped = await retrievePaper(f.store, f.config.research, '10.1234/paid', none.network);
  assert.equal(skipped.status, 'no-fulltext');
  assert.ok(
    skipped.attempts.some(
      (a) =>
        a.source === 'openalex-content' && /Skipped: no configured OpenAlex key/.test(a.outcome),
    ),
  );
  assert.ok(!none.requests.some((r) => r.url.hostname.endsWith('openalex.org')));
  process.env[OPENALEX_ENV] = OPENALEX_KEY;
  for (const failure of ['status', 'throw'] as const) {
    const network = new ResearchHttp(f.config.research, (async (input: any, init: any) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.openalex.org') {
        if (failure === 'throw') throw new Error(`rejected ${init?.headers?.authorization}`);
        return new Response(`bad key ${OPENALEX_KEY}`, { status: 401 });
      }
      return serve(url);
    }) as typeof fetch);
    const result = await retrievePaper(
      f.store,
      f.config.research,
      '10.1234/paid',
      network,
      undefined,
      true,
    );
    assert.equal(result.status, 'no-fulltext');
    assert.ok(result.attempts.some((a) => a.source === 'openalex-content'));
    assert.ok(!JSON.stringify(result).includes(OPENALEX_KEY), failure);
    assert.ok(!fs.readFileSync(result.manifestPath, 'utf8').includes(OPENALEX_KEY), failure);
  }
});

test('cluster commands, and the jobs they submit, do not inherit credentials', async (t) => {
  t.after(() => delete process.env.CLUSTER_PROBE_API_KEY);
  process.env.CLUSTER_PROBE_API_KEY = 'probe-secret';
  const run = clusterCommand(researchSchema.parse({}));
  const out = await run(process.execPath, [
    '-e',
    "process.stdout.write(process.env.CLUSTER_PROBE_API_KEY ? 'leak' : 'clean')",
  ]);
  assert.equal(out, 'clean');
});
