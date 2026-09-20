import { describeBlobStoreConformance } from '@genesis/testkit';
import { InMemoryBlobStore } from '../src/in-memory.js';

describeBlobStoreConformance({
  name: 'InMemoryBlobStore',
  create: async () => new InMemoryBlobStore(),
});
