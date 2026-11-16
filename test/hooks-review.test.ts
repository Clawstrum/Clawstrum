import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, ok, settle } from './helpers.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import type { Provider, ProviderRequest } from '../src/types.js';
import { citationOccurrences, parseCitation } from '../src/research/literature.js';
import {
  scanCitations,
  scanCitationWrite,
  readCitationDocument,
} from '../src/research/citations.js';
import { reviewReply, replyFeedback } from '../src/research/replies.js';
import { researchHooks } from '../src/research/hooks.js';
import { researchTool } from '../src/research/tools.js';

function enabled(t: any) {
  const f = fixture(t);
  f.config.research.enabled = true;
  f.config.research.validation = 'strict';
  record(f.store);
  return f;
}
function record(store: Store, id = '10.1234/example', authors = ['Jane Doe'], year = 2024) {
  const citation = {
    ...parseCitation(id),
    authors,
    year,
    title: 'An experiment',
    venue: 'Journal',
    source: 'fixture',
    fetchedAt: 1,
    responseHash: 'fixture',
    responsePath: '/fixture',
    correctionLinks: [],
  };
  store.exec(
    'INSERT OR REPLACE INTO citations(key,metadata_json,verified_at) VALUES(?,?,?)',
    citation.key!,
    JSON.stringify(citation),
    1,
  );
}
const good = 'Doe et al. (2024), doi:10.1234/example';
const bad = 'Smith et al. (1999), doi:10.1234/example';

