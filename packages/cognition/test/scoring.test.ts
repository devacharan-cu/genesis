/**
 * Question scoring (SPEC-01 §9.2, ADR-0017). The default scorer is pinned to
 * exact values: it is a heuristic, but a deterministic one, and a change to it
 * must show up as a failing test and a version bump — never silently.
 */

import {
  CognitiveEngine,
  cognitionProjector,
  decide,
  defaultQuestionScorer,
  type QuestionScorer,
  scoreQuestion,
  type Uncertainty,
} from '@genesis/cognition';
import { newProjectId, projectScope } from '@genesis/core-types';
import { InMemoryEventLedger } from '@genesis/ledger';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, countingIds, expectRefused, HUMAN, Mind, SYSTEM, testCriterion, tickingClock } from './support.js';

let mind: Mind;
beforeEach(() => {
  mind = new Mind();
});

const goal = (activate: boolean): string => {
  mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'g', priority: 1, successCriteria: [testCriterion()] });
  const id = mind.lastId('goal');
  if (activate) mind.run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: id });
  return id;
};

const uncertainty = (over: Record<string, unknown> = {}): Uncertainty => {
  mind.run(SYSTEM, {
    kind: 'RECORD_UNCERTAINTY',
    statement: 's',
    whatBreaksIfWrong: 'w',
    risk: 'MEDIUM',
    resolution: 'ASK_HUMAN',
    ...over,
  });
  return mind.state.uncertainties[mind.lastId('uncertainty')] as Uncertainty;
};

const factors = (u: Uncertainty) => defaultQuestionScorer.score(mind.state, u);

describe('the default scorer', () => {
  it('normalises risk: LOW .25, MEDIUM .5, HIGH .75, CRITICAL 1', () => {
    expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((risk) => factors(uncertainty({ risk })).riskReduction)).toEqual([
      0.25, 0.5, 0.75, 1,
    ]);
  });

  it('measures information gain by how many named beliefs an answer could still move', () => {
    expect(factors(uncertainty()).informationGain).toBe(1);
    mind.run(AGENT, { kind: 'RECORD_BELIEF', statement: 'movable', state: 'ASSUMED', rationale: 'r' });
    const movable = mind.lastId('belief');
    mind.run(SYSTEM, { kind: 'RECORD_BELIEF', statement: 'settled' });
    const settled = mind.lastId('belief');
    mind.run(SYSTEM, { kind: 'TRANSITION_BELIEF', beliefId: settled, to: 'ASSUMED', reason: 'r' });
    mind.run(SYSTEM, {
      kind: 'ADD_BELIEF_EVIDENCE',
      beliefId: settled,
      polarity: 'SUPPORTING',
      evidence: { evidenceId: 'e', kind: 'DOCUMENT', producedBy: 'p', environment: 'NONE', couldFalsify: false },
    });
    mind.run(SYSTEM, { kind: 'TRANSITION_BELIEF', beliefId: settled, to: 'SUPPORTED' });
    // (1 + 1 movable) / (1 + 2 named)
    expect(factors(uncertainty({ relatedBeliefs: [movable, settled] })).informationGain).toBeCloseTo(2 / 3, 12);
  });

  it('weighs decision impact by what the answer can change', () => {
    const active = goal(true);
    const proposed = goal(false);
    const abandoned = goal(false);
    const blockingAbandoned = uncertainty({ blocksGoalIds: [abandoned] });
    mind.run(HUMAN, { kind: 'ABANDON_GOAL', goalId: abandoned, reason: 'descoped' });

    expect(factors(uncertainty({ blocksGoalIds: [active, proposed] })).decisionImpact).toBe(1);
    expect(factors(uncertainty({ blocksGoalIds: [proposed] })).decisionImpact).toBe(0.6);
    expect(factors(uncertainty({ affectedRefs: [{ nodeType: 'COMPONENT', nodeId: 'n' }] })).decisionImpact).toBe(0.4);
    expect(factors(uncertainty()).decisionImpact).toBe(0.2);
    // A closed goal is not a decision any more.
    expect(factors(mind.state.uncertainties[blockingAbandoned.id] as Uncertainty).decisionImpact).toBe(0.2);
  });

  it('measures dependency coverage as this uncertainty’s share of the best goal’s blockers', () => {
    const shared = goal(true);
    const solo = goal(true);
    const first = uncertainty({ blocksGoalIds: [shared] });
    expect(factors(first).dependencyCoverage).toBe(1);
    const both = uncertainty({ blocksGoalIds: [shared, solo] });
    // Half of `shared`'s blockers, all of `solo`'s: the best goal counts.
    expect(factors(both).dependencyCoverage).toBe(1);
    expect(factors(mind.state.uncertainties[first.id] as Uncertainty).dependencyCoverage).toBe(0.5);
    expect(factors(uncertainty()).dependencyCoverage).toBe(0);
  });
});

