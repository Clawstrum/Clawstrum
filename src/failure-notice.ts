import type { Account, Inbound, Run } from './types.js';
import { secretValues } from './secrets.js';

/** Errors can contain echoed environment values. Discord needs the cause, not credentials. */
export function safeText(text: string): string {
  for (const value of secretValues()) text = text.split(value).join('[redacted]');
  return text
    .replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(sk-(?:ant-)?[\w-]{12,}|gh[pousr]_[\w]{12,})\b/g, '[redacted]')
    .replace(
      /([\w-]*(?:token|password|secret|api[_-]?key)[\w-]*["']?\s*[:=]\s*)["']?[^\s,"']+/gi,
      '$1[redacted]',
    )
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function turnFailureNotice(input: {
  run: Run;
  messages: Inbound[];
  reason: string;
  next: string;
  account?: Account;
  taskPrompt?: string;
}): { content: string; messageId?: string } {
  const users = input.messages.filter((m) => m.kind === 'user');
  const lastUser = users.at(-1);
  const source = input.taskPrompt ?? lastUser?.content ?? input.messages[0]?.content ?? '';
  const title = safeText(source.replace(/^Scheduled follow-up\.[^\n]*\n/, '').split('\n')[0] ?? '')
    .replace(/[`*_<>]/g, '')
    .slice(0, 140);
  const subject = users.length ? 'Request' : 'Scheduled task';
  const provider = input.account
    ? ` on ${{ claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[input.account.provider]} (${input.account.id}${input.account.model ? ` / ${input.account.model}` : ''})`
    : '';
  const reason = safeText(input.reason);
  const requestId = reason.match(/\breq_[A-Za-z0-9]+\b/)?.[0];
  const summary = reason.length > 700 ? reason.slice(0, 697) + '...' : reason;
  return {
    content: `${subject}${title ? ` “${title}”` : ''} stopped${provider}.\nCause: ${summary}\n${input.next}\nRun: ${input.run.id}${requestId && !summary.includes(requestId) ? `; provider request: ${requestId}` : ''}`,
    // Use this turn's message, never a newer request that has not been admitted yet.
    messageId: lastUser && /^\d+$/.test(lastUser.id) ? lastUser.id : undefined,
  };
}
