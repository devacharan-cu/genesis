/**
 * The belief system (SPEC-01 §6). The ladder's entry requirements are each
 * tested by making them refuse; the authority rules by trying to cheat them.
 */

import { AUTHORITY_LEVELS, BELIEF_STATES } from '@genesis/core-types';
import { beliefAuthority, beliefsInState, openContradictingEvidence } from '@genesis/cognition';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, evidence, expectRefused, HUMAN, Mind, SYSTEM } from './support.js';

let mind: Mind;
beforeEach(() => {
  mind = new Mind();
});

const record = (over: Record<string, unknown> = {}, actor = SYSTEM): string => {
  mind.run(actor, { kind: 'RECORD_BELIEF', statement: 'the cache is warm', ...over });
  return mind.lastId('belief');
};

const move = (id: string, to: string, actor = SYSTEM, reason?: string): void => {
  mind.run(actor, { kind: 'TRANSITION_BELIEF', beliefId: id, to, ...(reason === undefined ? {} : { reason }) });
};

const add = (id: string, ev: Record<string, unknown>, polarity = 'SUPPORTING', actor = SYSTEM): void => {
  mind.run(actor, { kind: 'ADD_BELIEF_EVIDENCE', beliefId: id, polarity, evidence: ev });
};

/** A belief carried to TESTED legitimately. */
const tested = (): string => {
  const id = record();
  move(id, 'ASSUMED', SYSTEM, 'observed warm-up logs');
  add(id, evidence('ev-1'));
  move(id, 'SUPPORTED');
  move(id, 'TESTED');
  return id;
};

describe('recording', () => {
  it('records UNKNOWN by default, at AI_ASSUMPTION', () => {
    const id = record();
    const b = mind.state.beliefs[id];
    expect([b?.state, b?.authority, b?.authorityRequested, b?.authorityClamp]).toEqual([
      'UNKNOWN',
      'AI_ASSUMPTION',
      'AI_ASSUMPTION',
      null,
    ]);
  });

  it('records ASSUMED only with a rationale', () => {
    expectRefused(mind, 'RATIONALE_REQUIRED', () => record({ state: 'ASSUMED' }));
    expectRefused(mind, 'RATIONALE_REQUIRED', () => record({ state: 'ASSUMED', rationale: '  ' }));
    const id = record({ state: 'ASSUMED', rationale: 'the logs say so' });
    expect(mind.state.beliefs[id]?.rationale).toBe('the logs say so');
  });

  it('keeps confidence as metadata, and subjects and reasoning call as given', () => {
    const id = record({
      confidence: 0.99,
      subjectRefs: [{ nodeType: 'COMPONENT', nodeId: 'node_x' }],
      reasoningCallId: 'call-7',
    });
    const b = mind.state.beliefs[id];
    expect([b?.confidence, b?.subjectRefs.length, b?.reasoningCallId]).toEqual([0.99, 1, 'call-7']);
  });
});

describe('authority (ADR-0014 rule 5)', () => {
  it('never lets an agent promote its own claim above AI_ASSUMPTION', () => {
    for (const requested of AUTHORITY_LEVELS) {
      const { authority } = beliefAuthority('AGENT', requested);
      expect(AUTHORITY_LEVELS.indexOf(authority), requested).toBeGreaterThanOrEqual(
        AUTHORITY_LEVELS.indexOf('AI_ASSUMPTION'),
      );
    }
  });

  it('records the clamp rather than applying it silently', () => {
    const agent = record({ authority: 'EVIDENCE' }, AGENT);
    expect(mind.state.beliefs[agent]?.authorityClamp).toBe('AGENT_ASSUMPTION_CAP');
    expect(mind.state.beliefs[agent]?.authorityRequested).toBe('EVIDENCE');

    const system = record({ authority: 'HUMAN_DECISION' }, SYSTEM);
    expect(mind.state.beliefs[system]?.authority).toBe('VERIFIED_SYSTEM_STATE');
    expect(mind.state.beliefs[system]?.authorityClamp).toBe('ACTOR_CEILING');

    const human = record({ authority: 'HUMAN_DECISION' }, HUMAN);
    expect(mind.state.beliefs[human]?.authorityClamp).toBeNull();
  });

  it('lets an agent record at or below AI_ASSUMPTION unclamped', () => {
    const id = record({ authority: 'UNGROUNDED' }, AGENT);
    expect(mind.state.beliefs[id]?.authorityClamp).toBeNull();
  });

  it('is monotone: asking for more never yields less', () => {
    for (const actor of ['HUMAN', 'SYSTEM', 'AGENT'] as const) {
      const effective = AUTHORITY_LEVELS.map((r) => AUTHORITY_LEVELS.indexOf(beliefAuthority(actor, r).authority));
      // AUTHORITY_LEVELS is highest-first, so ranks must be non-decreasing down the list.
      for (let i = 1; i < effective.length; i++) {
        expect(effective[i], `${actor} ${AUTHORITY_LEVELS[i]}`).toBeGreaterThanOrEqual(effective[i - 1] ?? 0);
      }
    }
  });
});

