import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invokesCommand, stripHeredocBodies, writeTargets } from '../src/research/shell.js';
import { invokesSbatch, validationIssues } from '../src/research/hooks.js';
import { dispatchRoleRefusal, orchestrationRefusal } from '../src/research/dispatch.js';
import {
  MAX_WRITING_BLOCKS,
  loadsWritingRules,
  writingGateRefusal,
} from '../src/research/writing.js';
import { researchSchema } from '../src/research/config.js';
import { buildContext, readSkills, skillHints } from '../src/context.js';
import { fixture } from './helpers.js';

import { replyShapeIssues } from '../src/research/shape.js';
import { workerEvidence, workerFindings } from '../src/research/validate.js';
import { Store } from '../src/store.js';

test('command recognition ignores mentions and reads through wrappers', () => {
  assert.equal(invokesSbatch('echo sbatch job.sh'), false);
  assert.equal(invokesSbatch("echo 'sbatch job.sh'"), false);
  assert.equal(invokesSbatch('grep -n sbatch scripts/*.sh'), false);
  assert.equal(invokesSbatch('# sbatch job.sh'), false);
  assert.equal(invokesSbatch('cd /tmp && /usr/bin/sbatch job.sh'), true);
  assert.equal(invokesSbatch('nohup sbatch job.sh &'), true);
  assert.equal(invokesSbatch('ACCOUNT=x nohup sbatch job.sh'), true);
  assert.equal(invokesSbatch("bash -c 'cd /tmp && sbatch job.sh'"), true);
});

test('a heredoc body is data, not a command line', () => {
  // The case that motivated this: an append whose prose begins a line with the gated word. A
  // command-position regex sees the newline before it and denies the write.
  const write = [
    "cat >> notes.md <<'ENTRY'",
    'sbatch is the submission command here',
    'ENTRY',
  ].join('\n');
  assert.equal(invokesSbatch(write), false);
  assert.equal(stripHeredocBodies(write).includes('submission command'), false);
  // A real invocation after the terminator is still seen.
  assert.equal(invokesSbatch(write + '\nsbatch job.sh'), true);
});

test('shell write forms are detected and reads are not', () => {
  assert.deepEqual(writeTargets("cat >> MEMORY.md <<'EOF'\nnote\nEOF", 'MEMORY.md'), ['MEMORY.md']);
  assert.deepEqual(writeTargets('echo x | tee -a ./MEMORY.md', 'MEMORY.md'), ['./MEMORY.md']);
  assert.deepEqual(writeTargets('sed -i s/a/b/ MEMORY.md', 'MEMORY.md'), ['MEMORY.md']);
  assert.deepEqual(writeTargets('cp /tmp/new MEMORY.md', 'MEMORY.md'), ['MEMORY.md']);
  // Reading is the first step of compacting an over-budget file, so it must stay allowed.
  assert.deepEqual(writeTargets('cat MEMORY.md', 'MEMORY.md'), []);
  assert.deepEqual(writeTargets('grep -c entry MEMORY.md > /tmp/count', 'MEMORY.md'), []);
  assert.deepEqual(writeTargets('wc -c MEMORY.md', 'CHECKPOINT.md'), []);
});

test('an over-budget memory file refuses shell writes but not shell reads', (t: any) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-harness-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new Store(home);
  t.after(() => store.close());
  const config = researchSchema.parse({ enabled: true });
  const target = path.join(home, 'MEMORY.md');
  fs.writeFileSync(target, 'x'.repeat(500));
  const limits = { budgets: { [target]: 100 }, cwd: home };

  const refused = validationIssues(
    store,
    config,
    'Bash',
    {
      command: "cat >> MEMORY.md <<'EOF'\nmore\nEOF",
    },
    limits,
  );
  assert.equal(refused.issues.length, 1);
  assert.match(refused.issues[0]!, /500 characters, 500%/);
  // Not correctable: a one-shot correction budget must not be spendable on it.
  assert.equal(refused.correctable, false);

  assert.deepEqual(
    validationIssues(store, config, 'Bash', { command: 'wc -c MEMORY.md' }, limits).issues,
    [],
  );
  // Under budget the shell write is the session's own business again.
  fs.writeFileSync(target, 'x'.repeat(50));
  assert.deepEqual(
    validationIssues(store, config, 'Bash', { command: 'echo n >> MEMORY.md' }, limits).issues,
    [],
  );
});

