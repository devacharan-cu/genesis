/**
 * The S3 blob store against the identical suite the in-memory one passes.
 *
 * The client under it is the object-store model. ADR-0024 §3 states what a
 * model proves and what it does not; the same applies here.
 */

import { refFor } from '@genesis/blob';
import { newProjectId, projectScope, ValidationError } from '@genesis/core-types';
import { describeBlobStoreConformance } from '@genesis/testkit';
import { describe, expect, it } from 'vitest';
import {
  blobPrefix,
  modelBackedBlobStore,
  type ObjectStoreClient,
  ObjectStoreModel,
  S3BlobStore,
} from '../src/s3-blob.js';

describeBlobStoreConformance({
  name: 'S3BlobStore (object store model)',
  create: async () => modelBackedBlobStore(),
});

describe('the S3 adapter past the shared suite', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('refuses work once closed, and closes cleanly twice', async () => {
    const client = new ObjectStoreModel();
    const store = new S3BlobStore({ client, bucket: 'b' });
    const scope = projectScope(newProjectId());
    await store.close();
    await expect(store.put(scope, 'EVIDENCE', bytes('late'))).rejects.toThrow(ValidationError);
    await expect(store.close()).resolves.toBeUndefined();
    // The client belongs to the composition root, so closing the store leaves
    // it usable by the other adapters sharing it.
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('skips a listed key whose object disappeared between the list and the head', async () => {
    const client = new ObjectStoreModel();
    const store = new S3BlobStore({ client, bucket: 'b' });
    const scope = projectScope(newProjectId());
    const stored = await store.put(scope, 'EVIDENCE', bytes('present'));

    // A listing is a snapshot; an object can be gone by the time it is read.
    const vanishing: ObjectStoreClient = {
      putObject: (bucket, key, body, contentType) => client.putObject(bucket, key, body, contentType),
      getObject: (bucket, key) => client.getObject(bucket, key),
      headObject: (bucket, key) => client.headObject(bucket, key),
      listObjects: async (bucket, prefix) => [...(await client.listObjects(bucket, prefix)), `${prefix}deadbeef`],
      deleteObject: (bucket, key) => client.deleteObject(bucket, key),
      close: () => client.close(),
    };
    const listing = new S3BlobStore({ client: vanishing, bucket: 'b' });
    expect((await listing.list(scope, 'EVIDENCE')).map((b) => b.digest)).toEqual([stored.digest]);
  });

  it('corrupts the right object when the store holds several', async () => {
    const client = new ObjectStoreModel();
    const store = new S3BlobStore({ client, bucket: 'b' });
    const scope = projectScope(newProjectId());
    const first = await store.put(scope, 'EVIDENCE', bytes('the first'));
    const second = await store.put(scope, 'EVIDENCE', bytes('the second'));

    await client.unsafeCorrupt(scope.projectId, second, bytes('substituted'));
    expect(await store.verify(scope, first)).toBe(true);
    expect(await store.verify(scope, second)).toBe(false);
  });

  it('refuses to corrupt something that was never stored', async () => {
    const client = new ObjectStoreModel();
    const scope = projectScope(newProjectId());
    await expect(client.unsafeCorrupt(scope.projectId, refFor('EVIDENCE', bytes('absent')), bytes('x'))).rejects.toThrow(
      /nothing stored to corrupt/,
    );
  });

  it('files a blob under the project prefix, so a listing cannot span projects', () => {
    expect(blobPrefix('prj-1', 'EVIDENCE')).toBe('prj-1/EVIDENCE/');
  });
});
