/**
 * The contradiction engine (SPEC-01 §8). The tests that matter: both sides are
 * always kept, an agent cannot win by declaring authority, and a tie is never
 * broken by anything but a human.
 */

import {
  contradictionsInvolving,
  determine,
  escalatedContradictions,
} from '@genesis/cognition';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, evidence, expectRefused, HUMAN, Mind, SYSTEM, testCriterion } from './support.js';

let mind: Mind;
beforeEach(() => {
  mind = new Mind();
});

const belief = (statement: string, actor = SYSTEM, authority?: string): string => {
  mind.run(actor, { kind: 'RECORD_BELIEF', statement, ...(authority === undefined ? {} : { authority }) });
  return mind.lastId('belief');
};

const external = (id: string, authority: string, claim = `claim ${id}`) => ({
  kind: 'EXTERNAL' as const,
  id,
  claim,
  authority,
});

const recordContradiction = (sides: unknown[], actor = SYSTEM, over: Record<string, unknown> = {}) => {
  const events = mind.run(actor, {
    kind: 'RECORD_CONTRADICTION',
    contradictionKind: 'DOCUMENTATION_IMPLEMENTATION',
    sides,
    ...over,
  });
  return { events: events.map((e) => e.type), id: mind.lastId('contradiction') };
};

describe('resolution by authority', () => {
  it('lets strictly higher authority govern and marks the losing belief, keeping both sides', () => {
    const human = belief('the API is v2', HUMAN, 'HUMAN_DECISION');
    const guess = belief('the API is v1', AGENT);
    const { events, id } = recordContradiction([{ kind: 'BELIEF', beliefId: guess }, { kind: 'BELIEF', beliefId: human }]);

    expect(events).toEqual(['CONTRADICTION_RECORDED', 'BELIEF_SUPERSEDED_BY_AUTHORITY']);
    const c = mind.state.contradictions[id];
    expect([c?.determination, c?.status, c?.governingSide, c?.uncertaintyId]).toEqual([
      'AUTHORITY',
      'RESOLVED_BY_AUTHORITY',
      1,
      null,
    ]);
    // SPEC-01 §8.1 step 1: nothing is deleted. Both claims are on the record...
    expect(c?.sides.map((s) => s.claim)).toEqual(['the API is v1', 'the API is v2']);
    // ...and the loser is still readable, only marked.
    expect(mind.state.beliefs[guess]?.statement).toBe('the API is v1');
    expect(mind.state.beliefs[guess]?.supersededBy).toEqual([id]);
    expect(mind.state.beliefs[human]?.supersededBy).toEqual([]);
  });

  it('governs from side 0 as well as side 1', () => {
    const strong = belief('a', HUMAN, 'HUMAN_DECISION');
    const weak = belief('b', AGENT);
    const { id } = recordContradiction([{ kind: 'BELIEF', beliefId: strong }, { kind: 'BELIEF', beliefId: weak }]);
    expect(mind.state.contradictions[id]?.governingSide).toBe(0);
    expect(mind.state.beliefs[weak]?.supersededBy).toEqual([id]);
  });

  it('marks nothing when the losing side is not a belief', () => {
    const strong = belief('spec says X', HUMAN, 'HUMAN_DECISION');
    const { events } = recordContradiction([{ kind: 'BELIEF', beliefId: strong }, external('doc:readme', 'HISTORICAL')]);
    expect(events).toEqual(['CONTRADICTION_RECORDED']);
  });

  it('reads a belief side’s authority from state, never from the caller', () => {
    const weak = belief('b', AGENT);
    const { id } = recordContradiction([{ kind: 'BELIEF', beliefId: weak }, external('doc', 'EVIDENCE')]);
    const side = mind.state.contradictions[id]?.sides[0];
    expect([side?.authority, side?.authoritySource]).toEqual(['AI_ASSUMPTION', 'STATE']);
  });

  it('stops a superseded belief from advancing, but lets it be downgraded', () => {
    const human = belief('v2', HUMAN, 'HUMAN_DECISION');
    const guess = belief('v1', AGENT);
    recordContradiction([{ kind: 'BELIEF', beliefId: guess }, { kind: 'BELIEF', beliefId: human }]);
    expectRefused(mind, 'BELIEF_SUPERSEDED', () =>
      mind.run(SYSTEM, { kind: 'TRANSITION_BELIEF', beliefId: guess, to: 'ASSUMED', reason: 'r' }),
    );
    mind.run(SYSTEM, { kind: 'RECORD_BELIEF', statement: 'x', state: 'ASSUMED', rationale: 'r' });
    const assumed = mind.lastId('belief');
    recordContradiction([{ kind: 'BELIEF', beliefId: assumed }, { kind: 'BELIEF', beliefId: human }], SYSTEM, {
      contradictionKind: 'BELIEF_EVIDENCE',
    });
    mind.run(SYSTEM, { kind: 'TRANSITION_BELIEF', beliefId: assumed, to: 'UNKNOWN', reason: 'lost' });
    expect(mind.state.beliefs[assumed]?.state).toBe('UNKNOWN');
  });
});

