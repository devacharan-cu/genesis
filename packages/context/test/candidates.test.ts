/**
 * Candidate builders (SPEC-01 §11.1, §11.3). The questions that matter: which
 * records are candidates at all, which are MANDATORY, and whether distances and
 * authorities are read from trustworthy places.
 */

import type { CognitionState } from '@genesis/cognition';
import {
  cognitionCandidates,
  type ContextCandidate,
  goalDistance,
  graphCandidates,
  knownFailureCandidates,
  memoryCandidates,
  nodeDistances,
  policyCandidates,
  signatureMatches,
} from '@genesis/context';
import type { GraphNode, ImpactEntry } from '@genesis/graph';
import type { MemoryRecord } from '@genesis/memory';
import { selfModelProjector } from '@genesis/projections';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, Cognition, HUMAN, parsed, SYSTEM } from './support.js';

const impact = (nodeId: string, depth: number, weakestAuthorityRank = 4): ImpactEntry =>
  ({ nodeId, depth, weakestAuthorityRank }) as ImpactEntry;

const byId = (candidates: readonly ContextCandidate[], id: string): ContextCandidate | undefined =>
  candidates.find((c) => c.id === id);

let mind: Cognition;
beforeEach(() => {
  mind = new Cognition();
});

const criterion = { statement: 's', checkKind: 'TEST', checkRef: 't' };

describe('distances', () => {
  it('puts the task’s nodes at 0 and keeps the nearest depth for the rest', () => {
    const d = nodeDistances(['node_task'], [impact('node_a', 3), impact('node_a', 1), impact('node_task', 2)]);
    expect([...d.entries()].sort()).toEqual([
      ['node_a', 1],
      ['node_task', 0],
    ]);
  });

  it('measures goal distance through the nearest common ancestor', () => {
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'root', priority: 1 });
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'a', priority: 1, parentId: 'goal-1' });
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'b', priority: 1, parentId: 'goal-1' });
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'a.1', priority: 1, parentId: 'goal-2' });
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'elsewhere', priority: 1 });
    const s = mind.state;
    expect(goalDistance(s, 'goal-2', 'goal-2')).toBe(0);
    expect(goalDistance(s, 'goal-2', 'goal-1')).toBe(1);
    expect(goalDistance(s, 'goal-4', 'goal-3')).toBe(3);
    expect(goalDistance(s, 'goal-4', 'goal-5')).toBeNull();
    expect(goalDistance(s, 'goal-404', 'goal-1')).toBeNull();
  });
});

