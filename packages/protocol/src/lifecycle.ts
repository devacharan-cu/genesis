/**
 * The agent task state machine (ADR-0020 §6).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). A task that can leave a terminal state is a
 * task whose recorded outcome is not its outcome, and the ledger would then
 * disagree with itself about whether work finished.
 *
 * The transitions are a table rather than a series of checks, because a table
 * can be read, tested exhaustively, and shown to have no way out of a terminal
 * state. A series of `if`s can only be argued about.
 *
 * What a task is *doing* is not modelled here. Context assembly, the reasoning
 * call and each proposal are already the orchestrator's events (ADR-0018 §3),
 * recorded once. Restating them as states would give two answers to "what did
 * this task do".
 */

import { AGENT_TASK_STATES, type AgentTaskState, isTerminalAgentTaskState } from '@genesis/core-types';

/**
 * Where a task may go from where it is.
 *
 *   ASSIGNED               accepted but not started, or withdrawn before it was
 *   RUNNING                the agent has the work
 *   BLOCKED                a dependency or an unanswered question stops it; not terminal
 *   AWAITING_VERIFICATION  evidence submitted, the engine has not ruled yet
 *
 * A retry does not appear as a transition: a new attempt of the same task
 * starts a new assignment, which is why `TaskAssignment` carries an attempt
 * number (ADR-0020 §7).
 */
export const AGENT_TASK_TRANSITIONS: Readonly<Record<AgentTaskState, readonly AgentTaskState[]>> = {
  ASSIGNED: ['RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  RUNNING: ['AWAITING_VERIFICATION', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  BLOCKED: ['RUNNING', 'FAILED', 'CANCELLED'],
  AWAITING_VERIFICATION: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/** True when a task in `from` may move to `to`. Self-transitions are not moves. */
export const canTransition = (from: AgentTaskState, to: AgentTaskState): boolean =>
  AGENT_TASK_TRANSITIONS[from].includes(to);

/**
 * The state a task starts in. Named rather than assumed, so a runtime that
 * begins somewhere else has to say so.
 */
export const INITIAL_AGENT_TASK_STATE: AgentTaskState = 'ASSIGNED';

/** Every state that is reachable from the initial one, by construction. */
export const reachableAgentTaskStates = (): readonly AgentTaskState[] => {
  const seen = new Set<AgentTaskState>([INITIAL_AGENT_TASK_STATE]);
  const queue: AgentTaskState[] = [INITIAL_AGENT_TASK_STATE];
  for (let i = 0; i < queue.length; i += 1) {
    const state = queue[i] as AgentTaskState;
    for (const next of AGENT_TASK_TRANSITIONS[state]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return AGENT_TASK_STATES.filter((state) => seen.has(state));
};

/**
 * Why a transition was refused, in words that name both states. A rejection
 * that only says "invalid" sends the reader to the source.
 *
 * The non-terminal branch can always list something, because a state with no
 * permitted moves is terminal by definition and the table test proves the two
 * definitions agree.
 */
export const refusalReason = (from: AgentTaskState, to: AgentTaskState): string =>
  isTerminalAgentTaskState(from)
    ? `task is already ${from}, which is terminal; it cannot become ${to}`
    : `a task in ${from} cannot become ${to} (permitted: ${AGENT_TASK_TRANSITIONS[from].join(', ')})`;