describe('ties and indeterminacy are escalated, never guessed', () => {
  it('opens an ASK_HUMAN uncertainty, atomically, when authority is equal', () => {
    const a = belief('a');
    const b = belief('b');
    const { events, id } = recordContradiction([{ kind: 'BELIEF', beliefId: a }, { kind: 'BELIEF', beliefId: b }], SYSTEM, {
      affectedRefs: [{ nodeType: 'COMPONENT', nodeId: 'node_api' }],
    });
    expect(events).toEqual(['UNCERTAINTY_RECORDED', 'CONTRADICTION_RECORDED']);

    const c = mind.state.contradictions[id];
    expect([c?.determination, c?.status, c?.governingSide]).toEqual(['EQUAL_AUTHORITY', 'ESCALATED', null]);
    const u = mind.state.uncertainties[c?.uncertaintyId ?? ''];
    expect([u?.resolution, u?.source, u?.sourceRef, u?.risk]).toEqual(['ASK_HUMAN', 'CONTRADICTION', id, 'HIGH']);
    expect(u?.relatedBeliefs).toEqual([a, b].sort());
    expect(u?.impact.affectedRefs).toEqual([{ nodeType: 'COMPONENT', nodeId: 'node_api' }]);
    expect(mind.state.beliefs[a]?.supersededBy).toEqual([]);
    expect(escalatedContradictions(mind.state).map((x) => x.id)).toEqual([id]);
  });

  it('treats an agent-supplied authority as indeterminate — an agent cannot win by declaration', () => {
    const weak = belief('b', AGENT);
    const { id } = recordContradiction([{ kind: 'BELIEF', beliefId: weak }, external('doc', 'HUMAN_DECISION')], AGENT);
    const c = mind.state.contradictions[id];
    expect([c?.determination, c?.status]).toEqual(['INDETERMINATE', 'ESCALATED']);
    expect(mind.state.beliefs[weak]?.supersededBy).toEqual([]);
  });

  it('trusts an actor-supplied authority from a human or the system', () => {
    const sides = [
      { ref: { kind: 'EXTERNAL' as const, id: 'x' }, claim: 'x', authority: 'HUMAN_DECISION' as const, authoritySource: 'ACTOR' as const },
      { ref: { kind: 'EXTERNAL' as const, id: 'y' }, claim: 'y', authority: 'EVIDENCE' as const, authoritySource: 'ACTOR' as const },
    ] as const;
    expect(determine(sides, 'SYSTEM').determination).toBe('AUTHORITY');
    expect(determine(sides, 'HUMAN').determination).toBe('AUTHORITY');
    expect(determine(sides, 'AGENT').determination).toBe('INDETERMINATE');
  });

  it('can block goals through its uncertainty, with the risk asked for', () => {
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'g', priority: 1, successCriteria: [testCriterion()] });
    const goal = mind.lastId('goal');
    const { id } = recordContradiction([external('a', 'EVIDENCE'), external('b', 'EVIDENCE')], SYSTEM, {
      blocksGoalIds: [goal],
      risk: 'CRITICAL',
    });
    const u = mind.state.uncertainties[mind.state.contradictions[id]?.uncertaintyId ?? ''];
    expect([u?.blocksGoalIds, u?.risk]).toEqual([[goal], 'CRITICAL']);
  });

  it('keeps the escalation uncertainty tied to its contradiction', () => {
    const { id } = recordContradiction([external('a', 'EVIDENCE'), external('b', 'EVIDENCE')]);
    const u = mind.state.contradictions[id]?.uncertaintyId ?? '';
    expectRefused(mind, 'CONTRADICTION_OWNED', () =>
      mind.run(HUMAN, { kind: 'RESOLVE_UNCERTAINTY', uncertaintyId: u, evidence: ['e'] }),
    );
    expectRefused(mind, 'CONTRADICTION_OWNED', () =>
      mind.run(HUMAN, { kind: 'MARK_UNCERTAINTY_OBSOLETE', uncertaintyId: u, reason: 'x' }),
    );
  });
});

