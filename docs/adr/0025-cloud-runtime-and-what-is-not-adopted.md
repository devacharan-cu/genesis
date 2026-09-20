# ADR-0025 — The cloud runtime, and three services not adopted

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Implements:** P8 — SPEC-00 §8; SPEC-07 §3, §7
- **Builds on:** [ADR-0016](0016-orchestrator-owns-graph-mirroring.md), [ADR-0019](0019-experiment-engine-and-verification.md), [ADR-0020](0020-agent-protocol-and-runtime.md), [ADR-0021](0021-impact-leases-and-serialised-factory-work.md), [ADR-0024](0024-dynamodb-single-table-and-cloud-persistence.md)
- **Settles:** SPEC-07 §8 questions 1, 2 and 4

## Context

SPEC-07 §1 sets the rule of admission: *every AWS service must have a clear,
singular responsibility that the architecture actually needs. A service that
exists to look impressive is a defect.* It then leaves three questions open for
P8 precisely so they would be answered against the built system rather than
guessed: the sandbox runtime, whether Bedrock AgentCore is adopted, and whether
Neptune is required at all.

The built system now answers them. P5 gave the sandbox a port with a real local
adapter. P6 gave agents a runtime whose central constraint is that an agent
holds no store, no ledger and no model. P7 gave the factory a pipeline that is
serialised per project and whose graph reads are bounded impact sets.

The temptation at this point is to adopt every service in the diagram because
the diagram has them. Three of them do not earn their place yet, and saying so
is the decision.

## Decision

### 1. Neptune is not built. The graph stays a projection served from DynamoDB.

The graph has always been derived state, rebuildable from the ledger
([ADR-0016](0016-orchestrator-owns-graph-mirroring.md)). SPEC-07 §3.3 says as
much, and §7 already admits a deployment without Neptune as *a supported
configuration, not a degraded one.*

The DynamoDB adapter serves every `GraphStore` method, including
`neighbourhood`, `impactSet`, `paths` and `findOrphans`, by bounded
application-side traversal over the two edge indexes
([ADR-0024](0024-dynamodb-single-table-and-cloud-persistence.md) §1). It passes
the identical `GraphStore` conformance suite the SQLite and in-memory adapters
pass, so the traversals are the same traversals.

This is affordable because the traversals are already bounded by the graph's
own invariants: `MAX_TRAVERSAL_DEPTH` is 6, `MAX_IMPACT_DEPTH` is 6, and every
call carries a mandatory limit (SPEC-03 G12). A bounded-depth walk over indexed
edges is a small number of queries, not a graph scan.

**What would change this:** a measured traversal at a real project's graph size
that exceeds the latency budget, or a project graph that outgrows one DynamoDB
partition. Neptune is a cluster with a fixed hourly cost and a VPC; adopting it
before either is measured would be paying for a shape of query the system does
not yet make.

### 2. Bedrock AgentCore is not adopted.

SPEC-07 §3.11 made adoption conditional on AgentCore being constrainable to the
proposal-only mutation model. Evaluated against what P6 actually built, it is
not the right fit, for a reason that is structural rather than a matter of
features.

GENESIS's agents are deliberately inert. An agent frames work, receives a
summary of what the core did, and returns messages; it holds no provider, no
tools and no state, and `packages/agents` cannot import anything that writes
([ADR-0020](0020-agent-protocol-and-runtime.md) §1). AgentCore's value is in
hosting the part GENESIS has deliberately removed — the tool-invocation loop and
the agent's own session state. Adopting it would mean either leaving that value
unused, or moving the loop back into the agent and losing the property the
package graph currently enforces.

Agents therefore run as ordinary workers behind the existing message port:
Lambda for short tasks, the sandbox tier for anything that executes code. The
reasoning call continues to go through the `ReasoningProvider` port to Bedrock,
which is the part of Bedrock the architecture does need.

**What would change this:** AgentCore offering hosted durable execution that can
be constrained to "propose only", with the tool loop disabled — at which point
it competes with Step Functions for the orchestration job, and the comparison
is about durable execution rather than about agents.

