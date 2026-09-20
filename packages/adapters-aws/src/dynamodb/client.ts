/**
 * The DynamoDB operation set the adapters use (ADR-0024 §2).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is ports-and-adapters one level below
 * the storage ports: the adapters depend on this operation set rather than on
 * the AWS SDK, which buys two things. The SDK is reached from exactly one file,
 * so its version is a change to that file. And the adapters can be exercised
 * against something other than AWS without a line of adapter code changing,
 * which is what makes the conformance suites runnable in the gate.
 *
 * It is deliberately DynamoDB's own vocabulary rather than a prettier one. An
 * abstraction that hid condition expressions would hide the thing most likely
 * to be wrong, and a "storage" interface general enough for two databases would
 * be general enough to express what neither can do.
 *
 * Only the operations the adapters actually issue are here. `Scan` is absent
 * because nothing scans: a scan is a query somebody could not key, and at that
 * point the key schema is wrong (ADR-0024 §1).
 */

import { GenesisError } from '@genesis/core-types';

/** An item as DynamoDB holds it, already marshalled to plain JSON values. */
export type DynamoItem = Record<string, unknown>;

/** A primary or index key: one or two attributes, nothing else. */
export type DynamoKey = Record<string, string | number>;

export interface ExpressionParts {
  /** `#name` placeholders, for attribute names that collide with reserved words. */
  readonly names?: Readonly<Record<string, string>> | undefined;
  /** `:value` placeholders. */
  readonly values?: Readonly<Record<string, unknown>> | undefined;
}

export interface GetRequest {
  readonly key: DynamoKey;
  /**
   * Strongly consistent read. The adapters use it wherever a read informs a
   * conditional write, because an eventually consistent read there would decide
   * against a stale world.
   */
  readonly consistentRead?: boolean | undefined;
}

export interface PutRequest extends ExpressionParts {
  readonly item: DynamoItem;
  /** Refused with `ConditionalCheckFailedException` when it does not hold. */
  readonly condition?: string | undefined;
}

export interface DeleteRequest extends ExpressionParts {
  readonly key: DynamoKey;
  readonly condition?: string | undefined;
}

export interface QueryRequest extends ExpressionParts {
  /** Names a global secondary index; absent means the table's own keys. */
  readonly index?: string | undefined;
  /** `#pk = :pk`, optionally `AND begins_with(#sk, :p)` or `AND #sk BETWEEN :a AND :b`. */
  readonly keyCondition: string;
  /** Applied after the key condition, as DynamoDB does: it does not reduce reads. */
  readonly filter?: string | undefined;
  readonly limit?: number | undefined;
  /** Ascending by sort key unless false. */
  readonly forward?: boolean | undefined;
  readonly exclusiveStartKey?: DynamoKey | undefined;
  readonly consistentRead?: boolean | undefined;
}

export interface QueryResult {
  readonly items: readonly DynamoItem[];
  /** Present when the query stopped early; pass it back to continue. */
  readonly lastEvaluatedKey: DynamoKey | null;
}

/** One write inside a transaction. `ConditionCheck` writes nothing and can still fail it. */
export type TransactItem =
  | { readonly kind: 'Put'; readonly request: PutRequest }
  | { readonly kind: 'Delete'; readonly request: DeleteRequest }
  | { readonly kind: 'ConditionCheck'; readonly key: DynamoKey; readonly condition: string } & ExpressionParts;

/**
 * DynamoDB's limit on one transaction, and therefore on anything that must be
 * atomic. Exceeding it is refused rather than split, because splitting would
 * break the all-or-nothing guarantee a caller asked for (ADR-0024 §4).
 */
export const MAX_TRANSACT_ITEMS = 100;

export class ConditionalCheckFailed extends GenesisError {
  constructor(message = 'the condition on a conditional write did not hold') {
    super('SEQUENCE_CONFLICT', message);
    this.name = 'ConditionalCheckFailed';
  }
}

/**
 * A transaction refused as a whole, naming which item refused it.
 *
 * `reasons` is positional and matches the request, the way DynamoDB's
 * `CancellationReasons` does, so a caller can tell a lost race on the head from
 * a duplicate id without parsing a message.
 */
export class TransactionCancelled extends GenesisError {
  constructor(
    readonly reasons: readonly (string | null)[],
    message = 'the transaction was cancelled',
  ) {
    super('SEQUENCE_CONFLICT', message, { reasons: [...reasons] });
    this.name = 'TransactionCancelled';
  }

  /** True when any item was refused for the given reason code. */
  cancelledBy(reason: string): boolean {
    return this.reasons.includes(reason);
  }
}

export const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailed';

export interface DynamoDbClient {
  get(table: string, request: GetRequest): Promise<DynamoItem | null>;
  put(table: string, request: PutRequest): Promise<void>;
  delete(table: string, request: DeleteRequest): Promise<boolean>;
  query(table: string, request: QueryRequest): Promise<QueryResult>;
  /** All of them land or none do. Rejects with `TransactionCancelled`. */
  transactWrite(table: string, items: readonly TransactItem[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * Reads every page of a query.
 *
 * Adapters use this wherever a port promises "every one of these" — listing a
 * project's graph, a logical record's versions — because a single `query` stops
 * at a page boundary and silently returning a page as though it were the whole
 * set is the classic way a store starts losing rows at scale.
 */
export async function queryAll(
  client: DynamoDbClient,
  table: string,
  request: QueryRequest,
  pageCap = 10_000,
): Promise<DynamoItem[]> {
  const items: DynamoItem[] = [];
  let startKey: DynamoKey | undefined = request.exclusiveStartKey;
  let pages = 0;
  do {
    const page: QueryResult = await client.query(table, {
      ...request,
      ...(startKey === undefined ? {} : { exclusiveStartKey: startKey }),
    });
    items.push(...page.items);
    startKey = page.lastEvaluatedKey ?? undefined;
    pages += 1;
    if (pages > pageCap) {
      throw new GenesisError('VALIDATION_FAILED', `a query paged past ${pageCap} pages without finishing`, { table });
    }
  } while (startKey !== undefined);
  return items;
}
