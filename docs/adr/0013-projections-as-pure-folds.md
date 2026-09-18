# ADR-0013 — Projections are pure folds; snapshots are a droppable cache

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Implements:** [ADR-0004](0004-event-sourced-ledger.md)
- **Constrained by:** [ADR-0001](0001-monorepo-layout.md), [ADR-0003](0003-ports-and-adapters-persistence.md), [ADR-0008](0008-project-scoping.md)

## Context

[ADR-0004](0004-event-sourced-ledger.md) made the event ledger the system of
record and said read models are "rebuildable by replay". SPEC-00 §6 lists
`worldState` and `selfState` as projections, and SPEC-01 §3 repeats it: *"The
world model is a projection over Semantic Memory and the graph. It can be
rebuilt from the event ledger."*

Nothing implemented that claim. "Rebuildable" was an assertion in a document,
not a property anything demonstrated. The specific ways it fails in practice
are well known and all of them are silent:

1. **Hidden state.** A projector that closes over a counter, a clock, a random
   source or a cache produces a state that the ledger alone cannot reproduce.
   The rebuild diverges from the live model, and nothing notices, because
   nothing compares them.
2. **Non-determinism.** Iteration over a `Set`, a `Date.now()` in a handler, a
   floating-point accumulation order — the same history yields two states.
3. **Order and duplication.** Events arriving out of order, or the same event
   applied twice after a retry, quietly corrupt the fold.
