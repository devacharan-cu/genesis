/**
 * The DynamoDB MemoryStore adapter (ADR-0024, SPEC-07 §3.1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). Memory is where authority lives, and the two
 * rules SPEC-02 §5 ends on — a contradicted claim is marked, never replaced;
 * a superseded one is marked, never removed — are what this must not lose.
 *
 * Query matching is NOT reimplemented here. Records are read from the project's
 * partition and passed through the shared `matchesQuery`/`finishQuery` from
 * @genesis/memory, so "what a default query returns" has exactly one definition
 * across adapters. A second implementation of that rule would drift, and the
 * drift would show up as one backend hiding a contradiction the other surfaced.
 *
 * Each version is its own item under the logical record's partition, so
 * `history` is one query and `current` is the last item in it. Nothing is ever
 * overwritten except a status, which is the one field SPEC-02 permits to move.
 */

import { assertInScope, type EventId, type MemoryId, type ProjectId, type ProjectScope, ValidationError } from '@genesis/core-types';
import {
  buildRecord,
  type ContradictionResolution,
  type ContradictionSide,
  finishQuery,
  type LinkOutcome,
  matchesQuery,
  type MemoryLink,
  type MemoryLinkKind,
  type MemoryQuery,
  MemoryRecord,
  type MemoryStatus,
  type MemoryStore,
  type NewMemoryRecord,
  type Page,
  resolveContradiction,
  resolveSupersedes,
  type WriteContext,
} from '@genesis/memory';
import { type DynamoDbClient, type DynamoItem, queryAll, type TransactItem } from './client.js';
import {
  GSI1,
  MEMORY_ID_SK,
  memoryAllPk,
  memoryAllSk,
  memoryIdPk,
  memoryPk,
  memoryVersionSk,
} from './schema.js';

export interface DynamoMemoryOptions {
  readonly client: DynamoDbClient;
  readonly table: string;
  /** Injectable clock, so link and transition timestamps are deterministic. */
  readonly now?: (() => Date) | undefined;
}

const toItem = (record: MemoryRecord): DynamoItem => ({
  pk: memoryPk(record.projectId, record.logicalId),
  sk: memoryVersionSk(record.version),
  gsi1pk: memoryIdPk(record.id),
  gsi1sk: MEMORY_ID_SK,
  gsi2pk: memoryAllPk(record.projectId),
  gsi2sk: memoryAllSk(record.createdAt, record.id),
  entity: 'MEMORY_VERSION',
  record,
});

const linkItem = (link: MemoryLink): DynamoItem => ({
  pk: memoryPk(link.projectId, link.from),
  sk: `LINK#${link.kind}#${link.to}`,
  entity: 'MEMORY_LINK',
  link,
});

export class DynamoMemoryStore implements MemoryStore {
  readonly #client: DynamoDbClient;
  readonly #table: string;
  readonly #now: () => Date;
  readonly #queues = new Map<string, Promise<unknown>>();
  #closed = false;

  constructor(options: DynamoMemoryOptions) {
    this.#client = options.client;
    this.#table = options.table;
    this.#now = options.now ?? ((): Date => new Date());
  }

  #assertOpen(): void {
    if (this.#closed) throw new ValidationError('memory store is closed');
  }

