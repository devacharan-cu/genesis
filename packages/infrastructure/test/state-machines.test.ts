/**
 * The generated orchestration.
 *
 * SPEC-07 §3.7 requires the machines to mirror the canonical vocabulary
 * exactly. These tests assert that against the enums themselves, so adding a
 * phase or a stage fails here until the deployment follows.
 */

import { COGNITIVE_LOOP_PHASES, FACTORY_STAGES, type FactoryStage } from '@genesis/core-types';
import { describe, expect, it } from 'vitest';
import {
  type AslState,
  CYCLE_TIMEOUT_SECONDS,
  cycleStateMachine,
  danglingTransitions,
  factoryStateMachine,
  gateBefore,
  PHASE_TIMEOUT_SECONDS,
  phaseStateName,
  reachableStates,
  stageStateName,
  successorsOf,
  TRANSIENT_RETRY,
} from '../src/state-machines.js';

const cycle = cycleStateMachine({ phaseHandlerArn: 'arn:phase', approvalHandlerArn: 'arn:approval' });

// The factory's real table (ADR-0023 §2), restated here as the test's premise.
// `@genesis/cloud` asserts that this matches what the factory actually exports.
const ON_SUCCESS: Record<FactoryStage, FactoryStage | null> = {
  PLAN: 'ARCHITECT',
  ARCHITECT: 'BUILD',
  BUILD: 'TEST',
  TEST: 'SECURITY_REVIEW',
  SECURITY_REVIEW: 'VERIFY',
  DIAGNOSE: 'REPAIR',
  REPAIR: 'TEST',
  VERIFY: null,
};
const ON_FAILURE: Record<FactoryStage, FactoryStage | null> = {
  PLAN: null,
  ARCHITECT: null,
  BUILD: 'DIAGNOSE',
  TEST: 'DIAGNOSE',
  SECURITY_REVIEW: 'DIAGNOSE',
  DIAGNOSE: null,
  REPAIR: null,
  VERIFY: 'DIAGNOSE',
};
const factory = factoryStateMachine({ stageHandlerArn: 'arn:stage', onSuccess: ON_SUCCESS, onFailure: ON_FAILURE, firstStage: 'PLAN' });

describe('state naming', () => {
  it('turns a canonical token into a readable state name', () => {
    expect(phaseStateName('UPDATE_WORLD_MODEL')).toBe('PhaseUpdateWorldModel');
    expect(phaseStateName('ACT')).toBe('PhaseAct');
    expect(stageStateName('SECURITY_REVIEW')).toBe('StageSecurityReview');
  });

  it('produces a distinct name for every phase and every stage', () => {
    expect(new Set(COGNITIVE_LOOP_PHASES.map(phaseStateName)).size).toBe(COGNITIVE_LOOP_PHASES.length);
    expect(new Set(FACTORY_STAGES.map(stageStateName)).size).toBe(FACTORY_STAGES.length);
  });
});

