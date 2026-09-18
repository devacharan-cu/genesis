# GENESIS — AWS Architecture

**Document ID:** `SPEC-07` · **Subordinate to:** [`00-MASTER-SPEC.md`](00-MASTER-SPEC.md)

Defines the AWS-native target deployment, the responsibility of each service,
and how cloud services attach to the ports defined elsewhere.

---

## 1. Rule of admission

> **Every AWS service must have a clear, singular responsibility that the
> architecture actually needs. A service that exists to look impressive is a
> defect.**

Each entry in §3 states what it owns and what breaks without it. Services
considered and **rejected** are listed in §6, with reasons — that list is part
of the design, not an omission.

Nothing in this document is built before P8
([`00-MASTER-SPEC.md`](00-MASTER-SPEC.md) §8). The purpose of writing it now is
to ensure the Phase-0 port definitions do not paint us into a corner.

---

## 2. Deployment shape

```
                       ┌───────────────────────────────┐
   Human ──▶ Amplify ─▶│  API Gateway (HTTP API)       │
   (console)           │  + Cognito authorizer          │
                       └───────────────┬───────────────┘
                                       │
                       ┌───────────────▼───────────────┐
                       │   Lambda: Core API handlers    │
                       │   (read state, submit intent)  │
                       └───────────────┬───────────────┘
                                       │
           ┌───────────────────────────┼──────────────────────────┐
           │                           │                          │
   ┌───────▼────────┐        ┌─────────▼─────────┐      ┌─────────▼────────┐
   │   DynamoDB     │        │  Step Functions   │      │   EventBridge    │
   │  canonical     │        │  cycle & change   │      │  event fan-out   │
   │  state + ledger│        │  orchestration    │      │                  │
   └───────┬────────┘        └─────────┬─────────┘      └─────────┬────────┘
           │ Streams                   │                          │
   ┌───────▼────────┐        ┌─────────▼─────────┐      ┌─────────▼────────┐
   │ Lambda:        │        │  Lambda: agents   │      │ Lambda: reactive │
   │ projections    │        │  + Bedrock        │      │ handlers         │
   │ → Neptune      │        │  (AgentCore)      │      │                  │
   └───────┬────────┘        └─────────┬─────────┘      └──────────────────┘
           │                           │
   ┌───────▼────────┐        ┌─────────▼─────────┐
   │   Neptune      │        │ Sandbox execution │
   │  graph queries │        │ (isolated tasks)  │
   └────────────────┘        └─────────┬─────────┘
                                       │
                             ┌─────────▼─────────┐
                             │       S3          │
                             │ evidence blobs,   │
                             │ artifacts, logs   │
                             └───────────────────┘
```

---

## 3. Service responsibilities

### 3.1 Amazon DynamoDB — canonical state and event ledger
**Owns:** memory records, graph nodes and edges (as items), proposals, cycles,
and the immutable event ledger.
**Why:** the access patterns are key-based, single-item and range reads with
strict write conditions — exactly DynamoDB's shape. Conditional writes give
optimistic concurrency on record versions, which is what `MemoryStore.put` and
proposal application need.
**Design:** single-table with a deliberate key schema; ledger in a separate
table configured write-once with deletion protection and a read-only role.
**Without it:** no durable canonical state.

### 3.2 DynamoDB Streams — projection updates
**Owns:** triggering projection rebuilds (world model, self model, graph
materialisation into Neptune) when records change.
**Why:** projections must not be updated by the writer — that couples them and
risks drift. A stream gives an ordered, at-least-once change feed.
**Without it:** projections are updated inline (coupling) or by polling
(latency and cost).

### 3.3 Amazon Neptune (+ Neptune Analytics) — graph traversal
**Owns:** `GraphStore.neighbourhood`, `impactSet`, `paths`, `findOrphans`.
**Why:** multi-hop traversal with edge-type and authority filters is the one
access pattern DynamoDB genuinely cannot serve well. Impact analysis
([`05-VERIFICATION-ARCHITECTURE.md`](05-VERIFICATION-ARCHITECTURE.md) §3.2)
is a bounded-depth traversal over a typed graph.
**Design:** Neptune is a **projection**, rebuildable from the ledger. It is not
a system of record. Neptune Analytics is used only if measured traversal cost on
real graph sizes justifies it — otherwise it is dropped.
**Without it:** traversals degrade to application-side BFS over DynamoDB, which
is correct but slow at depth; acceptable for small projects, not at scale.

