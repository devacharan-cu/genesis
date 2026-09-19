/**
 * The goal system (SPEC-01 §5). Every rule is tested by making it refuse, and
 * every refusal is checked to have changed nothing.
 */

import { blockingUncertainties, checkContribution, childGoals, isCheckable } from '@genesis/cognition';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, expectRefused, HUMAN, Mind, SYSTEM, testCriterion } from './support.js';

let mind: Mind;
beforeEach(() => {
  mind = new Mind();
});

const propose = (over: Record<string, unknown> = {}): string => {
  mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'ship P2', priority: 50, ...over });
  return mind.lastId('goal');
};

const activeGoal = (over: Record<string, unknown> = {}): string => {
  const id = propose({ successCriteria: [testCriterion()], ...over });
  mind.run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: id });
  return id;
};

const criterionOf = (goalId: string, index = 0): string => {
  const c = mind.state.goals[goalId]?.successCriteria[index];
  if (c === undefined) throw new Error('no criterion');
  return c.id;
};

describe('proposing goals', () => {
  it('records a PROPOSED goal with its criteria, creator and time', () => {
    const id = propose({ successCriteria: [testCriterion(), { statement: 'dev signs off', checkKind: 'HUMAN_CONFIRMATION' }] });
    const goal = mind.state.goals[id];
    expect(goal?.status).toBe('PROPOSED');
    expect(goal?.parentId).toBeNull();
    expect(goal?.successCriteria.map((c) => [c.checkKind, c.checkRef, c.met])).toEqual([
      ['TEST', 'test:suite', false],
      ['HUMAN_CONFIRMATION', null, false],
    ]);
    expect(goal?.createdBy).toEqual({ actorKind: 'HUMAN', actorId: 'dev' });
    expect(goal?.history).toEqual([]);
  });

  it('builds a tree through parentId', () => {
    const parent = propose();
    const child = propose({ parentId: parent });
    expect(mind.state.goals[child]?.parentId).toBe(parent);
    expect(childGoals(mind.state, parent).map((g) => g.id)).toEqual([child]);
  });

  it('refuses a parent that does not exist', () => {
    expectRefused(mind, 'PARENT_NOT_FOUND', () => propose({ parentId: 'goal-404' }));
  });

  it('refuses a parent that is closed', () => {
    const parent = propose();
    mind.run(HUMAN, { kind: 'ABANDON_GOAL', goalId: parent, reason: 'descoped' });
    expectRefused(mind, 'GOAL_CLOSED', () => propose({ parentId: parent }));
  });

  it('refuses a priority outside 0..100 or a blank description', () => {
    expectRefused(mind, 'INVALID_COMMAND', () => propose({ priority: 101 }));
    expectRefused(mind, 'INVALID_COMMAND', () => propose({ priority: 1.5 }));
    expectRefused(mind, 'INVALID_COMMAND', () => propose({ description: '   ' }));
  });
});

describe('criteria and priority', () => {
  it('adds a criterion to an open goal', () => {
    const id = propose();
    mind.run(HUMAN, { kind: 'ADD_SUCCESS_CRITERION', goalId: id, statement: 'docs updated', checkKind: 'EVIDENCE' });
    expect(mind.state.goals[id]?.successCriteria).toHaveLength(1);
  });

  it('refuses a criterion on a missing or closed goal', () => {
    expectRefused(mind, 'GOAL_NOT_FOUND', () =>
      mind.run(HUMAN, { kind: 'ADD_SUCCESS_CRITERION', goalId: 'goal-9', statement: 'x', checkKind: 'TEST' }),
    );
    const id = propose();
    mind.run(HUMAN, { kind: 'ABANDON_GOAL', goalId: id, reason: 'no' });
    expectRefused(mind, 'GOAL_CLOSED', () =>
      mind.run(HUMAN, { kind: 'ADD_SUCCESS_CRITERION', goalId: id, statement: 'x', checkKind: 'TEST' }),
    );
  });

  it('changes priority, and refuses a change that is not one', () => {
    const id = propose();
    mind.run(HUMAN, { kind: 'SET_GOAL_PRIORITY', goalId: id, priority: 90 });
    expect(mind.state.goals[id]?.priority).toBe(90);
    expectRefused(mind, 'NO_CHANGE', () => mind.run(HUMAN, { kind: 'SET_GOAL_PRIORITY', goalId: id, priority: 90 }));
  });

  it('refuses a priority change on a closed goal', () => {
    const id = propose();
    mind.run(HUMAN, { kind: 'ABANDON_GOAL', goalId: id, reason: 'no' });
    expectRefused(mind, 'GOAL_CLOSED', () => mind.run(HUMAN, { kind: 'SET_GOAL_PRIORITY', goalId: id, priority: 1 }));
  });

  it('knows what is checkable', () => {
    const base = { id: 'c', statement: 's', met: false, metAt: null, metBy: null, evidenceRef: null };
    expect(isCheckable({ ...base, checkKind: 'HUMAN_CONFIRMATION', checkRef: null })).toBe(true);
    expect(isCheckable({ ...base, checkKind: 'TEST', checkRef: 't' })).toBe(true);
    expect(isCheckable({ ...base, checkKind: 'EVIDENCE', checkRef: null })).toBe(false);
  });
});

