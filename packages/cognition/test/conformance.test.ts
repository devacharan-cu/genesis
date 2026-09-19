/**
 * The shared suites, run against the in-memory ledger. The SQLite ledger runs
 * the identical engine suite from its own package (ADR-0003).
 *
 * The projector suite is ADR-0013's, unchanged: it is what proves the cognitive
 * state is rebuildable from the ledger — replay equals live, snapshot plus tail
 * equals full replay at every split, two folds agree, projects stay apart.
 */

import { CognitiveEngine, cognitionProjector } from '@genesis/cognition';
import { InMemoryEventLedger } from '@genesis/ledger';
import {
  countingIdSource,
  describeCognitionConformance,
  describeProjectorConformance,
  fixedClock,
  seedCognition,
} from '@genesis/testkit';

const createLedger = () => Promise.resolve(new InMemoryEventLedger());

describeProjectorConformance({
  name: 'cognition',
  projector: cognitionProjector,
  createLedger,
  seed: async (ledger, scope) => {
    await seedCognition(new CognitiveEngine(ledger, { ids: countingIdSource(), now: fixedClock() }), scope);
    return ledger.read(scope);
  },
});

describeCognitionConformance({ name: 'in-memory ledger', createLedger });
