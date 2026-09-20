/**
 * The message envelope and the nine message bodies (SPEC-04 §3, ADR-0020 §5).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). Everything an agent says arrives through
 * here, so this is where a malformed or over-reaching message is stopped —
 * before a handler has read it, and before the runtime has acted on it.
 *
 * Three rules shape the schemas:
 *
 *   1. Every body is `.strict()`. A field nobody declared is a field nobody
 *      checked, and an agent that can attach one has an unaudited channel.
 *   2. Bodies carry claims, never conclusions. A proposal is a request; a
 *      finding is an observation; evidence is what was seen. No message kind
 *      can say what is true, because none of them has a field for it.
 *   3. `authorityClaim` is advisory and says so. The core clamps it (ADR-0005,
 *      ADR-0011); nothing here enforces it, because a check in two places is a
 *      check that disagrees with itself eventually.
 *
 * Envelopes are data. There is no shared mutable object passed between the
 * runtime and an agent, which is what makes a task's traffic replayable.
 */

import {
  AGENT_ROLES,
  ACTOR_KINDS,
  AUTHORITY_LEVELS,
  JsonValue,
  MESSAGE_KINDS,
  MessageId,
  QUESTION_AUDIENCES,
  RISK_LEVELS,
  TaskId,
  UNCERTAINTY_RESOLUTIONS,
} from '@genesis/core-types';
import { z } from 'zod';

/** The schema version of this protocol. One version exists; older ones upcast. */
export const PROTOCOL_VERSION = '1' as const;

const Id = z.string().trim().min(1);
const Text = z.string().trim().min(1).max(4000);
const Iso = z.string().datetime({ offset: true });

/**
 * Who sent or is to receive a message. Deliberately the same shape as the
 * ledger's `EventActor`, so recording an envelope does not translate between
 * two ideas of "who".
 */
export const ActorRef = z
  .object({
    kind: z.enum(ACTOR_KINDS),
    id: Id,
    /** Present for AGENT actors; absent otherwise. */
    role: z.enum(AGENT_ROLES).optional(),
  })
  .strict();
export type ActorRef = z.infer<typeof ActorRef>;

// ---------------------------------------------------------------- bodies

/**
 * core → agent. Everything the agent is given: the work, the goal it serves,
 * the assembled context, and the limits it must stay inside.
 *
 * The context is *text the core assembled*, not a handle onto anything. An
 * agent receives what it was shown and cannot go and look at more.
 */
export const TaskAssignmentBody = z
  .object({
    taskId: TaskId,
    /** Which attempt this is, from 1. A retry keeps the task id (ADR-0020 §7). */
    attempt: z.number().int().positive(),
    role: z.enum(AGENT_ROLES),
    kind: Id,
    instruction: Text,
    /** The goals this work serves. Non-empty: work that serves no goal is drift. */
    contributesTo: z.array(Id).min(1).max(50),
    context: z
      .array(
        z
          .object({ id: Id, kind: Id, authority: z.enum(AUTHORITY_LEVELS), text: z.string() })
          .strict(),
      )
      .max(500),
    budget: z.object({ maxOutputTokens: z.number().int().positive(), timeoutMs: z.number().int().positive() }).strict(),
    deadline: Iso,
    /**
     * The role-specific input for this task, validated by the role that reads
     * it (`ROLE_INPUTS` in factory.ts). `JsonValue`, so an assignment survives
     * the round trip through the ledger unchanged and a task can be replayed
     * from what was recorded rather than from what a caller still holds.
     */
    input: JsonValue.nullable().default(null),
  })
  .strict();
export type TaskAssignmentBody = z.infer<typeof TaskAssignmentBody>;

/**
 * agent → core. A requested change, inert until the core applies it.
 *
 * The concrete operations are `JsonValue` because the core, not the protocol,
 * decides what a proposal of a given kind may contain — `core/src/proposals.ts`
 * holds the only schemas that decide, and duplicating them here would create a
 * second answer that drifts (ADR-0020 §3).
 */
export const ProposalBody = z
  .object({
    taskId: TaskId,
    /** Checked against the core's permitted kinds, then against the agent's own. */
    proposalKind: Id,
    rationale: Text,
    contributesTo: z.array(Id).min(1).max(50),
    changes: JsonValue,
    /** The agent's claim about what it touches. The core recomputes this itself. */
    expectedImpact: z.array(Id).max(200).default([]),
    evidenceRefs: z.array(Id).max(50).default([]),
    /** Advisory. Clamped by the core; an agent cannot elevate its own truth. */
    authorityClaim: z.enum(AUTHORITY_LEVELS).optional(),
    reversible: z.boolean().default(true),
  })
  .strict();
