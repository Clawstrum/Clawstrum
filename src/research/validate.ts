import fs from 'node:fs';

/**
 * Checks run over a finished subagent's result, before the lead is woken with it.
 *
 * A subagent's output is a lead, not evidence, and the lead agent has no cheap way to tell a result
 * that was read out of the sources from one that was written in the shape of a result. These checks
 * do not judge the content. They compare the claim against the subagent's own event log, which is the
 * one record the subagent did not author.
 *
 * The predecessor deployment shipped a validator that parsed a JSON envelope workers were asked to
 * emit. It matched 0 of 231 real worker outputs and ran that way for months, because free prose was
 * always the actual output shape and nothing asserted otherwise. Two rules follow from that, and
 * both are structural here rather than advisory:
 *
 *   1. Nothing depends on the subagent's cooperation. Every input is either free text or the event log
 *      the runtime wrote, so there is no format the subagent can fail to produce.
 *   2. The result event is recorded on every run, findings or none. A check that fires on nothing is
 *      indistinguishable from a check that is not running, unless the zero is written down.
 *
 * Findings ride the wake message next to the summary, because the lead reads the summary and not the
 * event log. They are caveats, not blocks: a subagent that read nothing may still be right, and a
 * result withheld from the lead is worse than one it is told to distrust.
 */

/** Absolute paths as they appear in prose, backticks or lists. The lookbehind drops the tail of a
 * URL and of a path already being matched, both of which are otherwise reported as missing files. */
const PATH_PATTERN = /(?<![\w/:])\/(?:[\w.+@-]+\/)+[\w.+@-]+/g;
/** Existence checks are syscalls on a path list an untrusted subagent controls the length of. */
const MAX_CHECKED = 50;
const MAX_REPORTED = 5;

export interface WorkerEvidence {
  /** Tool events the subagent emitted, counted from its own event log. */
  toolEvents: number;
  /** Paths the brief handed it. */
  suppliedPaths: string[];
  /** How many of those the event log mentions anywhere. */
  suppliedPathsSeen: number;
}

export function citedPaths(text: string): string[] {
  return [...new Set(text.match(PATH_PATTERN) ?? [])]
    .map((file) => file.replace(/[.,;:)\]]+$/, ''))
    .slice(0, MAX_CHECKED);
}

export function workerEvidence(eventLog: string, suppliedPaths: string[]): WorkerEvidence {
  let log = '';
  try {
    log = fs.readFileSync(eventLog, 'utf8');
  } catch {
    // A missing log is zero evidence, which is what the checks below already treat it as.
  }
  return {
    toolEvents: log.split('\n').filter((line) => {
      try {
        return JSON.parse(line).type === 'activity';
      } catch {
        return false;
      }
    }).length,
    suppliedPaths,
    suppliedPathsSeen: suppliedPaths.filter((file) => log.includes(file)).length,
  };
}

export function workerFindings(
  text: string,
  evidence: WorkerEvidence,
  exists: (file: string) => boolean = fs.existsSync,
): string[] {
  const findings: string[] = [];
  if (!evidence.toolEvents)
    findings.push(
      'The subagent emitted no recorded tool activity. The log does not establish source inspection; verify specific claims before relying on them.',
    );
  if (evidence.suppliedPaths.length && !evidence.suppliedPathsSeen)
    findings.push(
      `None of the ${evidence.suppliedPaths.length} supplied paths appear literally in the subagent's event log. Relative paths, truncated events and equivalent paths can escape this check; source inspection is unconfirmed.`,
    );
  const missing = citedPaths(text).filter((file) => !exists(file));
  if (missing.length)
    findings.push(
      `Paths cited in the result that do not exist: ${missing.slice(0, MAX_REPORTED).join(', ')}${
        missing.length > MAX_REPORTED ? ` and ${missing.length - MAX_REPORTED} more` : ''
      }. Check these before quoting anything attributed to them.`,
    );
  return findings;
}
