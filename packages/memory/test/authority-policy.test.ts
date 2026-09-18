/**
 * Property tests for the write-time authority policy (ADR-0011, ADR-0012).
 *
 * The policy is a pure function over a SMALL FINITE domain: 7 authority levels
 * × 3 actor kinds × 6 source kinds × {evidence, none} × {requirement, none} ×
 * {validUntil, none}. That is enumerable, so these tests enumerate it rather
 * than sampling — exhaustive checking is strictly stronger than randomised
 * property testing at this size, and it cannot flake.
 *
 * A counterexample anywhere fails the suite and names the exact input.
 */

import {
  ACTOR_AUTHORITY_CEILING,
  type ActorKind,
  AUTHORITY_LEVELS,
  authorityRank,
  outranks,
} from '@genesis/core-types';
import {
  type AuthorityDecisionInput,
  decideAuthority,
  neverPromotes,
  SOURCE_KINDS,
  type SourceKind,
} from '@genesis/memory';
import { describe, expect, it } from 'vitest';

const ACTOR_KINDS: readonly ActorKind[] = ['HUMAN', 'SYSTEM', 'AGENT'];
const EVIDENCE_ID = 'mem_01ARZ3NDEKTSV4RRFFQ69G5FAV' as never;
const NODE_ID = 'node_01ARZ3NDEKTSV4RRFFQ69G5FAV' as never;
const END = '2020-06-01T00:00:00.000Z';

interface Case extends AuthorityDecisionInput {
  readonly label: string;
}

function everyCase(): Case[] {
  const cases: Case[] = [];
  for (const requested of AUTHORITY_LEVELS) {
    for (const actorKind of ACTOR_KINDS) {
      for (const sourceKind of SOURCE_KINDS) {
        for (const hasEvidence of [false, true]) {
          for (const hasRequirement of [false, true]) {
            for (const hasEnd of [false, true]) {
              cases.push({
                label: `${requested} by ${actorKind} from ${sourceKind}${hasEvidence ? ' +evidence' : ''}${hasRequirement ? ' +requirement' : ''}${hasEnd ? ' +validUntil' : ''}`,
                requested,
                actorKind,
                sourceRefs: [{ kind: sourceKind, id: 'src' }],
                evidenceRefs: hasEvidence ? [EVIDENCE_ID] : [],
                relatedEntities: hasRequirement
                  ? [{ nodeType: 'REQUIREMENT', nodeId: NODE_ID }]
                  : [],
                validUntil: hasEnd ? END : null,
              });
            }
          }
        }
      }
    }
  }
  return cases;
}

const CASES = everyCase();

