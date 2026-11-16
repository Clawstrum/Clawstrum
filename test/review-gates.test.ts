import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './helpers.js';
import { researchSchema } from '../src/research/config.js';
import { replyCorrections, replyFeedback, reviewReply } from '../src/research/replies.js';
import { researchHooks } from '../src/research/hooks.js';
import { researchWake } from '../src/research/records.js';
import {
  MAX_REVIEW_BLOCKS,
  gitAddPaths,
  isGitPush,
  paperChangeTriggers,
  paperChangesVsUpstream,
  paperPushDecision,
  pushRepoDir,
  reviewSnapshot,
  type PaperPushState,
} from '../src/research/paper-push.js';
import type { ProviderRequest } from '../src/types.js';

// With an artifact, the result carries its repository and snapshot tree as workers.ts records them.
const checkerResult = (f: ReturnType<typeof fixture>, id = 'w-checker', artifact?: string) =>
  f.store.event(f.session.id, null, 'research_checker_result', {
    id,
    artifact,
    ...(artifact ? reviewSnapshot(artifact) : {}),
    objections: 3,
    verified: 2,
    moved: 0,
    unverified: 1,
    unbacked: 0,
    noObjection: false,
  });
const reviewerResult = (f: ReturnType<typeof fixture>, id = 'w-reviewer', artifact?: string) =>
  f.store.event(f.session.id, null, 'research_reviewer_result', {
    id,
    artifact,
    ...(artifact ? reviewSnapshot(artifact) : {}),
    slots: 2,
    counts: {
      main: 1,
      fix: 1,
      develop: 4,
      supporting: 2,
      dead_end: 1,
      cut: 3,
      stop: 0,
      unknown: 0,
    },
    overBudget: false,
    items: 12,
    verified: 5,
    unverified: 1,
    unbacked: 1,
    missing: 0,
  });
const send = (
  f: ReturnType<typeof fixture>,
  config: any,
  runId: string,
  scope = 'scope-1',
  route = 'send_message',
) =>
  reviewReply(f.store, config, {
    sessionId: f.session.id,
    runId,
    scope,
    text: 'Short plain answer.',
    route,
  });
const finish = (f: ReturnType<typeof fixture>, runId: string) =>
  f.store.exec("UPDATE runs SET status='completed' WHERE id=?", runId);
/** A checker result and its wake, claimed as a run the way the engine claims it. */
const wakeRun = (
  f: ReturnType<typeof fixture>,
  id = 'w-checker',
  result: typeof checkerResult = checkerResult,
) => {
  result(f, id);
  researchWake(f.store, f.session.id, `worker:${id}`, `Worker ${id} completed.`);
  const claimed = f.store.claim(f.session.id)!;
  assert.deepEqual(JSON.parse(claimed.run.message_ids), [`research:worker:${id}`]);
  return claimed.run.id;
};
const userRun = (f: ReturnType<typeof fixture>, id: string) => {
  f.enqueue(id);
  const claimed = f.store.claim(f.session.id)!;
  assert.deepEqual(JSON.parse(claimed.run.message_ids), [id]);
  return claimed.run.id;
};

test('review hold blocks a reply of the run that consumed the wake once, then releases', (t) => {
  const f = fixture(t);
  const config = researchSchema.parse({ workers: { review: { hold: 'once' } } });
  const plain = userRun(f, 'u0');
  assert.equal(
    send(f, config, plain).blocked,
    false,
    'no checker or reviewer result, nothing to hold',
  );
  finish(f, plain);
  const run = wakeRun(f);
  const held = send(f, config, run);
  assert.equal(held.blocked, true);
  assert.match(held.feedback!, /checker subagent w-checker completed with 3 objection\(s\)/);
  assert.match(held.feedback!, /3 objection\(s\) \(2 verified, 1 unverified, 0 unbacked\)/);
  assert.match(
    held.feedback!,
    /read the checked evidence in that subagent's wake before replying/i,
  );
  assert.match(held.feedback!, /next attempt is released/);
  assert.equal(send(f, config, run).blocked, false);
  finish(f, run);
  const events = f.store.all<{ content: string }>(
    "SELECT content FROM events WHERE type='research_review_hold'",
  );
  assert.deepEqual(
    events.map((e) => JSON.parse(e.content)),
    [{ workerId: 'w-checker', scope: 'scope-1' }],
  );
  // A later checker result's wake arms it again.
  const next = wakeRun(f, 'w-checker-2');
  assert.equal(send(f, config, next).blocked, true);
  assert.equal(send(f, config, next).blocked, false);
});

