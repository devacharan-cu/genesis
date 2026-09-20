# ADR-0021 — Impact leases, and why factory work stays serialised

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Implements:** P7 — SPEC-00 §8; SPEC-04 §4c; SPEC-05 §3.2
- **Builds on:** [ADR-0014](0014-cognitive-primitives-as-deciders.md), [ADR-0016](0016-orchestrator-owns-graph-mirroring.md), [ADR-0020](0020-agent-protocol-and-runtime.md)
- **Settles:** SPEC-04 §7 question 3, deferred from P6

## Context

P6 serialised agent tasks per project and said plainly that parallelism was not
taken because it had not been shown safe. P7 runs many agents over one change —
Builder, then QA, then Security, then Repair, then Verify — so the question
cannot stay open: either the factory may overlap work, or it may not, and the
reason has to be written down before anyone builds on the answer.

Three mechanisms already constrain the answer.

1. **The cognitive engine appends conditionally** on the ledger position it
   decided from ([ADR-0014](0014-cognitive-primitives-as-deciders.md) rule 4). Two
   writers racing means one loses and retries against newly changed state. That
   is safe for a lost race; it is *not* safe for two agents that each decided
   something based on a world the other has since altered.
2. **The impact set is computed by the core from the graph**, ignoring what an
   agent claims (SPEC-05 §3.2). It is the only structural statement the system
   has about what a change touches.
3. **The graph is derived** ([ADR-0016](0016-orchestrator-owns-graph-mirroring.md)),
   reconciled from committed cognitive state after a run. An impact set read
   mid-flight may be stale with respect to work that has not yet mirrored.

The naive move is to run Builder and QA for two changes at once because the
machine has cores to spare. The failure that buys is silent: two changes whose
impact sets overlap, each tested against a tree the other has since altered,
both reported green, neither actually verified together.

## Decision

### 1. Factory work stays serialised per project

One project runs one factory stage at a time, on the same in-process queue the
cognitive engine, the orchestrator and the agent runtime already use. Different
projects are independent and always were, because every store is project-scoped
([ADR-0008](0008-project-scoping.md)).

This is not a placeholder for parallelism that is coming shortly. It is the
decision, and it stands until something below changes.

### 2. Every stage declares an impact lease

Before a stage runs, the factory computes the change's impact set from the graph
and records it as a **lease**: the set of node ids that stage's work depends on,
plus the ledger position it was computed at.

A lease is not a lock. Nothing blocks on it, because nothing runs concurrently.
It exists so that:

- **A stale stage is detectable.** If the ledger has moved past the lease's
  position *and* the events in between touched a leased node, the stage's
  conclusion was reached against a world that no longer holds. That is recorded
  and the stage is re-run, not silently accepted.
- **Two changes that overlap are visible.** Overlapping leases in one run are a
  conflict the factory reports rather than a race it loses.
- **The seam for concurrency is the lease, and it is already here.** Parallel
  execution becomes a question of admission — may two stages hold overlapping
  leases at once — rather than a rewrite. Today the answer is that the question
  never arises, because only one lease is ever held.

Recording the lease costs one graph read per stage and makes the staleness check
a comparison rather than an act of faith.

### 3. Conflict semantics, stated

- **Two proposals that cannot both hold** are not prevented and not arbitrated.
  They become a contradiction through the existing engine (SPEC-01 §8), which
  keeps both sides and refuses to guess a winner. The factory blocks the change
  rather than picking one.
- **A stage whose lease went stale** is re-run once against the current state. A
  second staleness is a blocked change with a recorded reason, not a third
  attempt: something is changing underneath faster than the factory can work,
  and quietly looping would hide that.
- **Duplicated work** is visible rather than deduplicated. Two runs against one
  goal are both on the ledger, and the run projection shows both.
- **Ordering is deterministic.** Stages run in the pipeline's declared order,
  impact sets are ranked by the graph's own stable ordering, and ids and the
  clock are injected. The same inputs give the same ledger, byte for byte.

### 4. What would justify revisiting this

Concurrency becomes arguable when all four hold, and an ADR says so:

1. Admission control over leases exists and is tested: two stages may run
   together only when their impact sets are disjoint.
2. The graph mirror is current enough at admission time that a disjointness
   check means something, or the check is made against the cognitive state
   directly rather than the derived graph.
3. The conditional-append retry path has a test showing that a lost race under
   real concurrency re-decides rather than re-applies a stale decision.
4. There is a measured reason. "The model call is slow" is a reason; "parallel
   sounds advanced" is not.

## Consequences

**Positive**

- Throughput is bounded by one stage at a time, and every result is about a
  world that held when it was computed.
- Staleness is detected rather than assumed away, which is the property that
  would otherwise be silently lost the first time anything overlapped.
- The concurrency seam is a data structure that already exists and is already
  recorded, not a redesign.

**Negative**

- A project's factory throughput is one stage at a time, and a slow model call
  blocks the queue for that project. This is real, and for a long build it is
  the dominant cost.
- Every stage pays a graph read it does not strictly need while nothing runs
  concurrently.
- Leases are recorded and checked but never contended, so the contention path
  has no production exercise until concurrency lands.

**Mitigations**

- Projects are independent, so more than one project proceeds at once today.
- The lease read is bounded by the graph's existing depth and limit caps
  (SPEC-03, G12), so it cannot become the expensive part of a stage.
- The staleness check is tested directly by appending an interfering event
  between a lease and its use, so the path is exercised even though nothing
  contends for it.
