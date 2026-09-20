/**
 * The S3 BlobStore adapter (SPEC-07 §3.4, ADR-0026 §1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). Evidence lives here, and SPEC-05 §4's
 * anti-fabrication rule is only as good as the bytes actually being present and
 * actually hashing to what the record claims.
 *
 * The key IS the digest, so content addressing is the storage layout rather
 * than a convention: `<projectId>/<kind>/<sha256>`. Project isolation is a
 * prefix, so a listing cannot accidentally span projects, and an object cannot
 * be filed under a digest it does not hash to without someone writing past this
 * adapter.
 *
 * The refusal rules are NOT reimplemented here. `checkPut` from @genesis/blob
 * decides whether a differing put is allowed, so every adapter refuses the same
 * thing (ADR-0026 §1).
 *
 * Like the DynamoDB adapters, this depends on an operation set rather than on
 * the SDK, so the conformance suite can run it without a cloud.
 */

import {
  type BlobKind,
  type BlobMetadata,
  type BlobRef,
  type BlobStore,
  blobKey,
  checkPut,
  type CorruptibleBlobStore,
  DEFAULT_CONTENT_TYPE,
  digestOf,
  type PutBlobOptions,
  refFor,
} from '@genesis/blob';
import { type ProjectScope, ValidationError } from '@genesis/core-types';

