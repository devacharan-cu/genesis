/**
 * The shared suites on the in-memory stores. The SQLite stores run the
 * identical orchestration suite from their own package (ADR-0003).
 *
 * The run projection is an ordinary ADR-0013 projector, so its replay laws —
 * replay equals live, snapshot plus tail equals full replay at every split,
 * determinism, isolation — come from the shared projector suite, seeded with
 * real orchestrated runs of every outcome.
 */

import { runsProjector } from '@genesis/core';
import { InMemoryGraphStore } from '@genesis/graph';
import { InMemoryEventLedger } from '@genesis/ledger';
import { InMemoryMemoryStore } from '@genesis/memory';
import { ReasoningError } from '@genesis/reasoning';
import {
  describeOrchestrationConformance,
  describeProjectorConformance,
  MIXED_PROPOSALS,
  rig,
  seedGoal,
  TASK,
} from '@genesis/testkit';

const createStores = () =>
  Promise.resolve({ ledger: new InMemoryEventLedger(), graph: new InMemoryGraphStore(), memory: new InMemoryMemoryStore() });

describeOrchestrationConformance({ name: 'in-memory stores', createStores });

describeProjectorConformance({
  name: 'runs',
  projector: runsProjector,
  createLedger: () => Promise.resolve(new InMemoryEventLedger()),
  seed: async (ledger, scope) => {
    const stores = { ledger, graph: new InMemoryGraphStore(), memory: new InMemoryMemoryStore() };
    const { engine, orchestrator } = rig(stores, [
      { output: MIXED_PROPOSALS },
      { error: new ReasoningError('TIMEOUT', 'slow') },
      { output: { not: 'an envelope' } },
    ]);
    await seedGoal(engine, scope);
    await orchestrator.run(scope, TASK);
    await orchestrator.run(scope, { ...TASK, id: 'task-2' });
    await orchestrator.run(scope, { ...TASK, id: 'task-3' });
    await orchestrator.run(scope, { ...TASK, id: 'task-4', budgetTokens: 5 });
    return ledger.read(scope);
  },
});
