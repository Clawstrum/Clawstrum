/**
 * research.workers.review.paperPush: a `git push` whose paper change touches a claim, number,
 * caption, figure or the abstract needs a checker or reviewer result after the change's first .tex edit.
 *
 * What changed is the trigger, against the merge-base with upstream (working tree included), so
 * uncommitted and committed-unpushed edits both count and pulled co-author edits do not: a caption,
 * section heading, figure environment or \includegraphics; abstract text; the multiset of numbers
 * (\ref/\cite/\label arguments and % comments stripped); an image file; or 800+ changed characters.
 * An untracked file counts only when a tracked .tex pulls it in (transitively) or the push command
 * `git add`s it by name. Each checker or reviewer result records a snapshot tree of its artifact's
 * repository; edits after it re-arm the check only when the diff review tree → now trips a trigger on
 * its own, so applying a review's cuts usually does not. Co-author edits pulled after a review are
 * not counted as edits since it: the reviewed change is replayed onto the new merge-base, and when
 * it cannot be the check compares against the review tree as before. A push after an allowed one passes as a
 * retry only while the snapshot tree is unchanged since that push. Edits, reviews, pushes and
 * refusals are keyed to the real path of the git toplevel, so a push from a subfolder or through
 * another spelling of the path is the same repository. Anything git cannot answer (no upstream, not
 * a repository, a path held in a variable) is allowed and recorded.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Store } from '../store.js';
import { commandArgvs } from './shell.js';

/** Changed .tex characters (added + removed) that alone trigger review. */
export const REVIEW_MIN_CHARS = 800;
/** Refusals per change before the push is allowed anyway, so the check cannot wedge a session. */
export const MAX_REVIEW_BLOCKS = 3;

export function isTexPath(p: unknown): boolean {
  return typeof p === 'string' && path.extname(p).toLowerCase() === '.tex';
}

/** git global options that take a separate value argument. */
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

interface GitCall {
  index: number;
  dir: string | null;
  sub: string;
  rest: string[];
}

/** Each `git` invocation in command position: its -C directory, if any, its subcommand and the
 * words after it. */
function gitCalls(command: string): GitCall[] {
  const out: GitCall[] = [];
  commandArgvs(command).forEach((words, index) => {
    if (words[0]?.split('/').pop() !== 'git') return;
    let dir: string | null = null;
    let i = 1;
    while (i < words.length && words[i]!.startsWith('-')) {
      const t = words[i]!;
      if (GIT_OPTS_WITH_VALUE.has(t)) {
        if (t === '-C') dir = words[i + 1] ?? '';
        i += 2;
      } else i += 1;
    }
    out.push({ index, dir, sub: words[i] ?? '', rest: words.slice(i + 1) });
  });
  return out;
}

export function isGitPush(command: string): boolean {
  return gitCalls(command).some((c) => c.sub === 'push');
}

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(1));
  return p.replace(/^\$HOME(?=\/|$)/, os.homedir());
}

/** The repository a push runs in: `git -C <dir> push`, else the `cd`s before the push applied in
 * order from `cwd`. Null when a path holds an unexpanded variable. */
export function pushRepoDir(command: string, cwd: string): string | null {
  const argvs = commandArgvs(command);
  const push = gitCalls(command).find((c) => c.sub === 'push');
  if (push?.dir) {
    const d = expandHome(push.dir);
    return d.includes('$') ? null : path.resolve(cwd, d);
  }
  let dir = cwd;
  for (const words of argvs.slice(0, push ? push.index : argvs.length)) {
    if (words[0] !== 'cd' || words[1] === undefined) continue;
    const target = expandHome(words[1]);
    if (target === '-') continue;
    if (target.includes('$')) return null;
    dir = path.resolve(dir, target);
  }
  return dir;
}

