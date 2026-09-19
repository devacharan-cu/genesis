/**
 * The agent task fold, driven directly.
 *
 * A projection is only trustworthy if it says so when it does not understand
 * something, so most of this drives events no correct runtime would write: a
 * payload of the wrong shape, a transition from the wrong state, a task
 * finishing twice, a reassignment after the end. Each must become an anomaly
 * rather than a state nobody can account for.
 */

import { AGENT_EVENTS, agentTasksProjector, emptyAgentTasksState, isInterruptedTask, messageCount } from '@genesis/core';
import { type GenesisEvent, type JsonValue } from '@genesis/core-types';
import { describe, expect, it } from 'vitest';

let seq = 0;

const event = (type: string, payload: JsonValue): GenesisEvent =>
  ({
    id: `evt_${'0'.repeat(20)}${String((seq += 1)).padStart(6, '0')}`,
    projectId: 'prj_1',
    seq,
    schemaVersion: 1,
    type,
    actor: { kind: 'SYSTEM', id: 'agent-runtime' },
    subject: null,
    before: null,
    after: null,
    cause: null,
    cycleId: null,
    authority: 'VERIFIED_SYSTEM_STATE',
    payload,
    timestamp: '2026-06-01T00:00:00.000Z',
    payloadHash: 'a'.repeat(64),
    prevHash: null,
  }) as GenesisEvent;

const ASSIGNMENT = {
  taskId: 'task_1',
  attempt: 1,
  agentId: 'agt_1',
  role: 'PLANNER',
  kind: 'PLANNER_TASK',
  contributesTo: ['goal-1'],
  deadline: '2026-06-01T00:05:00.000Z',
  proposalKinds: ['RECORD_BELIEF'],
};

const fold = (events: readonly GenesisEvent[]) => {
  seq = 0;
  return events.reduce((state, e) => agentTasksProjector.apply(state, e), emptyAgentTasksState());
};

const assigned = (over: Record<string, unknown> = {}) => event(AGENT_EVENTS.AGENT_TASK_ASSIGNED, { ...ASSIGNMENT, ...over });
const moved = (from: string, to: string) =>
  event(AGENT_EVENTS.AGENT_TASK_STATE_CHANGED, { taskId: 'task_1', from, to, reason: 'because' });
const finished = (finalState: string) =>
  event(AGENT_EVENTS.AGENT_TASK_FINISHED, { taskId: 'task_1', finalState, attempts: 1, messages: 0, proposalsAccepted: 0 });

describe('the ordinary shape of a task', () => {
  it('folds an assignment into a record in the initial state', () => {
    const state = fold([assigned()]);
    expect(state.tasks['task_1']).toMatchObject({
      agentId: 'agt_1',
      role: 'PLANNER',
      state: 'ASSIGNED',
      attempts: 1,
      failures: 0,
      rejectedMessages: 0,
    });
    expect(state.observations.anomalies).toEqual([]);
  });

  it('counts accepted messages by kind, and refused ones separately', () => {
    const state = fold([
      assigned(),
      moved('ASSIGNED', 'RUNNING'),
      event(AGENT_EVENTS.AGENT_MESSAGE_RECEIVED, {
        taskId: 'task_1',
        messageId: 'msg_1',
        messageKind: 'FINDING',
        envelope: null,
      }),
      event(AGENT_EVENTS.AGENT_MESSAGE_RECEIVED, {
        taskId: 'task_1',
        messageId: 'msg_2',
        messageKind: 'FINDING',
        envelope: null,
      }),
      event(AGENT_EVENTS.AGENT_MESSAGE_RECEIVED, {
        taskId: 'task_1',
        messageId: 'msg_3',
        messageKind: 'RESULT',
        envelope: null,
      }),
      event(AGENT_EVENTS.AGENT_MESSAGE_REJECTED, {
        taskId: 'task_1',
        messageId: null,
        messageKind: 'FINDING',
        issues: ['risk: required'],
      }),
    ]);
    const task = state.tasks['task_1'];
    expect(task?.messages).toEqual({ FINDING: 2, RESULT: 1 });
    expect(task?.rejectedMessages).toBe(1);
    expect(messageCount(task as never)).toBe(3);
    expect(state.observations.anomalies).toEqual([]);
  });

  it('counts every failure, and keeps the last one', () => {
    const state = fold([
      assigned(),
      moved('ASSIGNED', 'RUNNING'),
      event(AGENT_EVENTS.AGENT_TASK_FAILED, {
        taskId: 'task_1',
        attempt: 1,
        kind: 'TIMEOUT',
        message: 'slow',
        signature: 'agent:PLANNER:PLANNER_TASK:TIMEOUT',
        willRetry: true,
      }),
      moved('RUNNING', 'BLOCKED'),
      moved('BLOCKED', 'RUNNING'),
      assigned({ attempt: 2 }),
      event(AGENT_EVENTS.AGENT_TASK_FAILED, {
        taskId: 'task_1',
        attempt: 2,
        kind: 'AGENT_THREW',
        message: 'boom',
        signature: 'agent:PLANNER:PLANNER_TASK:AGENT_THREW',
        willRetry: false,
      }),
      moved('RUNNING', 'FAILED'),
      finished('FAILED'),
    ]);
    const task = state.tasks['task_1'];
    expect(task).toMatchObject({ state: 'FAILED', attempts: 2, failures: 2 });
    expect(task?.failure).toEqual({ kind: 'AGENT_THREW', signature: 'agent:PLANNER:PLANNER_TASK:AGENT_THREW' });
    expect(isInterruptedTask(task as never)).toBe(false);
    expect(state.observations.anomalies).toEqual([]);
  });

  it('a task that started and never finished is interrupted', () => {
    const state = fold([assigned(), moved('ASSIGNED', 'RUNNING')]);
    expect(isInterruptedTask(state.tasks['task_1'] as never)).toBe(true);
    expect(messageCount(state.tasks['task_1'] as never)).toBe(0);
  });
});

