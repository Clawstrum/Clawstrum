import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Attachment, Inbound } from './types.js';
import type { Store } from './store.js';
import { expandPath, type Config } from './config.js';

// Voice notes are transcribed on the daemon's host, after download and before the turn. Off by default; setup in
// docs/customize.md#voice-notes. The transcript is stored on the attachment record, so the prompt and the history
// archive both carry it, and a retried run does not transcribe twice.

const AUDIO_EXTENSIONS = ['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.wav', '.webm'];
const TIMEOUT_CAP_MS = 20 * 60 * 1000;
export const TRANSCRIPT_NOTE =
  "Speech-to-text, names and jargon may be misheard; 'heard [meant?]' marks a known sound-alike. Read it with the " +
  'conversation in mind, say which words you corrected, and add each corrected name or term to voice-words.txt in ' +
  "this workspace: one term per line, or 'heard -> meant' when it came out as a common word.";

export type TranscribeResult =
  | { ok: true; text: string; durationS: number }
  | { ok: false; reason: string };

export function isVoice(a: Attachment): boolean {
  if (a.contentType) return a.contentType.startsWith('audio/');
  return AUDIO_EXTENSIONS.some((ext) => a.name.toLowerCase().endsWith(ext));
}

/** Decoding runs at about real time on one core, plus model load; an Opus voice note is ~3 KB per second. */
export function transcribeTimeoutMs(bytes: number): number {
  return Math.min(Math.round(90_000 + 1.5 * (bytes / 3000) * 1000), TIMEOUT_CAP_MS);
}

export function bundledTranscriber(): string {
  return fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url));
}

// One transcription at a time per daemon: each holds the ~630 MB model and up to four cores.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export function runTranscriber(
  audio: string,
  options: {
    python: string;
    script: string;
    asrDir: string;
    words: string[];
    notes: string[];
    signal: AbortSignal;
    timeoutMs?: number;
  },
): Promise<TranscribeResult> {
  if (options.signal.aborted) return Promise.reject(options.signal.reason);
  if (!fs.existsSync(options.script))
    return Promise.resolve({ ok: false, reason: `transcriber script missing: ${options.script}` });
  let bytes = 0;
  try {
    bytes = fs.statSync(audio).size;
  } catch {
    /* the transcriber reports the missing file */
  }
  const timeout = options.timeoutMs ?? transcribeTimeoutMs(bytes);
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TMPDIR'] as const)
    if (process.env[k] !== undefined) env[k] = process.env[k];
  const args = [options.script, audio, '--asr-dir', options.asrDir];
  for (const w of options.words) args.push('--words', w);
  for (const n of options.notes) args.push('--notes', n);
  return new Promise((resolve, reject) => {
    execFile(
      options.python,
      args,
      { timeout, maxBuffer: 8 * 1024 * 1024, env, signal: options.signal },
      (error, stdout, stderr) => {
        if (options.signal.aborted) return reject(options.signal.reason);
        if (error) {
          const e = error as NodeJS.ErrnoException & { killed?: boolean };
          if (e.killed)
            return resolve({
              ok: false,
              reason: `timed out after ${Math.round(timeout / 1000)} s`,
            });
          const tail = String(stderr).trim().split('\n').at(-1);
          return resolve({ ok: false, reason: (tail || e.message).slice(0, 300) });
        }
        try {
          const parsed = JSON.parse(String(stdout).trim().split('\n').at(-1) || '');
          if (typeof parsed?.text !== 'string')
            return resolve({ ok: false, reason: 'transcriber output had no text' });
          resolve({ ok: true, text: parsed.text, durationS: Number(parsed.duration_s) || 0 });
        } catch {
          resolve({ ok: false, reason: 'unparseable transcriber output' });
        }
      },
    );
  });
}

/**
 * Add a transcript (or transcriptError) to every downloaded audio attachment not seen before. A failure never drops
 * the message: the agent still gets the audio path. Cancellation of the run aborts the transcriber and rethrows.
 */
export async function transcribeVoiceNotes(
  store: Store,
  messages: Inbound[],
  voice: Config['voice'],
  workspace: string,
  signal: AbortSignal,
): Promise<void> {
  // relative paths in config.json are relative to CLAWSTRUM_HOME, like account homes
  const resolve = (p: string) =>
    p === '~' || p.startsWith('~/') ? expandPath(p) : path.resolve(store.home, p);
  const python = voice.python.includes('/') ? resolve(voice.python) : voice.python;
  const script = voice.script ? resolve(voice.script) : bundledTranscriber();
  const asrDir = resolve(voice.asrDir);
  for (const message of messages) {
    signal.throwIfAborted();
    const attachments = JSON.parse(message.attachments) as Attachment[];
    let changed = false;
    for (const a of attachments) {
      if (!a.path || !isVoice(a) || a.transcript !== undefined || a.transcriptError !== undefined)
        continue;
      const started = Date.now();
      const result = await serial(() =>
        runTranscriber(a.path!, {
          python,
          script,
          asrDir,
          words: [
            path.join(store.home, 'voice-words.txt'),
            path.join(workspace, 'voice-words.txt'),
          ],
          notes: [path.join(store.home, 'AGENTS.md'), path.join(workspace, 'AGENTS.md')],
          signal,
        }),
      );
      if (result.ok) {
        a.transcript = result.text.trim() || '(no speech recognized)';
        a.transcriptNote = TRANSCRIPT_NOTE;
        a.durationS = result.durationS;
      } else a.transcriptError = result.reason;
      changed = true;
      store.event(message.session_id, null, 'voice_transcribed', {
        message: message.id,
        ok: result.ok,
        audioS: result.ok ? result.durationS : undefined,
        elapsedMs: Date.now() - started,
        error: result.ok ? undefined : result.reason,
      });
    }
    if (changed) {
      message.attachments = JSON.stringify(attachments);
      store.exec('UPDATE inbound SET attachments=? WHERE id=?', message.attachments, message.id);
    }
  }
}
