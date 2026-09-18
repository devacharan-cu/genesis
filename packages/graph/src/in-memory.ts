/**
 * In-memory GraphStore adapter.
 *
 * The reference semantics for traversal. The SQLite adapter must produce
 * identical results through recursive CTEs, and the shared conformance suite is
 * what proves it (ADR-0003) — the point of having two implementations from the
 * start.
 *
 * Not durable.
 */

import {
  assertInScope,
  type EdgeId,
  type EventId,
  newEdgeId,
  newNodeId,
  type NodeId,
  type ProjectScope,
  ValidationError,
  authorityRank,
} from '@genesis/core-types';
import {
  checkEdgeWrite,
  checkStructuralGaps,
  type EdgeWriteContext,
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
  GraphEdge,
  GraphNode,
  type EdgeStatus,
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
  type ImpactOptions,
  IMPACT_INBOUND,
  IMPACT_OUTBOUND,
  MAX_IMPACT_DEPTH,
  MAX_TRAVERSAL_DEPTH,
  type NeighbourhoodOptions,
  type PathOptions,
  rankImpact,
} from './traversal.js';

export class InMemoryGraphStore implements GraphStore {
  readonly #nodes = new Map<string, GraphNode>();
  readonly #edges = new Map<string, GraphEdge>();
  readonly #queues = new Map<string, Promise<unknown>>();
  #closed = false;

  #assertOpen(): void {
    if (this.#closed) throw new ValidationError('graph store is closed');
  }

