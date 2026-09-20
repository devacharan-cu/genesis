import { describeMemoryStoreConformance } from '@genesis/testkit';
import { DynamoMemoryStore } from '../src/dynamodb/memory.js';
import { DynamoDbModel } from '../src/dynamodb/model.js';
import { GENESIS_TABLE_SCHEMA } from '../src/dynamodb/schema.js';

describeMemoryStoreConformance({
  name: 'DynamoMemoryStore (semantics model)',
  create: async () => new DynamoMemoryStore({ client: new DynamoDbModel(GENESIS_TABLE_SCHEMA), table: 'genesis-test' }),
});
