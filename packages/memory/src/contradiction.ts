/**
 * Contradiction resolution (SPEC-02 §5).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). The rule this enforces is that conflicting
 * claims are PRESERVED and marked, never merged and never deleted. A bug here
 * loses a claim silently, and losing a claim silently is indistinguishable from
 * never having been told it.
 *
 * Pure: it decides what should change, and the store applies it. Keeping the
 * decision separate from the writing is what lets both adapters share one
 * implementation of the rule rather than each reimplementing it.
 */

import { type Authority, type MemoryId, resolveConflict } from '@genesis/core-types';
import type { MemoryStatus } from './record.js';

export type ContradictionOutcome =
  /** One side has strictly higher authority and governs. */
  | 'GOVERNED_BY_AUTHORITY'
  /** Equal authority: neither wins, both stand, a question is owed. */
  | 'UNRESOLVED';

export interface StatusChange {
  readonly id: MemoryId;
  readonly status: MemoryStatus;
}

export interface ContradictionResolution {
  readonly outcome: ContradictionOutcome;
  /** The record that governs, when one does. Null when unresolved. */
  readonly governing: MemoryId | null;
  /** The record reduced to SUPERSEDED_BY_AUTHORITY, when there is one. */
  readonly superseded: MemoryId | null;
  /** Status changes the store must apply. May be empty. */
  readonly changes: readonly StatusChange[];
  /**
   * True when the conflict could not be settled by authority and therefore owes
   * an uncertainty and an issue (SPEC-02 §5 step 3, SPEC-01 §8).
   *
   * P1 records the obligation; the uncertainty engine that discharges it
   * arrives in P2. It is surfaced rather than silently dropped so that the gap
   * is visible in the type rather than only in a document.
   */
  readonly owesUncertainty: boolean;
}

export interface ContradictionSide {
  readonly id: MemoryId;
  readonly authority: Authority;
  readonly status: MemoryStatus;
}

/**
 * Decides what a CONTRADICTS link between `a` and `b` does to their statuses.
 *
 * Deletion is not among the possible outcomes, by construction: the return type
 * can only express status changes.
 */
export function resolveContradiction(
  a: ContradictionSide,
  b: ContradictionSide,
): ContradictionResolution {
  const governingAuthority = resolveConflict(a.authority, b.authority);

  if (governingAuthority === null) {
    // Equal authority. Neither side is demoted — both are marked so that the
    // disagreement is visible, and CONTRADICTED stays visible to default
    // queries (SPEC-02 §7).
    return {
      outcome: 'UNRESOLVED',
      governing: null,
      superseded: null,
      changes: [
        { id: a.id, status: 'CONTRADICTED' },
        { id: b.id, status: 'CONTRADICTED' },
      ],
      owesUncertainty: true,
    };
  }

  const governing = a.authority === governingAuthority ? a : b;
  const loser = governing === a ? b : a;

  return {
    outcome: 'GOVERNED_BY_AUTHORITY',
    governing: governing.id,
    superseded: loser.id,
    // Only the losing side changes. The governing record keeps its status —
    // being contradicted by something less authoritative is not a reason to
    // mark it, or a low-authority claim could taint a human decision.
    changes: [{ id: loser.id, status: 'SUPERSEDED_BY_AUTHORITY' }],
    owesUncertainty: false,
  };
}

/** What a SUPERSEDES link does: the superseded record is marked, never removed. */
export function resolveSupersedes(
  superseding: ContradictionSide,
  superseded: ContradictionSide,
): ContradictionResolution {
  return {
    outcome: 'GOVERNED_BY_AUTHORITY',
    governing: superseding.id,
    superseded: superseded.id,
    changes: [{ id: superseded.id, status: 'SUPERSEDED' }],
    owesUncertainty: false,
  };
}
