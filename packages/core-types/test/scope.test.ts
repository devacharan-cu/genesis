/**
 * Project scoping is safety-critical (SPEC-00 section 8.1): 100% branch
 * coverage required. Every decision point below is exercised both ways.
 */

import { describe, expect, it } from 'vitest';
import {
  assertInScope,
  isInScope,
  newProjectId,
  projectScope,
  sameScope,
  ScopeMismatchError,
  ValidationError,
} from '@genesis/core-types';

describe('projectScope', () => {
  it('accepts a well-formed project id', () => {
    const id = newProjectId();
    expect(projectScope(id).projectId).toBe(id);
  });

  it('rejects a malformed project id', () => {
    expect(() => projectScope('not-an-id')).toThrow(ValidationError);
  });

  it('rejects an id with the wrong prefix', () => {
    expect(() => projectScope('evt_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toThrow(ValidationError);
  });

  it('reports the validation issues rather than just failing', () => {
    try {
      projectScope('nope');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe('VALIDATION_FAILED');
      expect((error as ValidationError).details['issues']).toBeDefined();
    }
  });

  it('returns a frozen scope so it cannot be repointed after construction', () => {
    const scope = projectScope(newProjectId());
    expect(Object.isFrozen(scope)).toBe(true);
  });
});

describe('assertInScope', () => {
  it('passes when the record belongs to the scoped project', () => {
    const id = newProjectId();
    expect(() => assertInScope(projectScope(id), id, 'event evt_x')).not.toThrow();
  });

  it('throws when the record belongs to another project', () => {
    const scope = projectScope(newProjectId());
    const other = newProjectId();
    expect(() => assertInScope(scope, other, 'event evt_x')).toThrow(ScopeMismatchError);
  });

  it('names both projects and the subject, so the error is diagnosable', () => {
    const mine = newProjectId();
    const theirs = newProjectId();
    try {
      assertInScope(projectScope(mine), theirs, 'memory mem_x');
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ScopeMismatchError;
      expect(err.code).toBe('SCOPE_MISMATCH');
      expect(err.message).toContain(mine);
      expect(err.message).toContain(theirs);
      expect(err.message).toContain('memory mem_x');
    }
  });

  it('is an error rather than a silent empty result (ADR-0008 rule 6)', () => {
    // An empty result would be indistinguishable from "no such record", which
    // is exactly how a scoping bug hides. This asserts the design choice.
    const scope = projectScope(newProjectId());
    expect(() => assertInScope(scope, newProjectId(), 'x')).toThrow();
  });
});

describe('isInScope', () => {
  it('is true for the same project', () => {
    const id = newProjectId();
    expect(isInScope(projectScope(id), id)).toBe(true);
  });

  it('is false for a different project', () => {
    expect(isInScope(projectScope(newProjectId()), newProjectId())).toBe(false);
  });
});

describe('sameScope', () => {
  it('is true for two scopes on the same project', () => {
    const id = newProjectId();
    expect(sameScope(projectScope(id), projectScope(id))).toBe(true);
  });

  it('is false for scopes on different projects', () => {
    expect(sameScope(projectScope(newProjectId()), projectScope(newProjectId()))).toBe(false);
  });
});
