# GENESIS — Master Specification

**Status:** Authoritative · **Phase:** Pre-build architecture · **Version:** 0.1.0
**Document ID:** `SPEC-00`

This document is the single source of truth for GENESIS terminology, canonical
enumerations, scope and phasing. Every other document in `docs/` is subordinate
to it. Where another document disagrees with this one, this one wins and the
other document is a defect.

---

## 1. What GENESIS is

GENESIS is an experimental **self-questioning software intelligence**: an
engineering system that maintains persistent, structured knowledge about a
software project and uses that knowledge to build, test, repair, verify, deploy
and maintain software over time.

Its distinguishing property is not that it writes code. It is that it maintains
a **canonical, authority-ranked model of what is actually known about a
project**, detects where that model is incomplete or contradictory, and acts to
close those gaps — by asking, searching, or experimenting — before it acts on
assumptions.

### 1.1 Honesty constraints (non-negotiable)

GENESIS does **not** claim, and this codebase must never assert, that the system
is conscious, sentient, self-aware in a phenomenal sense, an AGI, or
superintelligent. The words "self-model", "belief", "question" and "experiment"
in this repository are **technical terms for data structures and processes**
defined in this specification. They carry no claim about inner experience.

Three rules follow, and they are enforced in code review and by the
documentation checker:

1. **No fake functionality.** A module that cannot do the thing its name implies
   must not exist, must throw `NotImplementedError`, or must be explicitly
   marked as a stub in both code and docs.
2. **No fabricated evidence.** Test results, verification outcomes and
   experiment observations must originate from real execution. Synthesising a
   plausible-looking result is the most serious defect class in this project.
3. **Generation is not verification.** Producing an artifact advances it to
   `GENERATED` and no further. See `05-VERIFICATION-ARCHITECTURE.md`.

### 1.2 Non-goals

- GENESIS is not a chat assistant with a large prompt and a vector database.
- GENESIS is not an autonomous agent with unrestricted production access.
- GENESIS does not attempt open-ended self-improvement of its own core.
- GENESIS does not require an LLM to hold state; the LLM is a replaceable
  reasoning component, not the system of record.

---

## 2. Architectural principle

> The Cognitive Core owns persistent project state and structured truth.
> The LLM is a reasoning component invoked by the core, never the other way
> around.

The rejected architecture is `LLM + giant prompt + vector database`, because it
has no durable notion of authority, no way to represent "unknown", no mechanism
to preserve contradiction, and no auditable history.

The adopted architecture is:

```
                    ┌──────────────────────────────┐
                    │        COGNITIVE CORE        │
                    │  (owns the canonical state)  │
                    └──────────────┬───────────────┘
                                   │
   ┌───────────────┬───────────────┼───────────────┬───────────────┐
   │               │               │               │               │
┌──┴───┐      ┌────┴────┐    ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
│MEMORY│      │ PROJECT │    │ KNOWLEDGE │   │   EVENT   │   │ CANONICAL │
│      │      │  TREE   │    │   GRAPH   │   │  LEDGER   │   │   STATE   │
└──────┘      └─────────┘    └───────────┘   └───────────┘   └───────────┘

   ┌───────────┬───────────┬───────────┬────────────┬────────────┐
   │   WORLD   │   SELF    │   GOAL    │   BELIEF   │UNCERTAINTY │
   │   MODEL   │   MODEL   │  SYSTEM   │   SYSTEM   │   ENGINE   │
   └───────────┴───────────┴───────────┴────────────┴────────────┘

   ┌───────────┬────────────┬──────────────┬───────────────┐
   │ QUESTION  │ EXPERIMENT │ VERIFICATION │ CONTRADICTION │
   │  ENGINE   │   ENGINE   │    ENGINE    │    ENGINE     │
   └───────────┴────────────┴──────────────┴───────────────┘

   ┌──────────────────────────────────────────────────────┐
   │  REASONING PROVIDER (port) → Bedrock / API / Mock     │
   └──────────────────────────────────────────────────────┘
```