/** Real path, or the resolved path when it does not exist. */
function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function inside(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Top-relative paths the command's `git add`s name. `dir`: where its git runs. `.`, `:/`, globs
 * and variables name no file and are skipped. */
export function gitAddPaths(command: string, dir: string, top: string): string[] {
  const out: string[] = [];
  for (const c of gitCalls(command)) {
    if (c.sub !== 'add') continue;
    let base = dir;
    if (c.dir) {
      const d = expandHome(c.dir);
      if (d.includes('$')) continue;
      base = path.resolve(dir, d);
    }
    base = real(base);
    for (const t of c.rest) {
      if (t.startsWith('-')) continue;
      const p = expandHome(t);
      if (!p || p === '.' || p === ':/' || /[*?[$]/.test(p)) continue;
      const abs = path.resolve(base, p);
      const rel = path.relative(top, abs);
      if (!rel || !inside(top, abs)) continue;
      out.push(rel);
    }
  }
  return out;
}

type Exec = (file: string, args: string[]) => string;
const defaultExec: Exec = (file, args) =>
  execFileSync(file, args, {
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

const STRUCTURE_RE =
  /\\(caption|includegraphics|title|section|subsection|subsubsection|paragraph)\b|\\(begin|end)\{(abstract|figure|figure\*|table|table\*)\}/g;
const IMAGE_RE = /\.(png|pdf|jpg|jpeg|eps|svg)$/i;
const REF_ARG_RE = /\\(label|ref|eqref|cref|cite|citep|citet)\*?(\[[^\]]*\])*\{[^}]*\}/g;
const COMMENT_RE = /(^|[^\\])%.*$/;

/** Numbers in a .tex line, after dropping `%` comments and label/ref/cite arguments. */
function numberTokens(line: string): string[] {
  const noComment = line.replace(COMMENT_RE, '$1');
  return noComment.replace(REF_ARG_RE, '').match(/\d+(?:\.\d+)?/g) ?? [];
}

/** 1-based line ranges [begin, end] of abstract environments in a file. */
function abstractRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  let open: number | null = null;
  text.split('\n').forEach((l, k) => {
    if (open === null && /\\begin\{abstract\}/.test(l)) open = k + 1;
    if (open !== null && /\\end\{abstract\}/.test(l)) {
      out.push([open, k + 1]);
      open = null;
    }
  });
  if (open !== null) out.push([open, Number.MAX_SAFE_INTEGER]);
  return out;
}

/**
 * Why a paper change needs review; [] when it does not.
 * diffU0: `git diff -U0 <base> -- '*.tex'`. untrackedTex: paths of untracked .tex
 * files, whose whole content (from newFiles) counts as added. changedImages: changed
 * or untracked paths (non-images are ignored). newFiles: path → current content, for
 * the abstract check.
 */
export function paperChangeTriggers(
  diffU0: string,
  untrackedTex: string[],
  changedImages: string[],
  newFiles: Record<string, string>,
): string[] {
  const added: string[] = [];
  const removed: string[] = [];
  const touched = new Map<string, number[]>();
  let file = '';
  let inHeader = false;
  for (const line of diffU0.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      file = '';
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- a/') && !file) file = line.slice(6);
      else if (line.startsWith('+++ b/')) file = line.slice(6);
      if (!line.startsWith('@@')) continue;
      inHeader = false;
    }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      const start = Number(h[1]);
      const len = h[2] === undefined ? 1 : Number(h[2]);
      const lines = touched.get(file) ?? [];
      if (len === 0) lines.push(Math.max(start, 1));
      for (let k = 0; k < len; k++) lines.push(start + k);
      touched.set(file, lines);
      continue;
    }
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  for (const f of untrackedTex) {
    const text = newFiles[f] ?? '';
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    added.push(...lines);
    touched.set(
      f,
      lines.map((_, k) => k + 1),
    );
  }

  const reasons: string[] = [];
  const chars = [...added, ...removed].reduce((n, l) => n + l.length, 0);
  if (chars >= REVIEW_MIN_CHARS) reasons.push(`size: ${chars} changed chars`);

  const structure = new Set<string>();
  for (const l of [...added, ...removed]) {
    for (const m of l.matchAll(STRUCTURE_RE)) structure.add((m[1] ?? m[3]!).replace('*', ''));
  }
  for (const name of structure) reasons.push(`${name} changed`);

  const counts = new Map<string, number>();
  for (const l of added) for (const t of numberTokens(l)) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const l of removed) for (const t of numberTokens(l)) counts.set(t, (counts.get(t) ?? 0) - 1);
  let plus = 0;
  let minus = 0;
  for (const v of counts.values()) {
    if (v > 0) plus += v;
    else minus -= v;
  }
  const nums = Math.max(plus, minus);
  if (nums > 0) reasons.push(`${nums} number${nums === 1 ? '' : 's'} changed`);

  for (const [f, lines] of touched) {
    const text = newFiles[f];
    if (text === undefined) continue;
    const ranges = abstractRanges(text);
    if (lines.some((n) => ranges.some(([a, b]) => n >= a && n <= b))) {
      reasons.push('abstract text changed');
      break;
    }
  }

  const images = changedImages.filter((f) => IMAGE_RE.test(f));
  if (images.length)
    reasons.push(
      `image changed: ${images.slice(0, 3).join(', ')}${images.length > 3 ? ', …' : ''}`,
    );
  return reasons;
}