describe('authority policy — exhaustive properties', () => {
  it('covers the whole input domain', () => {
    expect(CASES.length).toBe(7 * 3 * 6 * 2 * 2 * 2);
  });

  it('NEVER returns an authority higher than requested', () => {
    for (const c of CASES) {
      expect(neverPromotes(c.requested, decideAuthority(c).authority), c.label).toBe(true);
    }
  });

  it('never exceeds the actor ceiling', () => {
    for (const c of CASES) {
      const ceiling = ACTOR_AUTHORITY_CEILING[c.actorKind];
      expect(authorityRank(decideAuthority(c).authority), c.label).toBeGreaterThanOrEqual(
        authorityRank(ceiling),
      );
    }
  });

  it('ALWAYS lands a model-sourced claim at AI_ASSUMPTION', () => {
    // The guarantee: an agent cannot promote its own claims, whatever it asks
    // for, whichever actor it presents as, however much evidence it attaches.
    // It lands at AI_ASSUMPTION and not lower, because the model source is
    // exactly what grounds that level (ADR-0012).
    for (const c of CASES) {
      if (!c.sourceRefs.some((r) => r.kind === 'MODEL')) continue;
      // A caller that asked for UNGROUNDED gets it: the ceiling lowers, it
      // never raises, so model provenance cannot promote a claim either.
      const expected = c.requested === 'UNGROUNDED' ? 'UNGROUNDED' : 'AI_ASSUMPTION';
      expect(decideAuthority(c).authority, c.label).toBe(expected);
    }
  });

  /**
   * The property ADR-0012 was written to restore.
   *
   * Asserted across every pair of (case, lower request) in the domain — about
   * 4000 comparisons — rather than spot-checked.
   */
  it('is MONOTONE: asking for less never yields more', () => {
    for (const c of CASES) {
      for (const lowerRequest of AUTHORITY_LEVELS) {
        if (!outranks(c.requested, lowerRequest)) continue;
        const high = decideAuthority(c).authority;
        const low = decideAuthority({ ...c, requested: lowerRequest }).authority;
        expect(authorityRank(low), `${c.label} vs ${lowerRequest}`).toBeGreaterThanOrEqual(
          authorityRank(high),
        );
      }
    }
  });

  it('is idempotent: re-deciding an already-decided authority changes nothing', () => {
    for (const c of CASES) {
      const first = decideAuthority(c);
      const second = decideAuthority({ ...c, requested: first.authority });
      expect(second.authority, c.label).toBe(first.authority);
    }
  });

  it('always lands on a level whose grounding is actually satisfied', () => {
    for (const c of CASES) {
      const { authority } = decideAuthority(c);
      const hasEvidence = c.evidenceRefs.length > 0;
      const hasRequirement = c.relatedEntities.some((e) => e.nodeType === 'REQUIREMENT');
      const hasEnd = c.validUntil !== null && c.validUntil !== undefined;
      const hasModel = c.sourceRefs.some((r) => r.kind === 'MODEL');

      switch (authority) {
        case 'VERIFIED_SYSTEM_STATE':
        case 'EVIDENCE':
          expect(hasEvidence, c.label).toBe(true);
          break;
        case 'ACTIVE_REQUIREMENT':
          expect(hasRequirement, c.label).toBe(true);
          break;
        case 'HISTORICAL':
          expect(hasEnd, c.label).toBe(true);
          break;
        case 'AI_ASSUMPTION':
          expect(hasModel, c.label).toBe(true);
          break;
        case 'HUMAN_DECISION':
          expect(c.actorKind, c.label).toBe('HUMAN');
          break;
        case 'UNGROUNDED':
          break;
      }
    }
  });

  it('records a clamp exactly when the authority changed', () => {
    for (const c of CASES) {
      const { authority, clamps } = decideAuthority(c);
      expect(clamps.length > 0, c.label).toBe(authority !== c.requested);
    }
  });

  it('never records the same clamp reason twice', () => {
    for (const c of CASES) {
      const { clamps } = decideAuthority(c);
      expect(new Set(clamps).size, c.label).toBe(clamps.length);
    }
  });

  it('is deterministic', () => {
    for (const c of CASES) {
      expect(decideAuthority(c)).toEqual(decideAuthority(c));
    }
  });

  it('leaves UNGROUNDED untouched in every configuration — it is the floor', () => {
    for (const c of CASES) {
      if (c.requested !== 'UNGROUNDED') continue;
      const { authority, clamps } = decideAuthority(c);
      expect(authority, c.label).toBe('UNGROUNDED');
      expect(clamps, c.label).toEqual([]);
    }
  });

  it('only a HUMAN actor can reach HUMAN_DECISION', () => {
    for (const c of CASES) {
      if (decideAuthority(c).authority !== 'HUMAN_DECISION') continue;
      expect(c.actorKind, c.label).toBe('HUMAN');
    }
  });

  it('only a HUMAN or SYSTEM actor can reach VERIFIED_SYSTEM_STATE', () => {
    for (const c of CASES) {
      if (decideAuthority(c).authority !== 'VERIFIED_SYSTEM_STATE') continue;
      expect(['HUMAN', 'SYSTEM'], c.label).toContain(c.actorKind);
    }
  });
});

