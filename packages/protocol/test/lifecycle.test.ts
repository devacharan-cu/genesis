/**
 * The task state machine, checked exhaustively rather than by example.
 *
 * Every ordered pair of states is enumerated, so "terminal is terminal" is a
 * proven property of the table and not a claim about the cases someone thought
 * to write down.
 */

import { AGENT_TASK_STATES, type AgentTaskState, isTerminalAgentTaskState } from '@genesis/core-types';
import { describe, expect, test } from 'vitest';
import {
  AGENT_TASK_TRANSITIONS,
  canTransition,
  INITIAL_AGENT_TASK_STATE,
  reachableAgentTaskStates,
  refusalReason,
} from '../src/lifecycle.js';

describe('the transition table', () => {
  test('covers every state exactly once', () => {
    expect(Object.keys(AGENT_TASK_TRANSITIONS).sort()).toEqual([...AGENT_TASK_STATES].sort());
  });

  test('names only real states as destinations', () => {
    for (const [from, tos] of Object.entries(AGENT_TASK_TRANSITIONS)) {
      for (const to of tos) {
        expect(AGENT_TASK_STATES, `${from} -> ${to}`).toContain(to);
      }
    }
  });

  test('no state transitions to itself: a move has to move', () => {
    for (const state of AGENT_TASK_STATES) {
      expect(AGENT_TASK_TRANSITIONS[state], state).not.toContain(state);
    }
  });

  test('every terminal state is a dead end, and every dead end is terminal', () => {
    for (const state of AGENT_TASK_STATES) {
      expect(AGENT_TASK_TRANSITIONS[state].length === 0, state).toBe(isTerminalAgentTaskState(state));
    }
  });

  test('every state is reachable from ASSIGNED, so none is decoration', () => {
    expect(reachableAgentTaskStates()).toEqual([...AGENT_TASK_STATES]);
  });

  test('every non-terminal state can still fail and can still be cancelled', () => {
    for (const state of AGENT_TASK_STATES) {
      if (isTerminalAgentTaskState(state)) continue;
      expect(canTransition(state, 'FAILED'), `${state} -> FAILED`).toBe(true);
      expect(canTransition(state, 'CANCELLED'), `${state} -> CANCELLED`).toBe(true);
    }
  });

  test('only RUNNING and AWAITING_VERIFICATION can complete', () => {
    const completing = AGENT_TASK_STATES.filter((state) => canTransition(state, 'COMPLETED'));
    expect([...completing]).toEqual(['RUNNING', 'AWAITING_VERIFICATION']);
  });

  test('a blocked task can resume, because what blocks it can be resolved', () => {
    expect(canTransition('BLOCKED', 'RUNNING')).toBe(true);
  });

  test('evidence must be submitted from RUNNING, not conjured from ASSIGNED', () => {
    expect(canTransition('RUNNING', 'AWAITING_VERIFICATION')).toBe(true);
    expect(canTransition('ASSIGNED', 'AWAITING_VERIFICATION')).toBe(false);
  });

  test('a task cannot go back to being assigned', () => {
    for (const state of AGENT_TASK_STATES) {
      expect(canTransition(state, 'ASSIGNED'), state).toBe(false);
    }
  });
});

describe('every ordered pair', () => {
  const pairs: [AgentTaskState, AgentTaskState][] = [];
  for (const from of AGENT_TASK_STATES) for (const to of AGENT_TASK_STATES) pairs.push([from, to]);

  test('is either permitted by the table or refused by canTransition', () => {
    for (const [from, to] of pairs) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(AGENT_TASK_TRANSITIONS[from].includes(to));
    }
  });

  test('leaving a terminal state is refused in all cases', () => {
    for (const [from, to] of pairs) {
      if (!isTerminalAgentTaskState(from)) continue;
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
    }
  });
});

describe('the starting state', () => {
  test('is ASSIGNED, and is not terminal', () => {
    expect(INITIAL_AGENT_TASK_STATE).toBe('ASSIGNED');
    expect(isTerminalAgentTaskState(INITIAL_AGENT_TASK_STATE)).toBe(false);
  });
});

describe('refusalReason', () => {
  test('says so when the task already finished', () => {
    expect(refusalReason('COMPLETED', 'RUNNING')).toBe(
      'task is already COMPLETED, which is terminal; it cannot become RUNNING',
    );
  });

  test('lists what was permitted instead', () => {
    const reason = refusalReason('ASSIGNED', 'COMPLETED');
    expect(reason).toContain('ASSIGNED cannot become COMPLETED');
    expect(reason).toContain('RUNNING');
  });

  test('reads correctly for a state with no permitted moves left', () => {
    // Reachable only if the table is edited; the wording must still be a
    // sentence rather than a trailing empty list.
    expect(refusalReason('CANCELLED', 'FAILED')).toContain('terminal');
  });
});
