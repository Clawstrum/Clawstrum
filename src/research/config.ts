import { z } from 'zod';

const role = z
  .object({
    description: z.string().min(1),
    prompt: z.string().min(1),
    models: z
      .object({
        claude: z.string().optional(),
        codex: z.string().optional(),
        gemini: z.string().optional(),
      })
      .strict()
      .prefault({}),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
    /** Claude turns or completed Codex tool items; 0 means no limit. A per-role default of 20 to 40
     * stopped close to half of all subagents in one deployment, so the limits stopped more useful
     * work than runaway work. A stuck subagent is caught by the lead's periodic progress check
     * (workers.checkMinutes) and cancelled there. */
    maxTurns: z.number().int().min(0).max(1000).default(0),
    maxTokens: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().finite().optional(),
    /** Installed skills this role's subagents are given, by directory name. The lead receives the
     * whole inventory because it decides what the turn is; a subagent has one brief, and a catalog of
     * workflows it will not use is prompt it pays for on a model chosen to be cheap. A name that is
     * not installed is reported in the subagent's route event rather than failing the dispatch, since
     * a role travels with the configuration and the skills travel with the installation. */
    skills: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{0,60}$/))
      .max(20)
      .default([]),
  })
  .strict();
const defaults: Record<string, z.input<typeof role>> = {
  explorer: {
    description: 'Locate code or evidence in supplied files',
    prompt:
      'Inspect the supplied paths. Return exact locations, observations and unresolved questions. Keep bulk file contents out of the summary.',
    models: { claude: 'haiku', codex: 'gpt-5.6-luna' },
    effort: 'low',
  },
  'log-reader': {
    description: 'Extract evidence from large experiment logs',
    prompt:
      'Read targeted logs incrementally. Report measurements with units, run IDs, paths and line numbers. Separate missing evidence from zero-valued measurements.',
    models: { claude: 'haiku', codex: 'gpt-5.6-luna' },
    effort: 'low',
  },
  'lit-reader': {
    description: 'Retrieve and read scientific papers',
    prompt:
      'Use research_paper and research_citation. Distinguish metadata, abstract and full text. Return verified identifiers, limitations and exact evidence locations; unavailable quotations must stay unavailable.',
    models: { claude: 'sonnet', codex: 'gpt-5.6-sol' },
    effort: 'medium',
  },
  analyst: {
    description: 'Analyze a narrowly specified scientific question',
    prompt:
      'Use the supplied evidence. State assumptions, derive the result, check units and limiting cases, and record uncertainty. Do not turn a bounded analysis into an open-ended search.',
    models: { claude: 'sonnet', codex: 'gpt-5.6-sol' },
    effort: 'high',
    skills: ['theory'],
  },
  coder: {
    description: 'Implement a bounded computational change',
    prompt:
      'Implement the specified change in the supplied project. Verify with relevant tests or a small experiment. Report modified paths, results and limitations.',
    models: { claude: 'sonnet', codex: 'gpt-5.6-terra' },
    effort: 'high',
    skills: ['iterate'],
  },
  /** The first five roles answer "what is there" or "make this change". A design question needs
   * the direction worked out in enough detail to cost it, which is lead-cost work if nobody else
   * does it. The thinker builds only: judging the direction is the reviewer's job, because a
   * subagent asked to both develop and judge a plan does each half-heartedly. Separating derived
   * from assumed stays in the prompt; a long assumption list is itself the finding.
   */
  thinker: {
    description: 'Develop a proposed direction in detail',
    prompt:
      "Work within the assigned direction without widening its scope. Work out the design detail, the tradeoffs, any derivations, and an implementation sketch concrete enough to cost it, checked against the actual sources. Mark every claim as derived from evidence you inspected or assumed, and name the assumptions you could not check. Do not argue against the direction itself; judging it is the reviewer role's job.",
    models: { claude: 'sonnet', codex: 'gpt-5.6-sol' },
    effort: 'high',
    skills: ['brainstorm'],
  },
  /** Facts only. Each objection must cite a file, line and verbatim quote so the harness can read
   * the cited lines itself (checker.ts) and show the lead what is actually there. */
  checker: {
    description: 'Check one artifact against its sources: is it true; proposes nothing',
    prompt: [
      'Read the artifact named in the brief and the sources the brief names, and the research notes appended below.',
      'When research notes are appended below the brief, check the artifact against them: an earlier result it ignores or contradicts is a missed_prior objection. Cite a note by its file and line like any other source.',
      'Check whether it is true: find what is wrong, stale, unsupported, overclaimed, or contradicted by an earlier result. Give at most 3 objections, most serious first.',
      'Format each objection exactly as:',
      'OBJECTION <n> [<kind>]: <one sentence>',
      'EVIDENCE: <path>:<line> "<verbatim quote from that line or the 1-3 lines starting there>"',
      'with one or more EVIDENCE lines per objection. <kind> is one of wrong, stale, unsupported, overclaim, missed_prior. An objection with no EVIDENCE line is allowed and will be marked unbacked.',
      'If nothing survives, answer with one line: NO OBJECTION: <why>.',
      'Never judge whether the work is worth doing or what to cut; that is the reviewer role. Never propose designs, fixes or alternatives.',
    ].join('\n'),
    models: { claude: 'opus', codex: 'gpt-5.6-sol' },
    effort: 'high',
    skills: [],
  },
  /** Worth, not truth. The review reads the items as one story before any verdict, so a piece is
   * judged by what it does for the strongest story the results could tell. Two stages: direction
   * (work in progress: nothing is cut, under-evidenced is develop) and final (a referee with scarce
   * slots), because slot pressure on unfinished work cut promising results. The harness checks the
   * evidence quotes, the stage rules and the budget (reviewer.ts). */
  reviewer: {
    description:
      'Judge whether work is promising (direction) or passes a referee (final); reads the story first, one verdict per item',
    prompt: [
      'Judge what exists: what story it tells, whether it convinces, what it still needs, what should go. The checker asks whether a claim is true; the thinker designs new work; you do neither. Anything new (a run, a proof, an analysis) you name in one line, and the lead hands it to a thinker.',
      'The brief gives the artifact, the stage, the goal (which paper, claim or decision this serves; venue if any), the story the piece sits in (paper outline, other figures, the slate), slots and your angle. The artifact is a slate (results and plan, one item per line), a fresh result (the claims it should carry), or a paper draft or figure (its claims, sections or panels; look at the figure itself, not only its caption).',
      'Two stages. direction: work in progress, pieces missing; is it promising, what story could it tell, what does it need; no slot squeeze and nothing is cut; OVERALL is promising / promising with work / not promising, and why. final: a paper draft, final figure or submission; does it pass a referee at the venue; slots are scarce: main and fix results together at most the slots, the rest goes to develop, supporting or cut; OVERALL is accept / minor / major / reject at the venue, and the biggest problem.',
      "Read the raw notes and sources yourself, not only the artifact; the lead's framing is the authors' spin; when notes disagree the newer one wins unless it says otherwise.",
      "Your job is to help the work tell the best story it can, not to shrink it. Before any verdict, read the items together and the story they sit in: STORY NOW, the story the items tell as they stand; STORY BEST, the strongest story the existing results could tell, develop items included (say so if it differs from the authors' framing); STORY GAP, the missing link between the results and that story (a result, a control, a derivation); LEAD, the most promising item or combination to develop next, and why. Judge each item by what it does for the best story, not alone.",
      'Each item has a kind: result (a result, claim, panel or section) or plan (a run, job, analysis or control not done yet). Give EVERY item exactly one verdict:',
      'main: a result that carries the story as it stands; a plan item worth its cost (run it).',
      'fix: a result that belongs in main but not as it is; say what to change.',
      'develop: interesting but not convincing yet (one seed, no proof, a missing control, a weak analysis), or a plan item worth doing that is not designed yet; say what it needs (data, proof, control or design) and roughly what it costs.',
      'supporting: backup: supplement, extended data, a check, a later run; say where it goes.',
      'dead_end: a result already killed it; cite that result in EVIDENCE. It is flagged, not removed.',
      'cut (final stage only): drop it; it serves no story worth telling in this paper even if it holds up.',
      'stop (plan items only): halt it; it costs and cannot change the conclusion.',
      'Unfinished or under-evidenced is never a reason for cut, dead_end or stop: that is develop. Cutting promising work for want of data is as much a failed review as keeping everything in main. An item that does not fit the current framing but would carry a stronger story is main or develop. An item that fits the story but not this piece is supporting, with its destination. Plan items never count against the slots; main plan items are at most PLAN SLOTS when the brief gives them. Your verdicts are proposals; the researcher decides.',
      'Format exactly:',
      'STAGE: <direction or final, from the brief>',
      'SLOTS: <n>   (main result slots from the brief; required in final)',
      'PLAN SLOTS: <n>   (only when the brief gives them)',
      'STORY NOW: <one line>',
      'STORY BEST: <one line>',
      'STORY GAP: <one line>',
      'LEAD: <one line>',
      'ITEM <n> [<verdict>, <kind>]: <item> — <why, one line>',
      'FIX: <what to change>   (fix items only)',
      'DEVELOP: <what it needs + rough cost>   (develop items only)',
      'KILL: <result that would change this verdict>   (main, fix, develop and supporting items)',
      'EVIDENCE: <path>:<line> "<verbatim quote from that line or the 1-3 lines starting there>"   (zero or more per item; at least one for dead_end)',
      'MISSING: <direction: what the story still needs; final: what a referee would demand that is not there>   (at most 3 lines)',
      'OVERALL: <the call for the stage, as above>',
      'TOP CUT: <final stage: the single cut that saves the most reader time; none otherwise>',
      'No praise, no summary of the artifact.',
    ].join('\n'),
    models: { claude: 'opus', codex: 'gpt-5.6-sol' },
    effort: 'high',
    skills: [],
  },
};
export const researchSchema = z
  .object({
    enabled: z.boolean().default(true),
    email: z.email().optional(),
    // Enabling research tools does not opt an existing installation into tool denials.
    // Operators can explicitly choose strict checks; all modes retain full host access.
    validation: z.enum(['advisory', 'strict', 'off']).default('advisory'),
    requestTimeoutMs: z.number().int().min(100).max(120000).default(30000),
    maxDownloadBytes: z.number().int().min(1024).max(200000000).default(50000000),
    minTextChars: z.number().int().min(1).default(1000),
    pdftotext: z.string().min(1).default('pdftotext'),
    /** OpenAlex budget (USD) left untouched by paid full-text downloads, so search keeps working. */
    openalexReserveUsd: z.number().min(0).max(100).default(0.25),
    springerKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .default('SPRINGER_OA_API_KEY'),
    openalexKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .default('OPENALEX_API_KEY'),
    stateChars: z.number().int().min(1000).max(50000).default(12000),
    /** A short list of this channel's current research notes (date, title, id) in the lead's prompt,
     * so the lead sees that notes exist without searching. Titles only; the body is read with
     * research_status collection=notes id=<id>. Built by the harness for each lead run and never
     * written into AGENTS.md. Subagents and maintenance passes do not get it. */
    notesIndex: z
      .object({
        enabled: z.boolean().default(true),
        maxItems: z.number().int().min(1).max(500).default(40),
        maxChars: z.number().int().min(500).max(50000).default(4000),
      })
      .strict()
      .prefault({}),
    /** Deprecated configuration compatibility only. New passes use runtime.consolidation. */
    consolidator: z
      .object({
        enabled: z.boolean().default(true),
        models: z
          .object({
            claude: z.string().optional(),
            codex: z.string().optional(),
            gemini: z.string().optional(),
          })
          .strict()
          .prefault({ claude: 'haiku' }),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
        prompt: z.string().min(1).default('Deprecated; see runtime.consolidation'),
        timeoutMs: z.number().int().min(5000).max(600000).default(90000),
        restoreWaitMs: z.number().int().min(0).max(120000).default(45000),
        /** Transcript budget. Sampled head and tail, so this is the size of what the pass sees, not
         * a prefix of the conversation. */
        transcriptChars: z.number().int().min(2000).max(400000).default(60000),
        /** Ceiling on the block delivered back into context. It competes with the state dump and the
         * research state for the same post-compaction window. */
        digestChars: z.number().int().min(500).max(20000).default(4000),
        /** Candidate memory entries below this are dropped rather than queued. Candidates are never
         * promoted automatically at any confidence; this only bounds the size of the queue. */
        minConfidence: z.number().min(0).max(1).default(0.7),
        maxBudgetUsd: z.number().positive().finite().optional(),
      })
      .strict()
      .prefault({}),
    /** Deprecated and inert: there is no independent file curation process. */
    curation: z
      .object({
        enabled: z.boolean().default(true),
        prompt: z.string().min(1).default('Deprecated; file curation is retired'),
        intervalMs: z
          .number()
          .int()
          .min(60000)
          .max(7 * 86400000)
          .default(6 * 3600000),
        timeoutMs: z.number().int().min(5000).max(600000).default(120000),
        maxBudgetUsd: z.number().positive().finite().optional(),
      })
      .strict()
      .prefault({}),
    /** Ceilings on an outgoing reply, enforced through the same review that handles citations. Set
     * either to 0 to drop that half of the check; both to 0 to remove it entirely. */
    reply: z
      .object({
        maxLines: z.number().int().min(0).max(500).default(25),
        maxChars: z.number().int().min(0).max(40000).default(2000),
      })
      .strict()
      .prefault({}),
    /** Tool-call recall (recall.ts): matching passages from this conversation's history, handed
     * to the lead with its search-shaped tool calls. Never denies; independent of `validation`. */
    recall: z
      .object({
        enabled: z.boolean().default(true),
        /** Notices with hits per provider run. Calls with no hits never spend one. */
        maxNotices: z.number().int().min(0).max(20).default(3),
        maxHits: z.number().int().min(1).max(10).default(3),
      })
      .strict()
      .prefault({}),
    /** Message-time recall (message-recall.ts): research notes no longer in loaded memory, screened
     * by Jev against each user message and pasted into the lead's prompt. No-op without a Jev key. */
    messageRecall: z
      .object({
        enabled: z.boolean().default(true),
        candidates: z.number().int().min(1).max(100).default(24),
        threshold: z.number().finite().min(0).max(1).default(0.78),
        maxNotes: z.number().int().min(1).max(10).default(3),
        budgetMs: z.number().int().min(100).max(10000).default(2500),
      })
      .strict()
      .prefault({}),
    /** Extra absolute roots a session may write to, beyond its workspace, the Clawstrum home and the
     * system temporary directory. Shared project trees belong here; a home directory does not. */
    writeRoots: z.array(z.string()).default([]),
    holdBackgroundTasks: z.boolean().default(true),
    /** The daemon, every lead and subagent `claude` process, and every Bash tool command share one
     * CPU on the login node. A Bash command is prefixed with `renice -n <toolNice> -p $$` so the
     * daemon and the agent processes keep priority while the shell command runs; the daemon and the
     * agent processes themselves stay at nice 0. 0 disables the prefix. Codex has no PreToolUse hook,
     * so this has no effect on Codex leads or workers. */
    toolNice: z.number().int().min(0).max(19).default(15),
    /** `workers.critic` is the deprecated name of `workers.review`, kept so older configuration
     * files still parse under .strict(); `review` wins when both are present. */
    workers: z
      .preprocess(
        (value: any) => {
          if (!value || typeof value !== 'object' || !('critic' in value)) return value;
          const { critic, ...rest } = value;
          return rest.review === undefined ? { ...rest, review: critic } : rest;
        },
        z
          .object({
            /**
             * What happens when a dispatch bypasses the roles: a native subagent, or a workflow script
             * that fans out around every control in this block. See dispatch.ts for the run that
             * motivated the refusals.
             *
             * This is separate from `validation` above, and defaults the other way, because the two
             * decide different things. `validation` judges the *content* of a write — a citation, a
             * file size, a path — where a model that disagrees with the finding may well be right, so
             * advising it and letting it proceed is the defensible default. Routing judges *which tool*
             * runs work that is already going to happen, where there is nothing to disagree with: the
             * same work through research_delegate gets a pinned model, a turn cap, a result artifact
             * and a review by the lead, and through the native tool gets none of them. Advising there
             * has a measured compliance of approximately zero, which makes the refusal a no-op in every
             * default installation — the state this setting exists to end.
             *
             * Nothing here constrains the lead's own work. The refusals name three dispatch tools; a
             * lead that reads, edits, runs commands and answers inline never meets them, and the
             * refusal text says so. `advise` restores the previous behaviour, `off` removes the check.
             * `validation: 'off'` disables every PreToolUse check including this one.
             */
            enforceRoles: z.enum(['deny', 'advise', 'off']).default('deny'),
            /** Subagents running at once across the daemon. Each also takes a slot of its account's
             * maxConcurrent, which it shares with lead conversations on that account. */
            maxConcurrent: z.number().int().min(1).max(64).default(20),
            /** Do not start a queued subagent while less than this much memory is available (MB), read
             * from the daemon's cgroup limits and the host's free memory (memory.ts). A waiting
             * subagent stays queued and is retried on the next tick. 0 turns the check off. */
            minFreeMemoryMB: z.number().int().min(0).max(1048576).default(1024),
            /** How many times one subagent is resumed in its own provider conversation after a
             * Clawstrum restart. Past this it fails as an interrupted subagent. 0 turns resume off. */
            restartResumes: z.number().int().min(0).max(10).default(2),
            /** How many times a running subagent is automatically continued, under the same id, on a
             * different account after its account hits a provider quota. The provider conversation is
             * tied to the exhausted account, so each continuation is a fresh context carrying the prior
             * record forward, not a native session resume. Past this, or with no other account
             * configured for the subagent's provider, it fails as before. 0 turns this off. */
            quotaContinues: z.number().int().min(0).max(10).default(2),
            /** Wall-clock limit per subagent; 0 means no limit (see role maxTurns). */
            timeoutMs: z.number().int().min(0).max(86400000).default(0),
            /** While a conversation has running subagents, wake its lead this often with each subagent's
             * run time, step count, idle time and last progress note, so the lead can cancel or correct
             * one that is stuck or off its brief. 0 turns the check off. */
            checkMinutes: z.number().int().min(0).max(1440).default(15),
            /** The first running subagent to edit a file with a native edit tool holds it until it ends;
             * another running subagent's native edit of that file is refused, naming the holder. The
             * lead is never held. Completion wakes list the files each subagent changed and flag files
             * another subagent changed at the same time. See research/file-holds.ts. */
            fileHolds: z.boolean().default(true),
            resultChars: z.number().int().min(500).max(20000).default(8000),
            /** A subagent sees only its brief, not the conversation that produced it, so a constraint
             * the person stated and the lead's own summary dropped never reaches the subagent (in one
             * deployment 74% of briefs carried only the default placeholder text). When enabled, every
             * BRIEF.md gets a "Conversation context" section carrying the channel's goal entry (or, when
             * the channel's MEMORY has no reliable goal marker, the harness-saved user-decisions block)
             * plus the parent conversation's recent messages from both sides, verbatim. */
            briefContext: z
              .object({
                enabled: z.boolean().default(true),
                /** Messages kept from the merged, time-ordered conversation (both the person's inbound
                 * messages and the lead's delivered outbox replies); oldest dropped first past this. */
                recentMessages: z.number().int().min(0).max(200).default(40),
                /** Per-message cap; a long message is truncated, not dropped. */
                messageChars: z.number().int().min(100).max(20000).default(1500),
                /** Cap on the whole context section; oldest messages dropped first past this. */
                maxChars: z.number().int().min(500).max(100000).default(30000),
              })
              .strict()
              .prefault({}),
            /** Refuse research_delegate when `context` is missing or under 40 characters, naming the
             * purpose of the work and any constraint from the person the subagent must keep. A worker
             * with no stated purpose once advised sending long prompts to a model that a comparison
             * required kept off that model; the lead had the constraint and never passed it down. */
            requireContext: z.boolean().default(true),
            account: z.string().optional(),
            roles: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), role).prefault(defaults),
            review: z
              .object({
                /** A checker or reviewer delegation without an existing artifact file: refuse it,
                 * proceed with a one-line advisory in the delegate result, or say nothing. */
                artifact: z.enum(['deny', 'advise', 'off']).default('advise'),
                /** Hold a send from the run that consumed a checker or reviewer result's wake once
                 * (never an interim result), so the checked result is read before the user hears
                 * anything. Enforced in the shared outgoing reply review (replies.ts), so it covers
                 * Claude and Codex leads; independent of `validation`. */
                hold: z.enum(['off', 'once']).default('off'),
                /** A git push whose paper change touches a claim, number, caption, figure or the abstract needs a checker or reviewer result
                 * after the change's first .tex edit in that repository (paper-push.ts). Enforced by
                 * PreToolUse hooks, which exist only for Claude leads; checked on the lead's pushes;
                 * subagent pushes are not checked. Independent of `validation`. */
                paperPush: z.enum(['deny', 'advise', 'off']).default('off'),
                /** Characters of the session's AGENTS.md "Research state" section appended to a
                 * checker or reviewer prompt, newest kept when over; 0 leaves only the memory
                 * pointer every subagent gets. */
                notesChars: z.number().int().min(0).default(20000),
              })
              .strict()
              .prefault({}),
          })
          .strict(),
      )
      .prefault({}),
    slurm: z
      .object({
        enabled: z.boolean().default(true),
        pollMs: z.number().int().min(60000).default(300000),
        maxChecks: z.number().int().min(1).max(10000).default(288),
        commandTimeoutMs: z.number().int().min(100).max(120000).default(20000),
        commands: z
          .object({
            sbatch: z.string().default('sbatch'),
            squeue: z.string().default('squeue'),
            sacct: z.string().default('sacct'),
            sinfo: z.string().default('sinfo'),
            sshare: z.string().default('sshare'),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});
export type ResearchConfig = z.infer<typeof researchSchema>;

/** Explicit MCP credentials work with providers that do not inherit the full host environment. */
export function researchEnvironment(
  config: ResearchConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    [config.openalexKeyEnv, config.springerKeyEnv]
      .filter((key) => !!env[key])
      .map((key) => [key, env[key]!]),
  );
}
