/**
 * What an agent is, what it is handed, and what it may hand back
 * (SPEC-04 §1, ADR-0020 §1-2).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is the shape of the boundary. If an
 * agent can be handed something that writes, or can return something the core
 * applies without checking, every guarantee downstream is decoration.
 *
 * Four things are true here by construction:
 *
 *   1. **An agent is handed no handle onto anything.** `AgentServices` carries
 *      a clock, an id source, a cancellation signal, and a read of what its run
 *      came to. No store, no ledger, no engine, no provider. This package
 *      cannot even import one — ADR-0001's dependency table forbids it, and
 *      `check-boundaries.mjs` enforces that on every run.
 *   2. **An agent holds no model.** It frames work and reads a summary; the
 *      core makes the call. No model-specific behaviour can live in an agent
 *      because an agent has nothing to call (ADR-0020 §2).
 *   3. **An agent returns messages, not effects.** An outcome is a list of
 *      envelopes the runtime will check and record. Returning a proposal is
 *      asking; nothing here applies anything.
 *   4. **An agent cannot report someone else's task.** Every message it emits
 *      is checked against the task it was assigned, so a confused or
 *      misbehaving agent cannot write into a task it was not given.
 */

import type { AgentTaskState, MessageId } from '@genesis/core-types';
import {
  AGENT_FAILURE_KINDS,
  type AgentFailureKind,
  type AgentManifest,
  type Envelope,
  isAgentOriginated,
  type RunSummary,
  type TaskAssignmentBody,
  type TaskFraming,
  taskOf,
} from '@genesis/protocol';

/**
 * Everything an agent may reach. Deliberately tiny, and deliberately without a
 * single thing that can change canonical state or reach a model.
 */
export interface AgentServices {
  /**
   * What the core's run came to, or null when the agent framed no run. A
   * deterministic agent always sees null, and an agent whose framing was
   * refused sees a summary that says so rather than nothing.
   */
  readonly run: RunSummary | null;
  /** Injected, so an agent's output does not depend on when it ran. */
  readonly now: () => string;
  /** Minted by the runtime, so ids in a replay match ids in the original run. */
  readonly newMessageId: () => MessageId;
  /**
   * Cancellation. An agent that ignores it is stopped by the runtime's deadline
   * instead; honouring it is how a cancel is fast rather than merely eventual.
   */
  readonly signal: AbortSignal;
}

/** What an agent hands back: messages, and where it thinks the task now stands. */
export interface AgentOutcome {
  /**
   * The messages the agent emits, in order. Each is checked and recorded by the
   * runtime before it has any effect.
   */
  readonly messages: readonly Envelope[];
  /**
   * What the agent believes the task reached. Advisory: the runtime decides,
   * the same way the core decides a proposal's authority.
   */
  readonly reached: Extract<AgentTaskState, 'COMPLETED' | 'BLOCKED' | 'AWAITING_VERIFICATION'>;
}

/**
 * The whole contract. Two methods: one pure, one not.
 *
 * `frame` is where a role differs from every other role, and it is pure so that
 * what a role asks for can be tested without a model, a ledger or a clock.
 * Returning null means "this role needs no model for this task", which is a
 * real answer and not a degenerate one.
 */
export interface Agent {
  readonly manifest: AgentManifest;
  frame(assignment: TaskAssignmentBody): TaskFraming | null;
  /**
   * Turn the assignment and what came back into messages. Resolves with an
   * outcome, or rejects — a rejection is a failure the runtime types and
   * records; it is not a way to signal anything.
   */
  handle(assignment: TaskAssignmentBody, services: AgentServices): Promise<AgentOutcome>;
}

/** A failure raised by an agent itself, carrying the kind the runtime will record. */
export class AgentError extends Error {
  constructor(
    readonly kind: AgentFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

/**
 * The failure kind for anything thrown that did not say what it was.
 *
 * An agent that throws a bare `TypeError` has failed in a way nobody
 * classified, and guessing a friendlier kind would hide that.
 */
export const failureKindOf = (thrown: unknown): AgentFailureKind =>
  thrown instanceof AgentError ? thrown.kind : 'AGENT_THREW';

/**
 * A signature stable across occurrences of the same failure, so the self model
 * can see that one keeps happening (SPEC-01 §4). It names the role, the task
 * kind and the failure kind, never the message: messages carry ids and timings,
 * and a signature that changes every time groups nothing.
 */
export const failureSignature = (role: string, taskKind: string, kind: AgentFailureKind): string =>
  `agent:${role}:${taskKind}:${kind}`;

export type OutcomeCheck =
  | { readonly ok: true; readonly outcome: AgentOutcome }
  | { readonly ok: false; readonly kind: AgentFailureKind; readonly reason: string };

/**
 * Checks an outcome before the runtime acts on any of it.
 *
 * Nothing here trusts the static type: an agent is the component most likely to
 * be wrong, and `handle` returning `AgentOutcome` is a claim by whoever wrote
 * the agent, not a fact.
 */
export function checkOutcome(assignment: TaskAssignmentBody, outcome: unknown, maxMessages: number): OutcomeCheck {
  if (typeof outcome !== 'object' || outcome === null) {
    return { ok: false, kind: 'MALFORMED_OUTPUT', reason: 'the agent returned no outcome' };
  }
  const { messages, reached } = outcome as { messages?: unknown; reached?: unknown };
  if (!Array.isArray(messages)) {
    return { ok: false, kind: 'MALFORMED_OUTPUT', reason: 'the outcome carries no list of messages' };
  }
  if (messages.length > maxMessages) {
    return {
      ok: false,
      kind: 'MALFORMED_OUTPUT',
      reason: `the agent emitted ${messages.length} messages, over the limit of ${maxMessages}`,
    };
  }
  if (reached !== 'COMPLETED' && reached !== 'BLOCKED' && reached !== 'AWAITING_VERIFICATION') {
    return { ok: false, kind: 'MALFORMED_OUTPUT', reason: `an agent cannot report reaching ${String(reached)}` };
  }
  for (const [index, message] of messages.entries()) {
    const envelope = message as Envelope;
    if (!isAgentOriginated(envelope)) {
      return {
        ok: false,
        kind: 'CAPABILITY_REFUSED',
        reason: `message ${index} is ${String(envelope.kind)} from ${String(envelope.from.kind)}, which an agent may not send`,
      };
    }
    if (taskOf(envelope) !== assignment.taskId) {
      return {
        ok: false,
        kind: 'CAPABILITY_REFUSED',
        reason: `message ${index} reports on task ${taskOf(envelope)}, which was not assigned to this agent`,
      };
    }
  }
  return { ok: true, outcome: { messages: messages as readonly Envelope[], reached } };
}

/** Exported for the conformance suite, which asserts every kind is handled. */
export const AGENT_FAILURES: readonly AgentFailureKind[] = AGENT_FAILURE_KINDS;

/** What the manifest declares, restated for a role that is checking its own limits. */
export const declaredProposalKinds = (manifest: AgentManifest): readonly string[] => manifest.proposalKinds;
