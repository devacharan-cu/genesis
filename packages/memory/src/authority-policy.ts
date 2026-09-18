/**
 * Write-time authority policy (SPEC-02 §4.2, ADR-0011, ADR-0012).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is the function that stops an agent from
 * writing `authority: 'HUMAN_DECISION'` and having the store believe it. If it
 * is wrong, every downstream safety property — conflict resolution, context
 * ranking, policy checks — is reasoning over a value the agent chose for
 * itself, and nothing else in the system would notice.
 *
 * It is a PURE FUNCTION of its inputs, which is what allows its entire input
 * domain to be enumerated in tests rather than sampled.
 *
 * Nothing here reads a confidence score. That is the point of ADR-0005.
 */

import {
  ACTOR_AUTHORITY_CEILING,
  type ActorKind,
  AUTHORITY_LEVELS,
  type Authority,
  authorityRank,
  type MemoryId,
  outranks,
} from '@genesis/core-types';
import type { ClampReason, EntityRef, SourceRef } from './record.js';

export interface AuthorityDecisionInput {
  readonly requested: Authority;
  readonly actorKind: ActorKind;
  readonly sourceRefs: readonly SourceRef[];
  readonly evidenceRefs: readonly MemoryId[];
  readonly relatedEntities: readonly EntityRef[];
  /**
   * When the claim stops being current. Grounds `HISTORICAL`, which means
   * "previously true, now superseded or aged" — a specific claim, so it needs
   * a specific fact behind it (ADR-0012).
   */
  readonly validUntil?: string | null | undefined;
}

export interface AuthorityDecision {
  /** The authority the record will actually carry. Never above `requested`. */
  readonly authority: Authority;
  /** Why it was reduced. Empty when it was not. Ordered as applied. */
  readonly clamps: readonly ClampReason[];
}

const hasModelSource = (input: AuthorityDecisionInput): boolean =>
  input.sourceRefs.some((ref) => ref.kind === 'MODEL');

/**
 * What grounds each level — the ladder from ADR-0012.
 *
 * Returns `null` when the level is grounded, or the reason it is not.
 *
 * `HUMAN_DECISION` returns null unconditionally: the actor requirement is owned
 * by ceiling 1, which has already run. Re-checking it here would create a
 * branch that ceiling 1 makes unreachable.
 *
 * `UNGROUNDED` returns null unconditionally. That is what makes the step-down
 * below total — there is always somewhere truthful to land — and in turn what
 * makes the whole policy monotone.
 */
const GROUNDING: Record<Authority, (input: AuthorityDecisionInput) => ClampReason | null> = {
  HUMAN_DECISION: () => null,
  VERIFIED_SYSTEM_STATE: (input) => (input.evidenceRefs.length > 0 ? null : 'NO_EVIDENCE'),
  ACTIVE_REQUIREMENT: (input) =>
    input.relatedEntities.some((entity) => entity.nodeType === 'REQUIREMENT')
      ? null
      : 'NO_REQUIREMENT_LINK',
  EVIDENCE: (input) => (input.evidenceRefs.length > 0 ? null : 'NO_EVIDENCE'),
  HISTORICAL: (input) =>
    input.validUntil !== undefined && input.validUntil !== null ? null : 'NO_HISTORICAL_BOUND',
  AI_ASSUMPTION: (input) => (hasModelSource(input) ? null : 'NO_MODEL_SOURCE'),
  UNGROUNDED: () => null,
};

export function decideAuthority(input: AuthorityDecisionInput): AuthorityDecision {
  const clamps: ClampReason[] = [];
  let authority = input.requested;

  // Ceiling 1 — the actor. A SYSTEM probe cannot make a human's decision.
  const actorCeiling = ACTOR_AUTHORITY_CEILING[input.actorKind];
  if (outranks(authority, actorCeiling)) {
    authority = actorCeiling;
    clamps.push('ACTOR_CEILING');
  }

  // Ceiling 2 — model provenance. This is the one that makes the guarantee
  // absolute: an agent's own claim is model-sourced, so it lands here no matter
  // what it asked for and no matter which actor kind it presents as.
  //
  // Note it caps at AI_ASSUMPTION, not at the floor. AI_ASSUMPTION is grounded
  // BY that model source, so the ladder below leaves it there.
  if (hasModelSource(input) && outranks(authority, 'AI_ASSUMPTION')) {
    authority = 'AI_ASSUMPTION';
    clamps.push('MODEL_SOURCED');
  }

  // Ceiling 3 — the grounding ladder. Step down to the highest level at or
  // below the current one whose grounding is satisfied.
  //
  // `L -> max{ L' <= L : grounded(L') }` is monotone non-decreasing in L, and
  // the two ceilings above are min operations, which are also monotone.
  // Composing monotone functions gives a monotone policy: over-claiming can
  // never land a record lower than asking modestly would have (ADR-0012).
  // Iterating the slice rather than indexing avoids an `undefined` check that
  // the loop bounds already make impossible — a dead branch in a module that
  // requires 100% branch coverage is a sign the code is doing more than the
  // problem needs.
  for (const level of AUTHORITY_LEVELS.slice(authorityRank(authority) - 1)) {
    const reason = GROUNDING[level](input);
    if (reason === null) {
      authority = level;
      break;
    }
    // Each distinct unmet requirement is recorded once, so the record explains
    // every rung it fell past rather than only the last.
    if (!clamps.includes(reason)) clamps.push(reason);
  }

  return { authority, clamps };
}

/**
 * The invariant every caller may rely on: the policy never raises authority.
 *
 * Exported so the property tests can state it once and `buildRecord` can assert
 * it on every write. A policy bug that promoted a claim would be the single
 * worst failure in the knowledge layer, so it is checked rather than assumed.
 */
export function neverPromotes(requested: Authority, decided: Authority): boolean {
  return authorityRank(decided) >= authorityRank(requested);
}