describe('human resolution', () => {
  const escalate = (): { id: string; a: string; b: string } => {
    const a = belief('a');
    const b = belief('b');
    const { id } = recordContradiction([{ kind: 'BELIEF', beliefId: a }, { kind: 'BELIEF', beliefId: b }]);
    return { id, a, b };
  };

  it('settles the contradiction, supersedes the losing belief and resolves the uncertainty together', () => {
    const { id, a, b } = escalate();
    const events = mind.run(HUMAN, {
      kind: 'RESOLVE_CONTRADICTION',
      contradictionId: id,
      governingSide: 1,
      reason: 'the v2 docs are current',
    }).map((e) => e.type);
    expect(events).toEqual(['CONTRADICTION_RESOLVED', 'BELIEF_SUPERSEDED_BY_AUTHORITY', 'UNCERTAINTY_STATUS_CHANGED']);

    const c = mind.state.contradictions[id];
    expect([c?.status, c?.governingSide, c?.resolution?.reason, c?.resolution?.by]).toEqual([
      'RESOLVED_BY_HUMAN',
      1,
      'the v2 docs are current',
      'dev',
    ]);
    expect(mind.state.beliefs[a]?.supersededBy).toEqual([id]);
    expect(mind.state.beliefs[b]?.supersededBy).toEqual([]);
    const u = mind.state.uncertainties[c?.uncertaintyId ?? ''];
    expect([u?.status, u?.resolutionEvidence]).toEqual(['RESOLVED', [id]]);
    expect(contradictionsInvolving(mind.state, a).map((x) => x.id)).toEqual([id]);
  });

  it('leaves an uncertainty a human already accepted as it is', () => {
    const { id } = escalate();
    const u = mind.state.contradictions[id]?.uncertaintyId ?? '';
    mind.run(HUMAN, { kind: 'ACCEPT_UNCERTAINTY', uncertaintyId: u, reason: 'both are fine for now' });
    const events = mind.run(HUMAN, { kind: 'RESOLVE_CONTRADICTION', contradictionId: id, governingSide: 0, reason: 'decided' });
    expect(events.map((e) => e.type)).toEqual(['CONTRADICTION_RESOLVED', 'BELIEF_SUPERSEDED_BY_AUTHORITY']);
    expect(mind.state.uncertainties[u]?.status).toBe('ACCEPTED');
  });

  it('resolves an external-only contradiction without touching any belief', () => {
    const { id } = recordContradiction([external('a', 'EVIDENCE'), external('b', 'EVIDENCE')]);
    const events = mind.run(HUMAN, { kind: 'RESOLVE_CONTRADICTION', contradictionId: id, governingSide: 0, reason: 'r' });
    expect(events.map((e) => e.type)).toEqual(['CONTRADICTION_RESOLVED', 'UNCERTAINTY_STATUS_CHANGED']);
  });

  it('refuses anyone but a human, a missing reason, or one that is not escalated', () => {
    const { id } = escalate();
    expectRefused(mind, 'HUMAN_ONLY', () =>
      mind.run(SYSTEM, { kind: 'RESOLVE_CONTRADICTION', contradictionId: id, governingSide: 0, reason: 'r' }),
    );
    expectRefused(mind, 'REASON_REQUIRED', () =>
      mind.run(HUMAN, { kind: 'RESOLVE_CONTRADICTION', contradictionId: id, governingSide: 0 }),
    );
    mind.run(HUMAN, { kind: 'RESOLVE_CONTRADICTION', contradictionId: id, governingSide: 0, reason: 'r' });
    expectRefused(mind, 'NOT_ESCALATED', () =>
      mind.run(HUMAN, { kind: 'RESOLVE_CONTRADICTION', contradictionId: id, governingSide: 1, reason: 'r' }),
    );
    expectRefused(mind, 'CONTRADICTION_NOT_FOUND', () =>
      mind.run(HUMAN, { kind: 'RESOLVE_CONTRADICTION', contradictionId: 'ctr-404', governingSide: 1, reason: 'r' }),
    );
  });
});

