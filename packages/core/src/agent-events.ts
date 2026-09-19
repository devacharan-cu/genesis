/**
 * An agent task's record on the ledger (ADR-0020 §5).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is the only account of what an agent
 * was asked, what it said, and what came of it. A gap here is work the system
 * did that nobody can reconstruct.
 *
 * The vocabulary is small on purpose. A run's internals — context assembly, the
 * reasoning call, each proposal — are already the orchestrator's events, under
 * the same `cycleId`. Restating them would give two answers to "what did this
 * task do", which is the same mistake as a second event store in miniature.
 *
 * `EXECUTION_FAILED` is the self model's existing vocabulary (SPEC-01 §4),
 * reused so that an agent failing repeatedly is something the system learns
 * rather than something a log holds.
 *
 * Payload schemas are strict: the task projection reads them, and an event some
 * other version of this code wrote is an anomaly, not a guess.
 */

import { AGENT_ROLES, AGENT_TASK_STATES, MESSAGE_KINDS } from '@genesis/core-types';
import { AGENT_FAILURE_KINDS } from '@genesis/protocol';
import { z } from 'zod';

export const AGENT_EVENTS = {
  AGENT_TASK_ASSIGNED: 'AGENT_TASK_ASSIGNED',
  AGENT_TASK_STATE_CHANGED: 'AGENT_TASK_STATE_CHANGED',
  AGENT_MESSAGE_RECEIVED: 'AGENT_MESSAGE_RECEIVED',
  AGENT_MESSAGE_REJECTED: 'AGENT_MESSAGE_REJECTED',
  AGENT_TASK_FAILED: 'AGENT_TASK_FAILED',
  AGENT_TASK_FINISHED: 'AGENT_TASK_FINISHED',
} as const;
export type AgentEventType = (typeof AGENT_EVENTS)[keyof typeof AGENT_EVENTS];

const Id = z.string().min(1);

export const AgentTaskAssignedPayload = z
  .object({
    taskId: Id,
    attempt: z.number().int().positive(),
    agentId: Id,
    role: z.enum(AGENT_ROLES),
    kind: Id,
    contributesTo: z.array(Id).min(1),
    deadline: z.string().datetime({ offset: true }),
    /** The proposal kinds this agent was granted for this task, after narrowing. */
    proposalKinds: z.array(Id),
  })
  .strict();

export const AgentTaskStateChangedPayload = z
  .object({
    taskId: Id,
    from: z.enum(AGENT_TASK_STATES),
    to: z.enum(AGENT_TASK_STATES),
    reason: z.string().min(1),
  })
  .strict();

/**
 * A message the runtime accepted. The whole envelope is the payload: a record
 * that kept only a summary could not be replayed into the same state.
 */
export const AgentMessageReceivedPayload = z
  .object({
    taskId: Id,
    messageId: Id,
    messageKind: z.enum(MESSAGE_KINDS),
    envelope: z.unknown(),
  })
  .strict();

/** A message the runtime refused. Recorded so the ledger shows what was refused. */
export const AgentMessageRejectedPayload = z
  .object({
    taskId: Id,
    /** Null when the thing was so malformed it named no message id. */
    messageId: Id.nullable(),
    messageKind: z.string().nullable(),
    issues: z.array(z.string()),
  })
  .strict();

export const AgentTaskFailedPayload = z
  .object({
    taskId: Id,
    attempt: z.number().int().positive(),
    kind: z.enum(AGENT_FAILURE_KINDS),
    message: z.string(),
    /** Stable across occurrences, so repetition is visible (SPEC-01 §4). */
    signature: Id,
    /** Whether another attempt will be made. A bounded count, decided here. */
    willRetry: z.boolean(),
  })
  .strict();

export const AgentTaskFinishedPayload = z
  .object({
    taskId: Id,
    finalState: z.enum(AGENT_TASK_STATES),
    attempts: z.number().int().positive(),
    messages: z.number().int().nonnegative(),
    proposalsAccepted: z.number().int().nonnegative(),
  })
  .strict();

export const AGENT_EVENT_PAYLOADS = {
  AGENT_TASK_ASSIGNED: AgentTaskAssignedPayload,
  AGENT_TASK_STATE_CHANGED: AgentTaskStateChangedPayload,
  AGENT_MESSAGE_RECEIVED: AgentMessageReceivedPayload,
  AGENT_MESSAGE_REJECTED: AgentMessageRejectedPayload,
  AGENT_TASK_FAILED: AgentTaskFailedPayload,
  AGENT_TASK_FINISHED: AgentTaskFinishedPayload,
} as const satisfies Record<AgentEventType, z.ZodTypeAny>;