describe('the ladder (SPEC-01 §6.1)', () => {
  it('climbs one step at a time with each entry requirement met', () => {
    const id = tested();
    move(id, 'VERIFIED');
    const b = mind.state.beliefs[id];
    expect(b?.state).toBe('VERIFIED');
    expect(b?.history.map((h) => h.to)).toEqual(['ASSUMED', 'SUPPORTED', 'TESTED', 'VERIFIED']);
    expect(b?.rationale).toBe('observed warm-up logs');
  });

  it('refuses skipping a state', () => {
    const id = record();
    expectRefused(mind, 'SKIPPED_STATE', () => move(id, 'SUPPORTED'));
  });

  it('refuses a transition to the current state', () => {
    const id = record();
    expectRefused(mind, 'NO_CHANGE', () => move(id, 'UNKNOWN', SYSTEM, 'x'));
  });

  it('ASSUMED needs a rationale', () => {
    const id = record();
    expectRefused(mind, 'RATIONALE_REQUIRED', () => move(id, 'ASSUMED'));
  });

  it('SUPPORTED needs evidence not produced by the reasoning call that made the belief', () => {
    const id = record({ state: 'ASSUMED', rationale: 'r', reasoningCallId: 'call-1' }, AGENT);
    expectRefused(mind, 'NEEDS_INDEPENDENT_EVIDENCE', () => move(id, 'SUPPORTED', AGENT));
    add(id, evidence('self', { producedBy: 'call-1', kind: 'OBSERVATION' }), 'SUPPORTING', AGENT);
    expectRefused(mind, 'NEEDS_INDEPENDENT_EVIDENCE', () => move(id, 'SUPPORTED', AGENT));
    add(id, evidence('other', { producedBy: 'run-9', kind: 'DOCUMENT' }), 'SUPPORTING', AGENT);
    move(id, 'SUPPORTED', AGENT);
    expect(mind.state.beliefs[id]?.state).toBe('SUPPORTED');
  });

  it('TESTED needs an executed test that could have falsified the belief', () => {
    const id = record({ state: 'ASSUMED', rationale: 'r' });
    add(id, evidence('obs', { kind: 'OBSERVATION' }));
    move(id, 'SUPPORTED');
    expectRefused(mind, 'NEEDS_FALSIFYING_TEST', () => move(id, 'TESTED'));
    add(id, evidence('weak', { couldFalsify: false }));
    expectRefused(mind, 'NEEDS_FALSIFYING_TEST', () => move(id, 'TESTED'));
    add(id, evidence('exp', { kind: 'EXPERIMENT' }));
    move(id, 'TESTED');
    expect(mind.state.beliefs[id]?.state).toBe('TESTED');
  });

  it('never lets an agent move a belief to TESTED or VERIFIED', () => {
    const id = record({ state: 'ASSUMED', rationale: 'r' });
    add(id, evidence('ev-1'));
    move(id, 'SUPPORTED');
    expectRefused(mind, 'AGENT_CANNOT_TEST', () => move(id, 'TESTED', AGENT));
    move(id, 'TESTED');
    expectRefused(mind, 'AGENT_CANNOT_TEST', () => move(id, 'VERIFIED', AGENT));
  });

  it('does not count test evidence an agent attached (no laundering)', () => {
    const id = record({ state: 'ASSUMED', rationale: 'r' });
    add(id, evidence('ev-agent'), 'SUPPORTING', AGENT);
    move(id, 'SUPPORTED');
    expectRefused(mind, 'NEEDS_FALSIFYING_TEST', () => move(id, 'TESTED'));
  });

  it('VERIFIED needs target-environment test evidence', () => {
    const id = record({ state: 'ASSUMED', rationale: 'r' });
    add(id, evidence('sandbox', { environment: 'SANDBOX' }));
    move(id, 'SUPPORTED');
    move(id, 'TESTED');
    expectRefused(mind, 'NEEDS_TARGET_EVIDENCE', () => move(id, 'VERIFIED'));
  });

  it('VERIFIED needs no open contradicting evidence, and a dismissal clears the way', () => {
    const id = tested();
    add(id, evidence('against', { kind: 'OBSERVATION' }), 'CONTRADICTING');
    expectRefused(mind, 'OPEN_CONTRADICTING_EVIDENCE', () => move(id, 'VERIFIED'));
    mind.run(HUMAN, { kind: 'DISMISS_CONTRADICTING_EVIDENCE', beliefId: id, evidenceId: 'against', reason: 'stale host' });
    const belief = mind.state.beliefs[id];
    expect(belief).toBeDefined();
    if (belief !== undefined) expect(openContradictingEvidence(belief)).toEqual([]);
    move(id, 'VERIFIED');
    expect(mind.state.beliefs[id]?.state).toBe('VERIFIED');
  });

  it('dismisses exactly the evidence named, leaving the rest open', () => {
    const id = tested();
    add(id, evidence('first', { kind: 'OBSERVATION' }), 'CONTRADICTING');
    add(id, evidence('second', { kind: 'OBSERVATION' }), 'CONTRADICTING');
    mind.run(HUMAN, { kind: 'DISMISS_CONTRADICTING_EVIDENCE', beliefId: id, evidenceId: 'first', reason: 'stale host' });
    expect(mind.state.beliefs[id]?.contradictingEvidence.map((e) => [e.evidenceId, e.status])).toEqual([
      ['first', 'DISMISSED'],
      ['second', 'OPEN'],
    ]);
  });

  it('downgrades to any lower state with a reason, without overwriting the rationale', () => {
    const id = tested();
    expectRefused(mind, 'REASON_REQUIRED', () => move(id, 'ASSUMED'));
    move(id, 'ASSUMED', AGENT, 'the test host was misconfigured');
    const b = mind.state.beliefs[id];
    expect(b?.state).toBe('ASSUMED');
    expect(b?.rationale).toBe('observed warm-up logs');
    move(id, 'UNKNOWN', AGENT, 'no longer sure');
    expect(mind.state.beliefs[id]?.state).toBe('UNKNOWN');
  });

  it('lists beliefs by state', () => {
    const a = record();
    record({ state: 'ASSUMED', rationale: 'r' });
    expect(beliefsInState(mind.state, 'UNKNOWN').map((b) => b.id)).toEqual([a]);
    expect(BELIEF_STATES).toContain('VERIFIED');
  });
});