const TEX_EXTS = ['.tex'];
const GRAPHIC_EXTS = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg'];
const BIB_EXTS = ['.bib'];

type TexRef = { arg: string; exts: string[]; graphic: boolean };

/** Files a .tex text pulls in, and its \graphicspath dirs. `%` comments dropped first. */
function texRefs(text: string): { refs: TexRef[]; graphicsPath: string[] } {
  const t = text
    .split('\n')
    .map((l) => l.replace(COMMENT_RE, '$1'))
    .join('\n');
  const refs: TexRef[] = [];
  const tex = (arg: string) => refs.push({ arg, exts: TEX_EXTS, graphic: false });
  for (const m of t.matchAll(/\\(?:input|include|subfile)\s*\{([^}]*)\}/g)) tex(m[1]!);
  for (const m of t.matchAll(/\\input\s+([^\s{}\\%]+)/g)) tex(m[1]!);
  for (const m of t.matchAll(
    /\\(?:import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom)\*?\s*\{([^}]*)\}\s*\{([^}]*)\}/g,
  )) {
    tex(path.posix.join(m[1]!.trim() || '.', m[2]!.trim()));
  }
  for (const m of t.matchAll(
    /\\(?:includegraphics|includepdf|includesvg)\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}/g,
  )) {
    refs.push({ arg: m[1]!, exts: GRAPHIC_EXTS, graphic: true });
  }
  for (const m of t.matchAll(/\\bibliography\s*\{([^}]*)\}/g)) {
    for (const b of m[1]!.split(',')) refs.push({ arg: b, exts: BIB_EXTS, graphic: false });
  }
  for (const m of t.matchAll(/\\addbibresource\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g)) {
    refs.push({ arg: m[1]!, exts: BIB_EXTS, graphic: false });
  }
  const graphicsPath: string[] = [];
  for (const m of t.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\})*)\s*\}/g)) {
    for (const d of m[1]!.matchAll(/\{([^}]*)\}/g)) graphicsPath.push(d[1]!);
  }
  return { refs, graphicsPath };
}

const stripQuotes = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2');

/** Top-relative path of p resolved against base, or null when it leaves top. */
function topRel(top: string, base: string, p: string): string | null {
  const r = path.posix.isAbsolute(p)
    ? path.posix.relative(top, p)
    : path.posix.normalize(path.posix.join(base, p));
  return !r || r === '..' || r.startsWith('../') || path.posix.isAbsolute(r) ? null : r;
}

/**
 * The untracked files a push of `top` could carry: those a tracked .tex pulls in (\input,
 * \includegraphics, \bibliography, \import, …, through counted untracked .tex too), plus `explicit`
 * (top-relative; a directory covers what is under it). In `git ls-files` order. Throws when git fails.
 */