Every box below the core is reachable only through a typed port. No component
reaches into another component's storage.

---

## 3. The core cognitive loop

One iteration of the loop is a **cycle**. A cycle is durable: it has an id, it
emits events, and it can be reconstructed from the event ledger.

```canonical:CognitiveLoopPhase
OBSERVE
UPDATE_WORLD_MODEL
UPDATE_SELF_MODEL
RETRIEVE_MEMORY
CHECK_GOALS
DETECT_UNCERTAINTY
GENERATE_QUESTIONS
GATHER_INFORMATION
UPDATE_BELIEFS
PLAN
ACT
VERIFY
STORE_EXPERIENCE
```

`GATHER_INFORMATION` is the ASK / SEARCH / EXPERIMENT phase; the three
resolution strategies are enumerated in `UncertaintyResolution` below. After
`STORE_EXPERIENCE` the loop returns to `OBSERVE`.

A cycle may terminate early at `CHECK_GOALS` (no active goal), or block at
`GATHER_INFORMATION` when the only available resolution is `ASK_HUMAN` and no
answer has been supplied. Blocking is a legitimate, recorded outcome — it is the
system correctly representing "I cannot determine this from current
information."

Detailed semantics: `01-COGNITIVE-ARCHITECTURE.md`.

---

## 4. Canonical enumerations

These blocks are the **only** authoritative definitions of these enumerations.
Any other document or source file that reproduces one of these lists must
reproduce it exactly; `tools/docs-check.mjs` enforces this mechanically.

### 4.1 Memory classes

```canonical:MemoryClass
WORKING
SEMANTIC
EPISODIC
DECISION
PROCEDURAL
EVIDENCE
ARCHIVED
```

Defined in `02-MEMORY-ARCHITECTURE.md`.

### 4.2 Authority levels

Ordered from highest authority (1) to lowest (7). Authority, not confidence,
decides which of two conflicting claims governs.

```canonical:Authority
HUMAN_DECISION
VERIFIED_SYSTEM_STATE
ACTIVE_REQUIREMENT
EVIDENCE
HISTORICAL
AI_ASSUMPTION
UNGROUNDED
```

An AI-produced claim enters the store at `AI_ASSUMPTION` and can only be
promoted by an event that supplies a higher-authority source. It never promotes
itself.

`UNGROUNDED` is the floor: nothing at all supports the claim. It sits below
`AI_ASSUMPTION` because an AI assumption *is* grounded — in a model's reasoning,
which is a real if weak provenance ([ADR-0012](../adr/0012-ungrounded-authority-level.md)).

### 4.3 Belief states

```canonical:BeliefState
UNKNOWN
ASSUMED
SUPPORTED
TESTED
VERIFIED
```

A numeric confidence score may accompany a belief as metadata. It is never a
substitute for a state transition, and no belief reaches `VERIFIED` without a
linked evidence record produced by real execution.

### 4.4 Verification states

```canonical:VerificationState
GENERATED
STATIC_CHECKED
UNIT_TESTED
INTEGRATION_TESTED
E2E_TESTED
DEPLOYED
PRODUCTION_VERIFIED
```

Verification state is tracked per **artifact version**; a new version restarts at
`GENERATED`. Within a version, state advances monotonically *while the evidence
supporting it stands*. If later evidence contradicts a state — a test that
passed now fails — the artifact **downgrades** to the highest state still
supported, and the downgrade is an event. Reality outranks bookkeeping. See
[`05-VERIFICATION-ARCHITECTURE.md`](05-VERIFICATION-ARCHITECTURE.md) §2.2.

### 4.5 Change lifecycle

```canonical:ChangeLifecycle
PROPOSE
IMPACT_ANALYSIS
POLICY_CHECK
APPLY
TEST
VERIFY
COMMIT_STATE
```

### 4.6 Uncertainty resolution strategies

```canonical:UncertaintyResolution
ASK_HUMAN
SEARCH
EXPERIMENT
```

### 4.7 Graph node types

