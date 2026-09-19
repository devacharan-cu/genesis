/**
 * The cognitive engine on the SQLite ledger: the identical suite the in-memory
 * ledger runs, so the four cognitive primitives are shown to behave the same on
 * either store (ADR-0003, ADR-0014).
 */

import { SqliteEventLedger } from '@genesis/adapters-sqlite';
import { describeCognitionConformance } from '@genesis/testkit';

describeCognitionConformance({
  name: 'SqliteEventLedger',
  createLedger: () => Promise.resolve(new SqliteEventLedger({ location: ':memory:' })),
});