export function documentUntracked(
  top: string,
  explicit: string[] = [],
  exec: Exec = defaultExec,
): string[] {
  const lsz = (args: string[]) =>
    exec('git', ['-C', top, 'ls-files', '-z', ...args])
      .split('\0')
      .filter(Boolean);
  const untracked = lsz(['--others', '--exclude-standard']);
  const isUntracked = new Set(untracked);
  const counted = new Set<string>();
  const parsed = new Map<string, TexRef[]>();
  const graphicsDirs = new Set<string>();
  const queue = lsz(['--', '*.tex']);
  for (;;) {
    while (queue.length) {
      const f = queue.shift()!;
      if (parsed.has(f)) continue;
      let text: string;
      try {
        text = fs.readFileSync(path.join(top, f), 'utf-8');
      } catch {
        continue;
      }
      const { refs, graphicsPath } = texRefs(text);
      parsed.set(f, refs);
      for (const d of graphicsPath.map(stripQuotes)) {
        for (const r of [topRel(top, path.posix.dirname(f), d), topRel(top, '.', d)])
          if (r) graphicsDirs.add(r);
      }
    }
    let grew = false;
    for (const [f, refs] of parsed) {
      for (const ref of refs) {
        const arg = stripQuotes(ref.arg);
        if (!arg) continue;
        const names = path.posix.extname(arg) ? [arg] : [arg, ...ref.exts.map((e) => arg + e)];
        const bases = [path.posix.dirname(f), '.', ...(ref.graphic ? graphicsDirs : [])];
        for (const b of bases) {
          for (const n of names) {
            const r = topRel(top, b, n);
            if (!r || !isUntracked.has(r) || counted.has(r)) continue;
            counted.add(r);
            grew = true;
            if (isTexPath(r)) queue.push(r);
          }
        }
      }
    }
    if (!grew) break;
  }
  const named = explicit.map((e) => path.posix.normalize(e).replace(/\/+$/, ''));
  return untracked.filter(
    (u) => counted.has(u) || named.some((n) => u === n || u.startsWith(`${n}/`)),
  );
}

/** A PDF next to its own .tex is the compiled paper, rebuilt on every compile: not a figure change. */
function compiledPdf(top: string, f: string): boolean {
  return /\.pdf$/i.test(f) && fs.existsSync(path.join(top, f.replace(/\.pdf$/i, '.tex')));
}

/**
 * Review triggers for the working tree vs the merge-base with upstream. Null when git cannot say.
 * explicit: top-relative paths the push command `git add`s.
 */
export function paperChangesVsUpstream(
  dir: string,
  explicit: string[] = [],
  exec: Exec = defaultExec,
): string[] | null {
  try {
    if (!fs.existsSync(dir)) return null;
    const top = exec('git', ['-C', dir, 'rev-parse', '--show-toplevel']).trim();
    if (!top) return null;
    const base = exec('git', ['-C', top, 'merge-base', 'HEAD', '@{u}']).trim();
    if (!base) return null;
    const diff = exec('git', ['-C', top, 'diff', '-U0', base, '--', '*.tex']);
    const untracked = documentUntracked(top, explicit, exec);
    const untrackedTex = untracked.filter(isTexPath);
    const changed = exec('git', ['-C', top, 'diff', '--name-only', base])
      .split('\n')
      .filter(Boolean);
    const newFiles: Record<string, string> = {};
    const texFiles = new Set(untrackedTex);
    for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) texFiles.add(m[1]!);
    for (const f of texFiles) {
      try {
        newFiles[f] = fs.readFileSync(path.join(top, f), 'utf-8');
      } catch {
        /* vanished between git and read */
      }
    }
    const images = [...changed, ...untracked].filter((f) => !compiledPdf(top, f));
    return paperChangeTriggers(diff, untrackedTex, images, newFiles);
  } catch {
    return null;
  }
}

