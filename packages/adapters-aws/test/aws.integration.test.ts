/**
 * The DynamoDB adapters against real DynamoDB (ADR-0024 §3, tier 2).
 *
 * SKIPPED unless explicitly enabled, and never part of the default gate.
 *
 * **This has not been run.** ADR-0024 §3 says so, ADR-0026 §5 says so, and this
 * comment says so, because a file that looks like an integration suite is the
 * easiest place in a repository to mistake intent for evidence. What the gate
 * proves is that the adapters pass the conformance suites against a faithful
 * in-process model of DynamoDB's semantics. What it does not prove is that the
 * model is faithful — only this can, and only once somebody runs it.
 *
 * Enabling it needs three things this workspace does not have:
 *
 *   1. the AWS SDK: `pnpm add -D @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb`
 *      in this package. It is imported dynamically below, so the default gate
 *      neither needs nor resolves it.
 *   2. a table with the schema in ADR-0024 §1 — `pk`/`sk` as the key, `gsi1`
 *      and `gsi2` as global secondary indexes over `gsi1pk`/`gsi1sk` and
 *      `gsi2pk`/`gsi2sk` — which DynamoDB Local satisfies as well as an
 *      account does;
 *   3. credentials that may read and write it.
 *
 *   GENESIS_AWS_INTEGRATION=1 GENESIS_AWS_TABLE=genesis-it \
 *   GENESIS_AWS_REGION=eu-west-1 GENESIS_AWS_ENDPOINT=http://localhost:8000 \
 *   corepack pnpm exec vitest run packages/adapters-aws/test/aws.integration.test.ts
 *
 * What it checks is exactly what the model tier checks: the same conformance
 * suites, unchanged. A difference between the two tiers is a defect in the
 * model, and running these suites is the only thing that would surface it.
 */

import { GraphEngine } from '@genesis/graph';
import { describeGraphStoreConformance, describeLedgerConformance, describeMemoryStoreConformance } from '@genesis/testkit';
import { describe, it } from 'vitest';
import {
  ConditionalCheckFailed,
  type DynamoDbClient,
  type DynamoItem,
  type DynamoKey,
  type PutRequest,
  type QueryRequest,
  type QueryResult,
  type TransactItem,
  TransactionCancelled,
} from '../src/dynamodb/client.js';
import { DynamoGraphStorage } from '../src/dynamodb/graph.js';
import { DynamoEventLedger } from '../src/dynamodb/ledger.js';
import { DynamoMemoryStore } from '../src/dynamodb/memory.js';

const enabled = process.env['GENESIS_AWS_INTEGRATION'] === '1';
const table = process.env['GENESIS_AWS_TABLE'] ?? 'genesis-it';
const region = process.env['GENESIS_AWS_REGION'] ?? 'eu-west-1';
const endpoint = process.env['GENESIS_AWS_ENDPOINT'];

type Sender = { send(command: unknown): Promise<Record<string, unknown>>; destroy(): void };
type Constructor = new (input: unknown) => unknown;

const expressionOf = (parts: {
  readonly names?: unknown;
  readonly values?: unknown;
  readonly condition?: string | undefined;
}): Record<string, unknown> => ({
  ...(parts.condition === undefined ? {} : { ConditionExpression: parts.condition }),
  ...(parts.names === undefined ? {} : { ExpressionAttributeNames: parts.names }),
  ...(parts.values === undefined ? {} : { ExpressionAttributeValues: parts.values }),
});

/**
 * The port, over the SDK's document client.
 *
 * Deliberately a thin mapping and nothing else. Every behaviour worth testing
 * lives in the adapters above this line, so if this needed logic of its own,
 * the port would be drawn in the wrong place.
 */