test('document checks catch attribution errors on already-resolved IDs, including repeated occurrences', (t) => {
  const f = enabled(t);
  const scan = scanCitations(f.store, `${good}\n${bad}`);
  assert.equal(scan.identifiers, 2);
  assert.equal(scan.attributionsChecked, 2);
  assert.equal(scan.findings.length, 1);
  assert.equal(scan.findings[0]!.line, 2);
  assert.match(scan.findings[0]!.message, /Year differs/);
  assert.match(scan.findings[0]!.message, /Author surname absent/);
  assert.match(scan.findings[0]!.message, /Jane Doe \(2024\), An experiment/);
});
test('author-year pairing never borrows an author or year from a second paper', (t) => {
  const f = enabled(t);
  record(f.store, '10.1234/other', ['John Smith'], 1999);
  const scan = scanCitations(
    f.store,
    'Doe (1999), doi:10.1234/example; Smith (2024), doi:10.1234/other',
  );
  assert.equal(scan.attributionsChecked, 2);
  assert.equal(scan.findings.length, 2);
  assert.ok(scan.findings.every((i) => /Year differs/.test(i.message)));
});
test('two citations on the same line retain their own local author-year pairs', (t) => {
  const f = enabled(t);
  record(f.store, '10.1234/other', ['John Smith'], 1999);
  const scan = scanCitations(
    f.store,
    'Doe (2024), doi:10.1234/example and Smith (1999), doi:10.1234/other',
  );
  assert.equal(scan.attributionsChecked, 2);
  assert.equal(scan.ok, true);
});
test('ambiguous or distant attributions are reported as unverified, not guessed', (t) => {
  const f = enabled(t);
  const scan = scanCitations(f.store, 'Smith (1999) and Doe (2024), doi:10.1234/example');
  assert.ok(scan.ambiguous > 0);
  assert.equal(scan.findings.length, 0);
  const distant = scanCitations(f.store, `Smith (1999) ${'x'.repeat(300)} doi:10.1234/example`);
  assert.equal(distant.attributionsChecked, 0);
  assert.ok(distant.ambiguous > 0);
});
test('surname checks reject a matching given name and support diacritics, short names and particles', (t) => {
  const f = enabled(t);
  assert.equal(scanCitations(f.store, 'Jane (2024), doi:10.1234/example').ok, false);
  record(f.store, '10.1234/example', ['Ana García', 'Bo Li', 'Ludwig van Beethoven']);
  for (const name of ['Garcia', 'Li', 'van Beethoven'])
    assert.equal(scanCitations(f.store, `${name} (2025), doi:10.1234/example`).ok, true, name);
  assert.equal(scanCitations(f.store, 'Garcia & Smith (2024), doi:10.1234/example').ok, false);
});
test('fenced logs/examples are ignored while inline identifiers and normal references are checked', (t) => {
  const f = enabled(t);
  const scan = scanCitations(
    f.store,
    '```text\nSmith (1999), doi:10.1234/missing\n```\n' + 'Smith (1999), `doi:10.1234/example`',
  );
  assert.equal(scan.identifiers, 1);
  assert.equal(scan.findings.length, 1);
  assert.equal(scan.findings[0]!.line, 4);
});
test('BibTeX checks nested titles and author/year fields without crossing entry boundaries', (t) => {
  const f = enabled(t);
  const source =
    '@article{a,\n author = {Doe, Jane}, title = {An {experiment}}, year = {2024}, doi = {10.1234/example}\n}\n@article{b, author = "Smith, John", year = 1999, doi = {10.1234/example}}';
  const scan = scanCitations(f.store, source);
  assert.equal(scan.attributionsChecked, 2);
  assert.equal(scan.findings.length, 1);
  assert.match(scan.findings[0]!.message, /Smith/);
});
test('BibTeX arXiv eprint IDs are checked and mixed identifiers stay ambiguous', (t) => {
  const f = enabled(t);
  record(f.store, '2401.12345v2');
  const scan = scanCitations(
    f.store,
    '@misc{x, author={Smith, John}, year={1999}, eprint={2401.12345v2}, archivePrefix={arXiv}}',
  );
  assert.equal(scan.identifiers, 1);
  assert.equal(scan.findings[0]!.key, 'arxiv:2401.12345v2');
  assert.equal(scan.ok, false);
  const mixed = scanCitations(
    f.store,
    '@misc{x, author={Smith, John}, year={1999}, doi={10.1234/example}, eprint={2401.12345v2}, archivePrefix={arXiv}}',
  );
  assert.equal(mixed.ambiguous, 1);
  assert.equal(mixed.attributionsChecked, 0);
});
test('citation occurrences preserve offsets, literal DOI parentheses and arXiv versions', () => {
  const text = 'See (doi:10.1234/a(b)).\nhttps://arxiv.org/abs/2401.12345v2';
  const refs = citationOccurrences(text);
  assert.equal(refs[0]!.id, '10.1234/a(b)');
  assert.equal(text.slice(refs[0]!.index, refs[0]!.end), 'doi:10.1234/a(b)');
  assert.equal(refs[1]!.id, '2401.12345v2');
});
test('SICI DOIs survive their angle brackets instead of being truncated into a different DOI', () => {
  const sici = '10.1002/(SICI)1097-0258(19990330)18:6<679::AID-SIM346>3.0.CO;2-V';
  assert.equal(citationOccurrences(`See doi:${sici} for the method.`)[0]!.id, sici.toLowerCase());
  assert.equal(citationOccurrences(`<https://doi.org/${sici}>`)[0]!.id, sici.toLowerCase());
  // A '<' that opens markup still terminates an ordinary DOI.
  assert.equal(citationOccurrences('doi:10.1234/example<br>')[0]!.id, '10.1234/example');
});
test('bare arXiv numbers are recognized without a prefix, and decimals are not', () => {
  const refs = citationOccurrences('Attention is all you need (1706.03762), and 2401.12345v2 too.');
  assert.deepEqual(
    refs.map((r) => r.id),
    ['1706.03762', '2401.12345v2'],
  );
  assert.deepEqual(citationOccurrences('accuracy 0.8812, run 1234.56789, build 2024.100000'), []);
  // A bare number inside a DOI or a path belongs to the enclosing identifier, not to arXiv.
  assert.deepEqual(
    citationOccurrences('doi:10.1234/2301.12345 and runs/2301.12345/out').map((r) => r.id),
    ['10.1234/2301.12345'],
  );
});
test('Edit previews catch changed author/year with an unchanged DOI and leave unrelated legacy findings alone', (t) => {
  const f = enabled(t);
  const file = path.join(f.session.workspace, 'report.md');
  fs.writeFileSync(file, good + '\nLegacy: doi:10.1234/unknown\nA summary.');
  const edited = scanCitationWrite(f.store, 'Edit', {
    file_path: file,
    old_string: '2024',
    new_string: '1999',
  })!;
  assert.equal(edited.findings.length, 1);
  assert.match(edited.findings[0]!.message, /Year differs/);
  assert.equal(
    scanCitationWrite(f.store, 'Edit', {
      file_path: file,
      old_string: 'A summary.',
      new_string: 'A revised summary.',
    })!.ok,
    true,
  );
  assert.equal(fs.readFileSync(file, 'utf8').includes('1999'), false);
  assert.equal(
    scanCitationWrite(f.store, 'Write', { file_path: 'raw-log.txt', content: bad }),
    undefined,
  );
});
test('explicit scan tool supports text and workspace-relative paths with clear input and size errors', async (t) => {
  const f = enabled(t);
  const ctx = { store: f.store, config: f.config, sessionId: f.session.id, scope: 'scan' };
  fs.writeFileSync(path.join(f.session.workspace, 'report.bib'), bad);
  assert.equal(
    ((await researchTool('research_citation', { action: 'scan', path: 'report.bib' }, ctx)) as any)
      .ok,
    false,
  );
  assert.equal(
    ((await researchTool('research_citation', { action: 'scan', text: good }, ctx)) as any).ok,
    true,
  );
  await assert.rejects(
    researchTool('research_citation', { action: 'scan', text: '', path: 'report.bib' }, ctx),
    /exactly one/,
  );
  await assert.rejects(researchTool('research_citation', { action: 'verify' }, ctx), /requires id/);
  const large = path.join(f.session.workspace, 'large.md');
  fs.writeFileSync(large, 'x'.repeat(2_000_001));
  assert.throws(() => readCitationDocument(large), /up to/);
});
test('strict citation write feedback is bounded and native worker budgets do not consume the lead budget', async (t) => {
  const f = enabled(t);
  f.enqueue('hooks');
  const run = f.store.claim(f.session.id)!.run;
  const request: ProviderRequest = {
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
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id, CLAWSTRUM_RUN: run.id },
    },
    onEvent() {},
  };
  async function invoke(agent?: string) {
    const hooks = researchHooks(request);
    try {
      return (await hooks.hooks!.PreToolUse![0]!.hooks[0]!(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'sdk',
          transcript_path: '',
          cwd: f.session.workspace,
          tool_use_id: 't',
          tool_name: 'Write',
          tool_input: { file_path: path.join(f.session.workspace, 'report.md'), content: bad },
          ...(agent ? { agent_id: agent } : {}),
        },
        undefined,
        { signal: request.controller.signal },
      )) as any;
    } finally {
      hooks.close();
    }
  }
  assert.equal((await invoke('worker')).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await invoke()).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await invoke()).hookSpecificOutput.permissionDecision, undefined);
});
test('reply correction budget survives a new Store connection and is shared across delivery routes', (t) => {
  const f = enabled(t);
  f.enqueue('review');
  const run = f.store.claim(f.session.id)!.run;
  const input = {
    sessionId: f.session.id,
    runId: run.id,
    scope: run.logical_id,
    text: bad,
    route: 'send_message',
  };
  const first = reviewReply(f.store, f.config.research, input);
  assert.equal(first.blocked, true);
  assert.equal(fs.statSync(first.artifactPath!).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(first.artifactPath!, 'utf8'), /Smith/);
  const reopened = new Store(f.home);
  try {
    assert.match(
      replyFeedback(reopened, run.logical_id)!,
      /do not repeat completed external actions/,
    );
    assert.equal(
      reviewReply(reopened, f.config.research, { ...input, route: 'provider-result' }).blocked,
      false,
    );
  } finally {
    reopened.close();
  }
  assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
});
test('a reply over its ceiling is held on the same correction opportunity as a bad citation', (t) => {
  const f = enabled(t);
  f.enqueue('long');
  const run = f.store.claim(f.session.id)!.run;
  const input = {
    sessionId: f.session.id,
    runId: run.id,
    scope: run.logical_id,
    text: 'a clean line with no citation in it\n'.repeat(40),
    route: 'provider-result',
  };
  const held = reviewReply(f.store, f.config.research, input);
  assert.equal(held.blocked, true);
  assert.match(held.feedback!, /40 lines against a ceiling of 25/);
  // Citation remedies are not offered for a reply whose only problem is length.
  assert.doesNotMatch(held.feedback!, /research_citation/);
  assert.match(replyFeedback(f.store, run.logical_id)!, /Cut the reply rather than rewording it/);
  // The correction opportunity is shared, so the second pass delivers rather than looping.
  assert.equal(reviewReply(f.store, f.config.research, input).blocked, false);
  // Zeroing both ceilings removes the check without touching the citation half.
  f.config.research.reply = { maxLines: 0, maxChars: 0 };
  assert.deepEqual(reviewReply(f.store, f.config.research, input), { blocked: false });
});
test('advisory review records diagnostics without spending a strict correction; disabled profiles are inert', (t) => {
  const f = enabled(t);
  f.enqueue('m');
  const run = f.store.claim(f.session.id)!.run;
  const input = {
    sessionId: f.session.id,
    runId: run.id,
    scope: run.logical_id,
    text: bad,
    route: 'provider-result',
  };
  f.config.research.validation = 'advisory';
  assert.equal(reviewReply(f.store, f.config.research, input).blocked, false);
  assert.equal(replyFeedback(f.store, run.logical_id), undefined);
  f.config.research.validation = 'off';
  assert.deepEqual(reviewReply(f.store, f.config.research, input), { blocked: false });
  f.config.research.enabled = false;
  f.config.research.validation = 'strict';
  assert.deepEqual(reviewReply(f.store, f.config.research, input), { blocked: false });
  assert.equal(f.store.all("SELECT * FROM events WHERE type='research_reply_review'").length, 1);
});
for (const provider of ['claude', 'codex'] as const)
  test(`${provider} final results get one corrective turn before delivery`, async (t) => {
    const f = enabled(t);
    if (provider === 'codex') f.config.accounts.reverse();
    let calls = 0;
    const adapter: Provider = {
      async run(r) {
        calls++;
        if (calls === 1) return bad;
        assert.match(r.prompt, /Outgoing reply correction/);
        assert.match(r.prompt, /Jane Doe/);
        assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
        return good;
      },
    };
    const engine = new Engine(f.config, f.store, { claude: adapter, codex: adapter });
    t.after(() => engine.stop());
    f.enqueue('answer');
    await engine.tick();
    await settle(engine);
    assert.equal(calls, 2);
    assert.equal(f.store.get<any>('SELECT content FROM outbox').content, good);
    assert.equal(f.store.get<any>('SELECT status FROM runs').status, 'done');
    assert.equal(f.store.get<any>('SELECT attempts FROM inbound').attempts, 0);
  });
