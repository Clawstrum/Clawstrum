import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { isVoice, runTranscriber, transcribeVoiceNotes, TRANSCRIPT_NOTE } from '../src/voice.js';
import type { Provider } from '../src/types.js';
import { fixture, settle } from './helpers.js';

// Stands in for scripts/transcribe.py: the audio file's content picks the behavior, and each call is counted.
const FAKE = `import fs from 'node:fs';
const [audio, ...rest] = process.argv.slice(2);
fs.appendFileSync(audio + '.calls', 'x');
const mode = fs.readFileSync(audio, 'utf8');
if (mode === 'fail') { console.error('loading model\\nno module named sherpa_onnx'); process.exit(1); }
if (mode === 'slow') setTimeout(() => {}, 60000);
else console.log(JSON.stringify({ text: 'Jeff [Jev?] said hi ' + rest.join(' '), duration_s: 2.5 }));
`;

function setup(
  t: any,
  mode: string,
  name = 'voice-message.ogg',
  contentType: string | undefined = 'audio/ogg',
) {
  const f = fixture(t);
  const script = path.join(f.home, 'fake-transcriber.mjs');
  fs.writeFileSync(script, FAKE);
  const audio = path.join(f.session.workspace, 'clip');
  fs.mkdirSync(f.session.workspace, { recursive: true });
  fs.writeFileSync(audio, mode);
  f.enqueue('m');
  f.store.exec(
    'UPDATE inbound SET attachments=? WHERE id=?',
    JSON.stringify([
      { name, url: 'https://cdn.discordapp.com/a', size: 4, contentType, path: audio },
      {
        name: 'notes.txt',
        url: 'https://cdn.discordapp.com/b',
        size: 4,
        contentType: 'text/plain',
        path: audio,
      },
    ]),
    'm',
  );
  f.config.voice = { enabled: true, python: process.execPath, asrDir: 'asr', script };
  const calls = () =>
    fs.existsSync(audio + '.calls') ? fs.readFileSync(audio + '.calls', 'utf8').length : 0;
  return { f, audio, calls };
}

test('voice notes are off by default and audio is recognized by type, then by extension', () => {
  const minimal = configSchema.parse({
    version: 1,
    discord: { ownerIds: ['123456'], channelIds: ['987654'], guildId: '555555' },
    accounts: [{ id: 'a', provider: 'claude', home: '/tmp/a' }],
  });
  assert.deepEqual(minimal.voice, { enabled: false, python: 'python3', asrDir: 'asr' });
  const a = (name: string, contentType?: string) => ({ name, url: '', size: 1, contentType });
  assert.ok(isVoice(a('voice-message.ogg', 'audio/ogg')));
  assert.ok(isVoice(a('x.bin', 'audio/mpeg')));
  assert.ok(!isVoice(a('x.ogg', 'video/ogg')));
  assert.ok(isVoice(a('memo.M4A')));
  assert.ok(!isVoice(a('data.csv')));
});

test('a voice note gets its transcript once, with word lists from home and workspace', async (t) => {
  const { f, audio, calls } = setup(t, 'ok');
  const messages = f.store.claim(f.session.id)!.messages;
  await transcribeVoiceNotes(
    f.store,
    messages,
    f.config.voice,
    f.session.workspace,
    new AbortController().signal,
  );
  const [voice, text] = JSON.parse(messages[0]!.attachments);
  assert.match(voice.transcript, /^Jeff \[Jev\?\] said hi /);
  for (const file of [
    path.join(f.home, 'voice-words.txt'),
    path.join(f.session.workspace, 'voice-words.txt'),
    path.join(f.home, 'AGENTS.md'),
    path.join(f.session.workspace, 'AGENTS.md'),
  ])
    assert.ok(voice.transcript.includes(file), file);
  assert.ok(voice.transcript.includes(`--asr-dir ${path.join(f.home, 'asr')}`));
  assert.equal(voice.transcriptNote, TRANSCRIPT_NOTE);
  assert.equal(voice.durationS, 2.5);
  assert.equal(text.transcript, undefined);
  const stored = f.store.get<{ attachments: string }>(
    'SELECT attachments FROM inbound WHERE id=?',
    'm',
  )!;
  assert.equal(JSON.parse(stored.attachments)[0].transcript, voice.transcript);
  await transcribeVoiceNotes(
    f.store,
    messages,
    f.config.voice,
    f.session.workspace,
    new AbortController().signal,
  );
  assert.equal(calls(), 1);
  assert.ok(fs.existsSync(audio));
});

