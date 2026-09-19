/**
 * Gathering from real stores (the in-memory adapters, which pass the same
 * conformance suites as SQLite). The gatherer gets read-only views; these tests
 * hand it exactly that — an object with only the read methods — so a write
 * attempt would fail here, not in production.
 */

import { assembleContext, type ContextSources, gatherCandidates } from '@genesis/context';
import { newProjectId, NodeId, projectScope, type ProjectScope } from '@genesis/core-types';
import { type GraphNode, InMemoryGraphStore } from '@genesis/graph';
import { InMemoryMemoryStore } from '@genesis/memory';
import { selfModelProjector } from '@genesis/projections';
import { beforeEach, describe, expect, it } from 'vitest';
import { Cognition, HUMAN, request, SYSTEM } from './support.js';

let graph: InMemoryGraphStore;
let memory: InMemoryMemoryStore;
let scope: ProjectScope;
let sources: ContextSources;
let task: GraphNode;
let direct: GraphNode;
let transitive: GraphNode;

beforeEach(async () => {
  graph = new InMemoryGraphStore();
  memory = new InMemoryMemoryStore();
  scope = projectScope(newProjectId());
  // Read-only views: nothing else is reachable through them.
  sources = {
    memory: { query: (s, q) => memory.query(s, q) },
    graph: { getNode: (s, id) => graph.getNode(s, id), impactSet: (s, id, o) => graph.impactSet(s, id, o) },
  };

  // Fixed ids, in ascending order, so the order impact sets are merged in is known.
  const add = (label: string, suffix: string) =>
    graph.addNode(scope, { type: 'COMPONENT', label }, { newNodeId: () => NodeId.parse(`node_01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`) });
  task = await add('bookings', 'A1');
  direct = await add('billing', 'A2');
  transitive = await add('invoices', 'A3');
  // billing depends on bookings; invoices depends on billing: changing bookings impacts both.
  await graph.addEdge(scope, { type: 'DEPENDS_ON', from: direct.id, to: task.id, authority: 'EVIDENCE' });
  await graph.addEdge(scope, { type: 'DEPENDS_ON', from: transitive.id, to: direct.id, authority: 'AI_ASSUMPTION' });
});

const remember = (statement: string, node: GraphNode) =>
  memory.put(
    scope,
    {
      class: 'SEMANTIC',
      type: 'fact',
      content: { statement },
      authorityRequested: 'HUMAN_DECISION',
      sourceRefs: [{ kind: 'HUMAN', id: 'dev' }],
      relatedEntities: [{ nodeType: node.type, nodeId: node.id }],
      validFrom: '2026-01-01T00:00:00.000Z',
    },
    { actorKind: 'HUMAN', actorId: 'dev' },
  );

