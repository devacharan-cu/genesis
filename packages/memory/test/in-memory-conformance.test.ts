import { InMemoryMemoryStore } from '@genesis/memory';
import { describeMemoryStoreConformance } from '@genesis/testkit';

describeMemoryStoreConformance({
  name: 'InMemoryMemoryStore',
  create: async () => new InMemoryMemoryStore(),
});
