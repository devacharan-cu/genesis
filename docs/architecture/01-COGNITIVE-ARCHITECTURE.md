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

### 2.3 The orchestrated run (P4)

> **Implemented (P4)** in `packages/core`
> ([ADR-0018](../adr/0018-reasoning-and-orchestration.md)): not the full cycle
> above, but its reasoning spine — one **run** of one task, under a `cycleId`
> stamped on every event it causes: `TASK_STARTED` → context gathered and
> assembled against the cognitive state at a recorded ledger position
> (`CONTEXT_ASSEMBLED`) → `TASK_SPLIT_REQUIRED` and stop, before any model
> call, when mandatory context cannot fit → `REASONING_REQUESTED` → the provider
> call under a budget and an outer timeout → `REASONING_FAILED` (typed) or
> `REASONING_RESPONDED` (the exact text, recorded before anything reads it) →
> `REASONING_OUTPUT_REJECTED` if it is not the proposal envelope → one
> `PROPOSAL_EVALUATED` per proposal → the graph mirror reconciled from the
> committed state → `TASK_FINISHED`. A proposal is one of `RECORD_BELIEF`,
> `RECORD_UNCERTAINTY`, `DRAFT_QUESTION` or `RECORD_CONTRADICTION`, must name an
> `ACTIVE` goal it serves, and is executed by the cognitive engine as an
> `AGENT` — so it is clamped to `AI_ASSUMPTION` and held to every agent rule.
> Failures become the self model's known failures under
> `<task kind>:reasoning:<KIND>`, which the next context for that kind of task
> must include. The `runs` projection rebuilds every run, including one that
> was interrupted. **Not implemented:** the other phases (`OBSERVE`, `PLAN`,
> `ACT`, `VERIFY`, …), the `BLOCKED_ON_HUMAN` outcome, task splitting, and
> retries.

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

> **Implemented** in `packages/projections` as a pure fold
> ([ADR-0013](../adr/0013-projections-as-pure-folds.md)). "It can be rebuilt" is
> a test, not a claim: replaying the ledger must produce the same digest as the
> live fold, and a snapshot taken at *any* point plus the events after it must
> produce that digest again. What exists is the fold over `WORLD_FACT_*` events
> and nothing else — it records what history says, keeps contradictions open
> rather than resolving them, and counts the event types it does not interpret
> instead of dropping them.

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

> **Implemented** in `packages/projections` as a pure fold over the ledger
> ([ADR-0013](../adr/0013-projections-as-pure-folds.md)). Rule 1 is enforced
> rather than assumed: an event claiming a capability is `AVAILABLE` with no
> evidence reference and no human behind it is recorded as `UNAVAILABLE`, and
> the over-claim is kept as an anomaly. `knownFailures` counts `EXECUTION_FAILED`
> events by signature.
>
> What is **not** implemented: the freshness window in rule 1. Deciding that a
> capability has gone stale needs a clock, and a clock inside the fold would make
> the projection depend on when it was run — so that belongs to the component
> reading this state, and is not built yet.
>
> Since P2 (self model v2, [ADR-0014](../adr/0014-cognitive-primitives-as-deciders.md)),
> `assumptions` and `uncertainties` are read from the belief system's and the
> uncertainty engine's own events — beliefs at `ASSUMED`, uncertainties `OPEN`
> or `IN_PROGRESS` — rather than a private vocabulary, so there is one source of
> truth. `currentGoal` is the goal in *focus* (`GOAL_FOCUSED` /
> `GOAL_UNFOCUSED`), not which goals are `ACTIVE`. Rule 2's state is
> representable (`hasOpenUncertainty`).

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

> **Implemented (P2)** in `packages/cognition`
> ([ADR-0014](../adr/0014-cognitive-primitives-as-deciders.md)): the record
> above; the tree; the §5.1 rule, read as "at least one criterion that is
> human-confirmable or names its check"; no `SATISFIED` with an unmet
> criterion, an `ACTIVE`/`BLOCKED` child, or an open uncertainty blocking it;
> terminal states that never reopen; no silent cascade on abandon; a
> human-confirmation criterion met only by a human and a test criterion never
> on an agent's say-so. Drift conditions 1 and 2 are the pure
> `checkContribution`. **Not implemented:** condition 3 (needs cycle history),
> and emitting `GOAL_DRIFT_DETECTED` (needs the loop).

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

> **Implemented (P2)**: one step forward at a time, every entry requirement
> enforced; downgrades to any lower state with a reason. Two rules go beyond
> the table, both to stop an agent verifying its own claim: an `AGENT` actor
> can never move a belief to `TESTED` or `VERIFIED`, and test evidence counts
> toward those states only if a non-agent attached it. An agent's belief is
> capped at `AI_ASSUMPTION`, with the clamp recorded. Contradicting evidence
> against a `VERIFIED` belief downgrades it to `TESTED` in the same decision.
> Evidence is checked by its descriptor; that the evidence exists is the
> evidence writer's job (SPEC-05 §4, P5).

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

> **Implemented (P2)**: the record (with `blocking` derived from
> `blocksGoalIds`, so the two cannot disagree), the lifecycle, resolution
> evidence, `ASK_HUMAN` answered only by a human, `ACCEPTED` only by a human,
> and `selectResolution` for §7.2. Detection sources 1, 3 and 5 are pure
> detectors returning drafts — they never write, and never report a gap an open
> uncertainty already covers; source 4 is the contradiction engine. **Not
> implemented:** source 2 (needs the graph). The `UNCERTAINTY` graph node and
> its `BLOCKS` edges are written by the orchestrator's graph mirror since P4
> (ADR-0018 §4).

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

