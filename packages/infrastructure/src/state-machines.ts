/**
 * Step Functions definitions generated from the canonical vocabulary
 * (SPEC-07 §3.7, ADR-0026 §2).
 *
 * SPEC-07 §3.7 requires the state machine to mirror `CognitiveLoopPhase` and
 * `ChangeLifecycle` *exactly*. The only way to keep that true is to generate it
 * from those constants, so adding a phase to the enum adds a state to the
 * deployed machine and cannot be forgotten.
 *
 * The transition tables are **parameters**, not imports. The factory owns its
 * own pipeline table (ADR-0023 §2) and this package may not depend on the
 * factory, so the composition root passes the real table in and asserts that
 * what was generated matches it. That keeps one table authoritative instead of
 * producing a second one here that would drift.
 *
 * What the machine does NOT decide: whether anything is verified. Every state
 * is a call into a handler that goes through the core. Step Functions sequences
 * the work; it has no opinion about truth (ADR-0023 §4).
 */

import { COGNITIVE_LOOP_PHASES, type CognitiveLoopPhase, FACTORY_STAGES, type FactoryStage } from '@genesis/core-types';

export interface AslRetry {
  readonly ErrorEquals: readonly string[];
  readonly IntervalSeconds: number;
  readonly MaxAttempts: number;
  readonly BackoffRate: number;
}

export interface AslCatch {
  readonly ErrorEquals: readonly string[];
  readonly Next: string;
  readonly ResultPath: string | null;
}

export type AslState =
  | {
      readonly Type: 'Task';
      readonly Resource: string;
      readonly Parameters: Readonly<Record<string, unknown>>;
      readonly ResultPath: string | null;
      readonly TimeoutSeconds?: number;
      readonly Retry?: readonly AslRetry[];
      readonly Catch?: readonly AslCatch[];
      readonly Next?: string;
      readonly End?: true;
    }
  | {
      readonly Type: 'Choice';
      readonly Choices: readonly Readonly<Record<string, unknown>>[];
      readonly Default: string;
    }
  | { readonly Type: 'Pass'; readonly Result?: unknown; readonly ResultPath?: string | null; readonly Next?: string; readonly End?: true }
  | { readonly Type: 'Succeed' }
  | { readonly Type: 'Fail'; readonly Error: string; readonly Cause: string };

export interface StateMachineDefinition {
  readonly Comment: string;
  readonly StartAt: string;
  readonly TimeoutSeconds: number;
  readonly States: Readonly<Record<string, AslState>>;
}

/**
 * Transient faults only.
 *
 * A retry on `States.ALL` would re-run a handler that failed because its input
 * was wrong, and a cognitive phase that appends to the ledger is not free of
 * side effects. The core's own conditional append (ADR-0014 rule 4) is what
 * makes a retried append safe; this list is what makes a retry rare.
 */
export const TRANSIENT_RETRY: readonly AslRetry[] = [
  {
    ErrorEquals: ['Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException'],
    IntervalSeconds: 2,
    MaxAttempts: 4,
    BackoffRate: 2,
  },
];

/** A phase or stage that runs longer than this has hung, and hanging is a failure. */
export const PHASE_TIMEOUT_SECONDS = 900;
/** A cycle that has not finished in an hour needs a person, not more patience. */
export const CYCLE_TIMEOUT_SECONDS = 3_600;
/** A factory run may legitimately take much longer: builds and suites are slow. */
export const RUN_TIMEOUT_SECONDS = 21_600;

const stateName = (prefix: string, token: string): string =>
  `${prefix}${token
    .split('_')
    .map((part) => `${part[0]}${part.slice(1).toLowerCase()}`)
    .join('')}`;

export const phaseStateName = (phase: CognitiveLoopPhase): string => stateName('Phase', phase);
export const stageStateName = (stage: FactoryStage): string => stateName('Stage', stage);