describe('evidence', () => {
  it('refuses the same evidence twice, on either side', () => {
    const id = record();
    add(id, evidence('ev-1'));
    expectRefused(mind, 'EVIDENCE_ALREADY_RECORDED', () => add(id, evidence('ev-1'), 'CONTRADICTING'));
  });

  it('refuses evidence for a belief that does not exist', () => {
    expectRefused(mind, 'BELIEF_NOT_FOUND', () => add('bel-404', evidence('e')));
  });

  it('records who attached evidence and when', () => {
    const id = record();
    add(id, evidence('ev-1'), 'SUPPORTING', AGENT);
    expect(mind.state.beliefs[id]?.supportingEvidence[0]?.addedBy).toEqual({ actorKind: 'AGENT', actorId: 'agt-1' });
  });

  it('downgrades a VERIFIED belief in the same decision when evidence contradicts it', () => {
    const id = tested();
    move(id, 'VERIFIED');
    const events = mind.run(AGENT, {
      kind: 'ADD_BELIEF_EVIDENCE',
      beliefId: id,
      polarity: 'CONTRADICTING',
      evidence: evidence('regression', { kind: 'OBSERVATION' }),
    });
    expect(events.map((e) => e.type)).toEqual(['BELIEF_EVIDENCE_ADDED', 'BELIEF_STATE_CHANGED']);
    expect(mind.state.beliefs[id]?.state).toBe('TESTED');
  });

  it('does not downgrade a belief below VERIFIED on contradicting evidence alone', () => {
    const id = tested();
    add(id, evidence('against', { kind: 'OBSERVATION' }), 'CONTRADICTING');
    expect(mind.state.beliefs[id]?.state).toBe('TESTED');
  });

  it('refuses an agent dismissing evidence against a belief', () => {
    const id = record();
    add(id, evidence('against'), 'CONTRADICTING');
    expectRefused(mind, 'AGENT_CANNOT_DISMISS', () =>
      mind.run(AGENT, { kind: 'DISMISS_CONTRADICTING_EVIDENCE', beliefId: id, evidenceId: 'against', reason: 'x' }),
    );
  });

  it('refuses dismissing evidence that is not open, or without a reason', () => {
    const id = record();
    add(id, evidence('against'), 'CONTRADICTING');
    expectRefused(mind, 'REASON_REQUIRED', () =>
      mind.run(SYSTEM, { kind: 'DISMISS_CONTRADICTING_EVIDENCE', beliefId: id, evidenceId: 'against' }),
    );
    expectRefused(mind, 'NO_OPEN_EVIDENCE', () =>
      mind.run(SYSTEM, { kind: 'DISMISS_CONTRADICTING_EVIDENCE', beliefId: id, evidenceId: 'nope', reason: 'x' }),
    );
    mind.run(SYSTEM, { kind: 'DISMISS_CONTRADICTING_EVIDENCE', beliefId: id, evidenceId: 'against', reason: 'x' });
    expectRefused(mind, 'NO_OPEN_EVIDENCE', () =>
      mind.run(SYSTEM, { kind: 'DISMISS_CONTRADICTING_EVIDENCE', beliefId: id, evidenceId: 'against', reason: 'x' }),
    );
  });
});
