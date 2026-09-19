/**
 * The agent task projection: what each task did, rebuilt from the ledger
 * (ADR-0020 §5, ADR-0013).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is how a failed, abandoned or
 * interrupted agent task is seen after the fact. It folds the runtime's events
 * by `taskId` into one record per task, and records as an anomaly anything no
 * runtime could have written, like every other fold (ADR-0014 rule 3).
 *
 * A task with no `AGENT_TASK_FINISHED` is INTERRUPTED from the ledger's point
 * of view: the process stopped mid-task. That is visible here rather than lost,
 * which matters more for agents than for anything else — an agent task that
 * vanished is work the system may believe it did.
 *
 * The fold re-checks the state machine. A recorded transition the machine does
 * not permit is an anomaly, not a state: if the runtime and this projection
 * ever disagree about what is legal, the ledger says so instead of quietly
 * taking the runtime's word.
 */

import { AGENT_ROLES, AGENT_TASK_STATES, type GenesisEvent, MESSAGE_KINDS } from '@genesis/core-types';
import {
  emptyObservations,
  noteAnomaly,
  noteUnhandled,
  ObservationLog,
  parseProjectionState,
  type Projector,
} from '@genesis/projections';
import { canTransition, INITIAL_AGENT_TASK_STATE, refusalReason } from '@genesis/protocol';
import { z } from 'zod';
import {
  AGENT_EVENTS,
  AgentMessageReceivedPayload,
  AgentMessageRejectedPayload,
  AgentTaskAssignedPayload,
  AgentTaskFailedPayload,
  AgentTaskFinishedPayload,
  AgentTaskStateChangedPayload,
} from './agent-events.js';

export const AgentTask = z
  .object({
    taskId: z.string().min(1),
    agentId: z.string().min(1),
    role: z.enum(AGENT_ROLES),
    kind: z.string().min(1),
    state: z.enum(AGENT_TASK_STATES),
    attempts: z.number().int().positive(),
    startedSeq: z.number().int().positive(),
    finishedSeq: z.number().int().positive().nullable(),
    /** Accepted messages, by kind, so a task's traffic is countable. */
    messages: z.record(z.number().int().nonnegative()),
    rejectedMessages: z.number().int().nonnegative(),
    /** The last failure, and how many there were. Both matter for the self model. */
    failure: z.object({ kind: z.string(), signature: z.string() }).strict().nullable(),
    failures: z.number().int().nonnegative(),
  })
  .strict();
export type AgentTask = z.infer<typeof AgentTask>;

export const AgentTasksState = z.object({ tasks: z.record(AgentTask), observations: ObservationLog }).strict();
export type AgentTasksState = z.infer<typeof AgentTasksState>;

export const AGENT_TASKS_PROJECTION = 'agent-tasks';
export const AGENT_TASKS_VERSION = 1;

const put = (state: AgentTasksState, task: AgentTask): AgentTasksState => ({
  ...state,
  tasks: { ...state.tasks, [task.taskId]: task },
});

const anomaly = (
  state: AgentTasksState,
  event: GenesisEvent,
  kind: 'MALFORMED_PAYLOAD' | 'STATE_MISMATCH' | 'UNKNOWN_REFERENCE',
  detail: string,
): AgentTasksState => ({ ...state, observations: noteAnomaly(state.observations, event, kind, detail) });

/** The task id an event concerns, when its payload names one. */
const taskIdOf = (event: GenesisEvent): string | null => {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const id = (payload as { taskId?: unknown }).taskId;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

type Handler = (state: AgentTasksState, event: GenesisEvent, task: AgentTask) => AgentTasksState;

/** A handler whose payload is checked, and whose task has not finished. */
function during<T>(schema: z.ZodType<T>, apply: (task: AgentTask, payload: T, event: GenesisEvent) => AgentTask): Handler {
  return (state, event, task) => {
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success) return anomaly(state, event, 'MALFORMED_PAYLOAD', `${event.type} payload does not match`);
    if (task.finishedSeq !== null) return anomaly(state, event, 'STATE_MISMATCH', `task ${task.taskId} already finished`);
    return put(state, apply(task, parsed.data, event));
  };
}