describe('the cognitive cycle machine', () => {
  it('has one state per canonical phase, and no phase is missing', () => {
    for (const phase of COGNITIVE_LOOP_PHASES) {
      expect(cycle.States[phaseStateName(phase)], phase).toBeDefined();
    }
  });

  it('starts at the first canonical phase', () => {
    expect(cycle.StartAt).toBe(phaseStateName(COGNITIVE_LOOP_PHASES[0]));
  });

  it('runs the phases in canonical order', () => {
    const order: string[] = [];
    let name: string | undefined = cycle.StartAt;
    const guard = new Set<string>();
    while (name !== undefined && !guard.has(name)) {
      guard.add(name);
      const state: AslState | undefined = cycle.States[name];
      if (state === undefined) break;
      if (name.startsWith('Phase')) order.push(name);
      name = successorsOf(state)[0];
    }
    // The path through the gate visits the gate, not a phase, so the walk
    // above follows the first successor: that is the unauthorized-free path.
    expect(order.slice(0, 10)).toEqual(COGNITIVE_LOOP_PHASES.slice(0, 10).map(phaseStateName));
  });

  it('tells each handler which phase it is running', () => {
    for (const phase of COGNITIVE_LOOP_PHASES) {
      const state = cycle.States[phaseStateName(phase)];
      expect(state?.Type).toBe('Task');
      if (state?.Type !== 'Task') return;
      expect(state.Parameters['Payload']).toMatchObject({ phase });
      expect(state.Parameters['FunctionName']).toBe('arn:phase');
    }
  });

  it('ends after the last phase rather than looping forever', () => {
    const last = cycle.States[phaseStateName(COGNITIVE_LOOP_PHASES[COGNITIVE_LOOP_PHASES.length - 1] as never)];
    expect(last?.Type === 'Task' && last.End).toBe(true);
  });

  it('gates only the phase that changes something outside the system', () => {
    expect(gateBefore('ACT')).toBe('AuthorizationGate');
    for (const phase of COGNITIVE_LOOP_PHASES.filter((p) => p !== 'ACT')) {
      expect(gateBefore(phase), phase).toBeNull();
    }
  });

  it('reaches ACT through the gate, never around it', () => {
    const before = COGNITIVE_LOOP_PHASES[COGNITIVE_LOOP_PHASES.indexOf('ACT') - 1] as never;
    const previous = cycle.States[phaseStateName(before)];
    expect(previous?.Type === 'Task' && previous.Next).toBe('AuthorizationGate');

    const intoAct = Object.entries(cycle.States).filter(([, state]) => successorsOf(state).includes(phaseStateName('ACT')));
    expect(intoAct.map(([id]) => id).sort()).toEqual(['AuthorizationGate', 'AwaitHumanDecision']);
  });

  it('waits for a real human decision rather than polling or assuming', () => {
    const wait = cycle.States['AwaitHumanDecision'];
    expect(wait?.Type).toBe('Task');
    if (wait?.Type !== 'Task') return;
    expect(wait.Resource).toBe('arn:aws:states:::lambda:invoke.waitForTaskToken');
    expect(wait.Parameters['Payload']).toMatchObject({ 'taskToken.$': '$$.Task.Token' });
    // No retry: re-asking a human because a Lambda blipped would mint a second
    // gate for one decision.
    expect(wait.Retry).toBeUndefined();
  });

  it('treats an unanswered gate as withheld, never as approved', () => {
    const wait = cycle.States['AwaitHumanDecision'];
    expect(wait?.Type === 'Task' && wait.Catch?.[0]?.Next).toBe('CycleWithheld');
    expect(cycle.States['CycleWithheld']).toMatchObject({ Type: 'Fail', Error: 'AuthorizationWithheld' });
  });

  it('honours a configured approval deadline', () => {
    const impatient = cycleStateMachine({ phaseHandlerArn: 'a', approvalHandlerArn: 'b', approvalTimeoutSeconds: 60 });
    const wait = impatient.States['AwaitHumanDecision'];
    expect(wait?.Type === 'Task' && wait.TimeoutSeconds).toBe(60);
    const patient = cycle.States['AwaitHumanDecision'];
    expect(patient?.Type === 'Task' && patient.TimeoutSeconds).toBe(86_400);
  });

  it('retries only transient faults, never a handler that rejected its input', () => {
    const state = cycle.States[phaseStateName('OBSERVE')];
    expect(state?.Type === 'Task' && state.Retry).toEqual(TRANSIENT_RETRY);
    for (const retry of TRANSIENT_RETRY) {
      expect(retry.ErrorEquals).not.toContain('States.ALL');
      expect(retry.ErrorEquals.every((e) => e.startsWith('Lambda.'))).toBe(true);
    }
  });

  it('bounds a phase and bounds the cycle', () => {
    const state = cycle.States[phaseStateName('ACT')];
    expect(state?.Type === 'Task' && state.TimeoutSeconds).toBe(PHASE_TIMEOUT_SECONDS);
    expect(cycle.TimeoutSeconds).toBe(CYCLE_TIMEOUT_SECONDS);
  });

  it('sends every phase failure somewhere that records it', () => {
    for (const phase of COGNITIVE_LOOP_PHASES) {
      const state = cycle.States[phaseStateName(phase)];
      expect(state?.Type === 'Task' && state.Catch?.[0]?.Next, phase).toBe('CycleFailed');
    }
  });

  it('has no dangling transition and no orphan state', () => {
    expect(danglingTransitions(cycle)).toEqual([]);
    expect(reachableStates(cycle)).toEqual(Object.keys(cycle.States).sort());
  });
});