test('review hold fires once on a reviewer result with its verdict counts', (t) => {
  const f = fixture(t);
  const config = researchSchema.parse({ workers: { review: { hold: 'once' } } });
  const run = wakeRun(f, 'w-reviewer', reviewerResult);
  const held = send(f, config, run);
  assert.equal(held.blocked, true);
  assert.match(
    held.feedback!,
    /reviewer subagent w-reviewer completed: main 1 \/ fix 1 \/ develop 4 \/ supporting 2 \/ dead_end 1 \/ cut 3 \/ stop 0, slots 2\./,
  );
  assert.equal(send(f, config, run).blocked, false);
  assert.deepEqual(
    f.store
      .all<{ content: string }>("SELECT content FROM events WHERE type='research_review_hold'")
      .map((e) => JSON.parse(e.content)),
    [{ workerId: 'w-reviewer', scope: 'scope-1' }],
  );
});

test('review hold does not fire for a run that did not consume the wake', (t) => {
  const f = fixture(t);
  const config = researchSchema.parse({ workers: { review: { hold: 'once' } } });
  checkerResult(f);
  researchWake(f.store, f.session.id, 'worker:w-checker', 'Worker w-checker (checker) completed.');
  // User input is claimed ahead of the queued wake: an in-flight run that never saw it.
  const other = userRun(f, 'u1');
  assert.equal(send(f, config, other).blocked, false);
  finish(f, other);
  const wake = f.store.claim(f.session.id)!.run;
  assert.deepEqual(JSON.parse(wake.message_ids), ['research:worker:w-checker']);
  assert.equal(send(f, config, wake.id).blocked, true);
});

test('review hold never fires on the interim route', (t) => {
  const f = fixture(t);
  const config = researchSchema.parse({ workers: { review: { hold: 'once' } } });
  const run = wakeRun(f);
  assert.equal(send(f, config, run, 'scope-1', 'provider-interim').blocked, false);
  assert.equal(f.store.get("SELECT 1 FROM events WHERE type='research_review_hold'"), undefined);
  assert.equal(replyCorrections(f.store, config, 'scope-1'), undefined);
  assert.equal(send(f, config, run, 'scope-1', 'provider-result').blocked, true);
});

test('a quiet wake run leaves no hold armed for a later reply', (t) => {
  const f = fixture(t);
  const config = researchSchema.parse({ workers: { review: { hold: 'once' } } });
  // The wake run ends CLAWSTRUM_QUIET: nothing reaches the reply review.
  finish(f, wakeRun(f));
  const later = userRun(f, 'u2');
  assert.equal(send(f, config, later).blocked, false);
  assert.equal(f.store.get("SELECT 1 FROM events WHERE type='research_review_hold'"), undefined);
});

test('review hold is off by default', (t) => {
  const f = fixture(t);
  const config = researchSchema.parse({});
  assert.equal(config.workers.review.hold, 'off');
  assert.equal(send(f, config, wakeRun(f)).blocked, false);
});

test('review hold fires under advisory and off validation, but not with research disabled', (t) => {
  const f = fixture(t);
  for (const validation of ['advisory', 'off'] as const) {
    const config = researchSchema.parse({ validation, workers: { review: { hold: 'once' } } });
    const run = wakeRun(f, `w-${validation}`);
    assert.equal(send(f, config, run, `scope-${validation}`).blocked, true, validation);
    finish(f, run);
  }
  const disabled = researchSchema.parse({ enabled: false, workers: { review: { hold: 'once' } } });
  assert.equal(send(f, disabled, wakeRun(f)).blocked, false);
});

test('review hold does not spend the reply review correction but still reaches the retry', (t) => {
  const f = fixture(t);
  const config = researchSchema.parse({
    validation: 'strict',
    workers: { review: { hold: 'once' } },
  });
  assert.equal(send(f, config, wakeRun(f)).blocked, true);
  assert.equal(replyFeedback(f.store, 'scope-1'), undefined);
  assert.equal(
    f.store.get("SELECT key FROM metadata WHERE key LIKE 'research-reply-review:%'"),
    undefined,
  );
  assert.match(
    replyCorrections(f.store, config, 'scope-1')!,
    /checker subagent w-checker completed with 3 objection\(s\)/,
  );
  assert.equal(replyCorrections(f.store, config, 'other-scope'), undefined);
});

// A command that pushes 40 unreviewed lines of a paper.
const PAPER_PUSH = `cd /net/paper; bibtex draft >/dev/null 2>&1; pdflatex -interaction=nonstopmode draft.tex >/tmp/b.log 2>&1; git add draft.tex && git commit -q -m "Results: model section

Co-Authored-By: Claude" && git push -q 2>&1 | grep -v "://"; git log --oneline -1 | cat`;

test('isGitPush finds a push in command position and ignores mentions', () => {
  assert.equal(isGitPush(PAPER_PUSH), true);
  assert.equal(isGitPush('git -C /p push origin main'), true);
  assert.equal(isGitPush('git -c user.name=x push'), true);
  assert.equal(isGitPush('git log --oneline | grep push'), false);
  assert.equal(isGitPush("echo 'git push'"), false);
  assert.equal(isGitPush('cat > notes.md <<EOF\ngit push\nEOF'), false);
  assert.equal(isGitPush('git commit -m "push later"'), false);
});

