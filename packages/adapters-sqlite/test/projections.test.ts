/**
 * The SQLite snapshot adapter runs the identical conformance suite as the
 * in-memory one (ADR-0003). Two implementations, one suite, is what makes
 * "interchangeable" a demonstrated property.
 *
 * The second block is the end-to-end claim of ADR-0013: a projection rebuilt
 * from the ledger, stored through SQLite, read back and resumed, is the same
 * projection as one folded in a single pass — compared by digest.
 */

import { SqliteProjectionSnapshotStore } from '@genesis/adapters-sqlite';
import { newNodeId, newProjectId, projectScope } from '@genesis/core-types';
import { InMemoryEventLedger } from '@genesis/ledger';
import {
  projectionDigest,
  replayProjection,
  restoreProjection,
  resumeProjection,
  worldModelProjector,
} from '@genesis/projections';
import { describeProjectionSnapshotStoreConformance } from '@genesis/testkit';
import { describe, expect, it } from 'vitest';

describeProjectionSnapshotStoreConformance({
  name: 'sqlite',
  create: () => Promise.resolve(new SqliteProjectionSnapshotStore()),
});

describe('replay, store, resume: end to end through SQLite', () => {
  it('rebuilds the same projection it snapshotted', async () => {
    const ledger = new InMemoryEventLedger();
    const store = new SqliteProjectionSnapshotStore({ now: () => '2026-01-01T00:00:00.000Z' });
    const scope = projectScope(newProjectId());
    const node = newNodeId();

    const observe = (statement: string): Record<string, unknown> => ({
      type: 'WORLD_FACT_OBSERVED',
      actor: { kind: 'SYSTEM', id: 'test' },
      authority: 'EVIDENCE',
      subject: { nodeType: 'COMPONENT', nodeId: node },
      after: { statement },
    });

    await ledger.appendMany(scope, [observe('one'), observe('two'), observe('three')]);

    // Snapshot part of the way through.
    const partial = await replayProjection(worldModelProjector, scope, ledger, { toSeq: 2 });
    await store.save(scope, partial.projection);

    // More history arrives.
    await ledger.appendMany(scope, [observe('four'), observe('five')]);

    const loaded = await store.load(scope, worldModelProjector.name, worldModelProjector.version);
    expect(loaded).not.toBeNull();
    if (loaded === null) return;

    const restored = restoreProjection(scope, worldModelProjector, loaded);
    const resumed = await resumeProjection(worldModelProjector, restored, ledger);
    const fromScratch = await replayProjection(worldModelProjector, scope, ledger);

    expect(projectionDigest(resumed.projection)).toBe(projectionDigest(fromScratch.projection));
    expect(resumed.projection.lastSeq).toBe(5);

    await store.close();
    await ledger.close();
  });
});
