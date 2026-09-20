/**
 * The model of DynamoDB's semantics, tested directly.
 *
 * ADR-0024 §3 makes this the foundation of the whole tier-1 proof: the
 * conformance suites run the real adapters against this, so anything it gets
 * wrong is something the suites cannot catch. The adapters exercise a narrow
 * slice of its grammar, which is exactly why the grammar needs testing here
 * rather than only through them.
 *
 * The properties that matter are the ones a permissive model would silently
 * concede: a condition that does not hold refuses the write, a transaction
 * applies wholly or not at all, a query pages, and an expression this does not
 * understand is an error rather than a `false`.
 */

import { GenesisError } from '@genesis/core-types';
import { describe, expect, it } from 'vitest';
import {
  ConditionalCheckFailed,
  type DynamoItem,
  MAX_TRANSACT_ITEMS,
  type TransactItem,
  TransactionCancelled,
} from '../src/dynamodb/client.js';
import { DynamoDbModel, evaluateCondition, splitTerms, type TableSchema } from '../src/dynamodb/model.js';

const SCHEMA: TableSchema = {
  keys: { partition: 'pk', sort: 'sk' },
  indexes: { gsi1: { partition: 'gsi1pk', sort: 'gsi1sk' } },
};

const model = (): DynamoDbModel => new DynamoDbModel(SCHEMA);
const item = (pk: string, sk: string, rest: DynamoItem = {}): DynamoItem => ({ pk, sk, ...rest });

const seed = async (rows: readonly DynamoItem[]): Promise<DynamoDbModel> => {
  const store = model();
  for (const row of rows) await store.put('t', { item: row });
  return store;
};

// ------------------------------------------------------------- expressions

describe('splitting an expression', () => {
  it('splits on top-level ANDs', () => {
    expect(splitTerms('a = :a AND b = :b')).toEqual(['a = :a', 'b = :b']);
  });

  it('keeps a BETWEEN whole, because its AND is not a separator', () => {
    // A naive split tears `BETWEEN :a AND :b` in half, and the half is then an
    // unparseable term rather than a wrong answer — which is how this was
    // caught in the first place.
    expect(splitTerms('#sk BETWEEN :from AND :to')).toEqual(['#sk BETWEEN :from AND :to']);
  });

  it('handles a BETWEEN alongside other terms', () => {
    expect(splitTerms('pk = :pk AND sk BETWEEN :a AND :b')).toEqual(['pk = :pk', 'sk BETWEEN :a AND :b']);
  });

  it('is case-insensitive about the separator', () => {
    expect(splitTerms('a = :a and b = :b')).toEqual(['a = :a', 'b = :b']);
  });

  it('leaves a single term alone', () => {
    expect(splitTerms('attribute_not_exists(pk)')).toEqual(['attribute_not_exists(pk)']);
  });
});