describe('cognitionCandidates', () => {
  it('offers open goals with their progress, and never closed ones', () => {
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'ship', priority: 9, successCriteria: [criterion, criterion] });
    mind.run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: 'goal-1' });
    mind.run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: 'goal-1', criterionId: 'crit-1', evidenceRef: 'run-1' });
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'bare', priority: 1 });
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'dropped', priority: 1 });
    mind.run(HUMAN, { kind: 'ABANDON_GOAL', goalId: 'goal-3', reason: 'descoped' });

    const out = cognitionCandidates(mind.state, parsed({ activeGoalId: 'goal-1' }));
    expect(byId(out, 'goal:goal-1')).toMatchObject({
      text: 'Goal (ACTIVE, priority 9): ship',
      authority: 'HUMAN_DECISION',
      goalDistance: 0,
      evidenceStrength: 0.5,
      timestamp: mind.state.goals['goal-1']?.history.at(-1)?.at,
      mandatory: null,
      source: { store: 'COGNITION', id: 'goal-1', version: null },
    });
    expect(byId(out, 'goal:goal-2')).toMatchObject({ evidenceStrength: 0, goalDistance: null, timestamp: mind.state.goals['goal-2']?.createdAt });
    expect(byId(out, 'goal:goal-3')).toBeUndefined();
  });

  it('offers every belief, says when one lost on authority, and places it by its subjects', () => {
    mind.run(AGENT, {
      kind: 'RECORD_BELIEF',
      statement: 'cancellation is free',
      state: 'ASSUMED',
      rationale: 'r',
      subjectRefs: [{ nodeType: 'COMPONENT', nodeId: 'node_b' }],
    });
    mind.run(HUMAN, { kind: 'RECORD_BELIEF', statement: 'cancellation costs a fee', authority: 'HUMAN_DECISION' });
    mind.run(HUMAN, {
      kind: 'RECORD_CONTRADICTION',
      contradictionKind: 'BELIEF_EVIDENCE',
      sides: [
        { kind: 'BELIEF', beliefId: 'bel-1' },
        { kind: 'BELIEF', beliefId: 'bel-2' },
      ],
    });
    const out = cognitionCandidates(mind.state, parsed({ task: { nodeIds: ['node_a'] } }), [impact('node_b', 2)]);
    expect(byId(out, 'belief:bel-1')).toMatchObject({
      text: 'Belief (ASSUMED [superseded by authority]): cancellation is free',
      authority: 'AI_ASSUMPTION',
      dependencyDistance: 2,
      evidenceStrength: 0.2,
    });
    expect(byId(out, 'belief:bel-2')).toMatchObject({ text: 'Belief (UNKNOWN): cancellation costs a fee', dependencyDistance: null, evidenceStrength: 0 });
    // Decided by authority: as established as the side that governs.
    expect(byId(out, 'contradiction:ctr-1')).toMatchObject({ authority: 'HUMAN_DECISION', mandatory: null, dependencyDistance: 2 });
  });

  it('makes an open uncertainty blocking the ACTIVE goal mandatory, and nothing else', () => {
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'ship', priority: 9, successCriteria: [criterion] });
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'other', priority: 1, successCriteria: [criterion] });
    const record = (over: Record<string, unknown>) =>
      mind.run(SYSTEM, { kind: 'RECORD_UNCERTAINTY', statement: 's', whatBreaksIfWrong: 'w', risk: 'HIGH', resolution: 'ASK_HUMAN', ...over });
    record({ blocksGoalIds: ['goal-1'], affectedRefs: [{ nodeType: 'API', nodeId: 'node_a' }] });
    record({ blocksGoalIds: ['goal-2'] });
    record({});
    record({ blocksGoalIds: ['goal-1'] });
    mind.run(HUMAN, { kind: 'ACCEPT_UNCERTAINTY', uncertaintyId: 'unc-4', reason: 'live with it' });

    const out = cognitionCandidates(mind.state, parsed({ activeGoalId: 'goal-1', task: { nodeIds: ['node_a'] } }));
    expect(byId(out, 'uncertainty:unc-1')).toMatchObject({
      mandatory: 'BLOCKING_UNCERTAINTY',
      goalDistance: 0,
      dependencyDistance: 0,
      authority: 'VERIFIED_SYSTEM_STATE',
      text: 'Open question (HIGH risk, OPEN): s — if wrong: w',
    });
    expect(byId(out, 'uncertainty:unc-2')?.mandatory).toBeNull();
    expect(byId(out, 'uncertainty:unc-3')?.mandatory).toBeNull();
    expect(byId(out, 'uncertainty:unc-4')).toBeUndefined();
    // With no active goal, nothing blocks it.
    expect(cognitionCandidates(mind.state, parsed()).filter((c) => c.mandatory !== null)).toEqual([]);
  });

  it('makes an escalated contradiction in the impact set mandatory, at its weaker side’s authority', () => {
    mind.run(AGENT, {
      kind: 'RECORD_CONTRADICTION',
      contradictionKind: 'DOCUMENTATION_IMPLEMENTATION',
      sides: [
        { kind: 'EXTERNAL', id: 'doc', claim: 'free', authority: 'HUMAN_DECISION' },
        { kind: 'EXTERNAL', id: 'code', claim: 'fee', authority: 'EVIDENCE' },
      ],
      affectedRefs: [{ nodeType: 'COMPONENT', nodeId: 'node_b' }],
    });
    mind.run(AGENT, {
      kind: 'RECORD_CONTRADICTION',
      contradictionKind: 'REQUIREMENT_TEST',
      sides: [
        { kind: 'EXTERNAL', id: 'req', claim: 'x', authority: 'EVIDENCE' },
        { kind: 'EXTERNAL', id: 'test', claim: 'y', authority: 'HISTORICAL' },
      ],
      affectedRefs: [{ nodeType: 'COMPONENT', nodeId: 'node_far' }],
    });
    const out = cognitionCandidates(mind.state, parsed(), [impact('node_b', 1)]);
    expect(byId(out, 'contradiction:ctr-1')).toMatchObject({
      mandatory: 'CONTRADICTION_IN_IMPACT',
      // An agent asserted HUMAN_DECISION for one side; that cannot lift the record.
      authority: 'EVIDENCE',
      text: 'Contradiction (ESCALATED): "free" [HUMAN_DECISION] vs "fee" [EVIDENCE]',
    });
    expect(byId(out, 'contradiction:ctr-2')).toMatchObject({ mandatory: null, authority: 'HISTORICAL', dependencyDistance: null });

    // Once a person decides it, it is history: timestamped by the decision, no longer mandatory.
    mind.run(HUMAN, { kind: 'RESOLVE_CONTRADICTION', contradictionId: 'ctr-1', governingSide: 1, reason: 'the code is right' });
    const after = byId(cognitionCandidates(mind.state, parsed(), [impact('node_b', 1)]), 'contradiction:ctr-1');
    expect(after).toMatchObject({ mandatory: null, authority: 'EVIDENCE', timestamp: mind.state.contradictions['ctr-1']?.resolution?.at });
  });

  it('reaches a contradiction through the subjects of a belief on either side, and tolerates a missing one', () => {
    mind.run(AGENT, { kind: 'RECORD_BELIEF', statement: 'a', subjectRefs: [{ nodeType: 'COMPONENT', nodeId: 'node_b' }] });
    mind.run(AGENT, {
      kind: 'RECORD_CONTRADICTION',
      contradictionKind: 'BELIEF_EVIDENCE',
      sides: [
        { kind: 'BELIEF', beliefId: 'bel-1' },
        { kind: 'EXTERNAL', id: 'x', claim: 'not a', authority: 'EVIDENCE' },
      ],
    });
    expect(byId(cognitionCandidates(mind.state, parsed(), [impact('node_b', 1)]), 'contradiction:ctr-1')?.mandatory).toBe(
      'CONTRADICTION_IN_IMPACT',
    );
    const { 'bel-1': _gone, ...beliefs } = mind.state.beliefs;
    const damaged: CognitionState = { ...mind.state, beliefs };
    expect(byId(cognitionCandidates(damaged, parsed(), [impact('node_b', 1)]), 'contradiction:ctr-1')?.mandatory).toBeNull();
  });

  it('offers a person’s answers as decisions, and nothing for unanswered questions', () => {
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'ship', priority: 9, successCriteria: [criterion] });
    const ask = (statement: string) => {
      mind.run(SYSTEM, { kind: 'RECORD_UNCERTAINTY', statement, whatBreaksIfWrong: 'w', risk: 'LOW', resolution: 'ASK_HUMAN', blocksGoalIds: ['goal-1'] });
    };
    ask('fee?');
    ask('region?');
    mind.run(SYSTEM, { kind: 'DRAFT_QUESTION', uncertaintyId: 'unc-1', text: 'Is there a cancellation fee?' });
    mind.run(SYSTEM, { kind: 'DRAFT_QUESTION', uncertaintyId: 'unc-2', text: 'Which region?' });
    mind.run(SYSTEM, { kind: 'ASK_QUESTIONS', questionIds: ['qst-1', 'qst-2'] });
    mind.run(HUMAN, {
      kind: 'RESPOND_TO_QUESTION',
      questionId: 'qst-1',
      response: { kind: 'ANSWER', text: 'yes, 10%', evidence: ['policy-doc'] },
    });
    const out = cognitionCandidates(mind.state, parsed({ activeGoalId: 'goal-1' }));
    expect(byId(out, 'answer:qst-1')).toMatchObject({
      kind: 'ANSWER',
      text: 'Q: Is there a cancellation fee? — ANSWER: yes, 10%',
      authority: 'HUMAN_DECISION',
      goalDistance: 0,
      evidenceStrength: 0.5,
    });
    expect(byId(out, 'answer:qst-2')).toBeUndefined();
  });
});

