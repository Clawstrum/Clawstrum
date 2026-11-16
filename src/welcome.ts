import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { Store } from './store.js';

function welcome(name: string): string {
  return `This is Clawstrum's first start after setup, and the owner has not written yet. Write the first message in this channel yourself. It is step 1 of the \`onboarding\` skill, so read that skill first. Keep it short, in this order:\n- who you are, in one line: your name is ${name};\n- that this is the main channel, also called the therapy channel: here the owner talks with you about yourself, how you work, what should change, and which projects to start;\n- three or four short ideas for making you theirs, for example: tell you their field and how they like answers; name their projects, and you make a Discord channel for each; point you to their papers, notes and data, and to skills or tools they already use; tell you where their work runs, such as a cluster with its accounts and software; tell you here whenever something about how you work should change;\n- one question to start: the first question of step 2 of the onboarding skill.\nChange no files and start no other work in this turn. Do not answer with CLAWSTRUM_QUIET: this message must reach the owner.`;
}

/** Queue the agent's first message in the main channel once, on a new installation only. */
export function ensureWelcome(store: Store, config: Config, now = Date.now()): boolean {
  return store.transaction(() => {
    const channelId = config.discord.channelIds[0];
    if (!channelId) return false;
    const key = `welcome:${channelId}`;
    if (store.get('SELECT 1 FROM metadata WHERE key=?', key)) return false;
    const file = path.join(store.home, 'AGENTS.md');
    if (!fs.existsSync(file) || !/^## First conversation\b/m.test(fs.readFileSync(file, 'utf8')))
      return false;
    const session = store.ensureSession(channelId);
    if (store.get('SELECT 1 FROM inbound WHERE session_id=? LIMIT 1', session.id)) {
      store.exec('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)', key, String(now));
      return false;
    }
    const queued = store.enqueue({
      id: key,
      sessionId: session.id,
      author: 'Clawstrum',
      kind: 'task',
      content: welcome(config.name),
      at: now,
    });
    store.exec('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)', key, String(now));
    return queued;
  });
}
