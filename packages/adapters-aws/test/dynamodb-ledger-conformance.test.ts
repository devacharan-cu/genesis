/**
 * The DynamoDB ledger against the identical suite SQLite passes (ADR-0024 §3).
 *
 * The client under it is the semantics model, which evaluates condition
 * expressions and applies transactions atomically. ADR-0024 §3 states what that
 * proves and what it does not.
 */

import { describeLedgerConformance } from '@genesis/testkit';
import { DynamoEventLedger } from '../src/dynamodb/ledger.js';
import { DynamoDbModel } from '../src/dynamodb/model.js';
import { GENESIS_TABLE_SCHEMA } from '../src/dynamodb/schema.js';

describeLedgerConformance({
  name: 'DynamoEventLedger (semantics model)',
  create: async () =>
    new DynamoEventLedger({ client: new DynamoDbModel(GENESIS_TABLE_SCHEMA), table: 'genesis-test' }),
});
