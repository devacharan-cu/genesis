# GENESIS — Agent Architecture

**Document ID:** `SPEC-04` · **Subordinate to:** [`00-MASTER-SPEC.md`](00-MASTER-SPEC.md)

Defines the agent roster, the typed message protocol, the proposal-based
mutation model, and the order in which agents are built.

---

## 1. Position in the system

Agents are **workers with narrow mandates**. They do not own state. They receive
a task plus an assembled context, do bounded work, and return typed results —
most importantly, **proposals**.

```
  ┌──────────────────────────────────────────────┐
  │                COGNITIVE CORE                │
  │  assembles context · applies proposals       │
  │  owns canonical state · appends events       │
  └───────┬───────────────────────────▲──────────┘
          │ TaskAssignment            │ Proposal / Finding / Question
          ▼                           │
  ┌──────────────────────────────────────────────┐
  │              AGENT RUNTIME (bus)             │
  │  routing · timeouts · retries · permissions  │
  └───────┬──────────────────────────────────────┘
          │
   ┌──────┴──────┬──────────┬─────────┬──────────┐
   │ Planner     │ Builder  │ QA      │ Verifier │  ...
   └─────────────┴──────────┴─────────┴──────────┘
```

**The hard rule:** an agent has no write access to canonical state. Not to
memory, not to the graph, not to the ledger. The only thing an agent can do to
state is *propose*.

Why: it makes every state change auditable to a decision point, it lets policy
run before mutation, and it means a misbehaving or hallucinating agent produces
a rejected proposal rather than corrupted truth.

---

## 2. Agent roster and phasing

| Agent | Mandate | Phase |
|---|---|---|
| **Planner** | Decompose an active goal into an ordered plan of tasks with `contributesTo` justification | P6 ✅ |
| **Architect** | Propose structural decisions, component boundaries, and ADR drafts | P6 ✅ |
| **Researcher** | Resolve `SEARCH`-strategy uncertainties from project artifacts and permitted external sources | P6 ✅ |
| **Builder** | Produce code/config artifacts for a specified change | P7 |
| **QA** | Produce and run tests; report real results | P7 |
| **Security** | Review proposals against security policy; produce findings | P7 |
| **Verifier** | Review whether evidence is *adequate* and raise findings (trivial assertions, self-written tests, mocked subjects). The state machine itself is applied by the core's verification engine in P5 — see [SPEC-05](05-VERIFICATION-ARCHITECTURE.md) §3.6 | P6 ✅ (deterministic) |
| **Repair** | Diagnose a real failure and propose a fix | P7 |
| **Deployment** | Propose and execute deployments within policy | P8 |

A tick marks a role that exists. The rest are declared so that policy and
routing cover them before anyone writes one.

**None of these was implemented before the Cognitive Core (P1–P5) was green.**
Building agents first is exactly the `LLM + prompt + vector DB` architecture the
project rejects, arrived at from the other direction.

The roster is canonical (SPEC-00 §4, `canonical:AgentRole`), so a role exists in
one place and every policy covers it.

Each agent declares, statically:

```
AGENT_MANIFEST
  id, role, version
  capabilities      [string]
  requiredTools     [toolId]
  permissions       [{ scope, level }]      // least privilege, see SPEC-06
  maxContextTokens  number
  timeoutMs         number
  proposalKinds     [ProposalKind]          // what it is allowed to propose
  reasoningProvider ProviderRef | null      // some agents are deterministic
  maxAttempts       number                  // bounded retry, see §8
```

The registry rejects at registration any agent whose manifest requests a
permission policy does not grant, a tool the deployment does not have, a
reasoning provider that does not exist, a role already filled, or a proposal
kind the core has no schema for. Registration is the last cheap moment to refuse
a misconfigured agent; after it, every refusal costs a failed task.

`proposalKinds` is **intersected** with the core's set, never added to it. An
agent can narrow what it may propose and can never widen it
([ADR-0020](../adr/0020-agent-protocol-and-runtime.md) §3).

Not every agent uses a model. The Verifier is deterministic: it reads evidence
and judges whether that evidence is *adequate*. `reasoningProvider: null` is a
real answer, and an agent that does not reason is one whose output needs no mock
to be tested.