const handlerTask = (
  functionArn: string,
  payload: Readonly<Record<string, unknown>>,
  next: { readonly Next: string } | { readonly End: true },
  onFailure: string,
): AslState => ({
  Type: 'Task',
  Resource: 'arn:aws:states:::lambda:invoke',
  Parameters: { FunctionName: functionArn, Payload: payload },
  ResultPath: '$.result',
  TimeoutSeconds: PHASE_TIMEOUT_SECONDS,
  Retry: TRANSIENT_RETRY,
  Catch: [{ ErrorEquals: ['States.ALL'], Next: onFailure, ResultPath: '$.error' }],
  ...next,
});

export interface CycleMachineOptions {
  /** The handler that runs one phase. One function, dispatched by phase name. */
  readonly phaseHandlerArn: string;
  /**
   * The handler that records a human's answer to an authorization gate.
   *
   * Invoked with a task token: the machine genuinely waits, rather than polling
   * or assuming. SPEC-06 §7 gates are a pause, and a gate that timed out into
   * "proceed" would be a gate that does nothing.
   */
  readonly approvalHandlerArn: string;
  /** How long a human has to answer before the cycle is abandoned, not approved. */
  readonly approvalTimeoutSeconds?: number;
}

/**
 * The cognitive cycle, one state per canonical phase, in canonical order.
 *
 * `ACT` is preceded by an authorization gate, because `ACT` is where the system
 * changes something outside itself. Every other phase reads, reasons or
 * records, and a gate in front of each would train whoever answers them to
 * approve without reading.
 */
export function cycleStateMachine(options: CycleMachineOptions): StateMachineDefinition {
  const states: Record<string, AslState> = {};
  const failed = 'CycleFailed';

  COGNITIVE_LOOP_PHASES.forEach((phase, index) => {
    const nextPhase = COGNITIVE_LOOP_PHASES[index + 1];
    const after = nextPhase === undefined ? { End: true as const } : { Next: gateBefore(nextPhase) ?? phaseStateName(nextPhase) };
    states[phaseStateName(phase)] = handlerTask(
      options.phaseHandlerArn,
      { 'projectId.$': '$.projectId', 'cycleId.$': '$.cycleId', phase, 'input.$': '$.result' },
      after,
      failed,
    );
  });

  states['AuthorizationGate'] = {
    Type: 'Choice',
    Choices: [
      { Variable: '$.result.requiresAuthorization', BooleanEquals: true, Next: 'AwaitHumanDecision' },
    ],
    Default: phaseStateName('ACT'),
  };

  states['AwaitHumanDecision'] = {
    Type: 'Task',
    Resource: 'arn:aws:states:::lambda:invoke.waitForTaskToken',
    Parameters: {
      FunctionName: options.approvalHandlerArn,
      Payload: { 'projectId.$': '$.projectId', 'cycleId.$': '$.cycleId', 'gate.$': '$.result', 'taskToken.$': '$$.Task.Token' },
    },
    ResultPath: '$.approval',
    TimeoutSeconds: options.approvalTimeoutSeconds ?? 86_400,
    // No Retry: re-asking a human because a Lambda blipped would mint a second
    // gate for the same decision.
    Catch: [{ ErrorEquals: ['States.ALL'], Next: 'CycleWithheld', ResultPath: '$.error' }],
    Next: phaseStateName('ACT'),
  };

  states['CycleWithheld'] = {
    Type: 'Fail',
    Error: 'AuthorizationWithheld',
    Cause: 'the cycle stopped at an authorization gate that was refused or unanswered',
  };
  states[failed] = { Type: 'Fail', Error: 'CyclePhaseFailed', Cause: 'a phase handler failed; the ledger holds what was recorded before it' };

  return {
    Comment: 'The cognitive cycle (SPEC-01), one state per canonical phase.',
    StartAt: phaseStateName(COGNITIVE_LOOP_PHASES[0]),
    TimeoutSeconds: CYCLE_TIMEOUT_SECONDS,
    States: states,
  };
}

/** The one phase that is gated, and what gates it. Kept as a function so it is testable. */
export const gateBefore = (phase: CognitiveLoopPhase): string | null => (phase === 'ACT' ? 'AuthorizationGate' : null);

