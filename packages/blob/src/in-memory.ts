/**
 * In-memory BlobStore, and the shared rules every adapter applies (ADR-0026 §1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). The refusal rules live here rather than in
 * each adapter, so that "the same bytes are the same blob, different bytes
 * under one digest is an error" has exactly one definition. An adapter that
 * reimplemented it could drift, and the drift would show up as one backend
 * accepting evidence another rejected.
 */

import { assertInScope, type ProjectId, type ProjectScope, type Sha256Hex, ValidationError } from '@genesis/core-types';
import { createHash } from 'node:crypto';
import type {
  BlobKind,
  BlobMetadata,
  BlobRef,
  BlobStore,
  CorruptibleBlobStore,
  PutBlobOptions,
} from './port.js';

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** The digest of some bytes: the key a blob is filed under, not a checksum beside it. */
export const digestOf = (bytes: Uint8Array): Sha256Hex =>
  createHash('sha256').update(bytes).digest('hex') as Sha256Hex;

/** The reference bytes would be stored under. Pure, so a caller can compute it first. */
export const refFor = (kind: BlobKind, bytes: Uint8Array): BlobRef => ({ kind, digest: digestOf(bytes) });

/**
 * The storage key. Scoped and kind-partitioned, so a listing is a prefix and
 * project isolation is a property of the key rather than of a filter.
 */
export const blobKey = (projectId: string, ref: BlobRef): string => `${projectId}/${ref.kind}/${ref.digest}`;

/**
 * What a put must satisfy before anything is written.
 *
 * Returns the reference when the bytes may be stored, and throws when the
 * digest is already taken by different content. Shared by every adapter.
 */
export function checkPut(kind: BlobKind, bytes: Uint8Array, existing: Uint8Array | null): BlobRef {
  const ref = refFor(kind, bytes);
  if (existing === null) return ref;
  if (existing.length === bytes.length && Buffer.from(existing).equals(Buffer.from(bytes))) return ref;
  // Content addressing means this is either a collision or a caller writing
  // through a digest it did not compute. Both are worth stopping for.
  throw new ValidationError(`a different blob is already stored under ${ref.kind}/${ref.digest}`, {
    kind: ref.kind,
    digest: ref.digest,
    storedBytes: existing.length,
    incomingBytes: bytes.length,
  });
}

interface Stored {
  readonly metadata: BlobMetadata;
  bytes: Uint8Array;
}

export class InMemoryBlobStore implements BlobStore, CorruptibleBlobStore {
  readonly #blobs = new Map<string, Stored>();
  #closed = false;

  #assertOpen(): void {
    if (this.#closed) throw new ValidationError('the blob store is closed', {});
  }

  async put(
    scope: ProjectScope,
    kind: BlobKind,
    bytes: Uint8Array,
    options: PutBlobOptions = {},
  ): Promise<BlobMetadata> {
    this.#assertOpen();
    const candidate = refFor(kind, bytes);
    const existing = this.#blobs.get(blobKey(scope.projectId, candidate));
    const ref = checkPut(kind, bytes, existing?.bytes ?? null);
    // An identical re-put keeps the original record: the blob was already
    // stored, and rewriting its timestamp would rewrite when it was observed.
    if (existing !== undefined) return existing.metadata;

    const now = options.now ?? ((): Date => new Date());
    const metadata: BlobMetadata = {
      ...ref,
      projectId: scope.projectId,
      bytes: bytes.length,
      contentType: options.contentType ?? DEFAULT_CONTENT_TYPE,
      storedAt: now().toISOString(),
    };
    this.#blobs.set(blobKey(scope.projectId, ref), { metadata, bytes: Uint8Array.from(bytes) });
    return metadata;
  }

  async get(scope: ProjectScope, ref: BlobRef): Promise<Uint8Array | null> {
    this.#assertOpen();
    const stored = this.#blobs.get(blobKey(scope.projectId, ref));
    return stored === undefined ? null : Uint8Array.from(stored.bytes);
  }

  async head(scope: ProjectScope, ref: BlobRef): Promise<BlobMetadata | null> {
    this.#assertOpen();
    return this.#blobs.get(blobKey(scope.projectId, ref))?.metadata ?? null;
  }

  async verify(scope: ProjectScope, ref: BlobRef): Promise<boolean> {
    const bytes = await this.get(scope, ref);
    return bytes !== null && digestOf(bytes) === ref.digest;
  }

  async list(scope: ProjectScope, kind: BlobKind): Promise<BlobMetadata[]> {
    this.#assertOpen();
    return [...this.#blobs.values()]
      .filter((stored) => stored.metadata.projectId === scope.projectId && stored.metadata.kind === kind)
      .map((stored) => stored.metadata)
      .sort((a, b) => (a.digest < b.digest ? -1 : 1));
  }

  async delete(scope: ProjectScope, ref: BlobRef): Promise<boolean> {
    this.#assertOpen();
    return this.#blobs.delete(blobKey(scope.projectId, ref));
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  async unsafeCorrupt(projectId: string, ref: BlobRef, bytes: Uint8Array): Promise<void> {
    const stored = this.#blobs.get(blobKey(projectId, ref));
    if (stored === undefined) throw new ValidationError('nothing stored to corrupt', { digest: ref.digest });
    stored.bytes = Uint8Array.from(bytes);
  }
}

/**
 * Reads a blob a record points at, refusing what SPEC-05 §4 says to refuse:
 * bytes that are absent, and bytes that do not hash to the reference.
 *
 * Shared so that "evidence whose raw artifact is absent is rejected" is one
 * function every caller uses rather than a rule each remembers.
 */
export async function readEvidence(
  store: BlobStore,
  scope: ProjectScope,
  ref: BlobRef,
  projectIdOfRecord: ProjectId,
): Promise<Uint8Array> {
  assertInScope(scope, projectIdOfRecord, `evidence ${ref.digest}`);
  const bytes = await store.get(scope, ref);
  if (bytes === null) {
    throw new ValidationError(`evidence ${ref.kind}/${ref.digest} is not in the blob store`, { digest: ref.digest });
  }
  const actual = digestOf(bytes);
  if (actual !== ref.digest) {
    throw new ValidationError(`evidence ${ref.kind}/${ref.digest} does not hash to its reference`, {
      expected: ref.digest,
      actual,
    });
  }
  return bytes;
}
