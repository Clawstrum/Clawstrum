import fs from 'node:fs';
import { parseMemory } from './memory.js';

/** Installation seed only. Existing AGENTS.md files are authoritative, including deletions. */
export const DEFAULT_AGENTS = parseMemory(
  fs.readFileSync(new URL('../templates/AGENTS.md', import.meta.url), 'utf8'),
).instructions;

/** Legacy integration name; the policy text has one source in the shipped template. */
export const DEFAULT_SELF = DEFAULT_AGENTS;
