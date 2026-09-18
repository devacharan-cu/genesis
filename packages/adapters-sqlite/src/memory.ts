/**
 * SQLite MemoryStore adapter (ADR-0003, ADR-0010).
 *
 * The record shape is stored column-per-field where the field is queryable and
 * JSON where it is a list, so that `project_id` leads every index (ADR-0008
 * rule 7) and the common filters do not require deserialising every row.
 *
 * Query matching itself is NOT reimplemented in SQL. Rows are narrowed by the
 * cheap indexed predicates and then passed through the shared `matchesQuery`
 * from @genesis/memory, so "what a default query returns" has one definition
 * across adapters. A second SQL implementation of that rule would eventually
 * drift, and the drift would show up as one backend hiding a contradiction the
 * other surfaced.
 */

import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';
import {
  assertInScope,
  type EventId,
  type MemoryId,
  type ProjectScope,
  ValidationError,
} from '@genesis/core-types';
import {
  buildRecord,
  type ContradictionResolution,
  type ContradictionSide,
  finishQuery,
  type LinkOutcome,
  matchesQuery,
  MemoryRecord,
  type MemoryLink,
  type MemoryLinkKind,
  type MemoryQuery,
  type MemoryStatus,
  type MemoryStore,
  type NewMemoryRecord,
  type Page,
  resolveContradiction,
  resolveSupersedes,
  type WriteContext,
} from '@genesis/memory';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof NodeSqlite;