describe('what the fold refuses to understand', () => {
  const anomalyOf = (events: readonly GenesisEvent[]) => {
    const state = fold(events);
    expect(state.observations.anomalies).toHaveLength(1);
    return state.observations.anomalies[0];
  };

  it('ignores an event with no task, rather than guessing one', () => {
    const state = fold([event('SOMETHING_ELSE', { note: 'unrelated' })]);
    expect(state.tasks).toEqual({});
    expect(state.observations.anomalies).toEqual([]);
    expect(state.observations.unhandled).toEqual({ SOMETHING_ELSE: 1 });
  });

  it('ignores an event whose payload is not an object', () => {
    for (const payload of [null, 'text', 7, ['a']] as JsonValue[]) {
      const state = fold([event(AGENT_EVENTS.AGENT_TASK_ASSIGNED, payload)]);
      expect(state.tasks).toEqual({});
      expect(state.observations.unhandled).toEqual({ AGENT_TASK_ASSIGNED: 1 });
    }
  });

  it('ignores an event whose payload names no task id', () => {
    const state = fold([event(AGENT_EVENTS.AGENT_TASK_ASSIGNED, { attempt: 1 })]);
    expect(state.observations.unhandled).toEqual({ AGENT_TASK_ASSIGNED: 1 });
  });

  it('ignores an event whose task id is empty', () => {
    const state = fold([event(AGENT_EVENTS.AGENT_TASK_ASSIGNED, { taskId: '', attempt: 1 })]);
    expect(state.observations.unhandled).toEqual({ AGENT_TASK_ASSIGNED: 1 });
  });

  it('ignores an agent event kind it has no handler for', () => {
    const state = fold([assigned(), event('AGENT_SOMETHING_NEW', { taskId: 'task_1' })]);
    expect(state.observations.unhandled).toEqual({ AGENT_SOMETHING_NEW: 1 });
    expect(state.observations.anomalies).toEqual([]);
  });

  it('records an event about a task that was never assigned', () => {
    expect(anomalyOf([moved('ASSIGNED', 'RUNNING')])?.detail).toContain('no task task_1');
  });

  it('records a malformed assignment', () => {
    expect(anomalyOf([assigned({ role: 'ORACLE' })])?.detail).toContain('AGENT_TASK_ASSIGNED payload');
  });

  it('records a malformed transition', () => {
    expect(
      anomalyOf([assigned(), event(AGENT_EVENTS.AGENT_TASK_STATE_CHANGED, { taskId: 'task_1', from: 'ASSIGNED' })])?.detail,
    ).toContain('AGENT_TASK_STATE_CHANGED payload');
  });

  it('records a transition whose recorded origin is not where the fold is', () => {
    expect(anomalyOf([assigned(), moved('RUNNING', 'COMPLETED')])?.detail).toContain('is ASSIGNED, not RUNNING');
  });

  it('records a transition the machine does not permit', () => {
    expect(anomalyOf([assigned(), moved('ASSIGNED', 'COMPLETED')])?.detail).toContain('cannot become COMPLETED');
  });

  it('records a malformed message, and counts nothing for it', () => {
    const state = fold([assigned(), event(AGENT_EVENTS.AGENT_MESSAGE_RECEIVED, { taskId: 'task_1', messageKind: 'MADE_UP' })]);
    expect(state.tasks['task_1']?.messages).toEqual({});
    expect(state.observations.anomalies).toHaveLength(1);
  });

  it('records a malformed rejection', () => {
    expect(
      anomalyOf([assigned(), event(AGENT_EVENTS.AGENT_MESSAGE_REJECTED, { taskId: 'task_1', issues: 'one' })])?.detail,
    ).toContain('AGENT_MESSAGE_REJECTED payload');
  });

  it('records a malformed failure', () => {
    expect(
      anomalyOf([assigned(), event(AGENT_EVENTS.AGENT_TASK_FAILED, { taskId: 'task_1', kind: 'GAVE_UP' })])?.detail,
    ).toContain('AGENT_TASK_FAILED payload');
  });

  it('records a malformed finish', () => {
    expect(
      anomalyOf([assigned(), event(AGENT_EVENTS.AGENT_TASK_FINISHED, { taskId: 'task_1', finalState: 'DONE' })])?.detail,
    ).toContain('AGENT_TASK_FINISHED payload');
  });

  it('records a finish that disagrees with where the fold has the task', () => {
    expect(anomalyOf([assigned(), finished('COMPLETED')])?.detail).toContain('finished as COMPLETED, but the fold has it ASSIGNED');
  });
});

