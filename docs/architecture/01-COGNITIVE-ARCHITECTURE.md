# GENESIS — Cognitive Architecture

**Document ID:** `SPEC-01` · **Subordinate to:** [`00-MASTER-SPEC.md`](00-MASTER-SPEC.md)

Defines the Cognitive Core: the loop, the models it maintains, and the engines
that detect and close knowledge gaps.

---

## 1. Scope and boundary

The Cognitive Core is the only component permitted to write canonical project
state. Everything else — agents, tools, the reasoning provider — reads
task-scoped context and emits proposals.

```
   inputs                    CORE                         outputs
┌───────────┐        ┌──────────────────┐         ┌──────────────────┐
│ human     │        │  cycle executor  │         │ events (ledger)  │
│ tool      │───────▶│  ├ world model   │────────▶│ proposals→apply  │
│ runtime   │        │  ├ self model    │         │ questions to ask │
│ evidence  │        │  ├ goals         │         │ experiments      │
└───────────┘        │  ├ beliefs       │         │ actions          │
                     │  ├ uncertainty   │         └──────────────────┘
                     │  └ engines       │
                     └──────────────────┘
```

The core is **deterministic except where it explicitly calls the reasoning
provider**. Every non-deterministic call is recorded as an event with its
inputs, model identifier and output hash, so a cycle can be explained after the
fact even though it cannot be bit-for-bit replayed.

---

## 2. The cycle

A cycle is a durable record:

```
CYCLE
  id            cyc_01J...
  goalId        goal_...          | null
  trigger       OBSERVATION | HUMAN_INPUT | SCHEDULE | EVENT
  phase         <CognitiveLoopPhase>
  startedAt     ...
  endedAt       ...               | null
  outcome       COMPLETED | BLOCKED_ON_HUMAN | ABORTED_GOAL_DRIFT | FAILED
  events        [evt_...]
```

Phases execute in the order fixed by `CognitiveLoopPhase` in the master spec.
Each phase is a pure function of `(canonical state slice, cycle context)` to
`(events, next context)`. Phases never mutate state directly; they emit events
that the core applies.

### 2.1 Phase contracts

| Phase | Reads | Emits |
|---|---|---|
| `OBSERVE` | Observation inbox, filesystem/runtime probes | `OBSERVATION_RECORDED` |
| `UPDATE_WORLD_MODEL` | Observations | `WORLD_FACT_ADDED/CHANGED`, `CONTRADICTION_DETECTED` |
| `UPDATE_SELF_MODEL` | Tool registry, permissions, recent failures | `SELF_FACT_CHANGED`, `CAPABILITY_LOST/GAINED` |
| `RETRIEVE_MEMORY` | Memory stores via context assembly | nothing (read-only) |
| `CHECK_GOALS` | Goal tree | `GOAL_ACTIVATED`, `GOAL_DRIFT_DETECTED`, `GOAL_SATISFIED` |
| `DETECT_UNCERTAINTY` | Beliefs, goal success criteria, graph gaps | `UNCERTAINTY_OPENED` |
| `GENERATE_QUESTIONS` | Open uncertainties | `QUESTION_CREATED`, `QUESTION_SCORED` |
| `GATHER_INFORMATION` | Questions, resolution strategy | `QUESTION_ASKED`, `SEARCH_PERFORMED`, `EXPERIMENT_SCHEDULED`, `EVIDENCE_RECORDED` |
| `UPDATE_BELIEFS` | Evidence | `BELIEF_STATE_CHANGED`, `CONTRADICTION_DETECTED` |
| `PLAN` | Goals, beliefs, capabilities | `PLAN_CREATED`, `PLAN_REJECTED` |
| `ACT` | Plan, permissions | `ACTION_STARTED`, `PROPOSAL_SUBMITTED`, `ACTION_FAILED` |
| `VERIFY` | Artifacts, tests | `VERIFICATION_STATE_CHANGED`, `EVIDENCE_RECORDED` |
| `STORE_EXPERIENCE` | Cycle record | `EPISODE_STORED`, `PROCEDURE_LEARNED` |

### 2.2 Blocking

If `GATHER_INFORMATION` finds that the highest-value open question has
resolution `ASK_HUMAN` and is marked blocking for the active goal, the cycle
ends with outcome `BLOCKED_ON_HUMAN`. The system does not guess and proceed. It
records what it cannot determine, and why that matters, as a first-class state.

---

## 3. World model

The world model holds facts about everything **external to GENESIS**: the target
project, its runtime, its dependencies, its users' stated requirements, the
environment.