/** Real path of the git toplevel containing dir; null outside a repository. */
export function repoTop(dir: string, exec: Exec = defaultExec): string | null {
  try {
    if (!fs.existsSync(dir)) return null;
    const top = exec('git', ['-C', dir, 'rev-parse', '--show-toplevel']).trim();
    return top ? fs.realpathSync(top) : null;
  } catch {
    return null;
  }
}

/**
 * Tree id of the repository's working state: tracked files plus the untracked ones
 * documentUntracked counts, `explicit` included. Built in a temp index so the real index is never touched. Null on any
 * git failure.
 */
export function snapshotTree(top: string, explicit: string[] = []): string | null {
  const tmp = path.join(
    os.tmpdir(),
    `paper-push-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    execFileSync('git', ['-C', top, ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
  const run = (args: string[]) => git(args, { ...process.env, GIT_INDEX_FILE: tmp });
  try {
    // A copy of the real index keeps its stat cache, much faster than read-tree on NFS.
    const real = path.resolve(top, git(['rev-parse', '--git-path', 'index']).trim());
    if (fs.existsSync(real)) fs.copyFileSync(real, tmp);
    else run(['read-tree', 'HEAD']);
    run(['add', '-u']);
    const untracked = documentUntracked(top, explicit);
    if (untracked.length) run(['add', '--', ...untracked]);
    return run(['write-tree']).trim() || null;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(`${tmp}.lock`, { force: true });
  }
}

/** Merge-base of HEAD with its upstream; null with no upstream or on any git failure. */
export function upstreamBase(top: string, exec: Exec = defaultExec): string | null {
  try {
    return exec('git', ['-C', top, 'merge-base', 'HEAD', '@{u}']).trim() || null;
  } catch {
    return null;
  }
}

/** The repository of a checker's or reviewer's artifact, its snapshot tree and its upstream
 * merge-base, for the result event. Nulls when there is none or git fails; never throws. */
export function reviewSnapshot(artifact: string | undefined): {
  repo: string | null;
  tree: string | null;
  base: string | null;
} {
  try {
    const repo = artifact ? repoTop(path.dirname(real(artifact))) : null;
    return {
      repo,
      tree: repo ? snapshotTree(repo) : null,
      base: repo ? upstreamBase(repo) : null,
    };
  } catch {
    return { repo: null, tree: null, base: null };
  }
}

/**
 * The tree's changes against oldBase replayed onto newBase (3-way), built in a temp index. Null
 * when the patch does not apply or git fails.
 */
export function rebaseTree(
  top: string,
  tree: string,
  oldBase: string,
  newBase: string,
): string | null {
  const tmp = path.join(
    os.tmpdir(),
    `paper-push-rebase-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  const git = (args: string[], input?: string) =>
    execFileSync('git', ['-C', top, ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
      env,
      input,
    });
  try {
    git(['read-tree', newBase]);
    const patch = git(['diff', '--binary', oldBase, tree]);
    if (patch) git(['apply', '--cached', '--3way', '-'], patch);
    return git(['write-tree']).trim() || null;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(`${tmp}.lock`, { force: true });
  }
}

/** Review triggers in the diff between two trees of the repository at top. Null when git cannot say. */
export function paperChangesBetween(
  top: string,
  from: string,
  to: string,
  exec: Exec = defaultExec,
): string[] | null {
  try {
    const diff = exec('git', ['-C', top, 'diff', '-U0', from, to, '--', '*.tex']);
    const changed = exec('git', ['-C', top, 'diff', '--name-only', from, to])
      .split('\n')
      .filter(Boolean);
    const newFiles: Record<string, string> = {};
    for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
      try {
        newFiles[m[1]!] = fs.readFileSync(path.join(top, m[1]!), 'utf-8');
      } catch {
        /* vanished between git and read */
      }
    }
    return paperChangeTriggers(
      diff,
      [],
      changed.filter((f) => !compiledPdf(top, f)),
      newFiles,
    );
  } catch {
    return null;
  }
}