  /** Serialised per project, for the same reason the ledger is. */
  async #serialise<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(projectId) ?? Promise.resolve();
    const run = previous.then(task);
    this.#queues.set(
      projectId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  #parse(item: DynamoItem): MemoryRecord {
    const parsed = MemoryRecord.safeParse(item['record']);
    if (!parsed.success) {
      throw new ValidationError('stored memory record does not satisfy the current schema', {
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return parsed.data;
  }

  /** Every version of a logical record, oldest first: the sort key is the version. */
  async #versions(scope: ProjectScope, logicalId: MemoryId): Promise<MemoryRecord[]> {
    const items = await queryAll(this.#client, this.#table, {
      keyCondition: '#pk = :pk AND begins_with(#sk, :prefix)',
      names: { '#pk': 'pk', '#sk': 'sk' },
      values: { ':pk': memoryPk(scope.projectId, logicalId), ':prefix': 'VER#' },
      consistentRead: true,
    });
    return items.map((item) => this.#parse(item));
  }

  /** One version by its own id, wherever it is, so a cross-project id can be refused. */
  async #byId(id: MemoryId): Promise<{ record: MemoryRecord; item: DynamoItem } | null> {
    const found = await this.#client.query(this.#table, {
      index: GSI1,
      keyCondition: '#pk = :pk',
      names: { '#pk': 'gsi1pk' },
      values: { ':pk': memoryIdPk(id) },
      limit: 1,
    });
    const item = found.items[0];
    return item === undefined ? null : { record: this.#parse(item), item };
  }

  async put(scope: ProjectScope, record: NewMemoryRecord, ctx: WriteContext): Promise<MemoryRecord> {
    this.#assertOpen();
    const built = buildRecord(scope, record, ctx);
    await this.#client.put(this.#table, { item: toItem(built) });
    return built;
  }

  async putVersion(
    scope: ProjectScope,
    logicalId: MemoryId,
    record: NewMemoryRecord,
    ctx: WriteContext,
  ): Promise<MemoryRecord> {
    this.#assertOpen();
    return this.#serialise(scope.projectId, async () => {
      const versions = await this.#versions(scope, logicalId);
      const latest = versions[versions.length - 1];
      if (latest === undefined) {
        throw new ValidationError(`no memory record with logical id ${logicalId}`, { logicalId });
      }
      const built = buildRecord(scope, record, ctx, {
        previous: { logicalId: latest.logicalId, id: latest.id, version: latest.version },
      });
      // Atomic: the new version and the previous one's SUPERSEDED status land
      // together, so there is never a moment with two current versions.
      const superseded: MemoryRecord = { ...latest, status: 'SUPERSEDED', updatedAt: built.createdAt };
      await this.#client.transactWrite(this.#table, [
        { kind: 'Put', request: { item: toItem(built) } },
        { kind: 'Put', request: { item: toItem(superseded) } },
      ]);
      return built;
    });
  }

  async get(scope: ProjectScope, id: MemoryId): Promise<MemoryRecord | null> {
    this.#assertOpen();
    const found = await this.#byId(id);
    if (found === null) return null;
    // Cross-project access is an error, not an empty result (ADR-0008 rule 6).
    assertInScope(scope, found.record.projectId as ProjectId, `memory record ${id}`);
    return found.record;
  }

  async current(scope: ProjectScope, logicalId: MemoryId): Promise<MemoryRecord | null> {
    this.#assertOpen();
    const versions = await this.#versions(scope, logicalId);
    return versions[versions.length - 1] ?? null;
  }

  async history(scope: ProjectScope, logicalId: MemoryId): Promise<MemoryRecord[]> {
    this.#assertOpen();
    return this.#versions(scope, logicalId);
  }

  async query(scope: ProjectScope, q: MemoryQuery = {}): Promise<Page<MemoryRecord>> {
    this.#assertOpen();
    // The project's records, then the shared filter. ADR-0024 §4 prices this:
    // it reads more than a targeted index would, and it is the only way the
    // answer stays identical to every other adapter's.
    const items = await queryAll(this.#client, this.#table, {
      index: 'gsi2',
      keyCondition: '#pk = :pk',
      names: { '#pk': 'gsi2pk' },
      values: { ':pk': memoryAllPk(scope.projectId) },
    });
    const matched = items.map((item) => this.#parse(item)).filter((record) => matchesQuery(record, q));
    return finishQuery(matched, q);
  }

  async #require(scope: ProjectScope, id: MemoryId): Promise<MemoryRecord> {
    const found = await this.#byId(id);
    if (found === null) throw new ValidationError(`no memory record ${id}`, { id });
    assertInScope(scope, found.record.projectId as ProjectId, `memory record ${id}`);
    return found.record;
  }

  async link(scope: ProjectScope, a: MemoryId, b: MemoryId, kind: MemoryLinkKind): Promise<LinkOutcome> {
    this.#assertOpen();
    if (a === b) throw new ValidationError('a record cannot be linked to itself', { id: a, kind });

    return this.#serialise(scope.projectId, async () => {
      const left = await this.#require(scope, a);
      const right = await this.#require(scope, b);
      const sideOf = (r: MemoryRecord): ContradictionSide => ({ id: r.id, authority: r.authority, status: r.status });
      const resolution: ContradictionResolution =
        kind === 'CONTRADICTS' ? resolveContradiction(sideOf(left), sideOf(right)) : resolveSupersedes(sideOf(left), sideOf(right));

      const at = this.#now().toISOString();
      const link: MemoryLink = { projectId: scope.projectId, from: a, to: b, kind, createdAt: at };
      const writes: TransactItem[] = [{ kind: 'Put', request: { item: linkItem(link) } }];

      let reciprocal: MemoryLink | null = null;
      if (kind === 'CONTRADICTS') {
        // Symmetric, so both sides are findable from either (SPEC-02 §5).
        reciprocal = { projectId: scope.projectId, from: b, to: a, kind, createdAt: at };
        writes.push({ kind: 'Put', request: { item: linkItem(reciprocal) } });
      }

      for (const change of resolution.changes) {
        // The resolver is given exactly these two sides, so a change can only
        // ever name one of them. Looking anything else up would be looking for
        // a record the resolver had no way to know about.
        const affected = change.id === left.id ? left : right;
        writes.push({ kind: 'Put', request: { item: toItem({ ...affected, status: change.status, updatedAt: at }) } });
      }

      // The link and every status it implies land together: a link recorded
      // without its resolution would leave the store saying two things.
      await this.#client.transactWrite(this.#table, writes);
      return { link, reciprocal, resolution };
    });
  }

  async links(scope: ProjectScope, id: MemoryId): Promise<MemoryLink[]> {
    this.#assertOpen();
    await this.#require(scope, id);
    // Links are stored under the record they come from, and CONTRADICTS writes
    // both directions, so one partition read finds every link touching it.
    const items = await queryAll(this.#client, this.#table, {
      keyCondition: '#pk = :pk AND begins_with(#sk, :prefix)',
      names: { '#pk': 'pk', '#sk': 'sk' },
      values: { ':pk': memoryPk(scope.projectId, id), ':prefix': 'LINK#' },
      consistentRead: true,
    });
    const outgoing = items.map((item) => item['link'] as MemoryLink);

    // SUPERSEDES is one-directional, so the reverse side is found by asking the
    // other record. Bounded by the project's records, which is what the SQLite
    // adapter's `to_id` index does with an index instead.
    const all = await queryAll(this.#client, this.#table, {
      index: 'gsi2',
      keyCondition: '#pk = :pk',
      names: { '#pk': 'gsi2pk' },
      values: { ':pk': memoryAllPk(scope.projectId) },
    });
    const incoming: MemoryLink[] = [];
    for (const item of all) {
      const record = this.#parse(item);
      if (record.id === id) continue;
      const theirs = await queryAll(this.#client, this.#table, {
        keyCondition: '#pk = :pk AND begins_with(#sk, :prefix)',
        names: { '#pk': 'pk', '#sk': 'sk' },
        values: { ':pk': memoryPk(scope.projectId, record.id), ':prefix': 'LINK#' },
        consistentRead: true,
      });
      for (const stored of theirs) {
        const link = stored['link'] as MemoryLink;
        if (link.to === id) incoming.push(link);
      }
    }
    return [...outgoing, ...incoming];
  }

  async transition(scope: ProjectScope, id: MemoryId, status: MemoryStatus, cause: EventId | null): Promise<MemoryRecord> {
    this.#assertOpen();
    const record = await this.#require(scope, id);
    const moved: MemoryRecord = { ...record, status, updatedAt: this.#now().toISOString(), statusCause: cause };
    await this.#client.put(this.#table, { item: toItem(moved) });
    return moved;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
  }
}