describe('activation (SPEC-01 §5.1)', () => {
  it('activates a goal with a checkable criterion, and records the transition', () => {
    const id = activeGoal();
    const goal = mind.state.goals[id];
    expect(goal?.status).toBe('ACTIVE');
    expect(goal?.history.map((h) => `${h.from}->${h.to}`)).toEqual(['PROPOSED->ACTIVE']);
  });

  it('refuses a goal with no criterion at all', () => {
    const id = propose();
    expectRefused(mind, 'NO_CHECKABLE_CRITERION', () => mind.run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: id }));
  });

  it('refuses a goal whose only criteria name no check', () => {
    const id = propose({ successCriteria: [{ statement: 'works', checkKind: 'EVIDENCE' }] });
    expectRefused(mind, 'NO_CHECKABLE_CRITERION', () => mind.run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: id }));
  });

  it('refuses a goal that is not PROPOSED or BLOCKED', () => {
    const id = activeGoal();
    expectRefused(mind, 'GOAL_NOT_ACTIVATABLE', () => mind.run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: id }));
  });

  it('refuses a child whose parent has closed since it was proposed', () => {
    const parent = propose();
    const child = propose({ parentId: parent, successCriteria: [testCriterion()] });
    mind.run(HUMAN, { kind: 'ABANDON_GOAL', goalId: parent, reason: 'descoped' });
    expectRefused(mind, 'PARENT_CLOSED', () => mind.run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: child }));
  });

  it('activates a child under an open parent', () => {
    const parent = propose();
    const child = activeGoal({ parentId: parent });
    expect(mind.state.goals[child]?.status).toBe('ACTIVE');
  });

  it('blocks with a reason and unblocks by activating again', () => {
    const id = activeGoal();
    mind.run(HUMAN, { kind: 'BLOCK_GOAL', goalId: id, reason: 'waiting on credentials' });
    expect(mind.state.goals[id]?.status).toBe('BLOCKED');
    mind.run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: id, reason: 'credentials arrived' });
    expect(mind.state.goals[id]?.history.map((h) => h.reason)).toEqual([
      null,
      'waiting on credentials',
      'credentials arrived',
    ]);
  });

  it('refuses blocking without a reason, or a goal that is not ACTIVE', () => {
    const id = activeGoal();
    expectRefused(mind, 'REASON_REQUIRED', () => mind.run(HUMAN, { kind: 'BLOCK_GOAL', goalId: id }));
    expectRefused(mind, 'REASON_REQUIRED', () => mind.run(HUMAN, { kind: 'BLOCK_GOAL', goalId: id, reason: '  ' }));
    const proposed = propose();
    expectRefused(mind, 'GOAL_NOT_ACTIVE', () =>
      mind.run(HUMAN, { kind: 'BLOCK_GOAL', goalId: proposed, reason: 'x' }),
    );
  });
});

