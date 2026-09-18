/**
 * Authority ordering and ceilings (ADR-0005).
 *
 * SAFETY-CRITICAL (SPEC-00 section 8.1). This is the module that stops a fluent
 * AI assumption from outranking a human's stated requirement. If it is wrong,
 * the knowledge layer's central safety property is gone and nothing else
 * notices.
 *
 * Authority is a property of a claim's SOURCE AND GROUNDING, never of how
 * certain its producer sounded. Nothing here reads a confidence score, by
 * design.
 */

import { type ActorKind } from './actor.js';
import { AUTHORITY_LEVELS, type Authority } from './enums.js';
import { AuthorityNotPermittedError } from './errors.js';

/**
 * Rank 1 is the highest authority. Lower number wins.
 *
 * Derived from the array order rather than hard-coded, so the canonical-enum
 * drift test also protects the ranking: reordering the spec reorders this.
 */
export function authorityRank(authority: Authority): number {
  return AUTHORITY_LEVELS.indexOf(authority) + 1;
}

/** Negative when `a` outranks `b`, positive when `b` outranks `a`, zero when equal. */
export function compareAuthority(a: Authority, b: Authority): number {
  return authorityRank(a) - authorityRank(b);
}

/** True when `a` is strictly more authoritative than `b`. */
export function outranks(a: Authority, b: Authority): boolean {
  return authorityRank(a) < authorityRank(b);
}

/**
 * Resolves a conflict between two claims.
 *
 * Returns the governing authority, or `null` when neither outranks the other.
 * `null` is not a failure — it is the case that must NOT be broken by a
 * tiebreak. Equal authority means the contradiction stays open and a question
 * is raised (SPEC-01 section 8, ADR-0005 rule 5).
 */
export function resolveConflict(a: Authority, b: Authority): Authority | null {
  if (a === b) return null;
  return outranks(a, b) ? a : b;
}

/**
 * The highest authority an actor of each kind may assert directly.
 *
 * - HUMAN: a human decision is the top of the hierarchy by definition.
 * - SYSTEM: may report observed state of the real running system, which is what
 *   VERIFIED_SYSTEM_STATE means. It cannot make a human's decision.
 * - AGENT: may carry evidence it collected, but may not declare a requirement
 *   in force, assert verified system state, or make a decision. An agent
 *   reaching for a higher level is the exact failure ADR-0005 exists to stop.
 */
export const ACTOR_AUTHORITY_CEILING = {
  HUMAN: 'HUMAN_DECISION',
  SYSTEM: 'VERIFIED_SYSTEM_STATE',
  AGENT: 'EVIDENCE',
} as const satisfies Record<ActorKind, Authority>;

/** True when an actor of this kind may assert this authority. */
export function isAuthorityPermitted(actorKind: ActorKind, authority: Authority): boolean {
  return authorityRank(authority) >= authorityRank(ACTOR_AUTHORITY_CEILING[actorKind]);
}

/**
 * Reduces an authority to the actor's ceiling.
 *
 * Used where the architecture calls for *clamping* — a proposal's advisory
 * `authorityClaim`, for instance (ADR-0006 section 4.2), where the caller is
 * making a suggestion rather than a statement.
 */
export function clampAuthority(actorKind: ActorKind, requested: Authority): Authority {
  const ceiling = ACTOR_AUTHORITY_CEILING[actorKind];
  return outranks(requested, ceiling) ? ceiling : requested;
}

/**
 * Rejects an authority the actor may not assert.
 *
 * Used at the ledger boundary, where clamping would be wrong: an event is an
 * immutable statement of what happened, so silently recording a different
 * authority than the caller asked for would make the ledger disagree with the
 * caller's intent, and nobody would know. Failing loudly is the honest option.
 */
export function assertAuthorityPermitted(actorKind: ActorKind, authority: Authority): void {
  if (!isAuthorityPermitted(actorKind, authority)) {
    throw new AuthorityNotPermittedError(
      `an actor of kind ${actorKind} may not assert authority ${authority}; its ceiling is ${ACTOR_AUTHORITY_CEILING[actorKind]}`,
      { actorKind, authority, ceiling: ACTOR_AUTHORITY_CEILING[actorKind] },
    );
  }
}
