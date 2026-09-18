/**
 * The conformance suites, run against the in-memory implementations.
 *
 * The SQLite snapshot adapter runs the identical store suite from its own
 * package. That is what makes "the adapters are interchangeable" a
 * demonstrated property rather than an assertion (ADR-0003).
 */

import {
  InMemoryProjectionSnapshotStore,
  selfModelProjector,
  worldModelProjector,
} from '@genesis/projections';
import {
  describeProjectionSnapshotStoreConformance,
  describeProjectorConformance,
} from '@genesis/testkit';
import { createLedger, seedSelfModel, seedWorldModel } from './support.js';

describeProjectorConformance({
  name: 'worldModel',
  projector: worldModelProjector,
  createLedger,
  seed: seedWorldModel,
});

describeProjectorConformance({
  name: 'selfModel',
  projector: selfModelProjector,
  createLedger,
  seed: seedSelfModel,
});

describeProjectionSnapshotStoreConformance({
  name: 'in-memory',
  create: () => Promise.resolve(new InMemoryProjectionSnapshotStore()),
});
