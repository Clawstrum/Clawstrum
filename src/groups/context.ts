import fs from 'node:fs';
import path from 'node:path';
import { groupId } from './config.js';

export interface GroupContext {
  id: string;
  file: string;
  memory: string;
  revision: number;
}
/** The owner publishes the index last. Immutable memory snapshots prevent mixed-generation reads. */
export function readGroupsContext(home: string, workspace: string): GroupContext[] {
  let registry: any;
  try {
    registry = JSON.parse(fs.readFileSync(path.join(home, 'groups', 'index.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (registry.version !== 1) throw new Error('Unsupported group context registry');
  if (!registry.enabled) return [];
  const seen = new Map<string, string>();
  return (registry.channels[workspace] ?? []).map((id: string) => {
    groupId.parse(id);
    const group = registry.groups[id];
    if (!group) throw new Error('Group registry references a missing group');
    const directory = path.join(home, 'groups', id);
    if (
      path.resolve(group.file) !== path.resolve(directory, 'AGENTS.md') ||
      !path.resolve(group.snapshot).startsWith(path.resolve(directory, 'snapshots') + path.sep)
    )
      throw new Error('Group registry has an invalid path');
    const snapshot = JSON.parse(fs.readFileSync(group.snapshot, 'utf8'));
    if (snapshot.revision !== group.revision || snapshot.id !== id)
      throw new Error('Group context revision mismatch');
    const memory = String(snapshot.memory).replace(
      /<!-- clawstrum:entry:([a-f0-9-]+):(\d+):start -->[\s\S]*?<!-- clawstrum:entry:\1:end -->/g,
      (block: string, entry: string, revision: string) => {
        const key = entry + ':' + revision,
          first = seen.get(key);
        if (first)
          return `Entry ${entry} revision ${revision} is also shared here; its current content appears in group ${first}.`;
        seen.set(key, id);
        return block;
      },
    );
    return { id, file: group.file, memory, revision: group.revision };
  });
}
