# ADR-0014 — Cognitive primitives are deciders over the ledger

- **Status:** Accepted
- **Date:** 2026-09-19
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Implements:** SPEC-01 §5–§8 (goals, beliefs, uncertainty, contradiction)
- **Builds on:** [ADR-0004](0004-event-sourced-ledger.md), [ADR-0005](0005-authority-over-confidence.md), [ADR-0008](0008-project-scoping.md), [ADR-0011](0011-write-time-authority-policy.md), [ADR-0013](0013-projections-as-pure-folds.md)

## Context

P2 builds the goal system, belief system, uncertainty engine and contradiction
engine. SPEC-01 gives each a record shape and, more importantly, a set of rules:
a goal cannot be `ACTIVE` without a success criterion, a parent cannot be
`SATISFIED` while a child is open, a belief cannot reach `TESTED` without
evidence that could have falsified it, a contradiction must preserve both sides
and must not break an authority tie by guessing.

Two questions have to be answered before any of that is written:

1. **Where does cognitive state live?** Requirement: it must be reconstructable
   from the event ledger, scoped per project, and deterministic.
2. **Where are the rules enforced?** A rule enforced in one caller and not
   another is a suggestion.

## Options considered

**A. A `CognitiveStore` port with in-memory and SQLite adapters**, like memory
and graph. Rejected: it creates a second system of record beside the ledger.
Every rule would need enforcing in two adapters, and "reconstructable from the
ledger" would be false the moment a write reached the store without an event.

**B. Rules inside the projector.** The fold rejects an illegal event. Rejected by
ADR-0013 rule 4: the ledger is append-only, so a projector that rejects an event
already in it makes the projection permanently unbuildable.

**C. Deciders over a projection.** Chosen. The state is *only* a projection of
the ledger. A change is a **command**; a pure `decide(state, command)` checks
every rule against the current state and either throws or returns the events
that record the change; the events are appended; the state is the fold. This is
the event-sourced decider pattern, and it puts each rule in exactly one place.

## Decision

### 1. One package, one projection, four decider modules

`packages/cognition` depends on `core-types`, `ledger` and `projections` —
nothing else. It holds one projector, `cognition`, whose state carries all four
record families, because the rules cross them: a goal cannot be `SATISFIED`
while a blocking uncertainty targets it, and a contradiction marks beliefs and
opens uncertainties. Four separate projections would each validate against a
partial view. The code is still four modules — `goals`, `beliefs`,
`uncertainties`, `contradictions` — each owning its commands and events.

### 2. Deciders are pure; ids and the clock are injected

`decide(state, command, context)` has no hidden inputs. Record ids and
timestamps come from `context`, so the same state and command always produce
the same events, and tests are deterministic. Replay never calls a decider:
ids and times are already in the events.

### 3. Rules are enforced at decide time; the fold records, never rejects

An illegal command throws `CognitiveRuleViolationError` (new code
`COGNITIVE_RULE_VIOLATION`) and appends nothing. The projector trusts nothing
either: an event that no decider could have produced — a transition from the
wrong state, a reference to an unknown record — is recorded as an anomaly
(ADR-0013 rule 4) and does not change state.

### 4. Optimistic concurrency on the ledger

A decision is only valid against the state it was made on. `appendMany` gains an
optional `{ expectedLastSeq }`: when the project's head is not that sequence,
the append throws `SequenceConflictError` and writes nothing. Both adapters
check it inside their existing critical section (the in-memory per-project
queue; SQLite's `BEGIN IMMEDIATE`), so the check and the write are atomic.

The engine catches up, re-decides against the fresh state, and retries a
bounded number of times. Re-deciding is safe *because* deciders are pure: a
command that was legal may have become illegal, and it is then rejected rather
than written. This is an additive change to the ledger port; existing callers
are unaffected.

### 5. Authority

- A belief's authority is the requested one (default `AI_ASSUMPTION`, SPEC-01
  §6), clamped to the actor's ceiling, and for an `AGENT` further capped at
  `AI_ASSUMPTION` — the slice-2 rule that an agent can never promote its own
  claim above an assumption. Requested, effective and the reason are all
  recorded (ADR-0011).
- `TESTED` and `VERIFIED` cannot be reached by an `AGENT` actor. Both require an
  executed test; a model saying a test passed is generation, not verification.
