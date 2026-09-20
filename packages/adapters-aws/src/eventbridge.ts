/**
 * The EventBridge ledger fan-out (SPEC-07 §3.8, ADR-0025 §4).
 *
 * The ledger writer must not know who is listening. A notification, a scheduled
 * cycle and a reactive handler are all consumers of the same history, and
 * teaching the writer about each of them is how the core accumulates knowledge
 * of things it should not care about.
 *
 * So this is a one-way publisher downstream of the ledger, and it is
 * deliberately **not** an `EventLedger`. It cannot be mistaken for one and
 * cannot be substituted for one, and nothing reads from it: a consumer that
 * wanted history reads the ledger, because the bus is a notification and the
 * ledger is the record.
 *
 * Publication is best-effort by design. A failed publish must never fail the
 * append that preceded it — the event is already durable and already the truth,
 * and a consumer that missed a notification catches up from the ledger, which
 * is the whole reason the ledger is the system of record.
 */

import type { GenesisEvent } from '@genesis/core-types';

export interface EventBusEntry {
  readonly source: string;
  readonly detailType: string;
  readonly detail: string;
  readonly resources: readonly string[];
}

export interface EventBusClient {
  /** Returns how many entries the service refused, as PutEvents does. */
  putEvents(busName: string, entries: readonly EventBusEntry[]): Promise<number>;
  close(): Promise<void>;
}

/** EventBridge's own cap on one PutEvents call. */
export const MAX_ENTRIES_PER_PUT = 10;

export const GENESIS_EVENT_SOURCE = 'genesis.ledger';

export interface LedgerPublisherOptions {
  readonly client: EventBusClient;
  readonly busName: string;
  /** Reported rather than thrown, so a failed publish cannot fail an append. */
  readonly onFailure?: ((failed: number, entries: readonly EventBusEntry[]) => void) | undefined;
}

/**
 * What goes on the bus: enough to route on, and the coordinates of the rest.
 *
 * Not the payload. An event's payload can be large, may hold content that is
 * untrusted (SPEC-06 §6), and is already durable in the ledger. Copying it onto
 * a fan-out bus would put it somewhere with different retention and different
 * access control, so consumers get the coordinates and read what they need.
 */
export const entryFor = (event: GenesisEvent, busArn: string): EventBusEntry => ({
  source: GENESIS_EVENT_SOURCE,
  detailType: event.type,
  detail: JSON.stringify({
    projectId: event.projectId,
    seq: event.seq,
    eventId: event.id,
    type: event.type,
    actorKind: event.actor.kind,
    authority: event.authority,
    cycleId: event.cycleId,
    timestamp: event.timestamp,
  }),
  resources: [busArn],
});

export class LedgerEventPublisher {
  constructor(private readonly options: LedgerPublisherOptions) {}

  /**
   * Publishes a batch, in chunks the service accepts.
   *
   * Resolves with how many entries were refused rather than throwing: the
   * caller has already committed history, and there is nothing useful for it to
   * do with an exception.
   */
  async publish(events: readonly GenesisEvent[], busArn: string): Promise<number> {
    let refused = 0;
    for (let i = 0; i < events.length; i += MAX_ENTRIES_PER_PUT) {
      const chunk = events.slice(i, i + MAX_ENTRIES_PER_PUT).map((event) => entryFor(event, busArn));
      try {
        const failed = await this.options.client.putEvents(this.options.busName, chunk);
        refused += failed;
        if (failed > 0) this.options.onFailure?.(failed, chunk);
      } catch {
        // The bus being unreachable is an operational problem, not a
        // correctness one: the events are on the ledger and consumers catch up.
        refused += chunk.length;
        this.options.onFailure?.(chunk.length, chunk);
      }
    }
    return refused;
  }

  async close(): Promise<void> {
    await this.options.client.close();
  }
}

/** An in-process bus that records what was published, for tests. */
export class EventBusModel implements EventBusClient {
  readonly published: EventBusEntry[] = [];

  constructor(
    /** How many entries of each call to refuse, so the failure path is exercisable. */
    private readonly refuse = 0,
    private readonly unreachable = false,
  ) {}

  async putEvents(_busName: string, entries: readonly EventBusEntry[]): Promise<number> {
    if (this.unreachable) throw new Error('the bus is unreachable');
    this.published.push(...entries.slice(this.refuse));
    return Math.min(this.refuse, entries.length);
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
