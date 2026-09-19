/**
 * Event construction: sequence assignment, hash chaining, authority assertion.
 *
 * SAFETY-CRITICAL (SPEC-00 section 8.1). This is the single point where an
 * event becomes part of the record of what happened. Everything the system can
 * later explain about itself depends on this being right.
 *
 * Adapters call `buildEvent` and then persist the result. They do not compute
 * sequences or hashes themselves — if two adapters did that independently they
 * would eventually disagree, and a ledger that verifies on SQLite but not on
 * DynamoDB is worse than one that verifies nowhere.
 */

import {
  assertAuthorityPermitted,
  CURRENT_EVENT_SCHEMA_VERSION,
  EventInput,
  GenesisEvent,
  newEventId,
  type EventId,
  type ProjectScope,
  SequenceConflictError,
  type Sha256Hex,
  ValidationError,
} from '@genesis/core-types';
import { hashEvent } from './hash.js';

/** The tip of a project's chain. */
export interface LedgerHead {
  readonly seq: number;
  readonly hash: Sha256Hex;
}

export interface BuildEventOptions {
  /** Injectable clock, for deterministic tests. */
  readonly now?: (() => Date) | undefined;
  /** Injectable id source, for deterministic tests. */
  readonly newId?: (() => EventId) | undefined;
}

/**
 * Builds the event that would be appended next.
 *
 * Pure: given the same scope, input, head and options it produces the same
 * event. All non-determinism is in the injectable clock and id source, which is
 * what makes the hash chain testable.
 */
export function buildEvent(
  scope: ProjectScope,
  input: unknown,
  head: LedgerHead | null,
  options: BuildEventOptions = {},
): GenesisEvent {
  const parsed = EventInput.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('invalid event input', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  const value = parsed.data;

  // ADR-0005 at the ledger boundary. Rejected rather than clamped: an event is
  // an immutable statement of what happened, so recording an authority the
  // caller did not ask for would make the ledger quietly disagree with its own
  // caller. Clamping belongs to proposals, where the claim is advisory.
  assertAuthorityPermitted(value.actor.kind, value.authority);

  const seq = head === null ? 1 : head.seq + 1;
  const prevHash = head === null ? null : head.hash;

  const now = options.now ?? ((): Date => new Date());
  const mintId = options.newId ?? newEventId;

  const withoutHash = {
    id: mintId(),
    projectId: scope.projectId,
    seq,
    schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
    type: value.type,
    actor: value.actor,
    subject: value.subject,
    before: value.before,
    after: value.after,
    cause: value.cause,
    cycleId: value.cycleId,
    authority: value.authority,
    payload: value.payload,
    timestamp: value.timestamp ?? now().toISOString(),
    prevHash,
  };

  const event = { ...withoutHash, payloadHash: hashEvent(withoutHash) };

  // Parse the finished event too. The construction above should always be
  // valid, so this is belt and braces — but the cost of a malformed event
  // entering an append-only store is permanent, and the cost of this check is
  // microseconds.
  const validated = GenesisEvent.safeParse(event);
  if (!validated.success) {
    throw new ValidationError('constructed event failed its own schema', {
      issues: validated.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return validated.data;
}

/** Options for a conditional append (ADR-0014 rule 4). */
export interface AppendOptions {
  /**
   * The sequence the caller believes is the project's head — 0 for "no events
   * yet". When the actual head differs, nothing is appended and the append
   * throws `SequenceConflictError`.
   *
   * This is optimistic concurrency. A caller that decided what to write by
   * reading state at seq N states that assumption here, so a write made on a
   * stale view fails cleanly instead of landing on top of someone else's.
   */
  readonly expectedLastSeq?: number | undefined;
}

/**
 * Enforces `expectedLastSeq`. Adapters call it INSIDE the critical section in
 * which they read the head and write, so the check and the write are atomic —
 * a check outside it would reopen exactly the race it exists to close.
 */
export function assertExpectedHead(
  scope: ProjectScope,
  head: LedgerHead | null,
  options: AppendOptions | undefined,
): void {
  const expected = options?.expectedLastSeq;
  if (expected === undefined) return;
  if (!Number.isInteger(expected) || expected < 0) {
    throw new ValidationError('expectedLastSeq must be a non-negative integer', {
      expectedLastSeq: expected,
    });
  }
  const actual = head?.seq ?? 0;
  if (actual !== expected) {
    throw new SequenceConflictError(
      `project ${scope.projectId} is at seq ${actual}, but the append expected ${expected}`,
      { projectId: scope.projectId, expectedLastSeq: expected, actualLastSeq: actual },
    );
  }
}

/** Computes the head that results from appending `event`. */
export function advanceHead(event: GenesisEvent): LedgerHead {
  return { seq: event.seq, hash: event.payloadHash };
}
