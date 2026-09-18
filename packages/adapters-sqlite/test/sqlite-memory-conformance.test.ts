import { SqliteMemoryStore } from '@genesis/adapters-sqlite';
import { describeMemoryStoreConformance } from '@genesis/testkit';

describeMemoryStoreConformance({
  name: 'SqliteMemoryStore (in-memory database)',
  create: async () => new SqliteMemoryStore({ location: ':memory:' }),
});