describe('evaluating a condition', () => {
  const row = item('p', 's', { seq: 5, name: 'alpha', flag: true });
  const holds = (expression: string, parts: Record<string, unknown> = {}, against: DynamoItem | null = row): boolean =>
    evaluateCondition(expression, against, parts as never);

  it('checks whether an attribute is there', () => {
    expect(holds('attribute_exists(seq)')).toBe(true);
    expect(holds('attribute_exists(missing)')).toBe(false);
    expect(holds('attribute_exists(seq)', {}, null)).toBe(false);
  });

  it('checks whether an attribute is absent, which is how a first write is guarded', () => {
    expect(holds('attribute_not_exists(pk)')).toBe(false);
    expect(holds('attribute_not_exists(missing)')).toBe(true);
    expect(holds('attribute_not_exists(pk)', {}, null)).toBe(true);
  });

  it('passes a bare attribute name through when no placeholders were supplied', () => {
    expect(holds('attribute_exists(seq)', { names: undefined })).toBe(true);
  });

  it('resolves a #name placeholder', () => {
    expect(holds('attribute_exists(#s)', { names: { '#s': 'seq' } })).toBe(true);
    // An unresolvable placeholder falls through to the literal name, which no
    // item has, rather than silently matching something.
    expect(holds('attribute_exists(#unknown)', { names: {} })).toBe(false);
  });

  it('compares with every operator the adapters use', () => {
    const values = { values: { ':five': 5, ':six': 6, ':four': 4 } };
    expect(holds('seq = :five', values)).toBe(true);
    expect(holds('seq = :six', values)).toBe(false);
    expect(holds('seq <> :six', values)).toBe(true);
    expect(holds('seq <> :five', values)).toBe(false);
    expect(holds('seq < :six', values)).toBe(true);
    expect(holds('seq < :four', values)).toBe(false);
    expect(holds('seq <= :five', values)).toBe(true);
    expect(holds('seq <= :four', values)).toBe(false);
    expect(holds('seq > :four', values)).toBe(true);
    expect(holds('seq > :six', values)).toBe(false);
    expect(holds('seq >= :five', values)).toBe(true);
    expect(holds('seq >= :six', values)).toBe(false);
  });

  it('treats a missing attribute as failing any comparison', () => {
    expect(holds('absent = :v', { values: { ':v': 1 } })).toBe(false);
    expect(holds('absent BETWEEN :a AND :b', { values: { ':a': 1, ':b': 9 } })).toBe(false);
  });

  it('matches a prefix', () => {
    expect(holds('begins_with(name, :p)', { values: { ':p': 'al' } })).toBe(true);
    expect(holds('begins_with(name, :p)', { values: { ':p': 'be' } })).toBe(false);
    // A non-string attribute has no prefix, rather than being stringified.
    expect(holds('begins_with(seq, :p)', { values: { ':p': '5' } })).toBe(false);
  });

  it('matches a range, inclusive at both ends', () => {
    const v = (a: number, b: number) => ({ values: { ':a': a, ':b': b } });
    expect(holds('seq BETWEEN :a AND :b', v(5, 5))).toBe(true);
    expect(holds('seq BETWEEN :a AND :b', v(1, 9))).toBe(true);
    expect(holds('seq BETWEEN :a AND :b', v(6, 9))).toBe(false);
    expect(holds('seq BETWEEN :a AND :b', v(1, 4))).toBe(false);
  });

  it('compares numbers numerically and strings lexicographically', () => {
    // The distinction matters: as strings, 10 sorts before 2.
    expect(holds('seq < :v', { values: { ':v': 10 } })).toBe(true);
    expect(holds('name < :v', { values: { ':v': 'beta' } })).toBe(true);
    expect(holds('name > :v', { values: { ':v': 'beta' } })).toBe(false);
    expect(holds('flag = :v', { values: { ':v': true } })).toBe(true);
    expect(holds('flag <> :v', { values: { ':v': false } })).toBe(true);
  });

  it('requires every AND-joined term', () => {
    const parts = { values: { ':five': 5, ':six': 6 } };
    expect(holds('attribute_exists(seq) AND seq = :five', parts)).toBe(true);
    expect(holds('attribute_exists(seq) AND seq = :six', parts)).toBe(false);
  });

  it('refuses an expression it does not understand rather than guessing', () => {
    // A condition read as "does not hold" turns a typo into a mysterious
    // refusal; read as "holds" it would be worse.
    expect(() => holds('size(name) > :v', { values: { ':v': 1 } })).toThrow(/does not understand/);
    expect(() => holds('seq IN (:a, :b)')).toThrow(GenesisError);
  });

  it('refuses a value that is not a placeholder', () => {
    expect(() => holds('seq = 5')).toThrow(/does not understand/);
    expect(() => holds('begins_with(name, alpha)')).toThrow(/does not understand/);
  });

  it('refuses a placeholder nobody supplied', () => {
    expect(() => holds('seq = :missing', { values: {} })).toThrow(/was never supplied/);
    expect(() => holds('seq = :missing')).toThrow(/was never supplied/);
  });
});