> **Implemented (P2)**: steps 1, 3 and 5. Both sides are always kept, with
> where each side's authority came from. Authority governs only when it can be
> trusted — read from a belief in state, or supplied by a `HUMAN` or `SYSTEM`
> actor; an agent-supplied side authority makes the contradiction
> *indeterminate*, because otherwise an agent could win by declaring its side
> more authoritative. Equal or indeterminate opens an `ASK_HUMAN` uncertainty in
> the same atomic append, and only a human resolves it; resolving settles the
> uncertainty with it. **Not implemented:** step 2 (the `CONTRADICTS` edge),
> step 4 (the issue) and step 6 (blocking proposals) — they need the graph and
> the proposal pipeline.

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

### 9.5 Responses and the human interface

A person responds with one of three kinds, each with one defined effect,
applied in the same atomic append as the response
([ADR-0015](../adr/0015-questions-as-ledger-records.md)):

| Response | Effect |
|---|---|
| `ANSWER` | The uncertainty is `RESOLVED` with the question as resolution evidence; the answer may be attached as evidence for or against related beliefs. A contradiction's question must name the governing side, and resolves the contradiction. |
| `REJECT_ASSUMPTION` | The named related beliefs go to `UNKNOWN`, with the rejection recorded against each as contradicting evidence; the uncertainty is `RESOLVED`. |
| `ACCEPT_RISK` | The uncertainty is `ACCEPTED` — the gap stays a gap, by a person's choice. |

The production surface is a web interface over these records, whose actor comes
from an authenticated session. Terminal prompts are not a production interface.

> **Implemented (P3)** in `packages/cognition`: the §9.3 record, extended by
> ADR-0015 with the reason, affected goals and nodes, related beliefs, relevant
> evidence and resolution method; the lifecycle `DRAFT → ASKED → ANSWERED |
> WITHDRAWN | UNANSWERABLE`, terminal states never reopened; one open question
> per uncertainty and audience; no draft of a question a human already decided;
> the three responses above, each composed from the uncertainty, belief and
> contradiction deciders rather than re-implemented; agents draft but never ask,
> answer, close or record outcomes; a system answer to a `SELF`/`EXTERNAL`
> question must cite evidence; the outcome record, whose `beliefsTransitioned`
> is checked against belief history. Scoring (§9.2) is `QuestionScorer`, with a
> deterministic default (`genesis.default-question-scorer` v1): informationGain
> = (1 + movable related beliefs) / (1 + related beliefs); decisionImpact 1 / 0.6
> / 0.4 / 0.2 for blocking a goal in play / only proposed goals / only graph
> nodes / nothing; riskReduction = (risk rank + 1) / 4; dependencyCoverage = this
> uncertainty's share of the best blocked goal's blockers. The value is always the
> product, computed by the engine; a scorer returning a factor outside [0, 1] is
> refused. Scores are recorded at drafting and again at asking, with the
> scorer's name and version. Batching is the pure `nextQuestionBatch`; the
> interface contract is `pendingHumanQuestions` and `questionView`. **Not
> implemented:** the web interface and its authentication (SPEC-06). The
> `QUESTION` graph node is written by the graph mirror since P4 (ADR-0018 §4).

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

> **Implemented (P3)** in `packages/context`
> ([ADR-0017](../adr/0017-deterministic-scoring-and-context-assembly.md)):
> candidate builders for goals, beliefs, open uncertainties, contradictions,
> answered questions, matching known failures, applicable policies, memory
> records visible by default and graph nodes in the impact set; the six signals
> with the default weights above, validated to sum to 1 and summed in a fixed
> order; relevance through `RelevanceScorer` (default: lexical term coverage)
> and cost through `TokenEstimator` (default: `ceil(chars / 4)`, an
> approximation); recency relative to the request's `asOf`, never the clock;
> the four mandatory inclusions placed first; `SPLIT_REQUIRED` with no context
> when they alone exceed the budget; greedy selection by score then id; and a
> manifest of every candidate's signals, score and inclusion, recorded as a
> `CONTEXT_ASSEMBLED` event input that only the system may record. A read-only
> gatherer reads the memory and graph ports through `query`, `getNode` and
> `impactSet` alone. **Not implemented:** embedding relevance (E5), splitting
> the task (the planner, P4), and deciding which policies apply (P6) — the
> caller supplies them. Known-failure matching uses a provisional rule (§12
> item 2).

---

## 12. Open design questions

Tracked here rather than silently decided. Each becomes an ADR when settled.

1. Embedding model and store for the semantic half of retrieval. P3 ships the
   lexical half only, behind `RelevanceScorer`; the embedding scorer arrives
   with E5 (ADR-0017).
2. Exact normalisation of failure signatures in `knownFailures`. Context
   assembly matches provisionally — the signature, or its first `:` segment,
   equals the task kind (ADR-0017).
3. Whether `informationGain` can be estimated better than the belief-transition
   proxy. P3 records the outcome data (§9.2) this needs; the proxy stays until
   there is enough of it.
4. Cycle concurrency: currently one cycle at a time per project; multi-cycle
   needs a locking model (P6).