export type ProposalBody = z.infer<typeof ProposalBody>;

/** agent → core. An observation or concern that is not a requested change. */
export const FindingBody = z
  .object({
    taskId: TaskId,
    /** What the finding is about, in the sender's own terms. */
    subject: Text,
    detail: Text,
    risk: z.enum(RISK_LEVELS),
    /** References into context the agent was shown. It cannot cite what it never saw. */
    contextRefs: z.array(Id).max(50).default([]),
  })
  .strict();
export type FindingBody = z.infer<typeof FindingBody>;

/** agent → core. Something the agent cannot resolve itself (SPEC-01 §9). */
export const QuestionBody = z
  .object({
    taskId: TaskId,
    text: Text,
    /** Why it cannot be answered from what the agent was given. */
    reason: Text,
    audience: z.enum(QUESTION_AUDIENCES),
    /** What will break if the system guesses instead of asking. */
    whatBreaksIfWrong: Text,
    risk: z.enum(RISK_LEVELS),
    resolution: z.enum(UNCERTAINTY_RESOLUTIONS),
  })
  .strict();
export type QuestionBody = z.infer<typeof QuestionBody>;

/**
 * agent → core. Raw output from a real execution, plus what it claims to cover.
 *
 * There is no state field. An agent submits what happened; what that justifies
 * is the verification engine's to decide (ADR-0020 §8).
 */
export const EvidenceSubmissionBody = z
  .object({
    taskId: TaskId,
    /** The experiment this came out of, when it came out of one. */
    experimentId: Id.nullable().default(null),
    environment: z.enum(['SANDBOX', 'STAGING', 'PRODUCTION', 'LOCAL']),
    exitCode: z.number().int(),
    raw: z.string().max(200_000),
    testKind: z.enum(['PROPERTY', 'UNIT', 'CONFORMANCE', 'INTEGRATION', 'E2E', 'REGRESSION']).optional(),
    claimedArtifacts: z.array(Id).min(1).max(200),
  })
  .strict();
export type EvidenceSubmissionBody = z.infer<typeof EvidenceSubmissionBody>;

/** agent → core. Progress. A heartbeat is not a result and cannot finish a task. */
export const StatusBody = z
  .object({ taskId: TaskId, note: Text, progress: z.number().min(0).max(1).optional() })
  .strict();
export type StatusBody = z.infer<typeof StatusBody>;

/** agent → core. The terminal outcome of the assigned task, as the agent saw it. */
export const ResultBody = z
  .object({
    taskId: TaskId,
    /** What the agent believes it achieved. The runtime decides the task's state. */
    summary: Text,
    proposalsSubmitted: z.number().int().nonnegative().default(0),
    findingsRaised: z.number().int().nonnegative().default(0),
    questionsRaised: z.number().int().nonnegative().default(0),
  })
  .strict();
export type ResultBody = z.infer<typeof ResultBody>;

/** How a task can fail. The signature is what the self model folds (SPEC-01 §4). */
export const AGENT_FAILURE_KINDS = [
  'TIMEOUT',
  'CANCELLED',
  'AGENT_THREW',
  'MALFORMED_OUTPUT',
  'CAPABILITY_REFUSED',
  'REASONING_FAILED',
  'DEPENDENCY_FAILED',
  'BLOCKED',
] as const;
export type AgentFailureKind = (typeof AGENT_FAILURE_KINDS)[number];

/** any → core. A typed failure. `retryable` is a request, not a guarantee. */
export const ErrorBody = z
  .object({
    taskId: TaskId,
    kind: z.enum(AGENT_FAILURE_KINDS),
    message: Text,
    /** Stable across occurrences of the same failure, so repetition is visible. */
    signature: Id,
    retryable: z.boolean(),
  })
  .strict();
export type ErrorBody = z.infer<typeof ErrorBody>;

/** core → agent. Withdraw an in-flight task. */
export const CancelBody = z.object({ taskId: TaskId, reason: Text }).strict();
export type CancelBody = z.infer<typeof CancelBody>;

export const MESSAGE_BODIES = {
  TASK_ASSIGNMENT: TaskAssignmentBody,
  PROPOSAL: ProposalBody,
  FINDING: FindingBody,
  QUESTION: QuestionBody,
  EVIDENCE_SUBMISSION: EvidenceSubmissionBody,
  STATUS: StatusBody,
  RESULT: ResultBody,
  ERROR: ErrorBody,
  CANCEL: CancelBody,
} as const;

// -------------------------------------------------------------- envelope