---

## 3. Message protocol

All inter-component traffic is typed, versioned, and serialisable. Messages are
data; there is no shared mutable object passed between agents.

```ts
type Envelope<T> = {
  id: MessageId;                 // ULID
  schemaVersion: '1';
  kind: MessageKind;
  from: ActorRef;                // { kind: CORE|AGENT|HUMAN|SYSTEM, id, role? }
  to: ActorRef;
  cycleId: CycleId | null;
  correlationId: MessageId | null;   // request this replies to
  causationId: EventId | null;
  issuedAt: string;
  expiresAt: string | null;
  body: T;
};
```

### 3.1 Message kinds

The nine kinds are canonical (SPEC-00 §4, `canonical:MessageKind`). There is no
tenth and no free-form channel: traffic that is not one of these does not cross
the bus.

| Kind | Direction | Body |
|---|---|---|
| `TASK_ASSIGNMENT` | core → agent | task, goal ref, assembled context, budget, deadline |
| `PROPOSAL` | agent → core | requested state change (§4) |
| `FINDING` | agent → core | an observation or concern that is not a state change |
| `QUESTION` | agent → core | an uncertainty the agent cannot resolve itself |
| `EVIDENCE_SUBMISSION` | agent → core | raw output + metadata from a real execution |
| `STATUS` | agent → core | progress, partial results, heartbeat |
| `RESULT` | agent → core | terminal outcome of the assigned task |
| `ERROR` | any → core | typed failure with a signature for `knownFailures` |
| `CANCEL` | core → agent | withdraw an in-flight task |

Every kind has a schema in `packages/protocol`, and every body is strict: a
field nobody declared is a field nobody checked, and an agent that can attach
one has an unaudited channel. Messages failing validation are rejected at the
boundary and recorded as a rejection; they never reach a handler.

**No body can say what is true.** None has a verification state, and only a
proposal carries an `authorityClaim` — advisory, clamped by the core (§4.2). An
agent submits what happened; what that justifies is the core's to decide.

### 3.2 Delivery semantics

- At-least-once delivery; handlers must be idempotent on `Envelope.id`.
- Timeouts are mandatory. A silent agent is a failed agent: the runtime settles
  the task itself rather than waiting for one that will not answer.
- No broadcast. Agents do not talk to each other directly in P6/P7; all routing
  goes through the core so that every interaction is recorded. Direct
  agent-to-agent channels, if ever introduced, require an ADR.
- Direction is enforced, not conventional. An agent cannot send itself a task
  assignment, because assigning yourself work is the first step of deciding what
  you should be doing.

### 3.3 What an agent is handed

An agent receives an assignment and four services: a read of what its run came
to, a clock, an id source, and a cancellation signal. No store, no ledger, no
engine, no reasoning provider.

This is enforced by the package graph. `packages/agents` may depend on
`core-types` and `protocol` and nothing else, checked by
`tools/check-boundaries.mjs` on every run — so **"an agent cannot mutate
canonical state" is a property of the build**, not a promise in this document.

An agent influences its own model call through a `TaskFraming`: a task kind,
what the run is for, the nodes it concerns, the goal it serves, and a budget.
There is no prompt, system message, model id or sampling parameter in a framing,
so a role cannot smuggle model-specific behaviour in as text
([ADR-0020](../adr/0020-agent-protocol-and-runtime.md) §2).

---

## 4. Proposal protocol

A proposal is a **requested** change. It is inert until the core applies it.

```ts
type Proposal = {
  id: ProposalId;
  kind: ProposalKind;      // ADD_NODE | ADD_EDGE | WRITE_MEMORY | UPDATE_ARTIFACT
                           // | OPEN_ISSUE | TRANSITION_BELIEF | SCHEDULE_EXPERIMENT
                           // | REQUEST_DEPLOYMENT | RETIRE_REQUIREMENT
  proposedBy: ActorRef;
  contributesTo: GoalId[];         // required and non-empty
  rationale: string;               // required
  changes: ChangeOp[];             // the concrete operations
  expectedImpact: NodeId[];        // agent's claim; core recomputes independently
  evidenceRefs: MemoryId[];        // supporting evidence, may be empty
  authorityClaim: Authority;       // clamped by the core (§4.2)
  reversible: boolean;
  status: 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'PARTIALLY_ACCEPTED' | 'DEFERRED';
  decision?: { by: ActorRef; reason: string; at: string; rejectedOps?: number[] };
};
```

