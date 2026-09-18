/**
 * The ProjectionSnapshotStore port (ADR-0003, ADR-0013 rule 5).
 *
 * Note what this port HAS that the ledger deliberately does not: `drop`. The
 * asymmetry is the point. A snapshot holds nothing that is not rederivable
 * from the ledger, so deleting one costs time, never truth. A ledger event is
 * the truth, so there is no method to delete it.
 *
 * Snapshots are keyed by (projectId, projection, version). A projector that
 * changes meaning bumps its version, and its old snapshots are then simply not
 * found — the projection rebuilds from the ledger instead of being fed a state
 * that new logic never would have produced.
 */

import {
  assertInScope,
  type JsonValue,
  type ProjectId,
  ProjectionDivergenceError,
  type ProjectScope,
  type Sha256Hex,
  SequenceConflictError,
} from '@genesis/core-types';
import { assertProjectorMatches } from './apply.js';
import { assertJsonState, projectionDigest } from './digest.js';
import { type ProjectionState, type Projector } from './projector.js';

export interface ProjectionSnapshot {
  readonly projectId: ProjectId;
  readonly projection: string;
  readonly version: number;
  /** The last ledger sequence folded into `state`. 0 means "nothing yet". */
  readonly lastSeq: number;
  readonly state: JsonValue;
  /** `projectionDigest` of the state above, recorded at write time. */
  readonly digest: Sha256Hex;
  readonly updatedAt: string;
}

export interface ProjectionSnapshotStore {
  /** The stored snapshot for this projection, or null when there is none. */
  load(scope: ProjectScope, projection: string, version: number): Promise<ProjectionSnapshot | null>;

  /**
   * Writes a snapshot, enforcing the two rules in `checkSnapshotWrite`.
   *
   * Idempotent for an unchanged projection: saving the same state at the same
   * sequence twice is accepted and stores the same digest.
   */
  save(scope: ProjectScope, projection: ProjectionState<JsonValue>): Promise<ProjectionSnapshot>;

  /** Every snapshot for the scoped project, ordered by projection then version. */
  list(scope: ProjectScope): Promise<ProjectionSnapshot[]>;

  /** Discards a snapshot. Returns false when there was nothing to discard. */
  drop(scope: ProjectScope, projection: string, version: number): Promise<boolean>;

  close(): Promise<void>;
}

/**
 * The write rules, defined once so both adapters enforce the same thing.
 *
 * A second implementation of this in SQL would eventually drift, and the drift
 * would show up as one backend accepting a regression the other refused.
 *
 *   1. A snapshot may not move BACKWARDS. A half-built projection overwriting a
 *      complete one is not data loss — it is all rederivable — but it silently
 *      undoes work, and the next reader has no way to tell.
 *   2. Two different states at the SAME sequence is non-determinism, caught in
 *      the act. Identical history must fold to an identical state; if it does
 *      not, the projector depends on something outside the ledger.
 */
export function checkSnapshotWrite(
  stored: ProjectionSnapshot | null,
  incoming: ProjectionState<JsonValue>,
  incomingDigest: Sha256Hex,
): void {
  if (stored === null) return;

  if (incoming.lastSeq < stored.lastSeq) {
    throw new SequenceConflictError(
      `snapshot for ${incoming.projection} would move backwards from seq ${stored.lastSeq} to ${incoming.lastSeq}`,
      {
        projection: incoming.projection,
        projectId: incoming.projectId,
        storedSeq: stored.lastSeq,
        incomingSeq: incoming.lastSeq,
      },
    );
  }

  if (incoming.lastSeq === stored.lastSeq && incomingDigest !== stored.digest) {
    throw new ProjectionDivergenceError({
      projection: incoming.projection,
      projectId: incoming.projectId,
      lastSeq: incoming.lastSeq,
      stored: stored.digest,
      incoming: incomingDigest,
    });
  }
}

/** Builds the stored form. Adapters share this, so the digest is never omitted. */
export function toSnapshot(
  projection: ProjectionState<JsonValue>,
  updatedAt: string,
): ProjectionSnapshot {
  return {
    projectId: projection.projectId,
    projection: projection.projection,
    version: projection.version,
    lastSeq: projection.lastSeq,
    state: assertJsonState(projection.state, `projection ${projection.projection} state`),
    digest: projectionDigest(projection),
    updatedAt,
  };
}

/**
 * Turns a stored snapshot back into a projection, checking it on the way.
 *
 * Three checks, because a snapshot is bytes out of storage and the alternative
 * is trusting them:
 *   - it belongs to the scoped project (ADR-0008)
 *   - it was written by this projector at this version
 *   - it parses as a state of this projection, and still hashes to the digest
 *     recorded beside it
 */
export function restoreProjection<S extends JsonValue>(
  scope: ProjectScope,
  projector: Projector<S>,
  snapshot: ProjectionSnapshot,
): ProjectionState<S> {
  assertInScope(scope, snapshot.projectId, `snapshot of ${snapshot.projection}`);
  assertProjectorMatches(projector, snapshot, `snapshot of ${snapshot.projection}`);

  const restored: ProjectionState<S> = {
    projectId: snapshot.projectId,
    projection: snapshot.projection,
    version: snapshot.version,
    lastSeq: snapshot.lastSeq,
    state: projector.parse(snapshot.state),
  };

  const digest = projectionDigest(restored);
  if (digest !== snapshot.digest) {
    throw new ProjectionDivergenceError({
      projection: snapshot.projection,
      projectId: snapshot.projectId,
      lastSeq: snapshot.lastSeq,
      stored: snapshot.digest,
      incoming: digest,
    });
  }
  return restored;
}
