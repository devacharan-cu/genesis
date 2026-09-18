/**
 * Contradiction resolution is safety-critical (SPEC-00 §8.1).
 *
 * The property being defended is that nothing is ever lost. Exhaustive over all
 * 36 authority pairs, because that domain is small enough to check completely.
 */

import { AUTHORITY_LEVELS, type Authority, outranks } from '@genesis/core-types';
import {
  type ContradictionSide,
  resolveContradiction,
  resolveSupersedes,
} from '@genesis/memory';
import type { MemoryId } from '@genesis/core-types';
import type { MemoryStatus } from '@genesis/memory';
import { describe, expect, it } from 'vitest';

const side = (
  id: string,
  authority: Authority,
  status: MemoryStatus = 'ACTIVE',
): ContradictionSide => ({
  id: id as MemoryId,
  authority,
  status,
});

const PAIRS: { a: Authority; b: Authority }[] = AUTHORITY_LEVELS.flatMap((a) =>
  AUTHORITY_LEVELS.map((b) => ({ a, b })),
);

describe('resolveContradiction — exhaustive over every authority pair', () => {
  it('covers every ordered pair of authority levels', () => {
    expect(PAIRS.length).toBe(AUTHORITY_LEVELS.length ** 2);
  });

  it('NEVER produces a change that removes a record', () => {
    // The return type cannot express deletion; this asserts the values it does
    // produce are status changes onto statuses that keep the record readable.
    const preserving: MemoryStatus[] = ['CONTRADICTED', 'SUPERSEDED_BY_AUTHORITY'];
    for (const { a, b } of PAIRS) {
      const resolution = resolveContradiction(side('a', a), side('b', b));
      for (const change of resolution.changes) {
        expect(preserving, `${a} vs ${b}`).toContain(change.status);
      }
    }
  });

  it('touches at most both records, never a third', () => {
    for (const { a, b } of PAIRS) {
      const resolution = resolveContradiction(side('a', a), side('b', b));
      for (const change of resolution.changes) {
        expect(['a', 'b'], `${a} vs ${b}`).toContain(change.id);
      }
    }
  });

  it('is symmetric in outcome regardless of argument order', () => {
    for (const { a, b } of PAIRS) {
      const forward = resolveContradiction(side('a', a), side('b', b));
      const backward = resolveContradiction(side('b', b), side('a', a));
      expect(backward.outcome, `${a} vs ${b}`).toBe(forward.outcome);
      expect(backward.governing, `${a} vs ${b}`).toBe(forward.governing);
      expect(backward.superseded, `${a} vs ${b}`).toBe(forward.superseded);
    }
  });

  it('lets the strictly higher authority govern', () => {
    for (const { a, b } of PAIRS) {
      if (a === b) continue;
      const resolution = resolveContradiction(side('a', a), side('b', b));
      const expected = outranks(a, b) ? 'a' : 'b';
      expect(resolution.governing, `${a} vs ${b}`).toBe(expected);
      expect(resolution.outcome).toBe('GOVERNED_BY_AUTHORITY');
    }
  });

  it('demotes ONLY the losing side', () => {
    for (const { a, b } of PAIRS) {
      if (a === b) continue;
      const resolution = resolveContradiction(side('a', a), side('b', b));
      expect(resolution.changes.length, `${a} vs ${b}`).toBe(1);
      expect(resolution.changes[0]?.id).toBe(resolution.superseded);
      expect(resolution.changes[0]?.status).toBe('SUPERSEDED_BY_AUTHORITY');
    }
  });

  it('leaves equal authority UNRESOLVED and marks both', () => {
    for (const level of AUTHORITY_LEVELS) {
      const resolution = resolveContradiction(side('a', level), side('b', level));
      expect(resolution.outcome, level).toBe('UNRESOLVED');
      expect(resolution.governing).toBeNull();
      expect(resolution.superseded).toBeNull();
      expect(resolution.changes.map((c) => c.status)).toEqual(['CONTRADICTED', 'CONTRADICTED']);
    }
  });

  it('owes an uncertainty exactly when the conflict is unresolved', () => {
    for (const { a, b } of PAIRS) {
      const resolution = resolveContradiction(side('a', a), side('b', b));
      expect(resolution.owesUncertainty, `${a} vs ${b}`).toBe(a === b);
    }
  });

  it('never marks the governing record', () => {
    for (const { a, b } of PAIRS) {
      if (a === b) continue;
      const resolution = resolveContradiction(side('a', a), side('b', b));
      const governing = resolution.governing;
      expect(
        resolution.changes.some((c) => c.id === governing),
        `${a} vs ${b}`,
      ).toBe(false);
    }
  });

  it('a human decision is never demoted by an AI assumption', () => {
    const resolution = resolveContradiction(
      side('human', 'HUMAN_DECISION'),
      side('ai', 'AI_ASSUMPTION'),
    );
    expect(resolution.governing).toBe('human');
    expect(resolution.changes).toEqual([{ id: 'ai', status: 'SUPERSEDED_BY_AUTHORITY' }]);
  });

  it('does not depend on the incoming statuses', () => {
    const statuses: MemoryStatus[] = ['ACTIVE', 'CONTRADICTED', 'ARCHIVED', 'RETRACTED'];
    for (const status of statuses) {
      const resolution = resolveContradiction(
        side('a', 'HUMAN_DECISION', status),
        side('b', 'AI_ASSUMPTION', status),
      );
      expect(resolution.governing, status).toBe('a');
    }
  });
});

describe('resolveSupersedes', () => {
  it('marks the superseded side and nothing else', () => {
    const resolution = resolveSupersedes(side('new', 'EVIDENCE'), side('old', 'EVIDENCE'));
    expect(resolution.governing).toBe('new');
    expect(resolution.changes).toEqual([{ id: 'old', status: 'SUPERSEDED' }]);
    expect(resolution.owesUncertainty).toBe(false);
  });

  it('supersedes regardless of relative authority — it is an explicit act', () => {
    const resolution = resolveSupersedes(
      side('new', 'AI_ASSUMPTION'),
      side('old', 'HUMAN_DECISION'),
    );
    expect(resolution.changes).toEqual([{ id: 'old', status: 'SUPERSEDED' }]);
  });
});
