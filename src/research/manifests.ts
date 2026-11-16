import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Store } from '../store.js';
import { archiveRecord, historyHash } from '../history.js';
import { fingerprint } from './evidence.js';

const identity = z
  .object({
    project: z.string().min(1).max(300),
    run: z.string().min(1).max(300),
    version: z.string().min(1).max(300),
    method: z.string().min(1).max(4000),
    surface: z.enum(['execution', 'deployment']),
    sourceRevision: z.string().max(300).optional(),
  })
  .strict();
const artifact = z
  .object({
    id: z.string().min(1).max(300),
    role: z.enum(['source', 'input', 'output', 'view']),
    file: z.string().min(1).max(4000),
  })
  .strict();
const specification = z
  .object({
    identity,
    parameters: z.record(z.string(), z.json()).default({}),
    files: z.array(artifact).min(1).max(200),
  })
  .strict();
const manifestSchema = specification.extend({
  schema: z.literal(1),
  observedAt: z.number(),
  files: z
    .array(
      artifact.extend({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().nonnegative(),
      }),
    )
    .min(1)
    .max(200),
});
export const manifestToolSchema = z
  .object({
    action: z.enum(['record', 'verify']),
    key: z.string().min(1).max(500).optional(),
    identity: identity.optional(),
    parameters: specification.shape.parameters.optional(),
    files: specification.shape.files.optional(),
    manifest: z.string().min(1).max(4000).optional(),
    locations: z
      .array(z.object({ id: z.string(), file: z.string().min(1) }).strict())
      .max(200)
      .optional(),
  })
  .strict();
export const manifestInput = z.discriminatedUnion('action', [
  specification.extend({ action: z.literal('record'), key: z.string().min(1).max(500) }),
  z
    .object({
      action: z.literal('verify'),
      manifest: z.string().min(1).max(4000),
      locations: z
        .array(z.object({ id: z.string(), file: z.string().min(1) }).strict())
        .max(200)
        .default([]),
    })
    .strict(),
]);
export async function researchManifest(store: Store, session: string, scope: string, raw: unknown) {
  const input = manifestInput.parse(raw);
  const root = store.session(session).workspace;
  if (input.action === 'verify') {
    const manifestFile = path.resolve(root, input.manifest);
    // Manifests are small metadata, not arbitrary bulk files.
    const stamp = await fingerprint(manifestFile, 2 * 1024 * 1024);
    const text = await fs.promises.readFile(manifestFile, 'utf8');
    if (historyHash(text) !== stamp.sha256) throw new Error('Manifest changed while being read');
    const manifest = manifestSchema.parse(JSON.parse(text));
    const overrides = new Map(input.locations.map((row) => [row.id, row.file]));
    if (
      overrides.size !== input.locations.length ||
      [...overrides.keys()].some((id) => !manifest.files.some((f) => f.id === id))
    )
      throw new Error('Artifact locations must name distinct IDs in this manifest');
    const files = [];
    for (const expected of manifest.files) {
      const file = path.resolve(root, overrides.get(expected.id) ?? expected.file);
      try {
        const actual = await fingerprint(file);
        files.push({
          id: expected.id,
          file,
          expected: expected.sha256,
          actual: actual.sha256,
          status: actual.sha256 === expected.sha256 ? 'match' : 'changed',
        });
      } catch (error) {
        files.push({
          id: expected.id,
          file,
          expected: expected.sha256,
          status: 'unavailable',
          error: String(error),
        });
      }
    }
    const result = {
      manifest: manifestFile,
      manifestSha256: stamp.sha256,
      identity: manifest.identity,
      checkedAt: Date.now(),
      matches: files.every((f) => f.status === 'match'),
      files,
    };
    const event = archiveRecord(store, {
      id: `manifest-check:${session}:${historyHash(JSON.stringify(result))}`,
      sessionId: session,
      kind: 'research_manifest_check',
      content: result,
    });
    return {
      ...result,
      historyId: event.id,
      meaning:
        'Matches compare bytes only; method/version labels are supplied by the recording agent, not independently proven.',
    };
  }
  const spec = specification.parse({
    identity: input.identity,
    parameters: input.parameters,
    files: input.files.map((f) => ({ ...f, file: path.resolve(root, f.file) })),
  });
  if (new Set(spec.files.map((f) => f.id)).size !== spec.files.length)
    throw new Error('Artifact IDs must be distinct');
  const key = `manifest:${session}:${scope}:${input.key}`;
  const existing = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key);
  if (existing) {
    const previous = JSON.parse(existing.value);
    if (JSON.stringify(previous.spec) !== JSON.stringify(spec))
      throw new Error('Manifest key already names a different specification; use a new key');
    return { ...previous.result, reused: true };
  }
  const files = [];
  for (const f of spec.files) files.push({ ...f, ...(await fingerprint(f.file)) });
  const manifest = { ...spec, schema: 1 as const, observedAt: Date.now(), files };
  const text = JSON.stringify(manifest, null, 2) + '\n';
  const sha256 = historyHash(text);
  const directory = path.join(root, 'artifacts', 'manifests');
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, sha256 + '.json');
  await fs.promises.writeFile(file, text, { flag: 'wx', mode: 0o600 });
  const historyId = `manifest:${session}:${sha256}`;
  const result = { file, sha256, historyId, identity: spec.identity, files: files.length };
  return store.transaction(() => {
    // Another process may have finished the same idempotent request while files were hashing.
    const won = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key);
    if (won) {
      const previous = JSON.parse(won.value);
      if (JSON.stringify(previous.spec) !== JSON.stringify(spec))
        throw new Error('Manifest key raced with a different specification');
      return { ...previous.result, reused: true };
    }
    archiveRecord(store, {
      id: historyId,
      sessionId: session,
      kind: 'research_manifest',
      source: file,
      content: manifest,
    });
    store.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?)',
      key,
      JSON.stringify({ spec, result }),
    );
    return result;
  });
}
