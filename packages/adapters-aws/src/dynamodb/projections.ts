/**
 * The DynamoDB ProjectionSnapshotStore adapter (ADR-0024, ADR-0013).
 *
 * A snapshot is one item: the projection's identity, where in history it is,
 * its state, and the digest recorded beside it. The state is stored as the
 * CANONICAL serialisation (ADR-0009) rather than as whatever `JSON.stringify`
 * happened to emit, so an item written here and a row written by SQLite hash to
 * the same value. Without that, two backends would disagree about whether a
 * projection had changed and the divergence check would fire on a difference
 * that was never real.
 *
 * The write rules are NOT reimplemented here. They come from
 * `checkSnapshotWrite` in the port, so every adapter enforces one definition.
 */

import { type JsonValue, type ProjectId, type ProjectScope, type Sha256Hex } from '@genesis/core-types';
import { canonicalJson } from '@genesis/ledger';
import {
  checkSnapshotWrite,
  projectionDigest,
  type ProjectionSnapshot,
  type ProjectionSnapshotStore,
  type ProjectionState,
  toSnapshot,
} from '@genesis/projections';
import { type DynamoDbClient, type DynamoItem, queryAll } from './client.js';
import { snapshotPk, snapshotSk } from './schema.js';

export interface DynamoProjectionStoreOptions {
  readonly client: DynamoDbClient;
  readonly table: string;
  readonly now?: (() => string) | undefined;
}

const toItem = (snapshot: ProjectionSnapshot): DynamoItem => ({
  pk: snapshotPk(snapshot.projectId),
  sk: snapshotSk(snapshot.projection, snapshot.version),
  entity: 'SNAPSHOT',
  projectId: snapshot.projectId,
  projection: snapshot.projection,
  version: snapshot.version,
  lastSeq: snapshot.lastSeq,
  // Canonical, so the bytes are the same bytes every other adapter would store.
  state: canonicalJson(snapshot.state),
  digest: snapshot.digest,
  updatedAt: snapshot.updatedAt,
});

const hydrate = (item: DynamoItem): ProjectionSnapshot => ({
  projectId: item['projectId'] as ProjectId,
  projection: String(item['projection']),
  version: Number(item['version']),
  lastSeq: Number(item['lastSeq']),
  state: JSON.parse(String(item['state'])) as JsonValue,
  digest: item['digest'] as Sha256Hex,
  updatedAt: String(item['updatedAt']),
});

export class DynamoProjectionSnapshotStore implements ProjectionSnapshotStore {
  readonly #now: () => string;
  #closed = false;

  constructor(private readonly options: DynamoProjectionStoreOptions) {
    this.#now = options.now ?? ((): string => new Date().toISOString());
  }

  async load(scope: ProjectScope, projection: string, version: number): Promise<ProjectionSnapshot | null> {
    const item = await this.options.client.get(this.options.table, {
      key: { pk: snapshotPk(scope.projectId), sk: snapshotSk(projection, version) },
      consistentRead: true,
    });
    return item === null ? null : hydrate(item);
  }

  async save(scope: ProjectScope, projection: ProjectionState<JsonValue>): Promise<ProjectionSnapshot> {
    // Scoped by the caller's scope, not by the projection's own projectId, so a
    // projection from another project cannot be filed under this one (ADR-0008).
    const scoped: ProjectionState<JsonValue> = { ...projection, projectId: scope.projectId };
    const stored = await this.load(scope, scoped.projection, scoped.version);
    checkSnapshotWrite(stored, scoped, projectionDigest(scoped));

    const snapshot = toSnapshot(scoped, this.#now());
    await this.options.client.put(this.options.table, { item: toItem(snapshot) });
    return snapshot;
  }

  async list(scope: ProjectScope): Promise<ProjectionSnapshot[]> {
    // The sort key is `<projection>#<padded version>`, so ascending order is
    // already "by projection then version" and nothing is sorted afterwards.
    const items = await queryAll(this.options.client, this.options.table, {
      keyCondition: '#pk = :pk',
      names: { '#pk': 'pk' },
      values: { ':pk': snapshotPk(scope.projectId) },
      consistentRead: true,
    });
    return items.map(hydrate);
  }

  async drop(scope: ProjectScope, projection: string, version: number): Promise<boolean> {
    return this.options.client.delete(this.options.table, {
      key: { pk: snapshotPk(scope.projectId), sk: snapshotSk(projection, version) },
    });
  }

  async close(): Promise<void> {
    // The client is shared, so it is the composition root's to close.
    this.#closed = true;
  }

  /** Whether `close` has been called. The port has no such question; tests do. */
  get closed(): boolean {
    return this.#closed;
  }
}
