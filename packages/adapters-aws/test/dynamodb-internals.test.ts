/**
 * The adapter paths the conformance suites cannot reach.
 *
 * Three kinds of thing live here. What a stored item looks like when it does
 * not satisfy the current schema, which a port can never produce but a schema
 * change or a hand-edited table can. The indexed traversal path, which is a
 * cost claim rather than a correctness one and is therefore never exercised by
 * a suite asserting answers. And the limits that exist so a caller is refused
 * rather than quietly given something weaker than it asked for.
 */

import { type EdgeId, type MemoryId, newEdgeId, newNodeId, newProjectId, type NodeId, projectScope, ValidationError } from '@genesis/core-types';
import { GraphEngine } from '@genesis/graph';
import { describe, expect, it } from 'vitest';
import { type DynamoDbClient, type DynamoItem, MAX_TRANSACT_ITEMS, queryAll, TransactionCancelled } from '../src/dynamodb/client.js';
import { DynamoGraphStorage, edgesTouching } from '../src/dynamodb/graph.js';
import { DynamoEventLedger, MAX_EVENTS_PER_APPEND } from '../src/dynamodb/ledger.js';
import { DynamoMemoryStore } from '../src/dynamodb/memory.js';
import { DynamoDbModel } from '../src/dynamodb/model.js';
import { DynamoProjectionSnapshotStore } from '../src/dynamodb/projections.js';
import {
  edgePointerPk,
  edgeSk,
  GENESIS_TABLE_SCHEMA,
  graphPk,
  ledgerPk,
  memoryPk,
  memoryVersionSk,
  nodePointerPk,
  nodeSk,
  POINTER_SK,
} from '../src/dynamodb/schema.js';

const TABLE = 'genesis-test';
const client = (): DynamoDbModel => new DynamoDbModel(GENESIS_TABLE_SCHEMA);

const humanEvent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'REQUIREMENT_CHANGED',
  actor: { kind: 'HUMAN', id: 'dev' },
  authority: 'HUMAN_DECISION',
  ...overrides,
});

describe('a stored event that does not satisfy the current schema', () => {
  it('is refused rather than returned as though it were an event', async () => {
    const model = client();
    const ledger = new DynamoEventLedger({ client: model, table: TABLE });
    const scope = projectScope(newProjectId());
    const event = await ledger.append(scope, humanEvent());

    // Written past the adapter, which is the only way this state arises: a
    // schema change, or somebody editing the table.
    model.unsafePut({
      pk: ledgerPk(scope.projectId),
      sk: `EVT#${String(event.seq).padStart(20, '0')}`,
      entity: 'LEDGER_EVENT',
      id: event.id,
      seq: event.seq,
      schemaVersion: 1,
      type: 42,
      actor: { kind: 'HUMAN', id: 'dev' },
      authority: 'HUMAN_DECISION',
      timestamp: event.timestamp,
      payloadHash: event.payloadHash,
      prevHash: null,
    });

    await expect(ledger.read(scope)).rejects.toThrow(/stored event does not satisfy/);
  });
});

describe('what an atomic append refuses', () => {
  const ledger = (): DynamoEventLedger => new DynamoEventLedger({ client: client(), table: TABLE });

  it('refuses more events than one transaction can carry', async () => {
    // One item is spent on the head, so the cap is one below the service's.
    expect(MAX_EVENTS_PER_APPEND).toBe(MAX_TRANSACT_ITEMS - 1);
    const many = Array.from({ length: MAX_EVENTS_PER_APPEND + 1 }, () => humanEvent());
    await expect(ledger().appendMany(projectScope(newProjectId()), many)).rejects.toThrow(
      /splitting it would not be atomic/,
    );
  });

  it('accepts exactly the cap', async () => {
    const many = Array.from({ length: MAX_EVENTS_PER_APPEND }, () => humanEvent());
    const appended = await ledger().appendMany(projectScope(newProjectId()), many);
    expect(appended).toHaveLength(MAX_EVENTS_PER_APPEND);
    expect(appended.at(-1)?.seq).toBe(MAX_EVENTS_PER_APPEND);
  });

  it('refuses a non-positive read limit rather than returning everything', async () => {
    const scope = projectScope(newProjectId());
    await expect(ledger().read(scope, { limit: 0 })).rejects.toThrow(/limit must be positive/);
    await expect(ledger().read(scope, { limit: -1 })).rejects.toThrow(ValidationError);
  });

  it('answers nothing for an empty range rather than querying for it', async () => {
    const store = ledger();
    const scope = projectScope(newProjectId());
    await store.append(scope, humanEvent());
    expect(await store.read(scope, { fromSeq: 5, toSeq: 2 })).toEqual([]);
  });
});

