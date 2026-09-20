/**
 * The BlobStore port (SPEC-05 §4, SPEC-07 §3.4, ADR-0026 §1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is where evidence lives. SPEC-05 §4
 * requires that an evidence record's raw bytes exist and that the stored hash
 * match them, and that *an evidence record whose raw artifact is absent is
 * rejected*. Everything the anti-fabrication rule rests on is the difference
 * between bytes that are here and bytes that are claimed.
 *
 * Note what is ABSENT: there is no `overwrite`, no `update`, no `move`. A put
 * whose key already holds different bytes is refused, not applied. Because the
 * key is the digest of the content, a differing put is either a caller bug or a
 * hash collision, and both should be loud rather than absorbed.
 *
 * There is a `delete`, unlike the ledger, because retention is a real
 * requirement (SPEC-07 §5) and a store that can never forget is a store that
 * cannot honour one. It is the one operation the evidence role is not granted
 * (ADR-0026 §3).
 *
 * Every method takes a `ProjectScope` first, so an unscoped read is not
 * expressible (ADR-0008).
 */

import type { ProjectScope, Sha256Hex } from '@genesis/core-types';

/** What a blob is filed under. The digest of its bytes, plus what it is. */
export const BLOB_KINDS = ['EVIDENCE', 'ARTIFACT', 'LOG'] as const;
export type BlobKind = (typeof BLOB_KINDS)[number];

export interface BlobRef {
  readonly kind: BlobKind;
  /** Lowercase hex sha-256 of the bytes. The key, not a checksum beside it. */
  readonly digest: Sha256Hex;
}

export interface BlobMetadata extends BlobRef {
  readonly projectId: string;
  readonly bytes: number;
  /** IANA media type, for a reader that has to render it. Never used to decide anything. */
  readonly contentType: string;
  readonly storedAt: string;
}

export interface PutBlobOptions {
  readonly contentType?: string | undefined;
  /** Injectable clock, for deterministic tests. */
  readonly now?: (() => Date) | undefined;
}

export interface BlobStore {
  /**
   * Stores bytes under the digest of those bytes.
   *
   * Idempotent for identical content: putting the same bytes twice is accepted
   * and returns the same reference. Putting different bytes under a digest that
   * is already taken throws — see the header.
   */
  put(scope: ProjectScope, kind: BlobKind, bytes: Uint8Array, options?: PutBlobOptions): Promise<BlobMetadata>;

  /** The bytes, or null when nothing is stored under that reference. */
  get(scope: ProjectScope, ref: BlobRef): Promise<Uint8Array | null>;

  /** What is known about a blob without reading it. */
  head(scope: ProjectScope, ref: BlobRef): Promise<BlobMetadata | null>;

  /**
   * True when the stored bytes are present AND hash to the reference's digest.
   *
   * Separate from `head` on purpose: presence and integrity are different
   * questions, and SPEC-05 §4 asks the second one. A caller that only checked
   * presence would accept a corrupted object.
   */
  verify(scope: ProjectScope, ref: BlobRef): Promise<boolean>;

  /** Every blob of a kind in the scoped project, by digest ascending. */
  list(scope: ProjectScope, kind: BlobKind): Promise<BlobMetadata[]>;

  /** Removes a blob. Returns false when there was nothing to remove. */
  delete(scope: ProjectScope, ref: BlobRef): Promise<boolean>;

  close(): Promise<void>;
}

/**
 * Test-only corruption hook.
 *
 * The conformance suite has to prove that `verify` actually detects corruption,
 * and the only way to do that is to corrupt something. Adapters implement it by
 * writing past their own put path.
 *
 * Deliberately a separate interface: production code holding a `BlobStore`
 * cannot reach this, because the type does not have it.
 */
export interface CorruptibleBlobStore {
  unsafeCorrupt(projectId: string, ref: BlobRef, bytes: Uint8Array): Promise<void>;
}