```canonical:NodeType
PROJECT
GOAL
REQUIREMENT
DECISION
FEATURE
COMPONENT
FILE
FUNCTION
API
DATABASE
TEST
ISSUE
CHANGE
EVIDENCE
BELIEF
UNCERTAINTY
QUESTION
EXPERIMENT
DEPLOYMENT
EVENT
```

`UNCERTAINTY` was added after the Phase-0 audit (open decision **E2**). Without
it, uncertainties were part of canonical state but invisible to graph traversal,
so impact analysis could not see the gaps the system exists to find, and
`BLOCKS` had no legal endpoint for them.

### 4.8 Graph edge types

```canonical:EdgeType
CONTAINS
DEPENDS_ON
IMPLEMENTS
VERIFIES
SUPPORTS
CONTRADICTS
AFFECTS
CAUSES
FIXES
CALLS
READS
WRITES
CREATED_BY
MODIFIED_BY
SUPERSEDES
DERIVED_FROM
REQUIRES
BLOCKS
ACHIEVES
```

Semantics and legal endpoint pairs: `03-GRAPH-ARCHITECTURE.md`.

---

## 5. Canonical project state

There is exactly one canonical project state **per project**. GENESIS manages
several projects concurrently, and every record, event, node, edge and
projection is scoped by a mandatory, immutable `projectId`
([ADR-0008](../adr/0008-project-scoping.md)). "The canonical state" always means
the state of one named project; there is no global state above it beyond the
project registry itself.

Agents do not maintain private copies of project truth; they hold task-scoped
context assembled from one project's state and they propose changes back to it.

The state comprises these slices:

| Slice | Owner component | Storage shape |
|---|---|---|
| `project` | Core | Record |
| `worldState` | World Model | Projection |
| `selfState` | Self Model | Projection |
| `goals` | Goal System | Tree |
| `requirements` | Project Tree | Tree + graph nodes |
| `decisions` | Decision Memory | Append-only records |
| `entities` | Knowledge Graph | Nodes |
| `relationships` | Knowledge Graph | Edges |
| `artifacts` | Project Tree | Records + files |
| `dependencies` | Knowledge Graph | `DEPENDS_ON` edges |
| `tests` | Verification Engine | Records |
| `issues` | Contradiction / QA | Records |
| `beliefs` | Belief System | Records |
| `uncertainties` | Uncertainty Engine | Records |
| `questions` | Question Engine | Records |
| `experiments` | Experiment Engine | Records |
| `evidence` | Evidence Memory | Immutable records |
| `events` | Event Ledger | Immutable append-only log |
| `versions` | Core | Monotonic counters |
| `deployment` | Deployment | Records |
| `permissions` | Security | Policy records |

**Rule:** the event ledger is the write-ahead truth. Every other slice is either
an immutable record set or a projection that can be rebuilt by replaying events.
If a projection and the ledger disagree, the projection is rebuilt.

**Scoping rule:** every row in every slice carries `projectId`. Every read is
project-scoped at the type level, so an unscoped query is not expressible rather
than merely discouraged. Cross-project references are illegal and rejected on
write. The one exception is the project registry, which lists projects and is
scoped by account, not by project.

---

## 6. Project tree

A hierarchical view over graph nodes, not a separate store:

```
PROJECT
├── Product
│   ├── Requirements
│   ├── Decisions
│   └── Goals
├── Frontend
├── Backend
├── Database
├── Tests
├── Security
└── Deployment
```

Tree membership is expressed with `CONTAINS` edges. A node may appear in exactly
one tree position (single parent) while participating in arbitrary non-tree
relationships.

---

## 7. Event ledger

Every meaningful state change appends an immutable event. Events are the basis
of history, audit, explanation and reconstruction.

