/**
 * The SQLite adapter runs the identical conformance suite the in-memory
 * adapter runs — the same file, not a copy of it (ADR-0003).
 */

import { SqliteEventLedger } from '@genesis/adapters-sqlite';
import { describeLedgerConformance } from '@genesis/testkit';

describeLedgerConformance({
  name: 'SqliteEventLedger (in-memory database)',
  create: async () => new SqliteEventLedger({ location: ':memory:' }),
});