// `AGENT_TASK_ASSIGNED` is absent: `apply` routes it to `assigned`, which has
// to handle both the first assignment and a retry of a live task. An entry here
// would be unreachable, and unreachable code in a fold is a case nobody tests.
const HANDLERS: Record<string, Handler> = {
  [AGENT_EVENTS.AGENT_TASK_STATE_CHANGED]: (state, event, task) => {
    const parsed = AgentTaskStateChangedPayload.safeParse(event.payload);
    if (!parsed.success) return anomaly(state, event, 'MALFORMED_PAYLOAD', 'AGENT_TASK_STATE_CHANGED payload does not match');
    if (task.finishedSeq !== null) return anomaly(state, event, 'STATE_MISMATCH', `task ${task.taskId} already finished`);
    const { from, to } = parsed.data;
    // The recorded `from` must be where the fold thinks the task is, and the
    // move must be one the machine permits. Either disagreement is recorded
    // rather than resolved in the runtime's favour.
    if (from !== task.state) {
      return anomaly(state, event, 'STATE_MISMATCH', `task ${task.taskId} is ${task.state}, not ${from}`);
    }
    if (!canTransition(from, to)) {
      return anomaly(state, event, 'STATE_MISMATCH', refusalReason(from, to));
    }
    return put(state, { ...task, state: to });
  },

  [AGENT_EVENTS.AGENT_MESSAGE_RECEIVED]: during(AgentMessageReceivedPayload, (task, p) => ({
    ...task,
    messages: { ...task.messages, [p.messageKind]: (task.messages[p.messageKind] ?? 0) + 1 },
  })),

  [AGENT_EVENTS.AGENT_MESSAGE_REJECTED]: during(AgentMessageRejectedPayload, (task) => ({
    ...task,
    rejectedMessages: task.rejectedMessages + 1,
  })),

  [AGENT_EVENTS.AGENT_TASK_FAILED]: during(AgentTaskFailedPayload, (task, p) => ({
    ...task,
    failure: { kind: p.kind, signature: p.signature },
    failures: task.failures + 1,
  })),
};

function assigned(state: AgentTasksState, event: GenesisEvent, taskId: string): AgentTasksState {
  const parsed = AgentTaskAssignedPayload.safeParse(event.payload);
  if (!parsed.success) return anomaly(state, event, 'MALFORMED_PAYLOAD', 'AGENT_TASK_ASSIGNED payload does not match');
  const existing = state.tasks[taskId];
  // A second assignment for a live task is a retry, which is legal and folds
  // into the same record. A second assignment for a finished one is not.
  if (existing !== undefined) {
    return existing.finishedSeq === null
      ? put(state, { ...existing, attempts: Math.max(existing.attempts, parsed.data.attempt) })
      : anomaly(state, event, 'STATE_MISMATCH', `task ${taskId} was reassigned after finishing`);
  }
  return put(state, {
    taskId,
    agentId: parsed.data.agentId,
    role: parsed.data.role,
    kind: parsed.data.kind,
    state: INITIAL_AGENT_TASK_STATE,
    attempts: parsed.data.attempt,
    startedSeq: event.seq,
    finishedSeq: null,
    messages: {},
    rejectedMessages: 0,
    failure: null,
    failures: 0,
  });
}

function finished(state: AgentTasksState, event: GenesisEvent, task: AgentTask): AgentTasksState {
  const parsed = AgentTaskFinishedPayload.safeParse(event.payload);
  if (!parsed.success) return anomaly(state, event, 'MALFORMED_PAYLOAD', 'AGENT_TASK_FINISHED payload does not match');
  if (task.finishedSeq !== null) return anomaly(state, event, 'STATE_MISMATCH', `task ${task.taskId} already finished`);
  if (parsed.data.finalState !== task.state) {
    return anomaly(
      state,
      event,
      'STATE_MISMATCH',
      `task ${task.taskId} finished as ${parsed.data.finalState}, but the fold has it ${task.state}`,
    );
  }
  return put(state, { ...task, finishedSeq: event.seq });
}

export const emptyAgentTasksState = (): AgentTasksState => ({ tasks: {}, observations: emptyObservations() });

export const agentTasksProjector: Projector<AgentTasksState> = {
  name: AGENT_TASKS_PROJECTION,
  version: AGENT_TASKS_VERSION,
  initial: emptyAgentTasksState,
  apply(state, event) {
    const taskId = taskIdOf(event);
    if (taskId === null) return { ...state, observations: noteUnhandled(state.observations, event) };
    if (event.type === AGENT_EVENTS.AGENT_TASK_ASSIGNED) return assigned(state, event, taskId);
    const handler = event.type === AGENT_EVENTS.AGENT_TASK_FINISHED ? finished : HANDLERS[event.type];
    if (handler === undefined) return { ...state, observations: noteUnhandled(state.observations, event) };
    const task = state.tasks[taskId];
    if (task === undefined) return anomaly(state, event, 'UNKNOWN_REFERENCE', `no task ${taskId}`);
    return handler(state, event, task);
  },
  parse: (value) => parseProjectionState(AgentTasksState, value, AGENT_TASKS_PROJECTION),
  observationsOf: (state) => state.observations,
};

/** A task that started and never finished: the process stopped mid-task. */
export const isInterruptedTask = (task: AgentTask): boolean => task.finishedSeq === null;

/** How many messages of any kind a task had accepted. */
export const messageCount = (task: AgentTask): number =>
  MESSAGE_KINDS.reduce((total, kind) => total + (task.messages[kind] ?? 0), 0);
