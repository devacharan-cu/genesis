# Architecture Decision Records

Every architectural decision that constrains future work is recorded here before
it is implemented. Rule 11 of the project's development rules: *the architecture
does not change silently.* If a decision needs to change, a new ADR supersedes
the old one and states why — the old ADR is never edited away.

## Format

Each ADR states: context, options considered, the decision, and consequences —
**including the negative ones and how they are mitigated**. An ADR with no
listed downsides has not been thought through.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-monorepo-layout.md) | pnpm workspace monorepo layout | Accepted |
| [0002](0002-typescript-strict.md) | TypeScript with strict typing | Accepted |
| [0003](0003-ports-and-adapters-persistence.md) | Ports and adapters for persistence; SQLite first | Accepted |
| [0004](0004-event-sourced-ledger.md) | Event-sourced ledger with rebuildable projections | Accepted |
| [0005](0005-authority-over-confidence.md) | Authority hierarchy governs conflicts, not confidence | Accepted |
| [0006](0006-proposal-based-mutation.md) | Agents propose; only the core mutates state | Accepted |
| [0007](0007-reasoning-provider-port.md) | `ReasoningProvider` port, Bedrock first adapter | Accepted |
| [0008](0008-project-scoping.md) | Multi-project from the start: mandatory, immutable `projectId` | Accepted |
| [0009](0009-ledger-hash-chain.md) | Per-project hash chain over sequenced ledger events | Accepted |
| [0010](0010-node-sqlite-driver.md) | Built-in `node:sqlite` driver for the P1 adapters | Accepted |
| [0011](0011-write-time-authority-policy.md) | Write-time authority policy: clamp, and record the clamp | Accepted |
| [0012](0012-ungrounded-authority-level.md) | Add `UNGROUNDED`, and make the grounding step a ladder | Accepted |
| [0013](0013-projections-as-pure-folds.md) | Projections are pure folds; snapshots are a droppable cache | Accepted |
| [0014](0014-cognitive-primitives-as-deciders.md) | Cognitive primitives are deciders over the ledger | Accepted |
| [0015](0015-questions-as-ledger-records.md) | Questions are ledger records; humans answer through a web interface | Accepted |
| [0016](0016-orchestrator-owns-graph-mirroring.md) | The orchestrator owns graph mirroring; the graph is never a source of truth | Accepted |
| [0017](0017-deterministic-scoring-and-context-assembly.md) | Deterministic, replaceable scoring; context assembly as a pure package | Accepted |
| [0018](0018-reasoning-and-orchestration.md) | The reasoning port, the Bedrock adapter, and the core orchestrator | Accepted (amends 0007 rule 1) |
| [0019](0019-experiment-engine-and-verification.md) | Experiment Engine and Verification Sandbox | Accepted |
| [0020](0020-agent-protocol-and-runtime.md) | The agent protocol, the agent runtime, and how an agent's work rejoins the core | Accepted (amends 0001 dependency table) |
| [0021](0021-impact-leases-and-serialised-factory-work.md) | Impact leases, and why factory work stays serialised | Accepted |
| [0022](0022-reasoning-purposes-not-prompts.md) | Purposes, not prompts: how a role varies what it asks for | Accepted (amends 0018 §3) |
| [0023](0023-software-factory-and-the-verified-artifact.md) | The software factory, and what a verified artifact is | Accepted |
| [0024](0024-dynamodb-single-table-and-cloud-persistence.md) | DynamoDB Single-Table and Cloud Persistence | Accepted |
| [0025](0025-cloud-runtime-and-what-is-not-adopted.md) | Cloud runtime and what is not adopted | Accepted |
| [0026](0026-infrastructure-as-typed-code-and-platform-ports.md) | Infrastructure as typed code and platform ports | Accepted |

## Statuses

`Proposed` · `Accepted` · `Superseded by ADR-XXXX` · `Deprecated`