describe('recording rules', () => {
  it('refuses a claim contradicting itself', () => {
    const a = belief('a');
    expectRefused(mind, 'SAME_SIDE', () =>
      recordContradiction([{ kind: 'BELIEF', beliefId: a }, { kind: 'BELIEF', beliefId: a }]),
    );
  });

  it('refuses a side that names a missing belief', () => {
    expectRefused(mind, 'BELIEF_NOT_FOUND', () =>
      recordContradiction([{ kind: 'BELIEF', beliefId: 'bel-404' }, external('x', 'EVIDENCE')]),
    );
  });

  it('refuses recording the same pair twice, in either order', () => {
    recordContradiction([external('a', 'EVIDENCE'), external('b', 'HISTORICAL')]);
    expectRefused(mind, 'DUPLICATE_CONTRADICTION', () =>
      recordContradiction([external('b', 'HISTORICAL'), external('a', 'EVIDENCE')]),
    );
  });

  it('allows the same pair under a different kind of contradiction', () => {
    recordContradiction([external('a', 'EVIDENCE'), external('b', 'HISTORICAL')]);
    recordContradiction([external('a', 'EVIDENCE'), external('b', 'HISTORICAL')], SYSTEM, {
      contradictionKind: 'REQUIREMENT_TEST',
    });
    expect(Object.keys(mind.state.contradictions)).toHaveLength(2);
  });

  it('refuses an unknown contradiction kind', () => {
    expectRefused(mind, 'INVALID_COMMAND', () =>
      recordContradiction([external('a', 'EVIDENCE'), external('b', 'EVIDENCE')], SYSTEM, {
        contradictionKind: 'VIBES',
      }),
    );
  });

  it('works with evidence on a belief side (belief ↔ evidence)', () => {
    const b = belief('the cache is warm');
    mind.run(SYSTEM, {
      kind: 'ADD_BELIEF_EVIDENCE',
      beliefId: b,
      polarity: 'CONTRADICTING',
      evidence: evidence('cold-start', { kind: 'OBSERVATION' }),
    });
    const { id } = recordContradiction([{ kind: 'BELIEF', beliefId: b }, external('ev:cold-start', 'EVIDENCE')], SYSTEM, {
      contradictionKind: 'BELIEF_EVIDENCE',
    });
    // EVIDENCE outranks the belief's AI_ASSUMPTION, so the evidence governs.
    expect(mind.state.contradictions[id]?.governingSide).toBe(1);
    expect(mind.state.beliefs[b]?.supersededBy).toEqual([id]);
  });
});
