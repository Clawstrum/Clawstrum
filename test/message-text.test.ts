import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeMessageText } from '../src/message-text.js';
import { deliveryPayloads, splitMessage, sendDelivery } from '../src/discord.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { fixture, settle } from './helpers.js';
import type { Outbound, Provider } from '../src/types.js';

test('escaped prose paragraphs become real newlines, including overescaped and CRLF input', () => {
  for (const separator of [String.raw`\n\n`, String.raw`\\n\\n`, String.raw`\r\n\r\n`]) {
    const source = `All quiet on my end.${separator}What should we work on?`;
    const expected = 'All quiet on my end.\n\nWhat should we work on?';
    assert.equal(normalizeMessageText(source), expected);
    assert.equal(normalizeMessageText(expected), expected);
  }
  assert.equal(
    normalizeMessageText(String.raw`I'm ready.\n\nLet's go.`),
    "I'm ready.\n\nLet's go.",
  );
});

test('literal examples, JSON strings, paths and links keep their original bytes', () => {
  for (const text of [
    String.raw`Use \n for a newline and \n\n for a paragraph.`,
    String.raw`The string "one\n\ntwo" contains escape syntax.`,
    String.raw`The string 'one\n\ntwo' contains escape syntax.`,
    String.raw`{"message":"one\n\ntwo"}`,
    String.raw`C:\new\notes C:\n\notes \\server\n\notes /tmp/a\n\nb ./a\n\nb`,
    String.raw`https://example.org/a\n\nb [link](https://example.org/a\n\nb)`,
    String.raw`\n\n`,
  ])
    assert.equal(normalizeMessageText(text), text);
});

test('Markdown code stays literal while surrounding prose paragraphs are repaired', () => {
  const code = [
    '`one\\n\\ntwo`',
    '``a ` tick \\n\\n b``',
    '```python\nvalue = "a\\n\\nb"\n```',
    '~~~~text\n```\na\\n\\nb\n~~~~',
    '    code\\n\\nexample',
    '\tcode\\n\\nexample',
  ];
  for (const block of code) {
    const text = `First.\\n\\nSecond.\n${block}\nThird.\\n\\nFourth.`;
    assert.equal(normalizeMessageText(text), `First.\n\nSecond.\n${block}\nThird.\n\nFourth.`);
  }
  const unclosed = 'First.\\n\\nSecond.\n```text\na\\n\\nb';
  assert.equal(normalizeMessageText(unclosed), 'First.\n\nSecond.\n```text\na\\n\\nb');
});

test('Discord payloads repair legacy queued replies and split a long one into messages', (t) => {
  const f = fixture(t);
  for (const text of ['First.\\n\\nSecond.', 'First.\\n\\n' + 'Second paragraph. '.repeat(140)]) {
    const id = f.store.outbox(f.session.id, text, { origin: 'agent' });
    const row = f.store.get<Outbound>('SELECT * FROM outbox WHERE id=?', id)!;
    const payloads = deliveryPayloads(row);
    const expected = text.replaceAll('\\n', '\n');
    if (expected.length > 1900) {
      assert.ok(payloads.length > 1, `one message for ${expected.length} chars`);
      assert.match(payloads[0]!.content, /^First\.\n\nSecond paragraph\. /);
      // Every part is a readable message; nothing is hidden in an attachment.
      for (const payload of payloads) assert.equal(payload.files.length, 0);
      assert.equal(
        payloads
          .map((p) => p.content)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
        expected.replace(/\s+/g, ' ').trim(),
      );
    } else {
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0]!.content, expected);
    }
    assert.equal(deliveryPayloads(row)[0]!.nonce, payloads[0]!.nonce);
  }
});

