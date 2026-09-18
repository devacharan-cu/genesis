/**
 * Traversal caps and impact ranking are safety-critical (SPEC-00 §8.1).
 *
 * The caps exist because of the anti-pattern this architecture is defined
 * against: no query may accidentally pull the whole graph into a model context.
 * A cap that can be exceeded is not a cap, so each is tested at its boundary.
 */

import { type EdgeId, type NodeId, ValidationError } from '@genesis/core-types';
import {
  clampDepth,
  clampLimit,
  DEFAULT_IMPACT_DEPTH,
  DEFAULT_NEIGHBOURHOOD_DEPTH,
  edgeMatches,
  type GraphEdge,
  type ImpactEntry,
  IMPACT_INBOUND,
  IMPACT_OUTBOUND,
  MAX_IMPACT_DEPTH,
  MAX_TRAVERSAL_DEPTH,
  MAX_TRAVERSAL_LIMIT,
  rankImpact,
} from '@genesis/graph';
import { describe, expect, it } from 'vitest';

const graphEdge = (over: Partial<GraphEdge> = {}): GraphEdge =>
  ({
    id: 'edge_01ARZ3NDEKTSV4RRFFQ69G5FAV' as EdgeId,
    projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    type: 'DEPENDS_ON',
    from: 'node_01ARZ3NDEKTSV4RRFFQ69G5FAV' as NodeId,
    to: 'node_01BRZ3NDEKTSV4RRFFQ69G5FAV' as NodeId,
    authority: 'EVIDENCE',
    evidenceRefs: [],
    weight: null,
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdByCycle: null,
    reciprocalOf: null,
    ...over,
  }) as GraphEdge;

describe('clampDepth', () => {
  it('uses the fallback when nothing is requested', () => {
    expect(clampDepth(undefined, DEFAULT_NEIGHBOURHOOD_DEPTH, MAX_TRAVERSAL_DEPTH)).toBe(
      DEFAULT_NEIGHBOURHOOD_DEPTH,
    );
  });

  it('passes a request through when it is under the cap', () => {
    expect(clampDepth(2, DEFAULT_NEIGHBOURHOOD_DEPTH, MAX_TRAVERSAL_DEPTH)).toBe(2);
  });

  it('CAPS a request that exceeds the maximum', () => {
    expect(clampDepth(999, DEFAULT_NEIGHBOURHOOD_DEPTH, MAX_TRAVERSAL_DEPTH)).toBe(
      MAX_TRAVERSAL_DEPTH,
    );
  });

  it('allows depth zero — the origin alone is a valid answer', () => {
    expect(clampDepth(0, 3, MAX_TRAVERSAL_DEPTH)).toBe(0);
  });

  it('rejects a negative depth', () => {
    expect(() => clampDepth(-1, 3, MAX_TRAVERSAL_DEPTH)).toThrow(ValidationError);
  });

  it('rejects a fractional depth', () => {
    expect(() => clampDepth(1.5, 3, MAX_TRAVERSAL_DEPTH)).toThrow(/non-negative integer/);
  });
});

describe('clampLimit', () => {
  it('uses the fallback when nothing is requested', () => {
    expect(clampLimit(undefined, 50)).toBe(50);
  });

  it('passes a request through when it is under the cap', () => {
    expect(clampLimit(10, 50)).toBe(10);
  });

  it('CAPS a request that exceeds the maximum', () => {
    expect(clampLimit(10_000, 50)).toBe(MAX_TRAVERSAL_LIMIT);
  });

  it('rejects zero and negative limits', () => {
    expect(() => clampLimit(0, 50)).toThrow(/positive integer/);
    expect(() => clampLimit(-3, 50)).toThrow(/positive integer/);
  });

  it('rejects a fractional limit', () => {
    expect(() => clampLimit(2.5, 50)).toThrow(/positive integer/);
  });
});

describe('edgeMatches', () => {
  it('accepts an active edge with no filters', () => {
    expect(edgeMatches(graphEdge(), {})).toBe(true);
  });

  it('rejects a non-active edge', () => {
    expect(edgeMatches(graphEdge({ status: 'RETRACTED' }), {})).toBe(false);
    expect(edgeMatches(graphEdge({ status: 'SUPERSEDED' }), {})).toBe(false);
  });

  it('filters by edge type', () => {
    expect(edgeMatches(graphEdge(), { edgeTypes: ['DEPENDS_ON'] })).toBe(true);
    expect(edgeMatches(graphEdge(), { edgeTypes: ['CALLS'] })).toBe(false);
  });

  it('filters by minimum authority', () => {
    // minAuthority is a floor on how well established the edge must be.
    expect(edgeMatches(graphEdge({ authority: 'HUMAN_DECISION' }), { minAuthority: 'EVIDENCE' })).toBe(
      true,
    );
    expect(edgeMatches(graphEdge({ authority: 'EVIDENCE' }), { minAuthority: 'EVIDENCE' })).toBe(
      true,
    );
    expect(edgeMatches(graphEdge({ authority: 'UNGROUNDED' }), { minAuthority: 'EVIDENCE' })).toBe(
      false,
    );
  });

  it('applies both filters together', () => {
    expect(
      edgeMatches(graphEdge({ authority: 'UNGROUNDED' }), {
        edgeTypes: ['DEPENDS_ON'],
        minAuthority: 'EVIDENCE',
      }),
    ).toBe(false);
  });
});

describe('impact propagation sets', () => {
  it('propagates outward only along AFFECTS', () => {
    expect([...IMPACT_OUTBOUND]).toEqual(['AFFECTS']);
  });

  it('propagates inward along the dependency family', () => {
    expect([...IMPACT_INBOUND]).toEqual([
      'DEPENDS_ON',
      'CALLS',
      'READS',
      'WRITES',
      'IMPLEMENTS',
    ]);
  });

  it('defaults impact depth below its cap', () => {
    expect(DEFAULT_IMPACT_DEPTH).toBeLessThanOrEqual(MAX_IMPACT_DEPTH);
  });
});

describe('rankImpact', () => {
  const entry = (nodeId: string, depth: number, weakest: number): ImpactEntry => ({
    nodeId: nodeId as NodeId,
    depth,
    weakestAuthorityRank: weakest,
  });

  it('orders nearest first', () => {
    const ranked = rankImpact([entry('b', 3, 1), entry('a', 1, 1), entry('c', 2, 1)]);
    expect(ranked.map((e) => e.depth)).toEqual([1, 2, 3]);
  });

  it('orders better-established paths first at equal depth', () => {
    const ranked = rankImpact([entry('b', 1, 6), entry('a', 1, 2)]);
    expect(ranked.map((e) => e.weakestAuthorityRank)).toEqual([2, 6]);
  });

  it('breaks remaining ties by id, so both adapters agree', () => {
    // Without a deterministic tiebreak the two adapters could return the same
    // set in different orders, and the conformance suite would be comparing
    // something that is allowed to differ.
    const ranked = rankImpact([entry('zzz', 1, 1), entry('aaa', 1, 1), entry('mmm', 1, 1)]);
    expect(ranked.map((e) => e.nodeId)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('does not mutate its input', () => {
    const input = [entry('b', 2, 1), entry('a', 1, 1)];
    rankImpact(input);
    expect(input.map((e) => e.nodeId)).toEqual(['b', 'a']);
  });

  it('handles an empty set', () => {
    expect(rankImpact([])).toEqual([]);
  });
});
