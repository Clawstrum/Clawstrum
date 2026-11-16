import { usageProfile } from '../usage-profile.js';
import { maintenanceBudget } from '../maintenance-budget.js';
import { refreshClaimEvidence, noteClaim } from './claims.js';
import { researchManifest, manifestToolSchema } from './manifests.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writePrivate } from '../files.js';
import { bounded, hostTimeZone } from '../context.js';
import { readableTimes, inputTime, timeInput } from '../tool-times.js';
import { usageReport } from '../usage.js';
import {
  workerUpdateSchema,
  workerReviewSchema,
  updateWorker,
  reviewWorker,
  workerProfile,
  workerReport,
} from './worker-profile.js';
import { z } from 'zod';
import type { RegisterFn } from '../mcp.js';
import type { Store } from '../store.js';
import type { Config } from '../config.js';
import { ResearchHttp } from './http.js';
import { retrievePaper, verifyCitation, checkCitation, citationRecord } from './literature.js';
import { readCitationDocument, scanCitations } from './citations.js';
import { saveNote, noteSchema, noteRevisions } from './records.js';
import { delegate, delegationSchema } from './workers.js';
import { steerWorker, workerSteers, closeWorkerSteers } from './steering.js';
import { preflight, submitJob, watchJob, batchSchema, watchSchema } from './cluster.js';
import { DecisionService, decisionKey } from '../decisions/client.js';
import { searchLiterature, searchInputSchema } from './search.js';
import { workerAdvice } from '../decisions/advice.js';
import { decisionProfile } from '../decisions/profile.js';
import { noteFilterSql } from './notes-index.js';

export interface ResearchContext {
  store: Store;
  config: Config;
  sessionId: string;
  scope: string;
  runId?: string;
  worker?: boolean;
  workerId?: string;
  signal?: AbortSignal;
}
const advisorySchema = z
  .object({
    brief: z.string().min(1).max(12000),
    context: z.string().max(6000).optional(),
    constraints: z.array(z.string().max(2000)).max(20).default([]),
  })
  .strict();
const schemas = {
  research_paper: z.object({ id: z.string().min(1), refresh: z.boolean().default(false) }).strict(),
  research_search: searchInputSchema,
  research_citation: z
    .object({
      action: z.enum(['verify', 'check', 'get', 'scan']),
      id: z.string().min(1).optional(),
      text: z.string().optional(),
      path: z.string().optional(),
      title: z.string().optional(),
      authors: z.array(z.string()).optional(),
      year: z.number().int().optional(),
      quote: z.string().optional(),
      textPath: z.string().optional(),
    })
    .strict(),
  research_manifest: manifestToolSchema,
  research_note: noteSchema.extend({ key: z.string().min(1) }),
  // research_worker_* are kept as working aliases of research_subagent_* for saved sessions and
  // old prompts; research_subagent_* are the names advertised going forward.
  research_worker_update: workerUpdateSchema,
  research_subagent_update: workerUpdateSchema,
  research_worker_review: workerReviewSchema,
  research_subagent_review: workerReviewSchema,
  research_delegate: delegationSchema.extend({ key: z.string().min(1) }),
  research_worker_advice: advisorySchema,
  research_subagent_advice: advisorySchema,
  research_steer: z
    .object({ id: z.uuid(), key: z.string().min(1).max(200), message: z.string().min(1).max(8000) })
    .strict(),
  research_cluster: z
    .object({
      action: z.enum(['preflight', 'submit', 'watch', 'adopt', 'stop-watch']),
      key: z.string().optional(),
      batch: batchSchema.optional(),
      jobId: z.string().optional(),
      watch: watchSchema.optional(),
      cluster: z.string().optional(),
      id: z.string().optional(),
    })
    .strict(),
  research_status: z
    .object({
      collection: z.enum([
        'notes',
        'workers',
        'subagents',
        'jobs',
        'citations',
        'usage',
        'usage-profile',
        'worker-profile',
        'subagent-profile',
        'decisions',
        'maintenance',
      ]),
      id: z.string().optional(),
      /** collection=notes only: every word must appear in the note's title or body. */
      query: z.string().max(500).optional(),
      /** collection=notes only: leave out notes that a later note or a review has replaced. */
      current: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().nonnegative().default(0),
      cancelWorker: z.boolean().default(false),
      refresh: z.boolean().default(false),
      since: timeInput.optional(),
      until: timeInput.optional(),
    })
    .strict(),
};
export type ResearchTool = keyof typeof schemas;
/**
 * research_worker_* are the pre-rename tool names. Calls under either name are normalized to the
 * canonical research_worker_* key here before dispatch, so adding a new alias means adding one
 * entry, not touching every switch case.
 */
