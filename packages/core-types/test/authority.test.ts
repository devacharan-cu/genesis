/**
 * Authority is safety-critical (SPEC-00 section 8.1): 100% branch coverage.
 *
 * The property these tests actually defend is ADR-0005: a fluent AI assumption
 * must never outrank a human's stated requirement, and equal authority must
 * never be broken by a tiebreak.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTOR_AUTHORITY_CEILING,
  assertAuthorityPermitted,
  AUTHORITY_LEVELS,
  AuthorityNotPermittedError,
  authorityRank,
  clampAuthority,
  compareAuthority,
  isAuthorityPermitted,
  outranks,
  resolveConflict,
  type Authority,
} from '@genesis/core-types';

describe('authorityRank', () => {
  it('ranks HUMAN_DECISION highest and AI_ASSUMPTION lowest', () => {
    expect(authorityRank('HUMAN_DECISION')).toBe(1);
    expect(authorityRank('AI_ASSUMPTION')).toBe(AUTHORITY_LEVELS.length);
  });

  it('assigns a distinct rank to every level', () => {
    const ranks = AUTHORITY_LEVELS.map(authorityRank);
    expect(new Set(ranks).size).toBe(AUTHORITY_LEVELS.length);
  });

  it('follows the order declared in the specification', () => {
    const sorted = [...AUTHORITY_LEVELS].sort((a, b) => authorityRank(a) - authorityRank(b));
    expect(sorted).toEqual([...AUTHORITY_LEVELS]);
  });
});

describe('compareAuthority and outranks', () => {
  it('a human decision outranks an AI assumption', () => {
    expect(outranks('HUMAN_DECISION', 'AI_ASSUMPTION')).toBe(true);
    expect(compareAuthority('HUMAN_DECISION', 'AI_ASSUMPTION')).toBeLessThan(0);
  });

  it('an AI assumption does not outrank anything above it', () => {
    for (const level of AUTHORITY_LEVELS) {
      if (level === 'AI_ASSUMPTION') continue;
      expect(outranks('AI_ASSUMPTION', level)).toBe(false);
    }
  });

  it('nothing outranks itself', () => {
    for (const level of AUTHORITY_LEVELS) {
      expect(outranks(level, level)).toBe(false);
      expect(compareAuthority(level, level)).toBe(0);
    }
  });
});

describe('resolveConflict', () => {
  it('returns the governing authority when one side is higher', () => {
    expect(resolveConflict('AI_ASSUMPTION', 'HUMAN_DECISION')).toBe('HUMAN_DECISION');
    expect(resolveConflict('EVIDENCE', 'HISTORICAL')).toBe('EVIDENCE');
  });

  it('returns null on equal authority — ties are NOT broken (ADR-0005 rule 5)', () => {
    for (const level of AUTHORITY_LEVELS) {
      expect(resolveConflict(level, level)).toBeNull();
    }
  });

  it('is symmetric in outcome', () => {
    for (const a of AUTHORITY_LEVELS) {
      for (const b of AUTHORITY_LEVELS) {
        expect(resolveConflict(a, b)).toBe(resolveConflict(b, a));
      }
    }
  });
});

describe('actor ceilings', () => {
  it('an agent may not assert a human decision', () => {
    expect(isAuthorityPermitted('AGENT', 'HUMAN_DECISION')).toBe(false);
  });

  it('an agent may not assert verified system state or an active requirement', () => {
    expect(isAuthorityPermitted('AGENT', 'VERIFIED_SYSTEM_STATE')).toBe(false);
    expect(isAuthorityPermitted('AGENT', 'ACTIVE_REQUIREMENT')).toBe(false);
  });

  it('an agent may carry evidence and anything below it', () => {
    expect(isAuthorityPermitted('AGENT', 'EVIDENCE')).toBe(true);
    expect(isAuthorityPermitted('AGENT', 'HISTORICAL')).toBe(true);
    expect(isAuthorityPermitted('AGENT', 'AI_ASSUMPTION')).toBe(true);
  });

  it('the system may report observed state but not make a decision', () => {
    expect(isAuthorityPermitted('SYSTEM', 'VERIFIED_SYSTEM_STATE')).toBe(true);
    expect(isAuthorityPermitted('SYSTEM', 'HUMAN_DECISION')).toBe(false);
  });

  it('a human may assert every level', () => {
    for (const level of AUTHORITY_LEVELS) {
      expect(isAuthorityPermitted('HUMAN', level)).toBe(true);
    }
  });
});

describe('clampAuthority', () => {
  it('reduces an over-reaching claim to the actor ceiling', () => {
    expect(clampAuthority('AGENT', 'HUMAN_DECISION')).toBe('EVIDENCE');
    expect(clampAuthority('SYSTEM', 'HUMAN_DECISION')).toBe('VERIFIED_SYSTEM_STATE');
  });

  it('leaves a permitted claim untouched', () => {
    expect(clampAuthority('AGENT', 'AI_ASSUMPTION')).toBe('AI_ASSUMPTION');
    expect(clampAuthority('HUMAN', 'HUMAN_DECISION')).toBe('HUMAN_DECISION');
  });

  it('never returns something above the actor ceiling, for any input', () => {
    const kinds = Object.keys(ACTOR_AUTHORITY_CEILING) as (keyof typeof ACTOR_AUTHORITY_CEILING)[];
    for (const kind of kinds) {
      for (const level of AUTHORITY_LEVELS) {
        const clamped: Authority = clampAuthority(kind, level);
        expect(authorityRank(clamped)).toBeGreaterThanOrEqual(
          authorityRank(ACTOR_AUTHORITY_CEILING[kind]),
        );
      }
    }
  });
});

describe('assertAuthorityPermitted', () => {
  it('passes for a permitted combination', () => {
    expect(() => assertAuthorityPermitted('AGENT', 'EVIDENCE')).not.toThrow();
  });

  it('throws for an over-reaching combination', () => {
    expect(() => assertAuthorityPermitted('AGENT', 'HUMAN_DECISION')).toThrow(
      AuthorityNotPermittedError,
    );
  });

  it('names the actor kind, the authority and the ceiling', () => {
    try {
      assertAuthorityPermitted('AGENT', 'VERIFIED_SYSTEM_STATE');
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as AuthorityNotPermittedError;
      expect(err.code).toBe('AUTHORITY_NOT_PERMITTED');
      expect(err.message).toContain('AGENT');
      expect(err.message).toContain('VERIFIED_SYSTEM_STATE');
      expect(err.message).toContain('EVIDENCE');
    }
  });
});
