/**
 * The boundary an agent's output crosses.
 *
 * `checkOutcome` is the runtime's last chance to refuse something before acting
 * on it, so every way an agent can be wrong is exercised here: a non-object, a
 * missing list, too many messages, a state it may not claim, a message kind
 * only the core may send, and a message about somebody else's task.
 */

import { newAgentId, newMessageId, newTaskId } from '@genesis/core-types';
import type { Envelope, TaskAssignmentBody } from '@genesis/protocol';
import { describe, expect, test } from 'vitest';
import {
  AGENT_FAILURES,
  AgentError,
  checkOutcome,
  declaredProposalKinds,
  failureKindOf,
  failureSignature,
} from '../src/contract.js';

const taskId = newTaskId();
const otherTask = newTaskId();
const agentId = newAgentId();

const assignment: TaskAssignmentBody = {
  taskId,
  attempt: 1,
  role: 'PLANNER',
  kind: 'PLANNER_TASK',
  instruction: 'decompose the goal',
  contributesTo: ['goal-1'],
  context: [],
  budget: { maxOutputTokens: 512, timeoutMs: 1000 },
  deadline: '2026-09-19T10:05:00.000Z',
};

const envelope = (over: Partial<Envelope> = {}, task = taskId): Envelope =>
  ({
    id: newMessageId(),
    schemaVersion: '1',
    kind: 'RESULT',
    from: { kind: 'AGENT', id: agentId, role: 'PLANNER' },
    to: { kind: 'SYSTEM', id: 'agent-runtime' },
    cycleId: null,
    correlationId: null,
    causationId: null,
    issuedAt: '2026-09-19T10:00:00.000Z',
    expiresAt: null,
    body: { taskId: task, summary: 'done', proposalsSubmitted: 0, findingsRaised: 0, questionsRaised: 0 },
    ...over,
  }) as Envelope;

describe('checkOutcome accepts', () => {
  test('an outcome with no messages at all', () => {
    const checked = checkOutcome(assignment, { messages: [], reached: 'COMPLETED' }, 10);
    expect(checked.ok).toBe(true);
  });

  test('each state an agent is allowed to report', () => {
    for (const reached of ['COMPLETED', 'BLOCKED', 'AWAITING_VERIFICATION'] as const) {
      expect(checkOutcome(assignment, { messages: [envelope()], reached }, 10).ok, reached).toBe(true);
    }
  });

  test('exactly the message limit', () => {
    const messages = Array.from({ length: 3 }, () => envelope());
    expect(checkOutcome(assignment, { messages, reached: 'COMPLETED' }, 3).ok).toBe(true);
  });
});

describe('checkOutcome refuses', () => {
  const refusal = (outcome: unknown, max = 10) => {
    const checked = checkOutcome(assignment, outcome, max);
    if (checked.ok) throw new Error('expected a refusal');
    return checked;
  };

  test('anything that is not an object', () => {
    for (const value of [null, undefined, 7, 'done']) {
      expect(refusal(value).kind).toBe('MALFORMED_OUTPUT');
    }
  });

  test('an outcome with no list of messages', () => {
    expect(refusal({ reached: 'COMPLETED' }).reason).toContain('no list of messages');
    expect(refusal({ messages: 'none', reached: 'COMPLETED' }).reason).toContain('no list of messages');
  });

  test('more messages than the limit, naming both numbers', () => {
    const messages = Array.from({ length: 4 }, () => envelope());
    const checked = refusal({ messages, reached: 'COMPLETED' }, 3);
    expect(checked.reason).toContain('4 messages');
    expect(checked.reason).toContain('limit of 3');
  });

  test('a state an agent may not claim for itself', () => {
    for (const reached of ['FAILED', 'CANCELLED', 'RUNNING', 'ASSIGNED', undefined, 7]) {
      const checked = refusal({ messages: [], reached });
      expect(checked.kind, String(reached)).toBe('MALFORMED_OUTPUT');
      expect(checked.reason).toContain('cannot report reaching');
    }
  });

  test('a message kind only the core may send', () => {
    const checked = refusal({ messages: [envelope({ kind: 'CANCEL' })], reached: 'COMPLETED' });
    expect(checked.kind).toBe('CAPABILITY_REFUSED');
    expect(checked.reason).toContain('CANCEL');
  });

  test('a message an agent did not send', () => {
    const checked = refusal({
      messages: [envelope({ from: { kind: 'HUMAN', id: 'dev' } })],
      reached: 'COMPLETED',
    });
    expect(checked.kind).toBe('CAPABILITY_REFUSED');
    expect(checked.reason).toContain('HUMAN');
  });

  test('a message about a task this agent was not assigned', () => {
    const checked = refusal({ messages: [envelope({}, otherTask)], reached: 'COMPLETED' });
    expect(checked.kind).toBe('CAPABILITY_REFUSED');
    expect(checked.reason).toContain(otherTask);
  });

  test('a bad message among good ones, naming its position', () => {
    const messages = [envelope(), envelope({}, otherTask), envelope()];
    expect(refusal({ messages, reached: 'COMPLETED' }).reason).toContain('message 1');
  });
});

describe('failure classification', () => {
  test('an AgentError keeps the kind it declared', () => {
    for (const kind of AGENT_FAILURES) {
      expect(failureKindOf(new AgentError(kind, 'x'))).toBe(kind);
    }
  });

  test('anything else is AGENT_THREW, not a friendlier guess', () => {
    expect(failureKindOf(new TypeError('undefined is not a function'))).toBe('AGENT_THREW');
    expect(failureKindOf('a string')).toBe('AGENT_THREW');
    expect(failureKindOf(undefined)).toBe('AGENT_THREW');
  });

  test('a signature groups occurrences rather than distinguishing them', () => {
    const first = failureSignature('PLANNER', 'PLANNER_TASK', 'TIMEOUT');
    const second = failureSignature('PLANNER', 'PLANNER_TASK', 'TIMEOUT');
    expect(first).toBe(second);
    expect(first).toBe('agent:PLANNER:PLANNER_TASK:TIMEOUT');
  });

  test('different roles, tasks and kinds do not collide', () => {
    const signatures = new Set([
      failureSignature('PLANNER', 'A', 'TIMEOUT'),
      failureSignature('QA', 'A', 'TIMEOUT'),
      failureSignature('PLANNER', 'B', 'TIMEOUT'),
      failureSignature('PLANNER', 'A', 'AGENT_THREW'),
    ]);
    expect(signatures.size).toBe(4);
  });

  test('every declared failure kind is a usable signature', () => {
    expect(AGENT_FAILURES.length).toBeGreaterThan(0);
    for (const kind of AGENT_FAILURES) {
      expect(failureSignature('QA', 'T', kind)).toContain(kind);
    }
  });
});

describe('declaredProposalKinds', () => {
  test('reports what the manifest says, without interpreting it', () => {
    expect(declaredProposalKinds({ proposalKinds: ['RECORD_BELIEF'] } as never)).toEqual(['RECORD_BELIEF']);
  });
});
