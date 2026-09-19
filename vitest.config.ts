import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * Safety-critical modules, per SPEC-00 section 8.1 (coverage policy).
 *
 * A module is safety-critical when a silent failure in it would let the system
 * believe something untrue, or let an untrusted component write truth. These
 * require 100% BRANCH coverage — every decision point exercised both ways —
 * not a line-coverage percentage, which rewards executing code rather than
 * testing its decisions.
 *
 * Adding a file here is a one-line change. Removing one requires an ADR,
 * because it reduces what the project guarantees.
 */
const SAFETY_CRITICAL = [
  'packages/ledger/src/append.ts', // sequence assignment + hash chain (ADR-0009)
  'packages/ledger/src/hash.ts', // canonical serialisation + hashing
  'packages/ledger/src/upcast.ts', // a wrong upcast silently rewrites history
  'packages/ledger/src/verify.ts', // integrity verification
  'packages/core-types/src/scope.ts', // project isolation enforcement (ADR-0008)
  'packages/core-types/src/authority.ts', // authority ordering and clamping (ADR-0005)
  'packages/memory/src/authority-policy.ts', // write-time authority ceilings (ADR-0011)
  'packages/memory/src/contradiction.ts', // contradiction preservation (SPEC-02 §5)
  'packages/memory/src/build.ts', // the only path to an effective authority
  'packages/graph/src/invariants.ts', // G1-G13 enforcement (SPEC-03 §4)
  'packages/graph/src/traversal.ts', // depth caps and project-scoped walks (G12)
  'packages/projections/src/apply.ts', // ordering, idempotency, scope (ADR-0013)
  'packages/projections/src/digest.ts', // the replay/live equivalence proof itself
  'packages/projections/src/port.ts', // snapshot write rules and restore checks
  'packages/projections/src/observations.ts', // what a projection did not understand
  'packages/projections/src/world-model.ts', // SPEC-01 3: the rebuildable world model
  'packages/projections/src/self-model.ts', // SPEC-01 4: capabilities are evidence-backed
  'packages/cognition/src/context.ts', // authority of cognitive events, the fold's payload gate
  'packages/cognition/src/decide.ts', // command validation and routing (ADR-0014)
  'packages/cognition/src/goals.ts', // SPEC-01 5: no goal satisfied that is not done
  'packages/cognition/src/beliefs.ts', // SPEC-01 6: the belief state ladder
  'packages/cognition/src/uncertainties.ts', // SPEC-01 7: unknowns never silently vanish
  'packages/cognition/src/contradictions.ts', // SPEC-01 8: both sides kept, no guessed ties
  'packages/cognition/src/engine.ts', // conditional append and retry (ADR-0014 rule 4)
];

const safetyCriticalThresholds = Object.fromEntries(
  SAFETY_CRITICAL.map((file) => [file, { branches: 100, functions: 100, statements: 100 }]),
);

export default defineConfig({
  resolve: {
    alias: {
      '@genesis/core-types': pkg('core-types'),
      '@genesis/ledger': pkg('ledger'),
      '@genesis/memory': pkg('memory'),
      '@genesis/graph': pkg('graph'),
      '@genesis/projections': pkg('projections'),
      '@genesis/cognition': pkg('cognition'),
      '@genesis/adapters-sqlite': pkg('adapters-sqlite'),
      '@genesis/testkit': pkg('testkit'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/index.ts', 'packages/testkit/**'],
      thresholds: {
        // Repo-wide floor. A smoke alarm, not a target.
        lines: 80,
        ...safetyCriticalThresholds,
      },
    },
  },
});