test('an overflowing reply leads with its answer and never ships an unclosed code fence', (t) => {
  const f = fixture(t);
  const long = (text: string) => {
    const id = f.store.outbox(f.session.id, text, { origin: 'agent' });
    return deliveryPayloads(f.store.get<Outbound>('SELECT * FROM outbox WHERE id=?', id)!).map(
      (p) => p.content,
    );
  };
  const fenced = long(`Accuracy is 0.8812.\n\n\`\`\`python\n${'x = 1\n'.repeat(400)}\`\`\`\n`);
  assert.ok(fenced.length > 1);
  assert.match(fenced[0]!, /^Accuracy is 0\.8812\./);
  // Each part renders on its own, so a fence a cut left open is closed and reopened.
  for (const part of fenced) {
    assert.equal((part.match(/```/g) ?? []).length % 2, 0, part);
    assert.ok(part.length <= 1900, `part is ${part.length} chars`);
  }
  assert.equal(fenced.join('\n').match(/x = 1/g)!.length, 400);
  // A wall with no break to cut on is still split rather than attached, and loses nothing.
  const unbroken = long('word'.repeat(600));
  assert.match(unbroken[0]!, /^(word){50}/);
  assert.equal(unbroken.join(''), 'word'.repeat(600));
});
test('splitMessage keeps every part inside the limit and drops no content', () => {
  const bare = (s: string) => s.replace(/^```[^\n]*$/gm, '').replace(/\s+/g, '');
  for (const text of [
    'short',
    'a'.repeat(5000),
    ('paragraph of words. '.repeat(20) + '\n\n').repeat(30),
    'lead\n```js\n' + 'const x = 1;\n'.repeat(300) + '```',
  ]) {
    const parts = splitMessage(text, 1900);
    for (const part of parts) assert.ok(part.length <= 1900, `part is ${part.length} chars`);
    assert.equal(bare(parts.join('\n')), bare(text));
  }
});

test('split messages preserve code whitespace and language while leaving inline fences literal', () => {
  const code = '    x = "keep  "  \n\n\n    y = x\n'.repeat(100) + 'TAIL';
  const parts = splitMessage('```python\n' + code + '\n```', 140);
  const recovered = parts
    .map((part) => {
      assert.ok(part.length <= 140);
      const block = /^```python\n([\s\S]*)\n```$/.exec(part);
      assert.ok(block, part);
      return block[1];
    })
    .join('');
  assert.equal(recovered, code);
  const inline = 'The literal ``` belongs inside this sentence. '.repeat(80);
  assert.equal(splitMessage(inline, 140).join(''), inline);
  const unicode = 'a'.repeat(1895) + '🧬'.repeat(1200);
  const unicodeParts = splitMessage(unicode);
  assert.equal(unicodeParts.join(''), unicode);
  assert.ok(unicodeParts.every((p) => p.isWellFormed() && p.length <= 1900));
  assert.throws(() => splitMessage('test', 0), /at least/);
});

test('split reply retries retain acknowledged parts and frozen payloads across store reopen', async (t) => {
  const f = fixture(t);
  const file = path.join(f.home, 'evidence.txt');
  fs.writeFileSync(file, 'data');
  const row = {
    id: 'split-retry',
    content: 'x'.repeat(4500),
    origin: 'notice',
    file_path: file,
  } as Outbound;
  const payloads = deliveryPayloads(row);
  const calls: string[] = [];
  await assert.rejects(
    sendDelivery(f.store, row, async (payload) => {
      calls.push(payload.nonce);
      if (calls.length === 2) throw new Error('lost acknowledgment');
      return { id: 'remote-first' };
    }),
    /lost acknowledgment/,
  );
  const reopened = new Store(f.home);
  try {
    const retry = await sendDelivery(
      reopened,
      { ...row, content: 'splitter input changed' },
      async (payload) => {
        calls.push(payload.nonce);
        assert.doesNotMatch(payload.content, /Clawstrum notice|splitter input changed/);
        return { id: `remote-${calls.length}` };
      },
    );
    assert.equal(retry, 'remote-first');
    assert.deepEqual(calls, [
      payloads[0]!.nonce,
      payloads[1]!.nonce,
      payloads[1]!.nonce,
      payloads[2]!.nonce,
    ]);
    assert.match(payloads[0]!.content, /^-# Clawstrum notice/);
    assert.ok(payloads.slice(0, -1).every((p) => p.files.length === 0));
    assert.equal(payloads.at(-1)!.files[0]!.attachment, file);
    assert.equal(
      await sendDelivery(reopened, row, async () => {
        throw new Error('already acknowledged');
      }),
      'remote-first',
    );
  } finally {
    reopened.close();
  }
});

test('automatic Claude and Codex replies normalize before matching an existing MCP answer', async (t) => {
  for (const duplicate of [false, true]) {
    const f = fixture(t);
    f.config.discord.plainDashes = true;
    const provider: Provider = {
      async run(r) {
        if (duplicate)
          f.store.outbox(f.session.id, 'First - ready.\n\nSecond.', {
            runId: r.mcp.env.CLAWSTRUM_RUN,
            key: 'tool-answer',
          });
        return 'First — ready.\\n\\nSecond.';
      },
    };
    // Select each provider once; the shared engine handles automatic answers for both.
    const selected = f.config.accounts[duplicate ? 1 : 0]!;
    f.store.exec('UPDATE sessions SET preferred_account=? WHERE id=?', selected.id, f.session.id);
    f.enqueue('reply');
    const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
    engine.tick();
    await settle(engine);
    const rows = f.store.all<{ content: string }>('SELECT content FROM outbox');
    assert.deepEqual(
      rows.map((r) => r.content),
      ['First - ready.\n\nSecond.'],
    );
    assert.equal(f.store.get<{ status: string }>('SELECT status FROM inbound')!.status, 'done');
    await engine.stop();
  }
});

test('real MCP normalizes message and caption before review, persistence and idempotency', async (t) => {
  const f = fixture(t);
  f.config.discord.plainDashes = true;
  f.enqueue('reply');
  const run = f.store.claim(f.session.id)!.run;
  f.store.exec('UPDATE runs SET config_json=? WHERE id=?', JSON.stringify(f.config), run.id);
  const client = new Client({ name: 'paragraph-test', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', path.resolve('src/cli.ts'), 'mcp'],
        env: {
          PATH: process.env.PATH!,
          CLAWSTRUM_HOME: f.home,
          CLAWSTRUM_SESSION: f.session.id,
          CLAWSTRUM_RUN: run.id,
        },
        stderr: 'pipe',
      }),
    );
    for (const text of ['First — ready.\\n\\nSecond.', 'First - ready.\n\nSecond.']) {
      const sent = await client.callTool({
        name: 'send_message',
        arguments: { text, key: 'paragraphs' },
      });
      assert.ok(!sent.isError, JSON.stringify(sent));
    }
    const file = path.join(f.session.workspace, 'literal.txt');
    fs.writeFileSync(file, String.raw`Keep \n\n literal inside this file.`);
    for (const caption of [
      'File — ready.\\n\\nSee attachment.',
      'File - ready.\n\nSee attachment.',
    ]) {
      const sent = await client.callTool({
        name: 'send_file',
        arguments: { path: file, caption, final: true, key: 'file' },
      });
      assert.ok(!sent.isError, JSON.stringify(sent));
    }
    const rows = f.store.all<{ content: string; file_path: string | null }>(
      'SELECT content,file_path FROM outbox ORDER BY rowid',
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.content, 'First - ready.\n\nSecond.');
    assert.equal(rows[1]!.content, 'File - ready.\n\nSee attachment.');
    assert.equal(fs.readFileSync(rows[1]!.file_path!, 'utf8'), fs.readFileSync(file, 'utf8'));
    assert.equal(f.store.get<{ final_sent: number }>('SELECT final_sent FROM runs')!.final_sent, 1);
  } finally {
    await client.close();
  }
});

test('plain-dash normalization preserves code, literals, links and paragraph boundaries', () => {
  const input = 'Done — now inspect cycles 1–15.';
  assert.equal(normalizeMessageText(input), input);
  assert.equal(normalizeMessageText(input, true), 'Done - now inspect cycles 1-15.');
  assert.equal(normalizeMessageText('revision—same artifact.', true), 'revision - same artifact.');
  assert.equal(normalizeMessageText('first\n—\nsecond', true), 'first\n - \nsecond');
  assert.equal(normalizeMessageText('cycles 1 – 15', true), 'cycles 1-15');
  for (const literal of [
    '`a—b`',
    '``a ` tick—b``',
    '`multiline\ncode—data`',
    '````text\n```\na—b\n````',
    '~~~~text\n~~~\na—b\n~~~~',
    '```text\nunclosed—code',
    '    indented—code',
    '\tindented—code',
    '"a—b"',
    "'a—b'",
    'https://example.org/a—b',
    '/tmp/a—b',
    './a—b',
  ]) {
    const result = normalizeMessageText(`First—next.\n${literal}`, true);
    assert.equal(result, `First - next.\n${literal}`);
    assert.equal(normalizeMessageText(result, true), result);
  }
});

test('Discord applies plain dashes to new payloads and freezes them across configuration changes', async (t) => {
  const f = fixture(t);
  const row = { id: 'dash-retry', content: 'Done — next step', origin: 'agent' } as Outbound;
  assert.equal(deliveryPayloads(row)[0]!.content, row.content);
  assert.equal(deliveryPayloads(row, true)[0]!.content, 'Done - next step');
  await assert.rejects(
    sendDelivery(
      f.store,
      row,
      async (payload) => {
        assert.equal(payload.content, 'Done - next step');
        throw new Error('lost acknowledgment');
      },
      true,
    ),
    /lost acknowledgment/,
  );
  const remote = await sendDelivery(
    f.store,
    row,
    async (payload) => {
      assert.equal(payload.content, 'Done - next step');
      return { id: 'remote' };
    },
    false,
  );
  assert.equal(remote, 'remote');
});
