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

## Statuses

`Proposed` · `Accepted` · `Superseded by ADR-XXXX` · `Deprecated`
