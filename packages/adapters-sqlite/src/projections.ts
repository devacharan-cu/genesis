/**
 * SQLite ProjectionSnapshotStore adapter (ADR-0003, ADR-0010, ADR-0013).
 *
 * A snapshot is one row: the projection's identity, where in history it is, its
 * state, and the digest recorded beside it. The state is stored as the CANONICAL
 * serialisation (ADR-0009), not as whatever `JSON.stringify` happened to emit,
 * so a row written by this adapter and a row written by any other hash to the
 * same value. Without that, two backends would disagree about whether a
 * projection had changed, and the divergence check would fire on a difference
 * that was never real.
 *
 * The write rules are NOT reimplemented in SQL. They come from
 * `checkSnapshotWrite` in the port, so both adapters enforce one definition.
 */

import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';
import {
  type JsonValue,
  type ProjectId,
  type ProjectScope,
  type Sha256Hex,
} from '@genesis/core-types';
import { canonicalJson } from '@genesis/ledger';
import {
  checkSnapshotWrite,
  type ProjectionSnapshot,
  type ProjectionSnapshotStore,
  type ProjectionState,
  projectionDigest,
  toSnapshot,
} from '@genesis/projections';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof NodeSqlite;

type Database = NodeSqlite.DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projection_snapshots (
  project_id TEXT    NOT NULL,
  projection TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  last_seq   INTEGER NOT NULL,
  state      TEXT    NOT NULL,
  digest     TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (project_id, projection, version)
) STRICT;
`;

interface SnapshotRow {
  readonly project_id: string;
  readonly projection: string;
  readonly version: number;
  readonly last_seq: number;
  readonly state: string;
  readonly digest: string;
  readonly updated_at: string;
}

export interface SqliteProjectionSnapshotStoreOptions {
  /** Database file, or ':memory:' (the default). */
  readonly location?: string;
  /** An existing connection to share with the other adapters. */
  readonly database?: Database;
  /** Injected so tests are not at the mercy of the wall clock. */
  readonly now?: () => string;
}

export class SqliteProjectionSnapshotStore implements ProjectionSnapshotStore {
  readonly #db: Database;
  readonly #ownsDb: boolean;
  readonly #now: () => string;
  #closed = false;

  constructor(options: SqliteProjectionSnapshotStoreOptions = {}) {
    this.#ownsDb = options.database === undefined;
    this.#db = options.database ?? new DatabaseSync(options.location ?? ':memory:');
    this.#now = options.now ?? ((): string => new Date().toISOString());
    this.#db.exec(SCHEMA);
  }

  load(scope: ProjectScope, projection: string, version: number): Promise<ProjectionSnapshot | null> {
    const row = this.#db
      .prepare(
        `SELECT project_id, projection, version, last_seq, state, digest, updated_at
           FROM projection_snapshots
          WHERE project_id = ? AND projection = ? AND version = ?`,
      )
      .get(scope.projectId, projection, version) as SnapshotRow | undefined;

    return Promise.resolve(row === undefined ? null : hydrate(row));
  }

  async save(
    scope: ProjectScope,
    projection: ProjectionState<JsonValue>,
  ): Promise<ProjectionSnapshot> {
    // Scoped by the caller's scope, not by the projection's own projectId, so a
    // projection from another project cannot be filed under this one (ADR-0008).
    const scoped: ProjectionState<JsonValue> = { ...projection, projectId: scope.projectId };
    const stored = await this.load(scope, scoped.projection, scoped.version);
    checkSnapshotWrite(stored, scoped, projectionDigest(scoped));

    const snapshot = toSnapshot(scoped, this.#now());
    this.#db
      .prepare(
        `INSERT INTO projection_snapshots
           (project_id, projection, version, last_seq, state, digest, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, projection, version) DO UPDATE SET
           last_seq   = excluded.last_seq,
           state      = excluded.state,
           digest     = excluded.digest,
           updated_at = excluded.updated_at`,
      )
      .run(
        snapshot.projectId,
        snapshot.projection,
        snapshot.version,
        snapshot.lastSeq,
        canonicalJson(snapshot.state),
        snapshot.digest,
        snapshot.updatedAt,
      );

    return snapshot;
  }

  list(scope: ProjectScope): Promise<ProjectionSnapshot[]> {
    const rows = this.#db
      .prepare(
        `SELECT project_id, projection, version, last_seq, state, digest, updated_at
           FROM projection_snapshots
          WHERE project_id = ?
          ORDER BY projection, version`,
      )
      .all(scope.projectId) as unknown as SnapshotRow[];

    return Promise.resolve(rows.map(hydrate));
  }

  drop(scope: ProjectScope, projection: string, version: number): Promise<boolean> {
    const result = this.#db
      .prepare(
        `DELETE FROM projection_snapshots
          WHERE project_id = ? AND projection = ? AND version = ?`,
      )
      .run(scope.projectId, projection, version);

    return Promise.resolve(Number(result.changes) > 0);
  }

  close(): Promise<void> {
    if (!this.#closed && this.#ownsDb) this.#db.close();
    this.#closed = true;
    return Promise.resolve();
  }
}

function hydrate(row: SnapshotRow): ProjectionSnapshot {
  return {
    projectId: row.project_id as ProjectId,
    projection: row.projection,
    version: row.version,
    lastSeq: row.last_seq,
    state: JSON.parse(row.state) as JsonValue,
    digest: row.digest as Sha256Hex,
    updatedAt: row.updated_at,
  };
}
