/**
 * Traversal options, depth caps and impact analysis (SPEC-03 §5).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1) for one reason: G12. A traversal that loses
 * its project scope returns another project's nodes, and the system would then
 * reason confidently about the wrong project. The scope is therefore threaded
 * through every step and the caps are enforced here rather than per adapter.
 *
 * The caps exist because of the anti-pattern this architecture is defined
 * against: no query may accidentally pull the whole graph into a model context.
 * `limit` is mandatory and `depth` is hard-capped — not defaults a caller can
 * quietly exceed.
 */

import {
  type Authority,
  authorityRank,
  type EdgeType,
  type NodeId,
  ValidationError,
} from '@genesis/core-types';
import type { GraphEdge } from './schema.js';

/** Hard ceiling on traversal depth. Not a default — a cap. */
export const MAX_TRAVERSAL_DEPTH = 6;
export const DEFAULT_NEIGHBOURHOOD_DEPTH = 3;
export const MAX_TRAVERSAL_LIMIT = 1_000;

/** Hard ceiling and default for impact analysis specifically (SPEC-03 §5.1). */
export const MAX_IMPACT_DEPTH = 6;
export const DEFAULT_IMPACT_DEPTH = 4;

export type Direction = 'out' | 'in' | 'both';

export interface NeighbourhoodOptions {
  readonly depth?: number | undefined;
  readonly edgeTypes?: readonly EdgeType[] | undefined;
  readonly direction?: Direction | undefined;
  readonly minAuthority?: Authority | undefined;
  /** Mandatory: there is no unbounded neighbourhood query. */
  readonly limit: number;
}

export interface ImpactOptions {
  readonly maxDepth?: number | undefined;
  readonly limit?: number | undefined;
}

export interface PathOptions {
  readonly maxDepth: number;
  readonly edgeTypes?: readonly EdgeType[] | undefined;
  readonly limit?: number | undefined;
}

/**
 * The edge types impact propagates along, and in which direction (SPEC-03 §5.1).
 *
 * Outbound `AFFECTS`: whatever this node affects is impacted.
 * Inbound for the rest: whatever depends on, calls, reads, writes or implements
 * this node is impacted when this node changes.
 */
export const IMPACT_OUTBOUND: readonly EdgeType[] = ['AFFECTS'];
export const IMPACT_INBOUND: readonly EdgeType[] = [
  'DEPENDS_ON',
  'CALLS',
  'READS',
  'WRITES',
  'IMPLEMENTS',
];

export function clampDepth(requested: number | undefined, fallback: number, cap: number): number {
  const depth = requested ?? fallback;
  if (!Number.isInteger(depth) || depth < 0) {
    throw new ValidationError('traversal depth must be a non-negative integer', { depth });
  }
  return Math.min(depth, cap);
}

export function clampLimit(requested: number | undefined, fallback: number): number {
  const limit = requested ?? fallback;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ValidationError('traversal limit must be a positive integer', { limit });
  }
  return Math.min(limit, MAX_TRAVERSAL_LIMIT);
}

/** True when an edge passes the traversal filters. */
export function edgeMatches(
  edge: GraphEdge,
  filters: { edgeTypes?: readonly EdgeType[] | undefined; minAuthority?: Authority | undefined },
): boolean {
  if (edge.status !== 'ACTIVE') return false;
  if (filters.edgeTypes !== undefined && !filters.edgeTypes.includes(edge.type)) return false;
  if (
    filters.minAuthority !== undefined &&
    authorityRank(edge.authority) > authorityRank(filters.minAuthority)
  ) {
    return false;
  }
  return true;
}

export interface ImpactEntry {
  readonly nodeId: NodeId;
  /** Shortest number of hops from the origin. */
  readonly depth: number;
  /**
   * Rank of the weakest edge on the path that reached this node.
   *
   * Impact inherited through a guessed relationship is worth less than impact
   * through an observed one, and the weakest link is what governs — a chain is
   * only as well established as its least established step.
   */
  readonly weakestAuthorityRank: number;
}

/**
 * Orders an impact set: nearest first, then best-established, then by id.
 *
 * The id tiebreak keeps the order stable across adapters, which matters because
 * both must return identical results for the conformance suite to mean
 * anything.
 */
export function rankImpact(entries: readonly ImpactEntry[]): ImpactEntry[] {
  return [...entries].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.weakestAuthorityRank !== b.weakestAuthorityRank) {
      return a.weakestAuthorityRank - b.weakestAuthorityRank;
    }
    // Two arms, not three: entries are collected in a Map keyed by node id, so
    // two entries can never share one. An equality arm would be unreachable,
    // and unreachable branches in a module held to 100% coverage mean the code
    // is modelling a case the problem does not have.
    return a.nodeId < b.nodeId ? -1 : 1;
  });
}
