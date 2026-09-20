/**
 * A `GraphStore` over any storage that can load and write nodes and edges
 * (ADR-0025 §1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). Invariants G1–G13 and every bounded traversal
 * live here, once, so an adapter supplies storage and inherits the rules rather
 * than restating them. A second implementation of "what an impact set is" would
 * drift, and the drift would show as one backend reporting an impact the other
 * missed — which is the input to a change's policy check (SPEC-05 §3.2).
 *
 * G12 is structural rather than a filter someone must remember: the storage
 * interface is project-scoped, so a walk is over one project's edges by
 * construction and cannot leave it.
 *
 * Every traversal is bounded before it starts — depth by `clampDepth`, breadth
 * by `clampLimit` — because an unbounded walk over a graph that grew is an
 * outage rather than a slow answer.
 */

import {
  assertInScope,
  authorityRank,
  type EdgeId,
  type EventId,
  newEdgeId,
  newNodeId,
  type NodeId,
  type ProjectScope,
  ValidationError,
} from '@genesis/core-types';
import {
  checkEdgeWrite,
  checkStructuralGaps,
  type EdgeWriteContext,
  type InvariantViolation,
  InvariantViolationError,
  needsReciprocal,
  rejections,
} from './invariants.js';
import type {
  AddEdgeResult,
  GraphStore,
  GraphWriteContext,
  OrphanCriteria,
  OrphanFinding,
} from './port.js';
import {
  type EdgeStatus,
  GraphEdge,
  GraphNode,
  type GraphPath,
  NewEdge,
  NewNode,
  type NodeStatus,
  type Subgraph,
  TRAVERSABLE_NODE_STATUSES,
} from './schema.js';
import {
  clampDepth,
  clampLimit,
  DEFAULT_IMPACT_DEPTH,
  DEFAULT_NEIGHBOURHOOD_DEPTH,
  edgeMatches,
  type ImpactEntry,
  IMPACT_INBOUND,
  IMPACT_OUTBOUND,
  type ImpactOptions,
  MAX_IMPACT_DEPTH,
  MAX_TRAVERSAL_DEPTH,
  type NeighbourhoodOptions,
  type PathOptions,
  rankImpact,
} from './traversal.js';

/**
 * What an adapter must provide. Deliberately six methods: anything richer would
 * be a query language, and the point is that the rules live above this line.
 */
export interface GraphStorage {
  loadNodes(scope: ProjectScope): Promise<GraphNode[]>;
  loadEdges(scope: ProjectScope): Promise<GraphEdge[]>;
  /**
   * A node by id **wherever it lives**, not only in one project.
   *
   * Two rules need this. A cross-project id must be refused rather than answer
   * null (ADR-0008 rule 6), and G11 must be able to say "that endpoint is in
   * another project" rather than "that endpoint does not exist" — which is a
   * different diagnosis of a different mistake. Scoping is applied above this
   * line, where the refusal belongs.
   */
  getNodeAnywhere(id: NodeId): Promise<GraphNode | null>;
  getEdgeAnywhere(id: EdgeId): Promise<GraphEdge | null>;
  putNode(scope: ProjectScope, node: GraphNode): Promise<void>;
  putEdge(scope: ProjectScope, edge: GraphEdge): Promise<void>;
  close(): Promise<void>;
}

export class GraphEngine implements GraphStore {
  readonly #queues = new Map<string, Promise<unknown>>();
  #closed = false;

  constructor(private readonly storage: GraphStorage) {}

  #assertOpen(): void {
    if (this.#closed) throw new ValidationError('graph store is closed');
  }