describe('meeting criteria', () => {
  it('meets a test criterion with evidence from a non-agent', () => {
    const id = activeGoal();
    mind.run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: id, criterionId: criterionOf(id), evidenceRef: 'ev-1' });
    const c = mind.state.goals[id]?.successCriteria[0];
    expect([c?.met, c?.metBy, c?.evidenceRef]).toEqual([true, 'runner', 'ev-1']);
  });

  it('refuses a test criterion on an agent’s say-so', () => {
    const id = activeGoal();
    expectRefused(mind, 'AGENT_CANNOT_CONFIRM_TEST', () =>
      mind.run(AGENT, { kind: 'MARK_CRITERION_MET', goalId: id, criterionId: criterionOf(id), evidenceRef: 'ev-1' }),
    );
  });

  it('lets an agent meet an EVIDENCE criterion when it cites evidence', () => {
    const id = activeGoal({ successCriteria: [{ statement: 'docs', checkKind: 'EVIDENCE', checkRef: 'q:docs' }] });
    mind.run(AGENT, { kind: 'MARK_CRITERION_MET', goalId: id, criterionId: criterionOf(id), evidenceRef: 'ev-2' });
    expect(mind.state.goals[id]?.successCriteria[0]?.met).toBe(true);
  });

  it('refuses a machine-checked criterion with no evidence', () => {
    const id = activeGoal();
    expectRefused(mind, 'CRITERION_NEEDS_EVIDENCE', () =>
      mind.run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: id, criterionId: criterionOf(id) }),
    );
  });

  it('meets a human-confirmation criterion only when a human confirms it', () => {
    const id = activeGoal({ successCriteria: [{ statement: 'sign-off', checkKind: 'HUMAN_CONFIRMATION' }] });
    expectRefused(mind, 'CRITERION_NEEDS_HUMAN', () =>
      mind.run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: id, criterionId: criterionOf(id) }),
    );
    mind.run(HUMAN, { kind: 'MARK_CRITERION_MET', goalId: id, criterionId: criterionOf(id) });
    expect(mind.state.goals[id]?.successCriteria[0]?.evidenceRef).toBeNull();
  });

  it('meets criteria on a BLOCKED goal too', () => {
    const id = activeGoal();
    mind.run(HUMAN, { kind: 'BLOCK_GOAL', goalId: id, reason: 'x' });
    mind.run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: id, criterionId: criterionOf(id), evidenceRef: 'e' });
    expect(mind.state.goals[id]?.successCriteria[0]?.met).toBe(true);
  });

  it('refuses a criterion on a goal that is not active, unknown, or already met', () => {
    const proposed = propose({ successCriteria: [testCriterion()] });
    expectRefused(mind, 'GOAL_NOT_ACTIVE', () =>
      mind.run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: proposed, criterionId: criterionOf(proposed), evidenceRef: 'e' }),
    );
    const id = activeGoal();
    expectRefused(mind, 'CRITERION_NOT_FOUND', () =>
      mind.run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: id, criterionId: 'crit-404', evidenceRef: 'e' }),
    );
    mind.run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: id, criterionId: criterionOf(id), evidenceRef: 'e' });
    expectRefused(mind, 'CRITERION_ALREADY_MET', () =>
      mind.run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: id, criterionId: criterionOf(id), evidenceRef: 'e' }),
    );
  });
});

