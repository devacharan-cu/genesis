/**
 * The projection runner (ADR-0013 rule 2).
 *
 * Tested against a trivial projector rather than the real ones, so a failure
 * here points at the runner and nothing else.
 */

import {
  type GenesisEvent,
  newProjectId,
  type ProjectScope,
  projectScope,
  ScopeMismatchError,
  SequenceConflictError,
  ValidationError,
} from '@genesis/core-types';
import type { EventLedger } from '@genesis/ledger';
import {
  applyEvent,
  applyEvents,
  assertProjectorMatches,
  emptyObservations,
  emptyProjection,
  noteUnhandled,
  type ObservationLog,
  type ProjectionState,
  projectionDigest,
  type Projector,
  replayProjection,
  resumeProjection,
} from '@genesis/projections';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLedger, SYSTEM } from './support.js';

type TrailState = { seen: string[]; observations: ObservationLog };

const trail: Projector<TrailState> = {
  name: 'trail',
  version: 1,
  initial: () => ({ seen: [], observations: emptyObservations() }),
  apply: (state, event) => ({
    seen: [...state.seen, `${event.seq}:${event.type}`],
    observations: noteUnhandled(state.observations, event),
  }),
  parse: (value) => value as TrailState,
  observationsOf: (state) => state.observations,
};

const event = (seq: number, scope: ProjectScope): GenesisEvent =>
  ({
    id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    projectId: scope.projectId,
    seq,
    schemaVersion: 1,
    type: 'THING_HAPPENED',
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

describe('assertProjectorMatches', () => {
  const projection = { projection: 'trail', version: 1 };

  it('accepts a matching projection', () => {
    expect(() => assertProjectorMatches(trail, projection, 'subject')).not.toThrow();
  });

  it('rejects a different projection name', () => {
    expect(() =>
      assertProjectorMatches(trail, { projection: 'other', version: 1 }, 'subject'),
    ).toThrow(ValidationError);
  });

  it('rejects a different version of the same projection', () => {
    expect(() =>
      assertProjectorMatches(trail, { projection: 'trail', version: 2 }, 'subject'),
    ).toThrow(/different projection/);
  });
});

describe('applyEvent', () => {
  let scope: ProjectScope;
  let other: ProjectScope;
  let empty: ProjectionState<TrailState>;

  beforeEach(() => {
    scope = projectScope(newProjectId());
    other = projectScope(newProjectId());
    empty = emptyProjection(trail, scope);
  });

  it('applies the next event in sequence', () => {
    const next = applyEvent(trail, empty, event(1, scope));
    expect(next.lastSeq).toBe(1);
    expect(next.state.seen).toEqual(['1:THING_HAPPENED']);
  });

  it('returns the same projection for an event already applied', () => {
    const once = applyEvent(trail, empty, event(1, scope));
    expect(applyEvent(trail, once, event(1, scope))).toBe(once);
  });

  it('returns the same projection for an event before the current position', () => {
    const twice = applyEvents(trail, empty, [event(1, scope), event(2, scope)]);
    expect(applyEvent(trail, twice, event(1, scope))).toBe(twice);
  });

  it('refuses to skip a sequence', () => {
    expect(() => applyEvent(trail, empty, event(2, scope))).toThrow(SequenceConflictError);
    expect(() => applyEvent(trail, empty, event(2, scope))).toThrow(/cannot skip to 2/);
  });

  it('refuses an event belonging to another project', () => {
    expect(() => applyEvent(trail, empty, event(1, other))).toThrow(ScopeMismatchError);
  });

  it('carries the projection identity forward unchanged', () => {
    const next = applyEvent(trail, empty, event(1, scope));
    expect(next.projection).toBe(empty.projection);
    expect(next.version).toBe(empty.version);
    expect(next.projectId).toBe(empty.projectId);
  });
});

describe('applyEvents', () => {
  it('folds a batch in order', () => {
    const scope = projectScope(newProjectId());
    const folded = applyEvents(trail, emptyProjection(trail, scope), [
      event(1, scope),
      event(2, scope),
      event(3, scope),
    ]);
    expect(folded.lastSeq).toBe(3);
    expect(folded.state.seen).toHaveLength(3);
  });

  it('folds an empty batch to the same projection', () => {
    const scope = projectScope(newProjectId());
    const empty = emptyProjection(trail, scope);
    expect(applyEvents(trail, empty, [])).toBe(empty);
  });
});

describe('replayProjection and resumeProjection', () => {
  let ledger: EventLedger;
  let scope: ProjectScope;

  beforeEach(async () => {
    ledger = await createLedger();
    scope = projectScope(newProjectId());
    await ledger.appendMany(
      scope,
      [1, 2, 3, 4].map((n) => ({
        type: 'THING_HAPPENED',
        actor: SYSTEM,
        authority: 'EVIDENCE',
        payload: { n },
      })),
    );
  });

  it('replays the whole ledger', async () => {
    const { projection, summary } = await replayProjection(trail, scope, ledger);
    expect(projection.lastSeq).toBe(4);
    expect(summary.events).toBe(4);
  });

  it('honours replay options', async () => {
    const { projection } = await replayProjection(trail, scope, ledger, { toSeq: 2 });
    expect(projection.lastSeq).toBe(2);
  });

  it('fails closed when asked to replay a slice that starts with a gap', async () => {
    await expect(replayProjection(trail, scope, ledger, { fromSeq: 2 })).rejects.toThrow(
      SequenceConflictError,
    );
  });

  it('resumes from a partial projection', async () => {
    const head = await replayProjection(trail, scope, ledger, { toSeq: 2 });
    const resumed = await resumeProjection(trail, head.projection, ledger);
    const full = await replayProjection(trail, scope, ledger);
    expect(projectionDigest(resumed.projection)).toBe(projectionDigest(full.projection));
  });

  it('resumes with extra options', async () => {
    const head = await replayProjection(trail, scope, ledger, { toSeq: 1 });
    const resumed = await resumeProjection(trail, head.projection, ledger, { verify: false });
    expect(resumed.projection.lastSeq).toBe(4);
    expect(resumed.summary.verification).toBeNull();
  });

  it('resuming a complete projection is a no-op', async () => {
    const full = await replayProjection(trail, scope, ledger);
    const resumed = await resumeProjection(trail, full.projection, ledger);
    expect(resumed.projection.lastSeq).toBe(4);
    expect(resumed.summary.events).toBe(0);
  });

  it('refuses to resume a projection built by a different projector', async () => {
    const full = await replayProjection(trail, scope, ledger);
    const foreign: ProjectionState<TrailState> = {
      ...full.projection,
      projection: 'somethingElse',
    };
    await expect(resumeProjection(trail, foreign, ledger)).rejects.toThrow(ValidationError);
  });
});