describe('the tampering hook', () => {
  const setup = async (): Promise<{ ledger: DynamoEventLedger; scope: ReturnType<typeof projectScope> }> => {
    const ledger = new DynamoEventLedger({ client: client(), table: TABLE });
    const scope = projectScope(newProjectId());
    await ledger.append(scope, humanEvent());
    return { ledger, scope };
  };

  it('refuses to tamper with something that is not there', async () => {
    const { ledger, scope } = await setup();
    await expect(ledger.unsafeTamper(scope.projectId, 99, { type: 'X' })).rejects.toThrow(/nothing stored to tamper/);
  });

  it('refuses a field it does not know how to patch, so a typo tampers with nothing', async () => {
    const { ledger, scope } = await setup();
    await expect(ledger.unsafeTamper(scope.projectId, 1, { nonsense: 'x' })).rejects.toThrow(
      /does not know how to patch/,
    );
  });

  it('moves the item when the sequence itself is changed', async () => {
    const { ledger, scope } = await setup();
    await ledger.unsafeTamper(scope.projectId, 1, { seq: 7 });
    expect(await ledger.at(scope, 1)).toBeNull();
    expect((await ledger.at(scope, 7))?.seq).toBe(7);
  });
});

describe('a stored memory record that does not satisfy the current schema', () => {
  it('is refused rather than returned', async () => {
    const model = client();
    const store = new DynamoMemoryStore({ client: model, table: TABLE });
    const scope = projectScope(newProjectId());
    const record = await store.put(
      scope,
      {
        class: 'SEMANTIC',
        type: 'fact',
        content: { statement: 'something' },
        authorityRequested: 'HUMAN_DECISION',
        sourceRefs: [{ kind: 'HUMAN', id: 'dev' }],
      },
      { actorKind: 'HUMAN', actorId: 'dev' },
    );

    model.unsafePut({
      pk: memoryPk(scope.projectId, record.logicalId),
      sk: memoryVersionSk(record.version),
      entity: 'MEMORY_VERSION',
      record: { ...record, class: 'NOT_A_CLASS' },
    });

    await expect(store.history(scope, record.logicalId)).rejects.toThrow(/stored memory record does not satisfy/);
  });

  it('refuses a record id that names nothing', async () => {
    const store = new DynamoMemoryStore({ client: client(), table: TABLE });
    const scope = projectScope(newProjectId());
    const absent = 'mem_00000000000000000000000000' as MemoryId;
    await expect(store.transition(scope, absent, 'SUPERSEDED', null)).rejects.toThrow(/no memory record/);
  });
});

describe('a stored graph item that does not satisfy the current schema', () => {
  const setup = async () => {
    const model = client();
    const storage = new DynamoGraphStorage({ client: model, table: TABLE });
    const scope = projectScope(newProjectId());
    return { model, storage, scope };
  };

  it('refuses a node that is no longer a node', async () => {
    const { model, storage, scope } = await setup();
    const id: NodeId = newNodeId();
    model.unsafePut({ pk: graphPk(scope.projectId), sk: nodeSk(id), entity: 'GRAPH_NODE', node: { id, broken: true } });
    model.unsafePut({ pk: nodePointerPk(id), sk: POINTER_SK, projectId: scope.projectId });
    await expect(storage.getNodeAnywhere(id)).rejects.toThrow(/stored graph node does not satisfy/);
  });

  it('refuses an edge that is no longer an edge', async () => {
    const { model, storage, scope } = await setup();
    const id: EdgeId = newEdgeId();
    model.unsafePut({ pk: graphPk(scope.projectId), sk: edgeSk(id), entity: 'GRAPH_EDGE', edge: { id, broken: true } });
    await expect(storage.loadEdges(scope)).rejects.toThrow(/stored graph edge does not satisfy/);
  });

  it('answers null for an id no pointer names', async () => {
    const { storage } = await setup();
    expect(await storage.getNodeAnywhere(newNodeId())).toBeNull();
    expect(await storage.getEdgeAnywhere(newEdgeId())).toBeNull();
  });

  it('answers null when the pointer outlived the item it names', async () => {
    const { model, storage, scope } = await setup();
    const id: NodeId = newNodeId();
    model.unsafePut({ pk: nodePointerPk(id), sk: POINTER_SK, projectId: scope.projectId });
    expect(await storage.getNodeAnywhere(id)).toBeNull();
  });
});