export interface FactoryMachineOptions {
  /** The handler that runs one stage. One function, dispatched by stage name. */
  readonly stageHandlerArn: string;
  /** The factory's own table (ADR-0023 §2), passed in so it stays authoritative. */
  readonly onSuccess: Readonly<Record<FactoryStage, FactoryStage | null>>;
  readonly onFailure: Readonly<Record<FactoryStage, FactoryStage | null>>;
  readonly firstStage: FactoryStage;
}

/**
 * The change lifecycle, generated from the factory's transition table.
 *
 * Each stage is a Task followed by a Choice on its outcome, so the branch a run
 * takes is recorded in the execution history rather than being decided inside a
 * handler. An auditor reading the execution sees which stages ran, in what
 * order, and why it moved where it did — which is the auditable repair loop
 * ADR-0023 §3 requires, at the infrastructure layer.
 */
export function factoryStateMachine(options: FactoryMachineOptions): StateMachineDefinition {
  const states: Record<string, AslState> = {};
  const outcomeOf = (stage: FactoryStage): string => `${stageStateName(stage)}Outcome`;

  for (const stage of FACTORY_STAGES) {
    states[stageStateName(stage)] = handlerTask(
      options.stageHandlerArn,
      { 'projectId.$': '$.projectId', 'runId.$': '$.runId', stage, 'input.$': '$.result' },
      { Next: outcomeOf(stage) },
      'RunFailed',
    );

    const success = options.onSuccess[stage];
    const failure = options.onFailure[stage];
    states[outcomeOf(stage)] = {
      Type: 'Choice',
      Choices: [
        {
          Variable: '$.result.Payload.ok',
          BooleanEquals: true,
          // A stage with nowhere to go on success is the end of the pipeline,
          // and only VERIFY has that property. The table decides, not this file.
          Next: success === null ? 'RunComplete' : stageStateName(success),
        },
      ],
      // Nothing to repair means blocked, not failed: the work exists and is
      // recorded, and a person can pick it up (ADR-0023 §3).
      Default: failure === null ? 'RunBlocked' : stageStateName(failure),
    };
  }

  states['RunComplete'] = { Type: 'Succeed' };
  states['RunBlocked'] = {
    Type: 'Fail',
    Error: 'RunBlocked',
    Cause: 'a stage failed with no repair path; the run is recorded and awaits a person',
  };
  states['RunFailed'] = {
    Type: 'Fail',
    Error: 'StageHandlerFailed',
    Cause: 'a stage handler could not run; this is the factory failing, not the change',
  };

  return {
    Comment: 'The change lifecycle (SPEC-04 / ADR-0023), generated from the factory pipeline table.',
    StartAt: stageStateName(options.firstStage),
    TimeoutSeconds: RUN_TIMEOUT_SECONDS,
    States: states,
  };
}

/**
 * Every state a definition can reach from its start.
 *
 * Used to prove the generated machine has no orphan and no dangling `Next`,
 * which ASL itself will not tell you until you try to deploy it.
 */
export function reachableStates(definition: StateMachineDefinition): readonly string[] {
  const seen = new Set<string>([definition.StartAt]);
  const queue = [definition.StartAt];
  for (let i = 0; i < queue.length; i += 1) {
    const state = definition.States[queue[i] as string];
    if (state === undefined) continue;
    for (const next of successorsOf(state)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen].sort();
}

export function successorsOf(state: AslState): readonly string[] {
  const next: string[] = [];
  if ('Next' in state && typeof state.Next === 'string') next.push(state.Next);
  if (state.Type === 'Choice') {
    next.push(state.Default);
    for (const choice of state.Choices) {
      if (typeof choice['Next'] === 'string') next.push(choice['Next']);
    }
  }
  if (state.Type === 'Task') {
    for (const caught of state.Catch ?? []) next.push(caught.Next);
  }
  return next;
}

/** Names a `Next` points at that no state declares. Empty, or the machine is broken. */
export const danglingTransitions = (definition: StateMachineDefinition): readonly string[] => {
  const declared = new Set(Object.keys(definition.States));
  const missing = new Set<string>();
  if (!declared.has(definition.StartAt)) missing.add(definition.StartAt);
  for (const state of Object.values(definition.States)) {
    for (const next of successorsOf(state)) if (!declared.has(next)) missing.add(next);
  }
  return [...missing].sort();
};