### 4.1 Core evaluation pipeline

Every proposal runs the change lifecycle from
[`00-MASTER-SPEC.md`](00-MASTER-SPEC.md) §4.5:

```canonical:ChangeLifecycle
PROPOSE
IMPACT_ANALYSIS
POLICY_CHECK
APPLY
TEST
VERIFY
COMMIT_STATE
```

| Stage | What the core does | Rejection reasons |
|---|---|---|
| `PROPOSE` | Schema-validate; check `proposalKinds`; require non-empty `contributesTo` and `rationale` | Malformed; unauthorised kind; no goal linkage (goal drift) |
| `IMPACT_ANALYSIS` | Recompute the impact set from the graph, **ignoring** `expectedImpact` | Impact set intersects a blocked/contradicted region |
| `POLICY_CHECK` | Evaluate security policy, permissions, authorization gates | Insufficient permission; high-risk op without human authorization |
| `APPLY` | Write changes transactionally, append events | Invariant violation (graph G1–G10, memory schema) |
| `TEST` | Trigger the relevant test set for the impact set | Tests fail → automatic rollback of `APPLY` |
| `VERIFY` | Advance `VerificationState` only on real evidence | No evidence → state does not advance |
| `COMMIT_STATE` | Mark the change committed; update projections | — |

`expectedImpact` being wrong is not itself a rejection; it is recorded as a
calibration signal about that agent. Persistent mis-estimation is a `FINDING`
against the agent, which is how the self model learns an agent's limitations.

### 4.2 Authority clamping

`authorityClaim` is advisory. The core clamps it:

- Proposals from agents whose work came from a reasoning provider are clamped to
  `AI_ASSUMPTION`.
- Proposals carrying evidence refs from real executions may reach `EVIDENCE`.
- `VERIFIED_SYSTEM_STATE` requires observation of the real target environment.
- `HUMAN_DECISION` is unreachable from an agent by construction.

An agent cannot elevate its own truth. This is the concrete mechanism behind
"AI assumptions must never automatically become verified project truth."

### 4.3 Partial acceptance

The core may accept some `ChangeOp`s and reject others, recording which and why.
The agent is informed and may resubmit. This avoids all-or-nothing churn on
large proposals.

### 4.4 One door, two callers

Every proposal — from an agent's reasoning run and from a deterministic agent
alike — goes through the same evaluation, in the same order, with the same
refusals. The orchestrator and the agent runtime both call it. Two paths to
canonical state would be two sets of rules that disagree eventually
([ADR-0020](../adr/0020-agent-protocol-and-runtime.md) §2).

A deterministic agent's proposal records no reasoning call, because inventing
one would attribute a belief to a model that was never asked.

---

## 4a. Agent task lifecycle

A task is in exactly one `AgentTaskState` (SPEC-00 §4,
`canonical:AgentTaskState`), and the runtime records every transition.
`COMPLETED`, `FAILED` and `CANCELLED` are terminal. `BLOCKED` is not, because
what blocks a task can be resolved.

```
ASSIGNED ──► RUNNING ──► AWAITING_VERIFICATION ──► COMPLETED
    │           │  ▲                   │
    │           ▼  │                   │
    │        BLOCKED                   │
    ▼           ▼                      ▼
        FAILED · CANCELLED (from any non-terminal state)
```

What a task is *doing* is not modelled as state. Context assembly, the reasoning
call and each proposal are already the orchestrator's events under the same
cycle. Recording them twice would give two answers to "what did this task do".

The task projection rebuilds all of this from the ledger, and **re-checks every
recorded transition against the table**. If the runtime and the projection ever
disagree about what is legal, the ledger says so rather than taking the
runtime's word. A task with no finish is INTERRUPTED: the process stopped
mid-task, which is visible rather than lost.

