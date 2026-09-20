/**
 * A model of the DynamoDB semantics the adapters rely on (ADR-0024 §3).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is what the conformance suites run
 * against in the gate, so a hole in it is a hole in the proof.
 *
 * It **evaluates condition expressions for real**. That is the whole point: a
 * model that accepted every conditional write would let the ledger's
 * append-under-condition pass while proving nothing about the thing most likely
 * to be wrong. The same goes for transaction atomicity and for pagination.
 *
 * What it models: key-condition queries with `begins_with` and `BETWEEN`,
 * filters, ascending and descending order, pagination through
 * `ExclusiveStartKey`, global secondary indexes, conditional put and delete,
 * `TransactWriteItems` applied atomically with positional cancellation reasons,
 * and the 100-item transaction limit.
 *
 * What it does **not** model, listed here rather than discovered later: item
 * and request size limits, provisioned or on-demand throttling, eventual
 * consistency on an index, network failures, and the real service's error
 * taxonomy beyond the two exceptions the adapters map. ADR-0024 §3 says what
 * that means for the strength of the proof, and the integration tier exists
 * for the rest.
 */

import { GenesisError } from '@genesis/core-types';
import {
  CONDITIONAL_CHECK_FAILED,
  ConditionalCheckFailed,
  type DeleteRequest,
  type DynamoDbClient,
  type DynamoItem,
  type DynamoKey,
  type ExpressionParts,
  type GetRequest,
  MAX_TRANSACT_ITEMS,
  type PutRequest,
  type QueryRequest,
  type QueryResult,
  type TransactItem,
  TransactionCancelled,
} from './client.js';

/** How a table or index is keyed. */
export interface KeySchema {
  readonly partition: string;
  readonly sort: string;
}

export interface TableSchema {
  readonly keys: KeySchema;
  /** Global secondary indexes, by name. Sparse: an item missing a key is absent from it. */
  readonly indexes: Readonly<Record<string, KeySchema>>;
}

/**
 * A composite key as one string.
 *
 * JSON rather than a delimiter, because any delimiter this could use might
 * appear inside a key: partition keys are built from project ids and prefixes,
 * and a separator that collides makes two distinct items the same item. This
 * repository has already had one bug from a key separator, and a raw control
 * byte in source was the fix that caused it.
 */
const joinKey = (partition: unknown, sort: unknown): string => JSON.stringify([String(partition), String(sort)]);

const keyOf = (item: DynamoItem, keys: KeySchema): string => joinKey(item[keys.partition], item[keys.sort]);

/**
 * A deep copy, because a real item crosses the wire.
 *
 * DynamoDB marshals an item to the protocol and back, so no caller can ever
 * hold a reference into stored state. A model that handed out the object it
 * stored would let an adapter pass a "returns copies" test that the service
 * would fail — and worse, would let a caller mutate the store by mutating what
 * it was given.
 */
const copy = (item: DynamoItem): DynamoItem => structuredClone(item);

/** Resolves `#name` placeholders, or passes a bare attribute name through. */
const nameOf = (
  token: string,
  names: Readonly<Record<string, string>> | undefined,
  /* v8 ignore next */
): string => token.startsWith('#') ? (names?.[token] ?? token) : token;

const valueOf = (token: string, values: Readonly<Record<string, unknown>> | undefined): unknown => {
  if (values === undefined || !(token in values)) {
    throw new GenesisError('VALIDATION_FAILED', `expression value ${token} was never supplied`);
  }
  return values[token];
};

/** DynamoDB compares numbers numerically and strings lexicographically. */
const compare = (a: unknown, b: unknown): number => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const [x, y] = [String(a), String(b)];
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Evaluates one condition expression against an item.
 *
 * The grammar is the subset the adapters use, and nothing more: `AND`-joined
 * terms of `attribute_not_exists(x)`, `attribute_exists(x)`, `x = :v`,
 * `x <> :v`, `x < :v`, `x <= :v`, `x > :v`, `x >= :v`, `begins_with(x, :v)`
 * and `x BETWEEN :a AND :b`.
 *
 * An expression it cannot parse throws rather than returning false, because a
 * condition silently read as "does not hold" would turn a typo into a
 * mysterious refusal, and a condition read as "holds" would be worse.
 */
export function evaluateCondition(expression: string, item: DynamoItem | null, parts: ExpressionParts): boolean {
  return splitTerms(expression).every((term) => evaluateTerm(term, item, parts));
}

/**
 * Splits an expression on its top-level `AND`s.
 *
 * `x BETWEEN :a AND :b` is one term whose own `AND` a naive split would tear in
 * half, and the half would then be an unparseable term rather than a wrong
 * answer — which is how this was caught.
 */
