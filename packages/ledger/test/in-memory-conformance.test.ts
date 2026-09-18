/**
 * The in-memory adapter runs the identical conformance suite the SQLite
 * adapter runs. Two implementations passing one suite is what makes the suite a
 * test of the PORT rather than of one adapter (ADR-0003).
 */

import { InMemoryEventLedger } from '@genesis/ledger';
import { describeLedgerConformance } from '@genesis/testkit';

describeLedgerConformance({
  name: 'InMemoryEventLedger',
  create: async () => new InMemoryEventLedger(),
});