const TOOL_ALIASES: Partial<Record<ResearchTool, ResearchTool>> = {
  research_subagent_update: 'research_worker_update',
  research_subagent_review: 'research_worker_review',
  research_subagent_advice: 'research_worker_advice',
};
const COLLECTION_ALIASES: Record<string, string> = {
  subagents: 'workers',
  'subagent-profile': 'worker-profile',
};
const descriptions: Record<ResearchTool, string> = {
  research_subagent_advice:
    'Recommend a bounded subagent role and its configured Claude/Codex/Gemini models and skills. Advice only: does not spawn or constrain work. Explicit user model requests remain authoritative; research_delegate accepts provider/model overrides. Unavailable or uncertain advice falls back to your judgment.',
  research_worker_advice: 'Deprecated alias of research_subagent_advice; identical behavior.',
  research_paper:
    'Retrieve open-access full text by DOI, arXiv ID, PMID, PMCID, OpenReview/OSF ID or URL; not by title. Returns local text/document paths, hashes, source/version and failed attempts, never a landing page labeled as full text. Read returned files in bounded chunks.',
  research_citation:
    'Verify identifier metadata against Crossref/DataCite/arXiv and save the source response; check a structured claim or scan document text/path for local author/year/BibTeX discrepancies. Scan uses cached records, up to 2 MB, and reports ambiguous associations. Metadata verification does not establish the scientific claim. Quote checks match supplied text only.',
  research_search:
    'Search the literature for a question: OpenAlex keyword and semantic search, recent arXiv, then references and citers of the best hits. Selected candidates (the top gradeFrac by word-match pre-ranking, default one half) are graded by Jev relevance for this question and the ctx project lines, or the whole run by bm25 word overlap fused with search rank when Jev is unavailable or fails mid-run; one grader ranks the whole run and the output names it and the reason for any fallback. Writes every candidate (score, abstract, origin) to an artifact file and returns a compact top-k list with ids and that path. Takes 1-4 minutes.',
  research_manifest:
    'Record immutable content-hashed manifests of a run or deployment (source/input/output/view files and parameters), or verify them against current files or explicit deployment copies. Labels describe recorded intent; matching hashes verify bytes, not scientific correctness. Use a new key for each execution/version.',
  research_note:
    'Persist a finding, decision, reproducible method or open question with evidence paths/identifiers. For changing facts include claim with project/run/version/surface, basis and file/history dependencies. user_decision requires a user history record. Fingerprints detect changes, not truth. Use a new stable key and explicit supersedes note IDs to revise or consolidate current notes in this conversation. Old text remains as history; no automatic fact extraction or cross-conversation propagation.',
  research_subagent_update:
    'Subagent-only durable progress or final structured report: summary, evidence, verification, uncertainties. Routine updates stay internal; a newly blocked report wakes the lead for a decision without pausing the subagent budget.',
  research_worker_update: 'Deprecated alias of research_subagent_update; identical behavior.',
  research_subagent_review:
    'Lead-only receipt for an ended subagent: accepted, rework or unused, with what evidence you checked and why. Recorded for profiling; it does not itself start another subagent or prove correctness.',
  research_worker_review: 'Deprecated alias of research_subagent_review; identical behavior.',
  research_delegate:
    'Queue a bounded research subagent with a role, narrow brief and source paths. context is required (at least 40 characters, refused otherwise unless workers.requireContext=false): state the purpose of this work and any constraint the person stated that the subagent must keep, not just "read these files". The harness also appends the channel\'s goal entry and the parent conversation\'s recent messages from both sides to BRIEF.md automatically (workers.briefContext); your own context field still carries the specific point this subagent must not miss. Include deliverables and constraints too. Declare writePaths for edits; overlapping scopes serialize, without imposing access permissions. The subagent receives its brief and paths, not the conversation. Roles provide default models, effort, turn cap and skills. To honor an explicit model request set provider and model (for example provider=claude with the requested Fable model); effort can also be overridden. The override is preserved across account selection, not silently downgraded. Only the first resultChars of its final response reach the lead; bulk output stays in artifacts. resumeFrom continues an ended subagent in a fresh context without replaying commands automatically. Returns immediately and wakes the lead on completion. A stable key deduplicates this logical input.',
  research_steer:
    'Queue a correction for a running or queued research subagent without cancelling it. A stable key deduplicates delivery. Inspect research_status subagents for accepted/rejected/unknown acknowledgment; accepted means transport acceptance, not proven adoption. An unknown delivery is never automatically replayed.',
  research_cluster:
    'Slurm preflight, captured-script submission and durable polling. Submit validates with sbatch --test-only first. An unknown submission MUST be reconciled by job comment then adopted, never automatically resubmitted. stop-watch stops polling only; it does not cancel the cluster job.',
  research_status:
    'Read durable research records, subagents (collection=subagents; workers still accepted), jobs, citations or usage. subagent-profile (worker-profile still accepted) reports subagents created since a time, with their parent lead runs; usage-profile compares channel lead, each subagent and maintenance role, Jev features and local hooks over since/until. Give times with an offset, as results show them, or as epoch milliseconds; no model calls. Other collections are paginated. For collection=notes, query=<words> keeps notes whose title or body contains every word, and current=true leaves out replaced notes. Usage covers selected recorded invocations only; missing counters are not zero and estimated cost is not subscription spend. Optionally cancel one owned subagent by id. Bulk subagent results stay in artifacts.',
};
export async function researchTool(
  rawName: ResearchTool,
  raw: unknown,
  ctx: ResearchContext,
): Promise<unknown> {
  const name = TOOL_ALIASES[rawName] ?? rawName;
  const { store, config, sessionId, signal } = ctx;
  if (!config.research.enabled) throw new Error('Enable research.enabled first');
  switch (name) {
    case 'research_worker_advice': {
      if (ctx.worker) throw new Error('Subagent advice is a lead planning tool');
      return workerAdvice(
        new DecisionService(store, config.decisions),
        config,
        schemas[name].parse(raw),
        { scope: `channel:${sessionId}`, sessionId, runId: ctx.runId, signal },
      );
    }
    case 'research_worker_update': {
      if (!ctx.worker || !ctx.workerId)
        throw new Error('Only the current subagent can report progress');
      return updateWorker(store, sessionId, ctx.workerId, raw);
    }
    case 'research_worker_review': {
      if (ctx.worker) throw new Error('Only the lead can review subagent results');
      return reviewWorker(store, sessionId, raw);
    }
    case 'research_paper': {
      const input = schemas[name].parse(raw);
      return retrievePaper(
        store,
        config.research,
        input.id,
        new ResearchHttp(config.research),
        signal,
        input.refresh,
      );
    }
    case 'research_search': {
      const input = schemas[name].parse(raw);
      return searchLiterature(input, {
        config: config.research,
        artifactDir: path.join(store.home, 'research', 'searches'),
        decisions: new DecisionService(store, config.decisions),
        decisionScope: {
          scope: `channel:${sessionId}`,
          sessionId,
          runId: ctx.runId,
          workerId: ctx.workerId,
        },
        jevConcurrency: Math.min(24, config.decisions.maxConcurrent),
        jevUsdPerMillion: config.decisions.inputUsdPerMillion,
        secrets: [decisionKey(config.decisions) ?? ''],
        signal,
      });
    }
    case 'research_citation': {
      const input = schemas[name].parse(raw);
      if (input.action === 'scan') {
        if ((input.text === undefined) === (input.path === undefined))
          throw new Error('scan requires exactly one of text or path');
        return scanCitations(
          store,
          input.text ??
            readCitationDocument(path.resolve(store.session(sessionId).workspace, input.path!)),
        );
      }
      if (!input.id) throw new Error(`${input.action} requires id`);
      if (input.action === 'verify')
        return verifyCitation(
          store,
          config.research,
          input.id,
          new ResearchHttp(config.research),
          signal,
        );
      return input.action === 'get'
        ? (citationRecord(store, input.id) ?? { missing: true })
        : checkCitation(store, { ...input, id: input.id });
    }
    case 'research_manifest':
      return researchManifest(store, sessionId, ctx.scope, raw);
    case 'research_note': {
      const { key, ...note } = schemas[name].parse(raw);
      const saved = saveNote(store, sessionId, `${ctx.scope}:${key}`, note);
      return { ...saved, claim: noteClaim(store, sessionId, saved.id) };
    }
    case 'research_delegate': {
      if (ctx.worker)
        throw new Error(
          'Nested Clawstrum subagents are not exposed; return further work to the lead',
        );
      const { key, ...input } = schemas[name].parse(raw);
      if (config.research.workers.requireContext && (input.context ?? '').trim().length < 40)
        throw new Error(
          'context is required and must be at least 40 characters: state the purpose of this work and any constraint from the person that the subagent must keep, not just which sources to read (example: "this is a model comparison; each agent group must stay on its own model").',
        );
      const row = delegate(store, sessionId, config, `${ctx.scope}:${key}`, input, ctx.runId);
      return {
        id: row.id,
        status: row.status,
        resultPath: row.result_path,
        error: row.error,
        requestedProvider: input.provider,
        requestedModel: input.model,
        ...(row.advisory ? { advisory: row.advisory } : {}),
      };
    }
    case 'research_steer': {
      if (ctx.worker) throw new Error('Only the lead may steer research subagents');
      const input = schemas[name].parse(raw);
      return steerWorker(store, sessionId, input.id, `${ctx.scope}:${input.key}`, input.message);
    }
    case 'research_cluster': {
      const input = schemas[name].parse(raw);
      if (input.action === 'preflight' || input.action === 'submit') {
        if (!input.batch) throw new Error('batch is required');
        if (input.action === 'preflight')
          return preflight(store, sessionId, config.research, input.batch, undefined, signal);
        if (!input.key) throw new Error('A stable submission key is required');
        return submitJob(
          store,
          sessionId,
          config.research,
          `${ctx.scope}:${input.key}`,
          input.batch,
          undefined,
          signal,
          input.watch,
        );
      }
      if (input.action === 'stop-watch') {
        if (!input.id) throw new Error('id is required');
        return {
          changed: Number(
            store.exec(
              "UPDATE cluster_jobs SET status='watch-stopped',next_check=NULL,updated_at=? WHERE id=? AND session_id=? AND status='watching'",
              Date.now(),
              input.id,
              sessionId,
            ).changes,
          ),
          jobCancelled: false,
        };
      }
      if (!input.jobId || (input.action === 'adopt' && !input.id))
        throw new Error('jobId is required; adoption also requires the Clawstrum id');
      return watchJob(
        store,
        sessionId,
        config.research,
        input.jobId,
        input.cluster,
        input.action === 'adopt' ? input.id : undefined,
        input.watch,
      );
    }
    case 'research_status': {
      const parsed = schemas[name].parse(raw);
      const input = {
        ...parsed,
        since: inputTime(parsed.since, 'since'),
        until: inputTime(parsed.until, 'until'),
      };
      const collection = COLLECTION_ALIASES[input.collection] ?? input.collection;
      if (input.cancelWorker) {
        if (ctx.worker || collection !== 'workers' || !input.id)
          throw new Error(
            'Subagent cancellation requires a lead, collection=subagents (workers also accepted) and id',
          );
        store.transaction(() => {
          if (
            store.exec(
              "UPDATE delegations SET status='cancelled',ended_at=? WHERE id=? AND session_id=? AND status IN ('queued','running')",
              Date.now(),
              input.id!,
              sessionId,
            ).changes
          )
            closeWorkerSteers(store, input.id!);
        });
      }
      if (input.query !== undefined && collection !== 'notes')
        throw new Error('query works only with collection=notes');
      if (input.current && collection !== 'notes')
        throw new Error('current works only with collection=notes');
      if (collection === 'decisions')
        return decisionProfile(store, {
          sessionId,
          since: input.since,
          limit: input.limit,
          offset: input.offset,
        });
      if (collection === 'citations')
        return store.all(
          `SELECT key,metadata_json,verified_at FROM citations ${input.id ? 'WHERE key=?' : ''} ORDER BY verified_at DESC LIMIT ? OFFSET ?`,
          ...(input.id ? [input.id] : []),
          input.limit,
          input.offset,
        );
      if (collection === 'worker-profile') {
        if (input.id)
          throw new Error(
            'Use subagents with id for one subagent; subagent-profile accepts since/limit/offset',
          );
        return workerReport(store, {
          sessionId,
          since: input.since,
          limit: input.limit,
          offset: input.offset,
        });
      }
      if (collection === 'maintenance')
        return {
          ...maintenanceBudget(
            store,
            config.runtime.maintenance.maxCallsPerDay,
            Date.now(),
            config.runtime.maintenance.minIntervalMs,
          ),
          dailyConsolidation: maintenanceBudget(
            store,
            config.runtime.consolidation.daily.maxCallsPerDay,
            Date.now(),
            0,
            { daily: true },
          ),
        };
      if (collection === 'usage-profile')
        return usageProfile(store, {
          sessionId,
          since: input.since,
          until: input.until,
          roles: Object.keys(config.research.workers.roles),
        });
      if (collection === 'usage') {
        if (input.id) throw new Error('Usage is paginated by invocation; omit id');
        return usageReport(store, sessionId, input.limit, input.offset);
      }
      const table = { notes: 'research_notes', workers: 'delegations', jobs: 'cluster_jobs' }[
        collection as 'notes' | 'workers' | 'jobs'
      ];
      const columns = {
        notes: 'id,kind,title,body,evidence_json,created_at',
        workers:
          'id,status,parent_run,spec_json,account_id,result_path,summary,usage_json,error,created_at,started_at,ended_at',
        jobs: 'id,status,job_id,cluster,script_path,preflight_json,observation_json,error,checks,next_check,created_at',
      }[collection as 'notes' | 'workers' | 'jobs'];
      const noteFilter =
        collection === 'notes' ? noteFilterSql(input.query, input.current) : undefined;
      const rows = store.all<{ id: string }>(
        `SELECT ${columns} FROM ${table} WHERE session_id=? ${input.id ? 'AND id=?' : ''}${noteFilter ? ' AND ' + noteFilter.sql : ''} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
        sessionId,
        ...(input.id ? [input.id] : []),
        ...(noteFilter?.params ?? []),
        input.limit,
        input.offset,
      );
      if (collection === 'notes') {
        if (input.refresh) await refreshClaimEvidence(store, sessionId, signal);
        return rows.map((r) => ({
          ...r,
          ...noteRevisions(store, sessionId, r.id),
          claim: noteClaim(store, sessionId, r.id),
        }));
      }
      return collection === 'workers'
        ? rows.map((r) => ({
            ...r,
            profile: workerProfile(store, r.id),
            steering: workerSteers(store, r.id),
          }))
        : rows;
    }
  }
}
export function registerResearchTools(register: RegisterFn, ctx: ResearchContext) {
  if (!ctx.config.research.enabled) return;
  const leadOnly = [
    'research_delegate',
    'research_steer',
    'research_worker_review',
    'research_subagent_review',
    'research_worker_advice',
    'research_subagent_advice',
  ];
  const workerOnly = ['research_worker_update', 'research_subagent_update'];
  for (const name of Object.keys(schemas) as ResearchTool[]) {
    if (ctx.worker && leadOnly.includes(name)) continue;
    if (!ctx.worker && workerOnly.includes(name)) continue;
    register(
      name,
      { description: descriptions[name], inputSchema: schemas[name].shape },
      async (input: unknown, extra: any) => {
        let text = JSON.stringify(
          readableTimes(
            await researchTool(name, input, { ...ctx, signal: extra.signal }),
            ctx.config.runtime.timezone ?? hostTimeZone(),
          ),
        );
        if (text.length > 12000) {
          const artifactPath = path.join(
            ctx.store.home,
            'research',
            'tool-results',
            ctx.sessionId,
            `${randomUUID()}.json`,
          );
          writePrivate(artifactPath, text);
          text = JSON.stringify({
            artifactPath,
            originalChars: text.length,
            excerpt: bounded(text, 6000),
            advice:
              'Read the full JSON artifact in bounded portions. The excerpt may end inside a JSON value.',
          });
        }
        return { content: [{ type: 'text' as const, text }] };
      },
    );
  }
}
