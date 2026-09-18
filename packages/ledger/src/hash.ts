/**
 * Canonical serialisation and event hashing (ADR-0009).
 *
 * SAFETY-CRITICAL (SPEC-00 section 8.1). If this is not deterministic, the
 * chain fails verification for reasons unrelated to tampering, and the first
 * response will be to stop trusting the verifier — which is worse than having
 * no verifier at all.
 *
 * The serialisation format is FIXED AND VERSIONED. Changing it invalidates
 * every historical hash, so a change means a new version number and a
 * verifier that selects the serialiser matching each event's schema version.
 */

import { createHash } from 'node:crypto';
import { type HashableEvent, type Sha256Hex, ValidationError } from '@genesis/core-types';

/**
 * Version of the canonical serialisation format, not of the event schema.
 * Bumping this requires keeping every previous serialiser for verification.
 */
export const CANONICAL_SERIALISATION_VERSION = 1;

/**
 * Deterministic JSON.
 *
 * Rules, all of which matter for reproducibility:
 *   - object keys sorted by UTF-16 code unit, NOT by locale. `localeCompare`
 *     varies by environment and would make hashes machine-dependent.
 *   - no insignificant whitespace
 *   - `undefined` properties omitted, matching JSON.stringify
 *   - `undefined` inside arrays becomes null, matching JSON.stringify
 *   - non-finite numbers rejected rather than silently becoming null
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';

  const type = typeof value;

  if (type === 'string') return JSON.stringify(value);

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError('non-finite numbers cannot be canonically serialised', { value });
    }
    return JSON.stringify(value);
  }

  if (type === 'boolean') return value === true ? 'true' : 'false';

  if (Array.isArray(value)) {
    const items = value.map((item) => (item === undefined ? 'null' : canonicalJson(item)));
    return `[${items.join(',')}]`;
  }

  if (type === 'object') {
    const record = value as Record<string, unknown>;
    // Array.prototype.sort's default comparator converts to string and compares
    // by UTF-16 code unit, which is exactly what is wanted. `localeCompare`
    // would NOT be — it varies by environment and would make hashes
    // machine-dependent.
    //
    // A hand-written comparator was used here originally, and its
    // "keys are equal" branch was unreachable, because object keys are unique.
    // An unreachable branch in a module that requires 100% branch coverage is a
    // signal the code is more complicated than the problem.
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${parts.join(',')}}`;
  }

  throw new ValidationError(`value of type ${type} cannot be canonically serialised`, { type });
}

export function sha256Hex(input: string): Sha256Hex {
  return createHash('sha256').update(input, 'utf8').digest('hex') as Sha256Hex;
}

/**
 * Computes an event's `payloadHash`.
 *
 * Covers every field except `payloadHash` itself, `prevHash` included — that
 * inclusion is what chains the events together (see HashableEvent).
 */
export function hashEvent(event: HashableEvent): Sha256Hex {
  return sha256Hex(canonicalJson(event));
}
