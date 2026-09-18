/**
 * Graph invariants are safety-critical (SPEC-00 §8.1).
 *
 * The conformance suite exercises these through both adapters. These tests
 * reach the cases an adapter cannot produce — an edge type with no rule, an
 * edge with both endpoints missing — and assert the rule table itself is
 * complete, which is the check that stops a new edge type from silently
 * bypassing G7.
 */

import { EDGE_TYPES, type EdgeType, type NodeId } from '@genesis/core-types';
import {
  checkEdgeWrite,
  checkStructuralGaps,
  type EdgeWriteContext,
  ENDPOINT_RULES,
  type GraphNode,
  needsReciprocal,
  rejections,
} from '@genesis/graph';
import { describe, expect, it } from 'vitest';

const NODE_A = 'node_01ARZ3NDEKTSV4RRFFQ69G5FAV' as NodeId;
const NODE_B = 'node_01BRZ3NDEKTSV4RRFFQ69G5FAV' as NodeId;

const graphNode = (over: Partial<GraphNode> = {}): GraphNode =>
  ({
    id: NODE_A,
    projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    type: 'COMPONENT',
    label: 'n',
    recordRef: null,
    status: 'ACTIVE',
    attrs: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    statusCause: null,
    ...over,
  }) as GraphNode;

const context = (over: Partial<EdgeWriteContext> = {}): EdgeWriteContext => ({
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  from: graphNode({ id: NODE_A }),
  to: graphNode({ id: NODE_B }),
  existingContainsParent: null,
  wouldCreateCycle: false,
  reciprocalExists: false,
  ...over,
});

describe('ENDPOINT_RULES', () => {
  it('declares a rule for EVERY canonical edge type', () => {
    // Without this, adding an edge type to the enum and forgetting the table
    // would make G7 silently inapplicable to it. The rule table is the
    // enforcement, so its completeness is the thing to guard.
    for (const type of EDGE_TYPES) {
      expect(ENDPOINT_RULES[type], type).toBeDefined();
    }
  });

  it('marks CONTRADICTS as the symmetric one', () => {
    expect(ENDPOINT_RULES.CONTRADICTS.symmetric).toBe(true);
    expect(ENDPOINT_RULES.DEPENDS_ON.symmetric).toBeUndefined();
  });
});