  /** Serialised per project: the invariant checks read what the write depends on. */
  async #serialise<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(projectId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.#queues.set(
      projectId,
      next.catch(() => undefined),
    );
    return next;
  }

  async addNode(scope: ProjectScope, node: NewNode, ctx: GraphWriteContext = {}): Promise<GraphNode> {
    this.#assertOpen();
    return this.#serialise(scope.projectId, async () => {
      const parsed = NewNode.safeParse(node);
      if (!parsed.success) {
        throw new ValidationError('invalid graph node', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      const at = (ctx.now ?? ((): Date => new Date()))().toISOString();
      const built = GraphNode.parse({
        id: (ctx.newNodeId ?? newNodeId)(),
        projectId: scope.projectId,
        type: parsed.data.type,
        label: parsed.data.label,
        recordRef: parsed.data.recordRef,
        status: 'ACTIVE',
        attrs: parsed.data.attrs,
        createdAt: at,
        updatedAt: at,
        version: 1,
        statusCause: null,
      });
      await this.storage.putNode(scope, built);
      return built;
    });
  }

  /** Is there already a path from `from` to `to` along active edges of `type`? */
  #hasPath(edges: readonly GraphEdge[], from: NodeId, to: NodeId, type: GraphEdge['type']): boolean {
    const usable = edges.filter((e) => e.type === type && e.status === 'ACTIVE');
    const seen = new Set<string>([from]);
    let frontier: NodeId[] = [from];
    for (let hop = 0; hop < MAX_TRAVERSAL_DEPTH && frontier.length > 0; hop += 1) {
      const next: NodeId[] = [];
      for (const current of frontier) {
        for (const edge of usable) {
          if (edge.from !== current || seen.has(edge.to)) continue;
          if (edge.to === to) return true;
          seen.add(edge.to);
          next.push(edge.to);
        }
      }
      frontier = next;
    }
    return false;
  }

  async addEdge(scope: ProjectScope, edge: NewEdge, ctx: GraphWriteContext = {}): Promise<AddEdgeResult> {
    this.#assertOpen();
    return this.#serialise(scope.projectId, async () => {
      const parsed = NewEdge.safeParse(edge);
      if (!parsed.success) {
        throw new ValidationError('invalid graph edge', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      const value = parsed.data;
      // Endpoints are resolved globally so that an edge to another project's
      // node is refused as G11 — a boundary crossing — rather than as G6, a
      // missing node. The two are different mistakes with different fixes.
      const [edges, from, to] = await Promise.all([
        this.storage.loadEdges(scope),
        this.storage.getNodeAnywhere(value.from),
        this.storage.getNodeAnywhere(value.to),
      ]);

      const existingContainsParent =
        value.type === 'CONTAINS'
          ? (edges.find((e) => e.type === 'CONTAINS' && e.to === value.to && e.status === 'ACTIVE')?.from ?? null)
          : null;

      // A new edge from->to closes a cycle exactly when a path already runs
      // to->from along the same edge type.
      const wouldCreateCycle = from !== null && to !== null && this.#hasPath(edges, value.to, value.from, value.type);
      const reciprocalExists = edges.some((e) => e.type === value.type && e.from === value.to && e.to === value.from);

      const context: EdgeWriteContext = {
        projectId: scope.projectId,
        from,
        to,
        existingContainsParent,
        wouldCreateCycle,
        reciprocalExists,
      };
      const violations = checkEdgeWrite(value, context);
      const blocking = rejections(violations);
      if (blocking.length > 0) throw new InvariantViolationError(blocking[0] as InvariantViolation);

      const at = (ctx.now ?? ((): Date => new Date()))().toISOString();
      const mintEdgeId = ctx.newEdgeId ?? newEdgeId;
      const built = GraphEdge.parse({
        id: mintEdgeId(),
        projectId: scope.projectId,
        type: value.type,
        from: value.from,
        to: value.to,
        authority: value.authority,
        evidenceRefs: value.evidenceRefs,
        weight: value.weight,
        status: 'ACTIVE',
        createdAt: at,
        updatedAt: at,
        version: 1,
        createdByCycle: value.createdByCycle,
        reciprocalOf: null,
      });
      await this.storage.putEdge(scope, built);

      // G4 — auto-repair symmetry. Written after the edge it mirrors, and
      // marked as a reciprocal so the repair is visible rather than looking
      // like something a caller did.
      let reciprocal: GraphEdge | null = null;
      if (needsReciprocal(value.type, { reciprocalExists })) {
        reciprocal = GraphEdge.parse({ ...built, id: mintEdgeId(), from: value.to, to: value.from, reciprocalOf: built.id });
        await this.storage.putEdge(scope, reciprocal);
      }

      // Observations are returned rather than thrown: a recorded file-level
      // cycle is worth knowing about and not worth blocking a write for.
      return { edge: built, reciprocal, observations: violations.filter((v) => v.disposition !== 'REJECT') };
    });
  }

  async getNode(scope: ProjectScope, id: NodeId): Promise<GraphNode | null> {
    this.#assertOpen();
    const node = await this.storage.getNodeAnywhere(id);
    if (node === null) return null;
    // Cross-project access is an error, not an empty result (ADR-0008 rule 6).
    assertInScope(scope, node.projectId, `graph node ${id}`);
    return node;
  }

  async getEdge(scope: ProjectScope, id: EdgeId): Promise<GraphEdge | null> {
    this.#assertOpen();
    const edge = await this.storage.getEdgeAnywhere(id);
    if (edge === null) return null;
    assertInScope(scope, edge.projectId, `graph edge ${id}`);
    return edge;
  }

  async #requireNode(scope: ProjectScope, id: NodeId): Promise<GraphNode> {
    const node = await this.getNode(scope, id);
    if (node === null) throw new ValidationError(`no graph node ${id}`, { id });
    return node;
  }

  async edgesOf(scope: ProjectScope, id: NodeId): Promise<GraphEdge[]> {
    this.#assertOpen();
    await this.#requireNode(scope, id);
    const edges = await this.storage.loadEdges(scope);
    return edges.filter((e) => e.from === id || e.to === id);
  }

  async neighbourhood(scope: ProjectScope, id: NodeId, options: NeighbourhoodOptions): Promise<Subgraph> {
    this.#assertOpen();
    const origin = await this.#requireNode(scope, id);
    const depth = clampDepth(options.depth, DEFAULT_NEIGHBOURHOOD_DEPTH, MAX_TRAVERSAL_DEPTH);
    const limit = clampLimit(options.limit, options.limit);
    const direction = options.direction ?? 'both';

    const [allNodes, allEdges] = await Promise.all([this.storage.loadNodes(scope), this.storage.loadEdges(scope)]);
    const byId = new Map(allNodes.map((n) => [n.id as string, n]));
    const edges = allEdges.filter((e) => edgeMatches(e, options));

    const nodes = new Map<string, GraphNode>([[origin.id, origin]]);
    const collected = new Map<string, GraphEdge>();
    let frontier: NodeId[] = [origin.id];
    let truncated = false;

    for (let hop = 0; hop < depth && frontier.length > 0 && !truncated; hop += 1) {
      const next: NodeId[] = [];
      for (const current of frontier) {
        for (const edge of edges) {
          const outward = edge.from === current && direction !== 'in';
          const inward = edge.to === current && direction !== 'out';
          if (!outward && !inward) continue;

          const otherId = outward ? edge.to : edge.from;
          const other = byId.get(otherId);
          // G12: the edges are already project-scoped, so `other` cannot be
          // foreign. The status filter keeps deleted nodes from carrying the
          // walk onward.
          if (other === undefined || !TRAVERSABLE_NODE_STATUSES.includes(other.status)) continue;

          collected.set(edge.id, edge);
          if (!nodes.has(otherId)) {
            if (nodes.size >= limit) {
              truncated = true;
              break;
            }
            nodes.set(otherId, other);
            next.push(otherId);
          }
        }
        if (truncated) break;
      }
      frontier = next;
    }

    return { nodes: [...nodes.values()], edges: [...collected.values()], truncated };
  }

  async impactSet(scope: ProjectScope, id: NodeId, options: ImpactOptions = {}): Promise<ImpactEntry[]> {
    this.#assertOpen();
    await this.#requireNode(scope, id);
    const maxDepth = clampDepth(options.maxDepth, DEFAULT_IMPACT_DEPTH, MAX_IMPACT_DEPTH);
    const limit = clampLimit(options.limit, 1_000);

    const [allNodes, allEdges] = await Promise.all([this.storage.loadNodes(scope), this.storage.loadEdges(scope)]);
    const byId = new Map(allNodes.map((n) => [n.id as string, n]));
    const edges = allEdges.filter((e) => e.status === 'ACTIVE');

    const best = new Map<string, ImpactEntry>();
    let frontier: ImpactEntry[] = [{ nodeId: id, depth: 0, weakestAuthorityRank: 0 }];

    for (let hop = 1; hop <= maxDepth && frontier.length > 0; hop += 1) {
      const next: ImpactEntry[] = [];
      for (const current of frontier) {
        for (const edge of edges) {
          let neighbour: NodeId | null = null;
          if (edge.from === current.nodeId && IMPACT_OUTBOUND.includes(edge.type)) neighbour = edge.to;
          else if (edge.to === current.nodeId && IMPACT_INBOUND.includes(edge.type)) neighbour = edge.from;
          if (neighbour === null || neighbour === id) continue;

          const node = byId.get(neighbour);
          if (node === undefined || !TRAVERSABLE_NODE_STATUSES.includes(node.status)) continue;

          // The weakest link governs: a chain is only as well established as
          // its least established step.
          const weakest = Math.max(current.weakestAuthorityRank, authorityRank(edge.authority));
          const entry: ImpactEntry = { nodeId: neighbour, depth: hop, weakestAuthorityRank: weakest };
          const seen = best.get(neighbour);
          if (
            seen === undefined ||
            entry.depth < seen.depth ||
            (entry.depth === seen.depth && entry.weakestAuthorityRank < seen.weakestAuthorityRank)
          ) {
            best.set(neighbour, entry);
            next.push(entry);
          }
        }
      }
      frontier = next;
    }

    return rankImpact([...best.values()]).slice(0, limit);
  }

  async paths(scope: ProjectScope, from: NodeId, to: NodeId, options: PathOptions): Promise<GraphPath[]> {
    this.#assertOpen();
    await this.#requireNode(scope, from);
    await this.#requireNode(scope, to);
    const maxDepth = clampDepth(options.maxDepth, MAX_TRAVERSAL_DEPTH, MAX_TRAVERSAL_DEPTH);
    const limit = clampLimit(options.limit, 100);

    const [allNodes, allEdges] = await Promise.all([this.storage.loadNodes(scope), this.storage.loadEdges(scope)]);
    const byId = new Map(allNodes.map((n) => [n.id as string, n]));
    const edges = allEdges.filter((e) => edgeMatches(e, options));
    const found: GraphPath[] = [];

    const walk = (current: NodeId, nodes: NodeId[], edgeIds: EdgeId[], depth: number): void => {
      if (found.length >= limit) return;
      if (current === to && nodes.length > 1) {
        found.push({ nodes: [...nodes], edges: [...edgeIds] });
        return;
      }
      if (depth >= maxDepth) return;
      for (const edge of edges) {
        if (edge.from !== current) continue;
        if (nodes.includes(edge.to)) continue; // no revisits; keeps paths simple
        const node = byId.get(edge.to);
        if (node === undefined || !TRAVERSABLE_NODE_STATUSES.includes(node.status)) continue;
        walk(edge.to, [...nodes, edge.to], [...edgeIds, edge.id], depth + 1);
      }
    };

    walk(from, [from], [], 0);
    return found;
  }

  async findOrphans(scope: ProjectScope, criteria: OrphanCriteria = {}): Promise<OrphanFinding[]> {
    this.#assertOpen();
    const wanted = criteria.invariants ?? ['G8', 'G9', 'G13'];
    const limit = clampLimit(criteria.limit, 1_000);
    const [nodes, allEdges] = await Promise.all([this.storage.loadNodes(scope), this.storage.loadEdges(scope)]);
    const edges = allEdges.filter((e) => e.status === 'ACTIVE');

    const findings: OrphanFinding[] = [];
    for (const node of nodes) {
      if (node.status !== 'ACTIVE') continue;
      if (criteria.nodeTypes !== undefined && !criteria.nodeTypes.includes(node.type)) continue;

      const violations = checkStructuralGaps({
        node,
        inboundTypes: edges.filter((e) => e.to === node.id).map((e) => e.type),
        outboundTypes: edges.filter((e) => e.from === node.id).map((e) => e.type),
      });
      for (const violation of violations) {
        if (!wanted.includes(violation.invariant as 'G8' | 'G9' | 'G13')) continue;
        findings.push({ node, violation });
        if (findings.length >= limit) return findings;
      }
    }
    return findings;
  }

  async transitionNode(scope: ProjectScope, id: NodeId, status: NodeStatus, cause: EventId | null): Promise<GraphNode> {
    this.#assertOpen();
    return this.#serialise(scope.projectId, async () => {
      // Through `getNode`, so a foreign id is a scope mismatch rather than a
      // "no such node" that hides which project it was in.
      const node = await this.#requireNode(scope, id);
      const moved = GraphNode.parse({
        ...node,
        status,
        statusCause: cause,
        updatedAt: new Date().toISOString(),
        version: node.version + 1,
      });
      await this.storage.putNode(scope, moved);
      return moved;
    });
  }

  async transitionEdge(scope: ProjectScope, id: EdgeId, status: EdgeStatus, cause: EventId | null): Promise<GraphEdge> {
    this.#assertOpen();
    return this.#serialise(scope.projectId, async () => {
      const edge = await this.getEdge(scope, id);
      if (edge === null) throw new ValidationError(`no graph edge ${id}`, { id });
      // An edge carries no `statusCause`: the schema has none, so the cause is
      // the ledger event that drove the transition rather than a field here.
      void cause;
      const moved = GraphEdge.parse({ ...edge, status, updatedAt: new Date().toISOString(), version: edge.version + 1 });
      await this.storage.putEdge(scope, moved);
      return moved;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.storage.close();
  }
}