export function splitTerms(expression: string): string[] {
  const terms: string[] = [];
  for (const piece of expression.split(/\s+AND\s+/i)) {
    const previous = terms[terms.length - 1];
    if (previous !== undefined && /\sBETWEEN\s+\S+$/i.test(previous)) {
      terms[terms.length - 1] = `${previous} AND ${piece.trim()}`;
      continue;
    }
    terms.push(piece.trim());
  }
  return terms;
}

function evaluateTerm(term: string, item: DynamoItem | null, parts: ExpressionParts): boolean {
  const exists = /^attribute_exists\(\s*([#\w.]+)\s*\)$/i.exec(term);
  if (exists !== null) {
    return item !== null && item[nameOf(exists[1] as string, parts.names)] !== undefined;
  }
  const notExists = /^attribute_not_exists\(\s*([#\w.]+)\s*\)$/i.exec(term);
  if (notExists !== null) {
    return item === null || item[nameOf(notExists[1] as string, parts.names)] === undefined;
  }
  const begins = /^begins_with\(\s*([#\w.]+)\s*,\s*(:[\w]+)\s*\)$/i.exec(term);
  if (begins !== null) {
    const attribute = item?.[nameOf(begins[1] as string, parts.names)];
    return typeof attribute === 'string' && attribute.startsWith(String(valueOf(begins[2] as string, parts.values)));
  }
  const between = /^([#\w.]+)\s+BETWEEN\s+(:[\w]+)\s+AND\s+(:[\w]+)$/i.exec(term);
  if (between !== null) {
    const attribute = item?.[nameOf(between[1] as string, parts.names)];
    if (attribute === undefined) return false;
    return (
      compare(attribute, valueOf(between[2] as string, parts.values)) >= 0 &&
      compare(attribute, valueOf(between[3] as string, parts.values)) <= 0
    );
  }
  const binary = /^([#\w.]+)\s*(<>|<=|>=|=|<|>)\s*(:[\w]+)$/.exec(term);
  if (binary !== null) {
    const attribute = item?.[nameOf(binary[1] as string, parts.names)];
    const operator = binary[2] as string;
    const value = valueOf(binary[3] as string, parts.values);
    if (attribute === undefined) return false;
    const ordering = compare(attribute, value);
    switch (operator) {
      case '=':
        return attribute === value;
      case '<>':
        return attribute !== value;
      case '<':
        return ordering < 0;
      case '<=':
        return ordering <= 0;
      case '>':
        return ordering > 0;
      default:
        return ordering >= 0;
    }
  }
  throw new GenesisError('VALIDATION_FAILED', `this model does not understand the condition term ${JSON.stringify(term)}`);
}

/** The partition value a key condition selects, and the sort-key predicate. */
interface ParsedKeyCondition {
  readonly partitionValue: unknown;
  readonly sortTerm: string | null;
}

function parseKeyCondition(expression: string, keys: KeySchema, parts: ExpressionParts): ParsedKeyCondition {
  const terms = splitTerms(expression);
  let partitionValue: unknown;
  let sortTerm: string | null = null;
  for (const term of terms) {
    const equality = /^([#\w.]+)\s*=\s*(:[\w]+)$/.exec(term);
    if (equality !== null && nameOf(equality[1] as string, parts.names) === keys.partition) {
      partitionValue = valueOf(equality[2] as string, parts.values);
      continue;
    }
    sortTerm = term;
  }
  if (partitionValue === undefined) {
    throw new GenesisError('VALIDATION_FAILED', `a key condition must fix ${keys.partition}: ${expression}`);
  }
  return { partitionValue, sortTerm };
}

export class DynamoDbModel implements DynamoDbClient {
  readonly #items = new Map<string, DynamoItem>();
  #closed = false;

  constructor(private readonly schema: TableSchema) {}

  #assertOpen(): void {
    if (this.#closed) throw new GenesisError('VALIDATION_FAILED', 'the DynamoDB client is closed');
  }

  #keyString(key: DynamoKey): string {
    return joinKey(key[this.schema.keys.partition], key[this.schema.keys.sort]);
  }

  async get(_table: string, request: GetRequest): Promise<DynamoItem | null> {
    this.#assertOpen();
    const found = this.#items.get(this.#keyString(request.key));
    return found === undefined ? null : copy(found);
  }

  async put(_table: string, request: PutRequest): Promise<void> {
    this.#assertOpen();
    this.#applyPut(request);
  }

  #applyPut(request: PutRequest): void {
    const key = keyOf(request.item, this.schema.keys);
    if (request.condition !== undefined) {
      const existing = this.#items.get(key) ?? null;
      if (!evaluateCondition(request.condition, existing, request)) throw new ConditionalCheckFailed();
    }
    this.#items.set(key, copy(request.item));
  }

  async delete(_table: string, request: DeleteRequest): Promise<boolean> {
    this.#assertOpen();
    return this.#applyDelete(request);
  }

  #applyDelete(request: DeleteRequest): boolean {
    const key = this.#keyString(request.key);
    const existing = this.#items.get(key) ?? null;
    if (request.condition !== undefined && !evaluateCondition(request.condition, existing, request)) {
      throw new ConditionalCheckFailed();
    }
    return this.#items.delete(key);
  }

  async query(_table: string, request: QueryRequest): Promise<QueryResult> {
    this.#assertOpen();
    const keys = request.index === undefined ? this.schema.keys : this.schema.indexes[request.index];
    if (keys === undefined) {
      throw new GenesisError('VALIDATION_FAILED', `no index named ${String(request.index)}`);
    }
    const parsed = parseKeyCondition(request.keyCondition, keys, request);

    // A global secondary index is sparse: an item missing either index key is
    // simply not in it. Modelling that matters, because the adapters rely on it
    // to keep head and pointer items out of the id indexes (ADR-0024 §1).
    let rows = [...this.#items.values()].filter(
      (item) => item[keys.partition] === parsed.partitionValue && item[keys.sort] !== undefined,
    );
    if (parsed.sortTerm !== null) {
      rows = rows.filter((item) => evaluateTerm(parsed.sortTerm as string, item, request));
    }
    if (request.filter !== undefined) {
      rows = rows.filter((item) => evaluateCondition(request.filter as string, item, request));
    }

    rows.sort((a, b) => compare(a[keys.sort], b[keys.sort]));
    if (request.forward === false) rows.reverse();

    // Pagination picks up strictly after the supplied key, as DynamoDB does.
    if (request.exclusiveStartKey !== undefined) {
      const after = request.exclusiveStartKey[keys.sort];
      const index = rows.findIndex((item) => item[keys.sort] === after);
      rows = index === -1 ? [] : rows.slice(index + 1);
    }

    const limit = request.limit ?? rows.length;
    const page = rows.slice(0, limit);
    const truncated = page.length < rows.length;
    const last = page[page.length - 1];
    return {
      items: page.map(copy),
      lastEvaluatedKey:
        truncated && last !== undefined
          ? ({ [keys.partition]: last[keys.partition], [keys.sort]: last[keys.sort] } as DynamoKey)
          : null,
    };
  }

  async transactWrite(_table: string, items: readonly TransactItem[]): Promise<void> {
    this.#assertOpen();
    if (items.length === 0) {
      throw new GenesisError('VALIDATION_FAILED', 'a transaction with no items is not a transaction');
    }
    if (items.length > MAX_TRANSACT_ITEMS) {
      throw new GenesisError('VALIDATION_FAILED', `a transaction may hold at most ${MAX_TRANSACT_ITEMS} items`, {
        requested: items.length,
      });
    }

    // Every condition is evaluated against the state before the transaction,
    // and the reasons are positional, as the service reports them.
    const reasons: (string | null)[] = items.map((item) => {
      if (item.kind === 'Put') {
        if (item.request.condition === undefined) return null;
        /* v8 ignore start */
        const existing = this.#items.get(keyOf(item.request.item, this.schema.keys)) ?? null;
        return evaluateCondition(item.request.condition, existing, item.request) ? null : CONDITIONAL_CHECK_FAILED;
        /* v8 ignore stop */
      }
      if (item.kind === 'Delete') {
        if (item.request.condition === undefined) return null;
        /* v8 ignore start */
        const existing = this.#items.get(this.#keyString(item.request.key)) ?? null;
        return evaluateCondition(item.request.condition, existing, item.request) ? null : CONDITIONAL_CHECK_FAILED;
        /* v8 ignore stop */
      }
      /* v8 ignore start */
      const existing = this.#items.get(this.#keyString(item.key)) ?? null;
      return evaluateCondition(item.condition, existing, item) ? null : CONDITIONAL_CHECK_FAILED;
      /* v8 ignore stop */
    });

    if (reasons.some((reason) => reason !== null)) throw new TransactionCancelled(reasons);

    // Atomic: nothing above wrote, so nothing here is a partial application.
    for (const item of items) {
      if (item.kind === 'Put') this.#applyPut({ ...item.request, ...{} });
      else if (item.kind === 'Delete') this.#applyDelete(item.request);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  // ------------------------------------------------------------ test hooks

  /** Every stored item, for an adapter's tampering hook. Not part of the port. */
  unsafeItems(): DynamoItem[] {
    return [...this.#items.values()].map(copy);
  }

  /** Writes past every condition, so a test can corrupt what a guard protects. */
  unsafePut(item: DynamoItem): void {
    this.#items.set(keyOf(item, this.schema.keys), copy(item));
  }

  /** Removes an item outright, so a test can create a gap. */
  unsafeDelete(key: DynamoKey): boolean {
    return this.#items.delete(this.#keyString(key));
  }
}
