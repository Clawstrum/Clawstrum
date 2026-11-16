/**
 * Length ceilings on an outgoing reply, checked on the same path as citations.
 *
 * The predecessor deployment carried an 8-line ceiling as an instruction in the system prompt and
 * nothing else. Measured across 905 sent messages, 63 per cent were over it. That is the clearest
 * single piece of evidence behind this whole branch: the model does not hold a length budget it is
 * merely told about, because nothing in the loop ever reads back what it sent.
 *
 * So this returns issues into the reply review, which can hold a proposal and hand back one
 * correction. Two ceilings, both mechanical:
 *
 *   - characters, defaulting to 2000, which is also Discord's hard per-message limit
 *   - lines, defaulting to 25, which is the point past which a chat reply stops being read
 *
 * What it deliberately does not check is register, structure, or whether the bullets were earned.
 * Those are the parts of the rule that matter most and none of them is decidable from the text, so
 * putting them here would produce a gate that fires on taste. The feedback line says to cut rather
 * than reword, because rewording is what a model does when told a message is too long, and it
 * preserves every claim while losing only the words that made them readable.
 */

export interface ReplyLimits {
  /** 0 disables the check. */
  maxLines: number;
  /** 0 disables the check. */
  maxChars: number;
}

export function replyShapeIssues(text: string, limits: ReplyLimits): string[] {
  const body = text.trimEnd();
  const issues: string[] = [];
  const lines = body ? body.split('\n').length : 0;
  if (limits.maxLines && lines > limits.maxLines)
    issues.push(`reply: ${lines} lines against a ceiling of ${limits.maxLines}`);
  if (limits.maxChars && body.length > limits.maxChars)
    issues.push(`reply: ${body.length} characters against a ceiling of ${limits.maxChars}`);
  return issues;
}
