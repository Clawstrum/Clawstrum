import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Store } from '../store.js';
import { writePrivate } from '../files.js';
import { abortAfter } from '../async.js';
import type { DecisionsConfig } from './config.js';
import {
  OPENROUTER_URL,
  openRouterBody,
  openRouterDecision,
  openRouterUsage,
} from './openrouter.js';

const probability = z.number().finite().min(0).max(1);
export const questionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('choice'),
      instructions: z.string().min(1).max(4000),
      criteria: z.record(
        z.string().min(1).max(100),
        z.union([
          z.string().max(2000),
          z
            .object({
              skill: z.string().max(100).optional(),
              what: z.string().max(1000),
              not_for: z.string().max(1000).optional(),
              examples: z.array(z.string().max(300)).max(5).optional(),
            })
            .strict(),
        ]),
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal('score'),
      instructions: z.string().min(1).max(4000),
      criteria: z.array(z.string().min(1).max(2000)).min(2).max(10),
    })
    .strict(),
  z.object({ type: z.literal('noul'), instructions: z.string().min(1).max(4000) }).strict(),
]);
export type Question = z.infer<typeof questionSchema>;
export type Answer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number };
export interface DecisionResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number };
}
export interface DecisionInput {
  feature: string;
  version: string;
  scope: string;
  sessionId?: string | null;
  runId?: string;
  workerId?: string;
  state: unknown;
  questions: Record<string, Question>;
  sources?: Array<{ id: string; revision: string }>;
  background?: boolean;
  signal?: AbortSignal;
}
export type DecisionResult =
  | {
      status: 'decision';
      id: string;
      cached: boolean;
      artifact: string;
      response: DecisionResponse;
    }
  | { status: 'unavailable'; id?: string; reason: string };