```
WORLD_FACT
  id, statement, subjectRef (nodeType+nodeId),
  authority   <Authority>,
  beliefId    bel_... | null,
  observedAt, observedBy, sourceRefs[], status
```

World facts are never overwritten. A superseding fact is appended and linked
with `SUPERSEDES`; contradictory facts are retained and linked with
`CONTRADICTS` (see §8).

The world model is a **projection** over Semantic Memory and the graph. It can
be rebuilt from the event ledger.

---

## 4. Self model

The self model holds facts about **GENESIS itself**, and exists so the system
can reason about what it is and is not able to do right now.

```
SELF_STATE
  capabilities    [{ id, description, status: AVAILABLE|DEGRADED|UNAVAILABLE, evidenceRef }]
  limitations     [{ id, description, source: DECLARED|OBSERVED, since }]
  tools           [{ id, name, permissions[], lastFailure? }]
  permissions     [{ scope, level, grantedBy, expiresAt? }]
  currentTask     taskId | null
  currentGoal     goalId | null
  assumptions     [beliefId]     // beliefs at ASSUMED, in play for the current task
  knownFailures   [{ id, signature, occurrences, lastSeen, mitigation? }]
  uncertainties   [uncertaintyId]
```

Two rules give this teeth:

1. **Capabilities are evidence-backed.** A capability is `AVAILABLE` only if a
   real invocation succeeded within the configured freshness window, or a human
   declared it. Otherwise it is `UNAVAILABLE`. The system does not assume it can
   do something because its config says so.
2. **The system must be able to say it does not know.** `"I cannot determine
   this from current information"` is representable as: an open uncertainty
   whose `resolution` is `ASK_HUMAN`, linked to a belief at `UNKNOWN`, blocking
   the active goal. Any surface that reports status must render this state
   rather than substituting a guess.

`knownFailures` is populated from real failed executions only, keyed by a
normalised failure signature so repeats are counted rather than duplicated.

---

## 5. Goal system

```
GOAL
  id, description, priority (0-100),
  status      PROPOSED|ACTIVE|BLOCKED|SATISFIED|ABANDONED,
  parentId    goal_... | null,
  successCriteria [{ id, statement, checkKind: TEST|EVIDENCE|HUMAN_CONFIRMATION, checkRef?, met: bool }]
  createdBy, createdAt, closedAt?
```

Goals form a tree. A parent goal cannot be `SATISFIED` while any child is
`ACTIVE` or `BLOCKED`.

### 5.1 Success criteria are checkable

A goal without at least one machine-checkable or human-confirmable success
criterion cannot be `ACTIVE`. This prevents goals that can never be closed and
forces the system to state what "done" means before working.

### 5.2 Goal drift detection

At `ACT`, every planned action carries a `contributesTo: goalId[]` justification.
Drift is detected when:

- an action's `contributesTo` is empty; or
- an action's `contributesTo` names only goals that are not `ACTIVE`; or
- a cycle's cumulative actions have not advanced any success criterion for
  `N` consecutive cycles (`N` configurable, default 3).

Drift emits `GOAL_DRIFT_DETECTED`, ends the cycle with
`ABORTED_GOAL_DRIFT`, and opens an issue. Drift is a signal, not a crash.

---

## 6. Belief system

```
BELIEF
  id, statement, state <BeliefState>, authority <Authority>,
  supportingEvidence [evidenceId], contradictingEvidence [evidenceId],
  confidence   number | null,     // metadata only, never a gate
  subjectRefs  [{nodeType,nodeId}], createdAt, lastTransitionAt, history[]
```

### 6.1 Legal transitions

```
UNKNOWN ──▶ ASSUMED ──▶ SUPPORTED ──▶ TESTED ──▶ VERIFIED
   ▲           │            │            │           │
   └───────────┴────────────┴────────────┴───────────┘
              (any state may return to UNKNOWN or drop on
               contradicting evidence; downgrades are events)
```

Entry requirements — enforced, not advisory:

| Target state | Requires |
|---|---|
| `ASSUMED` | A stated rationale. No evidence needed. Authority is `AI_ASSUMPTION` unless supplied otherwise. |
| `SUPPORTED` | ≥1 evidence record that does not come from the same reasoning call that created the belief. |
| `TESTED` | ≥1 evidence record produced by an executed test or experiment that could have falsified the belief. |
| `VERIFIED` | `TESTED` **and** the evidence came from the real target environment, **and** no open contradicting evidence. |

A confidence number never substitutes for any of these. A belief at
`confidence: 0.99, state: ASSUMED` is an assumption, and the planner treats it
as one.

---

## 7. Uncertainty engine

Unknowns are first-class records, not the absence of records.

