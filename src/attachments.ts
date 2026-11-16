import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Attachment, Inbound } from './types.js';
import type { Store } from './store.js';
import { classifyError } from './accounts.js';

export function safeName(name: string): string {
  return (
    path
      .basename(name)
      .replace(/[^\p{L}\p{N}._ -]/gu, '_')
      .slice(-150) || 'attachment'
  );
}
export async function downloadAttachments(
  store: Store,
  messages: Inbound[],
  workspace: string,
  maxBytes: number,
  signal: AbortSignal = new AbortController().signal,
  maxAttempts = 3,
  refresh?: (messageId: string, attachment: Attachment) => Promise<string | undefined>,
): Promise<Inbound[]> {
  const ready: Inbound[] = [];
  for (const message of messages) {
    signal.throwIfAborted();
    try {
      const attachments = JSON.parse(message.attachments) as Attachment[];
      for (const a of attachments) {
        if (a.path && fs.existsSync(a.path)) continue;
        let url = new URL(a.url);
        if (
          url.protocol !== 'https:' ||
          !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
        )
          throw new Error('Attachment URL must be a Discord CDN URL');
        if (a.size > maxBytes)
          throw new Error(`Attachment ${a.name} exceeds the configured size limit`);
        const options = {
          redirect: 'error' as const,
          signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        };
        let response = await fetch(url, options);
        signal.throwIfAborted();
        if ([401, 403, 404].includes(response.status) && refresh) {
          await response.body?.cancel();
          const fresh = await refresh(message.id, a);
          signal.throwIfAborted();
          if (fresh) {
            url = new URL(fresh);
            if (
              url.protocol !== 'https:' ||
              !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
            )
              throw new Error('Refreshed attachment URL must be a Discord CDN URL');
            a.url = fresh;
            response = await fetch(url, options);
            signal.throwIfAborted();
          }
        }
        if (!response.ok || !response.body)
          throw new Error(`Attachment download failed: HTTP ${response.status}`);
        const dir = path.join(workspace, 'attachments');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const filename = path.join(dir, `${randomUUID()}-${safeName(a.name)}`);
        const handle = fs.openSync(`${filename}.part`, 'wx', 0o600);
        let total = 0;
        try {
          for await (const chunk of response.body) {
            signal.throwIfAborted();
            total += chunk.length;
            if (total > maxBytes)
              throw new Error(`Attachment ${a.name} exceeds the configured size limit`);
            fs.writeSync(handle, chunk);
          }
          fs.closeSync(handle);
          fs.renameSync(`${filename}.part`, filename);
          a.path = filename;
          delete a.error;
          message.attachments = JSON.stringify(attachments);
          store.exec(
            'UPDATE inbound SET attachments=? WHERE id=?',
            message.attachments,
            message.id,
          );
        } catch (error) {
          try {
            fs.closeSync(handle);
          } catch {
            /* already closed */
          }
          fs.rmSync(`${filename}.part`, { force: true });
          throw error;
        }
      }
      message.attachments = JSON.stringify(attachments);
      store.exec('UPDATE inbound SET attachments=? WHERE id=?', message.attachments, message.id);
      ready.push(message);
    } catch (error) {
      signal.throwIfAborted();
      const failure = classifyError(error);
      const attempts = message.attempts + 1;
      const retry = failure.kind === 'transient' && attempts < maxAttempts;
      store.exec(
        'UPDATE inbound SET status=?,attempts=?,available_at=?,batch_id=NULL WHERE id=?',
        retry ? 'queued' : 'failed',
        attempts,
        Date.now() + Math.min(60000, 5000 * 2 ** (attempts - 1)),
        message.id,
      );
      store.event(message.session_id, null, 'attachment_error', {
        message: message.id,
        retry,
        error: failure.message,
      });
      if (!retry)
        store.outbox(
          message.session_id,
          `Attachment on message ${message.id} could not be downloaded: ${failure.message}. Reattach the file or fix the cause and resume.`,
          { key: `attachment:${message.id}:${attempts}` },
        );
    }
  }
  return ready;
}
export function spoolFile(store: Store, filename: string, maxBytes: number): string {
  const stat = fs.statSync(filename);
  if (!stat.isFile()) throw new Error('Attachment must be a regular file');
  if (stat.size > maxBytes)
    throw new Error('File exceeds the configured Discord attachment size limit');
  const dir = path.join(store.home, 'outgoing');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, `${randomUUID()}-${safeName(filename)}`);
  fs.copyFileSync(filename, dest);
  fs.chmodSync(dest, 0o600);
  return dest;
}
