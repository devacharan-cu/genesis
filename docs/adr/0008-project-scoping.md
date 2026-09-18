# ADR-0008 — Multi-project from the start: mandatory, immutable `projectId`

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Answers:** Phase-0 audit open decision **E10**

## Context

The Phase-0 documents were written as though GENESIS manages one project. The
audit flagged this as a decision that had to be made before P1, because it
determines the storage key schema, and retrofitting a partition key into an
event ledger, a graph and a memory store after they hold data is one of the more
expensive migrations in software.

It is also a correctness question, not only a schema question. GENESIS assembles
context for a reasoning model. If project A's requirements can leak into project
B's context, the system will confidently reason about the wrong project — and
because every claim carries provenance but not necessarily a *project*, the
mistake would be hard to see afterwards.

## Options considered

1. **Single project now, partition later.** Fastest to build. But it means a
   data migration across three stores plus every projection, and until then
   isolation is a property nothing enforces.
2. **Separate database per project.** Strongest isolation. But it multiplies
   operational cost per project, makes the project registry awkward, and in AWS
   means a Neptune cluster per project, which is not viable at small scale.
3. **One store, mandatory `projectId` on every row, scope-typed reads.**
   Isolation enforced by the type system, the storage indexes and the graph
   invariants together.

## Decision

Adopt option 3. Concretely:

1. **Every** record, event, graph node, graph edge and projection row carries
   `projectId`. It is mandatory at write time — there is no default and no
   nullable column.
2. **`projectId` is immutable.** Nothing moves between projects. A node that
   belongs elsewhere is superseded in one project and created in the other, so
   both histories stay truthful.
3. **Reads are scope-typed.** Every read method on every store port takes a
   `ProjectScope` as its first parameter. An unscoped query is not expressible
   in the type system, rather than being discouraged by convention.
4. **Cross-project references are illegal.** Graph invariant G11 rejects any
   edge whose endpoints are in different projects; memory links are rejected the
   same way.
5. **Traversals fail closed.** Invariant G12: a traversal that cannot establish
   its project scope returns an error. It never returns an unscoped result.
6. **Scope mismatch is an error, not an empty result.** Asking for a node from
   project A while scoped to project B raises a typed error. Returning `null`
   would be indistinguishable from "no such node" and would hide the bug.
7. **Every index leads with `project_id`** (SQLite) / every key is under the
   project partition (DynamoDB). Isolation holds at the storage layer, so a
   query that forgets the scope cannot use an index — a performance cliff that
   surfaces the mistake immediately instead of silently returning another
   project's rows.
8. **The ledger is per-project.** Sequence numbers and the hash chain
   ([ADR-0009](0009-ledger-hash-chain.md)) are per-project, so replay,
   verification and snapshots are all project-local operations.
9. **The project registry is the one exception.** It lists projects and is
   scoped by account rather than by project.

## Consequences

**Positive**

- Isolation is a checkable property with three independent enforcement points
  (types, indexes, invariants) rather than a convention.
- The DynamoDB partition key design is settled now, which was the point of
  answering this before P1.
- Per-project ledgers mean replay cost and snapshot size scale with one
  project's history, not with all history.
- Project-level operations become natural: export, delete, archive, or fork a
  project without touching others.

**Negative**

- Every port signature is wider, and every test fixture must construct a
  project. There is real ceremony here for the single-project case, which is
  what we actually have today.
- Per-project sequence counters mean the ledger has a per-project write
  serialisation point, not a global one — correct, but it is a contention point
  per project under concurrent appends.
- Cross-project features that might be genuinely useful later — sharing a
  learned `PROCEDURAL` recipe between projects, for instance — are now blocked
  by an invariant and will need a deliberate design rather than an ad-hoc link.
- Hot-partition risk in DynamoDB if one project dominates traffic.

**Mitigations**

- A `ProjectScope` value is cheap to construct and is threaded through context
  objects, so the ceremony is one parameter, not one lookup per call.
- Cross-project knowledge sharing, when wanted, will be an explicit *copy with
  provenance* (`DERIVED_FROM` recording the source project) rather than a shared
  row. That keeps each project's state self-contained and replayable, which is
  the property the invariant is protecting.
- Sequence assignment is per-project and short-lived; if it becomes a real
  bottleneck the fix is a per-project writer lease, not a global counter.
- Partition design revisited in P8 with measured traffic, per the open question
  already recorded in SPEC-07 §8.