---

## 4b. Failure, retry and cancellation

- Every assignment carries a deadline, and the runtime settles the task itself
  when it passes. A silent agent is a failed agent.
- A cancellation settles the wait immediately. An agent that ignores its signal
  would otherwise turn a cancel into a delay.
- Failures are typed: `TIMEOUT`, `CANCELLED`, `AGENT_THREW`, `MALFORMED_OUTPUT`,
  `CAPABILITY_REFUSED`, `REASONING_FAILED`, `DEPENDENCY_FAILED`, `BLOCKED`.
- Each carries a **signature** naming the role, the task kind and the failure
  kind — never the message, because a signature that changes every time groups
  nothing. It is recorded in the self model's own vocabulary, so a role that
  keeps failing the same way is something the system learns (SPEC-01 §4).
- Retry is bounded by the manifest's `maxAttempts` and keeps one `taskId`, so
  the ledger shows one task with several attempts. Each retry is a real pair of
  recorded moves, not a second assignment appearing from nowhere.
- A cancelled task is not retried: the caller has already said to stop.

---

## 4c. Concurrency and conflict

**One task has exactly one agent, and one project runs one agent task at a
time.** Agent tasks are serialised per project, exactly as cognitive commands
and orchestrator runs already are.

Parallel agents need optimistic concurrency over the impact set, and that is not
taken here because it cannot yet be shown safe: two agents proposing into one
cognitive state would race on the conditional-append rule ADR-0014 relies on.
Lifting this requires an ADR that first defines conflict semantics.

Conflicting proposals are not prevented — they are **preserved**. Two claims
that cannot both hold become a contradiction through the existing contradiction
engine (SPEC-01 §8), which keeps both sides and refuses to guess. Duplicated
work is visible because both tasks are on the ledger against the same goal.

---

## 4d. Verification handoff

An agent may **request** verification and may **submit** evidence. It may not
perform verification.

Submitted evidence goes to the P5 verification engine, and the state it returns
is the engine's. With no verifier configured, the evidence is recorded and
nothing is claimed about it — the honest default.

A Verifier agent judges whether evidence is *adequate*: a failing run proves
nothing passed, silent output attributes nothing, output that never mentions the
artifact is an unattributed claim, and an end-to-end result from a local
environment describes no deployed system. That is a different question from what
state the evidence justifies, and the Verifier never answers the second one.

---

## 5. Agent execution environment

- Agents run in the sandbox tier defined in
  [`06-SECURITY-ARCHITECTURE.md`](06-SECURITY-ARCHITECTURE.md).
- Filesystem access is limited to an explicitly mounted workspace.
- Network access is deny-by-default with an allowlist per agent role.
- No agent receives cloud administrator credentials, production credentials, or
  raw secret material.
- Every tool invocation is recorded as an event with arguments and result hash.

---

## 6. Determinism and testability

- Agents that use a reasoning provider are tested against the **mock provider**
  with recorded fixtures, so the agent's own logic is tested deterministically.
- Agents that do not use a reasoning provider (Verifier, parts of QA) are fully
  deterministic and unit-tested normally.
- Every agent has a conformance test proving it **cannot** write state directly:
  the test grants it a store handle and asserts the write is refused.

---

## 7. Open design questions

1. Bus implementation for P6 (in-process typed queue) vs P8 (EventBridge +
   Step Functions) — the port is defined in P6, the cloud adapter in P8.
2. ~~Whether Planner output is itself a proposal or a distinct message kind.~~
   **Settled in P6:** a proposal, for uniform audit. Every role's output reaches
   state through the one proposal door and nothing else.
3. ~~Concurrency: multiple agents on one cycle.~~ **Deferred again, explicitly**
   (§4c and [ADR-0020](../adr/0020-agent-protocol-and-runtime.md) §9). One
   project runs one agent task at a time until an ADR defines conflict semantics
   over the impact set. Parallelism is not assumed safe because it has not been
   shown to be.
4. Whether a role should be able to vary its own system prompt. It cannot today,
   by construction (§3.3), and lifting that needs an ADR — it is the seam through
   which model-specific behaviour would re-enter the domain.
