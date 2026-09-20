/**
 * The DynamoDB EventLedger adapter (ADR-0024, SPEC-07 §3.1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is the cloud half of the append-only,
 * hash-chained record everything else in the system explains itself from.
 *
 * Three things carry the guarantee, and all three are in one transaction:
 *
 *   - **The head is an item in the ledger partition**, so reading it and
 *     conditioning on it happen in the same partition and the same transaction
 *     as the events being written.
 *   - **Every append is conditional on the head not having moved.** Two writers
 *     that read the same head produce two transactions with the same condition,
 *     and exactly one commits. The loser is a typed conflict, not a corrupted
 *     chain.
 *   - **Every event is written with `attribute_not_exists(pk)`**, so a retry
 *     that thinks it failed cannot overwrite a sequence that landed.
 *
 * Sequence assignment and hashing are not done here. `buildEvent` does them
 * (ADR-0009), shared with every other adapter, because two adapters computing
 * hashes independently would eventually disagree and a ledger that verifies on
 * SQLite but not on DynamoDB is worse than one that verifies nowhere.
 */

import {
  assertInScope,
  type EventId,
  GenesisEvent,
  type JsonValue,
  type ProjectId,
  type ProjectScope,
  SequenceConflictError,
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
import {
  CONDITIONAL_CHECK_FAILED,
  ConditionalCheckFailed,
  type DynamoDbClient,
  type DynamoItem,
  MAX_TRANSACT_ITEMS,
  queryAll,
  type TransactItem,
  TransactionCancelled,
} from './client.js';
import { EVENT_ID_SK, eventIdPk, eventSk, GSI1, HEAD_SK, ledgerPk, padSeq } from './schema.js';

const DEFAULT_PAGE_SIZE = 1_000;

/**
 * How many times an unconditional append re-reads the head after losing a race.
 *
 * Optimistic concurrency is the whole reason the head carries a condition: two
 * writers read the same head, one commits, and the other has to decide again
 * against what actually happened. Bounded, because an unbounded retry under
 * sustained contention is a hang rather than a wait — the same bound and the
 * same reasoning as the cognitive engine's (ADR-0014 rule 4).
 *
 * A *conditional* append never retries. The caller's `expectedLastSeq` is a
 * statement about the world it decided from, and re-deciding on its behalf
 * would apply a decision to state it never saw.
 */
export const MAX_APPEND_ATTEMPTS = 5;

/** A conditional write refused because something else got there first. */
const isLostRace = (error: unknown): boolean =>
  error instanceof ConditionalCheckFailed ||
  (error instanceof TransactionCancelled && error.cancelledBy(CONDITIONAL_CHECK_FAILED));

/**
 * One transaction item is spent on the head, so an atomic append carries at
 * most this many events (ADR-0024 §4). More is refused rather than split,
 * because splitting would break the all-or-nothing the port promises.
 */
export const MAX_EVENTS_PER_APPEND = MAX_TRANSACT_ITEMS - 1;

export interface DynamoLedgerOptions extends BuildEventOptions {
  readonly client: DynamoDbClient;
  readonly table: string;
  readonly pageSize?: number | undefined;
  readonly upcasters?: UpcastRegistry | undefined;
}

/** An event as the table holds it. JSON-valued attributes are stored as written. */
const toItem = (event: GenesisEvent): DynamoItem => ({
  pk: ledgerPk(event.projectId),
  sk: eventSk(event.seq),
  gsi1pk: eventIdPk(event.id),
  gsi1sk: EVENT_ID_SK,
  entity: 'LEDGER_EVENT',
  projectId: event.projectId,
  seq: event.seq,
  id: event.id,
  schemaVersion: event.schemaVersion,
  type: event.type,
  actor: event.actor,
  subject: event.subject,
  before: event.before,
  after: event.after,
  cause: event.cause,
  cycleId: event.cycleId,
  authority: event.authority,
  payload: event.payload,
  timestamp: event.timestamp,
  payloadHash: event.payloadHash,
  prevHash: event.prevHash,
});

const headItem = (projectId: string, head: LedgerHead): DynamoItem => ({
  pk: ledgerPk(projectId),
  sk: HEAD_SK,
  entity: 'LEDGER_HEAD',
  projectId,
  seq: head.seq,
  hash: head.hash,
});

export class DynamoEventLedger implements EventLedger, TamperableLedger {
  readonly #client: DynamoDbClient;
  readonly #table: string;
  readonly #upcasters: UpcastRegistry;
  readonly #queues = new Map<string, Promise<unknown>>();
  #closed = false;

  constructor(private readonly options: DynamoLedgerOptions) {
    this.#client = options.client;
    this.#table = options.table;
    this.#upcasters = options.upcasters ?? defaultUpcastRegistry;
  }

  #assertOpen(): void {
    if (this.#closed) throw new ValidationError('ledger is closed');
  }

  /**
   * Turns a stored item back into an event, through upcasting, so a stored v1
   * event stays readable after the schema moves on (ADR-0004).
   */
  #toEvent(item: DynamoItem): GenesisEvent {
    const upcast = this.#upcasters.upcast({
      id: item['id'],
      projectId: item['projectId'],
      seq: item['seq'],
      schemaVersion: item['schemaVersion'],
      type: item['type'],
      actor: item['actor'],
      subject: item['subject'] ?? null,
      before: item['before'] ?? null,
      after: item['after'] ?? null,
      cause: item['cause'] ?? null,
      cycleId: item['cycleId'] ?? null,
      authority: item['authority'],
      payload: item['payload'] ?? null,
      timestamp: item['timestamp'],
      payloadHash: item['payloadHash'],
      prevHash: item['prevHash'] ?? null,
    });
    const parsed = GenesisEvent.safeParse(upcast);
    if (!parsed.success) {
      throw new ValidationError('stored event does not satisfy the current schema', {
        id: String(item['id']),
        seq: Number(item['seq']),
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return parsed.data;
  }

  async append(scope: ProjectScope, input: unknown): Promise<GenesisEvent> {
    // `appendMany` returns one event per input and refuses an empty list, so
    // one input yields exactly one event.
    const [event] = await this.appendMany(scope, [input]);
    return event as GenesisEvent;
  }

  /**
   * Serialises this process's own writers per project.
   *
   * The conditional write is what makes an append safe against *another*
   * process. Against this one it is pure contention: twenty-five callers in one
   * process racing each other would have twenty-four of them lose a race they
   * created. The queue removes the self-inflicted half, the condition handles
   * the distributed half, and the bounded retry handles what is left.
   *
   * The same pattern the cognitive engine, the orchestrator and the agent
   * runtime already use, for the same reason.
   */
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

  async appendMany(scope: ProjectScope, inputs: readonly unknown[], options?: AppendOptions): Promise<GenesisEvent[]> {
    this.#assertOpen();
    if (inputs.length === 0) return [];
    return this.#serialise(scope.projectId, () => this.#appendMany(scope, inputs, options));
  }

  async #appendMany(
    scope: ProjectScope,
    inputs: readonly unknown[],
    options?: AppendOptions,
  ): Promise<GenesisEvent[]> {
    if (inputs.length > MAX_EVENTS_PER_APPEND) {
      throw new ValidationError(
        `an atomic append carries at most ${MAX_EVENTS_PER_APPEND} events; splitting it would not be atomic`,
        { requested: inputs.length, limit: MAX_EVENTS_PER_APPEND },
      );
    }

    // A caller that supplied a head is stating what it decided from, so losing
    // a race is its answer to have. One that did not is asking for an append,
    // and re-deciding against the head that actually won is what it wants.
    const conditional = options?.expectedLastSeq !== undefined;
    const attempts = conditional ? 1 : MAX_APPEND_ATTEMPTS;
    let lastSeen: number = 0;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const head = await this.head(scope);
      lastSeen = head?.seq ?? 0;
      // Checked before building, as every adapter does, so a conditional append
      // that was already stale fails without minting ids (ADR-0014 rule 4).
      assertExpectedHead(scope, head, options);
      try {
        return await this.#appendAgainst(scope, inputs, head);
      } catch (error) {
        if (!isLostRace(error)) throw error;
      }
    }
    throw new SequenceConflictError(
      conditional
        ? 'the ledger head moved between the read and the write'
        : `the ledger head moved under ${attempts} successive attempts`,
      { projectId: scope.projectId, expectedLastSeq: lastSeen, attempts },
    );
  }

  /** One attempt: build against this head, then land it or lose the race. */
  async #appendAgainst(
    scope: ProjectScope,
    inputs: readonly unknown[],
    head: LedgerHead | null,
  ): Promise<GenesisEvent[]> {
    // `appendMany` returns early for an empty list, so there is always at
    // least one event and therefore always a new head.
    let running: LedgerHead = head ?? { seq: 0, hash: '' as LedgerHead['hash'] };
    const built: GenesisEvent[] = [];
    for (const [index, input] of inputs.entries()) {
      const event = buildEvent(scope, input, index === 0 ? head : running, this.options);
      built.push(event);
      running = advanceHead(event);
    }

    const items: TransactItem[] = built.map((event) => ({
      kind: 'Put' as const,
      request: {
        item: toItem(event),
        // A retry that believes it failed must not overwrite a sequence that
        // landed. This is the guard that makes an append idempotent-safe.
        condition: 'attribute_not_exists(#pk)',
        names: { '#pk': 'pk' },
      },
    }));
    items.push({
      kind: 'Put',
      request: {
        item: headItem(scope.projectId, running),
        // The head must still be where it was when this append was built. Two
        // writers that read the same head produce the same condition, and
        // exactly one of them commits.
        condition: head === null ? 'attribute_not_exists(#pk)' : '#seq = :expected',
        names: head === null ? { '#pk': 'pk' } : { '#seq': 'seq' },
        ...(head === null ? {} : { values: { ':expected': head.seq } }),
      },
    });

    await this.#client.transactWrite(this.#table, items);
    return built;
  }

  async get(scope: ProjectScope, id: EventId): Promise<GenesisEvent | null> {
    this.#assertOpen();
    const found = await this.#client.query(this.#table, {
      index: GSI1,
      keyCondition: '#pk = :pk',
      names: { '#pk': 'gsi1pk' },
      values: { ':pk': eventIdPk(id) },
      limit: 1,
    });
    const item = found.items[0];
    if (item === undefined) return null;
    // Cross-project access is an error, not an empty result (ADR-0008 rule 6),
    // which is why the by-id index is global rather than scoped.
    assertInScope(scope, item['projectId'] as ProjectId, `event ${id}`);
    return this.#toEvent(item);
  }

  async at(scope: ProjectScope, seq: number): Promise<GenesisEvent | null> {
    this.#assertOpen();
    const item = await this.#client.get(this.#table, {
      key: { pk: ledgerPk(scope.projectId), sk: eventSk(seq) },
      consistentRead: true,
    });
    return item === null ? null : this.#toEvent(item);
  }

  async read(scope: ProjectScope, options: ReadOptions = {}): Promise<GenesisEvent[]> {
    this.#assertOpen();
    const fromSeq = options.fromSeq ?? 1;
    const toSeq = options.toSeq ?? Number.MAX_SAFE_INTEGER;
    const limit = options.limit ?? this.options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (limit <= 0) throw new ValidationError('limit must be positive', { limit });
    if (fromSeq > toSeq) return [];

    const request = {
      keyCondition: '#pk = :pk AND #sk BETWEEN :from AND :to',
      names: { '#pk': 'pk', '#sk': 'sk' },
      values: {
        ':pk': ledgerPk(scope.projectId),
        ':from': eventSk(fromSeq),
        // Bounded by the widest sequence the padding can express, so an
        // unbounded read is still a range read rather than a scan.
        ':to': `EVT#${padSeq(Math.min(toSeq, Number.MAX_SAFE_INTEGER))}`,
      },
      consistentRead: true,
    };
    // A caller that asked for everything gets everything, paged; one that asked
    // for a page gets exactly that page.
    const items =
      limit >= Number.MAX_SAFE_INTEGER
        ? await queryAll(this.#client, this.#table, request)
        : (await this.#client.query(this.#table, { ...request, limit })).items;
    return items.map((item) => this.#toEvent(item));
  }

  async head(scope: ProjectScope): Promise<LedgerHead | null> {
    this.#assertOpen();
    const item = await this.#client.get(this.#table, {
      key: { pk: ledgerPk(scope.projectId), sk: HEAD_SK },
      consistentRead: true,
    });
    if (item === null) return null;
    return { seq: Number(item['seq']), hash: item['hash'] as LedgerHead['hash'] };
  }

  async count(scope: ProjectScope): Promise<number> {
    this.#assertOpen();
    // From the head rather than by counting items: the head is one read and it
    // is the authority on how far the chain goes. A gap punched past the append
    // path shows up in `verify`, which is where it belongs.
    const head = await this.head(scope);
    if (head === null) return 0;
    const events = await queryAll(this.#client, this.#table, {
      keyCondition: '#pk = :pk AND begins_with(#sk, :prefix)',
      names: { '#pk': 'pk', '#sk': 'sk' },
      values: { ':pk': ledgerPk(scope.projectId), ':prefix': 'EVT#' },
      consistentRead: true,
    });
    return events.length;
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

  async replay(scope: ProjectScope, visit: ReplayVisitor, options: ReplayOptions = {}): Promise<ReplaySummary> {
    this.#assertOpen();
    const verification = options.verify === false ? null : await this.verify(scope, options);
    const events = await this.read(scope, { ...options, limit: Number.MAX_SAFE_INTEGER });
    for (const event of events) await visit(event);
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
    await this.#client.close();
  }

  // ---- TamperableLedger: test-only, bypasses the append path --------------

  /**
   * Writes an item directly, past every condition the adapter applies.
   *
   * This is how the conformance suite proves corruption is DETECTED rather than
   * merely prevented by a code path that could be bypassed. `EventLedger` has
   * no such method, so production code holding that type cannot reach it.
   */
  async unsafeTamper(projectId: string, seq: number, patch: Readonly<Record<string, unknown>>): Promise<void> {
    const key = { pk: ledgerPk(projectId), sk: eventSk(seq) };
    const existing = await this.#client.get(this.#table, { key, consistentRead: true });
    if (existing === null) throw new ValidationError('nothing stored to tamper with', { projectId, seq });

    const allowed = new Set([
      'type',
      'timestamp',
      'authority',
      'payloadHash',
      'prevHash',
      'seq',
      'after',
      'before',
      'payload',
    ]);
    const patched: DynamoItem = { ...existing };
    for (const [key_, value] of Object.entries(patch)) {
      // A typo in a test must not silently tamper with nothing.
      if (!allowed.has(key_)) throw new ValidationError(`unsafeTamper does not know how to patch "${key_}"`, { key: key_ });
      patched[key_] = value as JsonValue;
    }
    // A changed seq moves the item, so the old key is removed first.
    if (patched['seq'] !== existing['seq']) {
      await this.#client.delete(this.#table, { key });
      patched['sk'] = eventSk(Number(patched['seq']));
    }
    await this.#client.put(this.#table, { item: patched });
  }

  async unsafeDelete(projectId: string, seq: number): Promise<void> {
    await this.#client.delete(this.#table, { key: { pk: ledgerPk(projectId), sk: eventSk(seq) } });
  }
}
