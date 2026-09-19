/**
 * The fold's defensive paths (ADR-0014 rule 3, ADR-0013 rule 4).
 *
 * No decider produces these events. They are what tampering, a bug upstream, or
 * an event written by another version of the code would look like. For every
 * one, the fold must (a) change nothing but the observation log and (b) say
 * what it refused. A fold that threw would make the projection unbuildable; a
 * fold that applied them would believe something no rule allowed.
 */

import { type CognitiveEventInput, decide, type CognitionState } from '@genesis/cognition';
import type { JsonValue } from '@genesis/core-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { evidence, HUMAN, Mind, SYSTEM, testCriterion } from './support.js';

let mind: Mind;
beforeEach(() => {
  mind = new Mind();
});

const withoutLog = (s: CognitionState): Omit<CognitionState, 'observations'> => {
  const { observations: _ignored, ...rest } = s;
  return rest;
};

/** The events a command WOULD produce, without folding them. */
const decided = (command: unknown, actor = HUMAN): CognitiveEventInput[] => decide(mind.state, command, mind.ctx(actor));

const one = (command: unknown, actor = HUMAN): CognitiveEventInput => {
  const [first] = decided(command, actor);
  if (first === undefined) throw new Error('no event');
  return first;
};

function expectAnomaly(kind: string, type: string, payload: JsonValue, actor = HUMAN): void {
  const before = withoutLog(mind.state);
  const count = mind.state.observations.anomalies.length;
  mind.fold({ type, actor, authority: 'HUMAN_DECISION', subject: null, payload, timestamp: '2026-01-01T00:00:00.000Z' });
  expect(withoutLog(mind.state), 'the fold must not apply it').toEqual(before);
  expect(mind.state.observations.anomalies).toHaveLength(count + 1);
  expect(mind.state.observations.anomalies.at(-1)?.kind).toBe(kind);
}

const payloadOf = (input: CognitiveEventInput): Record<string, JsonValue> => input.payload as Record<string, JsonValue>;

// ----------------------------------------------------------------------- goals

describe('goal events', () => {
  const proposeGoal = (over: Record<string, unknown> = {}): string => {
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'g', priority: 5, successCriteria: [testCriterion()], ...over });
    return mind.lastId('goal');
  };

  it('refuses a malformed payload, naming the field', () => {
    expectAnomaly('MALFORMED_PAYLOAD', 'GOAL_PROPOSED', { goal: 42 });
    expect(mind.state.observations.anomalies.at(-1)?.detail).toMatch(/^payload: goal:/);
  });

  it('refuses a payload that is not an object at all, naming the root', () => {
    expectAnomaly('MALFORMED_PAYLOAD', 'GOAL_PROPOSED', null);
    expect(mind.state.observations.anomalies.at(-1)?.detail).toMatch(/^payload: <root>:/);
  });

  it('refuses a goal proposed twice, born in the wrong status, or under an unknown parent', () => {
    const template = one({ kind: 'PROPOSE_GOAL', description: 'g', priority: 5 });
    mind.fold(template);
    const goal = payloadOf(template)['goal'] as Record<string, JsonValue>;
    expectAnomaly('STATE_MISMATCH', 'GOAL_PROPOSED', { goal });
    expectAnomaly('STATE_MISMATCH', 'GOAL_PROPOSED', { goal: { ...goal, id: 'goal-x', status: 'ACTIVE' } });
    expectAnomaly('UNKNOWN_REFERENCE', 'GOAL_PROPOSED', { goal: { ...goal, id: 'goal-y', parentId: 'goal-404' } });
  });

  it('refuses events for a goal that does not exist', () => {
    expectAnomaly('UNKNOWN_REFERENCE', 'GOAL_STATUS_CHANGED', { goalId: 'goal-404', from: 'PROPOSED', to: 'ACTIVE', reason: null });
  });

  it('refuses a criterion added to a closed goal, or added twice', () => {
    const id = proposeGoal();
    const criterion = mind.state.goals[id]?.successCriteria[0] as unknown as JsonValue;
    expectAnomaly('STATE_MISMATCH', 'GOAL_CRITERION_ADDED', { goalId: id, criterion });
    mind.run(HUMAN, { kind: 'ABANDON_GOAL', goalId: id, reason: 'x' });
    expectAnomaly('STATE_MISMATCH', 'GOAL_CRITERION_ADDED', {
      goalId: id,
      criterion: { ...(criterion as Record<string, JsonValue>), id: 'crit-new' },
    });
  });

  it('refuses meeting a criterion that is unknown or already met', () => {
    const id = proposeGoal();
    mind.run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: id });
    const crit = mind.state.goals[id]?.successCriteria[0]?.id ?? '';
    expectAnomaly('UNKNOWN_REFERENCE', 'GOAL_CRITERION_MET', { goalId: id, criterionId: 'crit-404', evidenceRef: null });
    mind.run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: id, criterionId: crit, evidenceRef: 'e' });
    expectAnomaly('STATE_MISMATCH', 'GOAL_CRITERION_MET', { goalId: id, criterionId: crit, evidenceRef: null });
  });

  it('refuses a priority change from a priority the goal does not have', () => {
    const id = proposeGoal();
    expectAnomaly('STATE_MISMATCH', 'GOAL_PRIORITY_SET', { goalId: id, from: 99, to: 1 });
  });

  it('refuses a status change from the wrong status, or out of a terminal one', () => {
    const id = proposeGoal();
    expectAnomaly('STATE_MISMATCH', 'GOAL_STATUS_CHANGED', { goalId: id, from: 'ACTIVE', to: 'SATISFIED', reason: null });
    mind.run(HUMAN, { kind: 'ABANDON_GOAL', goalId: id, reason: 'x' });
    expectAnomaly('STATE_MISMATCH', 'GOAL_STATUS_CHANGED', { goalId: id, from: 'ABANDONED', to: 'ACTIVE', reason: null });
  });
});