export interface PaperPushState {
  /** First .tex edit inside the repository since its last allowed push; null if none. */
  firstEditSeq: number | null;
  /** Latest checker or reviewer result for the repository after firstEditSeq (any earlier one when
   * it is null), with its snapshot tree and upstream merge-base (null when not recorded); null if
   * none. */
  review: { seq: number; tree: string | null; base: string | null } | null;
  /** Last allowed push from the repository; 0 if none. */
  lastPushSeq: number;
  /** Snapshot tree recorded on that push; null if none. */
  lastPushTree: string | null;
  /** Refusals for the repository since its last allowed push. */
  blocks: number;
}

/** Built from the session's events for the repository whose real toplevel is `top`:
 * research_tex_edit under it, earlier research_paper_push_gate decisions for it, and checker or
 * reviewer results whose `repo` is it. A result recorded without `repo` counts when its artifact
 * is inside `top`. */
export function paperPushState(store: Store, sessionId: string, top: string): PaperPushState {
  const lastPush = store.get<{ seq: number; tree: unknown }>(
    "SELECT seq,json_extract(content,'$.tree') tree FROM events WHERE session_id=? AND type='research_paper_push_gate' AND json_extract(content,'$.decision') IN ('allow','advise') AND json_extract(content,'$.top')=? ORDER BY seq DESC LIMIT 1",
    sessionId,
    top,
  );
  const lastPushSeq = lastPush?.seq ?? 0;
  const firstEditSeq =
    store
      .all<{
        seq: number;
        path: unknown;
      }>(
        "SELECT seq,json_extract(content,'$.path') path FROM events WHERE session_id=? AND type='research_tex_edit' AND seq>? ORDER BY seq",
        sessionId,
        lastPushSeq,
      )
      .find((e) => typeof e.path === 'string' && inside(top, real(e.path)))?.seq ?? null;
  const review = store
    .all<{
      seq: number;
      artifact: unknown;
      repoType: string | null;
      repo: unknown;
      tree: unknown;
      base: unknown;
    }>(
      "SELECT seq,json_extract(content,'$.artifact') artifact,json_type(content,'$.repo') repoType,json_extract(content,'$.repo') repo,json_extract(content,'$.tree') tree,json_extract(content,'$.base') base FROM events WHERE session_id=? AND type IN ('research_checker_result','research_reviewer_result') AND seq>? ORDER BY seq DESC",
      sessionId,
      firstEditSeq ?? 0,
    )
    .find((row) =>
      row.repoType === null
        ? typeof row.artifact === 'string' && inside(top, real(row.artifact))
        : typeof row.repo === 'string' && real(row.repo) === top,
    );
  const blocks =
    store.get<{ n: number }>(
      "SELECT COUNT(*) n FROM events WHERE session_id=? AND type='research_paper_push_gate' AND json_extract(content,'$.decision')='deny' AND json_extract(content,'$.top')=? AND seq>?",
      sessionId,
      top,
      lastPushSeq,
    )?.n ?? 0;
  return {
    firstEditSeq,
    review: review
      ? {
          seq: review.seq,
          tree: typeof review.tree === 'string' ? review.tree : null,
          base: typeof review.base === 'string' ? review.base : null,
        }
      : null,
    lastPushSeq,
    lastPushTree: typeof lastPush?.tree === 'string' ? lastPush.tree : null,
    blocks,
  };
}

export type PaperPushWhy =
  | 'unknown'
  | 'minor'
  | 'reviewed'
  | 'retry'
  | 'cap'
  | 'unreviewed'
  | 'unreviewed-since-review';
export interface PaperPushVerdict {
  decision: 'allow' | 'deny' | 'advise';
  why: PaperPushWhy;
  reason?: string;
}