### 3.4 Amazon S3 — evidence, artifacts, logs
**Owns:** raw evidence bytes (test output, experiment observations, coverage
reports), generated artifacts, build logs.
**Why:** content-addressed, versioned, cheap, and the hash-integrity requirement
in [`02-MEMORY-ARCHITECTURE.md`](02-MEMORY-ARCHITECTURE.md) §3.1 maps directly
onto object keys.
**Design:** versioning on, object lock considered for the evidence prefix,
SSE-KMS, no public access.
**Without it:** evidence records point at nothing, and the anti-fabrication rule
loses its teeth.

### 3.5 AWS Lambda — core handlers, projections, agents
**Owns:** stateless execution of API handlers, projection updaters, and agent
tasks.
**Why:** the workload is event-driven and bursty.
**Limit:** anything that may exceed Lambda's execution ceiling — long builds,
long test suites, experiments — does **not** run on Lambda; it runs in the
sandbox tier (§3.9).

### 3.6 Amazon API Gateway — external surface
**Owns:** the HTTP surface for the human console and any external integration,
with request validation, throttling and the Cognito authorizer attached.
**Without it:** Lambdas would need function URLs with hand-rolled auth.

### 3.7 AWS Step Functions — cycle and change orchestration
**Owns:** the cognitive cycle's phase sequence and the change lifecycle's stage
sequence, including timeouts, retries, and the **human approval wait** for
authorization gates ([`06-SECURITY-ARCHITECTURE.md`](06-SECURITY-ARCHITECTURE.md) §7).
**Why:** these are long-running, multi-step, must-be-auditable workflows with
explicit human-in-the-loop pauses. Encoding them in application code would mean
re-implementing durable execution badly.
**Design:** the state machine mirrors `CognitiveLoopPhase` and `ChangeLifecycle`
exactly, so the orchestration is readable against the spec.
**Without it:** cycle state would have to be hand-managed across Lambda
invocations.

### 3.8 Amazon EventBridge — event fan-out
**Owns:** distribution of ledger events to interested consumers (notifications,
scheduled cycles, reactive handlers) without the ledger writer knowing about
them.
**Why:** keeps the core from accumulating knowledge of downstream consumers.
**Without it:** consumers couple directly to the stream.

### 3.9 Sandbox execution tier — generated code, tests, experiments
**Owns:** every execution of code GENESIS produced, every test run, every
experiment.
**Why:** [`06-SECURITY-ARCHITECTURE.md`](06-SECURITY-ARCHITECTURE.md) §4
requires hard isolation, no ambient credentials, controlled egress, and captured
output. Lambda is unsuitable (duration, image control, egress control).
**Design:** isolated container tasks with a task role scoped to nothing but
writing evidence to one S3 prefix, no VPC egress by default, per-task limits.
The concrete runtime (ECS/Fargate vs CodeBuild vs Firecracker-backed) is a P8
decision requiring measured cold-start and isolation trade-offs — recorded as an
open question rather than pre-decided here.

### 3.10 Amazon Bedrock — reasoning provider
**Owns:** inference for the `ReasoningProvider` port.
**Why:** keeps model access inside the AWS trust and IAM boundary, with request
logging for the audit trail.
**Design:** Bedrock is the **first adapter**, not a dependency of the core
([ADR-0007](../adr/0007-reasoning-provider-port.md)). The core's full test suite
must pass with the mock adapter alone.

### 3.11 Amazon Bedrock AgentCore — agent runtime (conditional)
**Owns:** hosting the agent runtime and tool invocation loop, *if* evaluation
shows it fits.
**Status:** **conditional, not committed.** The proposal-based mutation model
([`04-AGENT-ARCHITECTURE.md`](04-AGENT-ARCHITECTURE.md) §4) is strict about
agents never touching state directly. AgentCore is adopted only if it can be
constrained to that model; otherwise agents run as Lambda/task workers behind
the same message port. Decision deferred to P8 with an explicit evaluation.
**This is deliberately not assumed.** Assuming it now would be exactly the
"added for appearance" failure this document forbids.

### 3.12 Amazon Cognito — human identity
**Owns:** authentication of humans, and the identity attached to
`HUMAN_DECISION` events and authorization-gate approvals.
**Why:** authority hierarchy is meaningless without knowing *which* human
decided. Every `HUMAN_DECISION` event carries a verified subject.
**Without it:** human authority claims are unattributable.

