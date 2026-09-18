# ADR-0006 — Agents propose; only the core mutates state

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`

## Context

Multi-agent systems commonly let each agent write to shared state. That gives
every agent's mistakes — and every successful prompt injection against any
agent — a direct path to the system of record. It also makes "why is the state
like this?" unanswerable, because the mutation happened inside whichever agent
happened to run.

GENESIS's value depends on its state being trustworthy. If any agent can write
it, it is exactly as trustworthy as the least reliable agent.

## Options considered

1. **Direct writes with validation at the store.** Simple; validation catches
   malformed writes. But it cannot catch *unauthorised but well-formed* writes,
   and there is no single place where policy runs.
2. **Direct writes with an audit log.** Records what happened, but after the
   fact. Damage is already in the state.
3. **Proposal-based mutation.** Agents emit inert `Proposal` messages; the core
   evaluates and applies. One mutation path, one policy point.

## Decision

**Agents have no write access to canonical state — memory, graph, or ledger.**
The only thing an agent can do to state is submit a `Proposal`
([SPEC-04](../architecture/04-AGENT-ARCHITECTURE.md) §4).

Every proposal traverses the change lifecycle:

```
PROPOSE → IMPACT_ANALYSIS → POLICY_CHECK → APPLY → TEST → VERIFY → COMMIT_STATE
```

Key points:

- `IMPACT_ANALYSIS` recomputes the impact set from the graph and **ignores** the
  agent's `expectedImpact` claim. A wrong claim is recorded as calibration data
  about that agent, not treated as input.
- `POLICY_CHECK` is the single place security policy, permissions and
  authorization gates run
  ([SPEC-06](../architecture/06-SECURITY-ARCHITECTURE.md) §7).
- `APPLY` is transactional and reversible; `TEST` failure rolls it back.
- Authority is clamped at the core, so an agent cannot elevate its own claims
  ([ADR-0005](0005-authority-over-confidence.md)).
- Partial acceptance is supported: the core may accept some ops and reject
  others with reasons.

Enforcement is structural, at three levels: package dependency rules
([ADR-0001](0001-monorepo-layout.md)) mean an agent package cannot import a
store; the type system offers agents no store handle; and a per-agent
conformance test hands the agent a store handle and asserts the write is refused.

## Consequences

**Positive**

- One mutation path means one audit point, one policy point, one place to
  enforce invariants.
- Prompt injection against an agent produces a rejected proposal and a recorded
  finding, not corrupted state
  ([SPEC-06](../architecture/06-SECURITY-ARCHITECTURE.md) §6).
- Agents become replaceable and independently testable, since they are pure
  functions from context to proposals.
- Human authorization has a natural insertion point.

**Negative**

- Latency: every change round-trips through the core.
- The core becomes a throughput bottleneck and a single point of failure.
- More ceremony for trivial changes; a one-line fix still needs a proposal with
  rationale and goal linkage.
- Risk of a "god object" core if engines are not kept modular inside it.

**Mitigations**

- Proposals batch multiple ops, so one round-trip covers a coherent change.
- The core is internally modular: cycle executor, engines, and stores are
  separate packages behind interfaces; "the core" is a boundary, not a file.
- Proposal evaluation is mostly parallelisable per independent impact set
  (deferred to P6 with optimistic concurrency).
- The ceremony is the point for state changes. Agents' *internal* work — drafts,
  intermediate reasoning — needs no proposal; only state does.
