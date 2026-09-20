/**
 * Reading a DynamoDB stream record (SPEC-07 §3.2).
 *
 * The important decision here is what a stream record is *used for*. It is used
 * as a **signal**, never as a source: a record tells a consumer that project P
 * has history up to sequence N, and the consumer then reads those events from
 * the ledger.
 *
 * The alternative — unmarshalling the event out of the record's image and
 * acting on it — would make the stream a second copy of history, with its own
 * decoding path, its own bugs, and no hash chain. A consumer would then be
 * acting on something that looked like an event but had never been verified.
 * ADR-0004 says there is one system of record; this is what that means at the
 * point where something else is tempting.
 *
 * So only the keys are parsed, and only the keys are trusted.
 */

const LEDGER_PK = /^PRJ#(?<projectId>[^#]+)#LEDGER$/;
const EVENT_SK = /^EVT#(?<seq>\d{20})$/;

/** The shape Lambda delivers. Only the parts this module reads are declared. */
export interface StreamRecord {
  readonly eventID?: string;
  readonly eventName?: string;
  readonly dynamodb?: {
    readonly Keys?: Readonly<Record<string, { readonly S?: string }>>;
  };
}

export interface LedgerCoordinate {
  readonly projectId: string;
  readonly seq: number;
  /** The record's own id, for reporting a partial batch failure. */
  readonly itemIdentifier: string;
}

/**
 * The coordinates of a ledger event, or null for anything else.
 *
 * Null covers the majority of records on this stream: memory versions, graph
 * nodes, snapshots and the ledger head all live in the same table (ADR-0024
 * §1). A consumer of events must ignore them rather than guess at them.
 */
export function ledgerCoordinate(record: StreamRecord): LedgerCoordinate | null {
  const keys = record.dynamodb?.Keys;
  if (keys === undefined) return null;

  const partition = keys['pk']?.S ?? '';
  const sort = keys['sk']?.S ?? '';
  const project = LEDGER_PK.exec(partition);
  const event = EVENT_SK.exec(sort);
  if (project === null || event === null) return null;

  const { projectId } = project.groups as { projectId: string };
  const seq = Number((event.groups as { seq: string }).seq);
  // A sequence of 0 or a non-integer means the key was not written by the
  // adapter, so the record is not something this consumer understands.
  if (!Number.isSafeInteger(seq) || seq < 1) return null;

  return { projectId, seq, itemIdentifier: record.eventID ?? `${partition}|${sort}` };
}

export interface ProjectRange {
  readonly projectId: string;
  /** The lowest sequence this batch mentions. */
  readonly fromSeq: number;
  /** The highest. */
  readonly toSeq: number;
  /** Every record that contributed, so a failure can be reported precisely. */
  readonly itemIdentifiers: readonly string[];
}

/**
 * Groups a batch into one range per project.
 *
 * A batch can interleave projects, and handling them one record at a time would
 * mean one ledger read per event. Grouping means one read per project, and the
 * range is contiguous in practice because the stream preserves per-partition
 * order — but the consumer resumes from what it has stored rather than trusting
 * that, so a gap costs a longer read and never a wrong result.
 *
 * Only `INSERT` records count. The ledger is append-only, so a `MODIFY` on a
 * ledger item should be impossible; if one appears, it is not a new event and
 * folding it again would double-count.
 */
export function ledgerRanges(records: readonly StreamRecord[]): readonly ProjectRange[] {
  const ranges = new Map<string, { fromSeq: number; toSeq: number; itemIdentifiers: string[] }>();

  for (const record of records) {
    if (record.eventName !== undefined && record.eventName !== 'INSERT') continue;
    const coordinate = ledgerCoordinate(record);
    if (coordinate === null) continue;

    const existing = ranges.get(coordinate.projectId);
    if (existing === undefined) {
      ranges.set(coordinate.projectId, {
        fromSeq: coordinate.seq,
        toSeq: coordinate.seq,
        itemIdentifiers: [coordinate.itemIdentifier],
      });
      continue;
    }
    existing.fromSeq = Math.min(existing.fromSeq, coordinate.seq);
    existing.toSeq = Math.max(existing.toSeq, coordinate.seq);
    existing.itemIdentifiers.push(coordinate.itemIdentifier);
  }

  return [...ranges.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([projectId, range]) => ({ projectId, ...range }));
}

/** What Lambda expects back when a batch partly failed. */
export interface BatchResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}

export const batchFailures = (identifiers: readonly string[]): BatchResponse => ({
  batchItemFailures: [...new Set(identifiers)].sort().map((itemIdentifier) => ({ itemIdentifier })),
});