4. **Cross-project bleed.** A projector fed an event from another project
   (ADR-0008's failure mode) silently mixes two worlds.

## Options considered

**A. Mutable projector objects with an `apply(event)` method.**
The usual shape. Rejected: the object *is* the hidden state. Whether a rebuild
reproduces it depends on whether every field was reset, which is a code review
question rather than a checkable one.

**B. Pure fold `(state, event) -> state`, state constrained to plain JSON.**
Chosen. The state's type forbids a closure, a `Map`, a `Date` or a class
instance, so "everything needed to rebuild is in the value" is enforced by the
compiler rather than by discipline.

**C. Pure fold, state unconstrained (`S`).**
Rejected. It keeps purity but loses serialisability: a projector could hold a
`Map`, snapshot it as `{}`, and the rebuild-from-snapshot path would silently
lose data.

**D. Prove equivalence by deep-comparing states.**
Rejected as the primary mechanism. A deep comparison passes on two states that
differ only in key order, which is precisely the kind of non-determinism that
later breaks a snapshot digest. Hashing a canonical serialisation compares what
is actually persisted.

## Decision

### 1. A projection is a pure fold over the ledger

```ts
interface Projector<S extends JsonValue> {
  readonly name: string;
  readonly version: number;
  initial(): S;                             // a FRESH value per call
  apply(state: S, event: GenesisEvent): S;  // pure; must not mutate `state`
}
```

`S extends JsonValue` is the load-bearing constraint. It makes the state
canonically serialisable by construction, which is what makes a snapshot
complete and a digest meaningful.

`initial()` is a function, not a constant, so two projections cannot share and
then mutate one object.

### 2. Ordering, idempotency and scope are enforced by the runner, not by projectors

`applyEvent` carries `lastSeq` alongside the state and enforces three rules
before a projector ever sees an event:

| Condition | Result |
|---|---|
| `event.projectId` ≠ the projection's project | `ScopeMismatchError` |
| `event.seq` ≤ `lastSeq` | **no-op**, the same state returned |
| `event.seq` > `lastSeq + 1` | `SequenceConflictError` |
| `event.seq` = `lastSeq + 1` | applied |

Duplicates are absorbed rather than rejected, because at-least-once delivery is
the normal condition on any retry path and an error there would be noise. A
**gap** is an error, because a gap means state has been skipped and everything
after it would be quietly wrong. The ledger is gapless per project (ADR-0009),
so a gap can only mean a bug or a partial read.

### 3. Equivalence is proven by digest, not by assertion

```
projectionDigest(p) = sha256(canonicalJson({ projection, version, projectId, lastSeq, state }))
```

reusing the ledger's canonical serialiser (ADR-0009) so the two agree on what
"the same value" means. Three equalities are asserted by the conformance suite
for every projector and every adapter:

- **replay = live** — folding the whole ledger equals applying each event as it
  was appended.
- **snapshot + tail = full replay** — restoring a snapshot taken at seq *k* and
  replaying *k+1…n* equals replaying *1…n*. This is the property that catches
  hidden state: anything the projector kept outside the snapshotted value is
  missing from the left side.
- **determinism** — replaying the same history twice, into two independently
  constructed initial states, yields one digest.

### 4. A projector never throws on event *content*

Ordering and scope violations throw, because they are the caller's fault and
are fixable. Event content is different: the ledger is append-only, so a
projector that throws on a malformed or unexpected payload makes that
projection **permanently unbuildable** — the offending event can never be
removed. The predictable response would be to disable the check, which is worse
than not having had it.

So a projector records instead:

- `unhandled: { [eventType]: count }` — event types this projector does not
  interpret. Not an error; an honest statement of coverage.
- `anomalies: [{ seq, eventId, kind, detail }]` — events this projector *should*
  have interpreted but could not: a malformed payload, a reference to an entity
  it has never seen, a value the specification forbids.

Both are part of the projected state, so they are in the digest, they survive a
rebuild, and a surface that reports the world model can report how much of the
ledger it actually understood.

### 5. Snapshots are a cache and may be dropped

`ProjectionSnapshotStore` is a port (ADR-0003) with in-memory and SQLite
adapters. Unlike the ledger it *does* have `drop`, and that asymmetry is the
point: a snapshot holds nothing that is not rederivable, so deleting one costs
time, not truth.

Two write rules give it teeth:

- Saving a snapshot at a `lastSeq` **below** the stored one is rejected
  (`SEQUENCE_CONFLICT`) — a half-built projection must not clobber a complete
  one.
- Saving at the **same** `lastSeq` with a **different digest** is rejected
  (`PROJECTION_DIVERGENCE`, a new error code). Two folds over identical history
  disagreeing is non-determinism, detected at the moment it happens rather than
  inferred from a later bug.

### 6. `packages/projections` is a new package in the ADR-0001 layout

Depends on `core-types` and `ledger`; nothing else. It does **not** depend on
`memory` or `graph`: a projection is a fold over events, and giving it a store
to read would let a projector make its result depend on something other than
the ledger — the hidden-state failure by another route.

`adapters-sqlite` and `testkit` gain it as a dependency; the boundary checker's
table is updated in the same commit, so an unlisted package is still a
violation.

## Consequences

**Positive**

- "Rebuildable from the ledger" is now a test that runs, on two adapters, for
  every projector — not a sentence in a specification.
- Hidden state is caught by the snapshot-and-tail property rather than by
  review. A projector that keeps a private counter fails it immediately.
- The `JsonValue` constraint means a snapshot is complete by typing, so the
  "snapshot silently lost a `Map`" class of bug cannot be written.
- Non-determinism surfaces as a digest mismatch at save time, with the
  offending sequence in the error.
- Coverage of the ledger is visible: `unhandled` and `anomalies` say what the
  projection did not understand, instead of the state quietly omitting it.

**Negative**

- Every state update allocates a new object. For the projection sizes in P1
  this is irrelevant; at millions of events it will not be, and the answer will
  be structural sharing or a mutable-inside-a-boundary fold, which is a future
  ADR, not a reason to start mutable.
- `S extends JsonValue` rules out richer in-memory shapes (a `Map` index, a
  class with methods). Projectors build plain-object indexes instead, which is
  more verbose.
- A projector cannot consult the memory store or the graph, so any projection
  needing that information must be fed it through events. That is a real
  constraint on event design — events must carry what projections need.
- `anomalies` is unbounded in principle; a pathological ledger could grow it
  without limit. Bounded in the projectors written here by capping retained
  anomalies and keeping a total count, so the digest stays stable.
- One more error code (`PROJECTION_DIVERGENCE`) and one more package.

**Mitigations**

- The anomaly list is capped at a fixed size per projection with an
  `anomaliesDropped` counter, so the state stays bounded and the loss is
  visible rather than silent.
- The conformance suite runs against the in-memory and SQLite snapshot stores,
  so the equivalence proof is not a property of one adapter.
- `applyEvent` and the digest module are added to the safety-critical coverage
  list (SPEC-00 §8.1): a silent failure in either lets the system believe a
  rebuilt state that never happened.