/** The S3 operations this adapter issues, and no others. */
export interface ObjectStoreClient {
  putObject(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void>;
  getObject(bucket: string, key: string): Promise<Uint8Array | null>;
  headObject(bucket: string, key: string): Promise<{ bytes: number; contentType: string; storedAt: string } | null>;
  listObjects(bucket: string, prefix: string): Promise<readonly string[]>;
  deleteObject(bucket: string, key: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface S3BlobStoreOptions {
  readonly client: ObjectStoreClient;
  readonly bucket: string;
}

/** The prefix a project's blobs of one kind live under. Isolation is the key. */
export const blobPrefix = (projectId: string, kind: BlobKind): string => `${projectId}/${kind}/`;

export class S3BlobStore implements BlobStore {
  #closed = false;

  constructor(private readonly options: S3BlobStoreOptions) {}

  #assertOpen(): void {
    if (this.#closed) throw new ValidationError('the blob store is closed', {});
  }

  async put(scope: ProjectScope, kind: BlobKind, bytes: Uint8Array, options: PutBlobOptions = {}): Promise<BlobMetadata> {
    this.#assertOpen();
    const candidate = refFor(kind, bytes);
    const key = blobKey(scope.projectId, candidate);
    const existing = await this.options.client.getObject(this.options.bucket, key);
    const ref = checkPut(kind, bytes, existing);

    const head = existing === null ? null : await this.options.client.headObject(this.options.bucket, key);
    if (head !== null) {
      // An identical re-put keeps the original record: the blob was already
      // stored, and rewriting its timestamp would rewrite when it was observed.
      return { ...ref, projectId: scope.projectId, bytes: head.bytes, contentType: head.contentType, storedAt: head.storedAt };
    }

    const contentType = options.contentType ?? DEFAULT_CONTENT_TYPE;
    const now = options.now ?? ((): Date => new Date());
    const storedAt = now().toISOString();
    await this.options.client.putObject(this.options.bucket, key, bytes, contentType);
    return { ...ref, projectId: scope.projectId, bytes: bytes.length, contentType, storedAt };
  }

  async get(scope: ProjectScope, ref: BlobRef): Promise<Uint8Array | null> {
    this.#assertOpen();
    return this.options.client.getObject(this.options.bucket, blobKey(scope.projectId, ref));
  }

  async head(scope: ProjectScope, ref: BlobRef): Promise<BlobMetadata | null> {
    this.#assertOpen();
    const head = await this.options.client.headObject(this.options.bucket, blobKey(scope.projectId, ref));
    return head === null ? null : { ...ref, projectId: scope.projectId, ...head };
  }

  async verify(scope: ProjectScope, ref: BlobRef): Promise<boolean> {
    // Reads the bytes rather than trusting the stored length or an ETag: the
    // question SPEC-05 §4 asks is whether these bytes hash to this reference,
    // and only hashing them answers it.
    const bytes = await this.get(scope, ref);
    return bytes !== null && digestOf(bytes) === ref.digest;
  }

  async list(scope: ProjectScope, kind: BlobKind): Promise<BlobMetadata[]> {
    this.#assertOpen();
    const keys = await this.options.client.listObjects(this.options.bucket, blobPrefix(scope.projectId, kind));
    const found: BlobMetadata[] = [];
    for (const key of [...keys].sort()) {
      const head = await this.options.client.headObject(this.options.bucket, key);
      if (head === null) continue;
      const digest = key.slice(key.lastIndexOf('/') + 1);
      found.push({ kind, digest: digest as BlobRef['digest'], projectId: scope.projectId, ...head });
    }
    return found;
  }

  async delete(scope: ProjectScope, ref: BlobRef): Promise<boolean> {
    this.#assertOpen();
    return this.options.client.deleteObject(this.options.bucket, blobKey(scope.projectId, ref));
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

/**
 * An in-process object store with S3's semantics, for the conformance suite
 * (ADR-0024 §3, applied to S3).
 *
 * What it models: keys, prefixes, byte-exact bodies, absent objects, and
 * deletion reporting whether anything was there. What it does not: versioning,
 * object lock, eventual consistency on a listing, multipart, or the service's
 * error taxonomy. The same caveat as the DynamoDB model, for the same reason.
 */
export class ObjectStoreModel implements ObjectStoreClient, CorruptibleBlobStore {
  readonly #objects = new Map<string, { bytes: Uint8Array; contentType: string; storedAt: string }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async putObject(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.#objects.set(`${bucket}/${key}`, {
      bytes: Uint8Array.from(body),
      contentType,
      storedAt: this.now().toISOString(),
    });
  }

  async getObject(bucket: string, key: string): Promise<Uint8Array | null> {
    const found = this.#objects.get(`${bucket}/${key}`);
    return found === undefined ? null : Uint8Array.from(found.bytes);
  }

  async headObject(bucket: string, key: string): Promise<{ bytes: number; contentType: string; storedAt: string } | null> {
    const found = this.#objects.get(`${bucket}/${key}`);
    return found === undefined ? null : { bytes: found.bytes.length, contentType: found.contentType, storedAt: found.storedAt };
  }

  async listObjects(bucket: string, prefix: string): Promise<readonly string[]> {
    const full = `${bucket}/${prefix}`;
    return [...this.#objects.keys()].filter((key) => key.startsWith(full)).map((key) => key.slice(bucket.length + 1));
  }

  async deleteObject(bucket: string, key: string): Promise<boolean> {
    return this.#objects.delete(`${bucket}/${key}`);
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  /** Writes past the put path, so a test can prove `verify` detects corruption. */
  async unsafeCorrupt(projectId: string, ref: BlobRef, bytes: Uint8Array): Promise<void> {
    for (const [key, stored] of this.#objects) {
      if (!key.endsWith(blobKey(projectId, ref))) continue;
      stored.bytes = Uint8Array.from(bytes);
      return;
    }
    throw new ValidationError('nothing stored to corrupt', { digest: ref.digest });
  }
}

/** An `S3BlobStore` over the model, with the corruption hook the suite needs. */
export const modelBackedBlobStore = (bucket = 'genesis-test'): BlobStore & CorruptibleBlobStore => {
  const client = new ObjectStoreModel();
  const store = new S3BlobStore({ client, bucket });
  return Object.assign(store, {
    unsafeCorrupt: (projectId: string, ref: BlobRef, bytes: Uint8Array) => client.unsafeCorrupt(projectId, ref, bytes),
  });
};