describe('gatherCandidates', () => {
  it('follows the impact set, reads related memory, and records the impact it used', async () => {
    await remember('bookings are soft-deleted', task);
    await remember('invoices are immutable', transitive);
    const cognition = new Cognition().run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'ship', priority: 5 }).state;
    const selfModel = {
      ...selfModelProjector.initial(),
      knownFailures: {
        'implement:timeout': {
          signature: 'implement:timeout',
          occurrences: 2,
          firstSeen: '2026-01-02T00:00:00.000Z',
          lastSeen: '2026-01-03T00:00:00.000Z',
          mitigation: null,
        },
      },
    };

    const req = request({ task: { nodeIds: [task.id, task.id] } });
    const gathered = await gatherCandidates(sources, scope, req, {
      cognition,
      selfModel,
      policies: [{ id: 'no-prod', text: 'never touch production', authority: 'HUMAN_DECISION' }],
    });

    expect(gathered.impact.map((e) => [e.nodeId, e.depth])).toEqual([
      [direct.id, 1],
      [transitive.id, 2],
    ]);
    const byId = new Map(gathered.candidates.map((c) => [c.id, c]));
    expect(byId.get('policy:no-prod')?.mandatory).toBe('POLICY');
    expect(byId.get('failure:implement:timeout')?.mandatory).toBe('MATCHING_FAILURE');
    expect(byId.get('goal:goal-1')).toBeDefined();
    expect(byId.get(`node:${direct.id}`)).toMatchObject({ dependencyDistance: 1, authority: 'EVIDENCE' });
    // Impact through a guessed edge is worth a guess.
    expect(byId.get(`node:${transitive.id}`)).toMatchObject({ dependencyDistance: 2, authority: 'AI_ASSUMPTION' });
    const memories = gathered.candidates.filter((c) => c.kind === 'MEMORY');
    expect(memories.map((c) => [c.text, c.dependencyDistance])).toEqual(
      expect.arrayContaining([
        ['SEMANTIC memory: bookings are soft-deleted', 0],
        ['SEMANTIC memory: invoices are immutable', 2],
      ]),
    );

    // And the whole thing assembles.
    const assembled = assembleContext(req, gathered.candidates);
    expect(assembled.manifest.status).toBe('ASSEMBLED');
    expect(assembled.items[0]?.id).toBe('policy:no-prod');
  });

  it('respects the impact depth and the per-node memory limit, and defaults its options', async () => {
    await remember('one', task);
    await remember('two', task);
    const input = { cognition: new Cognition().state, selfModel: selfModelProjector.initial() };
    const shallow = await gatherCandidates(sources, scope, request({ task: { nodeIds: [task.id] } }), {
      ...input,
      impactDepth: 1,
      memoryPerNode: 1,
    });
    expect(shallow.impact.map((e) => e.nodeId)).toEqual([direct.id]);
    expect(shallow.candidates.filter((c) => c.kind === 'MEMORY')).toHaveLength(1);

    const plain = await gatherCandidates(sources, scope, request({ task: { nodeIds: [task.id] } }), input);
    expect(plain.candidates.filter((c) => c.kind === 'MEMORY')).toHaveLength(2);
    expect(plain.candidates.filter((c) => c.kind === 'POLICY')).toEqual([]);
  });

  it('keeps the nearest depth when two task nodes reach the same node', async () => {
    const input = { cognition: new Cognition().run(SYSTEM, { kind: 'RECORD_BELIEF', statement: 'b' }).state, selfModel: selfModelProjector.initial() };
    // From `task`, `invoices` is 2 hops; from `direct` (merged second) it is 1: the nearer replaces it.
    const both = await gatherCandidates(sources, scope, request({ task: { nodeIds: [direct.id, task.id] } }), input);
    expect(both.impact.map((e) => [e.nodeId, e.depth])).toEqual([[transitive.id, 1]]);

    // A node one hop from both task nodes: the second, equal depth does not replace the first.
    const side = await graph.addNode(scope, { type: 'COMPONENT', label: 'audit' }, { newNodeId: () => NodeId.parse('node_01ARZ3NDEKTSV4RRFFQ69G5FA4') });
    await graph.addEdge(scope, { type: 'DEPENDS_ON', from: side.id, to: task.id, authority: 'EVIDENCE' });
    await graph.addEdge(scope, { type: 'DEPENDS_ON', from: side.id, to: direct.id, authority: 'HISTORICAL' });
    const again = await gatherCandidates(sources, scope, request({ task: { nodeIds: [task.id, direct.id] } }), input);
    expect(again.impact.find((e) => e.nodeId === side.id)).toMatchObject({ depth: 1, weakestAuthorityRank: 4 });
  });

  it('refuses a task node the graph does not hold', async () => {
    const input = { cognition: new Cognition().state, selfModel: selfModelProjector.initial() };
    await expect(
      gatherCandidates(sources, scope, request({ task: { nodeIds: ['node_01ARZ3NDEKTSV4RRFFQ69G5FZZ'] } }), input),
    ).rejects.toThrow(/holds no node node_01ARZ3NDEKTSV4RRFFQ69G5FZZ/);
  });

  it('refuses an invalid request before reading anything', async () => {
    const input = { cognition: new Cognition().state, selfModel: selfModelProjector.initial() };
    await expect(gatherCandidates(sources, scope, { ...request(), asOf: 'now' }, input)).rejects.toThrow(/invalid context request/);
  });
});
