/**
 * Record construction is safety-critical (SPEC-00 §8.1): it is the only path by
 * which a record acquires its effective authority.
 *
 * The conformance suite covers this through both adapters. These tests reach
 * the cases an adapter cannot produce — a broken authority policy, a bad id
 * source — and the injected clock that makes the output deterministic.
 */

import {
  type MemoryId,
  newProjectId,
  projectScope,
  ValidationError,
} from '@genesis/core-types';
import { buildRecord, type NewMemoryRecord, type WriteContext } from '@genesis/memory';
import { describe, expect, it } from 'vitest';

const scope = projectScope(newProjectId());

const FIXED_ID = 'mem_01ARZ3NDEKTSV4RRFFQ69G5FAV' as MemoryId;
const FIXED_TIME = '2026-09-18T06:20:00.000Z';

const ctx = (over: Partial<WriteContext> = {}): WriteContext => ({
  actorKind: 'HUMAN',
  actorId: 'dev',
  ...over,
});

const input = (over: Partial<NewMemoryRecord> = {}): NewMemoryRecord =>
  ({
    class: 'SEMANTIC',
    type: 'api-behaviour',
    content: { statement: 'slots do not overlap' },
    authorityRequested: 'HUMAN_DECISION',
    sourceRefs: [{ kind: 'HUMAN', id: 'dev' }],
    ...over,
  }) as NewMemoryRecord;

describe('buildRecord', () => {
  it('is deterministic with an injected clock and id source', () => {
    const fixed = ctx({ now: () => new Date(FIXED_TIME), newId: () => FIXED_ID });
    const a = buildRecord(scope, input(), fixed);
    const b = buildRecord(scope, input(), fixed);
    expect(a).toEqual(b);
    expect(a.id).toBe(FIXED_ID);
    expect(a.createdAt).toBe(FIXED_TIME);
  });

  it('uses the ambient clock and id source when none is injected', () => {
    const record = buildRecord(scope, input(), ctx());
    expect(record.id).toMatch(/^mem_/);
    expect(Number.isNaN(Date.parse(record.createdAt))).toBe(false);
  });

  it('makes version 1 its own logical root', () => {
    const record = buildRecord(scope, input(), ctx());
    expect(record.version).toBe(1);
    expect(record.logicalId).toBe(record.id);
    expect(record.previousVersion).toBeNull();
  });

  it('inherits the logical id and increments the version for a later version', () => {
    const v1 = buildRecord(scope, input(), ctx());
    const v2 = buildRecord(scope, input(), ctx(), {
      previous: { logicalId: v1.logicalId, id: v1.id, version: v1.version },
    });
    expect(v2.logicalId).toBe(v1.logicalId);
    expect(v2.version).toBe(2);
    expect(v2.previousVersion).toBe(v1.id);
  });

  it('defaults validFrom to the write time', () => {
    const record = buildRecord(
      scope,
      input(),
      ctx({ now: () => new Date(FIXED_TIME), newId: () => FIXED_ID }),
    );
    expect(record.validFrom).toBe(FIXED_TIME);
  });

  it('honours a supplied validFrom', () => {
    const record = buildRecord(
      scope,
      input({ validFrom: '2020-01-01T00:00:00.000Z' }),
      ctx(),
    );
    expect(record.validFrom).toBe('2020-01-01T00:00:00.000Z');
  });

  it('stamps the projectId from the scope', () => {
    expect(buildRecord(scope, input(), ctx()).projectId).toBe(scope.projectId);
  });

  it('starts every record ACTIVE with no status cause', () => {
    const record = buildRecord(scope, input(), ctx());
    expect(record.status).toBe('ACTIVE');
    expect(record.statusCause).toBeNull();
  });

  it('reports validation issues with their field paths', () => {
    try {
      buildRecord(scope, input({ sourceRefs: [] }), ctx());
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const issues = (error as ValidationError).details['issues'] as { path: string }[];
      expect(issues.some((i) => i.path.includes('sourceRefs'))).toBe(true);
    }
  });

  it('catches a malformed constructed record before it can be stored', () => {
    expect(() =>
      buildRecord(scope, input(), ctx({ newId: () => 'not-a-memory-id' as MemoryId })),
    ).toThrow(/constructed memory record failed its own schema/);
  });

  /**
   * The guard that matters. A policy bug that PROMOTED an authority would be
   * the single worst failure in the knowledge layer — an agent's assumption
   * silently becoming a human decision — and nothing downstream would notice.
   *
   * The real policy cannot do this, which is why the guard needs an injected
   * broken one to be exercised at all. An untested guard is decoration.
   */
  it('REFUSES a policy that promotes an authority', () => {
    const promotingPolicy = (): { authority: 'HUMAN_DECISION'; clamps: [] } => ({
      authority: 'HUMAN_DECISION',
      clamps: [],
    });

    expect(() =>
      buildRecord(scope, input({ authorityRequested: 'AI_ASSUMPTION' }), ctx('AGENT' as never), {
        policy: promotingPolicy as never,
      }),
    ).toThrow(/higher authority than was requested/);
  });

  it('accepts a policy that clamps, which is the normal case', () => {
    const clampingPolicy = (): { authority: 'AI_ASSUMPTION'; clamps: ['MODEL_SOURCED'] } => ({
      authority: 'AI_ASSUMPTION',
      clamps: ['MODEL_SOURCED'],
    });

    const record = buildRecord(scope, input(), ctx(), { policy: clampingPolicy as never });
    expect(record.authority).toBe('AI_ASSUMPTION');
    expect(record.authorityClamps).toEqual(['MODEL_SOURCED']);
  });

  it('carries the requested authority through even when it is not clamped', () => {
    const record = buildRecord(scope, input(), ctx());
    expect(record.authorityRequested).toBe('HUMAN_DECISION');
    expect(record.authority).toBe('HUMAN_DECISION');
    expect(record.authorityClamps).toEqual([]);
  });

  it('defaults the optional collections rather than leaving them undefined', () => {
    const record = buildRecord(scope, input(), ctx());
    expect(record.relatedEntities).toEqual([]);
    expect(record.evidenceRefs).toEqual([]);
    expect(record.tags).toEqual([]);
    expect(record.validUntil).toBeNull();
    expect(record.producedByCycle).toBeNull();
    expect(record.producedByAgent).toBeNull();
    expect(record.confidence).toBeNull();
  });
});
