/**
 * What an agent asks the core to run, and what it is told came back
 * (ADR-0020 §2).
 *
 * This is the shape that keeps agents out of the orchestration business. An
 * agent frames a task; the core assembles the context, calls the provider under
 * budget, records the call, and puts each proposal through the cognitive
 * deciders. The agent then reads a `RunSummary` — data, after the fact.
 *
 * Two consequences follow, and both are the point:
 *
 *   - An agent never holds a provider, so no model-specific behaviour can live
 *     in an agent, and the `agents` package needs no dependency on the
 *     reasoning port at all.
 *   - There is one orchestration path. An agent cannot assemble its own
 *     context or make its own call, because it has nothing to make one with.
 */

import { z } from 'zod';

const Id = z.string().trim().min(1);

/**
 * How an agent frames the work for the core to run. Role-specific, and pure:
 * the same assignment always frames the same way.
 *
 * Note what is absent. No prompt, no system message, no model, no temperature.
 * The wording that reaches a provider is the core's (`core/src/request.ts`) and
 * the adapter's, so a role cannot smuggle model-specific behaviour in as text.
 */
export const TaskFraming = z
  .object({
    /** The task kind, used for the failure signature and for context scoring. */
    kind: Id,
    /** What this run is for, in the agent's own words. */
    text: z.string().trim().min(1).max(4000),
    /** Graph nodes the task is about, for the context assembler. */
    nodeIds: z.array(Id).max(100).default([]),
    /** The goal the run serves. Null when the assignment names none. */
    activeGoalId: Id.nullable().default(null),
    budgetTokens: z.number().int().positive(),
  })
  .strict();
export type TaskFraming = z.infer<typeof TaskFraming>;

export const RUN_OUTCOMES = ['COMPLETED', 'SPLIT_REQUIRED', 'FAILED'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** What one proposal from the run came to. The decision is the core's. */
export const ProposalSummary = z
  .object({
    kind: z.string().nullable(),
    accepted: z.boolean(),
    /** Why it was refused: malformed, not permitted, goal drift, a cognitive rule. */
    reason: z.string().nullable(),
    detail: z.string().nullable(),
  })
  .strict();
export type ProposalSummary = z.infer<typeof ProposalSummary>;

/**
 * What the agent is told about its run. Everything here is already on the
 * ledger; this is a read of it, shaped for one task.
 *
 * There is no raw model output. An agent reads what its proposals *came to*,
 * not what the model said, so a role cannot re-interpret rejected output into
 * something it prefers.
 */
export const RunSummary = z
  .object({
    outcome: z.enum(RUN_OUTCOMES),
    cycleId: Id,
    callId: Id.nullable(),
    /** The provider failure or output rejection, when there was one. */
    failure: z.object({ kind: Id, message: z.string() }).strict().nullable(),
    proposals: z.array(ProposalSummary).max(100),
    context: z
      .object({
        status: z.enum(['ASSEMBLED', 'SPLIT_REQUIRED']),
        usedTokens: z.number().int().nonnegative(),
        budgetTokens: z.number().int().positive(),
        /**
         * What the run was actually shown, so a finding can cite it. Ids and
         * kinds only: the agent already had the text in its assignment, and a
         * second copy here would be a second thing to keep in step.
         */
        shown: z.array(z.object({ id: Id, kind: Id, mandatory: Id.nullable() }).strict()).max(500),
      })
      .strict(),
  })
  .strict();
export type RunSummary = z.infer<typeof RunSummary>;

/** How many of the run's proposals the core accepted. */
export const acceptedCount = (summary: RunSummary): number =>
  summary.proposals.filter((p) => p.accepted).length;

/**
 * True when the run produced nothing the core kept.
 *
 * Distinct from failure: a run can complete, be well-formed, and have every
 * proposal refused. That is a real outcome and the agent must be able to see
 * it rather than reporting success because nothing threw.
 */
export const producedNothing = (summary: RunSummary): boolean => acceptedCount(summary) === 0;