### 3. The sandbox tier is ECS Fargate.

SPEC-07 §3.9 requires hard isolation, no ambient credentials, controlled egress
and captured output, and rules out Lambda on duration, image control and egress
control. Three candidates were weighed against what the sandbox actually runs —
a test suite for a change, bounded by the experiment's own timeout.

| Candidate | Why not, or why |
|---|---|
| **CodeBuild** | Built for builds, and gives a managed cache and buildspec. But its unit of work is a project with a source location, its start latency is the worst of the three, and shaping it into a per-experiment runner means fighting a build tool into being a sandbox. |
| **Firecracker (via EC2)** | The strongest isolation, and the most operational surface: an AMI, an autoscaling group, a pool manager and a scheduler, all of which GENESIS would own and none of which is its problem. |
| **ECS Fargate** | Adopted. A task is a container with a task role, a network mode and a timeout, which is exactly the unit the sandbox port already has. No instances to own, per-task IAM, and `awsvpc` networking makes egress a subnet and security-group decision rather than an application one. |

The task role is scoped to writing evidence under one S3 prefix and nothing
else. Egress is deny-by-default at the security group. The image is pinned by
digest, not by tag, so what ran is what was reviewed.

**The honest limit:** a Fargate task boundary is a container boundary on shared
infrastructure. It is not a hypervisor boundary. For code GENESIS generated and
is about to test, against a task with no credentials and no egress, that is the
right trade. For running untrusted third-party code it would not be, and SPEC-06
should be revisited before that ever becomes the use.

### 4. What runs where

| Component | Runtime | Why there |
|---|---|---|
| API handlers | Lambda behind API Gateway | Request/response, bursty, short |
| Projection updater | Lambda on a DynamoDB stream | Ordered at-least-once change feed; projections must not be written by the writer |
| Ledger fan-out | Lambda on the stream → EventBridge | Keeps the core ignorant of its consumers (SPEC-07 §3.8) |
| Factory run | Step Functions | Long, multi-step, must be auditable, and has a human-approval wait |
| Agent task | Lambda, invoked by the state machine | Short and stateless; the reasoning call is the long part and it has its own timeout |
| Experiment / test run | ECS Fargate task | §3 |

The Step Functions definitions are **generated from the canonical enumerations**
— `CognitiveLoopPhase`, `ChangeLifecycle` and `FactoryStage` — so SPEC-07 §3.7's
"the state machine mirrors them exactly" is a property a test asserts rather
than a claim someone maintains by hand.

### 5. Serialisation survives the move to the cloud

[ADR-0021](0021-impact-leases-and-serialised-factory-work.md) serialises factory
work per project, and that decision was made about correctness, not about
process boundaries. In the cloud the queue is no longer an in-process promise
chain, so the guarantee is re-established where it can be: the factory state
machine is started with the project id as the execution name, and Step Functions
refuses a duplicate execution name. One project therefore has at most one
factory execution in flight, for the same reason and with the same consequence.

## Consequences

**Positive**

- Three services are not deployed, three fixed costs are not incurred, and the
  reasons are written down where the next person can disagree with them.
- The graph adapter passes the same conformance suite as every other, so
  "Neptune later" is a swap rather than a rewrite.
- Every long-running thing is on a runtime built for long-running things, and
  every short one is on Lambda.

**Negative**

- Bounded application-side traversal costs more read units than a graph engine
  would, and the crossover point is unmeasured because there is no production
  graph to measure.
- One factory execution per project is a real throughput ceiling, now enforced
  by a service rather than by a data structure the code can inspect.
- Fargate's isolation is a container boundary, and §3 says so rather than
  implying more.

**Mitigations**

- The traversal cost is bounded by the graph's existing depth and limit caps, so
  the worst case is a known number of queries rather than an open one.
- The duplicate-execution refusal is surfaced as a typed conflict, so a caller
  learns that a run is already in flight instead of silently getting a second.
