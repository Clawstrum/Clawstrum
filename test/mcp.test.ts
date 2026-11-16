import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../src/store.js';
import { saveConfig, readConfig } from '../src/config.js';
import { localStamp } from '../src/context.js';

// A zone unlike any host's, with a half-hour offset, so a result in host time or UTC fails.
const ZONE = 'Asia/Kolkata';
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+05:30$/;
const json = (r: any) => JSON.parse(r.content[0].text);

test('MCP tools operate through a real stdio process and persist files, checkpoints and idempotent follow-ups', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-mcp-'));
  const store = new Store(home);
  const session = store.ensureSession('123456');
  saveConfig(home, {
    version: 1,
    discord: { ownerIds: ['123456'] },
    accounts: [{ id: 'a', provider: 'codex', home: 'accounts/a' }],
    runtime: { timezone: ZONE },
  });
  store.enqueue({ id: 'm', sessionId: session.id, author: 'owner', content: 'Task' });
  const run = store.claim(session.id)!.run;
  const snapshot = JSON.stringify(readConfig(home));
  store.exec('UPDATE runs SET config_json=? WHERE id=?', snapshot, run.id);
  // The running daemon owns a snapshot; broken edits must not disable its MCP tools.
  fs.writeFileSync(path.join(home, 'config.json'), '{invalid json');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.resolve('src/cli.ts'), 'mcp'],
    env: {
      PATH: process.env.PATH!,
      CLAWSTRUM_HOME: home,
      CLAWSTRUM_SESSION: session.id,
      CLAWSTRUM_RUN: run.id,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'clawstrum-test', version: '1' });
  try {
    await client.connect(transport);
    const listing = await client.listTools();
    assert.ok(listing.tools.some((t) => t.name === 'send_message'));
    const quiet = await client.callTool({
      name: 'send_message',
      arguments: { text: 'CLAWSTRUM_QUIET', key: 'quiet', final: true },
    });
    assert.equal(JSON.parse((quiet.content as any)[0].text).queued, false);
    assert.equal(store.all('SELECT * FROM outbox').length, 0);
    assert.equal(store.hasFinal(run.id), false);
    assert.ok(listing.tools.some((t) => t.name === 'checkpoint'));
    assert.ok(listing.tools.some((t) => t.name === 'watch'));
    const watchInput = {
      action: 'add',
      key: 'result-file',
      spec: { condition: { type: 'file', path: 'result.txt' }, message: 'Read the result' },
    };
    const watch = await client.callTool({ name: 'watch', arguments: watchInput });
    assert.ok(!watch.isError);
    const watchId = JSON.parse((watch.content as any)[0].text).id;
    assert.match(json(watch).createdAt, STAMP);
    assert.equal(
      JSON.parse(
        ((await client.callTool({ name: 'watch', arguments: watchInput })).content as any)[0].text,
      ).id,
      watchId,
    );
    assert.equal(
      JSON.parse(
        (
          (await client.callTool({ name: 'watch', arguments: { action: 'list' } })).content as any
        )[0].text,
      ).length,
      1,
    );
    assert.ok(
      !(await client.callTool({ name: 'watch', arguments: { action: 'cancel', id: watchId } }))
        .isError,
    );
    const checkpoint = await client.callTool({
      name: 'checkpoint',
      arguments: { markdown: 'Job 17 already submitted.' },
    });
    assert.ok(!checkpoint.isError);
    assert.match(fs.readFileSync(path.join(session.workspace, 'AGENTS.md'), 'utf8'), /17/);
    const memory = await client.callTool({ name: 'memory_update', arguments: {} });
    const memorySnapshot = JSON.parse((memory.content as any)[0].text);
    const changed = await client.callTool({
      name: 'memory_update',
      arguments: {
        section: 'Working understanding',
        markdown: 'Current protocol BETA; prior detail is archived.',
        revision: memorySnapshot.revision,
      },
    });
    assert.ok(!changed.isError);
    assert.ok(
      (
        await client.callTool({
          name: 'memory_update',
          arguments: {
            section: 'Working understanding',
            markdown: 'STALE',
            revision: memorySnapshot.revision,
          },
        })
      ).isError,
    );
    const search = await client.callTool({
      name: 'history',
      arguments: { action: 'search', query: 'BETA' },
    });
    const records = JSON.parse((search.content as any)[0].text).records;
    assert.ok(records.length);
    assert.match(records[0].at, STAMP);
    const inAnHour = localStamp(Date.now() + 3600000, ZONE);
    const later = await client.callTool({
      name: 'history',
      arguments: { action: 'search', query: 'BETA', from: inAnHour },
    });
    assert.equal(json(later).records.length, 0, 'from takes a stamp as results show it');
    const vague = await client.callTool({
      name: 'history',
      arguments: { action: 'search', query: 'BETA', from: 'yesterday' },
    });
    assert.equal(vague.isError, true);
    const record = await client.callTool({
      name: 'history',
      arguments: { action: 'read', id: records[0].id, chars: 20 },
    });
    assert.ok(JSON.parse((record.content as any)[0].text).nextOffset > 0);
    for (let i = 0; i < 2; i++)
      await client.callTool({
        name: 'send_message',
        arguments: { text: 'Finished.', final: true, key: 'answer' },
      });
    assert.equal(store.all('SELECT * FROM outbox').length, 1);
    assert.equal(store.get<any>('SELECT final_sent FROM runs WHERE id=?', run.id).final_sent, 1);
    const source = path.join(session.workspace, 'result.txt');
    fs.writeFileSync(source, 'immutable result');
    for (let i = 0; i < 2; i++)
      await client.callTool({
        name: 'send_file',
        arguments: { path: source, caption: 'Result', key: 'file' },
      });
    fs.writeFileSync(source, 'later mutation');
    const file = store.get<any>(
      'SELECT file_path FROM outbox WHERE file_path IS NOT NULL',
    ).file_path;
    assert.equal(fs.readFileSync(file, 'utf8'), 'immutable result');
    assert.equal(fs.readdirSync(path.join(home, 'outgoing')).length, 1);
    // The bot token lives in H/.env.
    const env = path.join(home, '.env');
    fs.writeFileSync(env, 'PLACEHOLDER=1\n');
    const refused = await client.callTool({
      name: 'send_file',
      arguments: { path: env, key: 'env' },
    });
    assert.equal(refused.isError, true);
    assert.match((refused.content as any)[0].text, /does not attach/);
    assert.equal(fs.readdirSync(path.join(home, 'outgoing')).length, 1);
    const schedule = new Date(Date.now() + 60000).toISOString();
    for (let i = 0; i < 2; i++)
      await client.callTool({
        name: 'schedule_task',
        arguments: { prompt: 'Check job 17', kind: 'once', schedule, key: 'job-17' },
      });
    assert.equal(store.all('SELECT * FROM tasks').length, 1);
    const task = store.get<any>('SELECT id FROM tasks')!;
    const listed = await client.callTool({ name: 'list_tasks', arguments: {} });
    assert.equal((listed.content as any)[0].text.includes(task.id), true);
    assert.equal(json(listed)[0].next_run, localStamp(Date.parse(schedule), ZONE));
    assert.match(json(listed)[0].created_at, STAMP);
    const status = await client.callTool({ name: 'status', arguments: {} });
    assert.ok(!status.isError);
    assert.match(json(status).runs[0].started_at, STAMP);
    assert.ok(
      !(await client.callTool({ name: 'cancel_task', arguments: { id: task.id } })).isError,
    );
    assert.equal(store.get<any>('SELECT status FROM tasks').status, 'cancelled');
    const conflict = await client.callTool({
      name: 'send_message',
      arguments: { text: 'Changed answer', final: true, key: 'answer' },
    });
    assert.equal(conflict.isError, true);
    const changedFile = await client.callTool({
      name: 'send_file',
      arguments: { path: source, caption: 'Result', key: 'file' },
    });
    assert.equal(changedFile.isError, true);
    assert.equal(fs.readdirSync(path.join(home, 'outgoing')).length, 1);
    assert.equal(fs.statSync(path.join(session.workspace, 'AGENTS.md')).mode & 0o777, 0o600);
    store.enqueue({
      id: 'post-final',
      sessionId: session.id,
      author: 'owner',
      content: 'Follow-up while background work runs',
    });
    store.transaction(() => {
      store.reopenReply(run, 'post-final');
      store.exec(
        "UPDATE inbound SET status='running',batch_id=? WHERE id='post-final'",
        run.logical_id,
      );
      run.message_ids = JSON.stringify(['m', 'post-final']);
      store.exec('UPDATE runs SET message_ids=? WHERE id=?', run.message_ids, run.id);
    });
    const reopened = await client.callTool({
      name: 'send_message',
      arguments: { text: 'New answer in the same provider process', final: true, key: 'answer' },
    });
    assert.ok(!reopened.isError, 'a live MCP process reads the new reply scope without restarting');
    assert.equal(store.all('SELECT * FROM outbox').length, 3);
    await client.close();
    store.finish(run, 'done');
    store.enqueue({ id: 'm2', sessionId: session.id, author: 'owner', content: 'A new request' });
    const nextRun = store.claim(session.id)!.run;
    store.exec('UPDATE runs SET config_json=? WHERE id=?', snapshot, nextRun.id);
    const nextClient = new Client({ name: 'clawstrum-test', version: '1' });
    try {
      await nextClient.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', path.resolve('src/cli.ts'), 'mcp'],
          env: {
            PATH: process.env.PATH!,
            CLAWSTRUM_HOME: home,
            CLAWSTRUM_SESSION: session.id,
            CLAWSTRUM_RUN: nextRun.id,
          },
          stderr: 'pipe',
        }),
      );
      await nextClient.callTool({
        name: 'send_message',
        arguments: { text: 'Second answer', final: true, key: 'answer' },
      });
      assert.ok(
        !(
          await nextClient.callTool({
            name: 'schedule_task',
            arguments: { prompt: 'Check again', kind: 'once', schedule, key: 'job-17' },
          })
        ).isError,
      );
      assert.equal(
        store.all('SELECT * FROM tasks').length,
        2,
        'A new input can reuse a completed/cancelled task key',
      );
      assert.equal(
        store.all('SELECT * FROM outbox').length,
        4,
        'The same tool key on a new request must not suppress its answer',
      );
      store.finish(nextRun, 'done');
      assert.equal(
        (await nextClient.callTool({ name: 'checkpoint', arguments: { markdown: 'Late write' } }))
          .isError,
        true,
      );
    } finally {
      await nextClient.close();
    }
  } finally {
    await client.close();
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