describe('satisfying (SPEC-01 §5)', () => {
  const meetAll = (id: string): void => {
    for (const c of mind.state.goals[id]?.successCriteria ?? []) {
      mind.run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: id, criterionId: c.id, evidenceRef: `ev-${c.id}` });
    }
  };

  it('satisfies a goal whose criteria are all met, and stamps closedAt', () => {
    const id = activeGoal();
    meetAll(id);
    mind.run(HUMAN, { kind: 'SATISFY_GOAL', goalId: id, reason: 'shipped' });
    const goal = mind.state.goals[id];
    expect(goal?.status).toBe('SATISFIED');
    expect(goal?.closedAt).not.toBeNull();
  });

  it('refuses while any criterion is unmet', () => {
    const id = activeGoal({ successCriteria: [testCriterion('a'), testCriterion('b')] });
    mind.run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: id, criterionId: criterionOf(id, 0), evidenceRef: 'e' });
    expectRefused(mind, 'UNMET_CRITERIA', () => mind.run(HUMAN, { kind: 'SATISFY_GOAL', goalId: id }));
  });

  it('refuses while a child is ACTIVE or BLOCKED', () => {
    const parent = activeGoal();
    const child = activeGoal({ parentId: parent });
    meetAll(parent);
    expectRefused(mind, 'OPEN_CHILDREN', () => mind.run(HUMAN, { kind: 'SATISFY_GOAL', goalId: parent }));
    mind.run(HUMAN, { kind: 'BLOCK_GOAL', goalId: child, reason: 'x' });
    expectRefused(mind, 'OPEN_CHILDREN', () => mind.run(HUMAN, { kind: 'SATISFY_GOAL', goalId: parent }));
  });

  it('allows a parent to close over PROPOSED or closed children', () => {
    const parent = activeGoal();
    propose({ parentId: parent });
    const done = activeGoal({ parentId: parent });
    meetAll(done);
    mind.run(HUMAN, { kind: 'SATISFY_GOAL', goalId: done });
    meetAll(parent);
    mind.run(HUMAN, { kind: 'SATISFY_GOAL', goalId: parent });
    expect(mind.state.goals[parent]?.status).toBe('SATISFIED');
  });

  it('refuses while an open uncertainty blocks it, and allows it once that closes', () => {
    const id = activeGoal();
    meetAll(id);
    mind.run(HUMAN, {
      kind: 'RECORD_UNCERTAINTY',
      statement: 'is the region right?',
      whatBreaksIfWrong: 'deploys to the wrong place',
      risk: 'HIGH',
      resolution: 'ASK_HUMAN',
      blocksGoalIds: [id],
    });
    const u = mind.lastId('uncertainty');
    expect(blockingUncertainties(mind.state, id)).toEqual([u]);
    expectRefused(mind, 'BLOCKED_BY_UNCERTAINTY', () => mind.run(HUMAN, { kind: 'SATISFY_GOAL', goalId: id }));

    mind.run(HUMAN, { kind: 'START_RESOLVING', uncertaintyId: u });
    expect(blockingUncertainties(mind.state, id)).toEqual([u]);
    mind.run(HUMAN, { kind: 'RESOLVE_UNCERTAINTY', uncertaintyId: u, evidence: ['answer-1'] });
    expect(blockingUncertainties(mind.state, id)).toEqual([]);
    mind.run(HUMAN, { kind: 'SATISFY_GOAL', goalId: id });
    expect(mind.state.goals[id]?.status).toBe('SATISFIED');
  });

  it('refuses a goal that is not ACTIVE', () => {
    const id = propose({ successCriteria: [testCriterion()] });
    expectRefused(mind, 'GOAL_NOT_ACTIVE', () => mind.run(HUMAN, { kind: 'SATISFY_GOAL', goalId: id }));
  });

  it('never reopens a satisfied goal', () => {
    const id = activeGoal();
    meetAll(id);
    mind.run(HUMAN, { kind: 'SATISFY_GOAL', goalId: id });
    expectRefused(mind, 'GOAL_NOT_ACTIVATABLE', () => mind.run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: id }));
    expectRefused(mind, 'GOAL_CLOSED', () => mind.run(HUMAN, { kind: 'ABANDON_GOAL', goalId: id, reason: 'x' }));
  });
});

describe('abandoning', () => {
  it('abandons with a reason', () => {
    const id = activeGoal();
    mind.run(HUMAN, { kind: 'ABANDON_GOAL', goalId: id, reason: 'descoped' });
    expect(mind.state.goals[id]?.status).toBe('ABANDONED');
    expect(mind.state.goals[id]?.history.at(-1)?.reason).toBe('descoped');
  });

  it('refuses without a reason', () => {
    const id = activeGoal();
    expectRefused(mind, 'REASON_REQUIRED', () => mind.run(HUMAN, { kind: 'ABANDON_GOAL', goalId: id }));
  });

  it('never cascades to open children silently', () => {
    const parent = activeGoal();
    activeGoal({ parentId: parent });
    expectRefused(mind, 'OPEN_CHILDREN', () =>
      mind.run(HUMAN, { kind: 'ABANDON_GOAL', goalId: parent, reason: 'descoped' }),
    );
  });
});

describe('goal drift (SPEC-01 §5.2, conditions 1 and 2)', () => {
  it('flags an action that contributes to nothing', () => {
    expect(checkContribution(mind.state, [])).toEqual({ drift: true, reason: 'NO_CONTRIBUTION', unknownGoals: [] });
  });

  it('flags an action whose goals are not ACTIVE, naming the unknown ones', () => {
    const proposed = propose();
    expect(checkContribution(mind.state, [proposed, 'goal-404'])).toEqual({
      drift: true,
      reason: 'NO_ACTIVE_GOAL',
      unknownGoals: ['goal-404'],
    });
  });

  it('accepts an action contributing to at least one ACTIVE goal', () => {
    const id = activeGoal();
    expect(checkContribution(mind.state, ['goal-404', id])).toEqual({ drift: false });
  });
});