```
EVENT
  id            evt_01J...            ULID, monotonic
  projectId     prj_01J...            mandatory; the partition this event belongs to
  seq           integer               per-project, gapless, assigned on append
  schemaVersion 1                     for upcasting on read
  type          REQUIREMENT_CHANGED
  actor         { kind: HUMAN | AGENT | SYSTEM, id, agentRole? }
  subject       { nodeType, nodeId }
  before        "24 hours"
  after         "12 hours"
  cause         evt_01J... | null     causing event, if any
  cycleId       cyc_01J... | null
  authority     HUMAN_DECISION
  timestamp     2026-09-18T06:20:00Z
  payloadHash   sha256:...            hash of this event's content
  prevHash      sha256:... | null     hash of the previous event in this project
```

Events are never updated or deleted. A mistaken event is corrected by appending
a compensating event that `SUPERSEDES` it.

`seq`, `payloadHash` and `prevHash` together form a per-project **hash chain**:
each event commits to its predecessor, so any retroactive edit or deletion
breaks verification at that point and every point after it. Integrity becomes a
property that can be checked rather than a policy that is trusted. See
[ADR-0009](../adr/0009-ledger-hash-chain.md).

---

## 8. Phasing

Implementation proceeds in phases. A phase is complete only when its exit
criteria are met by executed tests, not by inspection.

| Phase | Name | Contents | Exit criteria |
|---|---|---|---|
| **P0** | Pre-build architecture | This document set, ADRs, audit | Docs checker green; audit accepted by human |
| **P1** | Core state substrate | Types, storage ports, SQLite adapter, event ledger, graph store, memory store | Ledger replay reconstructs state; hash chain verifies; project isolation holds; coverage policy §8.1 met |
| **P2** | Cognitive primitives | World/self model, goals, beliefs, uncertainty, contradiction engine | Property tests on authority resolution and contradiction preservation |
| **P3** | Inquiry | Question engine, scoring module, context assembly | Question scoring is deterministic and unit-tested; scorer is swappable |
| **P4** | Reasoning provider | `ReasoningProvider` port, mock adapter, Bedrock adapter | Core test suite passes with mock adapter only |
| **P5** | Experiments & verification | Experiment engine, sandbox runner, verification state machine | Experiments produce real observations; no state advances without evidence |
| **P6** | Agents | Planner, Architect, Builder, QA, Verifier, Repair (proposal-based) | Agents cannot mutate state except through accepted proposals |
| **P7** | Software factory | Intent → requirements → build → test → repair → verify | End-to-end build of a reference project, self-repaired from a real failure |
| **P8** | AWS deployment | Adapters for DynamoDB/Neptune/S3, Step Functions orchestration, Cognito | Same core test suite passes against cloud adapters |

Nothing in P7 is implemented before P1–P5 are green. This is a hard rule.

### 8.1 Coverage policy

An earlier draft required "≥90% line coverage on core". That number was
arbitrary, and line coverage is the wrong instrument: it rewards executing code,
not exercising its decisions. A module full of guard clauses can reach 90% lines
with every guard untested.

The policy is therefore two-tier:

| Tier | Requirement |
|---|---|
| **Safety-critical modules** | **100% branch coverage**, enforced per file. Every decision point must be exercised in both directions. |
| Everything else | 80% line coverage as a floor, repo-wide — a smoke alarm, not a target |

A module is **safety-critical** when a silent failure in it would let the system
believe something untrue, or let an untrusted component write truth. The list is
explicit, lives in the coverage configuration, and grows as those components are
built:

1. Authority assignment and clamping — the rule that model output cannot promote
   itself (ADR-0005)
2. The evidence writer — hash verification and the no-model-authored rule
   (SPEC-05 §4)
3. Ledger append path — append-only enforcement, sequence assignment, hash chain
   (ADR-0004, ADR-0009)
4. Event schema upcasting — a wrong upcast silently rewrites history
5. Project scope enforcement — every boundary where a `projectId` is checked
   (ADR-0008)
6. Graph invariant enforcement — G1–G13 (SPEC-03 §4)
7. Verification state transitions and their entry requirements (SPEC-05 §2)
8. Policy check and authorization gates (SPEC-06 §7)

Adding a file to this list is a one-line config change. Removing one requires an
ADR, because it is a deliberate reduction in what the project guarantees.

---

## 9. Technology decisions (summary)

