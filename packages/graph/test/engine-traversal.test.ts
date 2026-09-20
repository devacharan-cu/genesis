/**
 * The traversal paths the shared conformance suite does not force.
 *
 * `GraphEngine` carries G1–G13 and the traversal rules for every storage
 * backend, so a branch here that no test reaches is a rule the DynamoDB store
 * inherits untested. These are the cases that need a particular graph shape:
 * a node reached twice by different routes, a walk that stops at a limit, a
 * status that makes a node untraversable.
 */

import {
  type EdgeId,
  newEdgeId,
  newProjectId,
  type NodeId,
  type ProjectScope,
  projectScope,
  ValidationError,
} from '@genesis/core-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { GraphEngine, type GraphStorage } from '../src/engine.js';
import type { GraphEdge, GraphNode } from '../src/schema.js';

/**
 * The smallest storage the engine can run on.
 *
 * The package's own `InMemoryGraphStore` is a complete `GraphStore`, not a
 * `GraphStorage`, so it cannot be handed to the engine. This is the storage
 * contract and nothing else: every rule under test belongs to the engine.
 */
class MapStorage implements GraphStorage {
  readonly #nodes = new Map<string, GraphNode>();
  readonly #edges = new Map<string, GraphEdge>();

  async loadNodes(scope: ProjectScope): Promise<GraphNode[]> {
    return [...this.#nodes.values()].filter((n) => n.projectId === scope.projectId);
  }

  async loadEdges(scope: ProjectScope): Promise<GraphEdge[]> {
    return [...this.#edges.values()].filter((e) => e.projectId === scope.projectId);
  }

  async getNodeAnywhere(id: NodeId): Promise<GraphNode | null> {
    return this.#nodes.get(id) ?? null;
  }

  async getEdgeAnywhere(id: EdgeId): Promise<GraphEdge | null> {
    return this.#edges.get(id) ?? null;
  }

  async putNode(_scope: ProjectScope, node: GraphNode): Promise<void> {
    this.#nodes.set(node.id, node);
  }

  async putEdge(_scope: ProjectScope, edge: GraphEdge): Promise<void> {
    this.#edges.set(edge.id, edge);
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

let graph: GraphEngine;
let scope: ProjectScope;

beforeEach(() => {
  graph = new GraphEngine(new MapStorage());
  scope = projectScope(newProjectId());
});

const node = async (label: string): Promise<GraphNode> => graph.addNode(scope, { type: 'COMPONENT', label });

/** A requirement that is in force, which is what G8 and G9 look at. */
const requirement = async (label: string): Promise<GraphNode> =>
  graph.addNode(scope, { type: 'REQUIREMENT', label, attrs: { inForce: true } });

/**
 * An impact edge from `from` to `to`.
 *
 * `AFFECTS` is the only outbound impact type (SPEC-03), so a traversal test has
 * to use it rather than `DEPENDS_ON`, which propagates the other way.
 */
const edge = async (
  from: NodeId,
  to: NodeId,
  authority: 'EVIDENCE' | 'AI_ASSUMPTION' | 'HUMAN_DECISION' = 'EVIDENCE',
): Promise<void> => {
  await graph.addEdge(scope, { type: 'AFFECTS', from, to, authority });
};

describe('the impact set', () => {
  it('keeps the shortest route to a node reached twice', async () => {
    // a -> b -> d and a -> d. `d` is reachable at depth 2 and at depth 1, and
    // the shallower entry must win however the edges are ordered.
    const [a, b, d] = [await node('a'), await node('b'), await node('d')];
    await edge(a.id, b.id);
    await edge(b.id, d.id);
    await edge(a.id, d.id);

    const impact = await graph.impactSet(scope, a.id, { maxDepth: 3 });
    expect(impact.find((entry) => entry.nodeId === d.id)?.depth).toBe(1);
  });

  it('prefers the better-established route at the same depth', async () => {
    // Two one-hop routes to the same node: the weakest link governs, so the
    // route through better evidence is the one recorded.
    const [a, c] = [await node('a'), await node('c')];
    await edge(a.id, c.id, 'AI_ASSUMPTION');
    await edge(a.id, c.id, 'HUMAN_DECISION');

    const impact = await graph.impactSet(scope, a.id, { maxDepth: 1 });
    const entry = impact.find((e) => e.nodeId === c.id);
    expect(entry?.depth).toBe(1);
    // Rank 1 is the strongest; the second edge improves on the first.
    expect(entry?.weakestAuthorityRank).toBe(1);
  });

  it('does not walk through a node that is no longer active', async () => {
    const [a, b, d] = [await node('a'), await node('b'), await node('d')];
    await edge(a.id, b.id);
    await edge(b.id, d.id);
    await graph.transitionNode(scope, b.id, 'DELETED_LOGICALLY', null);

    const impact = await graph.impactSet(scope, a.id, { maxDepth: 3 });
    expect(impact.map((entry) => entry.nodeId)).not.toContain(b.id);
    expect(impact.map((entry) => entry.nodeId)).not.toContain(d.id);
  });

  it('never reports the node it started from', async () => {
    const [a, b] = [await node('a'), await node('b')];
    await edge(a.id, b.id);
    await edge(b.id, a.id);
    const impact = await graph.impactSet(scope, a.id, { maxDepth: 3 });
    expect(impact.map((entry) => entry.nodeId)).toEqual([b.id]);
  });

  it('honours a limit', async () => {
    const a = await node('a');
    for (let i = 0; i < 5; i += 1) await edge(a.id, (await node(`n${i}`)).id);
    expect(await graph.impactSet(scope, a.id, { limit: 2 })).toHaveLength(2);
  });

  it('finds nothing from an isolated node', async () => {
    expect(await graph.impactSet(scope, (await node('alone')).id)).toEqual([]);
  });
});

describe('paths', () => {
  it('stops once it has as many as were asked for', async () => {
    // Three distinct one-hop-plus routes from a to z.
    const [a, z] = [await node('a'), await node('z')];
    for (const label of ['m1', 'm2', 'm3']) {
      const middle = await node(label);
      await edge(a.id, middle.id);
      await edge(middle.id, z.id);
    }
    expect(await graph.paths(scope, a.id, z.id, { limit: 2, maxDepth: 4 })).toHaveLength(2);
  });

  it('does not revisit a node, so a cycle does not become an infinite path', async () => {
    const [a, b, z] = [await node('a'), await node('b'), await node('z')];
    await edge(a.id, b.id);
    await edge(b.id, a.id);
    await edge(b.id, z.id);
    const paths = await graph.paths(scope, a.id, z.id, { maxDepth: 5 });
    expect(paths).toHaveLength(1);
    expect(paths[0]?.nodes).toEqual([a.id, b.id, z.id]);
  });

  it('does not route through a node that is no longer active', async () => {
    const [a, b, z] = [await node('a'), await node('b'), await node('z')];
    await edge(a.id, b.id);
    await edge(b.id, z.id);
    await graph.transitionNode(scope, b.id, 'DELETED_LOGICALLY', null);
    expect(await graph.paths(scope, a.id, z.id, { maxDepth: 5 })).toEqual([]);
  });

  it('stops at the depth it was given', async () => {
    const [a, b, c, z] = [await node('a'), await node('b'), await node('c'), await node('z')];
    await edge(a.id, b.id);
    await edge(b.id, c.id);
    await edge(c.id, z.id);
    expect(await graph.paths(scope, a.id, z.id, { maxDepth: 2 })).toEqual([]);
    expect(await graph.paths(scope, a.id, z.id, { maxDepth: 3 })).toHaveLength(1);
  });
});

describe('finding orphans', () => {
  it('ignores a node that is no longer active', async () => {
    const orphan = await requirement('unimplemented');
    expect((await graph.findOrphans(scope)).map((f) => f.node.id)).toContain(orphan.id);
    await graph.transitionNode(scope, orphan.id, 'DELETED_LOGICALLY', null);
    expect((await graph.findOrphans(scope)).map((f) => f.node.id)).not.toContain(orphan.id);
  });

  it('looks only at the node types it was asked about', async () => {
    const orphan = await requirement('unimplemented');
    expect((await graph.findOrphans(scope, { nodeTypes: ['DECISION'] })).map((f) => f.node.id)).not.toContain(orphan.id);
    expect((await graph.findOrphans(scope, { nodeTypes: ['REQUIREMENT'] })).map((f) => f.node.id)).toContain(orphan.id);
  });

  it('stops at the limit rather than scanning the whole project', async () => {
    for (let i = 0; i < 4; i += 1) await requirement(`r${i}`);
    expect(await graph.findOrphans(scope, { limit: 2 })).toHaveLength(2);
  });

  it('reports only the invariants it was asked about', async () => {
    await requirement('unimplemented');
    // G8 is what an unimplemented requirement violates, so asking only about
    // G13 must return nothing rather than everything.
    expect(await graph.findOrphans(scope, { invariants: ['G13'] })).toEqual([]);
    expect((await graph.findOrphans(scope, { invariants: ['G8'] })).map((f) => f.violation.invariant)).toEqual(['G8']);
  });
});

describe('transitions', () => {
  it('refuses to move an edge that is not there', async () => {
    await expect(graph.transitionEdge(scope, newEdgeId(), 'RETRACTED', null)).rejects.toThrow(ValidationError);
  });

  it('moves an edge and bumps its version', async () => {
    const [a, b] = [await node('a'), await node('b')];
    const { edge: created } = await graph.addEdge(scope, {
      type: 'DEPENDS_ON',
      from: a.id,
      to: b.id,
      authority: 'EVIDENCE',
    });
    const moved = await graph.transitionEdge(scope, created.id, 'RETRACTED', null);
    expect(moved.status).toBe('RETRACTED');
    expect(moved.version).toBe(created.version + 1);
  });
});
