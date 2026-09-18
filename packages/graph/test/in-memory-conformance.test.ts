import { InMemoryGraphStore } from '@genesis/graph';
import { describeGraphStoreConformance } from '@genesis/testkit';

describeGraphStoreConformance({
  name: 'InMemoryGraphStore',
  create: async () => new InMemoryGraphStore(),
});