### 3.13 AWS Amplify — console hosting
**Owns:** hosting and CI/CD for the human-facing console (state, questions
awaiting answers, authorization requests, verification status).
**Why:** a static frontend with managed builds; no backend logic lives here.
**Constraint:** the console holds **no** AWS credentials. It authenticates via
Cognito and calls API Gateway. Nothing else.

### 3.14 Supporting services
- **AWS Secrets Manager / SSM Parameter Store** — resolution target for
  `SecretRef` ([`06-SECURITY-ARCHITECTURE.md`](06-SECURITY-ARCHITECTURE.md) §5).
- **AWS KMS** — encryption keys for S3, DynamoDB and secrets.
- **CloudWatch** — operational metrics and logs (distinct from the event ledger,
  which is the system's own history and lives in DynamoDB).
- **AWS IAM** — per-component roles; no shared roles, no wildcard admin.

---

## 4. Port → adapter mapping

| Port (defined P1) | Local adapter (P1) | AWS adapter (P8) |
|---|---|---|
| `MemoryStore` | SQLite | DynamoDB |
| `GraphStore` | SQLite recursive CTE | Neptune (Gremlin) |
| `EventLedger` | SQLite append-only table | DynamoDB write-once table |
| `BlobStore` | Content-addressed local dir | S3 |
| `SandboxRunner` | Local container | Isolated task tier |
| `ReasoningProvider` | Mock / direct API | Bedrock |
| `MessageBus` | In-process typed queue | EventBridge + Step Functions |
| `IdentityProvider` | Local dev identity | Cognito |
| `SecretResolver` | Encrypted local file | Secrets Manager / SSM |

**Acceptance rule for P8:** each cloud adapter must pass the *identical*
conformance suite its local counterpart passes
([`05-VERIFICATION-ARCHITECTURE.md`](05-VERIFICATION-ARCHITECTURE.md) §5). No
adapter ships on the strength of a manual smoke test.

---

## 5. Data classification and residency

| Data | Store | Encryption | Retention |
|---|---|---|---|
| Event ledger | DynamoDB (write-once) | KMS | Indefinite |
| Memory records | DynamoDB | KMS | Indefinite; archived tier |
| Evidence blobs | S3 (versioned) | KMS | Indefinite |
| Generated artifacts | S3 | KMS | Per project policy |
| Model request/response logs | S3 via Bedrock logging | KMS | Bounded window |
| Secrets | Secrets Manager | KMS | Rotated |
| Operational logs | CloudWatch | KMS | Bounded window |

---

## 6. Services considered and rejected

| Service | Rejected because |
|---|---|
| Amazon Kendra | Retrieval is graph- and authority-driven, not document-search-driven. Adding it would duplicate context assembly with a weaker ranking model. |
| Amazon OpenSearch | Not needed until text search outgrows DynamoDB + an embedding store; revisit in P3 with measured need, not before. |
| Amazon SageMaker | No model training is planned. The reasoning provider is inference-only. |
| Amazon RDS / Aurora | The canonical store's access patterns do not need relational joins; adding a second transactional store would split the system of record. |
| Amazon SQS | EventBridge plus Step Functions already covers routing and retries; SQS would be a third queueing concept without a distinct job. Revisit only if a genuine backpressure buffer is measured to be needed. |
| AWS AppSync | The console's needs are simple request/response; GraphQL would add a schema layer with no current consumer. |

---

## 7. Cost and blast-radius posture

- Everything is scoped to one project's stack; no shared mutable infrastructure.
- Cost-incurring resource creation above a configured threshold is an
  authorization gate ([`06-SECURITY-ARCHITECTURE.md`](06-SECURITY-ARCHITECTURE.md) §7).
- Neptune is the largest fixed cost; because it is a rebuildable projection, a
  small-project deployment may run without it and fall back to application-side
  traversal. This is a supported configuration, not a degraded one.

---

## 8. Open design questions

1. Sandbox runtime choice (§3.9) — requires measured cold start and isolation
   comparison (P8).
2. Bedrock AgentCore adoption (§3.11) — requires evaluation against the
   proposal-only mutation constraint (P8).
3. DynamoDB single-table key schema — must be designed against the concrete
   query list from P1, not guessed now (P8).
4. Whether Neptune is required at all for small projects, or only above a
   measured graph size (P8).