test('pushRepoDir follows cd, prefers git -C, gives up on variables', () => {
  assert.equal(pushRepoDir(PAPER_PUSH, '/g'), '/net/paper');
  assert.equal(pushRepoDir('cd paper && git push', '/g'), '/g/paper');
  assert.equal(pushRepoDir('cd /a; cd b && git push', '/g'), '/a/b');
  assert.equal(pushRepoDir('cd /a && git -C /p push', '/g'), '/p');
  assert.equal(pushRepoDir('git -C ~/p push', '/g'), path.join(os.homedir(), 'p'));
  assert.equal(pushRepoDir('cd $P && git push', '/g'), null);
  assert.equal(pushRepoDir('git push', '/g'), '/g');
});

test('paperPushDecision sequence', () => {
  const big = ['caption changed', '1 number changed'];
  // A small event log: e = .tex edit, r = checker or reviewer result with the tree at its return,
  // then each decision appends a push or a block. The tree changes on every edit, recorded or not;
  // the diff between two trees trips a trigger when an edit between them did.
  const log = () => {
    let seq = 0;
    let tree = 't0';
    const edits: number[] = [];
    const tripping: number[] = [];
    const reviews: { seq: number; tree: string | null; base: string | null }[] = [];
    const s: PaperPushState = {
      firstEditSeq: null,
      review: null,
      lastPushSeq: 0,
      lastPushTree: null,
      blocks: 0,
    };
    const recompute = () => {
      s.firstEditSeq = edits.find((e) => e > s.lastPushSeq) ?? null;
      s.review = reviews.findLast((r) => r.seq > (s.firstEditSeq ?? 0)) ?? null;
    };
    const change = (trips: boolean) => {
      tree = `t${++seq}`;
      if (trips) tripping.push(seq);
      return seq;
    };
    return {
      s,
      edit(trips = true) {
        edits.push(change(trips));
        recompute();
      },
      shell(trips = true) {
        change(trips);
        recompute();
      },
      review(withTree = true) {
        reviews.push({ seq: ++seq, tree: withTree ? tree : null, base: null });
        recompute();
      },
      push(
        triggers: string[] | null = big,
        mode: 'deny' | 'advise' = 'deny',
        now: string | null = tree,
      ) {
        const v = paperPushDecision({
          state: s,
          dir: '/p',
          top: '/p',
          triggers,
          tree: now,
          sinceReview: (review, to) => {
            const a = Number(review.tree.slice(1));
            const b = Number(to.slice(1));
            return {
              triggers: tripping.some((k) => k > a && k <= b) ? ['1 number changed'] : [],
              from: review.tree,
            };
          },
          mode,
        });
        seq++;
        if (v.decision === 'deny') s.blocks++;
        else {
          s.lastPushSeq = seq;
          s.lastPushTree = now;
          s.blocks = 0;
        }
        recompute();
        return v;
      },
    };
  };
  let l = log();
  l.edit();
  const blocked = l.push();
  assert.equal(blocked.decision, 'deny');
  assert.match(blocked.reason!, /checker or reviewer/);
  assert.match(
    blocked.reason!,
    /paper changes against the upstream merge-base \(caption changed; 1 number changed\)/,
  );
  assert.match(blocked.reason!, /re-arm this check only when they trip a trigger on their own/);

  l = log();
  l.edit();
  assert.equal(l.push([]).why, 'minor');
  assert.equal(log().push(null).why, 'unknown');

  l = log();
  l.edit();
  l.review();
  l.edit(false);
  l.edit(false);
  assert.equal(l.push().why, 'reviewed', 'edits after the review that trip nothing do not re-arm');

  l = log();
  l.edit();
  l.review();
  l.edit(false);
  l.edit(true);
  const since = l.push();
  assert.equal(since.decision, 'deny', 'an edit after the review that trips a trigger re-arms');
  assert.equal(since.why, 'unreviewed-since-review');
  assert.match(since.reason!, /1 number changed/);
  assert.match(since.reason!, /diff: git -C \/p diff t1 t4/);

  l = log();
  l.edit();
  l.review(false);
  l.edit(true);
  assert.equal(l.push().why, 'reviewed', 'a review without a tree cannot be diffed');
  l = log();
  l.edit();
  l.review();
  l.edit(true);
  assert.equal(l.push(big, 'deny', null).why, 'reviewed', 'no tree now: git cannot say');

  l = log();
  l.review();
  l.edit();
  assert.equal(l.push().decision, 'deny', 'a review before the first edit does not count');

  l = log();
  l.edit();
  l.review();
  assert.equal(l.push().decision, 'allow');
  assert.equal(l.push().why, 'retry', 'a retried push with nothing changed passes');
  l.shell(true);
  assert.equal(l.push().why, 'unreviewed-since-review', 'a shell edit after a push is no retry');
  l = log();
  l.edit();
  l.review();
  assert.equal(l.push().decision, 'allow');
  l.shell(false);
  assert.equal(l.push().why, 'reviewed', 'a shell edit that trips nothing passes on the review');
  l.edit();
  assert.equal(l.push().decision, 'deny', 'a new change after a push re-arms');

  l = log();
  assert.equal(l.push().decision, 'deny');
  l.review();
  assert.equal(
    l.push().why,
    'reviewed',
    'with no edit or push seen, any checker or reviewer result counts',
  );

  l = log();
  l.edit();
  for (let k = 0; k < MAX_REVIEW_BLOCKS; k++) assert.equal(l.push().decision, 'deny');
  assert.equal(l.push().why, 'cap', 'cannot wedge a session');

  l = log();
  l.edit();
  const advised = l.push(big, 'advise');
  assert.equal(advised.decision, 'advise');
  assert.match(advised.reason!, /proceeds/);
  l = log();
  l.edit();
  l.review();
  l.edit(true);
  const advisedSince = l.push(big, 'advise');
  assert.equal(advisedSince.decision, 'advise');
  assert.equal(advisedSince.why, 'unreviewed-since-review');
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
function paperRepo(root: string) {
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['clone', '-q', remote, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@t');
  git(work, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(work, 'main.tex'), 'a\nb\nc\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', 'origin', 'HEAD');
  git(
    work,
    'branch',
    '-q',
    '--set-upstream-to',
    `origin/${git(work, 'rev-parse', '--abbrev-ref', 'HEAD').trim()}`,
  );
  return work;
}

// Hand-built `git diff -U0` output for one file.
const diffOf = (hunks: string, file = 'main.tex') =>
  `diff --git a/${file} b/${file}\nindex 1..2 100644\n--- a/${file}\n+++ b/${file}\n${hunks}`;
const T = (
  d: string,
  newFiles: Record<string, string> = {},
  images: string[] = [],
  untracked: string[] = [],
) => paperChangeTriggers(d, untracked, images, newFiles);

test('paperChangeTriggers: a typo, a \\ref or a comment triggers nothing', () => {
  assert.deepEqual(
    T(diffOf('@@ -5 +5 @@\n-The capcity grows with N.\n+The capacity grows with N.\n')),
    [],
  );
  assert.deepEqual(
    T(diffOf('@@ -5 +5 @@\n-as shown in Fig.~\\ref{fig:2}.\n+as shown in Fig.~\\ref{fig:3}.\n')),
    [],
  );
  assert.deepEqual(T(diffOf('@@ -5 +5 @@\n-text % was 0.4\n+text % now 0.5\n')), []);
  assert.deepEqual(T(diffOf('@@ -5 +5 @@\n-x\n+y\n', 'fig12_v3.tex')), [], 'headers ignored');
});

test('paperChangeTriggers: numbers, captions and figures', () => {
  assert.deepEqual(T(diffOf('@@ -5 +5 @@\n-Accuracy is 0.84.\n+Accuracy is 0.86.\n')), [
    '1 number changed',
  ]);
  assert.deepEqual(T(diffOf('@@ -5 +5 @@\n-up 5\\% here\n+up 6\\% here\n')), ['1 number changed']);
  assert.deepEqual(
    T(
      diffOf(
        '@@ -9 +9 @@\n-\\includegraphics[width=0.4\\linewidth]{f}\n+\\includegraphics[width=0.5\\linewidth]{f}\n',
      ),
    ),
    ['includegraphics changed', '1 number changed'],
  );
  assert.deepEqual(
    T(diffOf('@@ -9 +9 @@\n-\\caption{Capacity vs N.}\n+\\caption{Capacity versus N.}\n')),
    ['caption changed'],
  );
  assert.deepEqual(T('', { 'sec.tex': '\\section{Results}\nshort\n' }, [], ['sec.tex']), [
    'section changed',
  ]);
});

test('paperChangeTriggers: abstract, size and images', () => {
  const file = 'x\n\\begin{abstract}\nWe show capcity grows.\n\\end{abstract}\nbody\n';
  assert.deepEqual(
    T(diffOf('@@ -3 +3 @@\n-We show capcity grow.\n+We show capcity grows.\n'), {
      'main.tex': file,
    }),
    ['abstract text changed'],
  );
  assert.deepEqual(T(diffOf('@@ -5 +5 @@\n-bdy\n+body\n'), { 'main.tex': file }), []);
  assert.deepEqual(T(diffOf('@@ -4 +3,0 @@\n-A deleted sentence.\n'), { 'main.tex': file }), [
    'abstract text changed',
  ]);
  const a = 'a'.repeat(450);
  const b = 'b'.repeat(450);
  assert.deepEqual(T(diffOf(`@@ -5 +5 @@\n-${a}\n+${b}\n`)), ['size: 900 changed chars']);
  assert.deepEqual(T('', {}, ['figs/fig1.png', 'notes.md', 'figs/f2.PDF']), [
    'image changed: figs/fig1.png, figs/f2.PDF',
  ]);
});

test(
  'paperChangesVsUpstream sees unpushed, uncommitted and untracked changes, not a compiled pdf',
  { timeout: 30_000 },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-push-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const remote = path.join(root, 'remote.git');
    const work = path.join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    execFileSync('git', ['clone', '-q', remote, work], { stdio: 'ignore' });
    git(work, 'config', 'user.email', 't@t');
    git(work, 'config', 'user.name', 't');
    fs.writeFileSync(
      path.join(work, 'main.tex'),
      'a\n\\begin{abstract}\nb\n\\end{abstract}\nc 1\n',
    );
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'init');
    git(work, 'push', '-q', 'origin', 'HEAD');
    git(
      work,
      'branch',
      '-q',
      '--set-upstream-to',
      `origin/${git(work, 'rev-parse', '--abbrev-ref', 'HEAD').trim()}`,
    );
    assert.deepEqual(paperChangesVsUpstream(work), []);

    fs.writeFileSync(
      path.join(work, 'main.tex'),
      'a\n\\begin{abstract}\nB\n\\end{abstract}\nc 1\n',
    );
    git(work, 'commit', '-q', '-am', 'local');
    fs.writeFileSync(
      path.join(work, 'main.tex'),
      'a\n\\begin{abstract}\nB\n\\end{abstract}\nc 2\n',
    );
    fs.writeFileSync(path.join(work, 'notes.md'), 'x 9\n'.repeat(500));
    fs.mkdirSync(path.join(work, 'figs'));
    fs.writeFileSync(path.join(work, 'figs', 'f.png'), 'png');
    fs.writeFileSync(path.join(work, 'main.pdf'), 'compiled');
    assert.deepEqual(
      paperChangesVsUpstream(path.join(work, 'figs')),
      ['1 number changed', 'abstract text changed'],
      'an untracked png the paper does not use is not part of the change',
    );

    assert.equal(paperChangesVsUpstream('/nonexistent/dir'), null);
    assert.equal(paperChangesVsUpstream(fs.mkdtempSync(path.join(root, 'norepo-'))), null);
  },
);

function pushHooks(t: any, f: ReturnType<typeof fixture>, env: Record<string, string> = {}) {
  const research = researchSchema.parse({
    enabled: true,
    validation: 'off',
    workers: { review: { paperPush: 'deny' } },
  });
  const controller = new AbortController();
  const request: ProviderRequest = {
    account: f.config.accounts[0]!,
    cwd: f.session.workspace,
    prompt: '',
    instructions: '',
    controller,
    env: {},
    research,
    mcp: {
      command: process.execPath,
      args: [],
      env: { CLAWSTRUM_HOME: f.home, CLAWSTRUM_SESSION: f.session.id, ...env },
    },
    onEvent() {},
  };
  const hooks = researchHooks(request);
  t.after(() => hooks.close());
  const invoke = async (event: string, extra: Record<string, unknown>) =>
    await (hooks.hooks as any)[event][0].hooks[0](
      {
        session_id: 'native',
        transcript_path: '',
        cwd: f.session.workspace,
        hook_event_name: event,
        ...extra,
      },
      undefined,
      { signal: controller.signal },
    );
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  let n = 0;
  /** Writes main.tex and records the edit, as a Write tool call would. */
  const write = async (work: string, content: string, extra: Record<string, unknown> = {}) => {
    fs.writeFileSync(path.join(work, 'main.tex'), content);
    await invoke('PostToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: path.join(work, 'main.tex'), content },
      tool_response: {},
      tool_use_id: `w${++n}`,
      ...extra,
    });
  };
  const run = async (command: string, extra: Record<string, unknown> = {}) =>
    await invoke('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: `p${++n}`,
      ...extra,
    });
  return {
    invoke,
    body,
    write,
    run,
    /** Writes 40 lines over main.tex. */
    editTex: async (work: string, extra: Record<string, unknown> = {}) =>
      await write(work, body, extra),
    push: async (work: string, extra: Record<string, unknown> = {}) =>
      await run(`cd ${work} && git push`, extra),
  };
}
const decisions = (f: ReturnType<typeof fixture>) =>
  f.store
    .all<{
      content: string;
    }>("SELECT content FROM events WHERE type='research_paper_push_gate' ORDER BY seq")
    .map((e) => JSON.parse(e.content));

