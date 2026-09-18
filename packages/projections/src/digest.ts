/**
 * Projection digests (ADR-0013 rule 3).
 *
 * SAFETY-CRITICAL (SPEC-00 section 8.1). This is the whole mechanism by which
 * "the replayed state equals the live state" is a checked fact rather than an
 * assertion in a document. If it is wrong in the permissive direction, two
 * different states compare equal and a divergence goes unnoticed — which is
 * worse than having no equivalence check, because the check would be cited as
 * evidence.
 *
 * Why a digest rather than a deep comparison: a deep comparison treats
 * `{a:1,b:2}` and `{b:2,a:1}` as equal. They ARE equal as values, but they
 * serialise differently unless the serialiser sorts keys, and what gets
 * persisted and compared later is the serialisation. Hashing the canonical
 * form compares the thing that actually matters.
 *
 * The serialiser is the ledger's (ADR-0009), deliberately. Two definitions of
 * "the same value" in one system eventually disagree.
 */

import {
  JsonValue,
  type ProjectId,
  type Sha256Hex,
  ValidationError,
} from '@genesis/core-types';
import { canonicalJson, sha256Hex } from '@genesis/ledger';
import { type ProjectionState } from './projector.js';

/**
 * Asserts that a value is plain JSON, and returns it narrowed.
 *
 * `canonicalJson` alone is not enough. It throws on a function or a symbol, but
 * a `Date` and a `Map` are both `typeof 'object'` with no own enumerable keys,
 * so both serialise to `{}` — silently, which is the failure mode this whole
 * package exists to prevent. The schema check catches them.
 */
export function assertJsonState(value: unknown, subject: string): JsonValue {
  const parsed = JsonValue.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`${subject} is not canonically serialisable`, {
      subject,
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
}

/** The fields a digest covers. Exported so the shape is documented, not guessed. */
export interface DigestedProjection {
  readonly projection: string;
  readonly version: number;
  readonly projectId: ProjectId;
  readonly lastSeq: number;
  readonly state: JsonValue;
}

/**
 * sha-256 over the canonical form of the projection's identity and state.
 *
 * `projectId` is covered so that two projects cannot produce the same digest
 * from the same events — which would make a cross-project mix-up invisible to
 * the very check meant to catch it (ADR-0008).
 */
export function projectionDigest<S extends JsonValue>(p: ProjectionState<S>): Sha256Hex {
  const digested: DigestedProjection = {
    projection: p.projection,
    version: p.version,
    projectId: p.projectId,
    lastSeq: p.lastSeq,
    state: assertJsonState(p.state, `projection ${p.projection} state`),
  };
  return sha256Hex(canonicalJson(digested));
}

/**
 * True when two projections are the same state at the same point in history.
 *
 * Takes digests rather than states so a caller cannot accidentally compare by
 * reference and get `true` for two aliases of one object.
 */
export function projectionsEqual<A extends JsonValue, B extends JsonValue>(
  a: ProjectionState<A>,
  b: ProjectionState<B>,
): boolean {
  return projectionDigest(a) === projectionDigest(b);
}
