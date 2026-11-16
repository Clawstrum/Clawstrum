import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_PROMPT,
  CODEX_BASE_PROMPT,
  basePrompt,
  codexBasePrompt,
  mainBasePrompt,
} from '../src/base-prompt.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const MAIN_ROLE = 'You look after this Clawstrum installation';

function tmp(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawstrum-base-prompt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('outside the main channel the base prompt is the research one', () => {
  assert.equal(basePrompt({}), BASE_PROMPT);
  assert.equal(basePrompt({ mainChannel: false }), BASE_PROMPT);
});

test('the main base prompt fills every placeholder from the package and the bundled customize skill', (t) => {
  const prompt = mainBasePrompt(tmp(t));
  assert.ok(prompt.startsWith(MAIN_ROLE));
  assert.equal(prompt.split('# How you work').length, 2);
  assert.equal(prompt.includes('{{'), false);
  assert.equal(prompt.includes('You are a research collaborator'), false);
  assert.ok(prompt.includes(packageRoot.replace(/\/+$/, '')));
  assert.ok(prompt.includes('# Clawstrum documentation'));
  assert.ok(prompt.includes('# Clawstrum architecture'));
  assert.ok(prompt.includes('Pick the smallest scope'));
  assert.equal(prompt.includes('name: customize'), false);
});

test('an installed customize skill replaces the bundled one', (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, 'skills', 'customize'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'skills', 'customize', 'SKILL.md'),
    '---\nname: customize\ndescription: local\n---\n\nINSTALLED_CUSTOMIZE_MARKER\n',
  );
  const prompt = mainBasePrompt(home);
  assert.ok(prompt.includes('INSTALLED_CUSTOMIZE_MARKER'));
  assert.equal(prompt.includes('Pick the smallest scope'), false);
  assert.equal(prompt.includes('name: customize'), false);
});

test('a package without source, docs or skills leaves no placeholders or empty skill heading', (t) => {
  const prompt = mainBasePrompt(tmp(t), tmp(t));
  assert.equal(prompt.includes('{{'), false);
  assert.equal(prompt.includes('# Changing Clawstrum'), false);
  assert.ok(prompt.includes('installed package with only the build'));
});

test('the Codex base prompt appends the Codex part to either base prompt', () => {
  const codexPart = fs
    .readFileSync(path.join(packageRoot, 'templates', 'base-prompt-codex.md'), 'utf8')
    .trim();
  const main = codexBasePrompt({ mainChannel: true });
  assert.ok(main.startsWith(MAIN_ROLE));
  assert.ok(main.endsWith(codexPart));
  assert.equal(codexBasePrompt({}), CODEX_BASE_PROMPT);
});
