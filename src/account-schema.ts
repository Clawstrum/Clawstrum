import { z } from 'zod';
import type { ProviderName } from './types.js';

export const accountId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

/** The fields of one account, shared by config.json `accounts` and runtime/accounts.json. */
export const accountShape = {
  id: accountId,
  /** Plain-text description for people (who owns the subscription, what it is for). Never a secret. */
  owner: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(200).optional(),
  notes: z.string().min(1).max(2000).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  provider: z.enum(['claude', 'codex', 'gemini']),
  home: z.string().min(1),
  model: z.string().min(1).optional(),
  quotaBuckets: z.array(z.string().min(1)).default([]),
  modelFallbacks: z
    .array(
      z
        .object({
          model: z.string().min(1),
          quotaBuckets: z.array(z.string().min(1)).default([]),
        })
        .strict(),
    )
    .default([]),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  tokenEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
  executable: z.string().min(1).optional(),
  maxConcurrent: z.number().int().min(1).max(64).default(4),
};
export const accountSchema = z.object(accountShape).strict();

/** An account as stored in the private registry: the same fields plus an optional Claude OAuth token. */
export const registryAccountSchema = z
  .object({
    ...accountShape,
    token: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !/\s/.test(value), 'A token is one line without spaces')
      .optional(),
  })
  .strict();
export type RegistryAccount = z.infer<typeof registryAccountSchema>;

interface Issues {
  addIssue(issue: { code: 'custom'; message: string; path: (string | number)[] }): void;
}
interface Checked {
  id: string;
  provider: ProviderName;
  home: string;
  model?: string | undefined;
  quotaBuckets: string[];
  modelFallbacks: Array<{ model: string; quotaBuckets: string[] }>;
  effort?: string | undefined;
  tokenEnv?: string | undefined;
  token?: string | undefined;
}

/** Cross-account rules, identical for config.json and the registry. */
export function validateAccounts(
  accounts: Checked[],
  ctx: Issues,
  base: (string | number)[],
): void {
  if (new Set(accounts.map((a) => a.id)).size !== accounts.length)
    ctx.addIssue({ code: 'custom', message: 'Account ids must be unique', path: base });
  // Relative paths are resolved against the state directory by normalizeConfig.
  const homes = accounts.map((a) => `${a.provider}:${a.home}`);
  if (new Set(homes).size !== homes.length)
    ctx.addIssue({
      code: 'custom',
      message: 'Each account needs a distinct provider home',
      path: base,
    });
  for (const [i, a] of accounts.entries()) {
    const models = [a.model, ...a.modelFallbacks.map((m) => m.model)];
    if ((a.modelFallbacks.length && !a.model) || new Set(models).size !== models.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Model fallbacks require an explicit primary model and distinct model names',
        path: [...base, i, 'modelFallbacks'],
      });
    if (
      [...a.quotaBuckets, ...a.modelFallbacks.flatMap((m) => m.quotaBuckets)].some((b) =>
        ['five_hour', 'seven_day', '5h', '7d', 'unknown'].includes(b),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Shared or unknown quota buckets cannot be scoped to a model',
        path: [...base, i, 'quotaBuckets'],
      });
    if (a.provider === 'claude' && a.effort === 'ultra')
      ctx.addIssue({
        code: 'custom',
        message: 'Claude SDK does not support ultra effort',
        path: [...base, i, 'effort'],
      });
    if (a.provider === 'codex' && a.tokenEnv)
      ctx.addIssue({
        code: 'custom',
        message: 'Use Codex login with a dedicated home',
        path: [...base, i, 'tokenEnv'],
      });
    if (a.provider === 'gemini' && a.tokenEnv)
      ctx.addIssue({
        code: 'custom',
        message: 'Gemini accounts use the Google sign-in only; an API key is never used',
        path: [...base, i, 'tokenEnv'],
      });
    if (a.provider === 'gemini' && a.token)
      ctx.addIssue({
        code: 'custom',
        message:
          'A stored token is supported only for Claude OAuth tokens; use the Gemini (Google sign-in) login with a dedicated home',
        path: [...base, i, 'token'],
      });
    if (a.provider === 'codex' && a.token)
      ctx.addIssue({
        code: 'custom',
        message:
          'A token is supported only for Claude OAuth tokens; use Codex login with a dedicated home',
        path: [...base, i, 'token'],
      });
    if (a.token && a.tokenEnv)
      ctx.addIssue({
        code: 'custom',
        message: 'Set either token or tokenEnv, not both',
        path: [...base, i, 'token'],
      });
  }
}
