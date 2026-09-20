import { describeProjectionSnapshotStoreConformance } from '@genesis/testkit';
import { DynamoDbModel } from '../src/dynamodb/model.js';
import { DynamoProjectionSnapshotStore } from '../src/dynamodb/projections.js';
import { GENESIS_TABLE_SCHEMA } from '../src/dynamodb/schema.js';

describeProjectionSnapshotStoreConformance({
  name: 'DynamoProjectionSnapshotStore (semantics model)',
  create: async () =>
    new DynamoProjectionSnapshotStore({ client: new DynamoDbModel(GENESIS_TABLE_SCHEMA), table: 'genesis-test' }),
});
