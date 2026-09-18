/**
 * GraphStore conformance suite.
 *
 * Written against the PORT, never against an adapter (ADR-0003). The in-memory
 * adapter walks arrays; the SQLite adapter walks recursive CTEs. Both run this
 * file, which is what makes "identical semantics" a demonstrated property
 * rather than a hope.
 *
 * Ordered by how much damage a failure would do:
 *   1. Project isolation (G11, G12) — a leak makes the system reason about the
 *      wrong project.
 *   2. Invariants that reject writes (G1, G2, G3, G5, G6, G7, G10).
 *   3. Traversal caps — an unbounded walk is the anti-pattern this whole
 *      architecture is defined against.
 */

import {
  newProjectId,
  type NodeId,
  type ProjectScope,
  projectScope,
  ScopeMismatchError,
} from '@genesis/core-types';
import type { GraphNode, GraphStore, NewEdge, NewNode } from '@genesis/graph';
import { beforeEach, describe, expect, it } from 'vitest';

export interface GraphStoreHarness {
  readonly name: string;
  create(): Promise<GraphStore>;
}

const ABSENT = 'node_01ARZ3NDEKTSV4RRFFQ69G5FAV' as NodeId;

const node = (over: Partial<NewNode> = {}): NewNode =>
  ({ type: 'COMPONENT', label: 'a component', ...over }) as NewNode;

const edge = (from: NodeId, to: NodeId, over: Partial<NewEdge> = {}): NewEdge =>
  ({ type: 'DEPENDS_ON', from, to, authority: 'EVIDENCE', ...over }) as NewEdge;

