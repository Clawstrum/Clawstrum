import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from '../store.js';
import type { ResearchConfig } from './config.js';
import { writePrivate } from '../files.js';
import { scanCitations, type CitationScan } from './citations.js';
import { replyShapeIssues } from './shape.js';

const feedbackKey = (scope: string) => `research-reply-review:${scope}`;
export function replyFeedback(store: Store, scope: string): string | undefined {
  return store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', feedbackKey(scope))
    ?.value;
}
const holdKey = (scope: string) => `research-review-hold:${scope}`;
/** Everything the next attempt at this input's reply must see: the one-shot review correction and
 * a review hold. The hold has its own key so that it never spends the review's correction. */
export function replyCorrections(
  store: Store,
  config: ResearchConfig,
  scope: string,
): string | undefined {
  if (!config.enabled) return undefined;
  const hold = store.get<{ value: string }>(
    'SELECT value FROM metadata WHERE key=?',
    holdKey(scope),
  )?.value;
  const review = config.validation !== 'off' ? replyFeedback(store, scope) : undefined;
  return [review, hold].filter(Boolean).join('\n\n') || undefined;
}
export interface ReplyReview {
  blocked: boolean;
  feedback?: string;
  artifactPath?: string;
}
/** Both provider results and MCP sends pass here before creating a new outbox row.
 * One durable correction opportunity per logical input, shared across routes/accounts.
 * This is a quality check, not an access boundary or a claim of verified science.
 */
export function reviewReply(
  store: Store,
  config: ResearchConfig,
  input: {
    sessionId: string;
    runId: string;
    scope: string;
    text: string;
    route: string;
    document?: { path: string; text?: string; error?: string };
  },
): ReplyReview {
  if (!config.enabled) return { blocked: false };
  const hold = reviewHold(store, config, input);
  if (hold) return hold;
  if (config.validation === 'off') return { blocked: false };
  const scans: Array<{ source: string; scan?: CitationScan; error?: string }> = [];
  for (const source of [
    { path: 'reply', text: input.text },
    ...(input.document ? [input.document] : []),
  ]) {
    try {
      if ('error' in source && source.error) throw new Error(source.error);
      scans.push({ source: source.path, scan: scanCitations(store, source.text ?? '') });
    } catch (error) {
      scans.push({ source: source.path, error: String(error) });
    }
  }
  const citationIssues = scans.flatMap((s) =>
    s.error
      ? [`${s.source}: scan unavailable: ${s.error}`]
      : s.scan!.findings.map((f) => `${s.source}:${f.line}: ${f.message}`),
  );
  // Length shares the one correction opportunity rather than taking a second: a reply long enough to
  // trip the ceiling and wrong enough to trip a citation is one reply to fix, not two turns to spend.
  // Only the message body is measured; an attached document has no reason to be short.
  const shapeIssues = replyShapeIssues(input.text, config.reply);
  const issues = [...citationIssues, ...shapeIssues];
  if (!issues.length) return { blocked: false };
  return store.transaction(() => {
    const blocked = config.validation === 'strict' && !replyFeedback(store, input.scope);
    const artifactPath = path.join(
      store.home,
      'research',
      'reply-reviews',
      input.sessionId,
      `${randomUUID()}.json`,
    );
    writePrivate(
      artifactPath,
      JSON.stringify({ ...input, mode: config.validation, blocked, scans, shapeIssues }, null, 2),
    );
    const remedies = [
      citationIssues.length
        ? 'Resolve metadata with research_citation, correct the attribution or state what remains uncertain.'
        : '',
      shapeIssues.length
        ? 'Cut the reply rather than rewording it: drop whole points (what was checked and turned out fine first), never the definitions of the points you keep, and move detail that has to survive into a file the reply names.'
        : '',
    ].filter(Boolean);
    const feedback = `Clawstrum reply review${blocked ? ' held this proposed reply before delivery' : ' found remaining issues (delivery allowed)'}.\n${issues.join('\n').slice(0, 2400)}\nFull proposal and review: ${artifactPath}\n${remedies.join(' ')} Review the proposed answer only; do not repeat completed external actions. One correction opportunity is shared by all sends/final results for this input; remaining issues are recorded, not silently certified as correct.`;
    if (blocked)
      store.exec('INSERT INTO metadata(key,value) VALUES(?,?)', feedbackKey(input.scope), feedback);
    store.event(input.sessionId, input.runId, 'research_reply_review', {
      route: input.route,
      mode: config.validation,
      blocked,
      artifactPath,
      issueCount: issues.length,
      // Split so the two checks can be counted apart later; one firing on nothing would otherwise be
      // hidden inside the other's total.
      citationIssues: citationIssues.length,
      shapeIssues: shapeIssues.length,
      scope: input.scope,
    });
    return { blocked, feedback, artifactPath };
  });
}
/** workers.review.hold: a send from the run that consumed a checker or reviewer result's wake is
 * held once, so the checked result is read before the user hears anything. The run's inputs are the
 * inbound rows batched under its logical id; the wake is `research:worker:<workerId>` (records.ts
 * researchWake). Never on the interim route, whose held text has no retry. Its own switch,
 * independent of validation. */