test('paperPush hook refuses an unreviewed paper push and opens on a checker result', async (t) => {
  const f = fixture(t);
  const h = pushHooks(t, f);
  const work = paperRepo(fs.mkdtempSync(path.join(f.home, 'paper-')));
  await h.editTex(work);
  const denied = await h.push(work);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(
    denied.hookSpecificOutput.permissionDecisionReason,
    /paper changes against the upstream merge-base \(40 numbers changed\)/,
  );
  checkerResult(f, 'reviewed-paper', path.join(work, 'main.tex'));
  const allowed = await h.push(work);
  // A git push is still a Bash command, so an allowed one now carries the CPU-priority prefix.
  assert.equal(allowed.hookSpecificOutput?.permissionDecision, 'allow');
  assert.deepEqual(
    decisions(f).map((d) => [d.decision, d.why, d.triggers]),
    [
      ['deny', 'unreviewed', ['40 numbers changed']],
      ['allow', 'reviewed', ['40 numbers changed']],
    ],
  );
  assert.equal(
    f.store.get<{ n: number }>("SELECT COUNT(*) n FROM events WHERE type='research_tex_edit'")!.n,
    1,
  );
});

test('paperPush state is per repository: a push elsewhere does not reset the paper', async (t) => {
  const f = fixture(t);
  const h = pushHooks(t, f);
  const paper = paperRepo(fs.mkdtempSync(path.join(f.home, 'paper-')));
  const code = paperRepo(fs.mkdtempSync(path.join(f.home, 'code-')));
  await h.editTex(paper);
  assert.equal((await h.push(paper)).hookSpecificOutput.permissionDecision, 'deny');
  // A git push is still a Bash command, so an allowed one now carries the CPU-priority prefix.
  assert.equal((await h.push(code)).hookSpecificOutput?.permissionDecision, 'allow');
  assert.equal((await h.push(paper)).hookSpecificOutput.permissionDecision, 'deny');
  checkerResult(f, 'this-paper', path.join(paper, 'main.tex'));
  assert.equal((await h.push(paper)).hookSpecificOutput?.permissionDecision, 'allow');
  assert.deepEqual(
    decisions(f).map((d) => [d.dir === paper ? 'paper' : 'code', d.decision, d.why]),
    [
      ['paper', 'deny', 'unreviewed'],
      ['code', 'allow', 'minor'],
      ['paper', 'deny', 'unreviewed'],
      ['paper', 'allow', 'reviewed'],
    ],
  );
});

