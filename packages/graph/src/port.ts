/**
 * The GraphStore port (SPEC-03 §5).
 *
 * The core depends on this, never on a database.
 *
 * Note what is ABSENT: there is no `deleteNode` and no `deleteEdge`. G10 says
 * nodes are never hard-deleted, and the absence of the method is how that is
 * guaranteed rather than merely intended. Removal is
 * `transitionNode(..., 'DELETED_LOGICALLY', ...)`.
 *
 * Every method takes a `ProjectScope` first, so an unscoped traversal is not
 * expressible (ADR-0008, G12).
 */

import type { EdgeId, EventId, NodeId, NodeType, ProjectScope } from '@genesis/core-types';
import type { InvariantViolation } from './invariants.js';
import type {
  EdgeStatus,
  GraphEdge,
  GraphNode,
  GraphPath,
  NewEdge,
  NewNode,
  NodeStatus,
  Subgraph,
} from './schema.js';
import type { ImpactEntry, ImpactOptions, NeighbourhoodOptions, PathOptions } from './traversal.js';

export interface GraphWriteContext {
  readonly now?: (() => Date) | undefined;
  readonly newNodeId?: (() => NodeId) | undefined;
  readonly newEdgeId?: (() => EdgeId) | undefined;
}

export interface AddEdgeResult {
  readonly edge: GraphEdge;
  /** The reciprocal written to keep CONTRADICTS symmetric (G4), if any. */
  readonly reciprocal: GraphEdge | null;
  /**
   * Violations that did NOT stop the write — the `OBSERVE` ones. A file-level
   * dependency cycle, for instance: real, recorded, not blocked.
   */
  readonly observations: readonly InvariantViolation[];
}

export interface OrphanCriteria {
  /** Restrict the scan to these node types. Defaults to all. */
  readonly nodeTypes?: readonly NodeType[] | undefined;
  /** Which structural gaps to look for. Defaults to all of G8, G9, G13. */
  readonly invariants?: readonly ('G8' | 'G9' | 'G13')[] | undefined;
  readonly limit?: number | undefined;
}

export interface OrphanFinding {
  readonly node: GraphNode;
  readonly violation: InvariantViolation;
}

export interface GraphStore {
  addNode(scope: ProjectScope, node: NewNode, ctx?: GraphWriteContext): Promise<GraphNode>;

  /**
   * Adds an edge after checking G1–G7 and G11.
   *
   * Rejects with `InvariantViolationError` on any `REJECT` violation. Returns
   * observations for the rest, so the caller learns about a recorded file-level
   * cycle without the write being blocked.
   */
  addEdge(scope: ProjectScope, edge: NewEdge, ctx?: GraphWriteContext): Promise<AddEdgeResult>;

  getNode(scope: ProjectScope, id: NodeId): Promise<GraphNode | null>;
  getEdge(scope: ProjectScope, id: EdgeId): Promise<GraphEdge | null>;

  /** Every edge touching this node, in either direction. */
  edgesOf(scope: ProjectScope, id: NodeId): Promise<GraphEdge[]>;

  /** Bounded traversal. `limit` is mandatory; `depth` is hard-capped. */
  neighbourhood(
    scope: ProjectScope,
    id: NodeId,
    options: NeighbourhoodOptions,
  ): Promise<Subgraph>;

  /**
   * Nodes whose behaviour may change if `id` changes (SPEC-03 §5.1).
   *
   * Ranked nearest-first, then by how well established the weakest edge on the
   * path is. The origin node is not included in its own impact set.
   */
  impactSet(scope: ProjectScope, id: NodeId, options?: ImpactOptions): Promise<ImpactEntry[]>;

  paths(
    scope: ProjectScope,
    from: NodeId,
    to: NodeId,
    options: PathOptions,
  ): Promise<GraphPath[]>;

  /** The structural gaps the graph notices about itself: G8, G9, G13. */
  findOrphans(scope: ProjectScope, criteria?: OrphanCriteria): Promise<OrphanFinding[]>;

  transitionNode(
    scope: ProjectScope,
    id: NodeId,
    status: NodeStatus,
    cause: EventId | null,
  ): Promise<GraphNode>;

  transitionEdge(
    scope: ProjectScope,
    id: EdgeId,
    status: EdgeStatus,
    cause: EventId | null,
  ): Promise<GraphEdge>;

  close(): Promise<void>;
}
