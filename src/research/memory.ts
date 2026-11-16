import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What one running subagent costs in memory: a claude process of about 275 MB plus the two MCP
 * node processes it starts, about 130 MB and 95 MB (measured on one Linux host).
 */
export const SUBAGENT_MEMORY_MB = 500;

export interface MemoryReading {
  availableMB: number;
  /** The limit that gave the smallest figure: a cgroup directory or the host. */
  source: string;
}

const MB = 1024 * 1024;

function statField(stat: string, name: string): number {
  const match = new RegExp(`^${name} (\\d+)$`, 'm').exec(stat);
  return match ? Number(match[1]) : 0;
}

/**
 * Memory a new subagent can use, in MB: the smallest of the host's available memory and, for each
 * cgroup v2 directory from this process's cgroup up to the root that has a numeric memory.max,
 * memory.max minus the part of memory.current that cannot be reclaimed.
 *
 * memory.current counts page cache and kernel slab, which the kernel frees under pressure, so
 * inactive_file and slab_reclaimable from memory.stat are subtracted from it. In the user's
 * systemd slice reclaimable slab can be most of memory.current; subtracting inactive_file alone
 * can report under 1 GB available, holding every subagent below its floor, while the cgroup
 * still has several GB it could reclaim.
 */
export function availableMemory(
  options: { root?: string; cgroupFile?: string; hostFree?: () => number } = {},
): MemoryReading {
  const root = options.root ?? '/sys/fs/cgroup';
  let best: MemoryReading = {
    availableMB: Math.floor((options.hostFree ?? os.freemem)() / MB),
    source: 'host',
  };
  let relative: string | undefined;
  try {
    relative = fs
      .readFileSync(options.cgroupFile ?? '/proc/self/cgroup', 'utf8')
      .split('\n')
      .find((line) => line.startsWith('0::'))
      ?.slice(3);
  } catch {
    return best;
  }
  if (!relative) return best;
  let dir = path.join(root, relative);
  for (;;) {
    try {
      const max = fs.readFileSync(path.join(dir, 'memory.max'), 'utf8').trim();
      if (/^\d+$/.test(max)) {
        const current = Number(fs.readFileSync(path.join(dir, 'memory.current'), 'utf8').trim());
        const stat = fs.readFileSync(path.join(dir, 'memory.stat'), 'utf8');
        const used = Math.max(
          0,
          current - statField(stat, 'inactive_file') - statField(stat, 'slab_reclaimable'),
        );
        const availableMB = Math.floor(Math.max(0, Number(max) - used) / MB);
        if (availableMB < best.availableMB)
          best = { availableMB, source: path.relative(root, dir) || '/' };
      }
    } catch {
      // A level without memory accounting, or one this user cannot read, sets no limit here.
    }
    if (dir === root || path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  return best;
}