test('paperPush does not check subagent pushes but records their .tex edits', async (t) => {
  const f = fixture(t);
  const worker = pushHooks(t, f, { CLAWSTRUM_DELEGATION: 'w-1' });
  const paper = paperRepo(fs.mkdtempSync(path.join(f.home, 'paper-')));
  await worker.editTex(paper);
  // A git push is still a Bash command, so an allowed one now carries the CPU-priority prefix.
  assert.equal((await worker.push(paper)).hookSpecificOutput?.permissionDecision, 'allow');
  const lead = pushHooks(t, f);
  assert.equal(
    (await lead.push(paper, { agent_id: 'sub-1' })).hookSpecificOutput?.permissionDecision,
    'allow',
  );
  assert.deepEqual(decisions(f), []);
  // The subagent's edit still needs review before the lead pushes.
  assert.equal((await lead.push(paper)).hookSpecificOutput.permissionDecision, 'deny');
});

test('a checker of another repository cannot approve this paper', async (t) => {
  const f = fixture(t);
  const h = pushHooks(t, f);
  const paper = paperRepo(fs.mkdtempSync(path.join(f.home, 'paper-')));
  const other = paperRepo(fs.mkdtempSync(path.join(f.home, 'other-')));
  await h.editTex(paper);
  checkerResult(f, 'wrong-project', path.join(other, 'main.tex'));
  assert.equal((await h.push(paper)).hookSpecificOutput.permissionDecision, 'deny');
  checkerResult(f, 'right-project', path.join(paper, 'main.tex'));
  // A git push is still a Bash command, so an allowed one now carries the CPU-priority prefix.
  assert.equal((await h.push(paper)).hookSpecificOutput?.permissionDecision, 'allow');
});

