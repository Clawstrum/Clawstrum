import fs from 'node:fs';
import path from 'node:path';

export interface DecisionFinding {
  line: number;
  code: string;
  message: string;
}
/** Advisory syntax/conflict checks; never edits memory or imposes a tool gate. */
export function lintDecisions(text: string): DecisionFinding[] {
  const findings: DecisionFinding[] = [];
  const active = new Map<string, number>();
  let retired = false,
    fence = '';
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const number = index + 1;
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      continue;
    }
    if (fence) continue;
    const heading = /^#{1,2}\s+(.+)/.exec(line);
    if (heading) {
      retired = /\b(superseded|retired|history)\b/i.test(heading[1]!);
      continue;
    }
    if (!/^\s*[-*]\s+\d{4}-\d{2}-\d{2}\b/.test(line)) continue;
    const parsed = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\s+\[([a-z0-9][a-z0-9._-]*)\]:\s*(\S.*)$/.exec(
      line,
    );
    if (!parsed) {
      findings.push({
        line: number,
        code: 'format',
        message: 'Use - YYYY-MM-DD [tag]: decision text.',
      });
      continue;
    }
    const [, date, tag, body] = parsed;
    const time = Date.parse(date! + 'T00:00:00Z');
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date)
      findings.push({
        line: number,
        code: 'date',
        message: 'Decision has an invalid calendar date.',
      });
    if (retired) {
      if (!/\b(superseded|replaced|retired)\b.*\S/i.test(body!))
        findings.push({
          line: number,
          code: 'retirement',
          message: 'State what replaced this decision or why it was retired.',
        });
    } else if (active.has(tag!)) {
      findings.push({
        line: number,
        code: 'duplicate',
        message: `Tag [${tag}] is also active on line ${active.get(tag!)}; explicitly retire the replaced decision.`,
      });
    } else active.set(tag!, number);
  }
  return findings;
}
export function lintDecisionFile(file: string, sharedTarget?: string): DecisionFinding[] {
  const findings = lintDecisions(fs.readFileSync(file, 'utf8'));
  if (
    sharedTarget &&
    (!fs.lstatSync(file).isSymbolicLink() ||
      fs.realpathSync(file) !== fs.realpathSync(path.resolve(sharedTarget)))
  )
    findings.unshift({
      line: 0,
      code: 'shared-target',
      message: 'This file must link to the explicitly selected shared decision file.',
    });
  return findings;
}
