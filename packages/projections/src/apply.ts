/**
 * The projection runner (ADR-0013 rule 2).
 *
 * SAFETY-CRITICAL (SPEC-00 section 8.1). Ordering, idempotency and project
 * scope are enforced HERE, once, so that no projector has to remember them and
 * none can get them subtly different from another.
 *
 *   foreign projectId      -> ScopeMismatchError   (ADR-0008)
 *   seq <= lastSeq         -> no-op, same state    (at-least-once delivery)
 *   seq >  lastSeq + 1     -> SequenceConflictError (a gap means skipped state)
 *   seq == lastSeq + 1     -> applied
 *
 * The asymmetry between a duplicate and a gap is deliberate. A duplicate is
 * normal on any retry path and rejecting it would make correct callers handle
 * an error that means nothing. A gap means events were skipped, so everything
 * after it is computed from a state that never existed — and since the ledger
 * is gapless per project (ADR-0009), a gap can only be a bug or a partial read.
 * Absorbing it would produce a plausible-looking wrong answer.
 */

import {
  assertInScope,
  type GenesisEvent,
  type JsonValue,
  type ProjectScope,
  projectScope,
  SequenceConflictError,
  ValidationError,
} from '@genesis/core-types';
import type { EventLedger, ReplayOptions, ReplaySummary } from '@genesis/ledger';
import { emptyProjection, type ProjectionState, type Projector } from './projector.js';

/** Fails when a projection was built by a different projector or version. */
export function assertProjectorMatches<S extends JsonValue>(
  projector: Projector<S>,
  projection: Pick<ProjectionState<S>, 'projection' | 'version'>,
  subject: string,
): void {
  if (projection.projection !== projector.name || projection.version !== projector.version) {
    throw new ValidationError(`${subject} was built by a different projection`, {
      expected: `${projector.name}@${projector.version}`,
      actual: `${projection.projection}@${projection.version}`,
    });
  }
}

/**
 * Folds one event in.
 *
 * Returns the SAME projection object when the event has already been applied,
 * so a caller can cheaply detect a no-op by identity if it cares to.
 */
export function applyEvent<S extends JsonValue>(
  projector: Projector<S>,
  current: ProjectionState<S>,
  event: GenesisEvent,
): ProjectionState<S> {
  assertInScope(
    { projectId: current.projectId },
    event.projectId,
    `event ${event.id} (seq ${event.seq})`,
  );

  if (event.seq <= current.lastSeq) return current;

  if (event.seq > current.lastSeq + 1) {
    throw new SequenceConflictError(
      `projection ${current.projection} is at seq ${current.lastSeq} and cannot skip to ${event.seq}`,
      {
        projection: current.projection,
        projectId: current.projectId,
        lastSeq: current.lastSeq,
        eventSeq: event.seq,
        eventId: event.id,
      },
    );
  }

  return {
    projectId: current.projectId,
    projection: current.projection,
    version: current.version,
    lastSeq: event.seq,
    state: projector.apply(current.state, event),
  };
}

/** Folds a batch in, in the order given. */
export function applyEvents<S extends JsonValue>(
  projector: Projector<S>,
  current: ProjectionState<S>,
  events: Iterable<GenesisEvent>,
): ProjectionState<S> {
  let acc = current;
  for (const event of events) acc = applyEvent(projector, acc, event);
  return acc;
}

export interface ReplayResult<S extends JsonValue> {
  readonly projection: ProjectionState<S>;
  /**
   * The ledger's own report on the slice that was replayed, including its
   * chain verification. Carried through rather than swallowed: a rebuilt
   * projection is only as trustworthy as the history it was rebuilt from.
   */
  readonly summary: ReplaySummary;
}

/**
 * Rebuilds a projection from the ledger, from the beginning.
 *
 * Chain verification is on by default because that is `replay`'s default
 * (ADR-0009 rule 5) — the moment history is used is the moment to notice it
 * has been altered.
 */
export async function replayProjection<S extends JsonValue>(
  projector: Projector<S>,
  scope: ProjectScope,
  ledger: EventLedger,
  options?: ReplayOptions,
): Promise<ReplayResult<S>> {
  let acc = emptyProjection(projector, scope);
  const summary = await ledger.replay(
    scope,
    (event) => {
      acc = applyEvent(projector, acc, event);
    },
    options,
  );
  return { projection: acc, summary };
}

/**
 * Continues a projection from where it left off — the snapshot path.
 *
 * This is the function the "no hidden state" property is tested against:
 * resuming from a snapshot at seq k and replaying k+1..n must produce exactly
 * what replaying 1..n produces. Anything a projector kept outside the
 * snapshotted value is, by construction, absent from the left-hand side.
 */
export async function resumeProjection<S extends JsonValue>(
  projector: Projector<S>,
  from: ProjectionState<S>,
  ledger: EventLedger,
  options?: ReplayOptions,
): Promise<ReplayResult<S>> {
  assertProjectorMatches(projector, from, 'projection being resumed');

  let acc = from;
  const summary = await ledger.replay(
    projectScope(from.projectId),
    (event) => {
      acc = applyEvent(projector, acc, event);
    },
    { ...options, fromSeq: from.lastSeq + 1 },
  );
  return { projection: acc, summary };
}