describe('the indexed traversal path', () => {
  /**
   * `edgesTouching` is the query the cost claim in ADR-0025 §1 rests on: one
   * index read per direction rather than a load of the project's edges. The
   * engine's own `edgesOf` returns the same answer, which is what the
   * conformance suite proves, so this checks the indexed path agrees with it.
   */
  it('finds an edge from either end, once, and agrees with the engine', async () => {
    const options = { client: client(), table: TABLE };
    const storage = new DynamoGraphStorage(options);
    const graph = new GraphEngine(storage);
    const scope = projectScope(newProjectId());

    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const b = await graph.addNode(scope, { type: 'COMPONENT', label: 'b' });
    const { edge } = await graph.addEdge(scope, { type: 'DEPENDS_ON', from: a.id, to: b.id, authority: 'EVIDENCE' });

    expect((await edgesTouching(options, scope, a.id)).map((e) => e.id)).toEqual([edge.id]);
    expect((await edgesTouching(options, scope, b.id)).map((e) => e.id)).toEqual([edge.id]);
    expect((await edgesTouching(options, scope, a.id)).map((e) => e.id)).toEqual(
      (await graph.edgesOf(scope, a.id)).map((e) => e.id),
    );
  });

  it('counts an edge that touches one node twice as one edge', async () => {
    const options = { client: client(), table: TABLE };
    const graph = new GraphEngine(new DynamoGraphStorage(options));
    const scope = projectScope(newProjectId());
    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const b = await graph.addNode(scope, { type: 'COMPONENT', label: 'b' });
    const { edge } = await graph.addEdge(scope, { type: 'DEPENDS_ON', from: a.id, to: b.id, authority: 'EVIDENCE' });
    // Both index reads return it when queried from the two ends; from one end
    // it must appear once.
    const touching = await edgesTouching(options, scope, a.id);
    expect(touching.filter((e) => e.id === edge.id)).toHaveLength(1);
  });

  it('finds nothing for a node with no edges', async () => {
    const options = { client: client(), table: TABLE };
    expect(await edgesTouching(options, projectScope(newProjectId()), newNodeId())).toEqual([]);
  });
});

describe('the snapshot store’s own state', () => {
  it('reports whether it has been closed, which the port does not ask', async () => {
    const store = new DynamoProjectionSnapshotStore({ client: client(), table: TABLE });
    expect(store.closed).toBe(false);
    await store.close();
    expect(store.closed).toBe(true);
  });

  it('leaves the shared client open, because the composition root owns it', async () => {
    const model = client();
    const store = new DynamoProjectionSnapshotStore({ client: model, table: TABLE });
    await store.close();
    // Still usable: another adapter shares this client.
    await expect(model.get(TABLE, { key: { pk: 'p', sk: 's' } })).resolves.toBeNull();
  });
});

describe('items the table holds', () => {
  it('keeps every entity kind under its own key, in one table', async () => {
    const model = client();
    const scope = projectScope(newProjectId());
    const ledger = new DynamoEventLedger({ client: model, table: TABLE });
    await ledger.append(scope, humanEvent());

    const kinds = new Set(model.unsafeItems().map((row: DynamoItem) => row['entity']));
    expect(kinds.has('LEDGER_EVENT')).toBe(true);
    expect(kinds.has('LEDGER_HEAD')).toBe(true);
  });
});