// --------------------------------------------------------------------- beliefs

describe('belief events', () => {
  const recordBelief = (): string => {
    mind.run(SYSTEM, { kind: 'RECORD_BELIEF', statement: 'b' });
    return mind.lastId('belief');
  };

  it('refuses a belief recorded twice, or born above ASSUMED', () => {
    const template = one({ kind: 'RECORD_BELIEF', statement: 'b' }, SYSTEM);
    mind.fold(template);
    const belief = payloadOf(template)['belief'] as Record<string, JsonValue>;
    expectAnomaly('STATE_MISMATCH', 'BELIEF_RECORDED', { belief });
    expectAnomaly('STATE_MISMATCH', 'BELIEF_RECORDED', { belief: { ...belief, id: 'bel-x', state: 'VERIFIED' } });
  });

  it('refuses events for a belief that does not exist', () => {
    expectAnomaly('UNKNOWN_REFERENCE', 'BELIEF_STATE_CHANGED', { beliefId: 'bel-404', from: 'UNKNOWN', to: 'ASSUMED', reason: 'r' });
  });

  it('refuses the same evidence twice, on either side', () => {
    const id = recordBelief();
    mind.run(SYSTEM, { kind: 'ADD_BELIEF_EVIDENCE', beliefId: id, polarity: 'SUPPORTING', evidence: evidence('s') });
    mind.run(SYSTEM, { kind: 'ADD_BELIEF_EVIDENCE', beliefId: id, polarity: 'CONTRADICTING', evidence: evidence('c') });
    expectAnomaly('STATE_MISMATCH', 'BELIEF_EVIDENCE_ADDED', { beliefId: id, polarity: 'CONTRADICTING', evidence: evidence('s') });
    expectAnomaly('STATE_MISMATCH', 'BELIEF_EVIDENCE_ADDED', { beliefId: id, polarity: 'SUPPORTING', evidence: evidence('c') });
  });

  it('refuses a state change from the wrong state, to the same state, or skipping a state', () => {
    const id = recordBelief();
    expectAnomaly('STATE_MISMATCH', 'BELIEF_STATE_CHANGED', { beliefId: id, from: 'ASSUMED', to: 'SUPPORTED', reason: null });
    expectAnomaly('STATE_MISMATCH', 'BELIEF_STATE_CHANGED', { beliefId: id, from: 'UNKNOWN', to: 'UNKNOWN', reason: null });
    expectAnomaly('STATE_MISMATCH', 'BELIEF_STATE_CHANGED', { beliefId: id, from: 'UNKNOWN', to: 'VERIFIED', reason: null });
  });

  it('refuses dismissing evidence that is missing or not open', () => {
    const id = recordBelief();
    expectAnomaly('STATE_MISMATCH', 'BELIEF_CONTRADICTING_EVIDENCE_DISMISSED', { beliefId: id, evidenceId: 'nope', reason: 'r' });
    mind.run(SYSTEM, { kind: 'ADD_BELIEF_EVIDENCE', beliefId: id, polarity: 'CONTRADICTING', evidence: evidence('c') });
    mind.run(SYSTEM, { kind: 'DISMISS_CONTRADICTING_EVIDENCE', beliefId: id, evidenceId: 'c', reason: 'r' });
    expectAnomaly('STATE_MISMATCH', 'BELIEF_CONTRADICTING_EVIDENCE_DISMISSED', { beliefId: id, evidenceId: 'c', reason: 'r' });
  });

  it('refuses supersession by a contradiction that does not exist, or twice by the same one', () => {
    const id = recordBelief();
    expectAnomaly('UNKNOWN_REFERENCE', 'BELIEF_SUPERSEDED_BY_AUTHORITY', { beliefId: id, contradictionId: 'ctr-404' });
    mind.run(HUMAN, { kind: 'RECORD_BELIEF', statement: 'h', authority: 'HUMAN_DECISION' });
    const human = mind.lastId('belief');
    mind.run(SYSTEM, {
      kind: 'RECORD_CONTRADICTION',
      contradictionKind: 'BELIEF_EVIDENCE',
      sides: [{ kind: 'BELIEF', beliefId: id }, { kind: 'BELIEF', beliefId: human }],
    });
    const ctr = mind.lastId('contradiction');
    expectAnomaly('STATE_MISMATCH', 'BELIEF_SUPERSEDED_BY_AUTHORITY', { beliefId: id, contradictionId: ctr });
  });
});

