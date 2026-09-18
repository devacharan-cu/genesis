/**
 * Write-time authority policy (SPEC-02 §4.2, ADR-0011).
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
  type Authority,
  authorityRank,
  outranks,
} from '@genesis/core-types';
import type { MemoryId } from '@genesis/core-types';
import type { ClampReason, EntityRef, SourceRef } from './record.js';

export interface AuthorityDecisionInput {
  readonly requested: Authority;
  readonly actorKind: ActorKind;
  readonly sourceRefs: readonly SourceRef[];
  readonly evidenceRefs: readonly MemoryId[];
  readonly relatedEntities: readonly EntityRef[];
}

export interface AuthorityDecision {
  /** The authority the record will actually carry. Never above `requested`. */
  readonly authority: Authority;
  /** Why it was reduced. Empty when it was not. Ordered as applied. */
  readonly clamps: readonly ClampReason[];
}

/**
 * The floor for a claim that nothing supports.
 *
 * Named `AI_ASSUMPTION` because that is the level the brief defines, though for
 * an ungrounded claim by a human the name does not describe what happened. That
 * mismatch is open decision E11, recorded rather than worked around by
 * inventing a level (ADR-0011).
 */
const UNGROUNDED_FLOOR: Authority = 'AI_ASSUMPTION';

/** Authorities that require supporting evidence to be claimed at write time. */
const REQUIRES_EVIDENCE: readonly Authority[] = ['EVIDENCE', 'VERIFIED_SYSTEM_STATE'];

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
  const modelSourced = input.sourceRefs.some((ref) => ref.kind === 'MODEL');
  if (modelSourced && outranks(authority, UNGROUNDED_FLOOR)) {
    authority = UNGROUNDED_FLOOR;
    clamps.push('MODEL_SOURCED');
  }

  // Ceiling 3 — grounding. Applied to what survived the ceilings above, so a
  // claim already reduced to AI_ASSUMPTION is not re-examined.
  if (REQUIRES_EVIDENCE.includes(authority) && input.evidenceRefs.length === 0) {
    authority = UNGROUNDED_FLOOR;
    clamps.push('NO_EVIDENCE');
  } else if (
    authority === 'ACTIVE_REQUIREMENT' &&
    !input.relatedEntities.some((entity) => entity.nodeType === 'REQUIREMENT')
  ) {
    authority = UNGROUNDED_FLOOR;
    clamps.push('NO_REQUIREMENT_LINK');
  }

  return { authority, clamps };
}

/**
 * The invariant every caller may rely on: the policy never raises authority.
 *
 * Exported so the property tests can state it once and the store can assert it
 * in development. A policy bug that promoted a claim would be the single worst
 * failure in the knowledge layer, so it is checked rather than assumed.
 */
export function neverPromotes(requested: Authority, decided: Authority): boolean {
  return authorityRank(decided) >= authorityRank(requested);
}