test('a generic subagent dispatch is refused and pointed at the configured roles', () => {
  const config = researchSchema.parse({ enabled: true });
  const generic = dispatchRoleRefusal(config, 'Task', { subagent_type: 'general-purpose' }, false);
  assert.match(generic!, /general-purpose/);
  assert.match(generic!, /research_delegate/);
  // The menu is built from the configuration, so an installation that renames a role gets its names.
  assert.match(generic!, /explorer \(haiku, low effort, no step limit\)/);
  assert.match(dispatchRoleRefusal(config, 'Task', {}, false)!, /names no subagent_type/);
  assert.match(dispatchRoleRefusal(config, 'Task', {}, true)!, /does not spawn further subagents/);
  assert.equal(dispatchRoleRefusal(config, 'Bash', { command: 'ls' }, false), null);
  // Nothing to route a dispatch to means nothing to say about it.
  const roleless = researchSchema.parse({ enabled: true, workers: { roles: {} } });
  assert.equal(dispatchRoleRefusal(roleless, 'Task', {}, false), null);
});

test('an orchestration script is refused outright, with the limits it would bypass named', () => {
  const config = researchSchema.parse({ enabled: true });
  const script = "export const meta = {}\nphase('Find')\nphase('Verify')\n";
  const refused = orchestrationRefusal(config, 'Workflow', { script });
  assert.match(refused!, /\(2 phases\)/);
  // The numbers come from the configuration, so an installation that raises them says so.
  assert.match(refused!, /maxConcurrent limit of 20/);
  assert.doesNotMatch(refused!, /worker timeout/);
  assert.match(refused!, /progress checks/);
  assert.match(refused!, /research_delegate/);
  // A script the regex cannot count phases in is still refused, without the count.
  assert.match(orchestrationRefusal(config, 'Workflow', {})!, /^Refusing this workflow:/);
  assert.equal(orchestrationRefusal(config, 'Task', { subagent_type: 'explorer' }), null);
  const roleless = researchSchema.parse({ enabled: true, workers: { roles: {} } });
  assert.equal(orchestrationRefusal(roleless, 'Workflow', { script }), null);
});

test('a manuscript write is refused until the rules file has been read', () => {
  const rules = ['/w/WRITING.md'];
  const prose = 'x'.repeat(400);
  const base = { rulesPaths: rules, satisfied: false, blocksSoFar: 0 };
  const refused = writingGateRefusal({
    ...base,
    toolName: 'Write',
    target: '/w/paper.tex',
    payload: prose,
  });
  assert.match(refused!, /\/w\/WRITING\.md/);
  assert.match(refused!, /then re-issue the write/);
  // Markdown prose is most of what a session writes all day, so it is not this gate's business.
  assert.equal(
    writingGateRefusal({ ...base, toolName: 'Write', target: '/w/notes.md', payload: prose }),
    null,
  );
  // A \label fix is mechanical, and spending a refusal on it would disarm the gate for the prose.
  assert.equal(
    writingGateRefusal({
      ...base,
      toolName: 'Edit',
      target: '/w/paper.tex',
      payload: 'x'.repeat(9),
    }),
    null,
  );
  assert.equal(
    writingGateRefusal({
      ...base,
      satisfied: true,
      toolName: 'Write',
      target: '/w/paper.tex',
      payload: prose,
    }),
    null,
  );
  // No rules file means no opinion, and the ceiling means it can never wedge a run.
  assert.equal(
    writingGateRefusal({
      ...base,
      rulesPaths: [],
      toolName: 'Write',
      target: '/w/paper.tex',
      payload: prose,
    }),
    null,
  );
  assert.equal(
    writingGateRefusal({
      ...base,
      blocksSoFar: MAX_WRITING_BLOCKS,
      toolName: 'Write',
      target: '/w/paper.tex',
      payload: prose,
    }),
    null,
  );
});