async function sdkClient(): Promise<DynamoDbClient> {
  // Variable specifiers, so nothing tries to resolve a package the default gate
  // does not install.
  const core = (await import(/* @vite-ignore */ String('@aws-sdk/client-dynamodb'))) as Record<string, Constructor>;
  const lib = (await import(/* @vite-ignore */ String('@aws-sdk/lib-dynamodb'))) as Record<string, Constructor> & {
    DynamoDBDocumentClient: { from(client: unknown): Sender };
  };

  const document = lib.DynamoDBDocumentClient.from(
    new core['DynamoDBClient']!({ region, ...(endpoint === undefined ? {} : { endpoint }) }),
  );
  const send = (name: string, input: unknown): Promise<Record<string, unknown>> => document.send(new lib[name]!(input));

  return {
    async get(tableName, request) {
      const result = await send('GetCommand', {
        TableName: tableName,
        Key: request.key,
        ConsistentRead: request.consistentRead ?? false,
      });
      return (result['Item'] as DynamoItem | undefined) ?? null;
    },

    async put(tableName, request: PutRequest) {
      try {
        await send('PutCommand', { TableName: tableName, Item: request.item, ...expressionOf(request) });
      } catch (error) {
        if ((error as { name?: string }).name === 'ConditionalCheckFailedException') throw new ConditionalCheckFailed();
        throw error;
      }
    },

    async delete(tableName, request) {
      try {
        const result = await send('DeleteCommand', {
          TableName: tableName,
          Key: request.key,
          ReturnValues: 'ALL_OLD',
          ...expressionOf(request),
        });
        // The port answers whether anything was there, which DynamoDB reports
        // only if the old item is asked for.
        return result['Attributes'] !== undefined;
      } catch (error) {
        if ((error as { name?: string }).name === 'ConditionalCheckFailedException') throw new ConditionalCheckFailed();
        throw error;
      }
    },

    async query(tableName, request: QueryRequest): Promise<QueryResult> {
      const result = await send('QueryCommand', {
        TableName: tableName,
        ...(request.index === undefined ? {} : { IndexName: request.index }),
        KeyConditionExpression: request.keyCondition,
        ...(request.filter === undefined ? {} : { FilterExpression: request.filter }),
        ...(request.names === undefined ? {} : { ExpressionAttributeNames: request.names }),
        ...(request.values === undefined ? {} : { ExpressionAttributeValues: request.values }),
        ...(request.limit === undefined ? {} : { Limit: request.limit }),
        ...(request.forward === undefined ? {} : { ScanIndexForward: request.forward }),
        ...(request.exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: request.exclusiveStartKey }),
        // An index cannot be read consistently, so the flag is honoured only
        // where DynamoDB would accept it.
        ...(request.index === undefined ? { ConsistentRead: request.consistentRead ?? false } : {}),
      });
      return {
        items: (result['Items'] as DynamoItem[] | undefined) ?? [],
        lastEvaluatedKey: (result['LastEvaluatedKey'] as DynamoKey | undefined) ?? null,
      };
    },

    async transactWrite(tableName, items: readonly TransactItem[]) {
      try {
        await send('TransactWriteCommand', {
          TransactItems: items.map((entry) => {
            if (entry.kind === 'Put') {
              return { Put: { TableName: tableName, Item: entry.request.item, ...expressionOf(entry.request) } };
            }
            if (entry.kind === 'Delete') {
              return { Delete: { TableName: tableName, Key: entry.request.key, ...expressionOf(entry.request) } };
            }
            return { ConditionCheck: { TableName: tableName, Key: entry.key, ...expressionOf(entry) } };
          }),
        });
      } catch (error) {
        const reasons = (error as { CancellationReasons?: { Code?: string | null }[] }).CancellationReasons;
        // Positional reasons are the whole point: they say WHICH item refused,
        // which is how a lost race on the head is told from a duplicate id.
        if (reasons !== undefined) throw new TransactionCancelled(reasons.map((reason) => reason.Code ?? null));
        throw error;
      }
    },

    async close() {
      document.destroy();
    },
  };
}

if (enabled) {
  describeLedgerConformance({
    name: 'DynamoEventLedger (real DynamoDB)',
    create: async () => new DynamoEventLedger({ client: await sdkClient(), table }),
  });

  describeMemoryStoreConformance({
    name: 'DynamoMemoryStore (real DynamoDB)',
    create: async () => new DynamoMemoryStore({ client: await sdkClient(), table }),
  });

  describeGraphStoreConformance({
    name: 'DynamoGraphStorage (real DynamoDB)',
    create: async () => new GraphEngine(new DynamoGraphStorage({ client: await sdkClient(), table })),
  });
} else {
  describe('the AWS integration tier', () => {
    // Stated as a skipped test rather than as silence, so every run of the
    // suite says out loud that this evidence does not exist yet.
    it.skip('has not been run: it needs a table, credentials and the SDK', () => undefined);
  });
}
