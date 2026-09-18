# ADR-0004 — Event-sourced ledger with rebuildable projections

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`

## Context

GENESIS must support history, auditing, explanation and reconstruction
([SPEC-00](../architecture/00-MASTER-SPEC.md) §7). "Why does the system believe
this?" and "what changed the timeout from 24 hours to 12?" must be answerable
months later, including when the answer is "an agent assumed it and nobody
caught it."

A conventional mutable state store cannot answer those questions: the previous
value is gone.

There is also a cross-store consistency problem. In AWS, canonical state is in
DynamoDB and the graph is in Neptune, and there is no transaction spanning them.

## Decision

The **event ledger is the write-ahead system of record.** Every meaningful state
change appends an immutable event *before* any projection is updated.

- Events are append-only. No updates, no deletes. A mistaken event is corrected
  by a compensating event linked with `SUPERSEDES`.
- Derived read models — the world model, the self model, the Neptune graph
  materialisation, status views — are **projections**, rebuildable by replay.
- Immutable record sets (memory records, evidence) are written alongside events
  and are themselves append-only, so they need no replay.
- If a projection disagrees with the ledger, the projection is wrong and is
  rebuilt.
- Replay is a first-class, tested operation: a P1 exit criterion is that
  replaying the ledger from empty reconstructs state identical to the live
  projections.

Event shape is fixed in [SPEC-00](../architecture/00-MASTER-SPEC.md) §7,
including `cause` (the causing event), `actor`, `authority` and `payloadHash`.

## Consequences

**Positive**

- History, audit and explanation come from the storage model rather than from
  bolted-on logging.
- Cross-store consistency has a defined answer: ledger first, projections
  eventually consistent and rebuildable. DynamoDB Streams drives projection
  updates in P8.
- Debugging a bad decision means replaying the cycle that made it.
- "Preserve contradictions rather than overwrite" is natural: nothing is
  overwritten in the first place.

**Negative**

- Storage grows monotonically. Ledger volume is the dominant cost at scale.
- Projections can lag; reads must state whether they tolerate staleness.
- Schema evolution of events is permanent — a badly shaped event is with us
  forever.
- Replay time grows with history; naive full replay eventually becomes
  impractical.

**Mitigations**

- Events are versioned (`schemaVersion`) with upcasting functions on read, so
  old events remain replayable as shapes change.
- Periodic **snapshots** of projections with the ledger offset they were built
  from; replay starts from the latest snapshot. Snapshots are a cache, never a
  source of truth — a full replay from zero must remain possible and is tested
  periodically.
- Reads that require strong consistency go to the ledger or to immutable record
  sets, not to projections. Each read API declares its consistency.
- `EVENT` graph nodes may be materialised selectively rather than one-per-event
  (open question in [SPEC-03](../architecture/03-GRAPH-ARCHITECTURE.md) §8).
