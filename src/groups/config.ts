import { z } from 'zod';

export const groupsSchema = z
  .object({
    enabled: z.boolean().default(true),
    reviewer: z
      .object({
        enabled: z.boolean().default(true),
        models: z
          .object({
            claude: z.string().min(1).optional(),
            codex: z.string().min(1).optional(),
            gemini: z.string().min(1).optional(),
          })
          .strict()
          .prefault({ claude: 'haiku' }),
        effort: z.enum(['low', 'medium']).default('low'),
        debounceMs: z.number().int().min(0).max(60000).default(10000),
        debounceMaxMs: z.number().int().min(0).max(300000).default(30000),
        timeoutMs: z.number().int().min(1000).max(3600000).default(180000),
        chunkChars: z.number().int().min(2000).max(200000).default(40000),
        maxCallsPerPass: z.number().int().min(1).max(100).default(8),
        retryMs: z.number().int().min(1000).max(3600000).default(60000),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});
export type GroupsConfig = z.infer<typeof groupsSchema>;

export const groupId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const entrySpec = z
  .object({
    kind: z.enum(['finding', 'decision', 'progress', 'question', 'artifact']),
    subject: z.string().min(1).max(500),
    summary: z.string().min(1).max(50000),
    scope: z
      .object({
        project: z.string().min(1).max(200).optional(),
        experiment: z.string().min(1).max(200).optional(),
        run: z.string().min(1).max(200).optional(),
        dataset: z.string().min(1).max(200).optional(),
        version: z.string().min(1).max(200).optional(),
      })
      .strict()
      .refine((s) => Object.keys(s).length > 0, 'Declare at least one scope field')
      .optional(),
    evidence: z.array(z.string().min(1).max(4000)).max(100).default([]),
    dependsOn: z.array(z.string().min(1)).max(100).default([]),
    supersedes: z.array(z.string().min(1)).max(100).default([]),
    observedAt: z.number().int().nonnegative().optional(),
    expiresAt: z.number().int().nonnegative().nullable().optional(),
    reviewAfter: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type EntrySpec = z.infer<typeof entrySpec>;
export const boardInput = z
  .object({
    action: z.enum(['list', 'read', 'publish', 'revise', 'retract', 'resolve']),
    groups: z.array(groupId).min(1).max(32).optional(),
    id: z.string().optional(),
    key: z.string().min(1).max(500).optional(),
    revision: z.number().int().positive().optional(),
    entry: entrySpec.optional(),
    reason: z.string().min(1).max(10000).optional(),
    evidence: z.array(z.string().min(1)).max(100).optional(),
    after: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
export type BoardInput = z.infer<typeof boardInput>;
