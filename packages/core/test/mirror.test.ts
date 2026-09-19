/**
 * The graph mirror (ADR-0016, ADR-0018 §4): derived from canonical state,
 * idempotent, and loud when the graph disagrees with a record.
 */

import { CognitiveEngine } from '@genesis/cognition';
import { GraphMirror, mirrorEdgeId, mirrorNodeId, mirrorOf } from '@genesis/core';
import { MirrorDivergenceError, newProjectId, projectScope, type ProjectScope } from '@genesis/core-types';
import { InMemoryGraphStore } from '@genesis/graph';
import { InMemoryEventLedger } from '@genesis/ledger';
import { countingIdSource, fixedClock } from '@genesis/testkit';
import { beforeEach, describe, expect, it } from 'vitest';

const HUMAN = { kind: 'HUMAN', id: 'dev' } as const;
const SYSTEM = { kind: 'SYSTEM', id: 'runner' } as const;
const AGENT = { kind: 'AGENT', id: 'agt', agentRole: 'IMPLEMENTER' } as const;
const criterion = [{ statement: 's', checkKind: 'TEST', checkRef: 't' }];

let engine: CognitiveEngine;
let graph: InMemoryGraphStore;
let mirror: GraphMirror;
let scope: ProjectScope;

beforeEach(() => {
  engine = new CognitiveEngine(new InMemoryEventLedger(), { ids: countingIdSource(), now: fixedClock() });
  graph = new InMemoryGraphStore();
  mirror = new GraphMirror(graph, { now: () => new Date(Date.UTC(2026, 0, 1)) });
  scope = projectScope(newProjectId());
});

const run = (actor: typeof HUMAN | typeof SYSTEM | typeof AGENT, command: Record<string, unknown>) => engine.execute(scope, actor, command);
const state = async () => (await engine.state(scope)).state;
const node = (recordId: string) => graph.getNode(scope, mirrorNodeId(scope.projectId, recordId));
const edge = (type: string, from: string, to: string) => graph.getEdge(scope, mirrorEdgeId(scope.projectId, `${type}|${from}|${to}`));

describe('mirrorOf', () => {
  it('is pure and deterministic, and scopes ids by project', async () => {
    await run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'g', priority: 1 });
    const s = await state();
    expect(mirrorOf(scope.projectId, s)).toEqual(mirrorOf(scope.projectId, s));
    expect(mirrorNodeId(scope.projectId, 'goal-1')).toMatch(/^node_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(mirrorNodeId('prj_other', 'goal-1')).not.toBe(mirrorNodeId(scope.projectId, 'goal-1'));
  });
});