```
UNCERTAINTY
  id, projectId,
  statement,
  impact        WHAT_BREAKS_IF_WRONG (text) + affectedRefs[{nodeType,nodeId}]
  risk          LOW|MEDIUM|HIGH|CRITICAL
  blocking      bool                     // blocks the active goal
  resolution    <UncertaintyResolution>
  status        OPEN|IN_PROGRESS|RESOLVED|ACCEPTED|OBSOLETE
  relatedBeliefs [beliefId], relatedQuestions [questionId]
  openedAt, resolvedAt?, resolutionEvidence [evidenceId]
```

Each uncertainty is also an `UNCERTAINTY` node in the knowledge graph
([`03-GRAPH-ARCHITECTURE.md`](03-GRAPH-ARCHITECTURE.md) §2), so it is reachable
by traversal and can be a legal `BLOCKS` endpoint. Without that, uncertainties
would be invisible to impact analysis — the engine whose whole job is finding
gaps could not see the gaps already recorded. A blocking, open uncertainty with
no outbound `BLOCKS` edge is itself flagged by invariant G13.

### 7.1 Detection sources

1. **Belief gaps** — a belief at `UNKNOWN` or `ASSUMED` that a plan depends on.
2. **Requirement gaps** — a requirement whose graph neighbourhood lacks an
   `IMPLEMENTS` or `VERIFIES` edge.
3. **Success-criterion gaps** — an active goal criterion with no `checkRef`.
4. **Contradiction** — the contradiction engine opens an uncertainty when
   authority cannot decide between two claims.
5. **Self-model gaps** — a required capability with `UNAVAILABLE` status.

### 7.2 Strategy selection

| Condition | Strategy |
|---|---|
| The answer is a human preference, policy, or business rule | `ASK_HUMAN` |
| The answer exists in project artifacts, docs, or external sources | `SEARCH` |
| The answer is an empirical property of the system under test | `EXPERIMENT` |

Where more than one applies, prefer the cheapest strategy that can actually
settle the question: `SEARCH` → `EXPERIMENT` → `ASK_HUMAN`. Human attention is
the scarcest resource, so `ASK_HUMAN` is chosen when the other two *cannot*
settle it, not merely when they are inconvenient.

`ACCEPTED` status exists for uncertainties a human has explicitly decided to
live with; it records the acceptance rather than pretending the gap closed.

---

## 8. Contradiction engine

Contradictions are detected between:

| Pair | Detection |
|---|---|
| requirement ↔ implementation | Requirement has `IMPLEMENTS` edges whose artifact behaviour contradicts the requirement statement per evidence |
| requirement ↔ test | Test asserts behaviour that negates a requirement |
| decision ↔ implementation | Artifact violates a recorded decision's constraint |
| documentation ↔ implementation | Doc claim and code evidence disagree |
| belief ↔ evidence | Evidence contradicts a belief at `SUPPORTED`+ |
| goal ↔ action | Action contributes to no active goal (drift, §5.2) |

### 8.1 Procedure

On detection, the engine **always**:

1. **Preserves both sources.** Nothing is overwritten or deleted.
2. **Links them** with a `CONTRADICTS` edge, which is symmetric.
3. **Determines authority** using the `Authority` ordering. If one side is
   strictly higher, it governs; the lower side is marked
   `status: SUPERSEDED_BY_AUTHORITY` but remains readable with its history.
4. **Opens an issue** with the affected node set computed from graph traversal.
5. **Opens an uncertainty** if authority is equal or indeterminate — the system
   does not break ties by guessing.
6. **Blocks unsafe changes**: any proposal whose impact set intersects the
   affected node set is rejected at `POLICY_CHECK` until the issue is resolved,
   unless a human explicitly overrides with a recorded `HUMAN_DECISION` event.

Silent overwrite of a conflicting claim is a defect, not an optimisation.

---

## 9. Question engine

### 9.1 Purpose

Generate questions that would materially change what the system does next — not
questions that are merely answerable.

A useful question: *"Can administrators override attendance after a session is
closed?"* — it changes the data model and the authorization rules.
A useless question: *"What should the button colour be?"* when no active goal
touches presentation.

### 9.2 Scoring

Question value is a heuristic:

```
value = informationGain × decisionImpact × riskReduction × dependencyCoverage
```

| Factor | Meaning | Range |
|---|---|---|
| `informationGain` | Expected reduction in the uncertainty's entropy; approximated by how many belief states could transition | 0–1 |
| `decisionImpact` | Whether the answer changes a pending decision or plan branch | 0–1 |
| `riskReduction` | Risk level of the uncertainty, normalised | 0–1 |
| `dependencyCoverage` | Fraction of the active goal's blocked dependency set the answer unblocks | 0–1 |