Full rationale lives in `docs/adr/`. Summary:

| Decision | Choice | ADR |
|---|---|---|
| Language | TypeScript, `strict: true`, no implicit `any` | [ADR-0002](../adr/0002-typescript-strict.md) |
| Repo layout | pnpm workspace monorepo | [ADR-0001](../adr/0001-monorepo-layout.md) |
| Persistence | Ports + adapters; SQLite first, DynamoDB/Neptune later | [ADR-0003](../adr/0003-ports-and-adapters-persistence.md) |
| History | Event-sourced ledger with rebuildable projections | [ADR-0004](../adr/0004-event-sourced-ledger.md) |
| Conflict resolution | Authority hierarchy, not confidence scores | [ADR-0005](../adr/0005-authority-over-confidence.md) |
| State mutation | Agents propose; core applies | [ADR-0006](../adr/0006-proposal-based-mutation.md) |
| LLM integration | `ReasoningProvider` port; Bedrock first adapter | [ADR-0007](../adr/0007-reasoning-provider-port.md) |
| Multi-project | Mandatory immutable `projectId` on all state; scope-typed reads | [ADR-0008](../adr/0008-project-scoping.md) |
| Ledger integrity | Per-project hash chain over sequenced events | [ADR-0009](../adr/0009-ledger-hash-chain.md) |
| SQLite driver | Built-in `node:sqlite`, no native build step | [ADR-0010](../adr/0010-node-sqlite-driver.md) |
| Write-time authority | Clamp to the ceiling, and persist what was clamped | [ADR-0011](../adr/0011-write-time-authority-policy.md) |
| Authority floor | `UNGROUNDED` below `AI_ASSUMPTION`; grounding is a ladder | [ADR-0012](../adr/0012-ungrounded-authority-level.md) |

---

## 10. Document map

| Document | Scope |
|---|---|
| `00-MASTER-SPEC.md` | This document. Terminology, enums, scope, phasing |
| [`01-COGNITIVE-ARCHITECTURE.md`](01-COGNITIVE-ARCHITECTURE.md) | Loop, world/self model, goals, beliefs, uncertainty, questions, experiments, contradiction, context assembly |
| [`02-MEMORY-ARCHITECTURE.md`](02-MEMORY-ARCHITECTURE.md) | Memory classes, record schema, authority, lifecycle |
| [`03-GRAPH-ARCHITECTURE.md`](03-GRAPH-ARCHITECTURE.md) | Node and edge semantics, invariants, queries |
| [`04-AGENT-ARCHITECTURE.md`](04-AGENT-ARCHITECTURE.md) | Agent roster, typed messages, proposal protocol |
| [`05-VERIFICATION-ARCHITECTURE.md`](05-VERIFICATION-ARCHITECTURE.md) | Verification states, change lifecycle, evidence |
| [`06-SECURITY-ARCHITECTURE.md`](06-SECURITY-ARCHITECTURE.md) | Least privilege, sandboxing, secrets, authorization |
| [`07-AWS-ARCHITECTURE.md`](07-AWS-ARCHITECTURE.md) | Service responsibilities, adapter mapping |
| [`../audit/PRE-BUILD-ARCHITECTURE-AUDIT.md`](../audit/PRE-BUILD-ARCHITECTURE-AUDIT.md) | Phase-0 audit output |

---

## 11. Glossary

- **Artifact** — any produced thing tracked by the system: a file, a schema, a
  deployment, a document.
- **Belief** — a proposition the system holds about the project or the world,
  with a `BeliefState` and supporting evidence links.
- **Claim** — any statement in memory, regardless of authority.
- **Cycle** — one durable iteration of the cognitive loop.
- **Evidence** — an immutable record of something that actually happened
  (a test run, a command's output, a human statement), with provenance.
- **Proposal** — a requested state change emitted by an agent; not yet applied.
- **Projection** — a derived read model rebuildable from the event ledger.
- **Uncertainty** — an explicitly represented gap in knowledge with impact,
  risk and a resolution strategy.
