/**
 * The behaviour every agent shares, so that a role is a small difference from a
 * common shape rather than a copy of one (SPEC-04 §2).
 *
 * What is shared: emitting a well-formed envelope, honouring cancellation,
 * turning a run summary into the messages that summary justifies, and deciding
 * what state the task reached. What a role supplies is `frame` — what to ask
 * the core to run — and, optionally, extra messages of its own.
 *
 * The reading of a run summary is deliberately conservative and shared rather
 * than per-role:
 *
 *   - A refused proposal becomes a FINDING, not a retry. An agent that could
 *     decide for itself to try again would be an agent choosing its own
 *     workload.
 *   - A run that produced nothing completes with a result that says so. It does
 *     not fail — nothing broke — and it does not claim success.
 *   - A run that failed, or whose context would not fit, leaves the task
 *     BLOCKED with a finding naming why. Only the runtime fails a task.
 */

import type { AgentRole, TaskId } from '@genesis/core-types';
import {
  acceptedCount,
  type AgentManifest,
  type Envelope,
  type EnvelopeOf,
  type FindingBody,
  type MESSAGE_DIRECTION,
  producedNothing,
  type RunSummary,
  type TaskAssignmentBody,
  type TaskFraming,
} from '@genesis/protocol';
import { type Agent, AgentError, type AgentOutcome, type AgentServices } from './contract.js';

/** The recipient of everything an agent sends. Agents do not talk to each other (SPEC-04 §3.2). */
export const CORE_ACTOR = { kind: 'SYSTEM', id: 'agent-runtime' } as const;

/**
 * The kinds a role may emit. The core-to-agent kinds — a task assignment, a
 * cancellation — are absent by construction, so an agent cannot assign itself
 * work or withdraw its own task.
 */
export type EmittableKind = 'PROPOSAL' | 'FINDING' | 'QUESTION' | 'EVIDENCE_SUBMISSION' | 'STATUS' | 'RESULT';

/**
 * Builds one envelope. Given to roles rather than letting them construct their
 * own, so the header — who sent it, when, in which cycle — is filled the same
 * way everywhere and cannot be spoofed by a role naming a different sender.
 */
export type Emit = <K extends EmittableKind>(kind: K, body: EnvelopeOf<K>['body']) => EnvelopeOf<K>;

export abstract class BaseAgent implements Agent {
  constructor(readonly manifest: AgentManifest) {}

  abstract frame(assignment: TaskAssignmentBody): TaskFraming | null;

  /**
   * A role may add messages of its own — a Researcher's finding, a Verifier's
   * concern. It receives the same `emit` the shared path uses, so a role cannot
   * put a different sender on a message.
   */
  protected extraMessages(
    _assignment: TaskAssignmentBody,
    _services: AgentServices,
    _emit: Emit,
  ): readonly Envelope[] {
    return [];
  }

