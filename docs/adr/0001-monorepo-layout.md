# ADR-0001 — pnpm workspace monorepo layout

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`

## Context

GENESIS is deliberately layered: a Cognitive Core that owns canonical state,
storage adapters that must be swappable (SQLite now, DynamoDB/Neptune later),
and agents that must be structurally incapable of writing state directly
([SPEC-04](../architecture/04-AGENT-ARCHITECTURE.md) §1).

Those boundaries are the architecture. If they are enforced only by convention,
they erode — the first time an agent needs "just one read" from the store, the
import gets added and the guarantee is gone.

## Options considered

1. **Single package with `src/` modules.** Simplest tooling, one build. Module
   boundaries enforced only by lint rules, which are easy to suppress.
2. **pnpm workspace monorepo.** Package-level boundaries: an agent package that
   does not list the store package as a dependency *cannot import it*, and the
   type checker says so.
3. **Multiple repositories.** Strongest isolation, but version skew and
   cross-cutting changes become expensive at this stage.

## Decision

Adopt a **pnpm workspace monorepo**.

```
genesis/
├── packages/
│   ├── protocol/          # message + proposal types, JSON Schemas. Depends on nothing.
│   ├── core-types/        # canonical enums and record types. Depends on nothing.
│   ├── core/              # cognitive core: cycle, models, engines. Owns state writes.
│   ├── memory/            # MemoryStore port + logic
│   ├── graph/             # GraphStore port + logic
│   ├── ledger/            # EventLedger port + logic
│   ├── adapters-sqlite/   # P1 adapters
│   ├── adapters-aws/      # P8 adapters
│   ├── reasoning/         # ReasoningProvider port + mock/bedrock adapters
│   ├── sandbox/           # SandboxRunner port + adapters
│   ├── agents/            # agent implementations (P6+)
│   └── testkit/           # shared conformance suites + fixtures
├── apps/
│   └── cli/               # local operator CLI
├── docs/
└── tools/
```

Dependency rules, enforced by package manifests and a lint rule on import
paths:

- `agents/*` may depend on `protocol`, `core-types`, `testkit`.
  **It may not depend on `core`, `memory`, `graph`, `ledger`, or any adapter.**
- Adapters depend on their port package only, never on `core`.
- `core` depends on ports, never on a concrete adapter.
- `protocol` and `core-types` depend on nothing.

## Consequences

**Positive**

- The "agents cannot write state" rule becomes a compile-time property, and is
  additionally covered by a conformance test ([SPEC-04](../architecture/04-AGENT-ARCHITECTURE.md) §6).
- Adapters are swappable by construction; the AWS migration is adding a package,
  not rewriting the core.
- Conformance suites live in one shared package and run against every adapter.

**Negative**

- More tooling setup: workspace config, shared tsconfig with project
  references, coordinated versioning.
- Cross-package refactors touch more files.
- Contributors must understand the dependency rules before adding an import.

**Mitigation:** a single `tools/check-boundaries.mjs` run in CI that fails on any
import violating the rules above, so the rule is mechanical rather than
remembered.
