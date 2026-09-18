/**
 * The projector contract (ADR-0013).
 *
 * A projection is a pure fold over the event ledger:
 *
 *     state_0 = initial()
 *     state_n = apply(state_{n-1}, event_n)
 *
 * Two constraints carry the weight, and both are enforced by the type system
 * rather than by review:
 *
 *   1. `S extends JsonValue`. The state cannot be a class instance, a `Map`, a
 *      `Date` or a closure. It is plain JSON, so it serialises canonically, so
 *      a snapshot of it is COMPLETE. "No hidden state" stops being a promise
 *      and becomes something the compiler checks.
 *
 *   2. `initial()` is a function, not a constant. Two projections built from
 *      one projector cannot end up sharing — and then mutating — one object.
 *
 * `apply` must not mutate its `state` argument. That one cannot be expressed in
 * the type system (`readonly` is shallow and erased at runtime), so the
 * conformance suite deep-freezes the input state before every call and fails
 * loudly if a projector writes through it.
 */

import {
  type GenesisEvent,
  type JsonValue,
  type ProjectId,
  type ProjectScope,
} from '@genesis/core-types';
import { type ObservationLog } from './observations.js';

export interface Projector<S extends JsonValue> {
  /** Stable identifier, stored with snapshots. Changing it orphans them. */
  readonly name: string;
  /**
   * Bumped whenever `apply` changes meaning. Snapshots are keyed by
   * (projection, version), so an old snapshot is never fed to new logic — it
   * is simply not found, and the projection rebuilds from the ledger.
   */
  readonly version: number;
  /** A fresh empty state. Called once per projection, never shared. */
  initial(): S;
  /** Pure. Must not mutate `state`. */
  apply(state: S, event: GenesisEvent): S;
  /**
   * Validates a state that came back from storage.
   *
   * Required rather than optional: the alternative is casting an arbitrary
   * `JsonValue` from a snapshot straight into `S`, which trusts bytes that a
   * previous version of the code — or something else entirely — wrote.
   *
   * Throws `ValidationError` when the value is not a state of this projection.
   */
  parse(state: unknown): S;
  /**
   * What this projection did not understand (ADR-0013 rule 4).
   *
   * Part of the contract, not a convention, because the alternative is a
   * projector that meets an event it cannot interpret, carries on, and leaves a
   * state that looks complete and is not. Requiring the accessor means every
   * projection can be asked how much of the ledger it actually covered, and the
   * conformance suite can check that the answer is maintained.
   */
  observationsOf(state: S): ObservationLog;
}

/**
 * A projection: the folded state plus exactly enough bookkeeping to know where
 * in history it is.
 *
 * `lastSeq` is 0 for an empty projection, because ledger sequences start at 1
 * (ADR-0009). It is the only thing besides `state` that a rebuild needs, which
 * is why a snapshot is that pair and nothing more.
 */
export interface ProjectionState<S extends JsonValue> {
  readonly projectId: ProjectId;
  readonly projection: string;
  readonly version: number;
  readonly lastSeq: number;
  readonly state: S;
}

/** A projection positioned before the first event. */
export function emptyProjection<S extends JsonValue>(
  projector: Projector<S>,
  scope: ProjectScope,
): ProjectionState<S> {
  return {
    projectId: scope.projectId,
    projection: projector.name,
    version: projector.version,
    lastSeq: 0,
    state: projector.initial(),
  };
}