// --------------------------------------------------------------- uncertainties

describe('uncertainty events', () => {
  const recordU = (): CognitiveEventInput =>
    one({ kind: 'RECORD_UNCERTAINTY', statement: 's', whatBreaksIfWrong: 'w', risk: 'LOW', resolution: 'SEARCH' }, SYSTEM);

  it('refuses one recorded twice, born closed, or referencing records that do not exist', () => {
    const template = recordU();
    mind.fold(template);
    const u = payloadOf(template)['uncertainty'] as Record<string, JsonValue>;
    expectAnomaly('STATE_MISMATCH', 'UNCERTAINTY_RECORDED', { uncertainty: u });
    expectAnomaly('STATE_MISMATCH', 'UNCERTAINTY_RECORDED', { uncertainty: { ...u, id: 'unc-x', status: 'RESOLVED' } });
    expectAnomaly('UNKNOWN_REFERENCE', 'UNCERTAINTY_RECORDED', { uncertainty: { ...u, id: 'unc-y', blocksGoalIds: ['goal-404'] } });
    expectAnomaly('UNKNOWN_REFERENCE', 'UNCERTAINTY_RECORDED', { uncertainty: { ...u, id: 'unc-z', relatedBeliefs: ['bel-404'] } });
  });

  it('refuses a status change for a missing uncertainty, from the wrong status, or out of a terminal one', () => {
    expectAnomaly('UNKNOWN_REFERENCE', 'UNCERTAINTY_STATUS_CHANGED', {
      uncertaintyId: 'unc-404', from: 'OPEN', to: 'RESOLVED', reason: null, resolutionEvidence: [],
    });
    mind.fold(recordU());
    const id = mind.lastId('uncertainty');
    expectAnomaly('STATE_MISMATCH', 'UNCERTAINTY_STATUS_CHANGED', {
      uncertaintyId: id, from: 'IN_PROGRESS', to: 'RESOLVED', reason: null, resolutionEvidence: [],
    });
    mind.run(SYSTEM, { kind: 'MARK_UNCERTAINTY_OBSOLETE', uncertaintyId: id, reason: 'x' });
    expectAnomaly('STATE_MISMATCH', 'UNCERTAINTY_STATUS_CHANGED', {
      uncertaintyId: id, from: 'OBSOLETE', to: 'OPEN', reason: null, resolutionEvidence: [],
    });
  });
});

// -------------------------------------------------------------- contradictions

