import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const fileSource = z
  .object({
    file: z.string().min(1).max(4000),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const evidenceSource = z.union([
  fileSource,
  z.object({ historyId: z.string().min(1).max(2000) }).strict(),
]);
export const claimSchema = z
  .object({
    subject: z.string().min(1).max(300),
    scope: z
      .object({
        project: z.string().min(1).max(300),
        run: z.string().min(1).max(300).optional(),
        version: z.string().min(1).max(300).optional(),
        surface: z.enum(['design', 'execution', 'deployment']),
      })
      .strict(),
    basis: z.enum(['user_decision', 'observation', 'inference']),
    sources: z.array(evidenceSource).min(1).max(20),
  })
  .strict();
export type Claim = z.infer<typeof claimSchema>;
export type Observation = {
  source: z.infer<typeof evidenceSource>;
  sha256?: string;
  bytes?: number;
  kind?: string;
  supersededBy?: string;
  error?: string;
};

/** Hash complete regular files without blocking the event loop or buffering their contents.
 * Metadata is only a race check, never a substitute for hashing. Non-regular files cannot hang. */
export async function fingerprint(
  file: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const resolved = await fs.promises.realpath(file);
  const handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('Evidence must be a regular file');
    if (before.size > BigInt(maxBytes))
      throw new Error(
        'Evidence exceeds the observation budget; track a manifest for large artifacts',
      );
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maxBytes) throw new Error('Evidence grew beyond the observation budget');
      hash.update(buffer.subarray(0, bytesRead));
    }
    signal?.throwIfAborted();
    const after = await handle.stat({ bigint: true });
    const atPath = await fs.promises.stat(file, { bigint: true });
    if (
      [after, atPath].some(
        (s) =>
          s.dev !== before.dev ||
          s.ino !== before.ino ||
          s.size !== before.size ||
          s.mtimeNs !== before.mtimeNs ||
          s.ctimeNs !== before.ctimeNs,
      ) ||
      BigInt(bytes) !== before.size
    )
      throw new Error('Evidence changed while being read; retry the observation');
    return { file: path.resolve(file), sha256: hash.digest('hex'), bytes };
  } finally {
    await handle.close();
  }
}