test('reading the rules, or a writing skill body, satisfies the gate', () => {
  const rules = ['/w/WRITING.md'];
  assert.equal(loadsWritingRules('Read', { file_path: 'WRITING.md' }, rules, '/w'), true);
  assert.equal(
    loadsWritingRules('Read', { file_path: '/w/WRITING.md' }, rules, '/elsewhere'),
    true,
  );
  assert.equal(
    loadsWritingRules('Read', { file_path: '/w/skills/scientific-writing/SKILL.md' }, rules, '/w'),
    true,
  );
  assert.equal(loadsWritingRules('Skill', { skill: 'scientific-writing' }, rules, '/w'), true);
  assert.equal(loadsWritingRules('Read', { file_path: '/w/paper.tex' }, rules, '/w'), false);
  assert.equal(loadsWritingRules('Bash', { command: 'cat /w/WRITING.md' }, rules, '/w'), false);
});

test('a worker result is checked against the event log it did not write', (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'EVENTS.jsonl');
  const real = path.join(dir, 'notes.md');
  fs.writeFileSync(real, 'measured\n');

  // No log at all is the worst case and must not throw: a worker that died before its first event.
  assert.deepEqual(workerEvidence(path.join(dir, 'absent.jsonl'), [real]), {
    toolEvents: 0,
    suppliedPaths: [real],
    suppliedPathsSeen: 0,
  });

  fs.writeFileSync(
    log,
    [
      JSON.stringify({ at: 1, type: 'usage', detail: '{"input":1}' }),
      JSON.stringify({ at: 2, type: 'activity', detail: `{"type":"tool_use","path":"${real}"}` }),
    ].join('\n') + '\n',
  );
  const evidence = workerEvidence(log, [real]);
  assert.equal(evidence.toolEvents, 1);
  assert.equal(evidence.suppliedPathsSeen, 1);
  assert.deepEqual(workerFindings(`The value is in ${real}`, evidence), []);

  // A confident result with no tool work behind it is the failure the checks exist for.
  assert.match(
    workerFindings('The rate is 0.31.', { ...evidence, toolEvents: 0 }).join('\n'),
    /no recorded tool activity/,
  );
  assert.match(
    workerFindings('The rate is 0.31.', { ...evidence, suppliedPathsSeen: 0 }).join('\n'),
    /supplied paths/,
  );

  // Cited paths are checked for existence, and a URL is not a path.
  const cited = workerFindings(
    `Read ${real} and ${dir}/ghost.md, see https://arxiv.org/abs/2301.12345`,
    evidence,
  ).join('\n');
  assert.match(cited, /ghost\.md/);
  assert.doesNotMatch(cited, /arxiv/);
});

test('a skill is suggested from the current input only, and only where it declared triggers', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name: string, body: string) => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'SKILL.md'), body);
  };
  write(
    'preflight',
    '---\ndescription: check a job before submitting\ntriggers: sbatch, submit\n---\n',
  );
  write(
    'theory',
    '---\ndescription: derivations\ntriggers: derive\nnot_for: estimates\nexamples: a | b |  | c | d | e | f\n---\n',
  );
  // No triggers: this skill can only ever be chosen by the model reading the inventory.
  write('plotting', '---\ndescription: figures, plots and sbatch mentions in prose\n---\n');

  const skills = readSkills([root]);
  assert.deepEqual(
    skills.map((s) => s.name),
    ['plotting', 'preflight', 'theory'],
  );
  assert.equal(skills[2]!.notFor, 'estimates');
  assert.deepEqual(skills[2]!.examples, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(skills[0]!.notFor, undefined);
  assert.equal(skills[0]!.examples, undefined);
  const hint = skillHints(skills, 'can you sbatch the sweep');
  assert.match(hint, /Skill `preflight` was loaded for this turn by keyword match/);
  assert.match(hint, /matched sbatch\)/);
  // A description mentioning the same word is not a match, or every skill matches everything.
  assert.doesNotMatch(hint, /plotting/);
  assert.doesNotMatch(hint, /theory/);
  // Whole-word only: a longer word that contains a trigger is not that trigger.
  assert.equal(skillHints(skills, 'resubmitted the derived quantity'), '');
  assert.equal(skillHints([], 'sbatch'), '');
});