describe('paging every result out of a query', () => {
  /**
   * `queryAll` exists because a single query stops at a page boundary, and
   * returning a page as though it were the whole set is how a store starts
   * losing rows at scale. The cap exists because a client that always reports
   * more would otherwise loop forever.
   */
  const paging = (pages: number): DynamoDbClient => {
    let served = 0;
    return {
      get: async () => null,
      put: async () => undefined,
      delete: async () => false,
      query: async () => {
        served += 1;
        return {
          items: [{ pk: 'p', sk: `s${served}` }],
          lastEvaluatedKey: served < pages ? { pk: 'p', sk: `s${served}` } : null,
        };
      },
      transactWrite: async () => undefined,
      close: async () => undefined,
    };
  };

  it('reads every page, not only the first', async () => {
    const items = await queryAll(paging(3), TABLE, { keyCondition: 'pk = :pk', values: { ':pk': 'p' } });
    expect(items.map((row) => row['sk'])).toEqual(['s1', 's2', 's3']);
  });

  it('stops at one page when there is only one', async () => {
    expect(await queryAll(paging(1), TABLE, { keyCondition: 'pk = :pk', values: { ':pk': 'p' } })).toHaveLength(1);
  });

  it('continues from a start key it was given', async () => {
    const asked: unknown[] = [];
    const recording: DynamoDbClient = {
      ...paging(1),
      query: async (_table, request) => {
        asked.push(request.exclusiveStartKey);
        return { items: [], lastEvaluatedKey: null };
      },
    };
    await queryAll(recording, TABLE, {
      keyCondition: 'pk = :pk',
      values: { ':pk': 'p' },
      exclusiveStartKey: { pk: 'p', sk: 's0' },
    });
    expect(asked).toEqual([{ pk: 'p', sk: 's0' }]);
  });

  it('refuses to page forever when the client never finishes', async () => {
    const endless = paging(Number.MAX_SAFE_INTEGER);
    await expect(
      queryAll(endless, TABLE, { keyCondition: 'pk = :pk', values: { ':pk': 'p' } }, 3),
    ).rejects.toThrow(/paged past 3 pages/);
  });
});

describe('an append that is not an append', () => {
  it('writes nothing for a list with nothing in it', async () => {
    const ledger = new DynamoEventLedger({ client: client(), table: TABLE });
    const scope = projectScope(newProjectId());
    expect(await ledger.appendMany(scope, [])).toEqual([]);
    expect(await ledger.head(scope)).toBeNull();
  });
});

describe('when the head keeps moving', () => {
  /** A client whose conditional writes always lose, as a hot partition would. */
  const alwaysLoses = (reason: string): DynamoDbClient => {
    const model = client();
    return {
      get: (table, request) => model.get(table, request),
      put: (table, request) => model.put(table, request),
      delete: (table, request) => model.delete(table, request),
      query: (table, request) => model.query(table, request),
      transactWrite: async () => {
        throw new TransactionCancelled([reason, null]);
      },
      close: () => model.close(),
    };
  };

  it('gives up after a bounded number of attempts rather than looping', async () => {
    const ledger = new DynamoEventLedger({ client: alwaysLoses('ConditionalCheckFailed'), table: TABLE });
    await expect(ledger.append(projectScope(newProjectId()), humanEvent())).rejects.toThrow(
      /moved under 5 successive attempts/,
    );
  });

  it('does not retry an append the caller decided from a head', async () => {
    // A caller that stated what it decided from is asking for a conflict to be
    // reported, not for the decision to be made again against a newer head.
    const ledger = new DynamoEventLedger({ client: alwaysLoses('ConditionalCheckFailed'), table: TABLE });
    await expect(
      ledger.appendMany(projectScope(newProjectId()), [humanEvent()], { expectedLastSeq: 0 }),
    ).rejects.toThrow(/moved between the read and the write/);
  });

  it('lets a cancellation that is not a lost race surface as itself', async () => {
    const ledger = new DynamoEventLedger({ client: alwaysLoses('ItemCollectionSizeLimitExceeded'), table: TABLE });
    await expect(ledger.append(projectScope(newProjectId()), humanEvent())).rejects.toThrow(TransactionCancelled);
  });
});

describe('a graph pointer that outlived its edge', () => {
  it('answers null rather than failing to parse nothing', async () => {
    const model = client();
    const storage = new DynamoGraphStorage({ client: model, table: TABLE });
    const scope = projectScope(newProjectId());
    const id = newEdgeId();
    model.unsafePut({ pk: edgePointerPk(id), sk: POINTER_SK, projectId: scope.projectId });
    expect(await storage.getEdgeAnywhere(id)).toBeNull();
  });
});