  async #serialise<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(projectId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.#queues.set(
      projectId,
      next.catch(() => undefined),
    );
    return next;
  }

  #nodesIn(scope: ProjectScope): GraphNode[] {
    return [...this.#nodes.values()].filter((n) => n.projectId === scope.projectId);
  }

  /**
   * Every edge in the scoped project.
   *
   * G12 lives here: traversal only ever sees edges of one project, so a walk
   * physically cannot leave it. Combined with G11 (no edge crosses a boundary)
   * the isolation is structural rather than a filter someone might forget.
   */
  #edgesIn(scope: ProjectScope): GraphEdge[] {
    return [...this.#edges.values()].filter((e) => e.projectId === scope.projectId);
  }

  async addNode(
    scope: ProjectScope,
    node: NewNode,
    ctx: GraphWriteContext = {},
  ): Promise<GraphNode> {
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
      this.#nodes.set(built.id, built);
      return { ...built };
    });
  }

  /** Is there already a path from `from` to `to` along edges of `type`? */
  #hasPath(scope: ProjectScope, from: NodeId, to: NodeId, type: GraphEdge['type']): boolean {
    const edges = this.#edgesIn(scope).filter((e) => e.type === type && e.status === 'ACTIVE');
    const seen = new Set<string>([from]);
    const queue: NodeId[] = [from];
    while (queue.length > 0) {
      const current = queue.shift() as NodeId;
      if (current === to) return true;
      for (const edge of edges) {
        if (edge.from === current && !seen.has(edge.to)) {
          seen.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    return false;
  }

  async addEdge(
    scope: ProjectScope,
    edge: NewEdge,
    ctx: GraphWriteContext = {},
  ): Promise<AddEdgeResult> {
    this.#assertOpen();
    return this.#serialise(scope.projectId, async () => {
      const parsed = NewEdge.safeParse(edge);
      if (!parsed.success) {
        throw new ValidationError('invalid graph edge', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      const value = parsed.data;

      const from = this.#nodes.get(value.from) ?? null;
      const to = this.#nodes.get(value.to) ?? null;

      const containsParent =
        value.type === 'CONTAINS'
          ? (this.#edgesIn(scope).find(
              (e) => e.type === 'CONTAINS' && e.to === value.to && e.status === 'ACTIVE',
            )?.from ?? null)
          : null;

      // A new edge from->to closes a cycle exactly when a path already runs
      // to->from along the same edge type.
      const wouldCreateCycle =
        from !== null && to !== null && this.#hasPath(scope, value.to, value.from, value.type);

      const reciprocalExists = this.#edgesIn(scope).some(
        (e) => e.type === value.type && e.from === value.to && e.to === value.from,
      );

      const context: EdgeWriteContext = {
        projectId: scope.projectId,
        from,
        to,
        existingContainsParent: containsParent,
        wouldCreateCycle,
        reciprocalExists,
      };

      const violations = checkEdgeWrite(value, context);
      const blocking = rejections(violations);
      if (blocking.length > 0) {
        throw new InvariantViolationError(blocking[0] as (typeof blocking)[number]);
      }

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
      this.#edges.set(built.id, built);

      // G4 — auto-repair symmetry.
      let reciprocal: GraphEdge | null = null;
      if (needsReciprocal(value.type, { reciprocalExists })) {
        reciprocal = GraphEdge.parse({
          ...built,
          id: mintEdgeId(),
          from: value.to,
          to: value.from,
          reciprocalOf: built.id,
        });
        this.#edges.set(reciprocal.id, reciprocal);
      }

      return {
        edge: { ...built },
        reciprocal: reciprocal === null ? null : { ...reciprocal },
        observations: violations.filter((v) => v.disposition !== 'REJECT'),
      };
    });
  }

  async getNode(scope: ProjectScope, id: NodeId): Promise<GraphNode | null> {
    this.#assertOpen();
    const found = this.#nodes.get(id);
    if (found === undefined) return null;
    assertInScope(scope, found.projectId, `graph node ${id}`);
    return { ...found };
  }

  async getEdge(scope: ProjectScope, id: EdgeId): Promise<GraphEdge | null> {
    this.#assertOpen();
    const found = this.#edges.get(id);
    if (found === undefined) return null;
    assertInScope(scope, found.projectId, `graph edge ${id}`);
    return { ...found };
  }

  async edgesOf(scope: ProjectScope, id: NodeId): Promise<GraphEdge[]> {
    this.#assertOpen();
    await this.#requireNode(scope, id);
    return this.#edgesIn(scope)
      .filter((e) => e.from === id || e.to === id)
      .map((e) => ({ ...e }));
  }

  async #requireNode(scope: ProjectScope, id: NodeId): Promise<GraphNode> {
    const node = await this.getNode(scope, id);
    if (node === null) throw new ValidationError(`no graph node ${id}`, { id });
    return node;
  }

  async neighbourhood(
    scope: ProjectScope,
    id: NodeId,
    options: NeighbourhoodOptions,
  ): Promise<Subgraph> {
    this.#assertOpen();
    const origin = await this.#requireNode(scope, id);
    const depth = clampDepth(options.depth, DEFAULT_NEIGHBOURHOOD_DEPTH, MAX_TRAVERSAL_DEPTH);
    const limit = clampLimit(options.limit, options.limit);
    const direction = options.direction ?? 'both';

    const edges = this.#edgesIn(scope).filter((e) => edgeMatches(e, options));
    const nodes = new Map<string, GraphNode>([[origin.id, origin]]);
    const collected = new Map<string, GraphEdge>();

    let frontier: NodeId[] = [origin.id];
    let truncated = false;

    for (let hop = 0; hop < depth && frontier.length > 0 && !truncated; hop++) {
      const next: NodeId[] = [];
      for (const current of frontier) {
        for (const edge of edges) {
          const outward = edge.from === current && direction !== 'in';
          const inward = edge.to === current && direction !== 'out';
          if (!outward && !inward) continue;

          const otherId = outward ? edge.to : edge.from;
          const other = this.#nodes.get(otherId);
          // G12: `edges` is already project-scoped, so `other` cannot be
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

    return {
      nodes: [...nodes.values()].map((n) => ({ ...n })),
      edges: [...collected.values()].map((e) => ({ ...e })),
      truncated,
    };
  }

  async impactSet(
    scope: ProjectScope,
    id: NodeId,
    options: ImpactOptions = {},
  ): Promise<ImpactEntry[]> {
    this.#assertOpen();
    await this.#requireNode(scope, id);
    const maxDepth = clampDepth(options.maxDepth, DEFAULT_IMPACT_DEPTH, MAX_IMPACT_DEPTH);
    const limit = clampLimit(options.limit, 1_000);

    const edges = this.#edgesIn(scope).filter((e) => e.status === 'ACTIVE');
    const best = new Map<string, ImpactEntry>();
    let frontier: ImpactEntry[] = [
      { nodeId: id, depth: 0, weakestAuthorityRank: 0 },
    ];

    for (let hop = 1; hop <= maxDepth && frontier.length > 0; hop++) {
      const next: ImpactEntry[] = [];
      for (const current of frontier) {
        for (const edge of edges) {
          let neighbour: NodeId | null = null;
          if (edge.from === current.nodeId && IMPACT_OUTBOUND.includes(edge.type)) {
            neighbour = edge.to;
          } else if (edge.to === current.nodeId && IMPACT_INBOUND.includes(edge.type)) {
            neighbour = edge.from;
          }
          if (neighbour === null || neighbour === id) continue;

          const node = this.#nodes.get(neighbour);
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

  async paths(
    scope: ProjectScope,
    from: NodeId,
    to: NodeId,
    options: PathOptions,
  ): Promise<GraphPath[]> {
    this.#assertOpen();
    await this.#requireNode(scope, from);
    await this.#requireNode(scope, to);
    const maxDepth = clampDepth(options.maxDepth, MAX_TRAVERSAL_DEPTH, MAX_TRAVERSAL_DEPTH);
    const limit = clampLimit(options.limit, 100);

    const edges = this.#edgesIn(scope).filter((e) => edgeMatches(e, options));
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
        const node = this.#nodes.get(edge.to);
        if (node === undefined || !TRAVERSABLE_NODE_STATUSES.includes(node.status)) continue;
        walk(edge.to, [...nodes, edge.to], [...edgeIds, edge.id], depth + 1);
      }
    };

    walk(from, [from], [], 0);
    return found;
  }

  async findOrphans(
    scope: ProjectScope,
    criteria: OrphanCriteria = {},
  ): Promise<OrphanFinding[]> {
    this.#assertOpen();
    const wanted = criteria.invariants ?? ['G8', 'G9', 'G13'];
    const limit = clampLimit(criteria.limit, 1_000);
    const edges = this.#edgesIn(scope).filter((e) => e.status === 'ACTIVE');
    const findings: OrphanFinding[] = [];

    for (const node of this.#nodesIn(scope)) {
      if (node.status !== 'ACTIVE') continue;
      if (criteria.nodeTypes !== undefined && !criteria.nodeTypes.includes(node.type)) continue;

      const violations = checkStructuralGaps({
        node,
        inboundTypes: edges.filter((e) => e.to === node.id).map((e) => e.type),
        outboundTypes: edges.filter((e) => e.from === node.id).map((e) => e.type),
      });

      for (const violation of violations) {
        if (!wanted.includes(violation.invariant as 'G8' | 'G9' | 'G13')) continue;
        findings.push({ node: { ...node }, violation });
        if (findings.length >= limit) return findings;
      }
    }
    return findings;
  }

  async transitionNode(
    scope: ProjectScope,
    id: NodeId,
    status: NodeStatus,
    cause: EventId | null,
  ): Promise<GraphNode> {
    this.#assertOpen();
    return this.#serialise(scope.projectId, async () => {
      const node = await this.#requireNode(scope, id);
      const updated: GraphNode = {
        ...node,
        status,
        statusCause: cause,
        updatedAt: new Date().toISOString(),
        version: node.version + 1,
      };
      this.#nodes.set(id, updated);
      return { ...updated };
    });
  }

  async transitionEdge(
    scope: ProjectScope,
    id: EdgeId,
    status: EdgeStatus,
    cause: EventId | null,
  ): Promise<GraphEdge> {
    this.#assertOpen();
    return this.#serialise(scope.projectId, async () => {
      const edge = await this.getEdge(scope, id);
      if (edge === null) throw new ValidationError(`no graph edge ${id}`, { id });
      void cause;
      const updated: GraphEdge = {
        ...edge,
        status,
        updatedAt: new Date().toISOString(),
        version: edge.version + 1,
      };
      this.#edges.set(id, updated);
      return { ...updated };
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
