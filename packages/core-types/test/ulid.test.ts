import { describe, expect, it } from 'vitest';
import {
  createUlidFactory,
  MAX_ULID_TIME,
  ULID_LENGTH,
  UlidError,
  ulidTime,
} from '@genesis/core-types';

const zeros = (): number[] => new Array(16).fill(0) as number[];
const maxed = (): number[] => new Array(16).fill(31) as number[];

describe('ulid', () => {
  it('produces ids of the documented length and alphabet', () => {
    const next = createUlidFactory();
    const value = next();
    expect(value).toHaveLength(ULID_LENGTH);
    expect(value).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it('excludes the ambiguous characters I, L, O and U', () => {
    const next = createUlidFactory();
    const sample = Array.from({ length: 200 }, () => next()).join('');
    expect(sample).not.toMatch(/[ILOU]/);
  });

  it('encodes the timestamp so ids sort by creation time', () => {
    let clock = 1_000;
    const next = createUlidFactory({ now: () => clock, random: zeros });
    const first = next();
    clock = 2_000;
    const second = next();
    expect(first < second).toBe(true);
    expect(ulidTime(first)).toBe(1_000);
    expect(ulidTime(second)).toBe(2_000);
  });

  it('stays monotonic within a single millisecond', () => {
    const next = createUlidFactory({ now: () => 5_000, random: zeros });
    const ids = Array.from({ length: 50 }, () => next());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stays monotonic when the clock goes backwards', () => {
    let clock = 10_000;
    const next = createUlidFactory({ now: () => clock, random: zeros });
    const before = next();
    clock = 9_000; // NTP correction, VM migration, etc.
    const after = next();
    expect(after > before).toBe(true);
    // The earlier timestamp is retained rather than a smaller id being emitted.
    expect(ulidTime(after)).toBe(10_000);
  });

  it('carries when incrementing randomness overflows a position', () => {
    const random = (): number[] => {
      const values = zeros();
      values[15] = 31;
      return values;
    };
    const next = createUlidFactory({ now: () => 1, random });
    const first = next();
    const second = next();
    expect(second > first).toBe(true);
  });

  it('refuses rather than wrapping when randomness is exhausted', () => {
    const next = createUlidFactory({ now: () => 1, random: maxed });
    next();
    expect(() => next()).toThrow(UlidError);
  });

  it('rejects a random source of the wrong width', () => {
    const next = createUlidFactory({ now: () => 1, random: () => [1, 2, 3] });
    expect(() => next()).toThrow(/must return 16 values/);
  });

  it('rejects a timestamp beyond the representable range', () => {
    const next = createUlidFactory({ now: () => MAX_ULID_TIME + 1, random: zeros });
    expect(() => next()).toThrow(/exceeds the maximum/);
  });

  it('rejects a negative or non-integer timestamp', () => {
    expect(() => createUlidFactory({ now: () => -1, random: zeros })()).toThrow(
      /non-negative integer/,
    );
    expect(() => createUlidFactory({ now: () => 1.5, random: zeros })()).toThrow(
      /non-negative integer/,
    );
  });

  it('round-trips the maximum representable time', () => {
    const next = createUlidFactory({ now: () => MAX_ULID_TIME, random: zeros });
    expect(ulidTime(next())).toBe(MAX_ULID_TIME);
  });

  describe('ulidTime', () => {
    it('rejects a value of the wrong length', () => {
      expect(() => ulidTime('TOOSHORT')).toThrow(/26-character/);
    });

    it('rejects a value containing a character outside the alphabet', () => {
      expect(() => ulidTime('I'.repeat(ULID_LENGTH))).toThrow(/invalid ULID character/);
    });
  });

  it('generates distinct ids from the default crypto source', () => {
    const next = createUlidFactory();
    const ids = new Set(Array.from({ length: 1_000 }, () => next()));
    expect(ids.size).toBe(1_000);
  });
});
