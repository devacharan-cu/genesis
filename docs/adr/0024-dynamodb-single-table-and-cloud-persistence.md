# ADR-0024 — The DynamoDB single-table schema, and how a cloud adapter is proven

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Implements:** P8 — SPEC-00 §8; SPEC-07 §3.1, §4
- **Builds on:** [ADR-0003](0003-ports-and-adapters-persistence.md), [ADR-0004](0004-event-sourced-ledger.md), [ADR-0008](0008-project-scoping.md), [ADR-0009](0009-ledger-hash-chain.md)
- **Settles:** SPEC-07 §8 question 3

## Context

SPEC-07 §4 sets the acceptance rule for P8 plainly: *each cloud adapter must
pass the identical conformance suite its local counterpart passes. No adapter
ships on the strength of a manual smoke test.* Four ports need a DynamoDB
adapter — `EventLedger`, `MemoryStore`, `GraphStore`,
`ProjectionSnapshotStore` — and the key schema was deliberately left undesigned
until the query list was real rather than guessed.

The query list is now real. It is, in full:

| Port | Access pattern |
|---|---|
| Ledger | append at head under a condition; read a sequence range ascending; get by seq; get by event id; head; count |
| Memory | get a version by id; current version of a logical record; every version oldest-first; every record in a project, filtered in application code by the shared `matchesQuery` |
| Graph | get node; get edge; every edge touching a node, both directions; every node in a project; every edge in a project; bounded traversal built from those |
| Snapshots | load one by projection and version; list a project's; drop one |

Two things constrain the design harder than throughput does.

1. **Project isolation must be a property of the key** (ADR-0008 rule 7), not of
   application code that remembers to filter.
2. **The ledger is append-only and hash-chained** (ADR-0009). A conditional
   append must be atomic against a concurrent one, and `appendMany` must be all
   or nothing.

And one thing constrains how this can be *proven* right now: this repository has
no AWS credentials and no container daemon, so neither real DynamoDB nor
DynamoDB Local can be reached from the gate.

## Decision

### 1. One table, and every key leads with the project

A single table per deployment, `pk`/`sk`, two global secondary indexes. Every
partition key begins `PRJ#<projectId>`, so a query that forgot to scope would
have to name another project's key explicitly rather than merely omit a filter.

| Item | `pk` | `sk` | `gsi1pk` / `gsi1sk` | `gsi2pk` / `gsi2sk` |
|---|---|---|---|---|
| Ledger event | `PRJ#<p>#LEDGER` | `EVT#<seq:020d>` | `PRJ#<p>#EVTID#<eventId>` / `EVT` | — |
| Ledger head | `PRJ#<p>#LEDGER` | `HEAD` | — | — |
| Memory version | `PRJ#<p>#MEM#<logicalId>` | `VER#<version:010d>` | `PRJ#<p>#MEMID#<id>` / `MEM` | `PRJ#<p>#MEMALL` / `<createdAt>#<id>` |
| Graph node | `PRJ#<p>#GRAPH` | `NODE#<nodeId>` | — | — |
| Graph edge | `PRJ#<p>#GRAPH` | `EDGE#<edgeId>` | `PRJ#<p>#OUT#<from>` / `EDGE#<edgeId>` | `PRJ#<p>#IN#<to>` / `EDGE#<edgeId>` |
| Snapshot | `PRJ#<p>#SNAP` | `<projection>#<version:010d>` | — | — |

Notes on the choices that are not obvious:

- **Sequences and versions are zero-padded** so lexicographic sort order is
  numeric order. Without it, event 10 sorts before event 2 and a range read
  returns history out of order — a bug that would surface as a hash-chain
  failure long after the cause.
- **The head is an item in the ledger partition**, not a separate table, so a
  conditional append and the head read it depends on are in one partition and
  one transaction.
- **The graph is one partition per project.** Traversal reads many nodes and
  edges together, and a single partition makes that a small number of queries
  rather than a fan-out. It is a hot partition at scale, which §4 below prices.
- **Edges are indexed both ways.** `edgesOf` and every traversal step are then
  O(degree) rather than O(edges in project), which is what makes application-side
  traversal viable at all (ADR-0025 §1).

