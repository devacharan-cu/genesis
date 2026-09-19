/**
 * The engine with its production defaults: real branded ids and a real clock.
 * Everything else about the engine runs in the shared conformance suite, on
 * both ledgers.
 */

import { CognitiveEngine, defaultIdSource } from '@genesis/cognition';
import {
  BeliefId,
  ContradictionId,
  CriterionId,
  GoalId,
  newProjectId,
  projectScope,
  QuestionId,
  UncertaintyId,
} from '@genesis/core-types';
import { InMemoryEventLedger } from '@genesis/ledger';
import { describe, expect, it } from 'vitest';
import { HUMAN } from './support.js';

describe('production defaults', () => {
  it('mints branded ids of the right kind', () => {
    expect(GoalId.safeParse(defaultIdSource.goal()).success).toBe(true);
    expect(CriterionId.safeParse(defaultIdSource.criterion()).success).toBe(true);
    expect(BeliefId.safeParse(defaultIdSource.belief()).success).toBe(true);
    expect(UncertaintyId.safeParse(defaultIdSource.uncertainty()).success).toBe(true);
    expect(ContradictionId.safeParse(defaultIdSource.contradiction()).success).toBe(true);
    expect(QuestionId.safeParse(defaultIdSource.question()).success).toBe(true);
  });

  it('runs with no options: branded ids and a real ISO clock', async () => {
    const engine = new CognitiveEngine(new InMemoryEventLedger());
    const scope = projectScope(newProjectId());
    const before = Date.now();
    const { projection } = await engine.execute(scope, HUMAN, {
      kind: 'PROPOSE_GOAL',
      description: 'g',
      priority: 1,
      successCriteria: [{ statement: 's', checkKind: 'HUMAN_CONFIRMATION' }],
    });
    const [goal] = Object.values(projection.state.goals);
    expect(GoalId.safeParse(goal?.id).success).toBe(true);
    expect(CriterionId.safeParse(goal?.successCriteria[0]?.id).success).toBe(true);
    expect(Date.parse(goal?.createdAt ?? '')).toBeGreaterThanOrEqual(before - 1000);
  });
});