test('paperPush opens on a reviewer result naming an artifact inside the repository', async (t) => {
  const f = fixture(t);
  const h = pushHooks(t, f);
  const paper = paperRepo(fs.mkdtempSync(path.join(f.home, 'paper-')));
  await h.editTex(paper);
  assert.equal((await h.push(paper)).hookSpecificOutput.permissionDecision, 'deny');
  reviewerResult(f, 'paper-review', path.join(paper, 'main.tex'));
  // A git push is still a Bash command, so an allowed one now carries the CPU-priority prefix.
  assert.equal((await h.push(paper)).hookSpecificOutput?.permissionDecision, 'allow');
  assert.deepEqual(
    decisions(f).map((d) => [d.decision, d.why]),
    [
      ['deny', 'unreviewed'],
      ['allow', 'reviewed'],
    ],
  );
});

// A git push is still a Bash command, so an allowed one now carries the CPU-priority prefix.
const allowed = (r: any) => r.hookSpecificOutput?.permissionDecision === 'allow';

test('paperPush: after an allowed push, a shell edit that changes a number is refused', async (t) => {
  const f = fixture(t);
  const h = pushHooks(t, f);
  const work = paperRepo(fs.mkdtempSync(path.join(f.home, 'paper-')));
  await h.editTex(work);
  checkerResult(f, 'reviewed', path.join(work, 'main.tex'));
  assert.ok(allowed(await h.push(work)));
  // sed -i 's/line 3$/line 33/' main.tex: no editor event.
  fs.writeFileSync(path.join(work, 'main.tex'), h.body.replace('line 3\n', 'line 33\n'));
  const denied = await h.push(work);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /1 number changed/);
  assert.deepEqual(
    decisions(f).map((d) => [d.decision, d.why]),
    [
      ['allow', 'reviewed'],
      ['deny', 'unreviewed-since-review'],
    ],
  );
});