describe('knownFailureCandidates', () => {
  it('makes every failure matching the task kind mandatory, by the provisional signature rule', () => {
    expect(signatureMatches('implement', 'implement')).toBe(true);
    expect(signatureMatches('implement:timeout', 'implement')).toBe(true);
    expect(signatureMatches('implementation:timeout', 'implement')).toBe(false);

    const self = selfModelProjector.initial();
    const at = '2026-02-10T00:00:00.000Z';
    const model = {
      ...self,
      knownFailures: {
        'implement:timeout': { signature: 'implement:timeout', occurrences: 6, firstSeen: at, lastSeen: at, mitigation: 'raise the limit' },
        implement: { signature: 'implement', occurrences: 1, firstSeen: at, lastSeen: at, mitigation: null },
        'deploy:perm': { signature: 'deploy:perm', occurrences: 2, firstSeen: at, lastSeen: at, mitigation: null },
      },
    };
    const out = knownFailureCandidates(model, parsed());
    expect(out.map((c) => [c.id, c.mandatory, c.evidenceStrength])).toEqual([
      ['failure:implement:timeout', 'MATCHING_FAILURE', 1],
      ['failure:implement', 'MATCHING_FAILURE', 0.25],
    ]);
    expect(out[0]?.text).toBe('Known failure implement:timeout (seen 6x); mitigation: raise the limit');
    expect(out[1]?.text).toBe('Known failure implement (seen 1x)');
  });
});