- A contradiction's authority is **determinable** only when both sides'
  authorities are trustworthy: read from state (a belief side) or supplied by a
  `HUMAN` or `SYSTEM` actor. An agent-supplied side authority is
  **indeterminate**, because otherwise an agent could win a contradiction by
  declaring its side more authoritative.
- Strictly higher trusted authority governs; the lower side is marked
  `SUPERSEDED_BY_AUTHORITY` and stays readable. Equal or indeterminate opens an
  uncertainty with resolution `ASK_HUMAN`, in the same atomic append. Only a
  `HUMAN` actor may resolve an escalated contradiction.

### 6. The self model reads cognitive events

The self model (ADR-0013) had its own `ASSUMPTION_*` and `UNCERTAINTY_OPENED` /
`UNCERTAINTY_RESOLVED` vocabulary — a second source of truth for facts the
belief system and uncertainty engine now own. Self model **v2** derives
`assumptions` (beliefs at `ASSUMED`) and `uncertainties` (open or in progress)
from the cognition events instead, and the private vocabulary is removed. The
version bump means v1 snapshots are not found and the model rebuilds.

`currentGoal` stays in the self model: it is the goal the system is *focused*
on, which is a different fact from which goals are `ACTIVE`. Its events are
renamed `GOAL_FOCUSED` / `GOAL_UNFOCUSED` in the same version bump, because
`GOAL_ACTIVATED` would otherwise mean two different things in one ledger.

### 7. Canonical enumerations

`GoalStatus`, `SuccessCheckKind`, `UncertaintyStatus` and `RiskLevel` are taken
from SPEC-01 into SPEC-00's canonical blocks and `core-types`, so the drift test
covers them like every other canonical list.

## What this ADR does not decide — explicitly out of P2

- **Mirroring into the graph.** SPEC-01 §7 makes each uncertainty a graph node
  and §8.1 links contradicting sides with a `CONTRADICTS` edge. Cognition may not
  depend on `graph` (a decider that reads a second store has a second input).
  Records carry `affectedRefs`; writing the nodes and edges belongs to the core
  orchestrator, which is not built yet.
- **Issues and proposal blocking** (SPEC-01 §8.1 steps 4 and 6) need the
  proposal pipeline (P6).
- **Drift condition 3** (no criterion advanced for N cycles) needs the cognitive
  loop. Conditions 1 and 2 are pure and are implemented.
- **Uncertainty detection source 2** (requirement gaps) needs the knowledge
  graph. Sources 1 (belief gaps), 3 (criterion gaps), 4 (the contradiction
  engine itself) and 5 (capability gaps, read from the self model) are
  implemented — as pure detectors returning drafts, never writing.
- **Evidence integrity.** Belief transitions check the *descriptors* of the
  evidence cited — kind, producer, environment, whether it could have falsified
  the belief. That the evidence exists and its raw output hashes correctly is the
  evidence writer's job (SPEC-05 §4, P5). Until then a `SYSTEM` or `HUMAN`
  caller is trusted to cite real evidence, and an `AGENT` cannot cite its way to
  `TESTED`.

## Consequences

**Positive**

- Every rule lives in one decider, and every accepted change is an event, so the
  cognitive state is rebuildable and auditable by construction — and ADR-0013's
  conformance suite proves it for free, because the fold is a projector.
- Illegal commands leave no trace in the ledger; illegal *events* (tampering, a
  future bug) leave an anomaly rather than corrupting state.
- Concurrent writers cannot interleave decisions: stale decisions fail cleanly
  and are re-made against fresh state.

**Negative**

- Deciding requires the projection to be current. The engine keeps it live and
  catches up from the ledger before each command, which is a replay cost on a
  cold start; snapshots (ADR-0013) bound it.
- One projection holding four families is larger than four small ones, and any
  change to any family bumps one version.
- The ledger port grew an option. It is optional and additive, but it is a port
  change, and both adapters had to implement it identically.
- Event schemas are now shared between the cognition projection and the self
  model. A change to a cognitive event's shape must consider both.

**Mitigations**

- The conditional append is covered by the shared ledger conformance suite, so
  the two adapters are held to one behaviour.
- The engine is tested against both ledger adapters by one shared suite, and
  by seeded random command streams that check every invariant after every
  accepted command and end with a replay-equals-live check.
- The cognitive decider and fold modules join the safety-critical list at 100%
  branch coverage: a silent failure there lets the system believe a goal is done,
  a belief verified, or a contradiction settled when none of those is true.