test('the keyword fallback loads the top match and points at the rest', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name: string, body: string) => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'SKILL.md'), body);
  };
  write('alpha', '---\ndescription: a\ntriggers: sbatch, sweep\n---\nAlpha body.');
  write('beta', '---\ndescription: b\ntriggers: sbatch\n---\nBeta body.');
  write('gamma', '---\ndescription: c\ntriggers: sweep\n---\nGamma body.');
  const skills = readSkills([root]);
  const hint = skillHints(skills, 'sbatch the sweep');
  assert.ok(
    hint.startsWith(
      'Skill `alpha` was loaded for this turn by keyword match (the skill router was off or did not answer; matched sbatch, sweep). A keyword match can be wrong; if this skill does not fit the request, ignore it rather than working to fit it.\n' +
        `Base directory for this skill: ${path.join(root, 'alpha')}\n\nAlpha body.`,
    ),
  );
  assert.doesNotMatch(hint, /description:|triggers:/);
  assert.match(hint, /can be wrong; where it is, ignore it rather than working to fit it\./);
  assert.ok(hint.includes(`- beta (matched sbatch): read ${skills[1]!.file}`));
  assert.ok(hint.includes(`- gamma (matched sweep): read ${skills[2]!.file}`));
  assert.doesNotMatch(hint, /Beta body|Gamma body/);
  assert.doesNotMatch(hint, /- alpha/);

  // An unreadable top file leaves the pointer list exactly as it was.
  const missing = skills.map((s) =>
    s.name === 'alpha' ? { ...s, file: path.join(root, 'gone', 'SKILL.md') } : s,
  );
  assert.equal(
    skillHints(missing, 'sbatch the sweep'),
    [
      'Skills whose triggers match the current input. This is a keyword match on the input text, so it',
      'can be wrong; where it is, ignore it rather than working to fit it.',
      `- alpha (matched sbatch, sweep): read ${path.join(root, 'gone', 'SKILL.md')}`,
      `- beta (matched sbatch): read ${skills[1]!.file}`,
      `- gamma (matched sweep): read ${skills[2]!.file}`,
    ].join('\n'),
  );

  // A long body is clipped with the same marker the skill router uses.
  write('alpha', '---\ntriggers: sbatch\n---\n' + 'x'.repeat(13000));
  const long = skillHints(readSkills([root]), 'sbatch');
  assert.ok(long.includes('x'.repeat(12000) + `\n[truncated; full file: ${skills[0]!.file}]`));
  assert.doesNotMatch(long, /x{12001}/);
});

test('an outgoing reply is measured against its ceilings, and nothing else about its shape', () => {
  const limits = { maxLines: 25, maxChars: 2000 };
  assert.deepEqual(replyShapeIssues('one short answer\n', limits), []);
  // A trailing newline is not a line, or every reply would be one over.
  assert.deepEqual(replyShapeIssues('a\n'.repeat(25), limits), []);
  assert.match(
    replyShapeIssues('a\n'.repeat(26), limits).join(),
    /26 lines against a ceiling of 25/,
  );
  assert.match(replyShapeIssues('x'.repeat(2001), limits).join(), /2001 characters/);
  // Structure is not judged: a compact briefing with bullets and labels passes untouched.
  assert.deepEqual(replyShapeIssues('*best* run\n• 0.88 accuracy\n• 1 layer\n', limits), []);
  // Either half is disabled by zeroing it, and both zeroed removes the check.
  assert.equal(replyShapeIssues('a\n'.repeat(400), { maxLines: 0, maxChars: 2000 }).length, 0);
  assert.equal(replyShapeIssues('a\n'.repeat(400), { maxLines: 0, maxChars: 0 }).length, 0);
});

test('recursion through -c payloads is bounded and mentions stay mentions', () => {
  assert.equal(invokesCommand('bash -c "sh -c \'sbatch job.sh\'"', 'sbatch'), true);
  assert.equal(invokesCommand('python train.py', 'python'), true);
  assert.equal(invokesCommand('ls /usr/bin/python', 'python'), false);
});