describe('after a task has finished', () => {
  const done = [assigned(), moved('ASSIGNED', 'RUNNING'), moved('RUNNING', 'COMPLETED'), finished('COMPLETED')];

  it('a second finish is an anomaly, not a second ending', () => {
    const state = fold([...done, finished('COMPLETED')]);
    expect(state.observations.anomalies).toHaveLength(1);
    expect(state.observations.anomalies[0]?.detail).toContain('already finished');
  });

  it('a later transition is an anomaly: terminal is terminal', () => {
    const state = fold([...done, moved('COMPLETED', 'RUNNING')]);
    expect(state.tasks['task_1']?.state).toBe('COMPLETED');
    expect(state.observations.anomalies[0]?.detail).toContain('already finished');
  });

  it('a later message is an anomaly, and is not counted', () => {
    const state = fold([
      ...done,
      event(AGENT_EVENTS.AGENT_MESSAGE_RECEIVED, { taskId: 'task_1', messageId: 'msg_9', messageKind: 'RESULT', envelope: null }),
    ]);
    expect(state.tasks['task_1']?.messages).toEqual({});
    expect(state.observations.anomalies).toHaveLength(1);
  });

  it('a reassignment is an anomaly: a finished task is not picked up again', () => {
    const state = fold([...done, assigned({ attempt: 2 })]);
    expect(state.tasks['task_1']?.attempts).toBe(1);
    expect(state.observations.anomalies[0]?.detail).toContain('reassigned after finishing');
  });
});

describe('the projector contract', () => {
  it('parses a state it wrote, and refuses one it did not', () => {
    const state = fold([assigned()]);
    expect(agentTasksProjector.parse(JSON.parse(JSON.stringify(state)) as unknown)).toEqual(state);
    expect(() => agentTasksProjector.parse({ tasks: { task_1: { role: 'ORACLE' } } })).toThrow();
  });

  it('exposes its observations, and starts with none', () => {
    const empty = emptyAgentTasksState();
    expect(agentTasksProjector.observationsOf(empty)).toEqual(empty.observations);
    expect(empty.tasks).toEqual({});
  });

  it('names and versions itself', () => {
    expect(agentTasksProjector.name).toBe('agent-tasks');
    expect(agentTasksProjector.version).toBe(1);
    expect(agentTasksProjector.initial()).toEqual(emptyAgentTasksState());
  });
});
