/**
 * The cloud handlers (SPEC-07 §3.5, ADR-0026 §4).
 *
 * Each is a function of a runtime and an event, so the suite can call it
 * directly. None of them reaches for `process.env`, and none constructs an
 * adapter: what they can touch is whatever the composition root handed them,
 * which is how a handler stays unable to quietly acquire a capability the
 * deployment did not grant it.
 *
 * The two stream handlers report partial batch failures rather than throwing.
 * Throwing would make Lambda retry the whole batch, re-folding events that
 * already succeeded; reporting the specific records lets the rest make
 * progress, which matters when one project's projection is broken and five
 * others are fine.
 */

import { type JsonValue, ProjectId, projectScope, type ProjectScope } from '@genesis/core-types';
import {
  type ProjectionSnapshotStore,
  type Projector,
  emptyProjection,
  resumeProjection,
  restoreProjection,
  selfModelProjector,
  worldModelProjector,
} from '@genesis/projections';
import type { EventLedger } from '@genesis/ledger';
import type { CloudRuntime } from './runtime.js';
import { type BatchResponse, batchFailures, ledgerRanges, type StreamRecord } from './stream.js';

/** The projections a deployment keeps warm. Both are rebuildable from history. */
export const DEPLOYED_PROJECTIONS: readonly Projector<never>[] = [
  worldModelProjector as unknown as Projector<never>,
  selfModelProjector as unknown as Projector<never>,
];

export interface StreamEvent {
  readonly Records?: readonly StreamRecord[];
}

/**
 * Brings one projection up to date with the ledger.
 *
 * Resumes from the stored snapshot rather than from the stream's position: the
 * snapshot records what was actually folded, so a record that was retried, lost
 * or delivered twice changes how much is read and never what the result is.
 * That is ADR-0013's idempotency, arriving where it is needed.
 */
export async function advanceProjection(
  projector: Projector<JsonValue>,
  scope: ProjectScope,
  ledger: EventLedger,
  snapshots: ProjectionSnapshotStore,
): Promise<number> {
  const stored = await snapshots.load(scope, projector.name, projector.version);
  const from = stored === null ? emptyProjection(projector, scope) : restoreProjection(scope, projector, stored);
  const { projection } = await resumeProjection(projector, from, ledger);
  if (stored !== null && projection.lastSeq === stored.lastSeq) return projection.lastSeq;
  await snapshots.save(scope, projection);
  return projection.lastSeq;
}

/**
 * The projection updater, behind the table's stream.
 *
 * One project at a time, one read per project. A project whose projections
 * could not be advanced has its records reported as failures, and the others
 * still land.
 */
export async function projectionHandler(runtime: CloudRuntime, event: StreamEvent): Promise<BatchResponse> {
  const failed: string[] = [];

  for (const range of ledgerRanges(event.Records ?? [])) {
    const parsed = ProjectId.safeParse(range.projectId);
    if (!parsed.success) {
      // A key that is not a project id was written by something other than the
      // adapter. Nothing can be done with it, and retrying will not help.
      failed.push(...range.itemIdentifiers);
      continue;
    }
    const scope = projectScope(parsed.data);
    try {
      for (const projector of DEPLOYED_PROJECTIONS) {
        await advanceProjection(projector as unknown as Projector<JsonValue>, scope, runtime.ledger, runtime.snapshots);
      }
    } catch {
      failed.push(...range.itemIdentifiers);
    }
  }

  return batchFailures(failed);
}

/**
 * The ledger fan-out, behind the same stream.
 *
 * Reads the events the batch mentions from the ledger and publishes their
 * coordinates. The bus never carries a payload (ADR-0025 §4), and a failed
 * publish is reported so the batch is retried — the events are already durable,
 * so a repeat publish is a duplicate notification rather than duplicate truth.
 */
export async function fanOutHandler(runtime: CloudRuntime, event: StreamEvent): Promise<BatchResponse> {
  const failed: string[] = [];

  for (const range of ledgerRanges(event.Records ?? [])) {
    const parsed = ProjectId.safeParse(range.projectId);
    if (!parsed.success) {
      failed.push(...range.itemIdentifiers);
      continue;
    }
    try {
      const events = await runtime.ledger.read(projectScope(parsed.data), {
        fromSeq: range.fromSeq,
        toSeq: range.toSeq,
      });
      const refused = await runtime.publisher.publish(events, runtime.config.eventBusArn);
      if (refused > 0) failed.push(...range.itemIdentifiers);
    } catch {
      failed.push(...range.itemIdentifiers);
    }
  }

  return batchFailures(failed);
}