export function paperPushDecision(input: {
  state: PaperPushState;
  dir: string;
  /** Real path of the repository's toplevel; null when unknown. */
  top: string | null;
  triggers: string[] | null;
  /** Snapshot tree of the repository now; null when git could not make one. */
  tree: string | null;
  /** Triggers in the diff from the review (its tree, replayed onto the current merge-base when
   * upstream moved) to the tree now, and the tree compared from; null when git cannot say. */
  sinceReview?: (
    review: { tree: string; base: string | null },
    to: string,
  ) => { triggers: string[]; from: string } | null;
  mode: 'deny' | 'advise';
}): PaperPushVerdict {
  const { state: s, triggers, dir, tree } = input;
  if (triggers === null) return { decision: 'allow', why: 'unknown' };
  if (triggers.length === 0) return { decision: 'allow', why: 'minor' };
  // git rejected the last allowed push and nothing changed since.
  if (s.lastPushSeq > 0 && tree !== null && tree === s.lastPushTree)
    return { decision: 'allow', why: 'retry' };
  let since: { triggers: string[]; from: string } | null = null;
  if (s.review) {
    if (!s.review.tree || !tree || !input.sinceReview)
      return { decision: 'allow', why: 'reviewed' };
    since = input.sinceReview({ tree: s.review.tree, base: s.review.base }, tree);
    if (!since || since.triggers.length === 0) return { decision: 'allow', why: 'reviewed' };
  }
  if (s.blocks >= MAX_REVIEW_BLOCKS) return { decision: 'allow', why: 'cap' };
  const repo = input.top ?? dir;
  const rearm =
    'Edits after a review re-arm this check only when they trip a trigger on their own.';
  const tail = `After ${MAX_REVIEW_BLOCKS} refusals for the same change the push is allowed.`;
  if (since) {
    const steps =
      `Paper changes to a claim, number, caption, figure or the abstract go out after a checker or reviewer pass (research.workers.review.paperPush).\n` +
      `  1. research_delegate role checker, artifact <the changed .tex file inside ${repo}>, the diff command below (what changed since the review) and the notes the claims rest on, not a summary of them.\n` +
      `     diff: git -C ${repo} diff ${since.from} ${tree}\n` +
      `  2. Wait for it to complete; its result opens this check, not the dispatch.\n` +
      `  3. Re-issue the push. ${rearm}`;
    if (input.mode === 'advise')
      return {
        decision: 'advise',
        why: 'unreviewed-since-review',
        reason: `Clawstrum paper push advisory: this git push in ${dir} has edits since the last checker or reviewer result that would need one on their own (${since.triggers.join('; ')}). The push proceeds.\n${steps}`,
      };
    return {
      decision: 'deny',
      why: 'unreviewed-since-review',
      reason: `Refusing git push in ${dir}: a checker or reviewer returned on this repository, but the edits since it would need one on their own (${since.triggers.join('; ')}). ${steps} ${tail}`,
    };
  }
  const steps =
    `Paper changes to a claim, number, caption, figure or the abstract go out after a checker or reviewer pass (research.workers.review.paperPush).\n` +
    `  1. research_delegate role checker (a changed claim, number or caption) or reviewer (a new figure, section or abstract: goal and venue in the brief), artifact <the .tex file inside ${repo}>, the diff command below and the notes the claims rest on, not a summary of them.\n` +
    `     diff: git -C ${repo} diff $(git -C ${repo} merge-base HEAD @{u})\n` +
    `  2. Wait for it to complete; its result opens this check, not the dispatch.\n` +
    `  3. Re-issue the push. ${rearm}`;
  if (input.mode === 'advise')
    return {
      decision: 'advise',
      why: 'unreviewed',
      reason: `Clawstrum paper push advisory: this git push in ${dir} has paper changes against the upstream merge-base (${triggers.join('; ')}) and no checker or reviewer has returned since the change's first .tex edit. The push proceeds.\n${steps}`,
    };
  return {
    decision: 'deny',
    why: 'unreviewed',
    reason: `Refusing git push in ${dir}: it has paper changes against the upstream merge-base (${triggers.join('; ')}) and no checker or reviewer has returned since the change's first .tex edit. ${steps} ${tail}`,
  };
}
