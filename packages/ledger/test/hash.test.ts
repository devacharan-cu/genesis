/**
 * Canonical serialisation is safety-critical (SPEC-00 section 8.1).
 *
 * The property under test is determinism. If the same content can produce two
 * different strings, the chain fails verification for reasons unrelated to
 * tampering — and the first reaction to a verifier that cries wolf is to stop
 * believing it.
 */

import { ValidationError } from '@genesis/core-types';
import { canonicalJson, hashEvent, sha256Hex } from '@genesis/ledger';
import { describe, expect, it } from 'vitest';

describe('canonicalJson', () => {
  it('serialises primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(-1.5)).toBe('-1.5');
  });

  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('produces the same string regardless of insertion order', () => {
    const one = { alpha: 1, beta: { y: 2, x: 3 }, gamma: [1, 2] };
    const two = { gamma: [1, 2], beta: { x: 3, y: 2 }, alpha: 1 };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  it('sorts nested objects too', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('sorts by UTF-16 code unit, not by locale', () => {
    // Under a locale-aware collation 'a' can sort before 'B'. Code-unit order
    // puts uppercase first. Asserting the code-unit result pins the behaviour.
    expect(canonicalJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined properties, matching JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('turns undefined inside an array into null, matching JSON.stringify', () => {
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('escapes strings through JSON.stringify', () => {
    expect(canonicalJson('a"b\n')).toBe('"a\\"b\\n"');
    expect(canonicalJson({ 'key"with': 1 })).toBe('{"key\\"with":1}');
  });

  it('rejects NaN and Infinity rather than silently emitting null', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(ValidationError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalJson(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
  });

  it('rejects values with no stable JSON form', () => {
    expect(() => canonicalJson(undefined)).toThrow(/cannot be canonically serialised/);
    expect(() => canonicalJson(() => 1)).toThrow(/cannot be canonically serialised/);
    expect(() => canonicalJson(Symbol('x'))).toThrow(/cannot be canonically serialised/);
    expect(() => canonicalJson(1n)).toThrow(/cannot be canonically serialised/);
  });

  it('handles deeply nested structures', () => {
    const nested = { a: [{ c: 1, b: [{ e: 2, d: 3 }] }] };
    expect(canonicalJson(nested)).toBe('{"a":[{"b":[{"d":3,"e":2}],"c":1}]}');
  });

  it('serialises an empty object and array', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });
});

describe('sha256Hex', () => {
  it('produces a lowercase 64-character digest', () => {
    expect(sha256Hex('')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the known digest of the empty string', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is stable and differs for different inputs', () => {
    expect(sha256Hex('a')).toBe(sha256Hex('a'));
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });

  it('treats the input as UTF-8', () => {
    expect(sha256Hex('é')).not.toBe(sha256Hex('e'));
  });
});

describe('hashEvent', () => {
  const base = {
    id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    seq: 1,
    schemaVersion: 1,
    type: 'OBSERVATION_RECORDED',
    actor: { kind: 'SYSTEM', id: 'probe' },
    subject: null,
    before: null,
    after: null,
    cause: null,
    cycleId: null,
    authority: 'EVIDENCE',
    payload: null,
    timestamp: '2026-09-18T06:20:00.000Z',
    prevHash: null,
  } as unknown as Parameters<typeof hashEvent>[0];

  it('is deterministic', () => {
    expect(hashEvent(base)).toBe(hashEvent(base));
  });

  it('ignores property insertion order', () => {
    const reordered = Object.fromEntries(
      Object.entries(base as unknown as Record<string, unknown>).reverse(),
    ) as unknown as Parameters<typeof hashEvent>[0];
    expect(hashEvent(reordered)).toBe(hashEvent(base));
  });

  it('changes when any covered field changes', () => {
    const original = hashEvent(base);
    const fields = ['type', 'timestamp', 'authority', 'seq'] as const;
    for (const field of fields) {
      const mutated = { ...(base as unknown as Record<string, unknown>) };
      mutated[field] = field === 'seq' ? 99 : 'CHANGED';
      expect(hashEvent(mutated as unknown as Parameters<typeof hashEvent>[0]), field).not.toBe(
        original,
      );
    }
  });

  it('changes when prevHash changes — this is what chains the events', () => {
    const linked = { ...(base as unknown as Record<string, unknown>), prevHash: 'a'.repeat(64) };
    expect(hashEvent(linked as unknown as Parameters<typeof hashEvent>[0])).not.toBe(
      hashEvent(base),
    );
  });
});
