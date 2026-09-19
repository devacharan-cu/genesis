/**
 * The boundary every agent message crosses.
 *
 * Most of this suite is about what does NOT get through, because that is what
 * the boundary is for: an unknown kind, an undeclared field, a body for the
 * wrong kind, a message from an agent that only the core may send.
 */

import { AUTHORITY_LEVELS, MESSAGE_KINDS, newAgentId, newMessageId, newTaskId } from '@genesis/core-types';
import { describe, expect, test } from 'vitest';
import {
  type ActorRef,
  checkEnvelope,
  ENVELOPE_SCHEMAS,
  Envelope,
  isAgentOriginated,
  MESSAGE_BODIES,
  MESSAGE_DIRECTION,
  PROTOCOL_VERSION,
  taskOf,
} from '../src/envelope.js';

const taskId = newTaskId();
const core: ActorRef = { kind: 'SYSTEM', id: 'agent-runtime' };
const planner: ActorRef = { kind: 'AGENT', id: newAgentId(), role: 'PLANNER' };

const wrap = (kind: string, body: unknown, from: ActorRef = planner, to: ActorRef = core): unknown => ({
  id: newMessageId(),
  schemaVersion: PROTOCOL_VERSION,
  kind,
  from,
  to,
  issuedAt: '2026-09-19T10:00:00.000Z',
  body,
});

const assignment = {
  taskId,
  attempt: 1,
  role: 'PLANNER',
  kind: 'DECOMPOSE_GOAL',
  instruction: 'Break the active goal into an ordered plan.',
  contributesTo: ['goal_1'],
  context: [{ id: 'mem_1', kind: 'BELIEF', authority: 'EVIDENCE', text: 'the build is green' }],
  budget: { maxOutputTokens: 1024, timeoutMs: 30_000 },
  deadline: '2026-09-19T10:05:00.000Z',
};

const proposal = {
  taskId,
  proposalKind: 'RECORD_BELIEF',
  rationale: 'the context says the build is green',
  contributesTo: ['goal_1'],
  changes: { statement: 'the build is green' },
};

describe('the envelope', () => {
  test('accepts a well-formed assignment from the core', () => {
    const checked = checkEnvelope(wrap('TASK_ASSIGNMENT', assignment, core, planner));
    expect(checked.ok).toBe(true);
  });

  test('accepts a well-formed proposal from an agent', () => {
    const checked = checkEnvelope(wrap('PROPOSAL', proposal));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.envelope.kind).toBe('PROPOSAL');
    expect(taskOf(checked.envelope)).toBe(taskId);
  });

  test('fills the optional routing fields rather than leaving them absent', () => {
    const checked = checkEnvelope(wrap('PROPOSAL', proposal));
    if (!checked.ok) throw new Error('expected a valid envelope');
    expect(checked.envelope.cycleId).toBeNull();
    expect(checked.envelope.correlationId).toBeNull();
    expect(checked.envelope.causationId).toBeNull();
    expect(checked.envelope.expiresAt).toBeNull();
  });

  test('applies the declared defaults of a proposal body', () => {
    const checked = checkEnvelope(wrap('PROPOSAL', proposal));
    if (!checked.ok || checked.envelope.kind !== 'PROPOSAL') throw new Error('expected a proposal');
    expect(checked.envelope.body.expectedImpact).toEqual([]);
    expect(checked.envelope.body.evidenceRefs).toEqual([]);
    expect(checked.envelope.body.reversible).toBe(true);
  });

  // ------------------------------------------------------------- refusals

  test('refuses a value that is not an object', () => {
    for (const value of [null, undefined, 7, 'PROPOSAL', []]) {
      const checked = checkEnvelope(value);
      expect(checked.ok).toBe(false);
      if (checked.ok) return;
      expect(checked.kind).toBeNull();
      expect(checked.issues[0]).toContain('names its kind');
    }
  });

  test('refuses a kind that is not in the protocol', () => {
    const checked = checkEnvelope(wrap('EXECUTE_SQL', proposal));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.kind).toBe('EXECUTE_SQL');
    expect(checked.issues[0]).toContain('is not a message kind');
  });

  test('refuses an undeclared field, so there is no unaudited channel', () => {
    const checked = checkEnvelope({ ...(wrap('PROPOSAL', proposal) as object), sideChannel: 'anything' });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.kind).toBe('PROPOSAL');
  });

  test('refuses an undeclared field inside the body', () => {
    const checked = checkEnvelope(wrap('PROPOSAL', { ...proposal, verified: true }));
    expect(checked.ok).toBe(false);
  });

  test('refuses a body belonging to a different kind', () => {
    const checked = checkEnvelope(wrap('FINDING', proposal));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.kind).toBe('FINDING');
  });

  test('refuses a proposal that serves no goal', () => {
    const checked = checkEnvelope(wrap('PROPOSAL', { ...proposal, contributesTo: [] }));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.issues.join(' ')).toContain('contributesTo');
  });

  test('refuses a task id that is not one', () => {
    const checked = checkEnvelope(wrap('PROPOSAL', { ...proposal, taskId: 'task-one' }));
    expect(checked.ok).toBe(false);
  });

  test('refuses a message id that is not one', () => {
    const base = wrap('PROPOSAL', proposal) as Record<string, unknown>;
    const checked = checkEnvelope({ ...base, id: 'msg-1' });
    expect(checked.ok).toBe(false);
  });

  test('refuses a protocol version it does not speak', () => {
    const base = wrap('PROPOSAL', proposal) as Record<string, unknown>;
    const checked = checkEnvelope({ ...base, schemaVersion: '2' });
    expect(checked.ok).toBe(false);
  });

  test('refuses a role that is not on the roster', () => {
    const checked = checkEnvelope(wrap('PROPOSAL', proposal, { kind: 'AGENT', id: newAgentId(), role: 'ORACLE' } as never));
    expect(checked.ok).toBe(false);
  });

  test('reports at most five issues, so a rejection stays readable', () => {
    const checked = checkEnvelope(wrap('TASK_ASSIGNMENT', {}, core, planner));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.issues.length).toBeLessThanOrEqual(5);
    expect(checked.issues.length).toBeGreaterThan(0);
  });
});

