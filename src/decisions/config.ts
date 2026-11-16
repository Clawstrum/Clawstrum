import { z } from 'zod';

export const decisionsSchema = z
  .object({
    enabled: z.boolean().default(true),
    model: z
      .string()
      .regex(/^jev-\d+\.\d+\.\d+$/)
      .default('jev-1.13.0'),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .default('JEV_API_KEY'),
    foregroundTimeoutMs: z.number().int().min(50).max(10000).default(1000),
    backgroundTimeoutMs: z.number().int().min(100).max(60000).default(10000),
    maxConcurrent: z.number().int().min(1).max(32).default(4),
    maxRetries: z.number().int().min(0).max(3).default(1),
    // Bytes are a conservative request bound, not a claim to know Jev's tokenization.
    maxRequestBytes: z.number().int().min(2000).max(28000).default(24000),
    dailyBudgetUsd: z.number().finite().min(0).default(1),
    inputUsdPerMillion: z.number().finite().min(0).default(0.042),
    cacheTtlMs: z
      .number()
      .int()
      .min(0)
      .max(7 * 86400000)
      .default(86400000),
    history: z.boolean().default(true),
    skills: z.boolean().default(true),
    workers: z.boolean().default(true),
    // Compatibility setting: observational per-chunk calls were removed; they changed no decision.
    memoryReview: z.boolean().default(false),
  })
  .strict()
  .prefault({});
export type DecisionsConfig = z.output<typeof decisionsSchema>;