**This is explicitly a heuristic, and it is wrong in ways we cannot yet
enumerate.** It is therefore implemented behind a `QuestionScorer` interface
with the formula in a single replaceable module, plus:

- a recorded score breakdown per question, so scores are explainable;
- an outcome record per asked question (`did the answer change anything?`), so
  the scorer can be evaluated against reality later;
- a deterministic default scorer so tests are stable.

### 9.3 Question record

```
QUESTION
  id, text, uncertaintyId, audience HUMAN|SELF|EXTERNAL,
  score { value, informationGain, decisionImpact, riskReduction, dependencyCoverage },
  status DRAFT|ASKED|ANSWERED|WITHDRAWN|UNANSWERABLE,
  answer { text, authority, answeredBy, answeredAt } | null,
  outcome { changedPlan: bool, beliefsTransitioned: [beliefId] } | null
```

### 9.4 Batching

Questions to humans are batched per cycle, deduplicated against previously
answered questions, and ordered by score. The system does not ask a question it
already has a `HUMAN_DECISION`-authority answer for.

---

## 10. Experiment engine

An experiment is run when an uncertainty is empirically decidable.

```
EXPERIMENT
  id, uncertaintyId, hypothesis, nullHypothesis,
  method      { kind: LOAD|CONCURRENCY|PROPERTY|INTEGRATION|PROBE, spec }
  environment SANDBOX|STAGING                 // never PRODUCTION without HUMAN_DECISION
  predictedObservation, falsifiableBy,
  status      DESIGNED|APPROVED|RUNNING|OBSERVED|CONCLUDED|ABANDONED,
  observations [evidenceId],
  conclusion  { supportsHypothesis: bool, beliefTransitions: [...], issuesOpened: [...] } | null
```

Worked example:

- **Hypothesis:** 100 simultaneous booking requests for the same slot can create
  duplicate reservations.
- **Null hypothesis:** exactly one reservation is created.
- **Method:** `CONCURRENCY` — 100 parallel requests against the sandbox
  deployment, seeded with a single available slot.
- **Falsifiable by:** observing exactly one reservation row.
- **Observation:** real captured output — row count, response codes, timings —
  stored as an evidence record with the raw artifact.
- **Conclusion:** if duplicates appear, belief *"booking is safe under
  concurrency"* transitions toward `UNKNOWN`/contradicted, an `ISSUE` node is
  created with `CAUSES` edges to the implicated component, and a repair task is
  proposed.

Hard constraints:

- Experiments run in the sandbox described in
  [`06-SECURITY-ARCHITECTURE.md`](06-SECURITY-ARCHITECTURE.md).
- An experiment that did not execute produces **no** observation. There is no
  simulated result path.
- `CONCLUDED` requires ≥1 real evidence record.

---

## 11. Context assembly

The core never sends the whole project state to a model. For each task it builds
a bounded context.

### 11.1 Inputs

`currentTask`, relevant requirements, relevant graph neighbourhood, relevant
decisions, evidence, relevant memories, current files, open uncertainties, known
failures, applicable policies.

### 11.2 Retrieval scoring

Candidates are scored on six signals and selected under a token budget:

| Signal | Weight (default) | Notes |
|---|---|---|
| Relevance | 0.30 | Lexical + embedding similarity to the task |
| Authority | 0.25 | Higher `Authority` ranks higher |
| Goal relevance | 0.15 | Distance in the goal tree from the active goal |
| Dependency | 0.15 | Graph distance along `DEPENDS_ON`/`IMPLEMENTS`/`AFFECTS` |
| Evidence strength | 0.10 | Belief state and evidence count |
| Recency | 0.05 | Decays with age; deliberately the weakest signal |

Weights live in configuration and are recorded in the event for each assembly,
so a later cycle can explain why a given fact was or was not in context.

### 11.3 Mandatory inclusions

Regardless of score, context always includes: policies applicable to the task,
open **blocking** uncertainties for the active goal, contradictions touching the
task's impact set, and known failures whose signature matches the task kind.
These cannot be crowded out by the budget; if the budget cannot fit them, the
task is split.

---

## 12. Open design questions

Tracked here rather than silently decided. Each becomes an ADR when settled.

1. Embedding model and store for the lexical/semantic half of retrieval (P3).
2. Exact normalisation of failure signatures in `knownFailures` (P2).
3. Whether `informationGain` can be estimated better than the belief-transition
   proxy (P3, requires the outcome data from §9.2).
4. Cycle concurrency: currently one cycle at a time per project; multi-cycle
   needs a locking model (P6).