describe('what a message cannot say', () => {
  test('no body has a field that declares something verified', () => {
    // The whole point of the protocol: an agent submits what happened, and the
    // core decides what it justifies. A `verificationState` field anywhere here
    // would be a way to skip that.
    for (const [kind, schema] of Object.entries(MESSAGE_BODIES)) {
      const keys = Object.keys(schema.shape as Record<string, unknown>);
      expect(keys, `${kind} declares a verification state`).not.toContain('verificationState');
      expect(keys, `${kind} declares an authority outright`).not.toContain('authority');
    }
  });

  test('only a proposal may carry an authority claim, and only as a claim', () => {
    const carriers = Object.entries(MESSAGE_BODIES)
      .filter(([, schema]) => 'authorityClaim' in (schema.shape as Record<string, unknown>))
      .map(([kind]) => kind);
    expect(carriers).toEqual(['PROPOSAL']);
  });

  test('an authority claim is accepted as data, not as a grant', () => {
    for (const authority of AUTHORITY_LEVELS) {
      const checked = checkEnvelope(wrap('PROPOSAL', { ...proposal, authorityClaim: authority }));
      // The protocol takes the claim; the core clamps it. Refusing it here
      // would hide from the ledger what the agent actually asked for.
      expect(checked.ok, `authority ${authority}`).toBe(true);
    }
  });
});

describe('direction', () => {
  test('every message kind has a declared direction', () => {
    expect(Object.keys(MESSAGE_DIRECTION).sort()).toEqual([...MESSAGE_KINDS].sort());
  });

  test('every message kind has a body schema and an envelope schema', () => {
    expect(Object.keys(MESSAGE_BODIES).sort()).toEqual([...MESSAGE_KINDS].sort());
    expect(Object.keys(ENVELOPE_SCHEMAS).sort()).toEqual([...MESSAGE_KINDS].sort());
  });

  test('an agent-sent proposal is agent-originated', () => {
    const checked = checkEnvelope(wrap('PROPOSAL', proposal));
    if (!checked.ok) throw new Error('expected a valid envelope');
    expect(isAgentOriginated(checked.envelope)).toBe(true);
  });

  test('an agent cannot assign itself work', () => {
    const checked = checkEnvelope(wrap('TASK_ASSIGNMENT', assignment, planner, planner));
    if (!checked.ok) throw new Error('expected a valid envelope');
    // It parses — the shape is fine. It is not agent-originated traffic, which
    // is what the runtime routes on.
    expect(isAgentOriginated(checked.envelope)).toBe(false);
  });

  test('a proposal the core sent is not agent-originated either', () => {
    const checked = checkEnvelope(wrap('PROPOSAL', proposal, core, core));
    if (!checked.ok) throw new Error('expected a valid envelope');
    expect(isAgentOriginated(checked.envelope)).toBe(false);
  });
});

describe('every kind round-trips', () => {
  const bodies: Record<string, unknown> = {
    TASK_ASSIGNMENT: assignment,
    PROPOSAL: proposal,
    FINDING: { taskId, subject: 'the retry loop', detail: 'it has no ceiling', risk: 'HIGH' },
    QUESTION: {
      taskId,
      text: 'Which region is production in?',
      reason: 'no context item says',
      audience: 'HUMAN',
      whatBreaksIfWrong: 'the deployment targets the wrong account',
      risk: 'CRITICAL',
      resolution: 'ASK_HUMAN',
    },
    EVIDENCE_SUBMISSION: {
      taskId,
      environment: 'SANDBOX',
      exitCode: 0,
      raw: 'ok',
      testKind: 'UNIT',
      claimedArtifacts: ['file_1'],
    },
    STATUS: { taskId, note: 'halfway', progress: 0.5 },
    RESULT: { taskId, summary: 'decomposed into four tasks' },
    ERROR: { taskId, kind: 'TIMEOUT', message: 'no response', signature: 'PLANNER:TIMEOUT', retryable: true },
    CANCEL: { taskId, reason: 'the goal was abandoned' },
  };

  for (const kind of MESSAGE_KINDS) {
    test(`${kind} parses, and survives JSON unchanged`, () => {
      const sender = MESSAGE_DIRECTION[kind] === 'CORE_TO_AGENT' ? core : planner;
      const recipient = MESSAGE_DIRECTION[kind] === 'CORE_TO_AGENT' ? planner : core;
      const checked = checkEnvelope(wrap(kind, bodies[kind], sender, recipient));
      expect(checked.ok, `${kind}: ${checked.ok ? '' : checked.issues.join('; ')}`).toBe(true);
      if (!checked.ok) return;
      // Serialisable, per ADR-0020 §5: what the ledger stores is what comes back.
      const round = Envelope.parse(JSON.parse(JSON.stringify(checked.envelope)) as unknown);
      expect(round).toEqual(checked.envelope);
      expect(taskOf(round)).toBe(taskId);
    });
  }
});
