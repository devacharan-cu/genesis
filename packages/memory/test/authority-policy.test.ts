/**
 * Property tests for the write-time authority policy (ADR-0011).
 *
 * The policy is a pure function over a SMALL FINITE domain: 6 authority levels
 * × 3 actor kinds × 6 source kinds × {evidence, none} × {requirement, none}.
 * That is enumerable, so these tests enumerate it rather than sampling it —
 * exhaustive checking is strictly stronger than randomised property testing
 * when the domain is this size, and it cannot flake.
 *
 * The properties are stated over the whole domain. A counterexample anywhere
 * fails the suite and names the exact input.
 */

import {
  ACTOR_AUTHORITY_CEILING,
  type ActorKind,
  AUTHORITY_LEVELS,
  authorityRank,
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

interface Case extends AuthorityDecisionInput {
  readonly label: string;
}

/** Every combination of the policy's inputs. */
function everyCase(): Case[] {
  const cases: Case[] = [];
  for (const requested of AUTHORITY_LEVELS) {
    for (const actorKind of ACTOR_KINDS) {
      for (const sourceKind of SOURCE_KINDS) {
        for (const hasEvidence of [false, true]) {
          for (const hasRequirement of [false, true]) {
            cases.push({
              label: `${requested} by ${actorKind} from ${sourceKind}${hasEvidence ? ' +evidence' : ''}${hasRequirement ? ' +requirement' : ''}`,
              requested,
              actorKind,
              sourceRefs: [{ kind: sourceKind, id: 'src' }],
              evidenceRefs: hasEvidence ? [EVIDENCE_ID] : [],
              relatedEntities: hasRequirement
                ? [{ nodeType: 'REQUIREMENT', nodeId: NODE_ID }]
                : [],
            });
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
    // 6 authorities x 3 actors x 6 sources x 2 x 2
    expect(CASES.length).toBe(6 * 3 * 6 * 2 * 2);
  });

  it('NEVER returns an authority higher than requested', () => {
    for (const c of CASES) {
      const { authority } = decideAuthority(c);
      expect(neverPromotes(c.requested, authority), c.label).toBe(true);
    }
  });

  it('never exceeds the actor ceiling', () => {
    for (const c of CASES) {
      const { authority } = decideAuthority(c);
      const ceiling = ACTOR_AUTHORITY_CEILING[c.actorKind];
      expect(authorityRank(authority), c.label).toBeGreaterThanOrEqual(authorityRank(ceiling));
    }
  });

  it('ALWAYS lands a model-sourced claim at AI_ASSUMPTION', () => {
    // The guarantee: an agent cannot promote its own claims, whatever it asks
    // for, whichever actor it presents as, however much evidence it attaches.
    for (const c of CASES) {
      const modelSourced = c.sourceRefs.some((r) => r.kind === 'MODEL');
      if (!modelSourced) continue;
      const { authority } = decideAuthority(c);
      expect(authority, c.label).toBe('AI_ASSUMPTION');
    }
  });

  it('is idempotent: re-deciding an already-decided authority changes nothing', () => {
    for (const c of CASES) {
      const first = decideAuthority(c);
      const second = decideAuthority({ ...c, requested: first.authority });
      expect(second.authority, c.label).toBe(first.authority);
    }
  });

  /**
   * The policy is NOT monotone, and this test pins the counterexample rather
   * than asserting a property that does not hold.
   *
   * A SYSTEM actor with no evidence asking for HUMAN_DECISION is capped by the
   * actor ceiling to VERIFIED_SYSTEM_STATE, which then fails its grounding
   * check and falls to the AI_ASSUMPTION floor. The same actor asking for the
   * *lower* HISTORICAL — which needs no grounding — keeps it. So over-claiming
   * lands you below where asking modestly would have.
   *
   * This was found by an exhaustive property test asserting monotonicity, which
   * seemed obviously true when written. Three fixes were considered:
   *
   *   - Step down to the highest grounded level instead of the floor. Rejected:
   *     the next such level is HISTORICAL, which means "previously true, now
   *     superseded" — a specific claim, not a generic low-confidence bucket.
   *     Landing there would state something false about the record.
   *   - Check grounding against the REQUESTED level rather than the effective
   *     one. Rejected, and it is worse: a SYSTEM probe asking for
   *     HUMAN_DECISION would land at VERIFIED_SYSTEM_STATE with no evidence,
   *     which is exactly the claim the grounding rule exists to stop.
   *   - Add an UNGROUNDED level below HISTORICAL. This is the real fix, and it
   *     changes an enum the project brief fixed, so it needs a human decision:
   *     open decision E11 (ADR-0011).
   *
   * Until E11 is answered the behaviour stands as documented, so the test
   * records it. Note that the safety guarantee is unaffected: every clamp here
   * moves authority DOWN, never up.
   */
  it('is NOT monotone, and the known counterexample behaves as documented', () => {
    const shared = {
      actorKind: 'SYSTEM' as const,
      sourceRefs: [{ kind: 'HUMAN' as const, id: 'dev' }],
      evidenceRefs: [],
      relatedEntities: [],
    };

    const overClaimed = decideAuthority({ ...shared, requested: 'HUMAN_DECISION' });
    const modest = decideAuthority({ ...shared, requested: 'HISTORICAL' });

    expect(overClaimed.authority).toBe('AI_ASSUMPTION');
    expect(modest.authority).toBe('HISTORICAL');
    // Asking for more produced strictly less. Recorded, not asserted away.
    expect(authorityRank(overClaimed.authority)).toBeGreaterThan(authorityRank(modest.authority));
  });

  it('every clamp moves authority down, never up — across the whole domain', () => {
    // The weaker property that DOES hold, and the one safety depends on.
    for (const c of CASES) {
      const { authority } = decideAuthority(c);
      expect(authorityRank(authority), c.label).toBeGreaterThanOrEqual(
        authorityRank(c.requested),
      );
    }
  });

  it('records a clamp exactly when the authority changed', () => {
    for (const c of CASES) {
      const { authority, clamps } = decideAuthority(c);
      const changed = authority !== c.requested;
      expect(clamps.length > 0, c.label).toBe(changed);
    }
  });

  it('is deterministic', () => {
    for (const c of CASES) {
      expect(decideAuthority(c)).toEqual(decideAuthority(c));
    }
  });

  it('leaves AI_ASSUMPTION untouched in every configuration', () => {
    for (const c of CASES) {
      if (c.requested !== 'AI_ASSUMPTION') continue;
      const { authority, clamps } = decideAuthority(c);
      expect(authority, c.label).toBe('AI_ASSUMPTION');
      expect(clamps, c.label).toEqual([]);
    }
  });

  it('never grants EVIDENCE or above without supporting evidence', () => {
    for (const c of CASES) {
      if (c.evidenceRefs.length > 0) continue;
      const { authority } = decideAuthority(c);
      const grantsEvidence =
        authority === 'EVIDENCE' || authority === 'VERIFIED_SYSTEM_STATE';
      expect(grantsEvidence, c.label).toBe(false);
    }
  });

  it('never grants ACTIVE_REQUIREMENT without a linked requirement', () => {
    for (const c of CASES) {
      const hasRequirement = c.relatedEntities.some((e) => e.nodeType === 'REQUIREMENT');
      if (hasRequirement) continue;
      expect(decideAuthority(c).authority, c.label).not.toBe('ACTIVE_REQUIREMENT');
    }
  });

  it('only a HUMAN actor can reach HUMAN_DECISION', () => {
    for (const c of CASES) {
      const { authority } = decideAuthority(c);
      if (authority !== 'HUMAN_DECISION') continue;
      expect(c.actorKind, c.label).toBe('HUMAN');
    }
  });

  it('only a HUMAN or SYSTEM actor can reach VERIFIED_SYSTEM_STATE', () => {
    for (const c of CASES) {
      const { authority } = decideAuthority(c);
      if (authority !== 'VERIFIED_SYSTEM_STATE') continue;
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

  it('grants VERIFIED_SYSTEM_STATE to a system actor with evidence', () => {
    const decision = decideAuthority(
      base({
        requested: 'VERIFIED_SYSTEM_STATE',
        actorKind: 'SYSTEM',
        sourceRefs: [{ kind: 'TOOL', id: 'probe' }],
        evidenceRefs: [EVIDENCE_ID],
      }),
    );
    expect(decision.authority).toBe('VERIFIED_SYSTEM_STATE');
  });

  it('clamps HISTORICAL for nobody — it needs no grounding', () => {
    for (const actorKind of ACTOR_KINDS) {
      const decision = decideAuthority(
        base({ requested: 'HISTORICAL', actorKind, sourceRefs: [{ kind: 'FILE', id: 'f' }] }),
      );
      expect(decision.authority, actorKind).toBe('HISTORICAL');
    }
  });

  it('reports NO_EVIDENCE and NO_REQUIREMENT_LINK distinctly', () => {
    expect(
      decideAuthority(base({ requested: 'EVIDENCE', actorKind: 'SYSTEM', sourceRefs: [{ kind: 'TOOL', id: 't' }] }))
        .clamps,
    ).toContain('NO_EVIDENCE');
    expect(decideAuthority(base({ requested: 'ACTIVE_REQUIREMENT' })).clamps).toContain(
      'NO_REQUIREMENT_LINK',
    );
  });

  it('ignores non-REQUIREMENT related entities when gating ACTIVE_REQUIREMENT', () => {
    const decision = decideAuthority(
      base({
        requested: 'ACTIVE_REQUIREMENT',
        relatedEntities: [{ nodeType: 'COMPONENT', nodeId: NODE_ID }],
      }),
    );
    expect(decision.authority).toBe('AI_ASSUMPTION');
  });
});

describe('neverPromotes', () => {
  it('is true when the decision is equal or lower', () => {
    expect(neverPromotes('HUMAN_DECISION', 'HUMAN_DECISION')).toBe(true);
    expect(neverPromotes('HUMAN_DECISION', 'AI_ASSUMPTION')).toBe(true);
  });

  it('is false when the decision is higher — the failure it exists to catch', () => {
    expect(neverPromotes('AI_ASSUMPTION', 'HUMAN_DECISION')).toBe(false);
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