test('paperPush: a re-push with nothing changed since the allowed push is a retry', async (t) => {
  const f = fixture(t);
  const h = pushHooks(t, f);
  const work = paperRepo(fs.mkdtempSync(path.join(f.home, 'paper-')));
  await h.editTex(work);
  checkerResult(f, 'reviewed', path.join(work, 'main.tex'));
  assert.ok(allowed(await h.push(work)));
  // git rejected it (no push happened); the same push again.
  assert.ok(allowed(await h.push(work)));
  const [first, second] = decisions(f);
  assert.deepEqual([first.why, second.why, second.decision], ['reviewed', 'retry', 'allow']);
  assert.equal(first.top, fs.realpathSync(work));
  assert.match(first.tree, /^[0-9a-f]{40,}$/);
  assert.equal(second.tree, first.tree);
});

test('paperPush: edits after a review re-arm the check only when they trip a trigger', async (t) => {
  const f = fixture(t);
  const h = pushHooks(t, f);
  const work = paperRepo(fs.mkdtempSync(path.join(f.home, 'paper-')));
  await h.editTex(work);
  reviewerResult(f, 'reviewed', path.join(work, 'main.tex'));
  await h.write(work, h.body.replace('line 3\n', 'line 33\n'));
  const denied = await h.push(work);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  const reason = denied.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /edits since it would need one on their own \(1 number changed\)/);
  const tree = decisions(f)[0].tree;
  const reviewTree = JSON.parse(
    f.store.get<{ content: string }>(
      "SELECT content FROM events WHERE type='research_reviewer_result'",
    )!.content,
  ).tree;
  assert.ok(reason.includes(`diff: git -C ${fs.realpathSync(work)} diff ${reviewTree} ${tree}`));
  await h.write(work, h.body.replace('line 3\n', 'Line 3\n'));
  assert.ok(allowed(await h.push(work)));
  assert.deepEqual(
    decisions(f).map((d) => [d.decision, d.why]),
    [
      ['deny', 'unreviewed-since-review'],
      ['allow', 'reviewed'],
    ],
  );
});

test('paperPush: untracked files count when the paper uses them or the push adds them', async (t) => {
  const f = fixture(t);
  const h = pushHooks(t, f);
  const root = fs.mkdtempSync(path.join(f.home, 'paper-'));
  const work = paperRepo(root);
  fs.mkdirSync(path.join(work, 'figs'));
  fs.writeFileSync(path.join(work, 'fig.tex'), '\\graphicspath{{figs/}}\n\\includegraphics{f}\n');
  fs.writeFileSync(
    path.join(work, 'main.tex'),
    'a\n% \\includegraphics{figs/commented}\n\\input fig\nc\n',
  );
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'figures');
  git(work, 'push', '-q');
  fs.writeFileSync(path.join(work, 'figs', 'x.png'), 'png');
  fs.writeFileSync(path.join(work, 'figs', 'commented.png'), 'png');
  assert.deepEqual(paperChangesVsUpstream(work), [], 'an unreferenced untracked png');
  assert.deepEqual(paperChangesVsUpstream(work, ['figs/x.png']), ['image changed: figs/x.png']);
  fs.writeFileSync(path.join(work, 'figs', 'f.png'), 'png');
  assert.deepEqual(paperChangesVsUpstream(work), ['image changed: figs/f.png']);
  fs.rmSync(path.join(work, 'figs', 'f.png'));

  assert.deepEqual(
    gitAddPaths(
      `cd ${work} && git add . '*.png' figs/x.png $F && git -C figs add y.png`,
      work,
      fs.realpathSync(work),
    ),
    ['figs/x.png', 'figs/y.png'],
  );
  assert.ok(allowed(await h.run(`cd ${work} && git push`)));
  const denied = await h.run(`cd ${work} && git add figs/x.png && git commit -qm x && git push`);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /image changed: figs\/x\.png/);
});

test('paperPush: a push from a subfolder or a symlinked path matches a review of the paper', async (t) => {
  const f = fixture(t);
  const h = pushHooks(t, f);
  const root = fs.mkdtempSync(path.join(f.home, 'paper-'));
  const work = paperRepo(root);
  fs.mkdirSync(path.join(work, 'figs'));
  const link = path.join(root, 'link');
  fs.symlinkSync(work, link);
  await h.editTex(link);
  const push = `cd ${link}/figs && git push`;
  assert.equal((await h.run(push)).hookSpecificOutput.permissionDecision, 'deny');
  checkerResult(f, 'reviewed', path.join(work, 'main.tex'));
  assert.ok(allowed(await h.run(push)));
  assert.deepEqual(
    decisions(f).map((d) => [d.decision, d.why, d.top]),
    [
      ['deny', 'unreviewed', fs.realpathSync(work)],
      ['allow', 'reviewed', fs.realpathSync(work)],
    ],
  );
});

