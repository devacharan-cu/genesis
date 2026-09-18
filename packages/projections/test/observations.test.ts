/**
 * What a projection did not understand (ADR-0013 rule 4).
 *
 * The cap is the interesting part: it has to bound the state without hiding
 * that anything was lost, because a silently truncated anomaly list is exactly
 * the "looks complete and is not" failure this module exists to prevent.
 */

import { type GenesisEvent } from '@genesis/core-types';
import {
  ANOMALY_LIMIT,
  anomalyCount,
  emptyObservations,
  noteAnomaly,
  noteUnhandled,
  type ObservationLog,
} from '@genesis/projections';
import { describe, expect, it } from 'vitest';
import { SYSTEM } from './support.js';

const event = (seq: number, type = 'THING_HAPPENED'): GenesisEvent =>
  ({
    id: `evt_${String(seq).padStart(26, '0')}`,
    projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    seq,
    schemaVersion: 1,
    type,
    actor: SYSTEM,
    subject: null,
    before: null,
    after: null,
    cause: null,
    cycleId: null,
    authority: 'EVIDENCE',
    payload: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    payloadHash: 'a'.repeat(64),
    prevHash: null,
  }) as GenesisEvent;

const fill = (count: number): ObservationLog => {
  let log = emptyObservations();
  for (let i = 1; i <= count; i++) log = noteAnomaly(log, event(i), 'MALFORMED_PAYLOAD', `#${i}`);
  return log;
};

describe('noteAnomaly', () => {
  it('records the event it could not interpret', () => {
    const log = noteAnomaly(emptyObservations(), event(3), 'UNKNOWN_REFERENCE', 'no such fact');
    expect(log.anomalies).toEqual([
      {
        seq: 3,
        eventId: 'evt_00000000000000000000000003',
        eventType: 'THING_HAPPENED',
        kind: 'UNKNOWN_REFERENCE',
        detail: 'no such fact',
      },
    ]);
    expect(log.anomaliesDropped).toBe(0);
  });

  it('keeps everything up to the cap', () => {
    const log = fill(ANOMALY_LIMIT);
    expect(log.anomalies).toHaveLength(ANOMALY_LIMIT);
    expect(log.anomaliesDropped).toBe(0);
  });

  it('drops the oldest past the cap, and counts what it dropped', () => {
    const log = fill(ANOMALY_LIMIT + 3);
    expect(log.anomalies).toHaveLength(ANOMALY_LIMIT);
    expect(log.anomaliesDropped).toBe(3);
    expect(log.anomalies[0]?.detail).toBe('#4');
    expect(log.anomalies.at(-1)?.detail).toBe(`#${ANOMALY_LIMIT + 3}`);
  });

  it('reports the total, retained and dropped together', () => {
    expect(anomalyCount(fill(ANOMALY_LIMIT + 5))).toBe(ANOMALY_LIMIT + 5);
    expect(anomalyCount(emptyObservations())).toBe(0);
  });

  it('leaves the unhandled tally alone', () => {
    const withUnhandled = noteUnhandled(emptyObservations(), event(1, 'ODD_TYPE'));
    const log = noteAnomaly(withUnhandled, event(2), 'STATE_MISMATCH', 'x');
    expect(log.unhandled).toEqual({ ODD_TYPE: 1 });
  });
});

describe('noteUnhandled', () => {
  it('counts the first sighting of an event type', () => {
    expect(noteUnhandled(emptyObservations(), event(1, 'ODD_TYPE')).unhandled).toEqual({
      ODD_TYPE: 1,
    });
  });

  it('accumulates repeats without duplicating the key', () => {
    let log = emptyObservations();
    for (let i = 1; i <= 3; i++) log = noteUnhandled(log, event(i, 'ODD_TYPE'));
    log = noteUnhandled(log, event(4, 'OTHER_TYPE'));
    expect(log.unhandled).toEqual({ ODD_TYPE: 3, OTHER_TYPE: 1 });
  });

  it('does not mutate the log it was given', () => {
    const before = emptyObservations();
    noteUnhandled(before, event(1, 'ODD_TYPE'));
    expect(before.unhandled).toEqual({});
  });

  it('leaves recorded anomalies alone', () => {
    const withAnomaly = noteAnomaly(emptyObservations(), event(1), 'MISSING_SUBJECT', 'none');
    expect(noteUnhandled(withAnomaly, event(2, 'ODD_TYPE')).anomalies).toHaveLength(1);
  });
});