// ------------------------------------------------------------- the store

describe('reading and writing', () => {
  it('returns a copy, because a real item crosses the wire', async () => {
    const store = await seed([item('p', 's', { nested: { value: 1 } })]);
    const first = (await store.get('t', { key: { pk: 'p', sk: 's' } })) as DynamoItem;
    (first['nested'] as { value: number }).value = 99;
    const second = (await store.get('t', { key: { pk: 'p', sk: 's' } })) as DynamoItem;
    expect((second['nested'] as { value: number }).value).toBe(1);
  });

  it('answers null for an item that is not there', async () => {
    expect(await model().get('t', { key: { pk: 'p', sk: 's' } })).toBeNull();
  });

  it('keys on both attributes, so one key part matching is not a match', async () => {
    const store = await seed([item('p', 'a')]);
    expect(await store.get('t', { key: { pk: 'p', sk: 'b' } })).toBeNull();
  });

  it('does not confuse two keys that would collide under a delimiter', async () => {
    // `["a#b","c"]` and `["a","b#c"]` are different items whatever the
    // separator; this repository has already had one bug from a key separator.
    const store = await seed([item('a#b', 'c', { which: 1 }), item('a', 'b#c', { which: 2 })]);
    expect((await store.get('t', { key: { pk: 'a#b', sk: 'c' } }))?.['which']).toBe(1);
    expect((await store.get('t', { key: { pk: 'a', sk: 'b#c' } }))?.['which']).toBe(2);
  });

  it('refuses a conditional put whose condition does not hold', async () => {
    const store = await seed([item('p', 's')]);
    await expect(store.put('t', { item: item('p', 's'), condition: 'attribute_not_exists(pk)' })).rejects.toThrow(
      ConditionalCheckFailed,
    );
  });

  it('allows a conditional put whose condition holds', async () => {
    const store = model();
    await expect(store.put('t', { item: item('p', 's'), condition: 'attribute_not_exists(pk)' })).resolves.toBeUndefined();
  });

  it('reports whether a delete removed anything', async () => {
    const store = await seed([item('p', 's')]);
    expect(await store.delete('t', { key: { pk: 'p', sk: 's' } })).toBe(true);
    expect(await store.delete('t', { key: { pk: 'p', sk: 's' } })).toBe(false);
  });

  it('refuses a conditional delete whose condition does not hold', async () => {
    const store = await seed([item('p', 's', { seq: 1 })]);
    await expect(
      store.delete('t', { key: { pk: 'p', sk: 's' }, condition: 'seq = :v', values: { ':v': 2 } }),
    ).rejects.toThrow(ConditionalCheckFailed);
    expect(await store.get('t', { key: { pk: 'p', sk: 's' } })).not.toBeNull();
  });

  it('allows a conditional delete whose condition holds', async () => {
    const store = await seed([item('p', 's', { seq: 1 })]);
    expect(await store.delete('t', { key: { pk: 'p', sk: 's' }, condition: 'seq = :v', values: { ':v': 1 } })).toBe(true);
  });
});