test('repeated incorrect provider answers terminate after one correction with a recorded unresolved review', async (t) => {
  const f = enabled(t);
  let calls = 0;
  const adapter: Provider = {
    async run() {
      calls++;
      return bad;
    },
  };
  const engine = new Engine(f.config, f.store, { claude: adapter, codex: adapter });
  t.after(() => engine.stop());
  f.enqueue('answer');
  await engine.tick();
  await settle(engine);
  assert.equal(calls, 2);
  assert.equal(f.store.all('SELECT * FROM outbox').length, 1);
  const reviews = f.store.all<any>(
    "SELECT content FROM events WHERE type='research_reply_review' ORDER BY seq",
  );
  assert.deepEqual(
    reviews.map((e) => JSON.parse(e.content).blocked),
    [true, false],
  );
});
test('a provider switch during correction keeps feedback and cannot renew the correction budget', async (t) => {
  const f = enabled(t);
  let calls = 0;
  const engine = new Engine(f.config, f.store, {
    claude: {
      async run() {
        if (++calls === 1) return bad;
        throw new Error('usage limit reached');
      },
    },
    codex: {
      async run(r) {
        assert.match(r.prompt, /Outgoing reply correction/);
        return bad;
      },
    },
  });
  t.after(() => engine.stop());
  f.enqueue('switch');
  await engine.tick();
  await settle(engine);
  assert.equal(calls, 2);
  assert.equal(f.store.get<any>('SELECT status FROM runs').status, 'done');
  assert.equal(f.store.all("SELECT * FROM outbox WHERE origin='agent'").length, 1);
});
test('already-final sends are not reviewed as a second automatic reply', async (t) => {
  const f = enabled(t);
  let calls = 0;
  const adapter: Provider = {
    async run(r) {
      calls++;
      f.store.outbox(f.session.id, 'Already answered', {
        runId: r.mcp.env.CLAWSTRUM_RUN,
        final: true,
      });
      return bad;
    },
  };
  const engine = new Engine(f.config, f.store, { claude: adapter, codex: ok });
  t.after(() => engine.stop());
  f.enqueue('answer');
  await engine.tick();
  await settle(engine);
  assert.equal(calls, 1);
  assert.equal(f.store.all("SELECT * FROM events WHERE type='research_reply_review'").length, 0);
});
test('real MCP gates messages and immutable prose attachments, then preserves outbox idempotency', async (t) => {
  const f = enabled(t);
  f.enqueue('mcp');
  const run = f.store.claim(f.session.id)!.run;
  f.store.exec('UPDATE runs SET config_json=? WHERE id=?', JSON.stringify(f.config), run.id);
  const client = new Client({ name: 'review-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('dist/cli.js'), 'mcp'],
      env: {
        PATH: process.env.PATH!,
        CLAWSTRUM_HOME: f.home,
        CLAWSTRUM_SESSION: f.session.id,
        CLAWSTRUM_RUN: run.id,
      },
      stderr: 'pipe',
    }),
  );
  try {
    const file = path.join(f.session.workspace, 'report.md');
    fs.writeFileSync(file, bad);
    const blocked = await client.callTool({
      name: 'send_file',
      arguments: { path: file, caption: 'Report', final: true, key: 'report' },
    });
    assert.equal(blocked.isError, true);
    assert.equal(f.store.hasFinal(run.id), false);
    assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
    assert.equal(fs.readdirSync(path.join(f.home, 'outgoing')).length, 0);
    fs.writeFileSync(file, good);
    for (let i = 0; i < 2; i++)
      assert.ok(
        !(
          await client.callTool({
            name: 'send_file',
            arguments: { path: file, caption: 'Report', final: true, key: 'report' },
          })
        ).isError,
      );
    assert.equal(f.store.all('SELECT * FROM outbox').length, 1);
    assert.equal(fs.readdirSync(path.join(f.home, 'outgoing')).length, 1);
    // Existing payload keys still reject mutation, even after the review budget is used.
    fs.writeFileSync(file, bad);
    assert.equal(
      (
        await client.callTool({
          name: 'send_file',
          arguments: { path: file, caption: 'Report', key: 'report' },
        })
      ).isError,
      true,
    );
    for (let i = 0; i < 2; i++)
      assert.ok(
        !(await client.callTool({ name: 'send_message', arguments: { text: bad, key: 'message' } }))
          .isError,
      );
    assert.equal(f.store.all('SELECT * FROM outbox').length, 2);
    assert.equal(f.store.all("SELECT * FROM events WHERE type='research_reply_review'").length, 2);
    const scan = await client.callTool({
      name: 'research_citation',
      arguments: { action: 'scan', text: good },
    });
    assert.ok(!scan.isError);
    assert.equal(JSON.parse((scan.content as any)[0].text).ok, true);
  } finally {
    await client.close();
  }
});

