/**
 * Snapshot write rules and restore checks (ADR-0013 rule 5).
 *
 * These are the guards that stand between a stored byte string and something
 * the system will treat as its own history. Each one is tested by making it
 * fire, because a guard nobody has seen fire is a guard nobody knows works.
 */

import {
  type JsonValue,
  newProjectId,
  ProjectionDivergenceError,
  type ProjectScope,
  projectScope,
  ScopeMismatchError,
  SequenceConflictError,
  ValidationError,
} from '@genesis/core-types';
import {
  checkSnapshotWrite,
  type ProjectionSnapshot,
  type ProjectionState,
  projectionDigest,
  restoreProjection,
  toSnapshot,
  worldModelProjector,
} from '@genesis/projections';
import { beforeEach, describe, expect, it } from 'vitest';

describe('checkSnapshotWrite', () => {
  let scope: ProjectScope;

  const at = (lastSeq: number, state: JsonValue): ProjectionState<JsonValue> => ({
    projectId: scope.projectId,
    projection: 'p',
    version: 1,
    lastSeq,
    state,
  });

  const snapshotOf = (projection: ProjectionState<JsonValue>): ProjectionSnapshot =>
    toSnapshot(projection, '2026-01-01T00:00:00.000Z');

  beforeEach(() => {
    scope = projectScope(newProjectId());
  });

  it('accepts the first write', () => {
    const incoming = at(3, { a: 1 });
    expect(() => checkSnapshotWrite(null, incoming, projectionDigest(incoming))).not.toThrow();
  });

  it('accepts a write that moves forward', () => {
    const stored = snapshotOf(at(3, { a: 1 }));
    const incoming = at(4, { a: 2 });
    expect(() => checkSnapshotWrite(stored, incoming, projectionDigest(incoming))).not.toThrow();
  });

  it('accepts an identical re-write at the same sequence', () => {
    const projection = at(3, { a: 1 });
    const stored = snapshotOf(projection);
    expect(() => checkSnapshotWrite(stored, projection, projectionDigest(projection))).not.toThrow();
  });

  it('refuses a write that moves backwards', () => {
    const stored = snapshotOf(at(9, { a: 1 }));
    const incoming = at(4, { a: 1 });
    expect(() => checkSnapshotWrite(stored, incoming, projectionDigest(incoming))).toThrow(
      SequenceConflictError,
    );
  });

  it('refuses two different states at the same sequence', () => {
    const stored = snapshotOf(at(4, { a: 1 }));
    const incoming = at(4, { a: 2 });
    expect(() => checkSnapshotWrite(stored, incoming, projectionDigest(incoming))).toThrow(
      ProjectionDivergenceError,
    );
  });

  it('says which digests disagreed', () => {
    const stored = snapshotOf(at(4, { a: 1 }));
    const incoming = at(4, { a: 2 });
    expect(() => checkSnapshotWrite(stored, incoming, projectionDigest(incoming))).toThrow(
      new RegExp(stored.digest.slice(0, 16)),
    );
  });
});

describe('toSnapshot', () => {
  it('records the digest of what it stored', () => {
    const scope = projectScope(newProjectId());
    const projection: ProjectionState<JsonValue> = {
      projectId: scope.projectId,
      projection: 'p',
      version: 2,
      lastSeq: 5,
      state: { b: 2, a: 1 },
    };
    const snapshot = toSnapshot(projection, '2026-02-02T00:00:00.000Z');

    expect(snapshot.digest).toBe(projectionDigest(projection));
    expect(snapshot.updatedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(snapshot.version).toBe(2);
  });

  it('refuses a state that could not be stored faithfully', () => {
    const scope = projectScope(newProjectId());
    expect(() =>
      toSnapshot(
        {
          projectId: scope.projectId,
          projection: 'p',
          version: 1,
          lastSeq: 1,
          state: { when: new Date() } as unknown as JsonValue,
        },
        '2026-02-02T00:00:00.000Z',
      ),
    ).toThrow(ValidationError);
  });
});

describe('restoreProjection', () => {
  let scope: ProjectScope;
  let other: ProjectScope;
  let snapshot: ProjectionSnapshot;

  beforeEach(() => {
    scope = projectScope(newProjectId());
    other = projectScope(newProjectId());
    snapshot = toSnapshot(
      {
        projectId: scope.projectId,
        projection: worldModelProjector.name,
        version: worldModelProjector.version,
        lastSeq: 4,
        state: worldModelProjector.initial(),
      },
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('restores a snapshot it wrote', () => {
    const restored = restoreProjection(scope, worldModelProjector, snapshot);
    expect(restored.lastSeq).toBe(4);
    expect(projectionDigest(restored)).toBe(snapshot.digest);
  });

  it('refuses a snapshot from another project', () => {
    expect(() => restoreProjection(other, worldModelProjector, snapshot)).toThrow(
      ScopeMismatchError,
    );
  });

  it('refuses a snapshot written by a different projection', () => {
    expect(() =>
      restoreProjection(scope, worldModelProjector, { ...snapshot, projection: 'somethingElse' }),
    ).toThrow(ValidationError);
  });

  it('refuses a snapshot written by an older version of this projection', () => {
    expect(() => restoreProjection(scope, worldModelProjector, { ...snapshot, version: 0 })).toThrow(
      ValidationError,
    );
  });

  it('refuses a state that is not a state of this projection', () => {
    expect(() =>
      restoreProjection(scope, worldModelProjector, { ...snapshot, state: { facts: 'no' } }),
    ).toThrow(ValidationError);
  });

  it('refuses a state that no longer matches its recorded digest', () => {
    // What tampering, a partial write or a truncated read looks like from here.
    const tampered: ProjectionSnapshot = { ...snapshot, lastSeq: 99 };
    expect(() => restoreProjection(scope, worldModelProjector, tampered)).toThrow(
      ProjectionDivergenceError,
    );
  });
});