describe('querying', () => {
  const rows = [
    item('p', 'a', { gsi1pk: 'g', gsi1sk: '1', n: 1 }),
    item('p', 'b', { gsi1pk: 'g', gsi1sk: '2', n: 2 }),
    item('p', 'c', { n: 3 }),
    item('other', 'a', { n: 4 }),
  ];
  const seeded = () => seed(rows);
  const sks = (result: { items: readonly DynamoItem[] }): unknown[] => result.items.map((row) => row['sk']);

  it('returns one partition, ascending by sort key', async () => {
    const store = await seeded();
    const result = await store.query('t', { keyCondition: 'pk = :pk', values: { ':pk': 'p' } });
    expect(sks(result)).toEqual(['a', 'b', 'c']);
    expect(result.lastEvaluatedKey).toBeNull();
  });

  it('never returns another partition’s items', async () => {
    const store = await seeded();
    const result = await store.query('t', { keyCondition: 'pk = :pk', values: { ':pk': 'p' } });
    expect(result.items.every((row) => row['pk'] === 'p')).toBe(true);
  });

  it('reverses on request', async () => {
    const store = await seeded();
    expect(sks(await store.query('t', { keyCondition: 'pk = :pk', values: { ':pk': 'p' }, forward: false }))).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('applies a sort-key predicate', async () => {
    const store = await seeded();
    const begins = await store.query('t', {
      keyCondition: 'pk = :pk AND begins_with(sk, :p)',
      values: { ':pk': 'p', ':p': 'b' },
    });
    expect(sks(begins)).toEqual(['b']);

    const between = await store.query('t', {
      keyCondition: 'pk = :pk AND sk BETWEEN :from AND :to',
      values: { ':pk': 'p', ':from': 'b', ':to': 'c' },
    });
    expect(sks(between)).toEqual(['b', 'c']);
  });

  it('applies a filter after the key condition, as the service does', async () => {
    const store = await seeded();
    const result = await store.query('t', {
      keyCondition: 'pk = :pk',
      filter: 'n > :n',
      values: { ':pk': 'p', ':n': 1 },
    });
    expect(sks(result)).toEqual(['b', 'c']);
  });

  it('reads an index, and the index is sparse', async () => {
    const store = await seeded();
    const result = await store.query('t', {
      index: 'gsi1',
      keyCondition: 'gsi1pk = :pk',
      values: { ':pk': 'g' },
    });
    // The row without index keys is simply absent, which is what sparseness
    // means and what several adapters rely on.
    expect(sks(result)).toEqual(['a', 'b']);
  });

  it('resolves #name placeholders in a key condition', async () => {
    const store = await seeded();
    const result = await store.query('t', {
      keyCondition: '#p = :pk',
      names: { '#p': 'pk' },
      values: { ':pk': 'p' },
    });
    expect(result.items).toHaveLength(3);
  });

  it('pages, and says where to continue from', async () => {
    const store = await seeded();
    const first = await store.query('t', { keyCondition: 'pk = :pk', values: { ':pk': 'p' }, limit: 2 });
    expect(sks(first)).toEqual(['a', 'b']);
    expect(first.lastEvaluatedKey).toEqual({ pk: 'p', sk: 'b' });

    const second = await store.query('t', {
      keyCondition: 'pk = :pk',
      values: { ':pk': 'p' },
      exclusiveStartKey: first.lastEvaluatedKey as never,
    });
    expect(sks(second)).toEqual(['c']);
    expect(second.lastEvaluatedKey).toBeNull();
  });

  it('picks up strictly after the supplied key', async () => {
    const store = await seeded();
    const result = await store.query('t', {
      keyCondition: 'pk = :pk',
      values: { ':pk': 'p' },
      exclusiveStartKey: { pk: 'p', sk: 'a' },
    });
    expect(sks(result)).toEqual(['b', 'c']);
  });

  it('returns nothing when the start key is not in the result', async () => {
    const store = await seeded();
    const result = await store.query('t', {
      keyCondition: 'pk = :pk',
      values: { ':pk': 'p' },
      exclusiveStartKey: { pk: 'p', sk: 'zzz' },
    });
    expect(result.items).toEqual([]);
  });

  it('returns copies here too', async () => {
    const store = await seed([item('p', 'a', { nested: { value: 1 } })]);
    const result = await store.query('t', { keyCondition: 'pk = :pk', values: { ':pk': 'p' } });
    ((result.items[0] as DynamoItem)['nested'] as { value: number }).value = 99;
    const again = await store.query('t', { keyCondition: 'pk = :pk', values: { ':pk': 'p' } });
    expect(((again.items[0] as DynamoItem)['nested'] as { value: number }).value).toBe(1);
  });

  it('refuses an index it does not have', async () => {
    const store = await seeded();
    await expect(store.query('t', { index: 'gsi9', keyCondition: 'x = :v', values: { ':v': 1 } })).rejects.toThrow(
      /no index named gsi9/,
    );
  });

  it('refuses a key condition that does not fix the partition', async () => {
    const store = await seeded();
    await expect(store.query('t', { keyCondition: 'sk = :sk', values: { ':sk': 'a' } })).rejects.toThrow(
      /must fix pk/,
    );
  });
});

describe('transactions', () => {
  const put = (row: DynamoItem, condition?: string, values?: Record<string, unknown>): TransactItem => ({
    kind: 'Put',
    request: { item: row, ...(condition === undefined ? {} : { condition }), ...(values === undefined ? {} : { values }) },
  });

  it('applies every write when every condition holds', async () => {
    const store = model();
    await store.transactWrite('t', [put(item('p', 'a')), put(item('p', 'b'))]);
    expect((await store.query('t', { keyCondition: 'pk = :pk', values: { ':pk': 'p' } })).items).toHaveLength(2);
  });

  it('applies a put when its condition holds', async () => {
    const store = await seed([item('p', 'a', { n: 1 })]);
    await store.transactWrite('t', [
      put(item('p', 'a', { n: 2 }), 'n = :v', { ':v': 1 }),
      put(item('p', 'c', { n: 1 }), 'attribute_not_exists(pk)')
    ]);
    expect((await store.get('t', { key: { pk: 'p', sk: 'a' } }))?.n).toBe(2);
    expect((await store.get('t', { key: { pk: 'p', sk: 'c' } }))?.n).toBe(1);
  });

  it('applies nothing when one condition fails', async () => {
    const store = await seed([item('p', 'a')]);
    const attempt = store.transactWrite('t', [
      put(item('p', 'b')),
      put(item('p', 'a'), 'attribute_not_exists(pk)'),
    ]);
    await expect(attempt).rejects.toThrow(TransactionCancelled);
    // The first item must not have landed: partial application is the failure
    // mode a transaction exists to prevent.
    expect(await store.get('t', { key: { pk: 'p', sk: 'b' } })).toBeNull();
  });

  it('reports which item refused, positionally', async () => {
    const store = await seed([item('p', 'a')]);
    const error = await store
      .transactWrite('t', [put(item('p', 'b')), put(item('p', 'a'), 'attribute_not_exists(pk)')])
      .then(() => null, (thrown: unknown) => thrown as TransactionCancelled);
    expect(error?.reasons).toEqual([null, 'ConditionalCheckFailed']);
    expect(error?.cancelledBy('ConditionalCheckFailed')).toBe(true);
    expect(error?.cancelledBy('ItemCollectionSizeLimitExceeded')).toBe(false);
  });

  it('evaluates every condition against the state before the transaction', async () => {
    const store = model();
    // The second condition sees no `p/a`, because the first put has not been
    // applied yet. A model that applied as it went would accept this.
    await expect(
      store.transactWrite('t', [put(item('p', 'a')), put(item('p', 'b'), 'attribute_exists(pk)')]),
    ).rejects.toThrow(TransactionCancelled);
  });

  it('deletes inside a transaction', async () => {
    const store = await seed([item('p', 'a'), item('p', 'b')]);
    await store.transactWrite('t', [{ kind: 'Delete', request: { key: { pk: 'p', sk: 'a' } } }]);
    expect(await store.get('t', { key: { pk: 'p', sk: 'a' } })).toBeNull();
  });

  it('deletes inside a transaction when the condition holds', async () => {
    const store = await seed([item('p', 'a', { seq: 1 })]);
    await store.transactWrite('t', [
      { kind: 'Delete', request: { key: { pk: 'p', sk: 'a' }, condition: 'seq = :v', values: { ':v': 1 } } },
    ]);
    expect(await store.get('t', { key: { pk: 'p', sk: 'a' } })).toBeNull();
  });

  it('rejects delete inside a transaction when the condition fails', async () => {
    const store = await seed([item('p', 'a', { seq: 1 })]);
    await expect(store.transactWrite('t', [
      { kind: 'Delete', request: { key: { pk: 'p', sk: 'a' }, condition: 'seq = :v', values: { ':v': 2 } } },
    ])).rejects.toThrow(TransactionCancelled);
  });

  it('cancels when a delete’s condition does not hold', async () => {
    const store = await seed([item('p', 'a', { seq: 1 })]);
    const attempt = store.transactWrite('t', [
      { kind: 'Delete', request: { key: { pk: 'p', sk: 'a' }, condition: 'seq = :v', values: { ':v': 2 } } },
    ]);
    await expect(attempt).rejects.toThrow(TransactionCancelled);
    expect(await store.get('t', { key: { pk: 'p', sk: 'a' } })).not.toBeNull();
  });

  it('checks a condition without writing anything', async () => {
    const store = await seed([item('p', 'head', { seq: 1 })]);
    await store.transactWrite('t', [
      { kind: 'ConditionCheck', key: { pk: 'p', sk: 'head' }, condition: 'seq = :v', values: { ':v': 1 } },
      put(item('p', 'a')),
    ]);
    expect(await store.get('t', { key: { pk: 'p', sk: 'a' } })).not.toBeNull();
  });

  it('cancels the whole transaction when a condition check fails', async () => {
    const store = await seed([item('p', 'head', { seq: 1 })]);
    const attempt = store.transactWrite('t', [
      { kind: 'ConditionCheck', key: { pk: 'p', sk: 'head' }, condition: 'seq = :v', values: { ':v': 2 } },
      put(item('p', 'a')),
    ]);
    await expect(attempt).rejects.toThrow(TransactionCancelled);
    expect(await store.get('t', { key: { pk: 'p', sk: 'a' } })).toBeNull();
  });

  it('refuses a transaction with no items', async () => {
    await expect(model().transactWrite('t', [])).rejects.toThrow(/not a transaction/);
  });

  it('refuses more items than the service accepts', async () => {
    const store = model();
    const many = Array.from({ length: MAX_TRANSACT_ITEMS + 1 }, (_, i) => put(item('p', `s${i}`)));
    // Refused rather than split: splitting would break the all-or-nothing
    // guarantee the caller asked for.
    await expect(store.transactWrite('t', many)).rejects.toThrow(/at most 100 items/);
  });

  it('accepts exactly the limit', async () => {
    const store = model();
    const many = Array.from({ length: MAX_TRANSACT_ITEMS }, (_, i) => put(item('p', `s${i}`)));
    await expect(store.transactWrite('t', many)).resolves.toBeUndefined();
  });
});

describe('the test hooks and closing', () => {
  it('lists every stored item, as copies', async () => {
    const store = await seed([item('p', 'a', { n: 1 }), item('p', 'b', { n: 2 })]);
    const items = store.unsafeItems();
    expect(items).toHaveLength(2);
    items[0]!['n'] = 99;
    expect(store.unsafeItems().some((row) => row['n'] === 99)).toBe(false);
  });

  it('writes past every condition, so a guard can be corrupted deliberately', async () => {
    const store = await seed([item('p', 'a', { n: 1 })]);
    store.unsafePut(item('p', 'a', { n: 2 }));
    expect((await store.get('t', { key: { pk: 'p', sk: 'a' } }))?.['n']).toBe(2);
  });

  it('evaluates greater than', async () => {
    const store = await seed([item('p', 'a', { n: 1 })]);
    // put item with n=2 but the condition is checked against the existing item (n=1)
    // Wait, if n=1, then n > 0 holds!
    await store.put('t', { item: item('p', 'a', { n: 2 }), condition: 'n > :v', values: { ':v': 0 } });
    expect((await store.get('t', { key: { pk: 'p', sk: 'a' } }))?.n).toBe(2);
  });

  it('evaluates false for binary operators when the attribute is missing', async () => {
    const store = await seed([item('p', 'a')]); // no 'n' attribute
    await expect(
      store.put('t', { item: item('p', 'b'), condition: 'n = :v', values: { ':v': 1 } })
    ).rejects.toThrow(ConditionalCheckFailed);
  });

  it('evaluates false for attribute_exists when the attribute is missing on an existing item', async () => {
    const store = await seed([item('p', 'a')]);
    await expect(
      store.put('t', { item: item('p', 'a'), condition: 'attribute_exists(n)' })
    ).rejects.toThrow(ConditionalCheckFailed);
  });

  it('evaluates true for attribute_not_exists when the attribute is missing on an existing item', async () => {
    const store = await seed([item('p', 'a')]);
    await store.put('t', { item: item('p', 'a', { n: 1 }), condition: 'attribute_not_exists(n)' });
    expect((await store.get('t', { key: { pk: 'p', sk: 'a' } }))?.n).toBe(1);
  });

  it('evaluates false for BETWEEN when the attribute is missing', async () => {
    const store = await seed([item('p', 'a')]); // no 'n' attribute
    await expect(
      store.put('t', { item: item('p', 'b'), condition: 'n BETWEEN :a AND :b', values: { ':a': 1, ':b': 3 } })
    ).rejects.toThrow(ConditionalCheckFailed);
  });

  it('evaluates false for begins_with when the attribute is missing', async () => {
    const store = await seed([item('p', 'a')]); // no 'str' attribute
    await expect(
      store.put('t', { item: item('p', 'b'), condition: 'begins_with(str, :prefix)', values: { ':prefix': 'a' } })
    ).rejects.toThrow(ConditionalCheckFailed);
  });

  it('removes an item outright, so a test can create a gap', async () => {
    const store = await seed([item('p', 'a')]);
    expect(store.unsafeDelete({ pk: 'p', sk: 'a' })).toBe(true);
    expect(store.unsafeDelete({ pk: 'p', sk: 'a' })).toBe(false);
  });

  it('refuses every operation once closed', async () => {
    const store = await seed([item('p', 'a')]);
    await store.close();
    await expect(store.get('t', { key: { pk: 'p', sk: 'a' } })).rejects.toThrow(/closed/);
    await expect(store.put('t', { item: item('p', 'b') })).rejects.toThrow(/closed/);
    await expect(store.delete('t', { key: { pk: 'p', sk: 'a' } })).rejects.toThrow(/closed/);
    await expect(store.query('t', { keyCondition: 'pk = :pk', values: { ':pk': 'p' } })).rejects.toThrow(/closed/);
    await expect(store.transactWrite('t', [{ kind: 'Put', request: { item: item('p', 'c') } }])).rejects.toThrow(/closed/);
  });
});

describe('the failures the adapters map', () => {
  it('describes a refused conditional write', () => {
    const failure = new ConditionalCheckFailed();
    expect(failure.name).toBe('ConditionalCheckFailed');
    expect(failure.code).toBe('SEQUENCE_CONFLICT');
    expect(failure.message).toMatch(/did not hold/);
    expect(new ConditionalCheckFailed('a custom reason').message).toBe('a custom reason');
  });

  it('describes a cancelled transaction positionally', () => {
    const failure = new TransactionCancelled([null, 'ConditionalCheckFailed']);
    expect(failure.name).toBe('TransactionCancelled');
    expect(failure.details).toEqual({ reasons: [null, 'ConditionalCheckFailed'] });
    expect(failure.cancelledBy('ConditionalCheckFailed')).toBe(true);
    expect(failure.cancelledBy('None')).toBe(false);
    expect(new TransactionCancelled([], 'a custom reason').message).toBe('a custom reason');
  });
});