test('one attribution beside multiple distinct identifiers stays ambiguous', (t) => {
  const f = enabled(t);
  record(f.store, '10.1234/other', ['John Smith'], 1999);
  const scan = scanCitations(f.store, 'Smith (1999), doi:10.1234/example and doi:10.1234/other');
  assert.equal(scan.ambiguous, 1);
  assert.equal(scan.attributionsChecked, 0);
  assert.equal(scan.findings.length, 0);
});
test('strict outgoing review preserves quiet scheduled tasks', async (t) => {
  const f = enabled(t);
  const adapter: Provider = {
    async run() {
      return 'CLAWSTRUM_QUIET';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: adapter, codex: adapter });
  t.after(() => engine.stop());
  f.store.enqueue({
    id: 'quiet',
    sessionId: f.session.id,
    author: 'scheduler',
    content: 'Check progress',
    kind: 'task',
  });
  engine.tick();
  await settle(engine);
  assert.equal(f.store.get<any>('SELECT status FROM runs').status, 'done');
  assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
  assert.equal(f.store.all("SELECT * FROM events WHERE type='research_reply_review'").length, 0);
});
test('cancellation during a corrective provider turn cannot deliver its later result', async (t) => {
  const f = enabled(t);
  let calls = 0;
  let correction!: () => void;
  const entered = new Promise<void>((resolve) => {
    correction = resolve;
  });
  const adapter: Provider = {
    async run(r) {
      if (++calls === 1) return bad;
      correction();
      await new Promise<void>((resolve) =>
        r.controller.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return good;
    },
  };
  const engine = new Engine(f.config, f.store, { claude: adapter, codex: adapter });
  t.after(() => engine.stop());
  f.enqueue('cancel');
  engine.tick();
  await entered;
  await engine.stop();
  assert.equal(calls, 2);
  assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
  assert.equal(f.store.get<any>('SELECT status FROM runs').status, 'interrupted');
  assert.equal(f.store.get<any>('SELECT status FROM inbound').status, 'queued');
});
test('real MCP returns actionable feedback before a first problematic text send', async (t) => {
  const f = enabled(t);
  f.enqueue('mcp-text');
  const run = f.store.claim(f.session.id)!.run;
  f.store.exec('UPDATE runs SET config_json=? WHERE id=?', JSON.stringify(f.config), run.id);
  const client = new Client({ name: 'review-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('dist/cli.js'), 'mcp'],
      env: {
        PATH: process.env.PATH!,
        CLAWSTRUM_HOME: f.home,
        CLAWSTRUM_SESSION: f.session.id,
        CLAWSTRUM_RUN: run.id,
      },
      stderr: 'pipe',
    }),
  );
  try {
    const blocked = await client.callTool({
      name: 'send_message',
      arguments: { text: bad, final: true, key: 'answer' },
    });
    assert.equal(blocked.isError, true);
    assert.match((blocked.content as any)[0].text, /Jane Doe/);
    assert.equal(f.store.hasFinal(run.id), false);
    assert.equal(f.store.all('SELECT * FROM outbox').length, 0);
    assert.ok(
      !(
        await client.callTool({
          name: 'send_message',
          arguments: { text: good, final: true, key: 'answer' },
        })
      ).isError,
    );
    assert.equal(f.store.get<any>('SELECT content FROM outbox').content, good);
    assert.equal(f.store.hasFinal(run.id), true);
  } finally {
    await client.close();
  }
});