describe('contradiction events', () => {
  const external = (id: string, authority: string) => ({ kind: 'EXTERNAL', id, claim: id, authority });

  /** A decided contradiction's record, for hand-editing. */
  const recorded = (authorities: [string, string]): Record<string, JsonValue> => {
    const events = decided(
      {
        kind: 'RECORD_CONTRADICTION',
        contradictionKind: 'REQUIREMENT_TEST',
        sides: [external('a', authorities[0]), external('b', authorities[1])],
      },
      SYSTEM,
    );
    const input = events.find((e) => e.type === 'CONTRADICTION_RECORDED');
    if (input === undefined) throw new Error('no contradiction');
    return payloadOf(input)['contradiction'] as Record<string, JsonValue>;
  };

  it('refuses one recorded twice', () => {
    mind.run(SYSTEM, {
      kind: 'RECORD_CONTRADICTION',
      contradictionKind: 'REQUIREMENT_TEST',
      sides: [external('a', 'HUMAN_DECISION'), external('b', 'EVIDENCE')],
    });
    const existing = mind.state.contradictions[mind.lastId('contradiction')] as unknown as JsonValue;
    expectAnomaly('STATE_MISMATCH', 'CONTRADICTION_RECORDED', { contradiction: existing });
  });

  it('refuses a side naming a belief that does not exist', () => {
    const c = recorded(['HUMAN_DECISION', 'EVIDENCE']);
    const sides = c['sides'] as Record<string, JsonValue>[];
    expectAnomaly('UNKNOWN_REFERENCE', 'CONTRADICTION_RECORDED', {
      contradiction: { ...c, sides: [{ ...sides[0], ref: { kind: 'BELIEF', id: 'bel-404' } }, sides[1] ?? null] },
    });
  });

  it('refuses a record whose determination, status and uncertainty disagree', () => {
    const decidedOne = recorded(['HUMAN_DECISION', 'EVIDENCE']);
    expectAnomaly('STATE_MISMATCH', 'CONTRADICTION_RECORDED', { contradiction: { ...decidedOne, status: 'ESCALATED' } });
    expectAnomaly('STATE_MISMATCH', 'CONTRADICTION_RECORDED', { contradiction: { ...decidedOne, uncertaintyId: 'unc-1' } });
    expectAnomaly('STATE_MISMATCH', 'CONTRADICTION_RECORDED', {
      contradiction: { ...decidedOne, resolution: { by: 'x', at: 't', reason: 'r' } },
    });

    const escalated = recorded(['EVIDENCE', 'EVIDENCE']);
    expectAnomaly('STATE_MISMATCH', 'CONTRADICTION_RECORDED', { contradiction: { ...escalated, determination: 'AUTHORITY' } });
    expectAnomaly('STATE_MISMATCH', 'CONTRADICTION_RECORDED', { contradiction: { ...escalated, uncertaintyId: null } });
    expectAnomaly('STATE_MISMATCH', 'CONTRADICTION_RECORDED', { contradiction: { ...escalated, status: 'RESOLVED_BY_AUTHORITY' } });
  });

  it('refuses an escalated record whose uncertainty was never recorded', () => {
    // The decider emits the uncertainty first; folding only the contradiction
    // is what a dropped event looks like.
    const escalated = recorded(['EVIDENCE', 'EVIDENCE']);
    expectAnomaly('UNKNOWN_REFERENCE', 'CONTRADICTION_RECORDED', { contradiction: escalated });
  });

  it('refuses resolving one that is missing or not escalated', () => {
    expectAnomaly('UNKNOWN_REFERENCE', 'CONTRADICTION_RESOLVED', { contradictionId: 'ctr-404', governingSide: 0, reason: 'r' });
    mind.run(SYSTEM, {
      kind: 'RECORD_CONTRADICTION',
      contradictionKind: 'REQUIREMENT_TEST',
      sides: [external('a', 'HUMAN_DECISION'), external('b', 'EVIDENCE')],
    });
    const id = mind.lastId('contradiction');
    expectAnomaly('STATE_MISMATCH', 'CONTRADICTION_RESOLVED', { contradictionId: id, governingSide: 1, reason: 'r' });
  });
});

describe('everything else', () => {
  it('counts an event type it does not interpret, and changes nothing else', () => {
    const before = withoutLog(mind.state);
    mind.fold({ type: 'WORLD_FACT_OBSERVED', actor: SYSTEM, authority: 'EVIDENCE', subject: null, payload: null, timestamp: 't' });
    expect(withoutLog(mind.state)).toEqual(before);
    expect(mind.state.observations.unhandled).toEqual({ WORLD_FACT_OBSERVED: 1 });
  });

  it('produced no anomalies from any legitimate decision above', () => {
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'g', priority: 5 });
    expect(mind.anomalies()).toEqual([]);
  });
});
