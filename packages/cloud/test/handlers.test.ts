/**
 * The stream handlers, against a whole in-process deployment.
 *
 * These are not unit tests of a parser: events are appended through the real
 * DynamoDB ledger adapter, the stream records are what that write would
 * produce, and the handlers read back through the same adapter. What is being
 * checked is that a projection ends up where the ledger is, idempotently, and
 * that a failure is reported precisely enough for the rest of a batch to land.
 */

import { projectScope } from '@genesis/core-types';
import { worldModelProjector } from '@genesis/projections';
import { beforeEach, describe, expect, it } from 'vitest';
import { advanceProjection, DEPLOYED_PROJECTIONS, fanOutHandler, projectionHandler } from '../src/handlers.js';
import { deployment, type Deployment, humanEvent, ledgerRecord, ledgerWith, snapshotsWith } from './harness.js';

let d: Deployment;

beforeEach(() => {
  d = deployment();
});

const appendEvents = async (count: number): Promise<void> => {
  const scope = projectScope(d.projectId);
  for (let i = 0; i < count; i += 1) {
    await d.runtime.ledger.append(scope, humanEvent({ after: { index: i } }));
  }
};

const records = (count: number, projectId = d.projectId): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, i) => ledgerRecord(projectId, i + 1));

describe('the projection updater', () => {
  it('folds the ledger into a stored snapshot', async () => {
    await appendEvents(3);
    expect(await projectionHandler(d.runtime, { Records: records(3) })).toEqual({ batchItemFailures: [] });

    const snapshot = await d.runtime.snapshots.load(projectScope(d.projectId), worldModelProjector.name, worldModelProjector.version);
    expect(snapshot?.lastSeq).toBe(3);
  });

  it('advances every deployed projection, not only the first', async () => {
    await appendEvents(2);
    await projectionHandler(d.runtime, { Records: records(2) });
    for (const projector of DEPLOYED_PROJECTIONS) {
      const snapshot = await d.runtime.snapshots.load(projectScope(d.projectId), projector.name, projector.version);
      expect(snapshot?.lastSeq, projector.name).toBe(2);
    }
  });

  it('is idempotent: the same batch twice leaves the same state', async () => {
    await appendEvents(3);
    await projectionHandler(d.runtime, { Records: records(3) });
    const first = await d.runtime.snapshots.load(projectScope(d.projectId), worldModelProjector.name, worldModelProjector.version);

    await projectionHandler(d.runtime, { Records: records(3) });
    const second = await d.runtime.snapshots.load(projectScope(d.projectId), worldModelProjector.name, worldModelProjector.version);

    expect(second?.digest).toBe(first?.digest);
    expect(second?.lastSeq).toBe(first?.lastSeq);
  });

  it('catches up past a record that never arrived', async () => {
    await appendEvents(5);
    // Only the last record is delivered. The handler resumes from the stored
    // snapshot, not from the stream's position, so nothing is skipped.
    await projectionHandler(d.runtime, { Records: [ledgerRecord(d.projectId, 5)] });
    const snapshot = await d.runtime.snapshots.load(projectScope(d.projectId), worldModelProjector.name, worldModelProjector.version);
    expect(snapshot?.lastSeq).toBe(5);
  });

  it('ignores records for items that are not events', async () => {
    await appendEvents(1);
    const headRecord = { eventID: 'h', eventName: 'INSERT', dynamodb: { Keys: { pk: { S: `PRJ#${d.projectId}#LEDGER` }, sk: { S: 'HEAD' } } } };
    expect(await projectionHandler(d.runtime, { Records: [headRecord] })).toEqual({ batchItemFailures: [] });
    expect(await d.runtime.snapshots.load(projectScope(d.projectId), worldModelProjector.name, worldModelProjector.version)).toBeNull();
  });

  it('reports a key that is not a project id rather than guessing', async () => {
    const bogus = ledgerRecord('not a project id', 1, 'rec-bogus');
    expect(await projectionHandler(d.runtime, { Records: [bogus] })).toEqual({
      batchItemFailures: [{ itemIdentifier: 'rec-bogus' }],
    });
  });

  it('reports only the failed project’s records, so the rest of a batch lands', async () => {
    await appendEvents(2);
    const broken = {
      ...d.runtime,
      snapshots: snapshotsWith(d.runtime.snapshots, {
        load: async () => {
          throw new Error('the snapshot store is unavailable');
        },
      }),
    };
    const response = await projectionHandler(broken, { Records: [...records(2), ledgerRecord('other', 1, 'rec-other')] });
    expect(response.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(['rec-1', 'rec-2', 'rec-other']);
  });

  it('does nothing for an empty delivery', async () => {
    expect(await projectionHandler(d.runtime, {})).toEqual({ batchItemFailures: [] });
  });
});

describe('advancing one projection', () => {
  it('reports the sequence it reached', async () => {
    await appendEvents(4);
    const scope = projectScope(d.projectId);
    expect(await advanceProjection(worldModelProjector, scope, d.runtime.ledger, d.runtime.snapshots)).toBe(4);
  });

  it('writes no snapshot when there is nothing new to fold', async () => {
    await appendEvents(2);
    const scope = projectScope(d.projectId);
    await advanceProjection(worldModelProjector, scope, d.runtime.ledger, d.runtime.snapshots);

    let saves = 0;
    const counting = snapshotsWith(d.runtime.snapshots, {
      save: async (scope, projection) => {
        saves += 1;
        return d.runtime.snapshots.save(scope, projection);
      },
    });
    expect(await advanceProjection(worldModelProjector, scope, d.runtime.ledger, counting)).toBe(2);
    expect(saves).toBe(0);
  });

  it('starts from empty when nothing has been stored', async () => {
    const scope = projectScope(d.projectId);
    expect(await advanceProjection(worldModelProjector, scope, d.runtime.ledger, d.runtime.snapshots)).toBe(0);
  });
});

describe('the ledger fan-out', () => {
  it('publishes the coordinates of every event in the batch', async () => {
    await appendEvents(3);
    expect(await fanOutHandler(d.runtime, { Records: records(3) })).toEqual({ batchItemFailures: [] });
    expect(d.bus.published).toHaveLength(3);
    expect(d.bus.published.map((e) => JSON.parse(e.detail).seq)).toEqual([1, 2, 3]);
  });

  it('never puts a payload on the bus', async () => {
    const scope = projectScope(d.projectId);
    await d.runtime.ledger.append(scope, humanEvent({ after: { confidential: 'the body of the event' } }));
    await fanOutHandler(d.runtime, { Records: records(1) });
    expect(JSON.stringify(d.bus.published)).not.toContain('the body of the event');
  });

  it('addresses the configured bus', async () => {
    await appendEvents(1);
    await fanOutHandler(d.runtime, { Records: records(1) });
    expect(d.bus.published[0]?.resources).toEqual([d.runtime.config.eventBusArn]);
  });

  it('reports the batch when the bus refused an entry, because a retry is safe', async () => {
    await appendEvents(2);
    const refusing = { ...d.runtime, publisher: { ...d.runtime.publisher, publish: async () => 1 } as never };
    const response = await fanOutHandler(refusing, { Records: records(2) });
    expect(response.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(['rec-1', 'rec-2']);
  });

  it('reports the batch when the ledger could not be read', async () => {
    const broken = {
      ...d.runtime,
      ledger: ledgerWith(d.runtime.ledger, {
        read: async () => {
          throw new Error('unavailable');
        },
      }),
    };
    expect((await fanOutHandler(broken, { Records: records(1) })).batchItemFailures).toHaveLength(1);
  });

  it('reports a key that is not a project id', async () => {
    const response = await fanOutHandler(d.runtime, { Records: [ledgerRecord('not a project id', 1, 'rec-x')] });
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'rec-x' }]);
  });

  it('publishes nothing for an empty delivery', async () => {
    expect(await fanOutHandler(d.runtime, {})).toEqual({ batchItemFailures: [] });
    expect(d.bus.published).toEqual([]);
  });
});