describe('reconcile', () => {
  it('mirrors goals, beliefs, uncertainties and questions, with their links', async () => {
    await run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'parent', priority: 1, successCriteria: criterion });
    await run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'child', priority: 1, parentId: 'goal-1' });
    await run(AGENT, { kind: 'RECORD_BELIEF', statement: 'a' });
    await run(HUMAN, { kind: 'RECORD_BELIEF', statement: 'not a', authority: 'HUMAN_DECISION' });
    await run(SYSTEM, { kind: 'RECORD_UNCERTAINTY', statement: 'u?', whatBreaksIfWrong: 'w', risk: 'LOW', resolution: 'ASK_HUMAN', blocksGoalIds: ['goal-1'] });
    await run(AGENT, { kind: 'DRAFT_QUESTION', uncertaintyId: 'unc-1', text: 'q?' });
    await run(SYSTEM, {
      kind: 'RECORD_CONTRADICTION',
      contradictionKind: 'BELIEF_EVIDENCE',
      sides: [
        { kind: 'BELIEF', beliefId: 'bel-1' },
        { kind: 'BELIEF', beliefId: 'bel-2' },
      ],
    });

    const report = await mirror.reconcile(scope, await state());
    expect(report).toEqual({ nodesAdded: 6, nodesTransitioned: 1, edgesAdded: 4, edgesTransitioned: 0 });

    expect(await node('goal-1')).toMatchObject({ type: 'GOAL', label: 'parent', status: 'ACTIVE', attrs: { mirrorOf: 'cognition', recordKind: 'GOAL', recordId: 'goal-1' } });
    // Decided by authority at record time: the agent's belief is superseded, and says so.
    expect(await node('bel-1')).toMatchObject({ type: 'BELIEF', status: 'SUPERSEDED' });
    expect(await node('unc-1')).toMatchObject({ type: 'UNCERTAINTY', label: 'u?', status: 'ACTIVE' });
    expect(await node('qst-1')).toMatchObject({ type: 'QUESTION', label: 'q?' });

    expect(await edge('REQUIRES', 'goal-1', 'goal-2')).toMatchObject({ authority: 'HUMAN_DECISION', status: 'ACTIVE' });
    expect(await edge('BLOCKS', 'unc-1', 'goal-1')).toMatchObject({ authority: 'VERIFIED_SYSTEM_STATE', status: 'ACTIVE' });
    expect(await edge('DERIVED_FROM', 'qst-1', 'unc-1')).toMatchObject({ authority: 'AI_ASSUMPTION' });
    // Symmetric: the store wrote the reciprocal under the mirror's derived id.
    expect(await edge('CONTRADICTS', 'bel-1', 'bel-2')).toMatchObject({ status: 'ACTIVE' });
    expect(await graph.getEdge(scope, mirrorEdgeId(scope.projectId, 'CONTRADICTS|bel-1|bel-2|reciprocal'))).toMatchObject({
      type: 'CONTRADICTS',
    });

    // Idempotent.
    expect(await mirror.reconcile(scope, await state())).toEqual({ nodesAdded: 0, nodesTransitioned: 0, edgesAdded: 0, edgesTransitioned: 0 });
  });

  it('follows lifecycle: closed records are archived, and a closed uncertainty no longer blocks', async () => {
    await run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'g', priority: 1, successCriteria: criterion });
    await run(SYSTEM, { kind: 'RECORD_UNCERTAINTY', statement: 'u?', whatBreaksIfWrong: 'w', risk: 'LOW', resolution: 'SEARCH', blocksGoalIds: ['goal-1'] });
    await run(SYSTEM, { kind: 'DRAFT_QUESTION', uncertaintyId: 'unc-1', text: 'q?' });
    await mirror.reconcile(scope, await state());

    await run(SYSTEM, { kind: 'WITHDRAW_QUESTION', questionId: 'qst-1', reason: 'not needed' });
    await run(SYSTEM, { kind: 'RESOLVE_UNCERTAINTY', uncertaintyId: 'unc-1', evidence: ['found'] });
    await run(HUMAN, { kind: 'ABANDON_GOAL', goalId: 'goal-1', reason: 'descoped' });
    expect(await mirror.reconcile(scope, await state())).toEqual({ nodesAdded: 0, nodesTransitioned: 3, edgesAdded: 0, edgesTransitioned: 1 });
    expect((await node('goal-1'))?.status).toBe('ARCHIVED');
    expect((await node('unc-1'))?.status).toBe('ARCHIVED');
    expect((await node('qst-1'))?.status).toBe('ARCHIVED');
    expect((await edge('BLOCKS', 'unc-1', 'goal-1'))?.status).toBe('RETRACTED');
  });

  it('adds an edge already retracted when it first sees a closed uncertainty', async () => {
    await run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'g', priority: 1 });
    await run(SYSTEM, { kind: 'RECORD_UNCERTAINTY', statement: 'u?', whatBreaksIfWrong: 'w', risk: 'LOW', resolution: 'SEARCH', blocksGoalIds: ['goal-1'] });
    await run(SYSTEM, { kind: 'RESOLVE_UNCERTAINTY', uncertaintyId: 'unc-1', evidence: ['found'] });
    expect(await mirror.reconcile(scope, await state())).toEqual({ nodesAdded: 2, nodesTransitioned: 1, edgesAdded: 1, edgesTransitioned: 1 });
    expect((await edge('BLOCKS', 'unc-1', 'goal-1'))?.status).toBe('RETRACTED');
  });

  it('refuses to overwrite a node or edge that something else wrote under a mirror id', async () => {
    await run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'g', priority: 1 });
    await graph.addNode(scope, { type: 'GOAL', label: 'forged' }, { newNodeId: () => mirrorNodeId(scope.projectId, 'goal-1') });
    await expect(mirror.reconcile(scope, await state())).rejects.toThrow(MirrorDivergenceError);
  });

  it('refuses a node whose attributes were changed, and an edge that points elsewhere', async () => {
    await run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'g', priority: 1 });
    await graph.addNode(
      scope,
      { type: 'GOAL', label: 'g', attrs: { mirrorOf: 'cognition', recordKind: 'GOAL', recordId: 'goal-9' } },
      { newNodeId: () => mirrorNodeId(scope.projectId, 'goal-1') },
    );
    await expect(mirror.reconcile(scope, await state())).rejects.toThrow(/does not match GOAL goal-1/);

    const other = projectScope(newProjectId());
    const otherEngine = new CognitiveEngine(new InMemoryEventLedger(), { ids: countingIdSource(), now: fixedClock() });
    await otherEngine.execute(other, HUMAN, { kind: 'PROPOSE_GOAL', description: 'p', priority: 1 });
    await otherEngine.execute(other, HUMAN, { kind: 'PROPOSE_GOAL', description: 'c', priority: 1, parentId: 'goal-1' });
    await otherEngine.execute(other, HUMAN, { kind: 'PROPOSE_GOAL', description: 'x', priority: 1 });
    const g2 = new InMemoryGraphStore();
    const m2 = new GraphMirror(g2);
    const s = (await otherEngine.state(other)).state;
    // Nodes first, then a forged edge under the REQUIRES id, pointing at the wrong child.
    const plan = mirrorOf(other.projectId, s);
    for (const n of plan.nodes) {
      await g2.addNode(other, { type: n.type, label: n.label, attrs: { ...n.attrs } }, { newNodeId: () => n.id });
    }
    await g2.addEdge(
      other,
      { type: 'REQUIRES', from: mirrorNodeId(other.projectId, 'goal-1'), to: mirrorNodeId(other.projectId, 'goal-3'), authority: 'HUMAN_DECISION' },
      { newEdgeId: () => mirrorEdgeId(other.projectId, 'REQUIRES|goal-1|goal-2') },
    );
    await expect(m2.reconcile(other, s)).rejects.toThrow(/does not match the REQUIRES/);
  });

  it('uses the wall clock when none is given', async () => {
    await run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'g', priority: 1 });
    await new GraphMirror(graph).reconcile(scope, await state());
    expect(Date.parse((await node('goal-1'))?.createdAt ?? '')).toBeGreaterThan(Date.UTC(2026, 0, 1));
  });
});
