import { describeGraphStoreConformance } from '@genesis/testkit';
import { dynamoGraphStore } from '../src/dynamodb/graph.js';
import { DynamoDbModel } from '../src/dynamodb/model.js';
import { GENESIS_TABLE_SCHEMA } from '../src/dynamodb/schema.js';

describeGraphStoreConformance({
  name: 'DynamoGraphStore (semantics model)',
  create: async () => dynamoGraphStore({ client: new DynamoDbModel(GENESIS_TABLE_SCHEMA), table: 'genesis-test' }),
});