  async handle(assignment: TaskAssignmentBody, services: AgentServices): Promise<AgentOutcome> {
    // Checked before any work and again before reporting: a cancelled task must
    // not come back with a result nobody wants.
    this.#checkCancelled(services);

    const header = {
      schemaVersion: '1',
      from: { kind: 'AGENT', id: this.manifest.id, role: this.manifest.role },
      to: CORE_ACTOR,
      cycleId: services.run?.cycleId ?? null,
      correlationId: null,
      causationId: null,
      expiresAt: null,
    } as const;

    // The one assertion in this file: TypeScript cannot see that pairing a
    // narrowed `kind` with its own body picks one arm of the union. The pairing
    // is what `Emit`'s signature guarantees, and the envelope is re-checked by
    // the runtime before it has any effect.
    const emit = (<K extends EmittableKind>(kind: K, body: EnvelopeOf<K>['body']): EnvelopeOf<K> =>
      ({ ...header, id: services.newMessageId(), issuedAt: services.now(), kind, body }) as EnvelopeOf<K>) as Emit;

    const messages: Envelope[] = [];
    const { run } = services;

    let reached: AgentOutcome['reached'] = 'COMPLETED';
    let accepted = 0;

    if (run !== null) {
      accepted = acceptedCount(run);
      for (const finding of readRun(run, this.manifest.role, assignment.taskId)) {
        messages.push(emit('FINDING', finding));
      }
      if (run.outcome !== 'COMPLETED') reached = 'BLOCKED';
    }

    messages.push(...this.extraMessages(assignment, services, emit));
    this.#checkCancelled(services);

    messages.push(
      emit('RESULT', {
        taskId: assignment.taskId,
        summary: summarise(this.manifest.role, run, accepted),
        proposalsSubmitted: accepted,
        findingsRaised: messages.filter((m) => m.kind === 'FINDING').length,
        questionsRaised: messages.filter((m) => m.kind === 'QUESTION').length,
      }),
    );

    return { messages, reached: this.#reachedFrom(messages, reached) };
  }

  /** A role that only added questions has not completed; it is waiting on answers. */
  #reachedFrom(messages: readonly Envelope[], reached: AgentOutcome['reached']): AgentOutcome['reached'] {
    if (reached !== 'COMPLETED') return reached;
    if (messages.some((m) => m.kind === 'QUESTION')) return 'BLOCKED';
    if (messages.some((m) => m.kind === 'EVIDENCE_SUBMISSION')) return 'AWAITING_VERIFICATION';
    return 'COMPLETED';
  }

  #checkCancelled(services: AgentServices): void {
    if (services.signal.aborted) {
      throw new AgentError('CANCELLED', `${this.manifest.role} stopped: the task was cancelled`);
    }
  }
}

/**
 * What a run summary justifies saying, shared by every role.
 *
 * A rejected proposal is reported as a finding against the agent's own work,
 * which is how the self model learns an agent's limitations (SPEC-04 §4.1).
 */
export function readRun(run: RunSummary, role: AgentRole, taskId: TaskId): readonly FindingBody[] {
  const findings: FindingBody[] = [];

  if (run.outcome === 'SPLIT_REQUIRED') {
    findings.push({
      taskId,
      subject: 'the task is too large for its context budget',
      detail: `mandatory context needed ${run.context.usedTokens} tokens against a budget of ${run.context.budgetTokens}; the task must be split before ${role} can work on it`,
      risk: 'MEDIUM',
      contextRefs: [],
    });
  }
  if (run.failure !== null) {
    findings.push({
      taskId,
      subject: `the reasoning call did not produce usable output (${run.failure.kind})`,
      detail: run.failure.message,
      risk: 'MEDIUM',
      contextRefs: [],
    });
  }
  const refused = run.proposals.filter((p) => !p.accepted);
  for (const proposal of refused) {
    findings.push({
      taskId,
      subject: `a ${proposal.kind ?? 'malformed'} proposal was refused (${proposal.reason ?? 'no reason given'})`,
      detail: proposal.detail ?? 'the core refused this proposal and recorded why',
      risk: proposal.reason === 'GOAL_DRIFT' ? 'HIGH' : 'LOW',
      contextRefs: run.context.shown.map((c) => c.id),
    });
  }
  return findings;
}

/** One sentence about what the run came to. Never optimistic about nothing. */
export function summarise(role: AgentRole, run: RunSummary | null, accepted: number): string {
  if (run === null) return `${role} completed without a reasoning call`;
  if (run.outcome === 'SPLIT_REQUIRED') return `${role} could not start: the mandatory context does not fit`;
  if (run.outcome === 'FAILED') return `${role} could not finish: ${run.failure?.kind ?? 'the run failed'}`;
  if (producedNothing(run)) {
    return run.proposals.length === 0
      ? `${role} found nothing worth proposing`
      : `${role} proposed ${run.proposals.length}, and the core accepted none`;
  }
  return `${role} had ${accepted} of ${run.proposals.length} proposals accepted`;
}

/** Sanity check used by the conformance suite: every kind a base agent emits is agent-to-core. */
export const BASE_EMITTED_KINDS = ['FINDING', 'RESULT'] as const satisfies readonly (keyof typeof MESSAGE_DIRECTION)[];
