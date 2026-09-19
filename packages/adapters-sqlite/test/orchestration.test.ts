/**
 * The orchestrator on SQLite: ledger, graph and memory all SQLite, running the
 * identical end-to-end suite the in-memory stores run (ADR-0003, ADR-0018).
 * Includes the rebuild law: a replayed state mirrored into an empty SQLite
 * graph matches the graph mirrored run by run.
 */

import { SqliteEventLedger, SqliteGraphStore, SqliteMemoryStore } from '@genesis/adapters-sqlite';
import { describeOrchestrationConformance } from '@genesis/testkit';

describeOrchestrationConformance({
  name: 'SQLite stores',
  createStores: () =>
    Promise.resolve({
      ledger: new SqliteEventLedger({ location: ':memory:' }),
      graph: new SqliteGraphStore({ location: ':memory:' }),
      memory: new SqliteMemoryStore({ location: ':memory:' }),
    }),
});
