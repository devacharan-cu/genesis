import { SqliteGraphStore } from '@genesis/adapters-sqlite';
import { describeGraphStoreConformance } from '@genesis/testkit';

describeGraphStoreConformance({
  name: 'SqliteGraphStore (in-memory database, recursive CTEs)',
  create: async () => new SqliteGraphStore({ location: ':memory:' }),
});