test('a failed transcription keeps the message and records why', async (t) => {
  const { f } = setup(t, 'fail', 'memo.m4a', undefined);
  const messages = f.store.claim(f.session.id)!.messages;
  await transcribeVoiceNotes(
    f.store,
    messages,
    f.config.voice,
    f.session.workspace,
    new AbortController().signal,
  );
  const [voice] = JSON.parse(messages[0]!.attachments);
  assert.equal(voice.transcript, undefined);
  assert.equal(voice.transcriptError, 'no module named sherpa_onnx');
  const event = f.store.get<{ content: string }>(
    "SELECT content FROM events WHERE type='voice_transcribed'",
  );
  assert.equal(JSON.parse(event!.content).ok, false);
});

test('a missing transcriber and a timeout are reported, not thrown', async (t) => {
  const { f, audio } = setup(t, 'slow');
  const messages = f.store.claim(f.session.id)!.messages;
  await transcribeVoiceNotes(
    f.store,
    messages,
    { ...f.config.voice, script: path.join(f.home, 'missing.py') },
    f.session.workspace,
    new AbortController().signal,
  );
  assert.match(JSON.parse(messages[0]!.attachments)[0].transcriptError, /script missing/);
  const timedOut = await runTranscriber(audio, {
    python: process.execPath,
    script: f.config.voice.script!,
    asrDir: 'asr',
    words: [],
    notes: [],
    signal: new AbortController().signal,
    timeoutMs: 300,
  });
  assert.deepEqual(timedOut, { ok: false, reason: 'timed out after 0 s' });
});

test('cancelling the run stops the transcriber and stores nothing', async (t) => {
  const { f } = setup(t, 'slow');
  const messages = f.store.claim(f.session.id)!.messages;
  const ctrl = new AbortController();
  const pending = transcribeVoiceNotes(
    f.store,
    messages,
    f.config.voice,
    f.session.workspace,
    ctrl.signal,
  );
  setTimeout(() => ctrl.abort(new Error('stop requested')), 300);
  await assert.rejects(pending, /stop requested/);
  const stored = f.store.get<{ attachments: string }>(
    'SELECT attachments FROM inbound WHERE id=?',
    'm',
  )!;
  assert.equal(JSON.parse(stored.attachments)[0].transcript, undefined);
  assert.equal(JSON.parse(stored.attachments)[0].transcriptError, undefined);
});

test('the lead turn sees the transcript and the note in its input', async (t) => {
  const { f } = setup(t, 'ok');
  let prompt = '';
  const provider: Provider = {
    async run(r) {
      prompt = r.prompt;
      return 'Done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: provider, codex: provider });
  t.after(() => engine.stop());
  engine.tick();
  await settle(engine);
  assert.match(prompt, /Jeff \[Jev\?\] said hi/);
  assert.ok(prompt.includes('voice-words.txt in this workspace'));
});

test('with voice notes off the transcriber never runs', async (t) => {
  const { f, calls } = setup(t, 'ok');
  f.config.voice.enabled = false;
  const done: Provider = {
    async run() {
      return 'Done';
    },
  };
  const engine = new Engine(f.config, f.store, { claude: done, codex: done });
  t.after(() => engine.stop());
  engine.tick();
  await settle(engine);
  assert.equal(calls(), 0);
});
