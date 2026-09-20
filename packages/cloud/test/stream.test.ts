/**
 * Reading the stream.
 *
 * The property that matters: a stream record is a signal, and only its keys are
 * trusted. Nothing here decodes an event out of a record image, because that
 * would be a second, unverified copy of history.
 */

import { describe, expect, it } from 'vitest';
import { batchFailures, ledgerCoordinate, ledgerRanges, type StreamRecord } from '../src/stream.js';

const record = (pk: string, sk: string, extra: Partial<StreamRecord> = {}): StreamRecord => ({
  eventID: 'rec-1',
  eventName: 'INSERT',
  dynamodb: { Keys: { pk: { S: pk }, sk: { S: sk } } },
  ...extra,
});

const ledger = (projectId: string, seq: number, eventID = `rec-${seq}`): StreamRecord =>
  record(`PRJ#${projectId}#LEDGER`, `EVT#${String(seq).padStart(20, '0')}`, { eventID });

describe('recognising a ledger event', () => {
  it('reads the project and the sequence from the keys', () => {
    expect(ledgerCoordinate(ledger('prj-1', 42))).toEqual({ projectId: 'prj-1', seq: 42, itemIdentifier: 'rec-42' });
  });

  it('reads a large sequence without losing precision', () => {
    expect(ledgerCoordinate(ledger('prj-1', 1_000_000))?.seq).toBe(1_000_000);
  });

  it('ignores every other item kind in the table', () => {
    for (const [pk, sk] of [
      ['PRJ#prj-1#LEDGER', 'HEAD'],
      ['PRJ#prj-1#MEM#logical-1', 'VER#0000000001'],
      ['PRJ#prj-1#GRAPH', 'NODE#n-1'],
      ['PRJ#prj-1#SNAP', 'worldModel#0000000001'],
      ['EVTID#evt-1', 'EVT'],
      ['NODEID#n-1', 'PTR'],
    ]) {
      expect(ledgerCoordinate(record(pk as string, sk as string)), `${pk}/${sk}`).toBeNull();
    }
  });

  it('ignores a record with no keys at all', () => {
    expect(ledgerCoordinate({})).toBeNull();
    expect(ledgerCoordinate({ dynamodb: {} })).toBeNull();
    expect(ledgerCoordinate({ dynamodb: { Keys: {} } })).toBeNull();
  });

  it('refuses a sequence that is not a positive integer', () => {
    expect(ledgerCoordinate(record('PRJ#p#LEDGER', 'EVT#00000000000000000000'))).toBeNull();
    expect(ledgerCoordinate(record('PRJ#p#LEDGER', 'EVT#1'))).toBeNull();
    expect(ledgerCoordinate(record('PRJ#p#LEDGER', 'EVT#abcdefghijklmnopqrst'))).toBeNull();
  });

  it('refuses a partition key that is not a ledger partition', () => {
    expect(ledgerCoordinate(record('PRJ##LEDGER', 'EVT#00000000000000000001'))).toBeNull();
    expect(ledgerCoordinate(record('LEDGER', 'EVT#00000000000000000001'))).toBeNull();
    expect(ledgerCoordinate(record('PRJ#p#q#LEDGER', 'EVT#00000000000000000001'))).toBeNull();
  });

  it('falls back to the keys when the record carries no id', () => {
    const { eventID: _unnamed, ...anonymous } = ledger('prj-1', 3);
    expect(ledgerCoordinate(anonymous)?.itemIdentifier).toBe('PRJ#prj-1#LEDGER|EVT#00000000000000000003');
  });
});

describe('grouping a batch', () => {
  it('produces one range per project', () => {
    const ranges = ledgerRanges([ledger('prj-a', 1), ledger('prj-b', 7), ledger('prj-a', 5)]);
    expect(ranges).toEqual([
      { projectId: 'prj-a', fromSeq: 1, toSeq: 5, itemIdentifiers: ['rec-1', 'rec-5'] },
      { projectId: 'prj-b', fromSeq: 7, toSeq: 7, itemIdentifiers: ['rec-7'] },
    ]);
  });

  it('covers a batch that arrives out of order', () => {
    const [range] = ledgerRanges([ledger('p', 9), ledger('p', 2), ledger('p', 6)]);
    expect(range).toMatchObject({ fromSeq: 2, toSeq: 9 });
  });

  it('skips anything that is not a new ledger item', () => {
    const modified = { ...ledger('p', 1), eventName: 'MODIFY' };
    const removed = { ...ledger('p', 2), eventName: 'REMOVE' };
    expect(ledgerRanges([modified, removed])).toEqual([]);
  });

  it('accepts a record that does not say what happened to it', () => {
    const { eventName: _unsaid, ...unnamed } = ledger('p', 1);
    expect(ledgerRanges([unnamed])).toHaveLength(1);
  });

  it('returns nothing for an empty batch', () => {
    expect(ledgerRanges([])).toEqual([]);
  });

  it('orders the ranges, so a report reads the same way twice', () => {
    const ranges = ledgerRanges([ledger('prj-z', 1), ledger('prj-a', 1), ledger('prj-m', 1)]);
    expect(ranges.map((r) => r.projectId)).toEqual(['prj-a', 'prj-m', 'prj-z']);
  });
});

describe('reporting failures', () => {
  it('reports each failed record once', () => {
    expect(batchFailures(['b', 'a', 'b'])).toEqual({ batchItemFailures: [{ itemIdentifier: 'a' }, { itemIdentifier: 'b' }] });
  });

  it('reports nothing when the batch succeeded', () => {
    expect(batchFailures([])).toEqual({ batchItemFailures: [] });
  });
});