type Database = NodeSqlite.DatabaseSync;
type StatementSync = NodeSqlite.StatementSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_records (
  project_id          TEXT    NOT NULL,
  id                  TEXT    NOT NULL,
  logical_id          TEXT    NOT NULL,
  class               TEXT    NOT NULL,
  type                TEXT    NOT NULL,
  content             TEXT    NOT NULL,
  authority           TEXT    NOT NULL,
  authority_requested TEXT    NOT NULL,
  authority_clamps    TEXT    NOT NULL,
  status              TEXT    NOT NULL,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  valid_from          TEXT    NOT NULL,
  valid_until         TEXT,
  version             INTEGER NOT NULL,
  previous_version    TEXT,
  source_refs         TEXT    NOT NULL,
  related_entities    TEXT    NOT NULL,
  evidence_refs       TEXT    NOT NULL,
  tags                TEXT    NOT NULL,
  produced_by_cycle   TEXT,
  produced_by_agent   TEXT,
  confidence          REAL,
  status_cause        TEXT,
  PRIMARY KEY (project_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS memory_records_logical_idx
  ON memory_records (project_id, logical_id, version);

CREATE INDEX IF NOT EXISTS memory_records_status_idx
  ON memory_records (project_id, status);

CREATE INDEX IF NOT EXISTS memory_records_class_idx
  ON memory_records (project_id, class, type);

CREATE INDEX IF NOT EXISTS memory_records_id_idx
  ON memory_records (id);

CREATE TABLE IF NOT EXISTS memory_links (
  project_id TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, from_id, to_id, kind)
) STRICT;

CREATE INDEX IF NOT EXISTS memory_links_to_idx
  ON memory_links (project_id, to_id);
`;

interface RecordRow {
  readonly project_id: string;
  readonly id: string;
  readonly logical_id: string;
  readonly class: string;
  readonly type: string;
  readonly content: string;
  readonly authority: string;
  readonly authority_requested: string;
  readonly authority_clamps: string;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly valid_from: string;
  readonly valid_until: string | null;
  readonly version: number;
  readonly previous_version: string | null;
  readonly source_refs: string;
  readonly related_entities: string;
  readonly evidence_refs: string;
  readonly tags: string;
  readonly produced_by_cycle: string | null;
  readonly produced_by_agent: string | null;
  readonly confidence: number | null;
  readonly status_cause: string | null;
}

interface LinkRow {
  readonly project_id: string;
  readonly from_id: string;
  readonly to_id: string;
  readonly kind: string;
  readonly created_at: string;
}

export interface SqliteMemoryStoreOptions {
  readonly location?: string | undefined;
}

export class SqliteMemoryStore implements MemoryStore {
  readonly #db: Database;
  #closed = false;

  readonly #insert: StatementSync;
  readonly #selectById: StatementSync;
  readonly #selectByLogical: StatementSync;
  readonly #selectByProject: StatementSync;
  readonly #updateStatus: StatementSync;
  readonly #insertLink: StatementSync;
  readonly #selectLinks: StatementSync;

  constructor(options: SqliteMemoryStoreOptions = {}) {
    this.#db = new DatabaseSync(options.location ?? ':memory:');
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);

    this.#insert = this.#db.prepare(
      `INSERT INTO memory_records
         (project_id, id, logical_id, class, type, content, authority, authority_requested,
          authority_clamps, status, created_at, updated_at, valid_from, valid_until, version,
          previous_version, source_refs, related_entities, evidence_refs, tags,
          produced_by_cycle, produced_by_agent, confidence, status_cause)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.#selectById = this.#db.prepare('SELECT * FROM memory_records WHERE id = ?');
    this.#selectByLogical = this.#db.prepare(
      'SELECT * FROM memory_records WHERE project_id = ? AND logical_id = ? ORDER BY version ASC',
    );
    this.#selectByProject = this.#db.prepare(
      'SELECT * FROM memory_records WHERE project_id = ?',
    );
    this.#updateStatus = this.#db.prepare(
      'UPDATE memory_records SET status = ?, updated_at = ?, status_cause = ? WHERE project_id = ? AND id = ?',
    );
    this.#insertLink = this.#db.prepare(
      `INSERT OR IGNORE INTO memory_links (project_id, from_id, to_id, kind, created_at)
       VALUES (?,?,?,?,?)`,
    );
    this.#selectLinks = this.#db.prepare(
      'SELECT * FROM memory_links WHERE project_id = ? AND (from_id = ? OR to_id = ?)',
    );
  }

  #assertOpen(): void {
    if (this.#closed) throw new ValidationError('memory store is closed');
  }

  #toRecord(row: RecordRow): MemoryRecord {
    const raw = {
      id: row.id,
      logicalId: row.logical_id,
      projectId: row.project_id,
      class: row.class,
      type: row.type,
      content: JSON.parse(row.content) as unknown,
      authority: row.authority,
      authorityRequested: row.authority_requested,
      authorityClamps: JSON.parse(row.authority_clamps) as unknown,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      version: row.version,
      previousVersion: row.previous_version,
      sourceRefs: JSON.parse(row.source_refs) as unknown,
      relatedEntities: JSON.parse(row.related_entities) as unknown,
      evidenceRefs: JSON.parse(row.evidence_refs) as unknown,
      tags: JSON.parse(row.tags) as unknown,
      producedByCycle: row.produced_by_cycle,
      producedByAgent: row.produced_by_agent,
      confidence: row.confidence,
      statusCause: row.status_cause,
    };

    const parsed = MemoryRecord.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError('stored memory record does not satisfy the current schema', {
        id: row.id,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return parsed.data;
  }

  #store(record: MemoryRecord): void {
    this.#insert.run(
      record.projectId,
      record.id,
      record.logicalId,
      record.class,
      record.type,
      JSON.stringify(record.content),
      record.authority,
      record.authorityRequested,
      JSON.stringify(record.authorityClamps),
      record.status,
      record.createdAt,
      record.updatedAt,
      record.validFrom,
      record.validUntil,
      record.version,
      record.previousVersion,
      JSON.stringify(record.sourceRefs),
      JSON.stringify(record.relatedEntities),
      JSON.stringify(record.evidenceRefs),
      JSON.stringify(record.tags),
      record.producedByCycle,
      record.producedByAgent,
      record.confidence,
      record.statusCause,
    );
  }

  #requireRecord(scope: ProjectScope, id: MemoryId): MemoryRecord {
    const row = this.#selectById.get(id) as RecordRow | undefined;
    if (row === undefined) throw new ValidationError(`no memory record ${id}`, { id });
    assertInScope(scope, row.project_id as ProjectScope['projectId'], `memory record ${id}`);
    return this.#toRecord(row);
  }

  async put(
    scope: ProjectScope,
    record: NewMemoryRecord,
    ctx: WriteContext,
  ): Promise<MemoryRecord> {
    this.#assertOpen();
    const built = buildRecord(scope, record, ctx);
    this.#store(built);
    return built;
  }

  async putVersion(
    scope: ProjectScope,
    logicalId: MemoryId,
    record: NewMemoryRecord,
    ctx: WriteContext,
  ): Promise<MemoryRecord> {
    this.#assertOpen();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const latest = this.#currentSync(scope, logicalId);
      if (latest === null) {
        throw new ValidationError(`no memory record with logical id ${logicalId}`, { logicalId });
      }
      const built = buildRecord(scope, record, ctx, {
        previous: { logicalId: latest.logicalId, id: latest.id, version: latest.version },
      });
      this.#store(built);
      this.#updateStatus.run(
        'SUPERSEDED',
        built.createdAt,
        latest.statusCause,
        scope.projectId,
        latest.id,
      );
      this.#db.exec('COMMIT');
      return built;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async get(scope: ProjectScope, id: MemoryId): Promise<MemoryRecord | null> {
    this.#assertOpen();
    const row = this.#selectById.get(id) as RecordRow | undefined;
    if (row === undefined) return null;
    assertInScope(scope, row.project_id as ProjectScope['projectId'], `memory record ${id}`);
    return this.#toRecord(row);
  }

  #currentSync(scope: ProjectScope, logicalId: MemoryId): MemoryRecord | null {
    const rows = this.#selectByLogical.all(scope.projectId, logicalId) as RecordRow[];
    const last = rows[rows.length - 1];
    return last === undefined ? null : this.#toRecord(last);
  }

  async current(scope: ProjectScope, logicalId: MemoryId): Promise<MemoryRecord | null> {
    this.#assertOpen();
    return this.#currentSync(scope, logicalId);
  }

  async history(scope: ProjectScope, logicalId: MemoryId): Promise<MemoryRecord[]> {
    this.#assertOpen();
    const rows = this.#selectByLogical.all(scope.projectId, logicalId) as RecordRow[];
    return rows.map((row) => this.#toRecord(row));
  }

  async query(scope: ProjectScope, q: MemoryQuery = {}): Promise<Page<MemoryRecord>> {
    this.#assertOpen();
    const rows = this.#selectByProject.all(scope.projectId) as RecordRow[];
    const matched = rows.map((row) => this.#toRecord(row)).filter((r) => matchesQuery(r, q));
    return finishQuery(matched, q);
  }

  async link(
    scope: ProjectScope,
    a: MemoryId,
    b: MemoryId,
    kind: MemoryLinkKind,
  ): Promise<LinkOutcome> {
    this.#assertOpen();
    if (a === b) {
      throw new ValidationError('a record cannot be linked to itself', { id: a, kind });
    }

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const left = this.#requireRecord(scope, a);
      const right = this.#requireRecord(scope, b);

      const sideOf = (r: MemoryRecord): ContradictionSide => ({
        id: r.id,
        authority: r.authority,
        status: r.status,
      });

      const resolution: ContradictionResolution =
        kind === 'CONTRADICTS'
          ? resolveContradiction(sideOf(left), sideOf(right))
          : resolveSupersedes(sideOf(left), sideOf(right));

      const at = new Date().toISOString();
      const link: MemoryLink = { projectId: scope.projectId, from: a, to: b, kind, createdAt: at };
      this.#insertLink.run(scope.projectId, a, b, kind, at);

      let reciprocal: MemoryLink | null = null;
      if (kind === 'CONTRADICTS') {
        reciprocal = { projectId: scope.projectId, from: b, to: a, kind, createdAt: at };
        this.#insertLink.run(scope.projectId, b, a, kind, at);
      }

      for (const change of resolution.changes) {
        const existing = this.#selectById.get(change.id) as RecordRow | undefined;
        if (existing === undefined) continue;
        this.#updateStatus.run(
          change.status,
          at,
          existing.status_cause,
          scope.projectId,
          change.id,
        );
      }

      this.#db.exec('COMMIT');
      return { link, reciprocal, resolution };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async links(scope: ProjectScope, id: MemoryId): Promise<MemoryLink[]> {
    this.#assertOpen();
    this.#requireRecord(scope, id);
    const rows = this.#selectLinks.all(scope.projectId, id, id) as LinkRow[];
    return rows.map((row) => ({
      projectId: row.project_id as MemoryLink['projectId'],
      from: row.from_id as MemoryId,
      to: row.to_id as MemoryId,
      kind: row.kind as MemoryLinkKind,
      createdAt: row.created_at,
    }));
  }

  async transition(
    scope: ProjectScope,
    id: MemoryId,
    status: MemoryStatus,
    cause: EventId | null,
  ): Promise<MemoryRecord> {
    this.#assertOpen();
    this.#requireRecord(scope, id);
    this.#updateStatus.run(status, new Date().toISOString(), cause, scope.projectId, id);
    return this.#requireRecord(scope, id);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
