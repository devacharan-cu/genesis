/**
 * The run projection: what each orchestrated run did, rebuilt from the ledger
 * (ADR-0018 §3, ADR-0013).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is how a failed or interrupted run is
 * seen after the fact. It folds the orchestrator's events by `cycleId` into one
 * record per run — its task, context outcome, reasoning call, proposals and
 * final status — and records as an anomaly anything no orchestrator run could
 * have written, like every other fold (ADR-0014 rule 3).
 *
 * A run with no TASK_FINISHED is INTERRUPTED from the ledger's point of view:
 * the process stopped mid-run. That is visible here rather than lost.
 */

import type { GenesisEvent } from '@genesis/core-types';
import {
  emptyObservations,
  noteAnomaly,
  noteUnhandled,
  ObservationLog,
  parseProjectionState,
  type Projector,
} from '@genesis/projections';
import { z } from 'zod';
import {
  ContextAssembledView,
  ORCHESTRATION_EVENTS,
  ProposalEvaluatedPayload,
  ReasoningFailedPayload,
  ReasoningOutputRejectedPayload,
  ReasoningRequestedPayload,
  ReasoningRespondedPayload,
  TaskPayload,
  TaskSplitRequiredPayload,
} from './events.js';

export const RUN_STATUSES = ['RUNNING', 'SPLIT_REQUIRED', 'FAILED', 'COMPLETED'] as const;

export const Run = z
  .object({
    cycleId: z.string().min(1),
    taskId: z.string().min(1),
    status: z.enum(RUN_STATUSES),
    startedSeq: z.number().int().positive(),
    finishedSeq: z.number().int().positive().nullable(),
    context: z.object({ status: z.enum(['ASSEMBLED', 'SPLIT_REQUIRED']), usedTokens: z.number(), budgetTokens: z.number(), asOfSeq: z.number() }).strict().nullable(),
    callId: z.string().nullable(),
    modelId: z.string().nullable(),
    /** Why the run failed: a provider failure kind, or the output rejection. */
    failure: z.string().nullable(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  })
  .strict();
export type Run = z.infer<typeof Run>;

export const RunsState = z.object({ runs: z.record(Run), observations: ObservationLog }).strict();
export type RunsState = z.infer<typeof RunsState>;

export const RUNS_PROJECTION = 'runs';
export const RUNS_VERSION = 1;

type Handler = (state: RunsState, event: GenesisEvent, run: Run) => RunsState;

const put = (state: RunsState, run: Run): RunsState => ({ ...state, runs: { ...state.runs, [run.cycleId]: run } });
const anomaly = (state: RunsState, event: GenesisEvent, kind: 'MALFORMED_PAYLOAD' | 'STATE_MISMATCH' | 'UNKNOWN_REFERENCE', detail: string): RunsState => ({
  ...state,
  observations: noteAnomaly(state.observations, event, kind, detail),
});

/** A handler for an event within a run that is still RUNNING, with its payload checked. */
function during<T>(schema: z.ZodType<T>, apply: (run: Run, payload: T, event: GenesisEvent) => Run): Handler {
  return (state, event, run) => {
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success) return anomaly(state, event, 'MALFORMED_PAYLOAD', `${event.type} payload does not match`);
    if (run.status !== 'RUNNING') return anomaly(state, event, 'STATE_MISMATCH', `run ${run.cycleId} is ${run.status}`);
    return put(state, apply(run, parsed.data, event));
  };
}

const HANDLERS: Record<string, Handler> = {
  [ORCHESTRATION_EVENTS.CONTEXT_ASSEMBLED]: during(ContextAssembledView, (run, p) => ({
    ...run,
    context: {
      status: p.manifest.status,
      usedTokens: p.manifest.usedTokens,
      budgetTokens: p.manifest.budgetTokens,
      asOfSeq: p.asOfSeq,
    },
  })),
  [ORCHESTRATION_EVENTS.TASK_SPLIT_REQUIRED]: during(TaskSplitRequiredPayload, (run) => ({ ...run, status: 'SPLIT_REQUIRED' })),
  [ORCHESTRATION_EVENTS.REASONING_REQUESTED]: during(ReasoningRequestedPayload, (run, p) => ({ ...run, callId: p.callId })),
  [ORCHESTRATION_EVENTS.REASONING_FAILED]: during(ReasoningFailedPayload, (run, p) => ({
    ...run,
    status: 'FAILED',
    failure: p.kind,
  })),
  [ORCHESTRATION_EVENTS.REASONING_RESPONDED]: during(ReasoningRespondedPayload, (run, p) => ({ ...run, modelId: p.modelId })),
  [ORCHESTRATION_EVENTS.REASONING_OUTPUT_REJECTED]: during(ReasoningOutputRejectedPayload, (run, p) => ({
    ...run,
    status: 'FAILED',
    failure: `OUTPUT_${p.reason}`,
  })),
  [ORCHESTRATION_EVENTS.PROPOSAL_EVALUATED]: during(ProposalEvaluatedPayload, (run, p) =>
    p.outcome === 'ACCEPTED' ? { ...run, accepted: run.accepted + 1 } : { ...run, rejected: run.rejected + 1 },
  ),
  [ORCHESTRATION_EVENTS.EXECUTION_FAILED]: (state) => state,
};

function started(state: RunsState, event: GenesisEvent, cycleId: string): RunsState {
  const parsed = TaskPayload.safeParse(event.payload);
  if (!parsed.success) return anomaly(state, event, 'MALFORMED_PAYLOAD', 'TASK_STARTED payload does not match');
  if (state.runs[cycleId] !== undefined) return anomaly(state, event, 'STATE_MISMATCH', `run ${cycleId} already started`);
  return put(state, {
    cycleId,
    taskId: parsed.data.taskId,
    status: 'RUNNING',
    startedSeq: event.seq,
    finishedSeq: null,
    context: null,
    callId: null,
    modelId: null,
    failure: null,
    accepted: 0,
    rejected: 0,
  });
}

function finished(state: RunsState, event: GenesisEvent, run: Run): RunsState {
  if (run.finishedSeq !== null) return anomaly(state, event, 'STATE_MISMATCH', `run ${run.cycleId} already finished`);
  return put(state, {
    ...run,
    status: run.status === 'RUNNING' ? 'COMPLETED' : run.status,
    finishedSeq: event.seq,
  });
}

export const emptyRunsState = (): RunsState => ({ runs: {}, observations: emptyObservations() });

export const runsProjector: Projector<RunsState> = {
  name: RUNS_PROJECTION,
  version: RUNS_VERSION,
  initial: emptyRunsState,
  apply(state, event) {
    // Only events that belong to a run are a run's. The same types without a
    // cycle — a task started by something else — are not this projection's.
    const cycleId = event.cycleId;
    if (cycleId === null) return { ...state, observations: noteUnhandled(state.observations, event) };
    if (event.type === ORCHESTRATION_EVENTS.TASK_STARTED) return started(state, event, cycleId);
    const handler = event.type === ORCHESTRATION_EVENTS.TASK_FINISHED ? finished : HANDLERS[event.type];
    if (handler === undefined) return { ...state, observations: noteUnhandled(state.observations, event) };
    const run = state.runs[cycleId];
    if (run === undefined) return anomaly(state, event, 'UNKNOWN_REFERENCE', `no run ${cycleId}`);
    return handler(state, event, run);
  },
  parse: (value) => parseProjectionState(RunsState, value, RUNS_PROJECTION),
  observationsOf: (state) => state.observations,
};

/** A run that started and never finished: the process stopped mid-run. */
export const isInterrupted = (run: Run): boolean => run.finishedSeq === null;