interface Cache {
  expires: number;
  response: DecisionResponse;
  artifact: string;
}
export interface DecisionRecord {
  id: string;
  at: number;
  feature: string;
  version: string;
  scope: string;
  sessionId?: string | null;
  runId?: string;
  workerId?: string;
  stateHash: string;
  requestHash: string;
  requestedModel: string;
  resolvedModel?: string;
  status: string;
  reason?: string;
  cached: boolean;
  latencyMs: number;
  attempts: number;
  reportedInputTokens: number;
  reportedOutputTokens?: number;
  usageUnknownAttempts: number;
  estimatedUsd: number;
  artifact?: string;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
      .join(',') +
    '}'
  );
}
export const decisionHash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
function read<T>(store: Store, key: string): T | undefined {
  const row = store.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key);
  return row ? (JSON.parse(row.value) as T) : undefined;
}
function put(store: Store, key: string, value: unknown) {
  store.exec(
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key,
    JSON.stringify(value),
  );
}
/** The configured provider's model, key variable, foreground limit and prices; none is shared. */
export function decisionProvider(config: DecisionsConfig) {
  return config.provider === 'openrouter'
    ? { name: 'openrouter' as const, ...config.openrouter }
    : {
        name: 'jev' as const,
        model: config.model,
        apiKeyEnv: config.apiKeyEnv,
        foregroundTimeoutMs: config.foregroundTimeoutMs,
        inputUsdPerMillion: config.inputUsdPerMillion,
        outputUsdPerMillion: 0,
      };
}
export function decisionKey(config: DecisionsConfig, env: NodeJS.ProcessEnv = process.env) {
  // Only the configured provider's key counts: a Jev key never sends to OpenRouter or the reverse.
  if (config.provider === 'openrouter') return env[config.openrouter.apiKeyEnv] || undefined;
  return (
    env[config.apiKeyEnv] || (config.apiKeyEnv === 'JEV_API_KEY' ? env.TYPESAFE_API_KEY : undefined)
  );
}
export function decisionsAvailable(config: DecisionsConfig, env: NodeJS.ProcessEnv = process.env) {
  return config.enabled && !!decisionKey(config, env);
}
/** Codex's MCP environment allowlist does not automatically inherit auxiliary service keys. */
export function decisionEnvironment(
  config: DecisionsConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const key = config.enabled ? decisionKey(config, env) : undefined;
  return key ? { [decisionProvider(config).apiKeyEnv]: key } : {};
}
export function validateDecision(
  raw: unknown,
  model: string,
  questions: Record<string, Question>,
): DecisionResponse {
  const base = z
    .object({
      model: z.literal(model),
      answers: z.record(z.string(), z.unknown()),
      usage: z
        .object({
          input_tokens: z.number().int().nonnegative(),
          output_tokens: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .parse(raw);
  if (Object.keys(base.answers).sort().join('\0') !== Object.keys(questions).sort().join('\0'))
    throw new Error('answer_ids');
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'noul') {
      answers[id] = z
        .object({ type: z.literal('noul'), noul: probability })
        .parse(base.answers[id]);
      continue;
    }
    const common = z
      .object({
        type: z.literal(question.type),
        confidence: probability,
        probabilities: z.record(z.string(), probability),
        choice: z.string().optional(),
        score: z.number().finite().optional(),
      })
      .parse(base.answers[id]);
    const labels =
      question.type === 'choice'
        ? Object.keys(question.criteria)
        : question.criteria.map((_, i) => String(i));
    if (
      Object.keys(common.probabilities).sort().join('\0') !== labels.sort().join('\0') ||
      Math.abs(Object.values(common.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.05
    )
      throw new Error('probability_labels');
    if (question.type === 'choice') {
      if (!common.choice || !labels.includes(common.choice)) throw new Error('choice_label');
      answers[id] = {
        type: 'choice',
        choice: common.choice,
        confidence: common.confidence,
        probabilities: common.probabilities,
      };
    } else {
      if (common.score === undefined || common.score < 0 || common.score > labels.length - 1)
        throw new Error('score_range');
      answers[id] = {
        type: 'score',
        score: common.score,
        confidence: common.confidence,
        probabilities: common.probabilities,
      };
    }
  }
  return { model: base.model, answers, usage: base.usage };
}

/** One endpoint (Jev or OpenRouter) and one durable budget/cache across daemon and MCP processes. */
export class DecisionService {
  constructor(
    readonly store: Store,
    readonly config: DecisionsConfig,
    readonly transport: typeof fetch = fetch,
    readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async decide(input: DecisionInput): Promise<DecisionResult> {
    if (!this.config.enabled) return { status: 'unavailable', reason: 'disabled' };
    const key = decisionKey(this.config, this.environment);
    if (!key) return { status: 'unavailable', reason: 'missing_key' };
    // Invalid caller input is unavailable to the auxiliary feature, never a fatal main turn.
    try {
      return await this.execute(input, key);
    } catch {
      return { status: 'unavailable', reason: 'local_error' };
    }
  }

  private async execute(input: DecisionInput, apiKey: string): Promise<DecisionResult> {
    const at = Date.now(),
      id = randomUUID();
    const questions = z
      .record(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), questionSchema)
      .parse(input.questions);
    if (!Object.keys(questions).length || Object.keys(questions).length > 100)
      throw new Error('question_count');
    for (const question of Object.values(questions))
      if (
        question.type === 'choice' &&
        (Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 100)
      )
        throw new Error('choice_count');
    const provider = decisionProvider(this.config);
    const model = provider.model;
    // The size limit and cache key cover the same state and questions for either provider.
    const body = canonical({ model, state: input.state, questions });
    const payload =
      provider.name === 'openrouter'
        ? openRouterBody(model, canonical({ state: input.state, questions }), questions)
        : body;
    const requestHash = decisionHash({
      model,
      feature: input.feature,
      version: input.version,
      scope: input.scope,
      state: input.state,
      questions,
      sources: input.sources ?? [],
    });
    const cacheKey = `jev:cache:${requestHash}`,
      flightKey = `jev:flight:${requestHash}`;
    const deadline =
      at + (input.background ? this.config.backgroundTimeoutMs : provider.foregroundTimeoutMs);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), deadline - at);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
    const record: DecisionRecord = {
      id,
      at,
      feature: input.feature,
      version: input.version,
      scope: input.scope,
      sessionId: input.sessionId,
      runId: input.runId,
      workerId: input.workerId,
      stateHash: decisionHash(input.state),
      requestHash,
      requestedModel: model,
      status: 'unavailable',
      cached: false,
      latencyMs: 0,
      attempts: 0,
      reportedInputTokens: 0,
      reportedOutputTokens: 0,
      usageUnknownAttempts: 0,
      estimatedUsd: 0,
    };
    let owned = false;
    let savedInput = false;
    const artifact = path.join(this.store.home, 'research', 'decisions', `${id}.json`);
    const finish = (result: DecisionResult): DecisionResult => {
      record.latencyMs = Date.now() - at;
      record.status = result.status;
      if (result.status === 'decision') {
        record.cached = result.cached;
        record.resolvedModel = result.response.model;
        record.artifact = result.artifact;
      } else record.reason = result.reason;
      put(this.store, `jev:call:${String(at).padStart(16, '0')}:${id}`, record);
      if (savedInput)
        writePrivate(
          artifact,
          JSON.stringify(
            {
              request: {
                feature: input.feature,
                version: input.version,
                scope: input.scope,
                sources: input.sources ?? [],
                model,
                state: input.state,
                questions,
              },
              result,
              profile: record,
            },
            null,
            2,
          ),
        );
      return result;
    };
    try {
      if (Buffer.byteLength(body) > this.config.maxRequestBytes)
        return finish({ status: 'unavailable', id, reason: 'request_too_large' });
      // A contender may consume the leader's exact cached result. It never cancels that leader.
      for (;;) {
        signal.throwIfAborted();
        const found = this.store.transaction(() => {
          const cached = read<Cache>(this.store, cacheKey);
          if (cached && cached.expires > Date.now()) {
            try {
              validateDecision(cached.response, model, questions);
              return cached;
            } catch {
              this.store.exec('DELETE FROM metadata WHERE key=?', cacheKey);
            }
          } else if (cached) this.store.exec('DELETE FROM metadata WHERE key=?', cacheKey);
          const flight = read<{ owner: string; expires: number }>(this.store, flightKey);
          if (!flight || flight.expires <= Date.now()) {
            put(this.store, flightKey, { owner: id, expires: deadline + 1000 });
            owned = true;
          }
          return undefined;
        });
        if (found)
          return finish({
            status: 'decision',
            id,
            cached: true,
            artifact: found.artifact,
            response: validateDecision(found.response, model, questions),
          });
        if (owned) break;
        await delay(Math.min(40, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
      writePrivate(
        artifact,
        JSON.stringify({
          model,
          state: input.state,
          questions,
          sources: input.sources ?? [],
        }),
      );
      savedInput = true;
      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        signal.throwIfAborted();
        const now = Date.now(),
          day = new Date(now).toISOString().slice(0, 10);
        const budgetKey = `jev:budget:${day}`,
          leaseKey = `jev:lease:${id}`;
        // Reserve a conservative estimate before sending. Missing usage retains the reservation.
        // A byte bounds a token from above; a chat model answers in under 64 tokens per question.
        const reserve =
          ((Buffer.byteLength(payload) + 2048) * provider.inputUsdPerMillion +
            (64 + 64 * Object.keys(questions).length) * provider.outputUsdPerMillion) /
          1e6;
        const admission = this.store.transaction(() => {
          this.store.exec(
            "DELETE FROM metadata WHERE key GLOB 'jev:lease:*' AND json_extract(value,'$.expires')<=?",
            now,
          );
          const count = this.store.get<{ n: number }>(
            "SELECT COUNT(*) n FROM metadata WHERE key GLOB 'jev:lease:*'",
          )!.n;
          const spent = read<number>(this.store, budgetKey) ?? 0;
          if (count >= this.config.maxConcurrent) return 'capacity';
          if (spent + reserve > this.config.dailyBudgetUsd) return 'budget';
          put(this.store, budgetKey, spent + reserve);
          put(this.store, leaseKey, { expires: deadline + 1000 });
          return null;
        });
        if (admission) return finish({ status: 'unavailable', id, reason: admission });
        record.attempts++;
        record.estimatedUsd += reserve;
        record.usageUnknownAttempts++;
        let response: Response;
        try {
          response = await abortAfter(
            this.transport(
              provider.name === 'openrouter'
                ? OPENROUTER_URL
                : 'https://api.typesafe.ai/v1/systemone',
              {
                method: 'POST',
                redirect: 'error',
                signal,
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                  'User-Agent': 'Clawstrum/0.1',
                },
                body: payload,
              },
            ),
            signal,
          );
          if (!response.ok) {
            // Do not log remote error bodies or request headers, which can echo credentials.
            const retryable = [429, 529, 500, 502, 503, 504].includes(response.status);
            const retryAfter = response.headers.get('retry-after');
            await response.body?.cancel();
            if (!retryable || attempt === this.config.maxRetries)
              return finish({ status: 'unavailable', id, reason: `http_${response.status}` });
            const seconds = Number(retryAfter);
            const wait = retryAfter
              ? Number.isFinite(seconds)
                ? seconds * 1000
                : Date.parse(retryAfter) - Date.now()
              : 200 * 2 ** attempt + Math.random() * 100;
            if (!Number.isFinite(wait) || Date.now() + Math.max(0, wait) >= deadline)
              return finish({
                status: 'unavailable',
                id,
                reason: `http_${response.status}_deadline`,
              });
            this.store.exec('DELETE FROM metadata WHERE key=?', leaseKey);
            await delay(Math.max(0, wait), undefined, { signal });
            continue;
          }
          const raw = await abortAfter(response.json(), signal);
          const usage = z
            .object({
              input_tokens: z.number().int().nonnegative(),
              output_tokens: z.number().int().nonnegative(),
            })
            .safeParse(provider.name === 'openrouter' ? openRouterUsage(raw) : raw?.usage);
          if (usage.success) {
            const actual =
              (usage.data.input_tokens * provider.inputUsdPerMillion +
                usage.data.output_tokens * provider.outputUsdPerMillion) /
              1e6;
            this.store.transaction(() =>
              put(
                this.store,
                budgetKey,
                Math.max(0, (read<number>(this.store, budgetKey) ?? reserve) - reserve + actual),
              ),
            );
            record.estimatedUsd += actual - reserve;
            record.reportedInputTokens += usage.data.input_tokens;
            record.reportedOutputTokens! += usage.data.output_tokens;
            record.usageUnknownAttempts--;
          }
          let decoded: DecisionResponse;
          try {
            decoded = validateDecision(
              provider.name === 'openrouter' ? openRouterDecision(raw, model, questions) : raw,
              model,
              questions,
            );
          } catch {
            return finish({ status: 'unavailable', id, reason: 'invalid_response' });
          }
          put(this.store, cacheKey, {
            response: decoded,
            artifact,
            expires: Date.now() + this.config.cacheTtlMs,
          });
          return finish({ status: 'decision', id, cached: false, artifact, response: decoded });
        } finally {
          this.store.exec('DELETE FROM metadata WHERE key=?', leaseKey);
        }
      }
      return finish({ status: 'unavailable', id, reason: 'retry_exhausted' });
    } catch {
      return finish({
        status: 'unavailable',
        id,
        reason: input.signal?.aborted
          ? 'cancelled'
          : signal.aborted
            ? 'timeout'
            : 'transport_error',
      });
    } finally {
      clearTimeout(timer);
      if (owned)
        this.store.transaction(() => {
          if (read<{ owner: string }>(this.store, flightKey)?.owner === id)
            this.store.exec('DELETE FROM metadata WHERE key=?', flightKey);
        });
    }
  }
}
