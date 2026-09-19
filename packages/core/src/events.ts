/**
 * The orchestrator's event vocabulary (ADR-0018 §3).
 *
 * Every important transition of a run is one of these, carrying the run's
 * `cycleId`. `TASK_STARTED`, `TASK_FINISHED` and `EXECUTION_FAILED` are the
 * self model's existing vocabulary (SPEC-01 §4), reused rather than duplicated
 * so the self model learns about runs — the current task, and failures that
 * repeat — without a second source of the same fact. `CONTEXT_ASSEMBLED` is the
 * context package's (ADR-0017).
 *
 * Payload schemas are strict: the run projection reads them, and an event a
 * different version of this code wrote is an anomaly, not a guess.
 */

import { z } from 'zod';
import { REASONING_FAILURE_KINDS, REASONING_PURPOSES, STOP_REASONS, TokenUsage } from '@genesis/reasoning';

export const ORCHESTRATION_EVENTS = {
  TASK_STARTED: 'TASK_STARTED',
  CONTEXT_ASSEMBLED: 'CONTEXT_ASSEMBLED',
  TASK_SPLIT_REQUIRED: 'TASK_SPLIT_REQUIRED',
  REASONING_REQUESTED: 'REASONING_REQUESTED',
  REASONING_FAILED: 'REASONING_FAILED',
  REASONING_RESPONDED: 'REASONING_RESPONDED',
  REASONING_OUTPUT_REJECTED: 'REASONING_OUTPUT_REJECTED',
  PROPOSAL_EVALUATED: 'PROPOSAL_EVALUATED',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  TASK_FINISHED: 'TASK_FINISHED',
} as const;
export type OrchestrationEventType = (typeof ORCHESTRATION_EVENTS)[keyof typeof ORCHESTRATION_EVENTS];

const Id = z.string().min(1);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const TaskPayload = z.object({ taskId: Id }).strict();

/** What CONTEXT_ASSEMBLED tells a run: read leniently, since the manifest is the context package's shape. */
export const ContextAssembledView = z.object({
  manifest: z.object({
    status: z.enum(['ASSEMBLED', 'SPLIT_REQUIRED']),
    taskId: Id,
    usedTokens: z.number().int().nonnegative(),
    budgetTokens: z.number().int().positive(),
  }),
  asOfSeq: z.number().int().nonnegative(),
});

export const TaskSplitRequiredPayload = z
  .object({
    taskId: Id,
    budgetTokens: z.number().int().positive(),
    mandatoryTokens: z.number().int().nonnegative(),
    /** The mandatory items that must all be shown, and did not all fit. */
    mandatory: z.array(Id),
  })
  .strict();

export const ReasoningRequestedPayload = z
  .object({
    taskId: Id,
    callId: Id,
    providerId: Id,
    purpose: z.enum(REASONING_PURPOSES),
    requestHash: Sha256,
    contextIds: z.array(Id),
  })
  .strict();

export const ReasoningFailedPayload = z
  .object({
    callId: Id,
    kind: z.enum(REASONING_FAILURE_KINDS),
    retryable: z.boolean(),
    message: z.string(),
  })
  .strict();

export const ReasoningRespondedPayload = z
  .object({
    callId: Id,
    modelId: Id,
    stopReason: z.enum(STOP_REASONS),
    usage: TokenUsage,
    responseHash: Sha256,
    /** The raw text, so the run can be explained and replayed. Null when over the recorded limit. */
    outputText: z.string().nullable(),
    outputLength: z.number().int().nonnegative(),
  })
  .strict();

export const OUTPUT_REJECTIONS = ['NOT_AN_ENVELOPE', 'TOO_LARGE'] as const;

export const ReasoningOutputRejectedPayload = z
  .object({
    callId: Id,
    reason: z.enum(OUTPUT_REJECTIONS),
    issues: z.array(z.string()),
  })
  .strict();

export const PROPOSAL_REJECTIONS = ['MALFORMED', 'NOT_PERMITTED', 'GOAL_DRIFT', 'RULE_VIOLATION'] as const;
export type ProposalRejection = (typeof PROPOSAL_REJECTIONS)[number];

export const ProposalEvaluatedPayload = z
  .object({
    callId: Id,
    index: z.number().int().nonnegative(),
    /** The kind the output named, when it named a string at all. */
    kind: z.string().nullable(),
    outcome: z.enum(['ACCEPTED', 'REJECTED']),
    reason: z.enum(PROPOSAL_REJECTIONS).nullable(),
    /** The cognitive rule that refused it, for RULE_VIOLATION. */
    rule: z.string().nullable(),
    detail: z.string().nullable(),
    /**
     * Ledger positions of the events an accepted proposal appended. Positions,
     * not event ids: ids are minted at append time, and a run's record must be
     * the same whenever the same inputs are run.
     */
    eventSeqs: z.array(z.number().int().positive()),
  })
  .strict();
export type ProposalEvaluated = z.infer<typeof ProposalEvaluatedPayload>;

export const ExecutionFailedPayload = z
  .object({ signature: Id, mitigation: z.string().min(1).nullish() })
  .strict();