function reviewHold(
  store: Store,
  config: ResearchConfig,
  input: { sessionId: string; runId: string; scope: string; route: string },
): ReplyReview | undefined {
  if (config.workers.review.hold !== 'once' || input.route === 'provider-interim') return undefined;
  return store.transaction(() => {
    const result = store.get<{ seq: number; type: string; content: string }>(
      `SELECT e.seq,e.type,e.content FROM runs r
       JOIN inbound i ON i.session_id=r.session_id AND i.batch_id=r.logical_id AND i.id LIKE 'research:worker:%'
       JOIN events e ON e.session_id=r.session_id AND e.type IN ('research_checker_result','research_reviewer_result') AND json_extract(e.content,'$.id')=substr(i.id,17)
       WHERE r.id=? AND r.session_id=? AND NOT EXISTS (
         SELECT 1 FROM events h WHERE h.session_id=r.session_id AND h.type='research_review_hold' AND json_extract(h.content,'$.workerId')=json_extract(e.content,'$.id'))
       ORDER BY e.seq DESC LIMIT 1`,
      input.runId,
      input.sessionId,
    );
    if (!result) return undefined;
    let record: Record<string, unknown> = {};
    try {
      record = JSON.parse(result.content);
    } catch {
      /* The hold still applies; only the counts are lost. */
    }
    const count = (key: string) => (typeof record[key] === 'number' ? record[key] : '?');
    const verdicts = (record.counts ?? {}) as Record<string, unknown>;
    const verdict = (key: string) => (typeof verdicts[key] === 'number' ? verdicts[key] : '?');
    const workerId = typeof record.id === 'string' ? record.id : 'unknown';
    const outcome =
      result.type === 'research_reviewer_result'
        ? `reviewer subagent ${workerId} completed: main ${verdict('main')} / fix ${verdict('fix')} / develop ${verdict('develop')} / supporting ${verdict('supporting')} / dead_end ${verdict('dead_end')} / cut ${verdict('cut')} / stop ${verdict('stop')}, slots ${count('slots')}`
        : `checker subagent ${workerId} completed with ${count('objections')} objection(s) (${count('verified')} verified, ${count('unverified')} unverified, ${count('unbacked')} unbacked)`;
    const feedback = `Clawstrum held this reply once: ${outcome}. Read the checked evidence in that subagent's wake before replying; the next attempt is released.`;
    store.exec(
      'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
      holdKey(input.scope),
      feedback,
    );
    store.event(input.sessionId, input.runId, 'research_review_hold', {
      workerId,
      scope: input.scope,
    });
    return { blocked: true, feedback };
  });
}