describe('the change lifecycle machine', () => {
  it('has one state per canonical stage', () => {
    for (const stage of FACTORY_STAGES) expect(factory.States[stageStateName(stage)], stage).toBeDefined();
  });

  it('starts where the factory says it starts', () => {
    expect(factory.StartAt).toBe(stageStateName('PLAN'));
  });

  it('follows the factory’s own table, not a copy of it', () => {
    for (const stage of FACTORY_STAGES) {
      const choice = factory.States[`${stageStateName(stage)}Outcome`];
      expect(choice?.Type).toBe('Choice');
      if (choice?.Type !== 'Choice') return;
      const success = ON_SUCCESS[stage];
      const failure = ON_FAILURE[stage];
      expect(choice.Choices[0]?.['Next'], `${stage} on success`).toBe(success === null ? 'RunComplete' : stageStateName(success));
      expect(choice.Default, `${stage} on failure`).toBe(failure === null ? 'RunBlocked' : stageStateName(failure));
    }
  });

  it('sends a repair back through the checks, never past them', () => {
    const afterRepair = factory.States['StageRepairOutcome'];
    expect(afterRepair?.Type === 'Choice' && afterRepair.Choices[0]?.['Next']).toBe(stageStateName('TEST'));
    // The property that matters: nothing reaches VERIFY except SECURITY_REVIEW.
    const intoVerify = Object.entries(factory.States)
      .filter(([, state]) => successorsOf(state).includes(stageStateName('VERIFY')))
      .map(([id]) => id);
    expect(intoVerify).toEqual(['StageSecurityReviewOutcome']);
  });

  it('records the branch in the execution rather than inside a handler', () => {
    for (const stage of FACTORY_STAGES) {
      const task = factory.States[stageStateName(stage)];
      expect(task?.Type === 'Task' && task.Next, stage).toBe(`${stageStateName(stage)}Outcome`);
    }
  });

  it('distinguishes a blocked run from a broken factory', () => {
    expect(factory.States['RunBlocked']).toMatchObject({ Type: 'Fail', Error: 'RunBlocked' });
    expect(factory.States['RunFailed']).toMatchObject({ Type: 'Fail', Error: 'StageHandlerFailed' });
    expect(factory.States['RunComplete']).toEqual({ Type: 'Succeed' });
  });

  it('succeeds only where the table has nowhere further to go on success', () => {
    const succeeding = FACTORY_STAGES.filter((stage) => {
      const choice = factory.States[`${stageStateName(stage)}Outcome`];
      return choice?.Type === 'Choice' && choice.Choices[0]?.['Next'] === 'RunComplete';
    });
    expect(succeeding).toEqual(['VERIFY']);
  });

  it('has no dangling transition and no orphan state', () => {
    expect(danglingTransitions(factory)).toEqual([]);
    expect(reachableStates(factory)).toEqual(Object.keys(factory.States).sort());
  });
});

describe('the graph helpers', () => {
  it('reports a Next that points at nothing', () => {
    const broken = { ...factory, States: { ...factory.States, StagePlan: { Type: 'Pass', Next: 'Nowhere' } as never } };
    expect(danglingTransitions(broken)).toEqual(['Nowhere']);
  });

  it('reports a start state that does not exist', () => {
    expect(danglingTransitions({ ...factory, StartAt: 'Absent' })).toEqual(['Absent']);
  });

  it('stops at a state that was never declared', () => {
    const partial = { Comment: 'c', StartAt: 'A', TimeoutSeconds: 1, States: { A: { Type: 'Pass', Next: 'B' } as never } };
    expect(reachableStates(partial)).toEqual(['A', 'B']);
  });

  it('finds no successor for a terminal state', () => {
    expect(successorsOf({ Type: 'Succeed' })).toEqual([]);
    expect(successorsOf({ Type: 'Fail', Error: 'e', Cause: 'c' })).toEqual([]);
    expect(successorsOf({ Type: 'Pass', End: true })).toEqual([]);
  });

  it('follows a Task with no Catch, which has only its Next', () => {
    expect(
      successorsOf({ Type: 'Task', Resource: 'arn:x', Parameters: {}, ResultPath: null, Next: 'Onward' }),
    ).toEqual(['Onward']);
  });

  it('follows a Pass state’s Next', () => {
    expect(successorsOf({ Type: 'Pass', Next: 'Onward' })).toEqual(['Onward']);
  });

  it('ignores a Choice branch with no Next', () => {
    expect(successorsOf({ Type: 'Choice', Choices: [{ Variable: '$.x' }], Default: 'Fallback' })).toEqual(['Fallback']);
  });
});
