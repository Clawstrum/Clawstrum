#!/usr/bin/env node
// Install the release tarball with nested, production-only dependencies; no model or Discord calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = process.cwd();
delete process.env.JEV_API_KEY;
delete process.env.TYPESAFE_API_KEY;
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-package-')));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${executable} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`,
  );
  return result.stdout;
}
let store;
let engine;
try {
  const output = command(npm, ['pack', '--json'], { cwd: root });
  const packed = JSON.parse(output.slice(output.indexOf('[\n')))[0];
  for (const document of [
    'research-continuity',
    'performance',
    'customize',
    'configuration',
    'cli',
  ])
    assert.ok(packed.files.some((f) => f.path === `docs/${document}.md`));
  assert.ok(
    !packed.files.some((f) => /docs\/[^/]*-review\.md$/.test(f.path)),
    'Internal review artifacts must stay out of the install package',
  );
  const archive = path.join(root, packed.filename);
  command(
    npm,
    [
      'install',
      '--omit=dev',
      '--install-strategy=nested',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      archive,
    ],
    { cwd: temporary },
  );
  const installed = path.join(temporary, 'node_modules', 'clawstrum');
  const cli = path.join(temporary, 'node_modules', '.bin', 'clawstrum');
  const home = path.join(temporary, 'state');
  const env = { ...process.env, CLAWSTRUM_HOME: home };
  assert.equal(
    command(process.execPath, [cli, '--version'], { env }).trim(),
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version,
  );
  command(process.execPath, [cli, 'init', '--owner', '123456'], { env });
  const load = (name) => import(pathToFileURL(path.join(installed, 'dist', name + '.js')).href);
  const { Store } = await load('store');
  const { Engine } = await load('engine');
  const { readConfig, saveConfig } = await load('config');
  const { runtimeCommand } = await load('runtime');
  const { parseMemory } = await load('memory');
  const seededPolicy = parseMemory(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'));
  const shippedPolicy = parseMemory(
    fs.readFileSync(path.join(installed, 'templates', 'AGENTS.md'), 'utf8'),
  );
  assert.equal(seededPolicy.instructions, shippedPolicy.instructions);
  assert.match(seededPolicy.instructions, /one short non-final send_message/);
  assert.match(seededPolicy.memory, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const config = readConfig(home);
  assert.equal(config.research.enabled, true);
  assert.equal(config.runtime.consolidation.enabled, true);
  assert.deepEqual(config.runtime.consolidation.models, { claude: 'sonnet' });
  assert.equal(config.research.slurm.enabled, true);
  assert.equal(config.research.holdBackgroundTasks, true);
  assert.equal(config.discord.plainDashes, true);
  for (const provider of ['claude', 'codex']) {
    const runtime = runtimeCommand({ id: 'check', provider, home: path.join(home, provider) });
    assert.ok(command(runtime.command, [...runtime.args, '--version']).trim());
  }
  const fake = path.join(temporary, 'codex.mjs');
  const record = path.join(temporary, 'argv.json');
  const release = path.join(temporary, 'release');
  fs.writeFileSync(
    fake,
    `#!${process.execPath}\nimport fs from 'node:fs';
    if(process.argv.includes('--version')){process.stdout.write('codex-cli 0.154.0\\n');process.exit(0);}
    const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    const waitForRelease=(done)=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);done();}},20);};
    if(process.argv.includes('app-server')) {
      const {createInterface}=await import('node:readline');let mcp;
      for await(const line of createInterface({input:process.stdin})) {
        const m=JSON.parse(line);
        if(m.method==='initialize')send({id:m.id,result:{userAgent:'package-test'}});
        if(m.method==='thread/start'||m.method==='thread/resume') {mcp=m.params.config.mcp_servers.clawstrum;send({id:m.id,result:{thread:{id:'packaged-thread'}}});}
        if(m.method==='turn/start') {
          const args=[...process.argv.slice(2),...Object.entries(mcp).flatMap(([key,value])=>key==='env'?Object.entries(value).map(([k,v])=>'mcp_servers.clawstrum.env.'+k+'='+JSON.stringify(v)):['mcp_servers.clawstrum.'+key+'='+JSON.stringify(value)])];
          fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args,prompt:m.params.input[0].text}));
          send({id:m.id,result:{turn:{id:'package-turn',status:'inProgress',items:[]}}});
          send({method:'turn/started',params:{threadId:'packaged-thread',turn:{id:'package-turn',status:'inProgress',items:[]}}});
          waitForRelease(()=>{
            send({method:'item/completed',params:{threadId:'packaged-thread',turnId:'package-turn',item:{id:'answer',type:'agentMessage',text:'PACKAGE_OK'}}});
            send({method:'turn/completed',params:{threadId:'packaged-thread',turn:{id:'package-turn',status:'completed',items:[]}}});
          });
        }
      }
    } else {
      let prompt='';for await(const c of process.stdin)prompt+=c;
      fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),prompt}));
      send({type:'thread.started',thread_id:'packaged-thread'});send({type:'turn.started'});
      waitForRelease(()=>{send({type:'item.completed',item:{id:'answer',type:'agent_message',text:'PACKAGE_OK'}});send({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}});});
    }`,
    { mode: 0o700 },
  );
  config.research.enabled = true;
  config.research.validation = 'strict';
  config.accounts[0].executable = fake;
  config.runtime.debounceMs = config.runtime.debounceMaxMs = 0;
  saveConfig(home, config);
  store = new Store(home);
  engine = new Engine(config, store);
  const session = store.ensureSession('123456');
  store.enqueue({
    id: 'package-input',
    sessionId: session.id,
    author: 'test',
    content: 'Package check',
  });
  engine.start();
  engine.tick();
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(record) && Date.now() < deadline) await delay(50);
  assert.ok(fs.existsSync(record), 'Compiled worker must run the selected CLI');
  const invocation = JSON.parse(fs.readFileSync(record, 'utf8'));
  const overrides = Object.fromEntries(
    invocation.args
      .filter((a) => a.startsWith('mcp_servers.clawstrum.'))
      .map((a) => {
        const equals = a.indexOf('=');
        return [a.slice(0, equals), JSON.parse(a.slice(equals + 1))];
      }),
  );
  const args = overrides['mcp_servers.clawstrum.args'];
  assert.deepEqual(args, [path.join(installed, 'dist', 'cli.js'), 'mcp']);
  const mcpEnv = Object.fromEntries(
    Object.entries(overrides)
      .filter(([key]) => key.startsWith('mcp_servers.clawstrum.env.'))
      .map(([key, value]) => [key.slice('mcp_servers.clawstrum.env.'.length), value]),
  );
  // A broken on-disk edit must not affect the already-running engine's MCP snapshot.
  fs.writeFileSync(path.join(home, 'config.json'), '{broken');
  const client = new Client({ name: 'package-test', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: overrides['mcp_servers.clawstrum.command'],
        args,
        env: { PATH: process.env.PATH, ...mcpEnv },
        stderr: 'pipe',
      }),
    );
    assert.ok(
      (await client.listTools()).tools.some((tool) => tool.name === 'research_worker_review'),
    );
    assert.ok(
      !(await client.listTools()).tools.some((tool) => tool.name === 'research_worker_update'),
    );
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'research_manifest'));
    const citation = await client.callTool({
      name: 'research_citation',
      arguments: { action: 'scan', text: 'Example (2024), doi:10.1234/unresolved-fixture' },
    });
    assert.ok(!citation.isError);
    assert.equal(JSON.parse(citation.content[0].text).findings[0].kind, 'unresolved');
    const held = await client.callTool({
      name: 'send_message',
      arguments: {
        text: 'Example (2024), doi:10.1234/unresolved-fixture',
        final: true,
        key: 'held-proposal',
      },
    });
    assert.equal(held.isError, true);
    assert.equal(store.all('SELECT * FROM outbox').length, 0);
    const checkpoint = await client.callTool({
      name: 'checkpoint',
      arguments: { markdown: 'Packaged MCP verified' },
    });
    assert.ok(!checkpoint.isError);
    const note = await client.callTool({
      name: 'research_note',
      arguments: {
        kind: 'method',
        title: 'Installed package',
        body: 'Production-only package test',
        key: 'package',
      },
    });
    assert.ok(!note.isError);
    assert.match(
      fs.readFileSync(path.join(session.workspace, 'AGENTS.md'), 'utf8'),
      /Production-only package test/,
    );
    assert.ok(!fs.existsSync(path.join(session.workspace, 'research', 'RECORDS.md')));
    assert.ok(
      !(await client.callTool({ name: 'research_status', arguments: { collection: 'notes' } }))
        .isError,
    );
    const queued = await client.callTool({
      name: 'research_delegate',
      arguments: {
        role: 'explorer',
        brief: 'Return a bounded test result',
        context: 'Package smoke test: the queued subagent only needs to return a bounded result.',
        key: 'worker',
      },
    });
    assert.ok(!queued.isError);
  } finally {
    await client.close();
  }
  fs.writeFileSync(release, 'finish');
  await Promise.all([...engine.active.values()].map((s) => s.promise));
  assert.equal(store.get('SELECT content FROM outbox').content, 'PACKAGE_OK');
  assert.equal(store.get('SELECT status FROM inbound').status, 'done');
  engine.researchWorkers.tick();
  await Promise.all([...engine.researchWorkers.active.values()].map((s) => s.promise));
  const researchWorker = store.get('SELECT * FROM delegations');
  assert.equal(researchWorker.status, 'completed');
  assert.equal(fs.readFileSync(researchWorker.result_path, 'utf8').trim(), 'PACKAGE_OK');
  assert.equal(store.get("SELECT count(*) n FROM inbound WHERE kind='task'").n, 1);
  assert.ok(fs.existsSync(path.join(installed, 'docs', 'research.md')));
  assert.ok(fs.existsSync(path.join(installed, 'docs', 'orchestration.md')));
  assert.ok(fs.existsSync(path.join(home, 'skills', 'theory', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, 'skills', 'onboarding', 'WRITING.example.md')));
  assert.ok(fs.existsSync(path.join(installed, 'docs', 'hooks-and-gates.md')));
  assert.ok(fs.existsSync(path.join(installed, 'docs', 'workflows.md')));
  assert.ok(fs.existsSync(path.join(installed, 'templates', 'skills', 'self-review', 'SKILL.md')));
  assert.ok(
    fs.existsSync(path.join(installed, 'templates', 'skills', 'decision-hygiene', 'SKILL.md')),
  );
  saveConfig(home, config); // Standalone administration reads the on-disk configuration.
  assert.equal(config.groups.enabled, true);
  assert.equal(config.groups.reviewer.enabled, true);
  assert.ok(fs.existsSync(path.join(installed, 'docs', 'groups.md')));
  const profiling = JSON.parse(
    command(process.execPath, [cli, 'performance', session.id, '--limit', '1'], { env }),
  );
  const usageProfile = JSON.parse(command(process.execPath, [cli, 'usage', 'profile'], { env }));
  assert.equal(usageProfile.observed.roles.find((row) => row.role === 'lead').invocations, 1);
  assert.equal(usageProfile.observed.roles.find((row) => row.role === 'explorer').invocations, 1);
  assert.equal(usageProfile.observed.roles.find((row) => row.role === 'checker').invocations, 0);
  assert.ok(fs.existsSync(path.join(installed, 'docs', 'usage.md')));
  assert.equal(profiling.scope, session.id);
  assert.ok(Array.isArray(profiling.runs));
  assert.ok('heartbeatAgeMs' in profiling.health);
  command(process.execPath, [cli, 'group', 'create', 'science', '--name', 'Science'], { env });
  command(
    process.execPath,
    [cli, 'group', 'join', 'science', session.id, '--role', 'Package test'],
    { env },
  );
  const publication = path.join(temporary, 'publication.json');
  fs.writeFileSync(
    publication,
    JSON.stringify({
      action: 'publish',
      key: 'package-board',
      entry: {
        kind: 'finding',
        subject: 'PACKAGE_GROUP_OK',
        summary: 'Installed package group tools work',
      },
    }),
  );
  command(process.execPath, [cli, 'group', 'board', session.id, '--input', publication], { env });
  const board = JSON.parse(command(process.execPath, [cli, 'group', 'status', 'science'], { env }));
  assert.equal(board[0].entries[0].spec.summary, 'Installed package group tools work');
  assert.match(
    fs.readFileSync(path.join(home, 'groups', 'science', 'AGENTS.md'), 'utf8'),
    /PACKAGE_GROUP_OK/,
  );
  const history = JSON.parse(
    command(
      process.execPath,
      [
        cli,
        'history',
        session.id,
        '--group',
        'science',
        '--action',
        'search',
        '--query',
        'PACKAGE_GROUP_OK',
      ],
      { env },
    ),
  );
  assert.ok(history.records.length);
  const backupDirectory = path.join(temporary, 'backups');
  const snapshot = JSON.parse(
    command(process.execPath, [cli, 'backup', 'live', backupDirectory], { env }),
  );
  const verified = JSON.parse(
    command(process.execPath, [cli, 'backup', 'verify', snapshot.directory], { env }),
  );
  assert.equal(verified.sha256, snapshot.manifest.sha256);
  const decisions = path.join(temporary, 'decisions.md');
  fs.writeFileSync(decisions, '- 2026-09-17 [package.v1]: Test the installed artifact.\n');
  assert.equal(
    JSON.parse(command(process.execPath, [cli, 'decisions', 'lint', decisions], { env })).findings
      .length,
    0,
  );
  const watchInput = path.join(temporary, 'watch.json');
  fs.writeFileSync(
    watchInput,
    JSON.stringify({ condition: { type: 'file', path: 'result.json' }, message: 'Inspect result' }),
  );
  const watch = JSON.parse(
    command(
      process.execPath,
      [cli, 'watch', 'add', session.id, '--key', 'package-result', '--input', watchInput],
      { env },
    ),
  );
  assert.equal(
    JSON.parse(command(process.execPath, [cli, 'watch', 'list', session.id], { env }))[0].id,
    watch.id,
  );
  assert.equal(
    JSON.parse(command(process.execPath, [cli, 'watch', 'cancel', watch.id], { env })).cancelled,
    true,
  );
  const reviewDay = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const collected = JSON.parse(
    command(process.execPath, [cli, 'review', 'collect', '--date', reviewDay], { env }),
  );
  assert.ok(fs.existsSync(path.join(collected[0], 'MESSAGES.json')));
  const units = JSON.parse(
    command(process.execPath, [cli, 'service', 'backup', '--directory', backupDirectory], { env }),
  );
  assert.match(units.timer, /clawstrum-backup.service/);
  assert.ok(fs.existsSync(path.join(installed, 'docs', 'live-steering.md')));
  console.log(
    JSON.stringify(
      {
        archive,
        sha512: packed.integrity,
        installed: true,
        dependencyLayout: 'nested',
        developmentDependencies: false,
        checks: [
          'installed CLI',
          'init',
          'installed editable AGENTS policy seed and generated history paths',
          'bundled Claude and Codex runtimes',
          'compiled engine and worker',
          'Codex app-server lead and research worker subprocesses',
          'compiled MCP command and snapshot',
          'final outbox',
          'compiled research tools and durable notes',
          'installed group administration, publication, scoped history and template',
          'compiled citation scan and bounded outgoing review',
          'daemon-owned research worker and parent wake',
          'live snapshot and checksum verification',
          'decision lint and optional skill templates',
          'watch creation, listing and cancellation',
          'review snapshot and evidence artifacts',
          'backup service and timer generation',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (engine) await engine.stop();
  if (store) store.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
