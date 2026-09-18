/**
 * In-memory EventLedger adapter.
 *
 * Exists for two reasons, both real:
 *   1. Tests of higher layers need a ledger without a file on disk.
 *   2. Having TWO adapters from the start is what proves the conformance suite
 *      is written against the PORT rather than against SQLite's behaviour. A
 *      suite with one implementation is that implementation's test file wearing
 *      a different name (ADR-0003).
 *
 * Not durable. Nothing here is a production store.
 */

import {
  assertInScope,
  type EventId,
  type GenesisEvent,
  type ProjectScope,
  ValidationError,
} from '@genesis/core-types';
import { advanceHead, buildEvent, type BuildEventOptions, type LedgerHead } from './append.js';
import { sha256Hex } from './hash.js';
import {
  type EventLedger,
  type ReadOptions,
  type ReplayOptions,
  type ReplaySummary,
  type ReplayVisitor,
  type TamperableLedger,
} from './port.js';
import {
  chainDigest,
  type SliceRange,
  type VerificationReport,
  verifyLedgerSlice,
} from './verify.js';

const DEFAULT_PAGE_SIZE = 1_000;

export interface InMemoryLedgerOptions extends BuildEventOptions {
  readonly pageSize?: number | undefined;
}

export class InMemoryEventLedger implements EventLedger, TamperableLedger {
  /** projectId -> events in ascending sequence order. */
  readonly #events = new Map<string, GenesisEvent[]>();

  /**
   * Per-project append queue.
   *
   * JavaScript is single-threaded, but `append` is async: two callers can
   * interleave across an await, both read the same head, and produce two events
   * claiming the same sequence. Appends within a project therefore serialise
   * through a promise chain. That serialisation is inherent to a hash chain —
   * ADR-0009 records it as a known cost, not an implementation accident.
   */
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #options: InMemoryLedgerOptions;
  #closed = false;

  constructor(options: InMemoryLedgerOptions = {}) {
    this.#options = options;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ValidationError('ledger is closed');
    }
  }

  #bucket(projectId: string): GenesisEvent[] {
    let bucket = this.#events.get(projectId);
    if (bucket === undefined) {
      bucket = [];
      this.#events.set(projectId, bucket);
    }
    return bucket;
  }

  #headOf(bucket: readonly GenesisEvent[]): LedgerHead | null {
    const last = bucket[bucket.length - 1];
    return last === undefined ? null : { seq: last.seq, hash: last.payloadHash };
  }

  /** Runs `task` after any in-flight append for the same project. */
  async #serialise<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(projectId) ?? Promise.resolve();
    const next = previous.then(task, task);
    // The queue itself swallows rejections, so one failed append does not
    // poison every later append for that project.
    this.#queues.set(
      projectId,
      next.catch(() => undefined),
    );
    return next;
  }

  async append(scope: ProjectScope, input: unknown): Promise<GenesisEvent> {
    const [event] = await this.appendMany(scope, [input]);
    if (event === undefined) {
      throw new ValidationError('append produced no event');
    }
    return event;
  }

  async appendMany(scope: ProjectScope, inputs: readonly unknown[]): Promise<GenesisEvent[]> {
    this.#assertOpen();
    if (inputs.length === 0) return [];

    return this.#serialise(scope.projectId, async () => {
      const bucket = this.#bucket(scope.projectId);
      let head: LedgerHead | null = this.#headOf(bucket);
      const built: GenesisEvent[] = [];

      // Build every event before storing any of them, so a validation failure
      // on the third input leaves nothing behind (port.ts: atomic appendMany).
      for (const input of inputs) {
        const event = buildEvent(scope, input, head, this.#options);
        built.push(event);
        head = advanceHead(event);
      }

      bucket.push(...built);
      return built.map((event) => ({ ...event }));
    });
  }

  async get(scope: ProjectScope, id: EventId): Promise<GenesisEvent | null> {
    this.#assertOpen();
    for (const bucket of this.#events.values()) {
      const found = bucket.find((event) => event.id === id);
      if (found !== undefined) {
        // Found, but possibly in another project: that is an error, not null.
        // Null would be indistinguishable from "no such event" and would hide
        // the scoping bug (ADR-0008 rule 6).
        assertInScope(scope, found.projectId, `event ${id}`);
        return { ...found };
      }
    }
    return null;
  }

  async at(scope: ProjectScope, seq: number): Promise<GenesisEvent | null> {
    this.#assertOpen();
    const found = this.#bucket(scope.projectId).find((event) => event.seq === seq);
    return found === undefined ? null : { ...found };
  }

  async read(scope: ProjectScope, options: ReadOptions = {}): Promise<GenesisEvent[]> {
    this.#assertOpen();
    const fromSeq = options.fromSeq ?? 1;
    const toSeq = options.toSeq ?? Number.MAX_SAFE_INTEGER;
    const limit = options.limit ?? this.#options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (limit <= 0) {
      throw new ValidationError('limit must be positive', { limit });
    }
    return this.#bucket(scope.projectId)
      .filter((event) => event.seq >= fromSeq && event.seq <= toSeq)
      .slice(0, limit)
      .map((event) => ({ ...event }));
  }

  async head(scope: ProjectScope): Promise<LedgerHead | null> {
    this.#assertOpen();
    return this.#headOf(this.#bucket(scope.projectId));
  }

  async count(scope: ProjectScope): Promise<number> {
    this.#assertOpen();
    return this.#bucket(scope.projectId).length;
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
    // Verification runs first: replaying corrupt history into a projection and
    // reporting the problem afterwards would mean the projection is already
    // wrong (ADR-0009 rule 5).
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
    this.#closed = true;
  }

  // ---- TamperableLedger: test-only, bypasses every guard ------------------

  async unsafeTamper(
    projectId: string,
    seq: number,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const bucket = this.#bucket(projectId);
    const index = bucket.findIndex((event) => event.seq === seq);
    const existing = bucket[index];
    if (index === -1 || existing === undefined) {
      throw new ValidationError(`no event at sequence ${seq}`, { projectId, seq });
    }
    bucket[index] = { ...existing, ...patch } as GenesisEvent;
  }

  async unsafeDelete(projectId: string, seq: number): Promise<void> {
    const bucket = this.#bucket(projectId);
    const index = bucket.findIndex((event) => event.seq === seq);
    if (index === -1) {
      throw new ValidationError(`no event at sequence ${seq}`, { projectId, seq });
    }
    bucket.splice(index, 1);
  }
}
