/**
 * One proposal, on its own merits (SPEC-04 §4.1, ADR-0018 §3).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). Extracted from the orchestrator so that the
 * orchestrator and the agent runtime share it rather than each having a path
 * from a proposal to canonical state. One door, two callers.
 *
 * The order of the checks is the order of SPEC-04's pipeline, and each is
 * refused for its own reason:
 *
 *   1. Shape — is it a proposal at all, of a kind a model may make?
 *   2. Permission — is it a kind THIS actor declared? An agent's manifest can
 *      narrow the core's set, never widen it (ADR-0020 §3).
 *   3. Goal contribution — does it serve a goal that exists and is active?
 *      Work that serves no goal is drift, and drift is refused, not recorded
 *      as a curiosity.
 *   4. The cognitive rules themselves, which are the deciders' to apply.
 *
 * Nothing here decides authority. A belief proposed by an agent is capped at
 * AI_ASSUMPTION by the belief rules, and the ledger refuses an authority above
 * the actor's ceiling. Adding a third place that clamps would be a third place
 * to get it wrong.
 */

import { checkContribution, type CognitiveEngine } from '@genesis/cognition';
import { CognitiveRuleViolationError, type EventActor, type ProjectScope } from '@genesis/core-types';
import type { ProposalEvaluated } from './events.js';
import { checkProposal, PROPOSAL_KINDS, toCommand } from './proposals.js';

/** Who is proposing, and what they are allowed to propose. */
export interface Proposer {
  readonly actor: EventActor;
  /**
   * The kinds this proposer may use. Undefined means the core's full set — the
   * orchestrator's own default, unchanged from P4. A proposer that declares a
   * narrower set is held to it.
   */
  readonly proposalKinds?: readonly string[];
}

/** The kinds any proposer is measured against. Nothing widens this. */
export const permittedProposalKinds = (proposer: Proposer): readonly string[] =>
  proposer.proposalKinds === undefined
    ? PROPOSAL_KINDS
    : PROPOSAL_KINDS.filter((kind) => proposer.proposalKinds?.includes(kind) === true);

export interface EvaluateOptions {
  readonly engine: CognitiveEngine;
  readonly scope: ProjectScope;
  readonly proposer: Proposer;
  /** The run this belongs to, or null for a proposal made outside one. */
  readonly cycleId: string | null;
  /** The reasoning call it came from, or null when no model was asked. */
  readonly callId: string | null;
  readonly index: number;
  readonly item: unknown;
}

/**
 * Evaluates one proposal and returns what happened. Rejects only when a store
 * itself fails: a refused proposal is an outcome, not an exception.
 */
export async function evaluateProposal(options: EvaluateOptions): Promise<ProposalEvaluated> {
  const { engine, scope, proposer, cycleId, callId, index, item } = options;
  const base = { callId, index, rule: null, eventSeqs: [] as number[] };

  const check = checkProposal(item);
  if (!check.ok) {
    return { ...base, kind: check.kind, outcome: 'REJECTED', reason: check.reason, detail: check.issues.join('; ') };
  }
  const { proposal } = check;

  const permitted = permittedProposalKinds(proposer);
  if (!permitted.includes(proposal.kind)) {
    return {
      ...base,
      kind: proposal.kind,
      outcome: 'REJECTED',
      reason: 'NOT_PERMITTED',
      detail: `${proposer.actor.id} did not declare ${proposal.kind}; it may propose ${permitted.join(', ') || 'nothing'}`,
    };
  }

  const { state } = await engine.state(scope);
  const drift = checkContribution(state, proposal.contributesTo);
  if (drift.drift) {
    const unknown = drift.unknownGoals.length === 0 ? '' : ` (unknown: ${drift.unknownGoals.join(', ')})`;
    return { ...base, kind: proposal.kind, outcome: 'REJECTED', reason: 'GOAL_DRIFT', detail: `${drift.reason}${unknown}` };
  }

  try {
    const { events } = await engine.execute(
      scope,
      proposer.actor,
      toCommand(proposal, callId),
      cycleId === null ? {} : { cycleId },
    );
    return { ...base, kind: proposal.kind, outcome: 'ACCEPTED', reason: null, detail: null, eventSeqs: events.map((e) => e.seq) };
  } catch (error) {
    if (!(error instanceof CognitiveRuleViolationError)) throw error;
    return {
      ...base,
      kind: proposal.kind,
      outcome: 'REJECTED',
      reason: 'RULE_VIOLATION',
      rule: error.rule,
      detail: error.message,
    };
  }
}
