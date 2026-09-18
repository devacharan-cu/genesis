/**
 * Projection digests (ADR-0013 rule 3).
 *
 * The tests that matter here are the negative ones. A digest function that
 * always returned the same value would pass "equal states are equal"; what has
 * to be proven is that DIFFERENT states differ, including in the ways that are
 * easy to miss — a different project, a different position in history, a value
 * that does not survive serialisation.
 */

import { type JsonValue, newProjectId, type ProjectId, ValidationError } from '@genesis/core-types';
import {
  assertJsonState,
  type ProjectionState,
  projectionDigest,
  projectionsEqual,
} from '@genesis/projections';
import { describe, expect, it } from 'vitest';

const at = (projectId: ProjectId, lastSeq: number, state: JsonValue): ProjectionState<JsonValue> => ({
  projectId,
  projection: 'p',
  version: 1,
  lastSeq,
  state,
});

describe('assertJsonState', () => {
  it('accepts plain JSON', () => {
    expect(assertJsonState({ a: [1, 'two', null, { b: true }] }, 'state')).toEqual({
      a: [1, 'two', null, { b: true }],
    });
  });

  it('rejects a Date, which would silently serialise to {}', () => {
    expect(() => assertJsonState({ when: new Date() }, 'state')).toThrow(ValidationError);
  });

  it('rejects a Map, for the same reason', () => {
    expect(() => assertJsonState({ index: new Map() }, 'state')).toThrow(
      /not canonically serialisable/,
    );
  });

  it('names the subject in the failure', () => {
    expect(() => assertJsonState(() => 1, 'the world model state')).toThrow(/the world model state/);
  });
});

describe('projectionDigest', () => {
  const project = newProjectId();

  it('is stable for the same value', () => {
    expect(projectionDigest(at(project, 3, { a: 1 }))).toBe(
      projectionDigest(at(project, 3, { a: 1 })),
    );
  });

  it('ignores key order, which is what a snapshot round trip does too', () => {
    expect(projectionDigest(at(project, 1, { a: 1, b: 2 }))).toBe(
      projectionDigest(at(project, 1, { b: 2, a: 1 })),
    );
  });

  it('changes when the state changes', () => {
    expect(projectionDigest(at(project, 1, { a: 1 }))).not.toBe(
      projectionDigest(at(project, 1, { a: 2 })),
    );
  });

  it('changes when the position in history changes', () => {
    expect(projectionDigest(at(project, 1, { a: 1 }))).not.toBe(
      projectionDigest(at(project, 2, { a: 1 })),
    );
  });

  it('changes when the project changes', () => {
    expect(projectionDigest(at(project, 1, { a: 1 }))).not.toBe(
      projectionDigest(at(newProjectId(), 1, { a: 1 })),
    );
  });

  it('changes when the projection identity changes', () => {
    const base = at(project, 1, { a: 1 });
    expect(projectionDigest({ ...base, projection: 'other' })).not.toBe(projectionDigest(base));
    expect(projectionDigest({ ...base, version: 2 })).not.toBe(projectionDigest(base));
  });

  it('refuses a state that is not serialisable', () => {
    expect(() =>
      projectionDigest(at(project, 1, { when: new Date() } as unknown as JsonValue)),
    ).toThrow(ValidationError);
  });
});

describe('projectionsEqual', () => {
  const project = newProjectId();

  it('is true for equal projections', () => {
    expect(projectionsEqual(at(project, 2, { a: 1 }), at(project, 2, { a: 1 }))).toBe(true);
  });

  it('is false for different ones', () => {
    expect(projectionsEqual(at(project, 2, { a: 1 }), at(project, 2, { a: 2 }))).toBe(false);
  });
});
