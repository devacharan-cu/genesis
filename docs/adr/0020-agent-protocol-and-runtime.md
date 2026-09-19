# ADR-0020 — The agent protocol, the agent runtime, and how an agent's work rejoins the core

- **Status:** Accepted
- **Date:** 2026-09-19
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Implements:** P6 — SPEC-00 §8; SPEC-04
- **Builds on:** [ADR-0001](0001-monorepo-layout.md), [ADR-0005](0005-authority-over-confidence.md), [ADR-0006](0006-proposal-based-mutation.md), [ADR-0014](0014-cognitive-primitives-as-deciders.md), [ADR-0018](0018-reasoning-and-orchestration.md), [ADR-0019](0019-experiment-engine-and-verification.md)

## Context

P1–P5 built a cognitive core that already holds every property agents could
threaten. The ledger sequences and hashes (ADR-0009). The deciders own cognitive
transitions (ADR-0014). The orchestrator is the single path from model output to
canonical state, and it already narrows that path to four proposal kinds, checks
goal contribution, and records the whole run (ADR-0018). The graph is derived,
never a source (ADR-0016). Authority is capped per actor kind, and `AGENT` tops
out at `EVIDENCE` (ADR-0005).

P6 adds agents. The risk is not that agents are hard to build — it is that
building them is the easiest possible way to undo all of the above. The two
failure modes are concrete:

1. **A second orchestration architecture.** An agent runtime that assembles its
   own context, calls its own provider, and writes its own events would
   duplicate the orchestrator and would not inherit any of its guarantees. The
   ledger would then have two kinds of run, only one of which is replayable.
2. **An agent that is a source of truth.** Anything that lets an agent hold
   state, or hand the core a conclusion rather than a proposal, makes model
   output into project truth by a side door.

We must decide the package boundaries, the message protocol, where the runtime
lives, what an agent may be handed, how failure and retry work, and what
concurrency is permitted.

## Decision

### 1. Two new packages, and an amendment to ADR-0001's dependency table

| Package | Holds | May depend on |
|---|---|---|
| `protocol` | The message envelope, the nine message bodies, `AGENT_ROLES`, the agent manifest, the task states, and the run summary. Schemas and pure functions only. | `core-types` |
| `agents` | The agent contract, the services an agent is handed, the registry, and the role implementations. | `core-types`, `protocol`, `testkit` |

ADR-0001's table listed `protocol: []`. One amendment: **`protocol` may depend on
`core-types`.** Without it, `protocol` would redeclare `Authority`, `ActorKind`
and the id shapes, producing two enumerations with one name. This repository
already has that scar written into `core-types/src/actor.ts`. `core-types` is
inert vocabulary with no dependency of its own and no capacity to write
anything, so depending on it costs nothing the boundary was protecting.

`agents` keeps exactly the dependencies ADR-0001 gave it. It does **not** get
the reasoning port, which §2 explains. What it must never reach stays out:
`ledger`, `memory`, `graph`, `cognition`, `context`, `reasoning`, `experiment`,
`verification`, `core`, and every adapter. **"An agent cannot mutate canonical
state" is therefore a property of the package graph**, checked by
`tools/check-boundaries.mjs` on every run, not a promise in a document.

### 2. An agent frames work; the core runs it. Agents hold no provider.

`AgentRuntime` is part of `core`. It does not assemble context, does not call a
provider, and does not append cognitive events. For the reason-and-propose leg
of any agent task it calls the existing `Orchestrator`, which already does all
three, correctly and reproducibly.

The division is the load-bearing part:

- An agent implements `frame(assignment)`, a **pure** function returning a
  `TaskFraming`: a task kind, the text of what this run is for, the nodes it
  concerns, the goal it serves, and a token budget. That is the whole of a
  role's influence over a model call. There is no prompt, no system message, no
  model id and no sampling parameter in a `TaskFraming`, so **a role cannot
  smuggle model-specific behaviour in as text**.
- The core runs it. The orchestrator assembles context, builds the request, calls
  the provider under budget, records the call, and puts each proposal through
  the cognitive deciders.
- The agent then receives a `RunSummary`: what its proposals came to, and what
  context the run was shown. Not the raw model output — so a role cannot
  reinterpret rejected output into something it prefers.

An agent therefore never holds a `ReasoningProvider`, which is why `agents`
needs no dependency on `reasoning`. An agent that wanted to make its own model
call has nothing to make one with.

The orchestrator gains one parameter: the actor a run records its proposals as,
together with the set of proposal kinds that actor may use. Its default stays
exactly what P4 shipped.

Deterministic agents — the Verifier, parts of QA — return no framing at all.
They receive the evidence in their assignment, and their proposals go through
`evaluateProposal`, the function the orchestrator itself uses. One door, two
callers, rather than two doors.

### 3. An agent's manifest can only narrow, never widen

`checkProposal` in `core/src/proposals.ts` remains the only gate that decides
what a proposal may be. An agent's `proposalKinds` is intersected with that set.
A manifest naming a kind the core does not permit is rejected **at
registration**, not at use: a runtime that discovers an impossible capability
only when an agent tries to exercise it has already shipped the misconfiguration.

Consequently an agent cannot propose `TRANSITION_BELIEF`, cannot resolve an
uncertainty, cannot answer a question, and cannot set a `VerificationState`,
because no proposal kind does those things.