/** The fields every envelope carries, whatever its body (SPEC-04 §3). */
const envelopeShape = {
  id: MessageId,
  schemaVersion: z.literal(PROTOCOL_VERSION),
  from: ActorRef,
  to: ActorRef,
  /** The cognitive cycle this belongs to, when it belongs to one. */
  cycleId: Id.nullable().default(null),
  /** The message this replies to. */
  correlationId: MessageId.nullable().default(null),
  /** The ledger event that caused it. */
  causationId: Id.nullable().default(null),
  issuedAt: Iso,
  expiresAt: Iso.nullable().default(null),
} as const;

const envelopeFor = <K extends keyof typeof MESSAGE_BODIES>(
  kind: K,
): z.ZodObject<{ kind: z.ZodLiteral<K>; body: (typeof MESSAGE_BODIES)[K] } & typeof envelopeShape, 'strict'> =>
  z.object({ ...envelopeShape, kind: z.literal(kind), body: MESSAGE_BODIES[kind] }).strict() as never;

export const ENVELOPE_SCHEMAS = {
  TASK_ASSIGNMENT: envelopeFor('TASK_ASSIGNMENT'),
  PROPOSAL: envelopeFor('PROPOSAL'),
  FINDING: envelopeFor('FINDING'),
  QUESTION: envelopeFor('QUESTION'),
  EVIDENCE_SUBMISSION: envelopeFor('EVIDENCE_SUBMISSION'),
  STATUS: envelopeFor('STATUS'),
  RESULT: envelopeFor('RESULT'),
  ERROR: envelopeFor('ERROR'),
  CANCEL: envelopeFor('CANCEL'),
} as const;

export const Envelope = z.discriminatedUnion('kind', [
  ENVELOPE_SCHEMAS.TASK_ASSIGNMENT,
  ENVELOPE_SCHEMAS.PROPOSAL,
  ENVELOPE_SCHEMAS.FINDING,
  ENVELOPE_SCHEMAS.QUESTION,
  ENVELOPE_SCHEMAS.EVIDENCE_SUBMISSION,
  ENVELOPE_SCHEMAS.STATUS,
  ENVELOPE_SCHEMAS.RESULT,
  ENVELOPE_SCHEMAS.ERROR,
  ENVELOPE_SCHEMAS.CANCEL,
]);
export type Envelope = z.infer<typeof Envelope>;

/** An envelope of one particular kind. */
export type EnvelopeOf<K extends keyof typeof MESSAGE_BODIES> = Extract<Envelope, { kind: K }>;

export type EnvelopeCheck =
  | { readonly ok: true; readonly envelope: Envelope }
  | { readonly ok: false; readonly kind: string | null; readonly issues: readonly string[] };

const issuesOf = (error: z.ZodError): string[] =>
  error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);

/**
 * The boundary. An envelope that does not pass is rejected and recorded; it
 * never reaches a handler (SPEC-04 §3.1).
 */
export function checkEnvelope(value: unknown): EnvelopeCheck {
  const named =
    typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
      ? (value as { kind: string }).kind
      : null;
  if (named === null) return { ok: false, kind: null, issues: ['kind: a message names its kind'] };
  if (!(MESSAGE_KINDS as readonly string[]).includes(named)) {
    return { ok: false, kind: named, issues: [`kind: ${named} is not a message kind`] };
  }
  const parsed = Envelope.safeParse(value);
  return parsed.success ? { ok: true, envelope: parsed.data } : { ok: false, kind: named, issues: issuesOf(parsed.error) };
}

/** Which direction a kind may travel. Enforced by the runtime, stated here. */
export const MESSAGE_DIRECTION = {
  TASK_ASSIGNMENT: 'CORE_TO_AGENT',
  CANCEL: 'CORE_TO_AGENT',
  PROPOSAL: 'AGENT_TO_CORE',
  FINDING: 'AGENT_TO_CORE',
  QUESTION: 'AGENT_TO_CORE',
  EVIDENCE_SUBMISSION: 'AGENT_TO_CORE',
  STATUS: 'AGENT_TO_CORE',
  RESULT: 'AGENT_TO_CORE',
  ERROR: 'AGENT_TO_CORE',
} as const satisfies Record<(typeof MESSAGE_KINDS)[number], 'CORE_TO_AGENT' | 'AGENT_TO_CORE'>;

/**
 * True when this envelope is something an agent is allowed to have sent.
 *
 * An agent that sends itself a task assignment has assigned itself work, which
 * is the first step of an agent that decides what it should be doing.
 */
export const isAgentOriginated = (envelope: Envelope): boolean =>
  MESSAGE_DIRECTION[envelope.kind] === 'AGENT_TO_CORE' && envelope.from.kind === 'AGENT';

/** The task every message belongs to. There is no message outside a task. */
export const taskOf = (envelope: Envelope): string => envelope.body.taskId;