describe('authority policy — specific behaviours', () => {
  const base = (over: Partial<AuthorityDecisionInput> = {}): AuthorityDecisionInput => ({
    requested: 'HUMAN_DECISION',
    actorKind: 'HUMAN',
    sourceRefs: [{ kind: 'HUMAN', id: 'dev' }],
    evidenceRefs: [],
    relatedEntities: [],
    validUntil: null,
    ...over,
  });

  it('passes an honest human decision through untouched', () => {
    const decision = decideAuthority(base());
    expect(decision.authority).toBe('HUMAN_DECISION');
    expect(decision.clamps).toEqual([]);
  });

  it('applies the actor ceiling before model provenance', () => {
    const decision = decideAuthority(
      base({ actorKind: 'AGENT', sourceRefs: [{ kind: 'MODEL', id: 'm' }] }),
    );
    expect(decision.authority).toBe('AI_ASSUMPTION');
    expect(decision.clamps).toEqual(['ACTOR_CEILING', 'MODEL_SOURCED']);
  });

  it('detects a MODEL source among several sources', () => {
    const decision = decideAuthority(
      base({
        sourceRefs: [
          { kind: 'HUMAN', id: 'dev' },
          { kind: 'MODEL', id: 'claude' },
        ],
      }),
    );
    expect(decision.authority).toBe('AI_ASSUMPTION');
    expect(decision.clamps).toContain('MODEL_SOURCED');
  });

  it('grants EVIDENCE to a system actor with evidence attached', () => {
    const decision = decideAuthority(
      base({
        requested: 'EVIDENCE',
        actorKind: 'SYSTEM',
        sourceRefs: [{ kind: 'TOOL', id: 'runner' }],
        evidenceRefs: [EVIDENCE_ID],
      }),
    );
    expect(decision.authority).toBe('EVIDENCE');
    expect(decision.clamps).toEqual([]);
  });

  it('falls all the way to UNGROUNDED when nothing grounds the claim', () => {
    // A human asserting something with no evidence, no requirement link, no
    // end date and no model source. Previously this was mislabelled
    // AI_ASSUMPTION, which said something false about where it came from.
    const decision = decideAuthority(
      base({ requested: 'EVIDENCE', sourceRefs: [{ kind: 'HUMAN', id: 'dev' }] }),
    );
    expect(decision.authority).toBe('UNGROUNDED');
    expect(decision.clamps).toEqual(['NO_EVIDENCE', 'NO_HISTORICAL_BOUND', 'NO_MODEL_SOURCE']);
  });

  it('records every rung it fell past', () => {
    const decision = decideAuthority(
      base({ requested: 'VERIFIED_SYSTEM_STATE', actorKind: 'SYSTEM' }),
    );
    expect(decision.authority).toBe('UNGROUNDED');
    expect(decision.clamps).toContain('NO_EVIDENCE');
    expect(decision.clamps).toContain('NO_REQUIREMENT_LINK');
    expect(decision.clamps).toContain('NO_HISTORICAL_BOUND');
    expect(decision.clamps).toContain('NO_MODEL_SOURCE');
  });

  it('stops at HISTORICAL when the claim says when it stopped being current', () => {
    const decision = decideAuthority(
      base({ requested: 'EVIDENCE', validUntil: END }),
    );
    expect(decision.authority).toBe('HISTORICAL');
    expect(decision.clamps).toEqual(['NO_EVIDENCE']);
  });

  it('grants HISTORICAL directly when it is grounded', () => {
    const decision = decideAuthority(base({ requested: 'HISTORICAL', validUntil: END }));
    expect(decision.authority).toBe('HISTORICAL');
    expect(decision.clamps).toEqual([]);
  });

  it('refuses HISTORICAL with no end date — it asserts something specific', () => {
    const decision = decideAuthority(base({ requested: 'HISTORICAL' }));
    expect(decision.authority).toBe('UNGROUNDED');
    expect(decision.clamps).toContain('NO_HISTORICAL_BOUND');
  });

  it('refuses AI_ASSUMPTION with no model source', () => {
    const decision = decideAuthority(base({ requested: 'AI_ASSUMPTION' }));
    expect(decision.authority).toBe('UNGROUNDED');
    expect(decision.clamps).toEqual(['NO_MODEL_SOURCE']);
  });

  it('grants AI_ASSUMPTION when a model produced it', () => {
    const decision = decideAuthority(
      base({ requested: 'AI_ASSUMPTION', sourceRefs: [{ kind: 'MODEL', id: 'claude' }] }),
    );
    expect(decision.authority).toBe('AI_ASSUMPTION');
    expect(decision.clamps).toEqual([]);
  });

  it('ignores non-REQUIREMENT related entities when grounding ACTIVE_REQUIREMENT', () => {
    const decision = decideAuthority(
      base({
        requested: 'ACTIVE_REQUIREMENT',
        relatedEntities: [{ nodeType: 'COMPONENT', nodeId: NODE_ID }],
      }),
    );
    expect(decision.authority).toBe('UNGROUNDED');
  });

  /** The concrete case ADR-0012 was written to fix. */
  it('the former non-monotonicity counterexample is now monotone', () => {
    const shared = {
      actorKind: 'SYSTEM' as const,
      sourceRefs: [{ kind: 'HUMAN' as const, id: 'dev' }],
      evidenceRefs: [],
      relatedEntities: [],
      validUntil: null,
    };
    const overClaimed = decideAuthority({ ...shared, requested: 'HUMAN_DECISION' });
    const modest = decideAuthority({ ...shared, requested: 'HISTORICAL' });

    expect(overClaimed.authority).toBe('UNGROUNDED');
    expect(modest.authority).toBe('UNGROUNDED');
    expect(authorityRank(overClaimed.authority)).toBe(authorityRank(modest.authority));
  });
});

describe('neverPromotes', () => {
  it('is false when the decision is higher — the failure it exists to catch', () => {
    expect(neverPromotes('UNGROUNDED', 'HUMAN_DECISION')).toBe(false);
  });

  it('holds across every ordered pair', () => {
    for (const a of AUTHORITY_LEVELS) {
      for (const b of AUTHORITY_LEVELS) {
        expect(neverPromotes(a, b)).toBe(authorityRank(b) >= authorityRank(a));
      }
    }
  });
});

describe('source kinds', () => {
  it('MODEL is one of the declared source kinds', () => {
    const kinds: readonly SourceKind[] = SOURCE_KINDS;
    expect(kinds).toContain('MODEL');
  });
});