describe('policyCandidates', () => {
  it('makes every applicable policy mandatory', () => {
    expect(policyCandidates([{ id: 'no-prod', text: 'never touch production', authority: 'HUMAN_DECISION' }])).toEqual([
      {
        id: 'policy:no-prod',
        kind: 'POLICY',
        text: 'Policy: never touch production',
        authority: 'HUMAN_DECISION',
        goalDistance: null,
        dependencyDistance: null,
        evidenceStrength: 0,
        timestamp: null,
        mandatory: 'POLICY',
        source: { store: 'POLICY', id: 'no-prod', version: null },
      },
    ]);
  });
});

describe('memoryCandidates', () => {
  const memory = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
    ({
      id,
      class: 'SEMANTIC',
      status: 'ACTIVE',
      content: { statement: `fact ${id}`, body: null },
      authority: 'EVIDENCE',
      relatedEntities: [],
      evidenceRefs: [],
      updatedAt: '2026-02-01T00:00:00.000Z',
      version: 2,
      ...over,
    }) as MemoryRecord;

  it('offers records visible by default, labels a contradicted one, and records the version used', () => {
    const out = memoryCandidates(
      [
        memory('mem_a', { relatedEntities: [{ nodeType: 'COMPONENT', nodeId: 'node_b' } as MemoryRecord['relatedEntities'][number]], evidenceRefs: ['m1', 'm2'] as never }),
        memory('mem_b', { status: 'CONTRADICTED' }),
        memory('mem_c', { status: 'SUPERSEDED' }),
        memory('mem_d', { status: 'RETRACTED' }),
      ],
      parsed(),
      [impact('node_b', 3)],
    );
    expect(out.map((c) => c.id)).toEqual(['memory:mem_a', 'memory:mem_b']);
    expect(out[0]).toMatchObject({ dependencyDistance: 3, evidenceStrength: 0.5, source: { store: 'MEMORY', id: 'mem_a', version: 2 } });
    expect(out[1]?.text).toBe('SEMANTIC memory [contradicted]: fact mem_b');
  });
});

describe('graphCandidates', () => {
  const node = (id: string, status: GraphNode['status'] = 'ACTIVE'): GraphNode =>
    ({ id, type: 'COMPONENT', label: id.slice(5), status, updatedAt: '2026-02-01T00:00:00.000Z', version: 1 }) as GraphNode;

  it('offers active nodes in the impact set, as established as their weakest edge', () => {
    const out = graphCandidates(
      [node('node_b'), node('node_c', 'ARCHIVED'), node('node_z')],
      [impact('node_b', 2, 6), impact('node_c', 1)],
    );
    expect(out).toEqual([
      expect.objectContaining({ id: 'node:node_b', text: 'COMPONENT b', authority: 'AI_ASSUMPTION', dependencyDistance: 2 }),
    ]);
  });
});
