# ADR-0010 — Use the built-in `node:sqlite` driver for the P1 adapters

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`

## Context

[ADR-0003](0003-ports-and-adapters-persistence.md) makes SQLite the Phase-1
adapter behind the storage ports. It does not name a driver.

The choice matters more than it looks. The adapters are behind ports, so the
driver is replaceable — but it is also the one dependency that has to build and
run identically on every contributor's machine and in CI, and a native addon
that fails to compile blocks all work rather than one feature.

Measured on the development machine (WSL Ubuntu 26.04, Node v22.22.1): `make`,
`cc` and Python 3.14 are present, so native compilation is possible. Python 3.14
has removed `distutils`, which older `node-gyp` versions depend on, so a
compile-from-source path is not risk-free.

## Options considered

1. **`better-sqlite3`.** The mature choice, synchronous API, widely used. Ships
   prebuilt binaries for common platforms, falls back to `node-gyp`. Adds a
   native dependency and a compile risk on any platform without a prebuild.
2. **`node:sqlite`, built into Node 22.5+.** Zero dependencies, zero build step,
   synchronous API very close to `better-sqlite3`'s. Marked **experimental**, so
   the API may change across Node minor versions and it emits an
   `ExperimentalWarning`.
3. **`sql.js` (WASM).** No native build at all, but it is an in-memory database
   with manual persistence — wrong shape for a durable ledger.

## Decision

Use **`node:sqlite`** for the Phase-1 adapters, verified working on the target
Node version without any flag.

Constraints that make this safe to reverse:

1. **The driver is confined to `packages/adapters-sqlite`.** No other package
   imports it. This is enforced by `tools/check-boundaries.mjs`, so swapping
   drivers is a change to one package.
2. **The conformance suite is written against the port**, not against the
   driver ([ADR-0003](0003-ports-and-adapters-persistence.md)). A replacement
   adapter is accepted by passing the identical suite, which is exactly the
   escape hatch this decision needs.
3. **The Node version is pinned** in `package.json` `engines` and in CI, so an
   experimental-API change cannot arrive unnoticed through a background Node
   upgrade.
4. **The `ExperimentalWarning` is not suppressed.** Hiding it would mean
   forgetting the status of something we depend on.

## Consequences

**Positive**

- `pnpm install` cannot fail on a native build, on any platform. For a project
  whose first exit criterion is "the test suite runs", that is worth a lot.
- No prebuild matrix, no `node-gyp`, no Python dependency in CI.
- Sandboxed execution ([SPEC-06](../architecture/06-SECURITY-ARCHITECTURE.md) §4)
  gets simpler: the base image needs no build toolchain.
- The API is close enough to `better-sqlite3` that switching is mechanical.

**Negative**

- **It is experimental.** The API may change in a Node minor release, and
  `node:sqlite` has fewer users finding its edge cases than `better-sqlite3`.
- **Observed on day one:** the tooling around it has not caught up. Vite — which
  Vitest builds on — derives its list of Node builtins from
  `module.builtinModules`, and `sqlite` is absent from that list precisely
  *because* it is experimental, even though `module.isBuiltin('node:sqlite')`
  returns true. Vite therefore strips the `node:` prefix and tries to resolve a
  package called `sqlite`. Externalising it in the Vitest config does not help,
  because the prefix is gone before the externals list is consulted. The adapter
  loads the module through `createRequire` instead, which bypasses the bundler's
  module graph. This is recorded rather than quietly worked around: it is the
  first concrete instance of the cost this ADR accepted, and a second or third
  such workaround would be the signal to revisit the decision.
- Fewer features: no user-defined function ergonomics or extension loading to
  match the mature driver. FTS5 availability depends on how the bundled SQLite
  was compiled and must be verified before the memory adapter relies on it
  (SPEC-02 §8).
- Ties the project to Node 22+.

**Mitigations**

- Pinned Node version plus a CI job that runs the conformance suite on the next
  Node major, so an API change is found by a failing test rather than by
  a production incident.
- FTS5 availability is verified by a test before slice 2 depends on it; if it is
  absent, the fallback is a plain index, recorded as a defect rather than
  discovered later.
- Because of constraints 1 and 2, reversing this decision is a one-package
  change validated by an existing suite. This ADR would be superseded, not
  edited.
