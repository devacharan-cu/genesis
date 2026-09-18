# ADR-0003 — Ports and adapters for persistence; SQLite first, AWS later

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`

## Context

GENESIS targets an AWS-native deployment (DynamoDB, Neptune, S3). But the
Cognitive Core's semantics — authority resolution, contradiction preservation,
ledger replay, graph invariants — are the hard part, and they are independent of
where bytes live. They need to be built and tested offline, fast, with real
transactional behaviour.

Deciding the DynamoDB key schema now would mean designing it against a guessed
query list, before the core's actual queries exist.

## Options considered

1. **DynamoDB Local + a Gremlin server in Docker from day one.** Highest
   fidelity. But it forces cloud data-modelling decisions before the core's
   query set is known, and every core test then depends on containers.
2. **JSON files on disk.** Zero dependencies, fastest start. No transactions, no
   query engine, no concurrency control — the ledger and graph work would have
   to be *rewritten* rather than re-adapted, and the invariants would be
   unenforceable.
3. **Ports with a SQLite adapter now, cloud adapters later.** Real transactions,
   real constraints, real recursive queries; no cloud coupling in the core.

## Decision

Define storage **ports** in the core, with adapters behind them.

Ports (P1): `MemoryStore`, `GraphStore`, `EventLedger`, `BlobStore`.
Also ported: `SandboxRunner`, `ReasoningProvider`, `MessageBus`,
`IdentityProvider`, `SecretResolver`.

Adapters: SQLite + local content-addressed blob dir (P1); DynamoDB, Neptune, S3
(P8). Mapping table: [SPEC-07](../architecture/07-AWS-ARCHITECTURE.md) §4.

**The binding rule:** every adapter for a port must pass one shared conformance
suite, living in `packages/testkit`, written against the port — not against any
adapter. A cloud adapter is accepted when it passes the identical suite the
SQLite adapter passes. No adapter ships on a manual smoke test.

The core never imports an adapter. Adapters are injected at composition root
(`apps/cli` locally, the Lambda entrypoints in AWS).

## Consequences

**Positive**

- The core is testable offline, in milliseconds, with no containers.
- The DynamoDB key schema gets designed against the *real* query list produced
  by P1–P5, not a guess.
- Interchangeability is proven by the conformance suite rather than asserted.
- Small deployments can run entirely on SQLite; that is a supported
  configuration.

**Negative**

- The port surface must be expressive enough for both worlds. Anything
  SQLite-specific leaking into the port (transaction semantics, SQL-shaped
  filters) becomes a migration problem.
- Two implementations to maintain per port.
- SQLite's recursive CTE traversals and Neptune's Gremlin traversals can diverge
  in edge cases (cycle handling, ordering, depth limits).

**Mitigations**

- Port methods are declared in terms of domain operations (`impactSet`,
  `neighbourhood`), never in terms of query strings.
- Transaction semantics are stated explicitly in the port contract: the core
  requires atomic multi-write within one store and does **not** assume
  cross-store transactions — because DynamoDB + Neptune cannot provide them.
  Cross-store consistency is achieved by ledger-first writes and rebuildable
  projections ([ADR-0004](0004-event-sourced-ledger.md)).
- A traversal-parity test runs both adapters over the same fixture graph and
  compares results before the cloud adapter is accepted.