### 4. Authority is unchanged, and that is the point

The runtime adds no authority rule. It records the agent as the acting `AGENT`,
and the existing machinery does the rest: the ledger refuses an authority above
the `AGENT` ceiling of `EVIDENCE` (ADR-0005), and the belief rules cap anything
derived from a reasoning call at `AI_ASSUMPTION` (ADR-0018 §3). An agent
carrying an `authorityClaim` has it clamped, and the clamp is recorded
(ADR-0011).

A new rule here would be a new place to get it wrong. There is none.

### 5. Messages are typed, project-scoped, and recorded

The nine kinds of SPEC-04 §3.1 are the vocabulary, fixed as a canonical
enumeration. Every message travels in an `Envelope` carrying its id, kind,
sender, recipient, cycle, correlation and issue time, and every envelope the
runtime accepts or emits becomes a ledger event in the project it belongs to.

Three properties follow, and are tested rather than asserted:

- **Attributable.** The envelope names an actor, and the ledger records it.
- **Serialisable.** Envelope bodies are `JsonValue`, so an envelope survives the
  round trip through the ledger unchanged.
- **Deterministic.** Ids and the clock are injected. For a given ledger, task,
  and provider output, an agent task appends the same events in the same order.

A malformed envelope never reaches an agent's handler. It is rejected at the
boundary and recorded as a rejection, so the ledger shows what was refused
rather than silently showing nothing.

### 6. The task state machine

An agent task is in exactly one `AgentTaskState`, and the runtime records every
transition. The states are canonical (SPEC-00 §4). `COMPLETED`, `FAILED` and
`CANCELLED` are terminal; `BLOCKED` is not, because what blocks a task can be
resolved.

The prompt-level sketch of a lifecycle — receive, reason, propose, check,
execute, observe, verify — is not duplicated here as states, because most of
those steps are already events on the orchestrator's run record (ADR-0018 §3).
Recording them twice would create two answers to "what did this task do", which
is the same mistake as a second event store in miniature.

### 7. Failure, timeout and retry

- Every assignment carries a deadline. A silent agent is a failed agent: the
  runtime settles the task itself rather than waiting.
- A failure is typed and carries a **signature**, in the form the self model
  already folds into `knownFailures` (SPEC-01 §4). Repeated failure of one kind
  is therefore something the system learns, not something a log holds.
- Retry is bounded and explicit. A retried task keeps its `taskId` and gains an
  attempt number, so the ledger shows one task with several attempts rather than
  several unrelated tasks. Attempts past the bound leave the task `FAILED`.
- A task whose agent throws, times out, returns a malformed outcome, or returns
  an outcome for the wrong task is failed by the runtime, not trusted.

### 8. Verification stays where it is

An agent may **request** verification and may **submit** evidence. It may not
perform verification. The runtime hands submitted evidence to the P5
`VerificationEngine`, which is deterministic and lives in the core's reach, and
the resulting state is the engine's, never the agent's. A Verifier agent's job
is to judge whether evidence is *adequate* and to raise findings — a trivial
assertion, a self-written test, a mocked subject — which is a different question
from what state the evidence justifies.

### 9. Concurrency: one task at a time per project, for now

Agent tasks for one project are serialised in-process, exactly as cognitive
commands and orchestrator runs already are. Parallel agents need optimistic
concurrency over the impact set, and SPEC-04 §7 leaves that open.

We do not take it here, because we cannot yet prove it safe: two agents
proposing into one cognitive state would race on the very conditional-append
rule that ADR-0014 relies on. Ownership is therefore trivial and stated: **one
task has exactly one agent, and one project runs one agent task at a time.**

Conflicting proposals are not prevented — they are *preserved*. Two proposals
that cannot both hold become a contradiction through the existing contradiction
engine (SPEC-01 §8), which keeps both sides and refuses to guess. Duplicated
work is visible because both tasks are on the ledger against the same goal.

## Consequences

**Positive**

- There is one orchestration path, one event store, one door from model output
  to state, and one authority rule. P6 adds agents without adding a second of
  anything.
- The central safety claim is enforced by the build. An agent that imports a
  store fails `check-boundaries.mjs`, and that checker has a negative test
  proving it can fail.
- Agents are testable without a model: the manifest declares whether a role
  reasons at all, and the ones that do are tested against the mock provider.

**Negative**

- Serialising agent tasks per project caps throughput at one task at a time.
  For a system whose bottleneck is a model call, this is real.
- Putting the runtime in `core` makes an already central package larger, and
  `core` now depends on `protocol` as well.
- Reusing the orchestrator means an agent's reasoning leg inherits the
  orchestrator's constraints, including its four proposal kinds. A role that
  genuinely needs a fifth cannot have one without a core change — deliberately.
- A role's influence over its own model call is a `TaskFraming` and nothing
  else. Roles that would genuinely benefit from a different system prompt
  cannot have one until an ADR gives the framing somewhere to say so.

**Mitigations**

- Concurrency is deferred, not refused. The runtime's queue is one function; the
  ADR that lifts it must first define conflict semantics over the impact set.
- The runtime is registered safety-critical and held to 100% branch coverage,
  as every other module on the path from model output to state already is.
- A conformance suite runs over every registered agent and proves the negative
  cases directly: no store handle reaches an agent, a manifest cannot widen the
  proposal set, and an agent's claimed authority does not survive contact with
  the ledger.