export function describeGraphStoreConformance(harness: GraphStoreHarness): void {
  describe(`GraphStore conformance: ${harness.name}`, () => {
    let store: GraphStore;
    let scope: ProjectScope;
    let other: ProjectScope;

    beforeEach(async () => {
      store = await harness.create();
      scope = projectScope(newProjectId());
      other = projectScope(newProjectId());
    });

    const add = (over: Partial<NewNode> = {}, s: ProjectScope = scope): Promise<GraphNode> =>
      store.addNode(s, node(over));

    // ------------------------------------------------------------- nodes

    describe('nodes', () => {
      it('writes a node scoped to the project', async () => {
        const created = await add();
        expect(created.projectId).toBe(scope.projectId);
        expect(created.status).toBe('ACTIVE');
        expect(created.version).toBe(1);
      });

      it('refuses a caller-supplied id, projectId, status or version', async () => {
        for (const field of [
          { id: ABSENT },
          { projectId: other.projectId },
          { status: 'ARCHIVED' },
          { version: 3 },
        ]) {
          await expect(
            store.addNode(scope, { ...node(), ...field } as never),
            JSON.stringify(field),
          ).rejects.toThrow(/invalid graph node/i);
        }
      });

      it('rejects a node type outside the canonical enum', async () => {
        await expect(store.addNode(scope, node({ type: 'WIDGET' } as never))).rejects.toThrow(
          /invalid graph node/i,
        );
      });

      it('accepts UNCERTAINTY as a node type (decision E2)', async () => {
        await expect(add({ type: 'UNCERTAINTY' })).resolves.toBeDefined();
      });

      it('returns null for an id that exists nowhere', async () => {
        expect(await store.getNode(scope, ABSENT)).toBeNull();
      });
    });

    // -------------------------------------------- project isolation (G11/G12)

    describe('project isolation (G11, G12, ADR-0008)', () => {
      it('THROWS rather than returning null for a foreign node', async () => {
        const foreign = await add({}, other);
        await expect(store.getNode(scope, foreign.id)).rejects.toThrow(ScopeMismatchError);
      });

      it('G11: refuses an edge that would cross a project boundary', async () => {
        const mine = await add();
        const theirs = await add({}, other);
        await expect(store.addEdge(scope, edge(mine.id, theirs.id))).rejects.toThrow(/G11/);
      });

      it('G12: a traversal never leaves its project', async () => {
        const a = await add();
        const b = await add();
        await store.addEdge(scope, edge(a.id, b.id));

        const x = await add({}, other);
        const y = await add({}, other);
        await store.addEdge(other, edge(x.id, y.id));

        const walk = await store.neighbourhood(scope, a.id, { depth: 6, limit: 100 });
        expect(walk.nodes.every((n) => n.projectId === scope.projectId)).toBe(true);
        expect(walk.nodes.map((n) => n.id)).not.toContain(x.id);
      });

      it('G12: impact analysis never leaves its project', async () => {
        const a = await add();
        const b = await add();
        await store.addEdge(scope, edge(b.id, a.id, { type: 'DEPENDS_ON' }));
        const foreign = await add({}, other);

        const impact = await store.impactSet(scope, a.id);
        expect(impact.map((e) => e.nodeId)).not.toContain(foreign.id);
      });

      it('keeps identically shaped graphs in two projects independent', async () => {
        const a = await add();
        const b = await add();
        await store.addEdge(scope, edge(b.id, a.id));

        const x = await add({}, other);
        expect(await store.edgesOf(other, x.id)).toEqual([]);
      });
    });

    // ---------------------------------------------------- write invariants

    describe('edge invariants', () => {
      it('G6: rejects an edge whose endpoint does not exist', async () => {
        const a = await add();
        await expect(store.addEdge(scope, edge(a.id, ABSENT))).rejects.toThrow(/G6/);
      });

      it('G6: rejects an edge to a logically deleted node', async () => {
        const a = await add();
        const b = await add();
        await store.transitionNode(scope, b.id, 'DELETED_LOGICALLY', null);
        await expect(store.addEdge(scope, edge(a.id, b.id))).rejects.toThrow(/G6/);
      });

      it('G7: rejects an illegal endpoint type', async () => {
        const test = await add({ type: 'TEST' });
        const component = await add({ type: 'COMPONENT' });
        // CALLS is FUNCTION -> FUNCTION|API; a TEST may not start one.
        await expect(
          store.addEdge(scope, edge(test.id, component.id, { type: 'CALLS' })),
        ).rejects.toThrow(/G7/);
      });

      it('G7: accepts a legal endpoint pair', async () => {
        const fn = await add({ type: 'FUNCTION' });
        const api = await add({ type: 'API' });
        await expect(
          store.addEdge(scope, edge(fn.id, api.id, { type: 'CALLS' })),
        ).resolves.toBeDefined();
      });

      it('G7: accepts UNCERTAINTY as a BLOCKS source (decision E2)', async () => {
        const uncertainty = await add({ type: 'UNCERTAINTY' });
        const goal = await add({ type: 'GOAL' });
        await expect(
          store.addEdge(scope, edge(uncertainty.id, goal.id, { type: 'BLOCKS' })),
        ).resolves.toBeDefined();
      });

      it('G1: a node may have only one CONTAINS parent', async () => {
        const parentA = await add({ type: 'PROJECT' });
        const parentB = await add({ type: 'PROJECT' });
        const child = await add({ type: 'COMPONENT' });
        await store.addEdge(scope, edge(parentA.id, child.id, { type: 'CONTAINS' }));
        await expect(
          store.addEdge(scope, edge(parentB.id, child.id, { type: 'CONTAINS' })),
        ).rejects.toThrow(/G1/);
      });

      it('G2: CONTAINS stays acyclic', async () => {
        const a = await add({ type: 'PROJECT' });
        const b = await add({ type: 'COMPONENT' });
        await store.addEdge(scope, edge(a.id, b.id, { type: 'CONTAINS' }));
        await expect(store.addEdge(scope, edge(b.id, a.id, { type: 'CONTAINS' }))).rejects.toThrow(
          /G2/,
        );
      });

      it('G2: rejects a self-loop', async () => {
        const a = await add();
        await expect(store.addEdge(scope, edge(a.id, a.id))).rejects.toThrow(/G2/);
      });

      it('G3: rejects a DEPENDS_ON cycle between COMPONENT nodes', async () => {
        const a = await add({ type: 'COMPONENT' });
        const b = await add({ type: 'COMPONENT' });
        await store.addEdge(scope, edge(a.id, b.id, { type: 'DEPENDS_ON' }));
        await expect(
          store.addEdge(scope, edge(b.id, a.id, { type: 'DEPENDS_ON' })),
        ).rejects.toThrow(/G3/);
      });

      it('G3: RECORDS a FILE-level dependency cycle instead of rejecting it', async () => {
        // Real codebases contain these. Blocking the write would be a lie about
        // the code; recording it is the honest response (SPEC-03 §4 note).
        const a = await add({ type: 'FILE' });
        const b = await add({ type: 'FILE' });
        await store.addEdge(scope, edge(a.id, b.id, { type: 'DEPENDS_ON' }));
        const result = await store.addEdge(scope, edge(b.id, a.id, { type: 'DEPENDS_ON' }));
        expect(result.edge).toBeDefined();
        expect(result.observations.some((o) => o.invariant === 'G3')).toBe(true);
      });

      it('G5: SUPERSEDES requires both endpoints to be the same type', async () => {
        const a = await add({ type: 'COMPONENT' });
        const b = await add({ type: 'FILE' });
        await expect(
          store.addEdge(scope, edge(a.id, b.id, { type: 'SUPERSEDES' })),
        ).rejects.toThrow(/G5/);
      });

      it('G5: SUPERSEDES stays acyclic', async () => {
        const a = await add();
        const b = await add();
        await store.addEdge(scope, edge(a.id, b.id, { type: 'SUPERSEDES' }));
        await expect(
          store.addEdge(scope, edge(b.id, a.id, { type: 'SUPERSEDES' })),
        ).rejects.toThrow(/G5/);
      });

      it('G4: writes the reciprocal CONTRADICTS edge automatically', async () => {
        const a = await add({ type: 'BELIEF' });
        const b = await add({ type: 'BELIEF' });
        const result = await store.addEdge(scope, edge(a.id, b.id, { type: 'CONTRADICTS' }));

        expect(result.reciprocal).not.toBeNull();
        expect(result.reciprocal?.from).toBe(b.id);
        expect(result.reciprocal?.to).toBe(a.id);
        // The repair is marked, so it does not look like a caller wrote it.
        expect(result.reciprocal?.reciprocalOf).toBe(result.edge.id);

        const fromB = await store.edgesOf(scope, b.id);
        expect(fromB.some((e) => e.from === b.id && e.to === a.id)).toBe(true);
      });

      it('G4: does not write a second reciprocal when one already exists', async () => {
        const a = await add({ type: 'BELIEF' });
        const b = await add({ type: 'BELIEF' });
        await store.addEdge(scope, edge(a.id, b.id, { type: 'CONTRADICTS' }));
        const second = await store.addEdge(scope, edge(b.id, a.id, { type: 'CONTRADICTS' }));
        expect(second.reciprocal).toBeNull();
      });

      it('G10: exposes no method that could hard-delete a node', () => {
        for (const forbidden of ['deleteNode', 'deleteEdge', 'removeNode', 'purge', 'truncate']) {
          expect(
            (store as unknown as Record<string, unknown>)[forbidden],
            `GraphStore must not expose "${forbidden}"`,
          ).toBeUndefined();
        }
      });

      it('G10: a logically deleted node is still readable', async () => {
        const a = await add();
        await store.transitionNode(scope, a.id, 'DELETED_LOGICALLY', null);
        const found = await store.getNode(scope, a.id);
        expect(found).not.toBeNull();
        expect(found?.status).toBe('DELETED_LOGICALLY');
      });

      it('refuses an edge type outside the canonical enum', async () => {
        const a = await add();
        const b = await add();
        await expect(
          store.addEdge(scope, edge(a.id, b.id, { type: 'ENTANGLES' } as never)),
        ).rejects.toThrow(/invalid graph edge/i);
      });
    });

    // ------------------------------------------------------------ traversal

    describe('neighbourhood', () => {
      /** a -> b -> c -> d, a chain, so depth is observable. */
      const chain = async (): Promise<GraphNode[]> => {
        const nodes = [await add(), await add(), await add(), await add()];
        for (let i = 0; i < nodes.length - 1; i++) {
          const from = nodes[i] as GraphNode;
          const to = nodes[i + 1] as GraphNode;
          await store.addEdge(scope, edge(from.id, to.id));
        }
        return nodes;
      };

      it('includes the origin', async () => {
        const nodes = await chain();
        const origin = nodes[0] as GraphNode;
        const walk = await store.neighbourhood(scope, origin.id, { depth: 0, limit: 10 });
        expect(walk.nodes.map((n) => n.id)).toEqual([origin.id]);
      });

      it('honours depth', async () => {
        const nodes = await chain();
        const origin = nodes[0] as GraphNode;
        expect((await store.neighbourhood(scope, origin.id, { depth: 1, limit: 50 })).nodes).toHaveLength(2);
        expect((await store.neighbourhood(scope, origin.id, { depth: 2, limit: 50 })).nodes).toHaveLength(3);
      });

      it('caps depth rather than trusting the caller', async () => {
        const nodes = await chain();
        const origin = nodes[0] as GraphNode;
        // 999 is clamped to MAX_TRAVERSAL_DEPTH; the call must not walk the
        // whole graph just because someone asked it to.
        const walk = await store.neighbourhood(scope, origin.id, { depth: 999, limit: 50 });
        expect(walk.nodes.length).toBeLessThanOrEqual(4);
      });

      it('rejects a negative depth', async () => {
        const nodes = await chain();
        const origin = nodes[0] as GraphNode;
        await expect(
          store.neighbourhood(scope, origin.id, { depth: -1, limit: 10 }),
        ).rejects.toThrow(/non-negative/);
      });

      it('rejects a non-positive limit', async () => {
        const nodes = await chain();
        const origin = nodes[0] as GraphNode;
        await expect(store.neighbourhood(scope, origin.id, { depth: 1, limit: 0 })).rejects.toThrow(
          /positive integer/,
        );
      });

      it('reports truncation rather than silently returning less', async () => {
        const nodes = await chain();
        const origin = nodes[0] as GraphNode;
        const walk = await store.neighbourhood(scope, origin.id, { depth: 5, limit: 2 });
        expect(walk.nodes.length).toBeLessThanOrEqual(2);
        expect(walk.truncated).toBe(true);
      });

      it('filters by edge type', async () => {
        const a = await add();
        const b = await add();
        const c = await add({ type: 'REQUIREMENT' });
        await store.addEdge(scope, edge(a.id, b.id, { type: 'DEPENDS_ON' }));
        await store.addEdge(scope, edge(a.id, c.id, { type: 'IMPLEMENTS' }));

        const walk = await store.neighbourhood(scope, a.id, {
          depth: 2,
          limit: 50,
          edgeTypes: ['IMPLEMENTS'],
        });
        const ids = walk.nodes.map((n) => n.id);
        expect(ids).toContain(c.id);
        expect(ids).not.toContain(b.id);
      });

      it('filters by minimum edge authority', async () => {
        const a = await add();
        const strong = await add();
        const weak = await add();
        await store.addEdge(scope, edge(a.id, strong.id, { authority: 'VERIFIED_SYSTEM_STATE' }));
        await store.addEdge(scope, edge(a.id, weak.id, { authority: 'UNGROUNDED' }));

        const walk = await store.neighbourhood(scope, a.id, {
          depth: 2,
          limit: 50,
          minAuthority: 'EVIDENCE',
        });
        const ids = walk.nodes.map((n) => n.id);
        expect(ids).toContain(strong.id);
        expect(ids).not.toContain(weak.id);
      });

      it('honours direction', async () => {
        const a = await add();
        const downstream = await add();
        const upstream = await add();
        await store.addEdge(scope, edge(a.id, downstream.id));
        await store.addEdge(scope, edge(upstream.id, a.id));

        const out = await store.neighbourhood(scope, a.id, {
          depth: 1,
          limit: 50,
          direction: 'out',
        });
        expect(out.nodes.map((n) => n.id)).toContain(downstream.id);
        expect(out.nodes.map((n) => n.id)).not.toContain(upstream.id);

        const inbound = await store.neighbourhood(scope, a.id, {
          depth: 1,
          limit: 50,
          direction: 'in',
        });
        expect(inbound.nodes.map((n) => n.id)).toContain(upstream.id);
        expect(inbound.nodes.map((n) => n.id)).not.toContain(downstream.id);
      });

      it('does not walk through a logically deleted node', async () => {
        const a = await add();
        const b = await add();
        const c = await add();
        await store.addEdge(scope, edge(a.id, b.id));
        await store.addEdge(scope, edge(b.id, c.id));
        await store.transitionNode(scope, b.id, 'DELETED_LOGICALLY', null);

        const walk = await store.neighbourhood(scope, a.id, { depth: 3, limit: 50 });
        const ids = walk.nodes.map((n) => n.id);
        expect(ids).not.toContain(b.id);
        expect(ids).not.toContain(c.id);
      });

      it('does not follow a retracted edge', async () => {
        const a = await add();
        const b = await add();
        const created = await store.addEdge(scope, edge(a.id, b.id));
        await store.transitionEdge(scope, created.edge.id, 'RETRACTED', null);

        const walk = await store.neighbourhood(scope, a.id, { depth: 2, limit: 50 });
        expect(walk.nodes.map((n) => n.id)).not.toContain(b.id);
      });

      it('rejects a traversal from a node that does not exist', async () => {
        await expect(
          store.neighbourhood(scope, ABSENT, { depth: 1, limit: 10 }),
        ).rejects.toThrow(/no graph node/);
      });
    });

    // ----------------------------------------------------------- impactSet

    describe('impactSet (SPEC-03 §5.1)', () => {
      it('includes what depends on the changed node', async () => {
        const target = await add();
        const dependant = await add();
        await store.addEdge(scope, edge(dependant.id, target.id, { type: 'DEPENDS_ON' }));
        expect((await store.impactSet(scope, target.id)).map((e) => e.nodeId)).toContain(
          dependant.id,
        );
      });

      it('includes what the changed node affects', async () => {
        const target = await add();
        const affected = await add();
        await store.addEdge(scope, edge(target.id, affected.id, { type: 'AFFECTS' }));
        expect((await store.impactSet(scope, target.id)).map((e) => e.nodeId)).toContain(
          affected.id,
        );
      });

      it('follows callers inward', async () => {
        const target = await add({ type: 'FUNCTION' });
        const caller = await add({ type: 'FUNCTION' });
        await store.addEdge(scope, edge(caller.id, target.id, { type: 'CALLS' }));
        expect((await store.impactSet(scope, target.id)).map((e) => e.nodeId)).toContain(caller.id);
      });

      it('does NOT include the node the analysis started from', async () => {
        const target = await add();
        const dependant = await add();
        await store.addEdge(scope, edge(dependant.id, target.id));
        expect((await store.impactSet(scope, target.id)).map((e) => e.nodeId)).not.toContain(
          target.id,
        );
      });

      it('propagates transitively and reports the shortest depth', async () => {
        const target = await add();
        const near = await add();
        const far = await add();
        await store.addEdge(scope, edge(near.id, target.id, { type: 'DEPENDS_ON' }));
        await store.addEdge(scope, edge(far.id, near.id, { type: 'DEPENDS_ON' }));

        const impact = await store.impactSet(scope, target.id);
        expect(impact.find((e) => e.nodeId === near.id)?.depth).toBe(1);
        expect(impact.find((e) => e.nodeId === far.id)?.depth).toBe(2);
      });

      it('orders nearest first', async () => {
        const target = await add();
        const near = await add();
        const far = await add();
        await store.addEdge(scope, edge(near.id, target.id));
        await store.addEdge(scope, edge(far.id, near.id));

        const depths = (await store.impactSet(scope, target.id)).map((e) => e.depth);
        expect([...depths]).toEqual([...depths].sort((a, b) => a - b));
      });

      it('carries the weakest authority on the path', async () => {
        // A chain is only as well established as its least established step.
        const target = await add();
        const near = await add();
        const far = await add();
        await store.addEdge(scope, edge(near.id, target.id, { authority: 'VERIFIED_SYSTEM_STATE' }));
        await store.addEdge(scope, edge(far.id, near.id, { authority: 'UNGROUNDED' }));

        const impact = await store.impactSet(scope, target.id);
        const nearRank = impact.find((e) => e.nodeId === near.id)?.weakestAuthorityRank ?? 0;
        const farRank = impact.find((e) => e.nodeId === far.id)?.weakestAuthorityRank ?? 0;
        expect(farRank).toBeGreaterThan(nearRank);
      });

      it('honours maxDepth', async () => {
        const target = await add();
        const near = await add();
        const far = await add();
        await store.addEdge(scope, edge(near.id, target.id));
        await store.addEdge(scope, edge(far.id, near.id));

        const shallow = await store.impactSet(scope, target.id, { maxDepth: 1 });
        expect(shallow.map((e) => e.nodeId)).toContain(near.id);
        expect(shallow.map((e) => e.nodeId)).not.toContain(far.id);
      });

      it('does not follow relationships that do not carry impact', async () => {
        const target = await add({ type: 'REQUIREMENT' });
        const unrelated = await add({ type: 'DECISION' });
        await store.addEdge(scope, edge(unrelated.id, target.id, { type: 'DERIVED_FROM' }));
        expect((await store.impactSet(scope, target.id)).map((e) => e.nodeId)).not.toContain(
          unrelated.id,
        );
      });

      it('terminates on a cyclic graph', async () => {
        const a = await add({ type: 'FILE' });
        const b = await add({ type: 'FILE' });
        await store.addEdge(scope, edge(a.id, b.id, { type: 'DEPENDS_ON' }));
        await store.addEdge(scope, edge(b.id, a.id, { type: 'DEPENDS_ON' }));
        expect((await store.impactSet(scope, a.id)).map((e) => e.nodeId)).toContain(b.id);
      });

      it('returns nothing for an isolated node', async () => {
        const lonely = await add();
        expect(await store.impactSet(scope, lonely.id)).toEqual([]);
      });
    });

    // --------------------------------------------------------------- paths

    describe('paths', () => {
      it('finds a direct path', async () => {
        const a = await add();
        const b = await add();
        await store.addEdge(scope, edge(a.id, b.id));
        const found = await store.paths(scope, a.id, b.id, { maxDepth: 3 });
        expect(found).toHaveLength(1);
        expect(found[0]?.nodes).toEqual([a.id, b.id]);
      });

      it('finds a transitive path and records its edges', async () => {
        const a = await add();
        const b = await add();
        const c = await add();
        const first = await store.addEdge(scope, edge(a.id, b.id));
        const second = await store.addEdge(scope, edge(b.id, c.id));

        const found = await store.paths(scope, a.id, c.id, { maxDepth: 3 });
        expect(found).toHaveLength(1);
        expect(found[0]?.nodes).toEqual([a.id, b.id, c.id]);
        expect(found[0]?.edges).toEqual([first.edge.id, second.edge.id]);
      });

      it('respects maxDepth', async () => {
        const a = await add();
        const b = await add();
        const c = await add();
        await store.addEdge(scope, edge(a.id, b.id));
        await store.addEdge(scope, edge(b.id, c.id));
        expect(await store.paths(scope, a.id, c.id, { maxDepth: 1 })).toEqual([]);
      });

      it('returns nothing when no path exists', async () => {
        const a = await add();
        const b = await add();
        expect(await store.paths(scope, a.id, b.id, { maxDepth: 4 })).toEqual([]);
      });

      it('terminates on a cycle without revisiting nodes', async () => {
        const a = await add({ type: 'FILE' });
        const b = await add({ type: 'FILE' });
        const c = await add({ type: 'FILE' });
        await store.addEdge(scope, edge(a.id, b.id, { type: 'DEPENDS_ON' }));
        await store.addEdge(scope, edge(b.id, c.id, { type: 'DEPENDS_ON' }));
        await store.addEdge(scope, edge(c.id, a.id, { type: 'DEPENDS_ON' }));

        const found = await store.paths(scope, a.id, c.id, { maxDepth: 5 });
        expect(found.length).toBeGreaterThan(0);
        for (const path of found) {
          expect(new Set(path.nodes).size).toBe(path.nodes.length);
        }
      });

      it('filters by edge type', async () => {
        const a = await add({ type: 'FUNCTION' });
        const b = await add({ type: 'FUNCTION' });
        await store.addEdge(scope, edge(a.id, b.id, { type: 'CALLS' }));
        expect(
          await store.paths(scope, a.id, b.id, { maxDepth: 3, edgeTypes: ['CALLS'] }),
        ).toHaveLength(1);
        expect(
          await store.paths(scope, a.id, b.id, { maxDepth: 3, edgeTypes: ['DEPENDS_ON'] }),
        ).toEqual([]);
      });
    });

    // ------------------------------------------------- structural gaps

    describe('findOrphans (G8, G9, G13)', () => {
      it('G8: flags an in-force requirement nothing implements', async () => {
        const requirement = await add({ type: 'REQUIREMENT', attrs: { inForce: true } });
        const findings = await store.findOrphans(scope);
        expect(
          findings.some((f) => f.node.id === requirement.id && f.violation.invariant === 'G8'),
        ).toBe(true);
      });

      it('G8: does not flag a requirement that is not in force', async () => {
        await add({ type: 'REQUIREMENT', attrs: { inForce: false } });
        const findings = await store.findOrphans(scope);
        expect(findings.filter((f) => f.violation.invariant === 'G8')).toEqual([]);
      });

      it('G9: flags an implemented requirement nothing verifies', async () => {
        const requirement = await add({ type: 'REQUIREMENT', attrs: { inForce: true } });
        const file = await add({ type: 'FILE' });
        await store.addEdge(scope, edge(file.id, requirement.id, { type: 'IMPLEMENTS' }));

        const findings = await store.findOrphans(scope);
        expect(
          findings.some((f) => f.node.id === requirement.id && f.violation.invariant === 'G9'),
        ).toBe(true);
      });

      it('G9: clears once something verifies it', async () => {
        const requirement = await add({ type: 'REQUIREMENT', attrs: { inForce: true } });
        const file = await add({ type: 'FILE' });
        const test = await add({ type: 'TEST' });
        await store.addEdge(scope, edge(file.id, requirement.id, { type: 'IMPLEMENTS' }));
        await store.addEdge(scope, edge(test.id, requirement.id, { type: 'VERIFIES' }));

        const findings = await store.findOrphans(scope);
        expect(findings.filter((f) => f.node.id === requirement.id)).toEqual([]);
      });

      it('G13: flags a blocking open uncertainty that blocks nothing', async () => {
        const uncertainty = await add({
          type: 'UNCERTAINTY',
          attrs: { blocking: true, status: 'OPEN' },
        });
        const findings = await store.findOrphans(scope);
        expect(
          findings.some((f) => f.node.id === uncertainty.id && f.violation.invariant === 'G13'),
        ).toBe(true);
      });

      it('G13: clears once it blocks something', async () => {
        const uncertainty = await add({
          type: 'UNCERTAINTY',
          attrs: { blocking: true, status: 'OPEN' },
        });
        const goal = await add({ type: 'GOAL' });
        await store.addEdge(scope, edge(uncertainty.id, goal.id, { type: 'BLOCKS' }));

        const findings = await store.findOrphans(scope);
        expect(findings.filter((f) => f.node.id === uncertainty.id)).toEqual([]);
      });

      it('G13: does not flag a non-blocking uncertainty', async () => {
        await add({ type: 'UNCERTAINTY', attrs: { blocking: false, status: 'OPEN' } });
        const findings = await store.findOrphans(scope);
        expect(findings.filter((f) => f.violation.invariant === 'G13')).toEqual([]);
      });

      it('can be narrowed to one invariant', async () => {
        await add({ type: 'REQUIREMENT', attrs: { inForce: true } });
        await add({ type: 'UNCERTAINTY', attrs: { blocking: true, status: 'OPEN' } });
        const findings = await store.findOrphans(scope, { invariants: ['G13'] });
        expect(findings.every((f) => f.violation.invariant === 'G13')).toBe(true);
        expect(findings.length).toBe(1);
      });

      it('stays project-scoped', async () => {
        await add({ type: 'REQUIREMENT', attrs: { inForce: true } }, other);
        expect(await store.findOrphans(scope)).toEqual([]);
      });
    });

    // ------------------------------------------------------------ lifecycle

    describe('lifecycle', () => {
      it('transitions a node and records the cause', async () => {
        const a = await add();
        const updated = await store.transitionNode(
          scope,
          a.id,
          'ARCHIVED',
          'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV' as never,
        );
        expect(updated.status).toBe('ARCHIVED');
        expect(updated.statusCause).toBe('evt_01ARZ3NDEKTSV4RRFFQ69G5FAV');
        expect(updated.version).toBe(2);
      });

      it('refuses to transition a foreign node', async () => {
        const foreign = await add({}, other);
        await expect(store.transitionNode(scope, foreign.id, 'ARCHIVED', null)).rejects.toThrow(
          ScopeMismatchError,
        );
      });

      it('returns copies, so a caller cannot mutate stored state', async () => {
        const a = await add();
        (a as unknown as { label: string }).label = 'TAMPERED';
        expect((await store.getNode(scope, a.id))?.label).toBe('a component');
      });

      it('rejects use after close', async () => {
        await store.close();
        await expect(store.addNode(scope, node())).rejects.toThrow(/closed/i);
      });

      it('tolerates being closed twice', async () => {
        await store.close();
        await expect(store.close()).resolves.toBeUndefined();
      });
    });
  });
}
