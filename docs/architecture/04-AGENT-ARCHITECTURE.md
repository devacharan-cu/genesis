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
| **Planner** | Decompose an active goal into an ordered plan of tasks with `contributesTo` justification | P6 |
| **Architect** | Propose structural decisions, component boundaries, and ADR drafts | P6 |
| **Researcher** | Resolve `SEARCH`-strategy uncertainties from project artifacts and permitted external sources | P6 |
| **Builder** | Produce code/config artifacts for a specified change | P7 |
| **QA** | Produce and run tests; report real results | P7 |
| **Security** | Review proposals against security policy; produce findings | P7 |
| **Verifier** | Review whether evidence is *adequate* and raise findings (trivial assertions, self-written tests, mocked subjects). The state machine itself is applied by the core's verification engine in P5 — see [SPEC-05](05-VERIFICATION-ARCHITECTURE.md) §3.6 | P7 |
| **Repair** | Diagnose a real failure and propose a fix | P7 |
| **Deployment** | Propose and execute deployments within policy | P8 |

**None of these is implemented before the Cognitive Core (P1–P5) is green.**
Building agents first is exactly the `LLM + prompt + vector DB` architecture the
project rejects, arrived at from the other direction.

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
```

The runtime rejects at startup any agent whose manifest requests a permission
not granted by policy, and rejects at runtime any proposal whose kind is not in
`proposalKinds`. Not every agent uses an LLM: the Verifier, for example, is
deterministic — it reads evidence and applies the state machine.

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

Every kind has a JSON Schema in `packages/protocol`. Messages failing schema
validation are rejected and logged as `ERROR`; they never reach an agent's
handler.

### 3.2 Delivery semantics

- At-least-once delivery; handlers must be idempotent on `Envelope.id`.
- Timeouts are mandatory. A silent agent is a failed agent.
- No broadcast. Agents do not talk to each other directly in P6/P7; all routing
  goes through the core so that every interaction is recorded. Direct
  agent-to-agent channels, if ever introduced, require an ADR.

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
2. Whether Planner output is itself a proposal (`ADD_NODE` of plan nodes) or a
   distinct message kind. Leaning proposal, for uniform audit.
3. Concurrency: multiple agents on one cycle requires optimistic concurrency on
   the impact set. Deferred to P6.
