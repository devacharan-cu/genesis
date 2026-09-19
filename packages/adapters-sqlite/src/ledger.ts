/**
 * SQLite EventLedger adapter (ADR-0003, ADR-0010).
 *
 * Uses the built-in `node:sqlite`. This is the ONLY package permitted to import
 * it, enforced by tools/check-boundaries.mjs, so swapping the driver is a
 * change to one file rather than a migration.
 *
 * The experimental warning from `node:sqlite` is deliberately not suppressed
 * (ADR-0010 constraint 4): hiding it would mean forgetting the status of
 * something the project depends on.
 *
 * Every index leads with `project_id`, so project isolation holds at the
 * storage layer and not only in application code (ADR-0008 rule 7).
 */

import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';

/**
 * `node:sqlite` is loaded through createRequire rather than a static import.
 *
 * Vite — which Vitest builds on — derives its list of Node builtins from
 * `module.builtinModules`, and `sqlite` is absent from that list because the
 * module is still experimental, even though `module.isBuiltin('node:sqlite')`
 * returns true. Vite therefore strips the `node:` prefix and tries to load a
 * package called `sqlite`, which does not exist. Externalising it in the Vitest
 * config does not help: the prefix is gone before the externals list is
 * consulted.
 *
 * createRequire resolves through Node directly, so the bundler never sees the
 * specifier. The `import type` above is erased at compile time and costs
 * nothing at runtime.
 *
 * This is exactly the class of friction ADR-0010 accepted when it chose the
 * built-in driver over a native addon: fewer users have hit its edges. The
 * trade was one workaround like this against a compile toolchain in CI.
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof NodeSqlite;

type Database = NodeSqlite.DatabaseSync;
type StatementSync = NodeSqlite.StatementSync;
import {
  assertInScope,
  GenesisEvent,
  type EventId,
  type JsonValue,
  type ProjectScope,
  ValidationError,
} from '@genesis/core-types';
import {
  advanceHead,
  type AppendOptions,
  assertExpectedHead,
  type BuildEventOptions,
  buildEvent,
  chainDigest,
  defaultUpcastRegistry,
  type EventLedger,
  type LedgerHead,
  type ReadOptions,
  type ReplayOptions,
  type ReplaySummary,
  type ReplayVisitor,
  sha256Hex,
  type SliceRange,
  type TamperableLedger,
  type UpcastRegistry,
  type VerificationReport,
  verifyLedgerSlice,
} from '@genesis/ledger';

const DEFAULT_PAGE_SIZE = 1_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_events (
  project_id     TEXT    NOT NULL,
  seq            INTEGER NOT NULL,
  id             TEXT    NOT NULL,
  schema_version INTEGER NOT NULL,
  type           TEXT    NOT NULL,
  actor          TEXT    NOT NULL,
  subject        TEXT,
  before_value   TEXT    NOT NULL,
  after_value    TEXT    NOT NULL,
  cause          TEXT,
  cycle_id       TEXT,
  authority      TEXT    NOT NULL,
  payload        TEXT    NOT NULL,
  timestamp      TEXT    NOT NULL,
  payload_hash   TEXT    NOT NULL,
  prev_hash      TEXT,
  PRIMARY KEY (project_id, seq)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_project_id_idx
  ON ledger_events (project_id, id);

CREATE INDEX IF NOT EXISTS ledger_events_id_idx
  ON ledger_events (id);
`;

/** A row as stored. JSON columns are still strings here. */
interface LedgerRow {
  readonly project_id: string;
  readonly seq: number;
  readonly id: string;
  readonly schema_version: number;
  readonly type: string;
  readonly actor: string;
  readonly subject: string | null;
  readonly before_value: string;
  readonly after_value: string;
  readonly cause: string | null;
  readonly cycle_id: string | null;
  readonly authority: string;
  readonly payload: string;
  readonly timestamp: string;
  readonly payload_hash: string;
  readonly prev_hash: string | null;
}

export interface SqliteLedgerOptions extends BuildEventOptions {
  /** File path, or ':memory:' for an ephemeral database. */
  readonly location?: string | undefined;
  readonly pageSize?: number | undefined;
  readonly upcasters?: UpcastRegistry | undefined;
}

export class SqliteEventLedger implements EventLedger, TamperableLedger {
  readonly #db: Database;
  readonly #options: SqliteLedgerOptions;
  readonly #upcasters: UpcastRegistry;
  #closed = false;

