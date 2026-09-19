/**
 * The decision context and command gate (ADR-0014 rules 2 and 3).
 */

import {
  actionAuthority,
  cognitiveEvent,
  decide,
  emptyCognitionState,
  requireReason,
  sortById,
} from '@genesis/cognition';
import { CognitiveRuleViolationError } from '@genesis/core-types';
import { describe, expect, it } from 'vitest';
import { AGENT, countingIds, HUMAN, SYSTEM } from './support.js';

const ctx = { actor: HUMAN, now: '2026-01-01T00:00:00.000Z', ids: countingIds() };

describe('actionAuthority', () => {
  it('is a decision for a human, observed state for the system, an assumption for an agent', () => {
    expect(actionAuthority(HUMAN)).toBe('HUMAN_DECISION');
    expect(actionAuthority(SYSTEM)).toBe('VERIFIED_SYSTEM_STATE');
    expect(actionAuthority(AGENT)).toBe('AI_ASSUMPTION');
  });
});

describe('cognitiveEvent', () => {
  it('stamps the actor, the time and — unless told otherwise — the action authority', () => {
    const plain = cognitiveEvent(ctx, 'GOAL_PROPOSED', null);
    expect([plain.actor, plain.timestamp, plain.authority, plain.subject]).toEqual([
      HUMAN,
      '2026-01-01T00:00:00.000Z',
      'HUMAN_DECISION',
      null,
    ]);
    expect(cognitiveEvent(ctx, 'BELIEF_RECORDED', null, 'EVIDENCE').authority).toBe('EVIDENCE');
  });
});

describe('requireReason', () => {
  it('returns a trimmed reason, and refuses a missing or blank one', () => {
    expect(requireReason('  because  ', 'R', 'x')).toBe('because');
    expect(() => requireReason(undefined, 'R', 'x')).toThrow(CognitiveRuleViolationError);
    expect(() => requireReason('   ', 'R', 'closing')).toThrow(/closing requires a stated reason/);
  });
});

describe('sortById', () => {
  it('orders by id, by code unit rather than locale', () => {
    expect(sortById([{ id: 'b' }, { id: 'B' }, { id: 'a' }]).map((x) => x.id)).toEqual(['B', 'a', 'b']);
  });
});

describe('decide', () => {
  it('refuses anything that is not a valid command, and names the rule', () => {
    for (const bad of [null, 42, 'PROPOSE_GOAL', {}, { kind: 'NOPE' }, { kind: 'PROPOSE_GOAL', description: 'd', priority: 1, extra: true }]) {
      try {
        decide(emptyCognitionState(), bad, ctx);
        expect.unreachable(`${JSON.stringify(bad)} was accepted`);
      } catch (error) {
        expect(error).toBeInstanceOf(CognitiveRuleViolationError);
        expect((error as CognitiveRuleViolationError).rule).toBe('INVALID_COMMAND');
        expect((error as CognitiveRuleViolationError).code).toBe('COGNITIVE_RULE_VIOLATION');
      }
    }
  });

  it('is pure: the same state, command and context give the same events', () => {
    const command = { kind: 'PROPOSE_GOAL', description: 'd', priority: 1 };
    const a = decide(emptyCognitionState(), command, { ...ctx, ids: countingIds() });
    const b = decide(emptyCognitionState(), command, { ...ctx, ids: countingIds() });
    expect(a).toEqual(b);
  });

  it('routes each family to its decider', () => {
    const state = emptyCognitionState();
    const types = [
      { kind: 'PROPOSE_GOAL', description: 'd', priority: 1 },
      { kind: 'RECORD_BELIEF', statement: 's' },
      { kind: 'RECORD_UNCERTAINTY', statement: 's', whatBreaksIfWrong: 'w', risk: 'LOW', resolution: 'SEARCH' },
      {
        kind: 'RECORD_CONTRADICTION',
        contradictionKind: 'REQUIREMENT_TEST',
        sides: [
          { kind: 'EXTERNAL', id: 'a', claim: 'a', authority: 'EVIDENCE' },
          { kind: 'EXTERNAL', id: 'b', claim: 'b', authority: 'HISTORICAL' },
        ],
      },
    ].map((command) => decide(state, command, ctx).map((e) => e.type)[0]);
    expect(types).toEqual(['GOAL_PROPOSED', 'BELIEF_RECORDED', 'UNCERTAINTY_RECORDED', 'CONTRADICTION_RECORDED']);
  });
});