test('BibTeX macro values remain unverified and literal braces/quotes do not absorb another entry', (t) => {
  const f = enabled(t);
  const scan = scanCitations(
    f.store,
    '@article{a, author=authorMacro, title="An" # suffix, year=yearMacro, doi={10.1234/example}}',
  );
  assert.equal(scan.attributionsChecked, 0);
  assert.equal(scan.findings.length, 0);
  const source =
    '@article{a, title={A literal " mark}, doi={10.1234/example}}\n@article(b, title={A literal ) mark}, author={Smith, John}, year=1999, doi={10.1234/example})';
  const entries = scanCitations(f.store, source);
  assert.equal(entries.attributionsChecked, 2);
  assert.equal(entries.findings.length, 2);
});
test('Edit filtering retains a newly duplicated legacy discrepancy', (t) => {
  const f = enabled(t);
  const file = path.join(f.session.workspace, 'report.md');
  fs.writeFileSync(file, bad + '\nSummary.');
  const scan = scanCitationWrite(f.store, 'Edit', {
    file_path: file,
    old_string: 'Summary.',
    new_string: bad,
  })!;
  assert.equal(scan.findings.length, 1);
});

test('long code fences, blank lines and non-citation words do not cause pathological scanning', (t) => {
  const f = enabled(t);
  const scan = scanCitations(
    f.store,
    '\n'.repeat(20000) + 'A'.repeat(100000) + '\n' + '`'.repeat(100000) + '\n' + bad,
  );
  assert.equal(scan.identifiers, 0);
  assert.equal(scan.attributionsChecked, 0);
  assert.equal(scan.ok, true);
});

test('abbreviated bibliography given names do not create surname discrepancies', (t) => {
  const f = enabled(t);
  for (const author of ['Doe, J.', 'J. Doe', 'Jane Q. Doe']) {
    const scan = scanCitations(
      f.store,
      `@article{x, author={${author}}, year=2024, doi={10.1234/example}}`,
    );
    assert.equal(scan.attributionsChecked, 1);
    assert.equal(scan.ok, true, author);
  }
  assert.equal(
    scanCitations(f.store, '@article{x, author={Smith, J.}, year=2024, doi={10.1234/example}}').ok,
    false,
  );
});
test('prose bibliography initials associate with the preceding surname', (t) => {
  const f = enabled(t);
  const good = scanCitations(f.store, 'Doe, J. (2024), doi:10.1234/example');
  assert.equal(good.attributionsChecked, 1);
  assert.equal(good.ok, true);
  const bad = scanCitations(f.store, 'Doe, J. (1999), doi:10.1234/example');
  assert.equal(bad.attributionsChecked, 1);
  assert.equal(bad.ok, false);
  assert.match(bad.findings[0]!.message, /Year differs/);
});
