# ADR-0023 — The software factory, and what a verified artifact is

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Implements:** P7 — SPEC-00 §8; SPEC-04; SPEC-05
- **Builds on:** [ADR-0019](0019-experiment-engine-and-verification.md), [ADR-0020](0020-agent-protocol-and-runtime.md), [ADR-0021](0021-impact-leases-and-serialised-factory-work.md), [ADR-0022](0022-reasoning-purposes-not-prompts.md)

## Context

P6 delivered an agent runtime: one task, one agent, recorded and replayable. P7
has to turn that into a factory — intent in, verified artifact out — across
Builder, QA, Security, Repair and Verify.

The failure mode is specific and it is not subtle. A factory is the place where
"it worked" gets decided, and every shortcut in it produces a system that
reports success it has not earned:

- a Builder that writes a file and calls the change done;
- a QA stage that runs a suite and reads *the suite passed* as *this artifact is
  tested*;
- a Security stage that returns a plausible list of concerns from a model;
- a Repair loop that retries until something goes green;
- a "verified" flag written by whichever component last touched the change.

Each is easy to build and each is worse than having no factory, because the
output looks the same as a real one.

## Decision

### 1. `packages/factory`, driving the runtime rather than replacing it

The factory is a **policy layer over the P6 runtime**, in its own package. It
may depend on `core`, `agents`, `protocol`, `core-types`, `ledger`,
`projections` and `verification`. It is not part of the core's trust boundary,
and being a separate package makes that structural rather than stated.

What the factory does: decides which stage runs next, assigns typed tasks
through `AgentRuntime.assign`, reads structured results, routes failures, bounds
retries, and records its own run on the ledger.

What the factory does **not** do, and cannot: assemble context, call a provider,
append a cognitive event, write the graph, or decide a verification state. Every
one of those already has an owner, and the factory calls that owner.

There is no second orchestrator. There is no second event store. A factory run
is a sequence of agent tasks, each of which is an orchestrator run, each of
which is already recorded.

### 2. The pipeline

```canonical:FactoryStage
PLAN
ARCHITECT
BUILD
TEST
SECURITY_REVIEW
DIAGNOSE
REPAIR
VERIFY
```

Stages run in order. `DIAGNOSE` and `REPAIR` are entered only from a failure,
and a repaired change re-enters at `TEST` — never at `VERIFY`. A repair that
skipped QA and Security would be a fix nobody checked, which is the failure this
whole phase exists to prevent.

Each stage is serialised, takes an impact lease, and records entry and exit
([ADR-0021](0021-impact-leases-and-serialised-factory-work.md)).

### 3. The four new roles, and what each may actually claim

| Role | Does | Cannot |
|---|---|---|
| **Builder** | Frames a `PRODUCE_ARTIFACT` run; the core records each artifact at `GENERATED` | Mark anything tested, run its own tests, or write outside the proposal path |
| **QA** | Runs the artifact's tests in the sandbox and submits the real output as evidence | Decide what the evidence justifies, or pass a suite that never touched the artifact |
| **Security** | Applies deterministic checks to artifact contents and reports typed findings with the matched evidence | Claim a clean result it did not check for, or approve anything |
| **Repair** | Frames a `DIAGNOSE_FAILURE` run over a recorded failure, then proposes a bounded, targeted change | Retry blindly, skip QA or Security, or exceed its attempt bound |

Every one of them returns messages. None writes canonical state, because
`packages/agents` cannot reach anything that writes
([ADR-0020](0020-agent-protocol-and-runtime.md) §1).

### 4. Security review is a real static reviewer, and says what it is

The Security role runs deterministic checks over the proposed artifact's own
text: process and filesystem reach, dynamic evaluation, shell-shaped string
construction, path traversal, credential-shaped literals, network egress, and
authority escalation — an artifact that writes `HUMAN_DECISION` or
`VERIFIED_SYSTEM_STATE` is claiming an authority no generated code may assert.

Each finding carries the rule, a severity, the file, the line and **the matched
text**, so a finding can be checked rather than believed.