describe('checkEdgeWrite', () => {
  it('accepts a legal edge', () => {
    const violations = checkEdgeWrite(
      { type: 'DEPENDS_ON', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
      context(),
    );
    expect(violations).toEqual([]);
  });

  it('G6: reports both missing endpoints and stops there', () => {
    const violations = checkEdgeWrite(
      { type: 'DEPENDS_ON', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
      context({ from: null, to: null }),
    );
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.invariant === 'G6')).toBe(true);
    // Everything downstream needs both endpoints; reporting type errors about
    // nodes that do not exist would be noise.
  });

  it('G6: flags a logically deleted source and target', () => {
    const deleted = graphNode({ status: 'DELETED_LOGICALLY' });
    expect(
      checkEdgeWrite(
        { type: 'DEPENDS_ON', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
        context({ from: deleted }),
      ).some((v) => v.invariant === 'G6'),
    ).toBe(true);
    expect(
      checkEdgeWrite(
        { type: 'DEPENDS_ON', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
        context({ to: deleted }),
      ).some((v) => v.invariant === 'G6'),
    ).toBe(true);
  });

  it('G7: rejects an edge type with no declared rule', () => {
    // Unreachable through the store, which validates against the enum first.
    // Reachable here, which is the point: it is the guard for a future edge
    // type added to the enum but not to the table.
    const violations = checkEdgeWrite(
      { type: 'TELEPORTS' as EdgeType, from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
      context(),
    );
    expect(violations.some((v) => v.invariant === 'G7')).toBe(true);
    expect(violations[0]?.message).toMatch(/no endpoint rule declared/);
  });

  it('G7: allows an unconstrained endpoint side', () => {
    // AFFECTS is any -> any; neither side should be flagged.
    expect(
      checkEdgeWrite(
        { type: 'AFFECTS', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
        context({ from: graphNode({ type: 'TEST' }), to: graphNode({ type: 'DEPLOYMENT' }) }),
      ),
    ).toEqual([]);
  });

  it('G11: flags a source or target in another project', () => {
    const foreign = graphNode({ projectId: 'prj_01ZZZ3NDEKTSV4RRFFQ69G5FAV' as never });
    expect(
      checkEdgeWrite(
        { type: 'DEPENDS_ON', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
        context({ from: foreign }),
      ).some((v) => v.invariant === 'G11'),
    ).toBe(true);
  });

  it('G1: flags a second CONTAINS parent', () => {
    const violations = checkEdgeWrite(
      { type: 'CONTAINS', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
      context({ from: graphNode({ type: 'PROJECT' }), existingContainsParent: NODE_A }),
    );
    expect(violations.some((v) => v.invariant === 'G1')).toBe(true);
  });

  it('G2: flags a self-loop', () => {
    const violations = checkEdgeWrite(
      { type: 'DEPENDS_ON', from: NODE_A, to: NODE_A, authority: 'EVIDENCE' },
      context({ to: graphNode({ id: NODE_A }) }),
    );
    expect(violations.some((v) => v.invariant === 'G2')).toBe(true);
  });

  it('G3: REJECTS a component-level cycle but only RECORDS a file-level one', () => {
    const component = checkEdgeWrite(
      { type: 'DEPENDS_ON', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
      context({
        from: graphNode({ type: 'COMPONENT' }),
        to: graphNode({ type: 'COMPONENT' }),
        wouldCreateCycle: true,
      }),
    );
    expect(component.find((v) => v.invariant === 'G3')?.disposition).toBe('REJECT');

    const file = checkEdgeWrite(
      { type: 'DEPENDS_ON', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
      context({
        from: graphNode({ type: 'FILE' }),
        to: graphNode({ type: 'FILE' }),
        wouldCreateCycle: true,
      }),
    );
    expect(file.find((v) => v.invariant === 'G3')?.disposition).toBe('OBSERVE');
    expect(rejections(file)).toEqual([]);
  });

  it('G2/G5: flags a cycle on CONTAINS and on SUPERSEDES', () => {
    const contains = checkEdgeWrite(
      { type: 'CONTAINS', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
      context({ from: graphNode({ type: 'PROJECT' }), wouldCreateCycle: true }),
    );
    expect(contains.some((v) => v.invariant === 'G2')).toBe(true);

    const supersedes = checkEdgeWrite(
      { type: 'SUPERSEDES', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
      context({ wouldCreateCycle: true }),
    );
    expect(supersedes.some((v) => v.invariant === 'G5')).toBe(true);
  });

  it('ignores a cycle flag on an edge type with no acyclicity rule', () => {
    const violations = checkEdgeWrite(
      { type: 'AFFECTS', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
      context({ wouldCreateCycle: true }),
    );
    expect(violations).toEqual([]);
  });

  it('G5: flags mismatched types on SUPERSEDES', () => {
    const violations = checkEdgeWrite(
      { type: 'SUPERSEDES', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
      context({ from: graphNode({ type: 'COMPONENT' }), to: graphNode({ type: 'FILE' }) }),
    );
    expect(violations.some((v) => v.invariant === 'G5')).toBe(true);
  });

  it('reports every violation, not only the first', () => {
    const violations = checkEdgeWrite(
      { type: 'CALLS', from: NODE_A, to: NODE_A, authority: 'EVIDENCE' },
      context({
        from: graphNode({ id: NODE_A, type: 'TEST' }),
        to: graphNode({ id: NODE_A, type: 'TEST' }),
      }),
    );
    const kinds = new Set(violations.map((v) => v.invariant));
    expect(kinds.has('G7')).toBe(true);
    expect(kinds.has('G2')).toBe(true);
  });
});

describe('needsReciprocal', () => {
  it('is true for a symmetric type with no reciprocal yet', () => {
    expect(needsReciprocal('CONTRADICTS', { reciprocalExists: false })).toBe(true);
  });

  it('is false once the reciprocal exists', () => {
    expect(needsReciprocal('CONTRADICTS', { reciprocalExists: true })).toBe(false);
  });

  it('is false for an asymmetric type', () => {
    expect(needsReciprocal('DEPENDS_ON', { reciprocalExists: false })).toBe(false);
  });

  it('is false for an unknown type rather than throwing', () => {
    expect(needsReciprocal('TELEPORTS' as EdgeType, { reciprocalExists: false })).toBe(false);
  });
});

describe('checkStructuralGaps', () => {
  const view = (node: GraphNode, inbound: EdgeType[] = [], outbound: EdgeType[] = []) => ({
    node,
    inboundTypes: inbound,
    outboundTypes: outbound,
  });

  it('G8: an in-force requirement with no implementation', () => {
    const gaps = checkStructuralGaps(
      view(graphNode({ type: 'REQUIREMENT', attrs: { inForce: true } })),
    );
    expect(gaps.map((g) => g.invariant)).toEqual(['G8']);
    expect(gaps[0]?.disposition).toBe('OBSERVE');
  });

  it('G9: implemented but unverified', () => {
    const gaps = checkStructuralGaps(
      view(graphNode({ type: 'REQUIREMENT', attrs: { inForce: true } }), ['IMPLEMENTS']),
    );
    expect(gaps.map((g) => g.invariant)).toEqual(['G9']);
  });

  it('reports nothing once implemented and verified', () => {
    expect(
      checkStructuralGaps(
        view(graphNode({ type: 'REQUIREMENT', attrs: { inForce: true } }), [
          'IMPLEMENTS',
          'VERIFIES',
        ]),
      ),
    ).toEqual([]);
  });

  it('ignores a requirement that is not in force', () => {
    expect(
      checkStructuralGaps(view(graphNode({ type: 'REQUIREMENT', attrs: { inForce: false } }))),
    ).toEqual([]);
    expect(checkStructuralGaps(view(graphNode({ type: 'REQUIREMENT', attrs: {} })))).toEqual([]);
  });

  it('G13: a blocking open uncertainty that blocks nothing', () => {
    const gaps = checkStructuralGaps(
      view(graphNode({ type: 'UNCERTAINTY', attrs: { blocking: true, status: 'OPEN' } })),
    );
    expect(gaps.map((g) => g.invariant)).toEqual(['G13']);
  });

  it('G13: clears once it blocks something', () => {
    expect(
      checkStructuralGaps(
        view(
          graphNode({ type: 'UNCERTAINTY', attrs: { blocking: true, status: 'OPEN' } }),
          [],
          ['BLOCKS'],
        ),
      ),
    ).toEqual([]);
  });

  it('G13: ignores a non-blocking or resolved uncertainty', () => {
    expect(
      checkStructuralGaps(
        view(graphNode({ type: 'UNCERTAINTY', attrs: { blocking: false, status: 'OPEN' } })),
      ),
    ).toEqual([]);
    expect(
      checkStructuralGaps(
        view(graphNode({ type: 'UNCERTAINTY', attrs: { blocking: true, status: 'RESOLVED' } })),
      ),
    ).toEqual([]);
  });

  it('ignores node types it has no rule for', () => {
    expect(checkStructuralGaps(view(graphNode({ type: 'COMPONENT' })))).toEqual([]);
  });
});

describe('rejections', () => {
  it('keeps only the violations that stop a write', () => {
    const violations = checkEdgeWrite(
      { type: 'DEPENDS_ON', from: NODE_A, to: NODE_B, authority: 'EVIDENCE' },
      context({
        from: graphNode({ type: 'FILE' }),
        to: graphNode({ type: 'FILE' }),
        wouldCreateCycle: true,
      }),
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(rejections(violations)).toEqual([]);
  });
});
