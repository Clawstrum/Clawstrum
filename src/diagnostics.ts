import fs from 'node:fs';

/** Linux process attribution without recording command-line arguments or environment secrets. */
export function processTree(
  root?: number,
): Array<{ pid: number; status?: string; waitChannel?: string }> {
  if (!root) return [];
  if (process.platform !== 'linux') return [{ pid: root }];
  const result: Array<{ pid: number; status?: string; waitChannel?: string }> = [];
  const pending = [root];
  const seen = new Set<number>();
  while (pending.length && result.length < 256) {
    const pid = pending.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    try {
      const status = fs
        .readFileSync(`/proc/${pid}/status`, 'utf8')
        .split('\n')
        .filter((line) => /^(Name|State|PPid|VmRSS):/.test(line))
        .join('\n');
      const waitChannel = fs.readFileSync(`/proc/${pid}/wchan`, 'utf8').trim();
      result.push({ pid, status, waitChannel });
      const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
      if (children) pending.push(...children.split(/\s+/).map(Number).filter(Number.isSafeInteger));
    } catch {
      /* A process can exit while its snapshot is being read. */
    }
  }
  return result;
}