What it is not, stated here and in SPEC-06 rather than discovered later: it is a
pattern-based reviewer over artifact text. It performs no dataflow analysis, no
taint tracking, no dependency CVE lookup, and it does not see anything outside
the artifacts in the change. A clean result from it means *these checks did not
match*, and the factory reports it in exactly those words.

Findings at or above the configured blocking severity **stop the change before
`VERIFY`**. That is the only thing in the factory that can block a change on a
judgement rather than on an execution result, and it blocks rather than
approves — the asymmetry is deliberate.

### 5. What a verified artifact is

An artifact is verified when the **P5 verification engine** says so, from
evidence, and never otherwise. There is no second verification truth model and
no flag any component may set.

A `VerifiedArtifact` is a projection over the ledger, not a record anyone
writes:

```
VERIFIED_ARTIFACT
  artifactId, projectId            identity and isolation
  contentHash                      the exact bytes verified
  changeId, factoryRunId           the work that produced it
  state            VerificationState   from the P5 engine, from evidence
  evidence         [{ observationId, hash, environment, exitCode, testKind }]
  tests            [{ kind, passed, failed, attributed }]
  security         { checked, findings, blocking, clean }
  provenance       { proposedBy, stages, attempts }
  events           [seq]               every event that justifies the above
  verifiedAt       string | null       null unless state is above GENERATED
```

Four rules make it non-fakeable, and each is tested:

1. **The state comes from the engine.** The projection calls it with the
   evidence and records what it returns. It never computes a state itself.
2. **`GENERATED` is the default and the honest answer.** An artifact with no
   evidence is generated, not verified, and the field that says so is the same
   field that would say otherwise.
3. **A content hash change restarts verification.** A new version of an artifact
   is a new artifact record at `GENERATED`; nothing is inherited (SPEC-05 §2).
4. **Blocking security findings prevent advance regardless of evidence.** A
   change with unresolved blocking findings does not reach `VERIFY`, so its
   artifacts stay wherever their evidence left them.

The phrase the factory uses for a change that built and tested but was blocked
is not "failed" and not "done". It is *generated, not verified* — the same words
SPEC-05 §6 already requires.

### 6. The repair loop is bounded and explicit

```
FAILURE → DIAGNOSE → REPAIR PROPOSAL → POLICY CHECK → APPLY → TEST → SECURITY → VERIFY
```

- Bounded by `maxRepairAttempts`, default 3, from the role's typed config.
- On exhaustion the change is blocked, the failure history is kept in full, and
  a question is raised to a human (SPEC-05 §3.5). It does not keep trying and it
  does not declare success.
- Every attempt is on the ledger with its diagnosis, so a repair that made
  things worse is visible rather than overwritten.
- A repair never re-enters at `VERIFY`.

## Consequences

**Positive**

- Intent to verified artifact runs end to end, with every transition typed,
  project-scoped, recorded and replayable.
- The four new roles add no new way for model output to become truth: three of
  the four cannot propose canonical state at all, and the fourth goes through
  the same door as everything else.
- "Verified" has one definition, one owner, and a projection anyone can rebuild
  from the ledger to check.

**Negative**

- The factory is one more package that has to know the order of things, and the
  pipeline order is expressed in code rather than derived from the graph.
- Security review is shallow by construction. It will miss classes of problem
  that need dataflow, and a clean result is weaker than it sounds unless the
  wording is read carefully.
- Bounded repair means a genuinely fixable failure can end blocked because the
  third attempt ran out, and a human then picks it up.
- Serialised stages make a full run as slow as the sum of its model calls
  ([ADR-0021](0021-impact-leases-and-serialised-factory-work.md)).

**Mitigations**

- The pipeline order is one table, tested for the properties that matter:
  repair re-enters at `TEST`, nothing reaches `VERIFY` with blocking findings,
  and every stage is reachable.
- Security's limits are documented in SPEC-06 and reported in the run summary,
  and its result is phrased as *these checks did not match* rather than *clean*.
- Exhausted repair raises a question rather than closing quietly, so a human
  sees the ones the system could not finish.