### 2. Adapters depend on an operation set, not on the SDK

The adapters talk to a `DynamoDbClient` port: `get`, `put`, `delete`, `query`,
`transactWrite`. Each takes a plain request and returns a plain response, in
DynamoDB's own vocabulary — condition expressions, expression attribute names
and values, `ExclusiveStartKey`, `ConsistentRead`, cancellation reasons.

This is ports-and-adapters applied one level further down, and it buys two
things. The AWS SDK is reached from exactly one file, so the SDK version is a
change to that file. And the adapters can be run against something other than
AWS without changing a line of adapter code, which §3 depends on.

### 3. How conformance is proven, and what that proof is worth

**Tier 1, in the gate.** `DynamoDbModel` implements the `DynamoDbClient` port
in process, with the DynamoDB semantics the adapters actually rely on:
condition expressions evaluated for real, `ConditionalCheckFailedException`,
`TransactWriteItems` applied atomically with `TransactionCanceledException` and
per-item cancellation reasons, key-condition queries with `begins_with` and
between-bounds, pagination through `ExclusiveStartKey`/`LastEvaluatedKey`,
`ScanIndexForward`, index projections, and the 100-item transaction limit. The
four adapters run the *identical* conformance suites their SQLite counterparts
run, against this model.

**What that proves.** That the adapters' key schema, condition expressions,
pagination, ordering and error mapping are correct against a written model of
DynamoDB's contract.

**What it does not prove**, stated here rather than discovered in production:
that the model matches AWS. It does not exercise eventual consistency on a
global secondary index, real item and request size limits, provisioned or
on-demand throttling, network partitions, or the real service's error taxonomy
beyond the three exceptions the adapters map.

**Tier 2, opt-in.** The same conformance suites run against a real endpoint —
DynamoDB Local or AWS — when `GENESIS_AWS_INTEGRATION=1` and an endpoint is
configured. It is skipped otherwise, exactly as the Bedrock live suite is.
**It has not been run**, because this environment has neither AWS credentials
nor a container daemon. Running it is a precondition of calling the cloud
deployment production-ready, and SPEC-07 §3.10 already records the same
outstanding obligation for Bedrock.

Claiming the adapters are AWS-proven on tier 1 alone would be exactly the
fabricated-evidence failure SPEC-00 §1.1 rule 2 forbids, so the documentation
says what has been run and what has not.

### 4. Consequences priced, not hidden

- **`appendMany` is capped at 99 events** (100 transaction items minus the head
  update). More than that is refused with a typed error rather than silently
  split, because splitting would break the all-or-nothing guarantee the port
  promises.
- **A project's graph is one partition**, capped by DynamoDB at 10 GB and
  3,000 read units per second. For a project whose graph outgrows that, the
  answer is Neptune (ADR-0025 §1), not a reshuffle of this schema.
- **`MemoryStore.query` reads the project's records and filters in memory**,
  using the shared `matchesQuery`/`finishQuery` so that every adapter returns
  the same answer. That is the same trade the SQLite adapter makes for the
  filters SQL cannot express, and it is bounded by a page cap.
- **Ledger immutability is enforced twice**: by the port having no update, and
  by the deployment giving the writer role no `dynamodb:DeleteItem` and no
  `UpdateItem` on ledger items (ADR-0026 §3).

## Consequences

**Positive**

- One table, one key convention, and project isolation visible in every key.
- The SDK is reached from one file; adapters are testable without a cloud.
- The conformance suites are the same ones SQLite passes, so "interchangeable"
  stays proven rather than asserted.

**Negative**

- The gate's proof is against a model of DynamoDB, not DynamoDB. The model is
  code that can be wrong in the same direction as the adapter.
- A hot graph partition is a real ceiling, reached sooner than the ledger's.
- Application-side memory filtering reads more than a targeted index would.

**Mitigations**

- The model is registered safety-critical and held to full branch coverage, and
  its limits are listed above rather than left to be assumed.
- The integration tier exists, is runnable by configuration, and is named as an
  outstanding obligation in SPEC-07 and the README rather than quietly omitted.
