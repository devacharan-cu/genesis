/**
 * The EventLedger port (ADR-0003, ADR-0004).
 *
 * The core depends on this interface, never on a database.
 *
 * Note what is ABSENT: there is no `update`, no `delete`, no `truncate`. That
 * is the append-only guarantee expressed in the type system — a caller cannot
 * express the operation. The hash chain (ADR-0009) covers the other half, where
 * someone reaches past this interface into the storage engine directly.
 *
 * Every method takes a `ProjectScope` first, so an unscoped read is not
 * expressible (ADR-0008).
 */

import {
  type EventId,
  type GenesisEvent,
  type ProjectScope,
  type Sha256Hex,
} from '@genesis/core-types';
import { type LedgerHead } from './append.js';
import { type VerificationReport } from './verify.js';

export { type LedgerHead } from './append.js';

export interface ReadOptions {
  /** First sequence to return, inclusive. Defaults to 1. */
  readonly fromSeq?: number | undefined;
  /** Last sequence to return, inclusive. Defaults to the head. */
  readonly toSeq?: number | undefined;
  /** Maximum events to return. Defaults to the adapter's page size. */
  readonly limit?: number | undefined;
}

export interface ReplaySummary {
  readonly projectId: string;
  readonly events: number;
  readonly lastSeq: number | null;
  /** Digest over the replayed slice; two equal digests mean identical history. */
  readonly digest: Sha256Hex;
  /**
   * Null when verification was explicitly skipped.
   *
   * Deliberately not a synthetic "ok" report: a caller that skipped the check
   * must not be handed something that reads as a passing one.
   */
  readonly verification: VerificationReport | null;
}

/** Called once per event during replay, in ascending sequence order. */
export type ReplayVisitor = (event: GenesisEvent) => void | Promise<void>;

export interface ReplayOptions extends ReadOptions {
  /**
   * Verify the chain while replaying. Defaults to true.
   *
   * Replay is when history is actually used, so it is the right moment to
   * notice corruption (ADR-0009 rule 5). Turning it off is for benchmarking,
   * not for production reads.
   */
  readonly verify?: boolean | undefined;
}

export interface EventLedger {
  /** Appends one event. The ledger assigns seq, id, timestamp and the hashes. */
  append(scope: ProjectScope, input: unknown): Promise<GenesisEvent>;

  /**
   * Appends several events atomically: all of them land, or none do.
   *
   * Partial application would leave a chain whose hashes are valid but whose
   * meaning is half a transaction, which is harder to diagnose than a clean
   * failure.
   */
  appendMany(scope: ProjectScope, inputs: readonly unknown[]): Promise<GenesisEvent[]>;

  /** Fetches by id. Throws ScopeMismatchError if the event belongs elsewhere. */
  get(scope: ProjectScope, id: EventId): Promise<GenesisEvent | null>;

  /** Fetches by sequence within the scoped project. */
  at(scope: ProjectScope, seq: number): Promise<GenesisEvent | null>;

  /** Reads a slice in ascending sequence order. */
  read(scope: ProjectScope, options?: ReadOptions): Promise<GenesisEvent[]>;

  /** The tip of the chain, or null when the project has no events yet. */
  head(scope: ProjectScope): Promise<LedgerHead | null>;

  /** Number of events in the scoped project. */
  count(scope: ProjectScope): Promise<number>;

  /** Verifies the chain, reporting the first failure and its sequence. */
  verify(scope: ProjectScope, options?: ReadOptions): Promise<VerificationReport>;

  /** Streams the chain in order, verifying as it goes by default. */
  replay(
    scope: ProjectScope,
    visit: ReplayVisitor,
    options?: ReplayOptions,
  ): Promise<ReplaySummary>;

  /** Releases resources. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Test-only tampering hook.
 *
 * The conformance suite has to prove that corruption is actually DETECTED, and
 * the only way to do that is to corrupt something. Adapters implement this by
 * writing past their own append path — raw SQL, or direct array mutation.
 *
 * Deliberately a separate interface from `EventLedger`: production code that
 * holds an `EventLedger` cannot reach this, because the type does not have it.
 */
export interface TamperableLedger {
  /** Overwrites stored columns of one event, bypassing every guard. */
  unsafeTamper(
    projectId: string,
    seq: number,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  /** Removes one event outright, creating a gap. */
  unsafeDelete(projectId: string, seq: number): Promise<void>;
}