/** The paper repository (A, the agent's clone) with a 40-line main.tex pushed, and a co-author
 * clone (B) of the same upstream. */
function sharedPaper(root: string, body: string) {
  const a = paperRepo(root);
  fs.writeFileSync(path.join(a, 'main.tex'), body);
  git(a, 'commit', '-q', '-am', 'body');
  git(a, 'push', '-q', 'origin', 'HEAD');
  const b = path.join(root, 'coauthor');
  execFileSync('git', ['clone', '-q', path.join(root, 'remote.git'), b], { stdio: 'ignore' });
  git(b, 'config', 'user.email', 'b@b');
  git(b, 'config', 'user.name', 'b');
  /** B changes a line and pushes it. */
  const coauthor = (from: string, to: string) => {
    const file = path.join(b, 'main.tex');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(from, to));
    git(b, 'commit', '-q', '-am', 'coauthor');
    git(b, 'push', '-q', 'origin', 'HEAD');
  };
  return { a, coauthor };
}
const reviewEvent = (f: ReturnType<typeof fixture>) =>
  JSON.parse(
    f.store.get<{ content: string }>(
      "SELECT content FROM events WHERE type='research_checker_result' ORDER BY seq DESC LIMIT 1",
    )!.content,
  );

for (const pull of ['--rebase', '--no-rebase'])
  test(`paperPush: co-author edits pulled (${pull}) after a review are not edits since it`, async (t) => {
    const f = fixture(t);
    const h = pushHooks(t, f);
    const { a, coauthor } = sharedPaper(fs.mkdtempSync(path.join(f.home, 'paper-')), h.body);
    await h.write(a, h.body.replace('line 5\n', 'line 55\n'));
    git(a, 'commit', '-q', '-am', 'own');
    checkerResult(f, 'reviewed', path.join(a, 'main.tex'));
    assert.match(reviewEvent(f).base, /^[0-9a-f]{40,}$/);
    coauthor('line 30\n', 'line 300\n');
    git(a, 'pull', '-q', pull);
    assert.ok(allowed(await h.push(a)));
    assert.deepEqual(
      decisions(f).map((d) => [d.decision, d.why]),
      [['allow', 'reviewed']],
    );
  });

test('paperPush: an own edit after a pull is an edit since the review, diffed against the replayed review', async (t) => {
  const f = fixture(t);
  const h = pushHooks(t, f);
  const { a, coauthor } = sharedPaper(fs.mkdtempSync(path.join(f.home, 'paper-')), h.body);
  const own = h.body.replace('line 5\n', 'line 55\n');
  await h.write(a, own);
  git(a, 'commit', '-q', '-am', 'own');
  checkerResult(f, 'reviewed', path.join(a, 'main.tex'));
  coauthor('line 30\n', 'line 300\n');
  git(a, 'pull', '-q', '--rebase');
  await h.write(a, own.replace('line 30\n', 'line 300\n').replace('line 10\n', 'line 101\n'));
  const denied = await h.push(a);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  const reason = denied.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /edits since it would need one on their own \(1 number changed\)/);
  const [, from, to] = reason.match(/diff: git -C \S+ diff (\S+) (\S+)/)!;
  assert.notEqual(from, reviewEvent(f).tree);
  assert.deepEqual(
    git(a, 'diff', '-U0', from, to)
      .split('\n')
      .filter((l) => /^[-+](?![-+])/.test(l)),
    ['-line 10', '+line 101'],
  );
  assert.deepEqual(
    decisions(f).map((d) => [d.decision, d.why]),
    [['deny', 'unreviewed-since-review']],
  );
});

test('paperPush: a reviewed change that cannot be replayed onto the pulled base is compared to the review tree', async (t) => {
  const f = fixture(t);
  const h = pushHooks(t, f);
  const { a, coauthor } = sharedPaper(fs.mkdtempSync(path.join(f.home, 'paper-')), h.body);
  await h.write(a, h.body.replace('line 5\n', 'line 55\n'));
  checkerResult(f, 'reviewed', path.join(a, 'main.tex'));
  coauthor('line 5\n', 'line 7\n');
  git(a, 'checkout', '--', 'main.tex');
  git(a, 'pull', '-q', '--rebase');
  await h.write(a, h.body.replace('line 5\n', 'line 77\n'));
  const denied = await h.push(a);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  const reason = denied.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes(`diff ${reviewEvent(f).tree} ${decisions(f)[0].tree}`));
  assert.deepEqual(
    decisions(f).map((d) => [d.decision, d.why]),
    [['deny', 'unreviewed-since-review']],
  );
});