describe('scoreQuestion', () => {
  it('records the product of the factors and the scorer that made them', () => {
    const active = goal(true);
    const score = scoreQuestion(mind.state, uncertainty({ blocksGoalIds: [active], risk: 'HIGH' }));
    expect(score).toEqual({
      informationGain: 1,
      decisionImpact: 1,
      riskReduction: 0.75,
      dependencyCoverage: 1,
      value: 0.75,
      scorer: { name: 'genesis.default-question-scorer', version: 1 },
    });
  });

  it('refuses a scorer that reports factors outside [0, 1] or not numbers at all', () => {
    const u = uncertainty();
    const bad = (informationGain: number): QuestionScorer => ({
      name: 'test.bad',
      version: 1,
      score: () => ({ informationGain, decisionImpact: 1, riskReduction: 1, dependencyCoverage: 1 }),
    });
    for (const value of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => scoreQuestion(mind.state, u, bad(value))).toThrow(/invalid score/);
    }
  });

  it('refuses a draft, writing nothing, when the injected scorer is invalid', () => {
    const u = uncertainty();
    const broken: QuestionScorer = {
      name: 'test.broken',
      version: 1,
      score: () => ({ informationGain: 2, decisionImpact: 1, riskReduction: 1, dependencyCoverage: 1 }),
    };
    expectRefused(mind, 'INVALID_SCORE', () =>
      decideWith(broken, { kind: 'DRAFT_QUESTION', uncertaintyId: u.id, text: 'q?' }),
    );
  });
});

/** Decides with a scorer in the decision context, as the engine does, and folds. */
function decideWith(scorer: QuestionScorer, command: unknown): void {
  for (const input of decide(mind.state, command, { ...mind.ctx(SYSTEM), scorer })) {
    mind.state = cognitionProjector.apply(mind.state, mind.stored(input));
  }
}

describe('the engine uses the scorer it was given', () => {
  it('records the injected scorer on drafted and asked questions', async () => {
    const ledger = new InMemoryEventLedger();
    const scope = projectScope(newProjectId());
    const flat: QuestionScorer = {
      name: 'test.flat',
      version: 7,
      score: () => ({ informationGain: 1, decisionImpact: 1, riskReduction: 1, dependencyCoverage: 0.5 }),
    };
    const engine = new CognitiveEngine(ledger, { ids: countingIds(), now: tickingClock(), scorer: flat });
    await engine.execute(scope, SYSTEM, {
      kind: 'RECORD_UNCERTAINTY',
      statement: 's',
      whatBreaksIfWrong: 'w',
      risk: 'LOW',
      resolution: 'ASK_HUMAN',
    });
    await engine.execute(scope, SYSTEM, { kind: 'DRAFT_QUESTION', uncertaintyId: 'unc-1', text: 'q?' });
    const { projection } = await engine.execute(scope, SYSTEM, { kind: 'ASK_QUESTIONS', questionIds: ['qst-1'] });
    expect(projection.state.questions['qst-1']?.score).toMatchObject({ value: 0.5, scorer: { name: 'test.flat', version: 7 } });

    // Without one, the deterministic default.
    const plain = new CognitiveEngine(ledger, { ids: countingIds(), now: tickingClock() });
    const other = projectScope(newProjectId());
    await plain.execute(other, SYSTEM, {
      kind: 'RECORD_UNCERTAINTY',
      statement: 's',
      whatBreaksIfWrong: 'w',
      risk: 'LOW',
      resolution: 'ASK_HUMAN',
    });
    const drafted = await plain.execute(other, SYSTEM, { kind: 'DRAFT_QUESTION', uncertaintyId: 'unc-1', text: 'q?' });
    expect(drafted.projection.state.questions['qst-1']?.score.scorer.name).toBe('genesis.default-question-scorer');
  });
});
