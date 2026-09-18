/**
 * ULID generation.
 *
 * Identifiers must sort lexicographically by creation time so that event ids
 * carry an ordering hint, and must be monotonic within a generator so two ids
 * created in the same millisecond do not collide or invert.
 *
 * Note carefully: ULID monotonicity is *per generator instance*. It is NOT a
 * total order across processes. That is precisely why the ledger assigns its
 * own per-project `seq` rather than relying on id ordering (ADR-0009).
 */

/** Crockford base32: excludes I, L, O and U to avoid transcription errors. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Largest timestamp representable in 10 Crockford characters: 2^48 - 1 ms. */
export const MAX_ULID_TIME = 281_474_976_710_655;
export const ULID_LENGTH = TIME_LEN + RANDOM_LEN;

export class UlidError extends Error {
  override readonly name = 'UlidError';
}

function charAt(index: number): string {
  const ch = ENCODING[index];
  if (ch === undefined) {
    // Unreachable while every caller keeps its index in 0..31, but an index
    // error here would silently corrupt ids, so it fails loudly instead.
    throw new UlidError(`character index out of range: ${index}`);
  }
  return ch;
}

/**
 * Validates a clock reading before any state is touched.
 *
 * Called first in `ulid()` so a bad clock produces the error that describes the
 * actual problem. An earlier version validated inside `encodeTime`, after the
 * monotonic bookkeeping had already run, and a negative time surfaced as
 * "randomness overflow" — an error about the wrong thing entirely.
 */
function assertValidTime(time: number): void {
  if (!Number.isInteger(time) || time < 0) {
    throw new UlidError(`time must be a non-negative integer, got ${time}`);
  }
  if (time > MAX_ULID_TIME) {
    throw new UlidError(`time ${time} exceeds the maximum ULID time ${MAX_ULID_TIME}`);
  }
}

function encodeTime(time: number): string {
  let out = '';
  let remaining = time;
  for (let i = 0; i < TIME_LEN; i++) {
    out = charAt(remaining % ENCODING_LEN) + out;
    remaining = Math.floor(remaining / ENCODING_LEN);
  }
  return out;
}

/**
 * Random source: returns RANDOM_LEN values in 0..31.
 *
 * Bytes are masked with 31 rather than reduced modulo 32. 256 is divisible by
 * 32, so masking is uniform; `% 32` on a non-power-of-two range would not be.
 */
export type RandomSource = () => number[];

const defaultRandom: RandomSource = () => {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b & 31);
};

function incrementRandom(values: number[]): number[] {
  const next = [...values];
  for (let i = next.length - 1; i >= 0; i--) {
    const current = next[i];
    if (current === undefined) {
      throw new UlidError('malformed randomness buffer');
    }
    if (current < ENCODING_LEN - 1) {
      next[i] = current + 1;
      return next;
    }
    next[i] = 0;
  }
  // 80 bits of randomness all at maximum within one millisecond. Practically
  // unreachable, but returning a wrapped value would break monotonicity, so
  // this refuses instead of quietly producing a smaller id.
  throw new UlidError('randomness overflow within a single millisecond');
}

export interface UlidFactoryOptions {
  /** Injectable clock. Defaults to Date.now. Present so tests are deterministic. */
  readonly now?: () => number;
  /** Injectable randomness. Defaults to crypto.getRandomValues. */
  readonly random?: RandomSource;
}

export type UlidFactory = () => string;

/**
 * Creates a monotonic ULID factory.
 *
 * Within one millisecond the randomness is incremented rather than regenerated,
 * so ids created in the same tick still sort in creation order.
 */
export function createUlidFactory(options: UlidFactoryOptions = {}): UlidFactory {
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? defaultRandom;

  // `null` rather than a sentinel number: -1 was a valid value a caller-supplied
  // clock could return, and it collided with "no previous id yet".
  let lastTime: number | null = null;
  let lastRandom: number[] = [];

  return function ulid(): string {
    const time = now();
    assertValidTime(time);

    if (lastTime === null || time > lastTime) {
      lastTime = time;
      lastRandom = random();
      if (lastRandom.length !== RANDOM_LEN) {
        throw new UlidError(
          `random source must return ${RANDOM_LEN} values, got ${lastRandom.length}`,
        );
      }
    } else {
      // Same millisecond, or the clock went backwards (NTP correction, VM
      // migration). Holding the previous timestamp and incrementing the
      // randomness keeps ids monotonic; emitting a smaller id would corrupt the
      // ordering guarantee that the rest of the system reads from these.
      lastRandom = incrementRandom(lastRandom);
    }
    return encodeTime(lastTime) + lastRandom.map(charAt).join('');
  };
}

/** Process-wide default factory. */
export const ulid: UlidFactory = createUlidFactory();

/** Decodes the timestamp out of a ULID. Used for diagnostics, never for ordering. */
export function ulidTime(value: string): number {
  if (value.length !== ULID_LENGTH) {
    throw new UlidError(`expected a ${ULID_LENGTH}-character ULID, got ${value.length}`);
  }
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const index = ENCODING.indexOf(value[i] as string);
    if (index === -1) {
      throw new UlidError(`invalid ULID character at position ${i}`);
    }
    time = time * ENCODING_LEN + index;
  }
  return time;
}
