# ADR-0019 — Experiment Engine and Verification Sandbox

- **Status:** Accepted
- **Date:** 2026-09-19
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Implements:** P5 — SPEC-00 §8; SPEC-05
- **Builds on:** [ADR-0003](0003-ports-and-adapters-persistence.md), [ADR-0006](0006-proposal-based-mutation.md)

## Context

Phase 5 requires an Experiment Engine and Verification Sandbox to enact the central claim of SPEC-05: *Generation is not verification.* We must run experiments in strict isolation and map their outcomes to immutable evidence records, which transition an artifact's `VerificationState` deterministically.

We need to decide:
1. The package boundaries and dependency rules for P5.
2. The shape of the `SandboxProvider` port and its local adapter.
3. How verification states and evidence records interact with the ledger.

## Decision

### 1. Package Boundaries

We introduce four new packages for P5. They follow the ports-and-adapters architecture:

| Package | Holds | May depend on |
|---|---|---|
| `sandbox` | The `SandboxProvider` port, `SandboxRequest`/`Result` schemas, typed `SandboxError`, and a deterministic `MockSandboxProvider`. | `core-types` |
| `adapters-sandbox-local` | The local subprocess implementation of the `SandboxProvider`. Provides process isolation via temp directories. | `core-types`, `sandbox` |
| `verification` | The pure state machine mapping Evidence (SPEC-02 §3.1) to `VerificationState` (SPEC-05 §2). It has no authority to alter canonical code. | `core-types` |
| `experiment` | Orchestrates running an experiment. Issues the sandbox call, enforces timeouts/cancellation, and appends evidence records. | `core-types`, `ledger`, `memory`, `graph`, `projections`, `sandbox`, `verification` |

### 2. The Sandbox Port and Errors

The `SandboxProvider` exposes:
`run(request: SandboxRequest, abortSignal?: AbortSignal) → Promise<SandboxResult>`

A `SandboxRequest` contains the entrypoint command, environment variables, working directory setup (files to write), and `timeoutMs`.
A `SandboxResult` contains the `exitCode`, captured `stdout`/`stderr` (truncated to a safe size), and `durationMs`.

Errors are typed as `SandboxError` with kinds:
- `TIMEOUT`: The `timeoutMs` was exceeded, and the process was forcefully killed.
- `CANCELLED`: The `abortSignal` triggered.
- `SETUP_FAILED`: The sandbox could not be created (e.g. disk full).
- `TEARDOWN_FAILED`: The sandbox leaked resources.
- `UNKNOWN`

### 3. Experiments and Verification on the Ledger

An experiment is a lifecycle over the ledger:
1. `EXPERIMENT_STARTED`: Records the target task, the sandbox parameters, and the hypothesis.
2. `EXPERIMENT_COMPLETED` / `EXPERIMENT_FAILED`: Records the outcome (exit code, output) as a structured **evidence record** (`observation.raw`, `observation.hash`).
3. `VERIFICATION_STATE_CHANGED`: Appended by the `verification` engine when new evidence justifies a state transition (or regression) for an artifact.

Evidence is an observation mapping to states like `STATIC_CHECKED` or `UNIT_TESTED`. The verification engine is deterministic: if an evidence record lacks a passing exit code or fails to attribute coverage to the artifact, the engine does not advance the state. An agent cannot simply assert `VerificationState: UNIT_TESTED`.

## Consequences

**Positive**
- Strictly decouples generation from verification, preventing "self-certification" by LLMs.
- Active project state is perfectly isolated from unproven experiments.
- The local adapter explicitly acknowledges its trust boundaries (it uses subprocesses, not true containers yet, but the *port* allows upgrading to containers later).

**Negative**
- The `adapters-sandbox-local` relies on OS-level subprocess killing, which can be inconsistent on Windows vs. POSIX (mitigated by strict cleanup logic).

**Mitigations**
- We will enforce 100% branch coverage on the sandbox teardown and timeout logic to prevent orphaned processes and file locks.
- The `verification` package will be exhaustively tested against edge cases (e.g. tests that assert nothing) to ensure the state machine is sound.

