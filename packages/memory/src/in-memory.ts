/**
 * In-memory MemoryStore adapter.
 *
 * The second implementation exists so the conformance suite is proven to test
 * the PORT rather than SQLite's behaviour (ADR-0003). A suite with one
 * implementation is that implementation's test file under another name.
 *
 * Not durable.
 */

import {
  assertInScope,
  type EventId,
  type MemoryId,
  type ProjectScope,
  ValidationError,
} from '@genesis/core-types';
import { buildRecord } from './build.js';
import {
  type ContradictionResolution,
  type ContradictionSide,
  resolveContradiction,
  resolveSupersedes,
} from './contradiction.js';
import type { LinkOutcome, MemoryStore, WriteContext } from './port.js';
import { finishQuery, matchesQuery, type MemoryQuery, type Page } from './query.js';
import type {
  MemoryLink,
  MemoryLinkKind,
  MemoryRecord,
  MemoryStatus,
  NewMemoryRecord,
} from './record.js';

export class InMemoryMemoryStore implements MemoryStore {
  /** id -> record. One entry per VERSION. */
  readonly #records = new Map<string, MemoryRecord>();
  readonly #links: MemoryLink[] = [];
  /** Per-project write queue; see the ledger adapter for the same reasoning. */
  readonly #queues = new Map<string, Promise<unknown>>();
  #closed = false;

  #assertOpen(): void {
    if (this.#closed) throw new ValidationError('memory store is closed');
  }

  async #serialise<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(projectId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.#queues.set(
      projectId,
      next.catch(() => undefined),
    );
    return next;
  }

  #inScope(scope: ProjectScope): MemoryRecord[] {
    return [...this.#records.values()].filter((r) => r.projectId === scope.projectId);
  }

  #requireRecord(scope: ProjectScope, id: MemoryId): MemoryRecord {
    const found = this.#records.get(id);
    if (found === undefined) {
      throw new ValidationError(`no memory record ${id}`, { id });
    }
    assertInScope(scope, found.projectId, `memory record ${id}`);
    return found;
  }

  async put(
    scope: ProjectScope,
    record: NewMemoryRecord,
    ctx: WriteContext,
  ): Promise<MemoryRecord> {
    this.#assertOpen();
    return this.#serialise(scope.projectId, async () => {
      const built = buildRecord(scope, record, ctx);
      this.#records.set(built.id, built);
      return { ...built };
    });
  }

  async putVersion(
    scope: ProjectScope,
    logicalId: MemoryId,
    record: NewMemoryRecord,
    ctx: WriteContext,
  ): Promise<MemoryRecord> {
    this.#assertOpen();
    return this.#serialise(scope.projectId, async () => {
      const latest = this.#currentSync(scope, logicalId);
      if (latest === null) {
        throw new ValidationError(`no memory record with logical id ${logicalId}`, { logicalId });
      }
      const built = buildRecord(scope, record, ctx, {
        previous: { logicalId: latest.logicalId, id: latest.id, version: latest.version },
      });
      this.#records.set(built.id, built);
      // The previous version is marked, never rewritten or removed.
      this.#records.set(latest.id, { ...latest, status: 'SUPERSEDED', updatedAt: built.createdAt });
      return { ...built };
    });
  }

  async get(scope: ProjectScope, id: MemoryId): Promise<MemoryRecord | null> {
    this.#assertOpen();
    const found = this.#records.get(id);
    if (found === undefined) return null;
    assertInScope(scope, found.projectId, `memory record ${id}`);
    return { ...found };
  }

  #currentSync(scope: ProjectScope, logicalId: MemoryId): MemoryRecord | null {
    const versions = this.#inScope(scope).filter((r) => r.logicalId === logicalId);
    if (versions.length === 0) return null;
    return versions.reduce((best, r) => (r.version > best.version ? r : best));
  }

  async current(scope: ProjectScope, logicalId: MemoryId): Promise<MemoryRecord | null> {
    this.#assertOpen();
    const found = this.#currentSync(scope, logicalId);
    return found === null ? null : { ...found };
  }

  async history(scope: ProjectScope, logicalId: MemoryId): Promise<MemoryRecord[]> {
    this.#assertOpen();
    return this.#inScope(scope)
      .filter((r) => r.logicalId === logicalId)
      .sort((a, b) => a.version - b.version)
      .map((r) => ({ ...r }));
  }

  async query(scope: ProjectScope, q: MemoryQuery = {}): Promise<Page<MemoryRecord>> {
    this.#assertOpen();
    const matched = this.#inScope(scope).filter((r) => matchesQuery(r, q));
    const page = finishQuery(matched, q);
    return { ...page, items: page.items.map((r) => ({ ...r })) };
  }

  async link(
    scope: ProjectScope,
    a: MemoryId,
    b: MemoryId,
    kind: MemoryLinkKind,
  ): Promise<LinkOutcome> {
    this.#assertOpen();
    return this.#serialise(scope.projectId, async () => {
      if (a === b) {
        throw new ValidationError('a record cannot be linked to itself', { id: a, kind });
      }
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
      const link: MemoryLink = {
        projectId: scope.projectId,
        from: a,
        to: b,
        kind,
        createdAt: at,
      };
      this.#links.push(link);

      // CONTRADICTS is symmetric (SPEC-02 §5 step 2): both records carry it, so
      // neither side can be read without seeing the conflict.
      let reciprocal: MemoryLink | null = null;
      if (kind === 'CONTRADICTS') {
        reciprocal = { projectId: scope.projectId, from: b, to: a, kind, createdAt: at };
        this.#links.push(reciprocal);
      }

      for (const change of resolution.changes) {
        const record = this.#records.get(change.id);
        if (record === undefined) continue;
        this.#records.set(change.id, { ...record, status: change.status, updatedAt: at });
      }

      return { link, reciprocal, resolution };
    });
  }

  async links(scope: ProjectScope, id: MemoryId): Promise<MemoryLink[]> {
    this.#assertOpen();
    this.#requireRecord(scope, id);
    return this.#links
      .filter((l) => l.projectId === scope.projectId && (l.from === id || l.to === id))
      .map((l) => ({ ...l }));
  }

  async transition(
    scope: ProjectScope,
    id: MemoryId,
    status: MemoryStatus,
    cause: EventId | null,
  ): Promise<MemoryRecord> {
    this.#assertOpen();
    return this.#serialise(scope.projectId, async () => {
      const record = this.#requireRecord(scope, id);
      const updated: MemoryRecord = {
        ...record,
        status,
        statusCause: cause,
        updatedAt: new Date().toISOString(),
      };
      this.#records.set(id, updated);
      return { ...updated };
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
