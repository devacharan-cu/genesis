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
  'packages/cognition/src/questions.ts', // ADR-0015: only a person answers for a person
  'packages/cognition/src/scoring.ts', // ADR-0017: a recorded score matches its breakdown
  'packages/context/src/assemble.ts', // SPEC-01 11.3: mandatory context is never crowded out
  'packages/context/src/candidates.ts', // what is mandatory, and how far each record is from the task
  'packages/context/src/event.ts', // only the system records what a task was shown
  'packages/context/src/gather.ts', // reads through read-only views; refuses unknown task nodes
  'packages/context/src/model.ts', // weights and inputs are checked before they become scores
  'packages/context/src/scoring.ts', // the six signals, deterministic
  'packages/reasoning/src/port.ts', // what crosses the port, and what may not
  'packages/reasoning/src/errors.ts', // every provider failure is typed; no output is repaired
  'packages/reasoning/src/render.ts', // content cannot close its own fence (SPEC-06 6)
  'packages/reasoning/src/mock.ts', // the provider the whole core suite trusts
  'packages/adapters-aws/src/bedrock.ts', // Bedrock failures and stops mapped, never guessed
  'packages/core/src/events.ts', // the run's record
  'packages/core/src/proposals.ts', // the only door from model output to state (ADR-0018)
  'packages/core/src/request.ts', // untrusted content marked, requests hashed canonically
  'packages/core/src/orchestrator.ts', // context -> reasoning -> proposals -> mirror, all recorded
  'packages/core/src/mirror.ts', // the graph derived from canonical state (ADR-0016)
  'packages/core/src/runs.ts', // failed and interrupted runs visible from the ledger
  'packages/sandbox/src/port.ts', // sandbox port
  'packages/sandbox/src/mock.ts', // mock sandbox
  'packages/sandbox/src/errors.ts', // sandbox errors
  'packages/adapters-sandbox-local/src/local.ts', // sandbox teardown, timeout cleanup
  'packages/verification/src/engine.ts', // deterministic verification engine state machine
  'packages/experiment/src/engine.ts', // experiment engine records evidence
  'packages/protocol/src/envelope.ts', // everything an agent says arrives here (ADR-0020 §5)
  'packages/protocol/src/manifest.ts', // a manifest can narrow, never widen (ADR-0020 §3)
  'packages/protocol/src/lifecycle.ts', // terminal is terminal (ADR-0020 §6)
  'packages/agents/src/contract.ts', // what an agent is handed, and what it may return
  'packages/agents/src/registry.ts', // registration is where an over-reaching manifest stops
  'packages/core/src/agent-events.ts', // an agent task's record on the ledger
  'packages/core/src/agent-runtime.ts', // assignment -> orchestrator -> outcome, all recorded
  'packages/core/src/agent-tasks.ts', // failed and abandoned agent tasks visible from the ledger
  'packages/core/src/purposes.ts', // the prompts, schemas and handlers a role may not supply (ADR-0022)
  'packages/core/src/artifacts.ts', // the second door: a produced file becomes a record, and no more
  'packages/protocol/src/factory.ts', // what a role may claim to have done
  'packages/agents/src/security-checks.ts', // the only thing that blocks on a judgement
  'packages/agents/src/factory-roles.ts', // report what was done, never what it means
  'packages/factory/src/pipeline.ts', // a repair cannot reach VERIFY unchecked (ADR-0023 2)
  'packages/factory/src/leases.ts', // staleness is detected rather than assumed away
  'packages/factory/src/events.ts', // a factory run's record
  'packages/factory/src/verified-artifacts.ts', // the answer to "is it done"
  'packages/factory/src/factory.ts', // intent to verified artifact, all recorded
];

const safetyCriticalThresholds = Object.fromEntries(
  SAFETY_CRITICAL.map((file) => [file, { branches: 100, functions: 100, statements: 100 }]),
);

export default defineConfig({
  resolve: {
    alias: {
      '@genesis/core-types': pkg('core-types'),
      '@genesis/protocol': pkg('protocol'),
      '@genesis/ledger': pkg('ledger'),
      '@genesis/memory': pkg('memory'),
      '@genesis/graph': pkg('graph'),
      '@genesis/projections': pkg('projections'),
      '@genesis/cognition': pkg('cognition'),
      '@genesis/context': pkg('context'),
      '@genesis/reasoning': pkg('reasoning'),
      '@genesis/sandbox': pkg('sandbox'),
      '@genesis/adapters-sandbox-local': pkg('adapters-sandbox-local'),
      '@genesis/verification': pkg('verification'),
      '@genesis/experiment': pkg('experiment'),
      '@genesis/core': pkg('core'),
      '@genesis/adapters-aws': pkg('adapters-aws'),
      '@genesis/adapters-sqlite': pkg('adapters-sqlite'),
      '@genesis/agents': pkg('agents'),
      '@genesis/factory': pkg('factory'),
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
