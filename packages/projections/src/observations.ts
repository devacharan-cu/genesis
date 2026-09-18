/**
 * What a projection did not understand (ADR-0013 rule 4).
 *
 * SAFETY-CRITICAL (SPEC-00 section 8.1). This is the honesty mechanism for
 * projections, and the failure mode it guards against is the quiet one: a
 * projector that meets an event it cannot interpret and simply carries on,
 * leaving a state that looks complete and is not.
 *
 * Why a projector does not throw on event content. The ledger is append-only
 * (ADR-0004), so a projector that throws on a malformed payload makes that
 * projection PERMANENTLY unbuildable — the offending event can never be
 * removed. The predictable response would be to disable the check, which is
 * strictly worse than not having written it. So the event is recorded and the
 * fold continues.
 *
 * Both fields are part of the projected state, so they are covered by the
 * digest, they survive a rebuild, and any surface reporting the world model can
 * also report how much of the ledger it actually understood.
 */

import { type GenesisEvent } from '@genesis/core-types';
import { z } from 'zod';

/**
 * How many anomalies a projection retains.
 *
 * Bounded because the state is serialised, hashed and stored on every
 * snapshot; an unbounded list would let a pathological ledger grow the snapshot
 * without limit. The count of what was dropped is kept, so the loss is visible
 * rather than silent.
 */
export const ANOMALY_LIMIT = 100;

export const ANOMALY_KINDS = [
  /** The event's payload did not match the schema this event type requires. */
  'MALFORMED_PAYLOAD',
  /** The event type needs a subject and the event had none. */
  'MISSING_SUBJECT',
  /** The event refers to something this projection has never seen. */
  'UNKNOWN_REFERENCE',
  /** The payload was well-formed but states something the spec forbids. */
  'FORBIDDEN_VALUE',
  /** Well-formed and permitted, but inconsistent with the state so far. */
  'STATE_MISMATCH',
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

export const ProjectionAnomaly = z
  .object({
    seq: z.number().int().positive(),
    eventId: z.string().min(1),
    eventType: z.string().min(1),
    kind: z.enum(ANOMALY_KINDS),
    detail: z.string(),
  })
  .strict();
export type ProjectionAnomaly = z.infer<typeof ProjectionAnomaly>;

export const ObservationLog = z
  .object({
    /** The most recent anomalies, oldest first, capped at ANOMALY_LIMIT. */
    anomalies: z.array(ProjectionAnomaly),
    /** Anomalies that happened but are no longer retained. */
    anomaliesDropped: z.number().int().nonnegative(),
    /** Event types this projection does not interpret, with counts. */
    unhandled: z.record(z.number().int().positive()),
  })
  .strict();
export type ObservationLog = z.infer<typeof ObservationLog>;

export const emptyObservations = (): ObservationLog => ({
  anomalies: [],
  anomaliesDropped: 0,
  unhandled: {},
});

/**
 * Records an anomaly, dropping the OLDEST when the cap is reached.
 *
 * Oldest rather than newest: a projection that has been running for a while is
 * more usefully described by what is going wrong now than by what went wrong
 * when it started.
 */
export function noteAnomaly(
  log: ObservationLog,
  event: GenesisEvent,
  kind: AnomalyKind,
  detail: string,
): ObservationLog {
  const anomaly: ProjectionAnomaly = {
    seq: event.seq,
    eventId: event.id,
    eventType: event.type,
    kind,
    detail,
  };
  const kept = [...log.anomalies, anomaly];
  const overflow = kept.length - ANOMALY_LIMIT;
  return {
    anomalies: overflow > 0 ? kept.slice(overflow) : kept,
    anomaliesDropped: log.anomaliesDropped + (overflow > 0 ? overflow : 0),
    unhandled: log.unhandled,
  };
}

/** Counts an event type this projection has no handler for. */
export function noteUnhandled(log: ObservationLog, event: GenesisEvent): ObservationLog {
  const seen = log.unhandled[event.type] ?? 0;
  return {
    anomalies: log.anomalies,
    anomaliesDropped: log.anomaliesDropped,
    unhandled: { ...log.unhandled, [event.type]: seen + 1 },
  };
}

/** Total anomalies observed, retained and dropped together. */
export function anomalyCount(log: ObservationLog): number {
  return log.anomalies.length + log.anomaliesDropped;
}