  readonly #insert: StatementSync;
  readonly #selectHead: StatementSync;
  readonly #selectById: StatementSync;
  readonly #selectAt: StatementSync;
  readonly #selectRange: StatementSync;
  readonly #selectCount: StatementSync;

  constructor(options: SqliteLedgerOptions = {}) {
    this.#options = options;
    this.#upcasters = options.upcasters ?? defaultUpcastRegistry;
    this.#db = new DatabaseSync(options.location ?? ':memory:');
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);

    this.#insert = this.#db.prepare(
      `INSERT INTO ledger_events
         (project_id, seq, id, schema_version, type, actor, subject, before_value,
          after_value, cause, cycle_id, authority, payload, timestamp, payload_hash, prev_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.#selectHead = this.#db.prepare(
      `SELECT seq, payload_hash FROM ledger_events
        WHERE project_id = ? ORDER BY seq DESC LIMIT 1`,
    );
    this.#selectById = this.#db.prepare(`SELECT * FROM ledger_events WHERE id = ?`);
    this.#selectAt = this.#db.prepare(
      `SELECT * FROM ledger_events WHERE project_id = ? AND seq = ?`,
    );
    this.#selectRange = this.#db.prepare(
      `SELECT * FROM ledger_events
        WHERE project_id = ? AND seq >= ? AND seq <= ?
        ORDER BY seq ASC LIMIT ?`,
    );
    this.#selectCount = this.#db.prepare(
      `SELECT COUNT(*) AS n FROM ledger_events WHERE project_id = ?`,
    );
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ValidationError('ledger is closed');
    }
  }

  #rowToEvent(row: LedgerRow): GenesisEvent {
    const raw: Record<string, unknown> = {
      id: row.id,
      projectId: row.project_id,
      seq: row.seq,
      schemaVersion: row.schema_version,
      type: row.type,
      actor: JSON.parse(row.actor) as unknown,
      subject: row.subject === null ? null : (JSON.parse(row.subject) as unknown),
      before: JSON.parse(row.before_value) as unknown,
      after: JSON.parse(row.after_value) as unknown,
      cause: row.cause,
      cycleId: row.cycle_id,
      authority: row.authority,
      payload: JSON.parse(row.payload) as unknown,
      timestamp: row.timestamp,
      payloadHash: row.payload_hash,
      prevHash: row.prev_hash,
    };

    // Every read passes through upcasting, so a stored v1 event stays readable
    // after the schema moves on (ADR-0004).
    const upcast = this.#upcasters.upcast(raw);

    const parsed = GenesisEvent.safeParse(upcast);
    if (!parsed.success) {
      throw new ValidationError('stored event does not satisfy the current schema', {
        id: row.id,
        seq: row.seq,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return parsed.data;
  }

  #store(event: GenesisEvent): void {
    this.#insert.run(
      event.projectId,
      event.seq,
      event.id,
      event.schemaVersion,
      event.type,
      JSON.stringify(event.actor),
      event.subject === null ? null : JSON.stringify(event.subject),
      JSON.stringify(event.before),
      JSON.stringify(event.after),
      event.cause,
      event.cycleId,
      event.authority,
      JSON.stringify(event.payload),
      event.timestamp,
      event.payloadHash,
      event.prevHash,
    );
  }

  #headSync(projectId: string): LedgerHead | null {
    const row = this.#selectHead.get(projectId) as
      | { seq: number; payload_hash: string }
      | undefined;
    return row === undefined ? null : { seq: row.seq, hash: row.payload_hash as LedgerHead['hash'] };
  }

  async append(scope: ProjectScope, input: unknown): Promise<GenesisEvent> {
    const [event] = await this.appendMany(scope, [input]);
    if (event === undefined) {
      throw new ValidationError('append produced no event');
    }
    return event;
  }

  async appendMany(
    scope: ProjectScope,
    inputs: readonly unknown[],
    options?: AppendOptions,
  ): Promise<GenesisEvent[]> {
    this.#assertOpen();
    if (inputs.length === 0) return [];

    // BEGIN IMMEDIATE takes the write lock up front, so the head read and the
    // inserts cannot interleave with another writer. A deferred transaction
    // would allow two writers to read the same head and then collide on the
    // primary key — correct, but as a late error rather than a clean wait.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      let head = this.#headSync(scope.projectId);
      // Under the write lock, so the conditional check and the inserts are one
      // atomic step; a failed check rolls back through the catch below.
      assertExpectedHead(scope, head, options);
      const built: GenesisEvent[] = [];
      for (const input of inputs) {
        const event = buildEvent(scope, input, head, this.#options);
        built.push(event);
        head = advanceHead(event);
      }
      for (const event of built) {
        this.#store(event);
      }
      this.#db.exec('COMMIT');
      return built;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async get(scope: ProjectScope, id: EventId): Promise<GenesisEvent | null> {
    this.#assertOpen();
    const row = this.#selectById.get(id) as LedgerRow | undefined;
    if (row === undefined) return null;
    // Cross-project access is an error, not an empty result (ADR-0008 rule 6).
    assertInScope(scope, row.project_id as ProjectScope['projectId'], `event ${id}`);
    return this.#rowToEvent(row);
  }

  async at(scope: ProjectScope, seq: number): Promise<GenesisEvent | null> {
    this.#assertOpen();
    const row = this.#selectAt.get(scope.projectId, seq) as LedgerRow | undefined;
    return row === undefined ? null : this.#rowToEvent(row);
  }

  async read(scope: ProjectScope, options: ReadOptions = {}): Promise<GenesisEvent[]> {
    this.#assertOpen();
    const fromSeq = options.fromSeq ?? 1;
    const toSeq = options.toSeq ?? Number.MAX_SAFE_INTEGER;
    const limit = options.limit ?? this.#options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (limit <= 0) {
      throw new ValidationError('limit must be positive', { limit });
    }
    const rows = this.#selectRange.all(scope.projectId, fromSeq, toSeq, limit) as LedgerRow[];
    return rows.map((row) => this.#rowToEvent(row));
  }

  async head(scope: ProjectScope): Promise<LedgerHead | null> {
    this.#assertOpen();
    return this.#headSync(scope.projectId);
  }

  async count(scope: ProjectScope): Promise<number> {
    this.#assertOpen();
    const row = this.#selectCount.get(scope.projectId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async verify(scope: ProjectScope, options: ReadOptions = {}): Promise<VerificationReport> {
    this.#assertOpen();
    return verifyLedgerSlice(
      scope,
      options,
      (range: SliceRange) => this.read(scope, { ...range, limit: Number.MAX_SAFE_INTEGER }),
      (seq: number) => this.at(scope, seq),
    );
  }

  async replay(
    scope: ProjectScope,
    visit: ReplayVisitor,
    options: ReplayOptions = {},
  ): Promise<ReplaySummary> {
    this.#assertOpen();
    const verification = options.verify === false ? null : await this.verify(scope, options);

    const events = await this.read(scope, { ...options, limit: Number.MAX_SAFE_INTEGER });
    for (const event of events) {
      await visit(event);
    }

    return {
      projectId: scope.projectId,
      events: events.length,
      lastSeq: events[events.length - 1]?.seq ?? null,
      digest: sha256Hex(chainDigest(events)),
      verification,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  // ---- TamperableLedger: test-only, bypasses the append path --------------

  /**
   * Writes directly to the table, past every guard the adapter provides.
   *
   * This is how the conformance suite proves corruption is DETECTED rather than
   * merely prevented by a code path that could be bypassed. `EventLedger` has
   * no such method, so production code holding that type cannot reach it.
   */
  async unsafeTamper(
    projectId: string,
    seq: number,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const columns: Record<string, string> = {
      type: 'type',
      timestamp: 'timestamp',
      authority: 'authority',
      payloadHash: 'payload_hash',
      prevHash: 'prev_hash',
      seq: 'seq',
    };
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (column === undefined) {
        // `after` and `payload` are JSON columns; everything else is rejected
        // so a typo in a test silently tampers with nothing.
        if (key === 'after' || key === 'payload' || key === 'before') {
          const sqlColumn = key === 'after' ? 'after_value' : key === 'before' ? 'before_value' : 'payload';
          this.#db
            .prepare(`UPDATE ledger_events SET ${sqlColumn} = ? WHERE project_id = ? AND seq = ?`)
            .run(JSON.stringify(value as JsonValue), projectId, seq);
          continue;
        }
        throw new ValidationError(`unsafeTamper does not know how to patch "${key}"`, { key });
      }
      this.#db
        .prepare(`UPDATE ledger_events SET ${column} = ? WHERE project_id = ? AND seq = ?`)
        .run(value as string | number, projectId, seq);
    }
  }

  async unsafeDelete(projectId: string, seq: number): Promise<void> {
    this.#db
      .prepare('DELETE FROM ledger_events WHERE project_id = ? AND seq = ?')
      .run(projectId, seq);
  }
}
