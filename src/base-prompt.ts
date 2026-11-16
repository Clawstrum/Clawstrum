import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateHome } from './config.js';
import type { ProviderRequest } from './types.js';

const root = fileURLToPath(new URL('..', import.meta.url));

const template = (name: string) =>
  fs.readFileSync(new URL(`../templates/${name}`, import.meta.url), 'utf8').trim();

export const BASE_PROMPT = template('base-prompt.md');

const CODEX_TEMPLATE = template('base-prompt-codex.md');

export const CODEX_BASE_PROMPT = `${BASE_PROMPT}\n\n${CODEX_TEMPLATE}`;

const MAIN_TEMPLATE = template('base-prompt-main.md');

const RULES_START = BASE_PROMPT.search(/^# How you work$/m);
if (RULES_START < 0) throw new Error('templates/base-prompt.md has no "# How you work" section');
const RULES = BASE_PROMPT.slice(RULES_START).trim();

const readTrimmed = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

const stripFrontmatter = (text: string) =>
  text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').trim();

/** Base prompt for lead runs in the main channel, read fresh on every call so doc edits apply next turn. */
export function mainBasePrompt(home = stateHome(), packageRoot = root): string {
  const source = fs.existsSync(path.join(packageRoot, 'src'))
    ? 'It is a source checkout: the code is in `src/` and its tests in `test/`, and `dist/` is the build that runs. Edit `src/`, never `dist/`.'
    : 'It is an installed package with only the build (`dist/`), so a code change needs a source checkout.';
  const customize = stripFrontmatter(
    readTrimmed(path.join(home, 'skills', 'customize', 'SKILL.md')) ||
      readTrimmed(path.join(packageRoot, 'templates', 'skills', 'customize', 'SKILL.md')),
  );
  const values: Record<string, string> = {
    rules: RULES,
    root: packageRoot.replace(/\/+$/, ''),
    source,
    guides: readTrimmed(path.join(packageRoot, 'docs', 'index.md')),
    architecture: readTrimmed(path.join(packageRoot, 'docs', 'architecture.md')),
    customize,
  };
  let text = MAIN_TEMPLATE;
  if (!customize)
    text = text.replace(/^# Changing Clawstrum: the customize skill[ \t]*$/m, () => '');
  text = text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function basePrompt(r: Pick<ProviderRequest, 'mainChannel'>): string {
  return r.mainChannel ? mainBasePrompt() : BASE_PROMPT;
}

export function codexBasePrompt(r: Pick<ProviderRequest, 'mainChannel'>): string {
  return `${basePrompt(r)}\n\n${CODEX_TEMPLATE}`;
}

/** Subagent and tool-less maintenance runs keep each vendor's default prompt. */
export const usesBasePrompt = (r: Pick<ProviderRequest, 'subagent' | 'toolless'>) =>
  !r.subagent && !r.toolless;
