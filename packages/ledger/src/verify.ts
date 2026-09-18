/**
 * Chain verification (ADR-0009 rule 3).
 *
 * SAFETY-CRITICAL (SPEC-00 section 8.1). This is what turns "append-only" from
 * a policy the code promises into a property anyone can check.
 *
 * It reports the FIRST failure and where, rather than a bare boolean. "The
 * ledger is corrupt" is not actionable; "event 47 does not match its hash" is.
 */

import { type GenesisEvent, type ProjectScope, ValidationError } from '@genesis/core-types';
import { hashEvent } from './hash.js';

export type ChainFailureReason =
  | 'SEQUENCE_GAP'
  | 'SEQUENCE_OUT_OF_ORDER'
  | 'WRONG_START_SEQUENCE'
  | 'HASH_MISMATCH'
  | 'BROKEN_LINK'
  | 'FOREIGN_PROJECT'
  | 'UNEXPECTED_GENESIS_LINK';

export interface ChainFailure {
  readonly seq: number;
  readonly reason: ChainFailureReason;
  readonly detail: string;
}

export interface VerificationReport {
  readonly ok: boolean;
  readonly checked: number;
  readonly firstSeq: number | null;
  readonly lastSeq: number | null;
  readonly failure: ChainFailure | null;
}

export interface VerifyOptions {
  /**
   * The sequence the supplied slice must start at. Defaults to 1.
   *
   * This must come from OUTSIDE the slice being verified. Deriving it from the
   * slice's own first event makes the check vacuous — it would then agree with
   * whatever it was given, including a tampered genesis event.
   */
  readonly expectedStartSeq?: number | undefined;
  /**
   * The `prevHash` the first supplied event must carry; null when the slice
   * starts at the beginning of the chain. Same rule: it comes from outside.
   */
  readonly expectedPrevHash?: string | null | undefined;
}

/**
 * Single constructor for every report, including the empty one.
 *
 * Three near-identical builders existed here at first, and the `?? null`
 * fallbacks in two of them were unreachable, because those two were only ever
 * called with a non-empty slice. Routing the empty case through the same
 * function makes those branches real rather than decorative — which matters,
 * because this module requires 100% branch coverage and dead branches would
 * otherwise have to be excluded by hand.
 */
function report(
  events: readonly GenesisEvent[],
  checked: number,
  failure: ChainFailure | null,
): VerificationReport {
  const first = events[0];
  const last = events[events.length - 1];
  return {
    ok: failure === null,
    checked,
    firstSeq: first === undefined ? null : first.seq,
    lastSeq: last === undefined ? null : last.seq,
    failure,
  };
}

export const emptyReport = (): VerificationReport => report([], 0, null);

/**
 * Verifies a contiguous slice of one project's chain.
 *
 * Events must be in ascending sequence order, which is how every adapter
 * returns them.
 */
export function verifyChain(
  scope: ProjectScope,
  events: readonly GenesisEvent[],
  options: VerifyOptions = {},
): VerificationReport {
  const expectedStartSeq = options.expectedStartSeq ?? 1;
  const expectedPrevHash = options.expectedPrevHash === undefined ? null : options.expectedPrevHash;

  if (events.length === 0) {
    return emptyReport();
  }

  let previous: GenesisEvent | null = null;
  let checked = 0;

  for (const event of events) {
    if (event.projectId !== scope.projectId) {
      return report(events, checked, {
        seq: event.seq,
        reason: 'FOREIGN_PROJECT',
        detail: `event belongs to project ${event.projectId}, not ${scope.projectId}`,
      });
    }

    if (previous === null) {
      if (event.seq !== expectedStartSeq) {
        return report(events, checked, {
          seq: event.seq,
          reason: 'WRONG_START_SEQUENCE',
          detail: `expected the slice to start at sequence ${expectedStartSeq}, found ${event.seq}`,
        });
      }
      if ((event.prevHash ?? null) !== expectedPrevHash) {
        return report(events, checked, {
          seq: event.seq,
          reason: expectedPrevHash === null ? 'UNEXPECTED_GENESIS_LINK' : 'BROKEN_LINK',
          detail:
            expectedPrevHash === null
              ? `the first event of a chain must have a null prevHash, found ${String(event.prevHash)}`
              : 'prevHash does not match the hash of the event before this slice',
        });
      }
    } else if (event.seq <= previous.seq) {
      return report(events, checked, {
        seq: event.seq,
        reason: 'SEQUENCE_OUT_OF_ORDER',
        detail: `sequence ${event.seq} follows ${previous.seq}`,
      });
    } else if (event.seq !== previous.seq + 1) {
      return report(events, checked, {
        seq: event.seq,
        reason: 'SEQUENCE_GAP',
        detail: `sequence jumps from ${previous.seq} to ${event.seq}; ${event.seq - previous.seq - 1} event(s) missing`,
      });
    } else if (event.prevHash !== previous.payloadHash) {
      return report(events, checked, {
        seq: event.seq,
        reason: 'BROKEN_LINK',
        detail: `prevHash does not match the payloadHash of event ${previous.seq}`,
      });
    }

    const { payloadHash, ...hashable } = event;
    if (hashEvent(hashable) !== payloadHash) {
      return report(events, checked, {
        seq: event.seq,
        reason: 'HASH_MISMATCH',
        detail: 'the event content does not match its recorded payloadHash',
      });
    }

    previous = event;
    checked += 1;
  }

  return report(events, checked, null);
}

export interface SliceRange {
  readonly fromSeq?: number | undefined;
  readonly toSeq?: number | undefined;
}

/**
 * Verifies a slice, establishing the expected start anchor from OUTSIDE it.
 *
 * Shared by every adapter. If each adapter worked out its own anchor they
 * would eventually differ, and a ledger that verifies on one backend but not
 * another is worse than one that verifies nowhere (ADR-0003).
 */
export async function verifyLedgerSlice(
  scope: ProjectScope,
  range: SliceRange,
  readSlice: (range: SliceRange) => Promise<GenesisEvent[]>,
  at: (seq: number) => Promise<GenesisEvent | null>,
): Promise<VerificationReport> {
  const fromSeq = range.fromSeq ?? 1;
  if (!Number.isInteger(fromSeq) || fromSeq < 1) {
    throw new ValidationError('fromSeq must be a positive integer', { fromSeq });
  }

  let anchor: VerifyOptions;
  if (fromSeq === 1) {
    anchor = { expectedStartSeq: 1, expectedPrevHash: null };
  } else {
    const predecessor = await at(fromSeq - 1);
    if (predecessor === null) {
      throw new ValidationError(
        `cannot verify from sequence ${fromSeq}: event ${fromSeq - 1} is missing, so there is nothing to anchor the slice to`,
        { fromSeq },
      );
    }
    anchor = { expectedStartSeq: fromSeq, expectedPrevHash: predecessor.payloadHash };
  }

  const events = await readSlice(range);
  if (events.length === 0) return emptyReport();
  return verifyChain(scope, events, anchor);
}

/** A digest over a chain slice, for comparing two reads cheaply. */
export function chainDigest(events: readonly GenesisEvent[]): string {
  return events.map((event) => event.payloadHash).join('');
}
